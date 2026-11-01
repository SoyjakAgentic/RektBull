/**
 * Every check a trade must pass before RektBull hands it to the user's wallet,
 * ported from soyjak-agentic's swapRules.js (prepareSwap / prepareSell).
 *
 * A buy must pass all of them:
 *   1. trading is switched on (TRADING_ENABLED);
 *   2. the token is valid, and not the base asset itself;
 *   3. RektBull's token check (tokenRisk) finds nothing critical, and ran far
 *      enough to say whether it can be sold. High-risk findings need the user's
 *      explicit acknowledgement (they're shown on the approval);
 *   4. it's within the user's per-trade amount (trade_settings.max_trade_usd);
 *   5. 0x has a route, the quote simulated, and the token's taxes are at most
 *      max_tax_bps;
 *   6. selling what the buy would get straight back loses at most
 *      max_round_trip_loss_pct (a token that can't be sold back is a honeypot).
 * A sell skips 3, 4 and 6: it is how a user gets out.
 *
 * The fee (1%, FEE_BPS) is taken by 0x inside the swap, in the base asset.
 */
const { ethers } = require('ethers');
const env = require('../config/env');
const db = require('../config/db');
const { tradeChain, NATIVE } = require('./chains');
const zeroex = require('./zeroex');
const { basePrice } = require('../providers/prices');
const { evmRpc } = require('../providers/rpc');
const dd = require('../services/dueDiligence');

const { TradeBlocked } = zeroex;
const MAX_FEE_BPS = 100;

const DEFAULT_SETTINGS = { max_trade_usd: 500, max_tax_bps: 1000, max_round_trip_loss_pct: 30, slippage_bps: 100, stop_loss_pct: 20, take_profit_pct: 50, auto_exit: true };

async function settingsFor(accountId) {
  const { rows } = await db.query('SELECT * FROM trade_settings WHERE account_id = $1', [accountId]);
  if (!rows.length) return { ...DEFAULT_SETTINGS };
  const r = rows[0];
  return {
    max_trade_usd: Number(r.max_trade_usd), max_tax_bps: r.max_tax_bps, max_round_trip_loss_pct: Number(r.max_round_trip_loss_pct), slippage_bps: r.slippage_bps,
    stop_loss_pct: Number(r.stop_loss_pct ?? 20), take_profit_pct: Number(r.take_profit_pct ?? 50), auto_exit: r.auto_exit ?? true,
  };
}

async function saveSettings(accountId, s) {
  const cur = await settingsFor(accountId);
  const next = { ...cur, ...pick(s, Object.keys(DEFAULT_SETTINGS).filter(k => k !== 'auto_exit')), ...(s?.auto_exit !== undefined ? { auto_exit: !!s.auto_exit } : {}) };
  if (!(next.stop_loss_pct >= 1 && next.stop_loss_pct <= 95)) throw Object.assign(new Error('stop_loss_pct must be 1 to 95'), { status: 400 });
  if (!(next.take_profit_pct >= 1 && next.take_profit_pct <= 10000)) throw Object.assign(new Error('take_profit_pct must be 1 to 10000'), { status: 400 });
  if (!(next.max_trade_usd > 0)) throw Object.assign(new Error('max_trade_usd must be above 0'), { status: 400 });
  if (!(next.max_tax_bps >= 0 && next.max_tax_bps <= 5000)) throw Object.assign(new Error('max_tax_bps must be 0 to 5000'), { status: 400 });
  if (!(next.max_round_trip_loss_pct > 0 && next.max_round_trip_loss_pct <= 100)) throw Object.assign(new Error('max_round_trip_loss_pct must be above 0 and at most 100'), { status: 400 });
  if (!(next.slippage_bps >= 10 && next.slippage_bps <= 1000)) throw Object.assign(new Error('slippage_bps must be 10 to 1000'), { status: 400 });
  await db.query(
    `INSERT INTO trade_settings (account_id, max_trade_usd, max_tax_bps, max_round_trip_loss_pct, slippage_bps, stop_loss_pct, take_profit_pct, auto_exit)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (account_id) DO UPDATE SET max_trade_usd = $2, max_tax_bps = $3, max_round_trip_loss_pct = $4, slippage_bps = $5,
       stop_loss_pct = $6, take_profit_pct = $7, auto_exit = $8, updated_at = now()`,
    [accountId, next.max_trade_usd, next.max_tax_bps, next.max_round_trip_loss_pct, next.slippage_bps, next.stop_loss_pct, next.take_profit_pct, next.auto_exit],
  );
  return next;
}

const pick = (o, keys) => Object.fromEntries(keys.filter(k => o?.[k] !== undefined).map(k => [k, Number(o[k])]));

function swapFee(base) {
  if (!env.swapFeeWalletEvm) return null; // no fee wallet set: trade without the fee rather than refuse
  return { bps: Math.min(env.swapFeeBps, MAX_FEE_BPS), recipient: env.swapFeeWalletEvm, token: base.address };
}

const usdToUnits = (usd, price, decimals) => ethers.parseUnits((usd / price).toFixed(decimals), decimals);
const unitsToUsd = (units, price, decimals) => Number(ethers.formatUnits(units, decimals)) * price;

async function tokenBalance(chainName, wallet, token) {
  if (token === NATIVE) return BigInt(await evmRpc(chainName, 'eth_getBalance', [wallet, 'latest']));
  const data = new ethers.Interface(['function balanceOf(address) view returns (uint256)']).encodeFunctionData('balanceOf', [wallet]);
  return BigInt(await evmRpc(chainName, 'eth_call', [{ to: token, data }, 'latest']));
}

/**
 * Runs every check and gets a firm quote for `wallet`. Returns the plan, or
 * throws TradeBlocked saying which check failed.
 */
async function prepare({ accountId, wallet, chain: chainName, side, token, base: baseSymbol, amountUsd, sellFraction, acknowledgeRisks = false }) {
  if (!env.tradingEnabled) throw new TradeBlocked('Trading is switched off (TRADING_ENABLED).');
  const chain = tradeChain(chainName);
  if (!['buy', 'sell'].includes(side)) throw new TradeBlocked('side must be "buy" or "sell".');
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(token || ''))) throw new TradeBlocked('token must be a contract address.');
  token = token.toLowerCase();
  const baseKey = String(baseSymbol || chain.defaultBase).toUpperCase();
  const base = chain.bases[baseKey];
  if (!base) throw new TradeBlocked(`base must be one of: ${Object.keys(chain.bases).join(', ')}.`);
  if (token === base.address) throw new TradeBlocked('That is the base asset itself; name the token to buy or sell.');

  const settings = await settingsFor(accountId);
  const price = await basePrice(base);
  const fee = swapFee(base);
  const checks = [];

  if (side === 'buy') {
    const usd = Number(amountUsd);
    if (!(usd > 0)) throw new TradeBlocked('amount_usd must be a positive number for a buy.');
    if (usd > settings.max_trade_usd) throw new TradeBlocked(`$${usd} is over your per-trade amount of $${settings.max_trade_usd}. Change it in your trading settings.`);
    checks.push({ check: 'per_trade_amount', ok: true, detail: `$${usd} of your $${settings.max_trade_usd} per trade` });

    const risk = await dd.quickCheck({ chain: chainName, token });
    if (risk.incomplete) throw new TradeBlocked(`RektBull couldn't check whether this token can be sold (${risk.incomplete}) Not buying.`);
    if (risk.verdict === 'critical') throw new TradeBlocked(`RektBull's token check found a critical risk: ${risk.flags.find(f => f.severity === 'critical')?.title}. Not buying.`);
    const high = risk.flags.filter(f => f.severity === 'high');
    if (high.length && !acknowledgeRisks) {
      const err = new TradeBlocked(`RektBull's token check found ${high.length} high risk${high.length > 1 ? 's' : ''}: ${high.map(f => f.title).join('; ')}. Read them, then confirm to go ahead.`);
      err.needsAcknowledgement = true;
      err.risks = high;
      throw err;
    }
    checks.push({ check: 'token_risk', ok: true, detail: `verdict ${risk.verdict}`, flags: risk.flags, acknowledged: high.length ? high.map(f => f.id) : [] });

    const sellAmount = base.usd ? ethers.parseUnits(usd.toFixed(base.decimals), base.decimals) : usdToUnits(usd, price, base.decimals);
    const q = await zeroex.quote({ chainId: chain.chainId, sellToken: base.address, buyToken: token, sellAmount, taker: wallet, slippageBps: settings.slippage_bps, fee });
    if (q.taxBps > settings.max_tax_bps) throw new TradeBlocked(`This token charges a ${q.taxBps / 100}% tax, above your ${settings.max_tax_bps / 100}% limit.`);
    checks.push({ check: 'tax', ok: true, detail: `${q.taxBps / 100}% (limit ${settings.max_tax_bps / 100}%)` });

    let back = null;
    try {
      back = (await zeroex.quote({ chainId: chain.chainId, sellToken: token, buyToken: base.address, sellAmount: q.buyAmount, slippageBps: settings.slippage_bps, fee, indicative: true })).buyAmount;
    } catch (err) {
      if (!err.isTradeBlocked) throw err;
    }
    if (back === null) throw new TradeBlocked('There is no route to sell this token back: it may be a honeypot. Not buying.');
    const lossPct = Number((q.sellAmount - back) * 10000n / q.sellAmount) / 100;
    if (lossPct > settings.max_round_trip_loss_pct) throw new TradeBlocked(`Selling straight back would lose ${lossPct.toFixed(1)}%, above your ${settings.max_round_trip_loss_pct}% limit: the token may tax sells, or its pool is thin.`);
    checks.push({ check: 'sell_back', ok: true, detail: `selling straight back loses ${lossPct.toFixed(1)}% (fees included; limit ${settings.max_round_trip_loss_pct}%)` });

    return plan({ chainName, chain, side, token, base, baseKey, price, quote: q, valueUsd: usd, checks, wallet });
  }

  const fraction = Number(sellFraction ?? 1);
  if (!(fraction > 0 && fraction <= 1)) throw new TradeBlocked('sell_fraction must be above 0 and at most 1 (1 sells everything).');
  const balance = await tokenBalance(chainName, wallet, token);
  if (balance === 0n) throw new TradeBlocked('Your wallet holds none of this token.');
  const sellAmount = balance * BigInt(Math.round(fraction * 10000)) / 10000n;
  if (sellAmount === 0n) throw new TradeBlocked('That fraction of your holding rounds to nothing.');
  const q = await zeroex.quote({ chainId: chain.chainId, sellToken: token, buyToken: base.address, sellAmount, taker: wallet, slippageBps: settings.slippage_bps, fee });
  checks.push({ check: 'sell', ok: true, detail: 'Sells skip the buy checks: a sale is how you get out.' });
  return plan({ chainName, chain, side, token, base, baseKey, price, quote: q, valueUsd: unitsToUsd(q.minBuyAmount, price, base.decimals), sellFraction: fraction, checks, wallet });
}

function plan({ chainName, chain, side, token, base, baseKey, price, quote: q, valueUsd, sellFraction, checks, wallet }) {
  const feeUsd = q.fee && q.feeAmount > 0n ? unitsToUsd(q.feeAmount, price, base.decimals) : 0;
  return {
    chain: chainName, chainId: chain.chainId, wallet, side, token, base: baseKey, baseToken: base,
    valueUsd: Math.round(valueUsd * 100) / 100,
    ...(sellFraction ? { sellFraction } : {}),
    quote: q,
    summary: {
      text: side === 'buy'
        ? `Buy $${valueUsd.toFixed(2)} of ${token} with ${baseKey} on ${chain.label}`
        : `Sell ${Math.round(sellFraction * 100)}% of ${token} for ${baseKey} (about $${valueUsd.toFixed(2)}) on ${chain.label}`,
      sell_amount: q.sellAmount.toString(),
      buy_amount: q.buyAmount.toString(),
      min_buy_amount: q.minBuyAmount.toString(),
      fee: q.fee ? { pct: q.fee.bps / 100, asset: baseKey, amount: ethers.formatUnits(q.feeAmount, base.decimals), usd: Math.round(feeUsd * 100) / 100 } : null,
    },
    checks,
  };
}

module.exports = { prepare, settingsFor, saveSettings, DEFAULT_SETTINGS, tokenBalance, TradeBlocked };
