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
 * Checks 3 and 5 (and the bundle check) run at the same time; their results
 * are still weighed in this order, so the first failing check is the one
 * named. Given `seen` (a preview of the same trade, see proposals.preview),
 * check 6 runs alongside them too, on what the preview said the buy would get.
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

const DEFAULT_SETTINGS = {
  max_trade_usd: 500, max_tax_bps: 1000, max_round_trip_loss_pct: 30, slippage_bps: 100, stop_loss_pct: 20, take_profit_pct: 50, auto_exit: true,
  // The one-click buttons: dollar amounts to buy, shares of the holding to sell.
  buy_presets_usd: [25, 50, 100], sell_presets_pct: [25, 50, 100],
  // How fast to get into a block: 'standard' leaves the fee to the wallet (trade/fees.js).
  send_speed: 'standard',
};
const PRESETS = 4; // the most buttons of each kind
const ARRAYS = ['buy_presets_usd', 'sell_presets_pct'];
const NOT_NUMBERS = [...ARRAYS, 'auto_exit', 'send_speed'];

/** A list of preset buttons, sorted and without repeats, or an error naming what's wrong. */
function presets(name, list, max) {
  if (!Array.isArray(list) || !list.length || list.length > PRESETS) throw Object.assign(new Error(`${name} must list 1 to ${PRESETS} amounts`), { status: 400 });
  const out = [...new Set(list.map(Number))].sort((a, b) => a - b);
  if (!out.every(x => Number.isFinite(x) && x > 0 && x <= max)) throw Object.assign(new Error(`each of ${name} must be above 0 and at most ${max}`), { status: 400 });
  return out.map(x => Math.round(x * 100) / 100);
}

async function settingsFor(accountId) {
  const { rows } = await db.query('SELECT * FROM trade_settings WHERE account_id = $1', [accountId]);
  if (!rows.length) return { ...DEFAULT_SETTINGS };
  const r = rows[0];
  return {
    max_trade_usd: Number(r.max_trade_usd), max_tax_bps: r.max_tax_bps, max_round_trip_loss_pct: Number(r.max_round_trip_loss_pct), slippage_bps: r.slippage_bps,
    stop_loss_pct: Number(r.stop_loss_pct ?? 20), take_profit_pct: Number(r.take_profit_pct ?? 50), auto_exit: r.auto_exit ?? true,
    buy_presets_usd: (r.buy_presets_usd || DEFAULT_SETTINGS.buy_presets_usd).map(Number),
    sell_presets_pct: (r.sell_presets_pct || DEFAULT_SETTINGS.sell_presets_pct).map(Number),
    send_speed: r.send_speed || DEFAULT_SETTINGS.send_speed,
  };
}

async function saveSettings(accountId, s) {
  const cur = await settingsFor(accountId);
  const next = { ...cur, ...pick(s, Object.keys(DEFAULT_SETTINGS).filter(k => !NOT_NUMBERS.includes(k))), ...(s?.auto_exit !== undefined ? { auto_exit: !!s.auto_exit } : {}) };
  if (s?.send_speed !== undefined) {
    if (!(s.send_speed in require('./fees').SPEEDS)) throw Object.assign(new Error('send_speed must be standard, fast or fastest'), { status: 400 });
    next.send_speed = s.send_speed;
  }
  if (s?.buy_presets_usd !== undefined) next.buy_presets_usd = presets('buy_presets_usd', s.buy_presets_usd, 1000000);
  if (s?.sell_presets_pct !== undefined) next.sell_presets_pct = presets('sell_presets_pct', s.sell_presets_pct, 100);
  if (!(next.stop_loss_pct >= 1 && next.stop_loss_pct <= 95)) throw Object.assign(new Error('stop_loss_pct must be 1 to 95'), { status: 400 });
  if (!(next.take_profit_pct >= 1 && next.take_profit_pct <= 10000)) throw Object.assign(new Error('take_profit_pct must be 1 to 10000'), { status: 400 });
  if (!(next.max_trade_usd > 0)) throw Object.assign(new Error('max_trade_usd must be above 0'), { status: 400 });
  if (!(next.max_tax_bps >= 0 && next.max_tax_bps <= 5000)) throw Object.assign(new Error('max_tax_bps must be 0 to 5000'), { status: 400 });
  if (!(next.max_round_trip_loss_pct > 0 && next.max_round_trip_loss_pct <= 100)) throw Object.assign(new Error('max_round_trip_loss_pct must be above 0 and at most 100'), { status: 400 });
  if (!(next.slippage_bps >= 10 && next.slippage_bps <= 1000)) throw Object.assign(new Error('slippage_bps must be 10 to 1000'), { status: 400 });
  await db.query(
    `INSERT INTO trade_settings (account_id, max_trade_usd, max_tax_bps, max_round_trip_loss_pct, slippage_bps, stop_loss_pct, take_profit_pct, auto_exit, buy_presets_usd, sell_presets_pct, send_speed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (account_id) DO UPDATE SET max_trade_usd = $2, max_tax_bps = $3, max_round_trip_loss_pct = $4, slippage_bps = $5,
       stop_loss_pct = $6, take_profit_pct = $7, auto_exit = $8, buy_presets_usd = $9, sell_presets_pct = $10, send_speed = $11, updated_at = now()`,
    [accountId, next.max_trade_usd, next.max_tax_bps, next.max_round_trip_loss_pct, next.slippage_bps, next.stop_loss_pct, next.take_profit_pct, next.auto_exit, next.buy_presets_usd, next.sell_presets_pct, next.send_speed],
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
async function prepare({ accountId, wallet, chain: chainName, side, token, base: baseSymbol, amountUsd, sellFraction, acknowledgeRisks = false, seen = null }) {
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

  // A token a launchpad made: Virtuals' (Base) and four.meme's (BNB Chain) are traded on their bonding curves until they graduate.
  const pad = ['base', 'bsc'].includes(chainName) ? await require('../services/launchpads').identify(chainName, token).catch(() => ({ launchpad: null })) : { launchpad: null };
  if (pad.launchpad === 'fourmeme' && pad.state === 'curve') {
    return fourMemeCurve({ chainName, chain, wallet, side, token, base, baseKey, price, settings, checks, amountUsd, sellFraction, acknowledgeRisks, pad });
  }
  if (pad.launchpad === 'fourmeme') checks.push({ check: 'launchpad', ok: true, detail: 'A four.meme token that graduated from its bonding curve: it trades on PancakeSwap, through 0x', source: pad.source });
  if (pad.launchpad === 'virtuals') {
    if (pad.state !== 'curve') {
      throw new TradeBlocked(pad.state === 'graduated' && pad.agent_token
        ? `This Virtuals token has graduated from its bonding curve: it now trades as ${pad.agent_token} on Uniswap, and Virtuals swaps holders of the curve token for it. Trade ${pad.agent_token} instead.`
        : 'This Virtuals token\'s bonding curve is closed, and it isn\'t trading yet.');
    }
    return virtualsCurve({ chainName, chain, wallet, side, token, base, baseKey, price, fee, settings, checks, amountUsd, sellFraction, acknowledgeRisks, pad });
  }

  if (side === 'buy') {
    const usd = Number(amountUsd);
    if (!(usd > 0)) throw new TradeBlocked('amount_usd must be a positive number for a buy.');
    if (usd > settings.max_trade_usd) throw new TradeBlocked(`$${usd} is over your per-trade amount of $${settings.max_trade_usd}. Change it in your trading settings.`);
    checks.push({ check: 'per_trade_amount', ok: true, detail: `$${usd} of your $${settings.max_trade_usd} per trade` });

    const sellAmount = base.usd ? ethers.parseUnits(usd.toFixed(base.decimals), base.decimals) : usdToUnits(usd, price, base.decimals);
    // What a sale straight back would return, or null when there's no route back.
    const sellBack = amount => zeroex.quote({ chainId: chain.chainId, sellToken: token, buyToken: base.address, sellAmount: amount, slippageBps: settings.slippage_bps, fee, indicative: true })
      .then(r => r.buyAmount, err => { if (err.isTradeBlocked) return null; throw err; });
    // A preview of this same buy said what it gets: the sale back can be priced now, alongside the rest.
    const early = seen && seen.base === baseKey && seen.sell_amount === sellAmount.toString() && /^\d+$/.test(String(seen.buy_amount || '')) && BigInt(seen.buy_amount) > 0n ? BigInt(seen.buy_amount) : null;
    const [riskR, launchR, quoteR, backR] = await Promise.allSettled([
      dd.quickCheck({ chain: chainName, token }),
      // A token under a week old also gets the bundle and insider check (services/launches.js).
      require('../services/launches').forTrade({ chain: chainName, token }),
      zeroex.quote({ chainId: chain.chainId, sellToken: base.address, buyToken: token, sellAmount, taker: wallet, slippageBps: settings.slippage_bps, fee }),
      early === null ? Promise.resolve(undefined) : sellBack(early),
    ]);
    const take = r => { if (r.status === 'rejected') throw r.reason; return r.value; };

    const risk = take(riskR);
    if (risk.incomplete) throw new TradeBlocked(`RektBull couldn't check whether this token can be sold (${risk.incomplete}) Not buying.`);
    if (risk.verdict === 'critical') throw new TradeBlocked(`RektBull's token check found a critical risk: ${risk.flags.find(f => f.severity === 'critical')?.title}. Not buying.`);
    const launch = take(launchR);
    if (launch.risk === 'block') {
      throw new TradeBlocked(`RektBull's bundle check found a critical risk: ${launch.flags.find(f => f.severity === 'critical').title}. Not buying.`);
    }
    const high = [
      ...risk.flags.filter(f => f.severity === 'high'),
      ...(launch.risk === 'confirm' ? launch.flags.filter(f => f.severity === 'high').map(f => ({ id: 'bundle', ...f })) : []),
      ...(launch.risk === 'unknown' ? [{ id: 'bundle_unchecked', severity: 'high', title: 'This token is under a week old and RektBull couldn\'t check it for a bundled launch', evidence: launch.detail, source: 'Launch Safety' }] : []),
    ];
    if (high.length && !acknowledgeRisks) {
      const err = new TradeBlocked(`RektBull's checks found ${high.length} high risk${high.length > 1 ? 's' : ''}: ${high.map(f => f.title).join('; ')}. Read them, then confirm to go ahead.`);
      err.needsAcknowledgement = true;
      err.risks = high;
      throw err;
    }
    checks.push({ check: 'token_risk', ok: true, detail: `verdict ${risk.verdict}`, flags: risk.flags, acknowledged: high.length ? high.map(f => f.id) : [] });
    if (launch.young) checks.push({ check: 'bundle', ok: launch.risk !== 'block', detail: `launch check: ${launch.detail}`, flags: launch.flags || [] });

    const q = take(quoteR);
    if (q.taxBps > settings.max_tax_bps) throw new TradeBlocked(`This token charges a ${q.taxBps / 100}% tax, above your ${settings.max_tax_bps / 100}% limit.`);
    checks.push({ check: 'tax', ok: true, detail: `${q.taxBps / 100}% (limit ${settings.max_tax_bps / 100}%)` });

    let back;
    if (early === null) back = await sellBack(q.buyAmount);
    else {
      // Priced on the preview's amount. Getting fewer tokens now, the sale back is scaled down with them
      // (a sale's price per token only improves as it gets smaller, so this never flatters the result);
      // getting more, the smaller sale's return stands, which understates it.
      const b = take(backR);
      back = b === null ? null : (q.buyAmount >= early ? b : b * q.buyAmount / early);
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

/**
 * A Virtuals token still on its bonding curve. The fee stays inside a 0x swap, as on every trade:
 * a buy swaps the base asset into VIRTUAL through 0x (1% fee), then buys on the curve; a sell sells
 * on the curve for VIRTUAL, then swaps that into the base asset through 0x (1% fee). The wallet signs
 * every step; nothing is held anywhere in between.
 */
async function virtualsCurve({ chainName, chain, wallet, side, token, base, baseKey, price, fee, settings, checks, amountUsd, sellFraction, acknowledgeRisks, pad }) {
  const lp = require('../services/launchpads');
  const { buy_tax_pct: buyTax, sell_tax_pct: sellTax, progress_pct: progress } = pad.curve;
  const slip = BigInt(settings.slippage_bps);
  checks.push({ check: 'launchpad', ok: true, detail: `A Virtuals token on its bonding curve (${progress}% of the way to graduating to Uniswap), traded on Virtuals' own contract with its ${buyTax}% buy and ${sellTax}% sell tax`, source: pad.source });
  const route = { kind: 'virtuals_curve', bonding: lp.ADDR.bonding, frouter: lp.ADDR.frouter, virtual: lp.VIRTUAL, deadline: Math.floor(Date.now() / 1000) + 20 * 60 };

  if (side === 'buy') {
    // The tax limit is a buy check: a sale is how you get out.
    if ((buyTax + sellTax) * 100 > settings.max_tax_bps) throw new TradeBlocked(`The launchpad's taxes (${buyTax}% to buy, ${sellTax}% to sell) are above your ${settings.max_tax_bps / 100}% limit.`);
    const usd = Number(amountUsd);
    if (!(usd > 0)) throw new TradeBlocked('amount_usd must be a positive number for a buy.');
    if (usd > settings.max_trade_usd) throw new TradeBlocked(`$${usd} is over your per-trade amount of $${settings.max_trade_usd}. Change it in your trading settings.`);
    checks.push({ check: 'per_trade_amount', ok: true, detail: `$${usd} of your $${settings.max_trade_usd} per trade` });
    await curveBundleCheck({ chainName, token, checks, acknowledgeRisks });
    const sellAmount = base.usd ? ethers.parseUnits(usd.toFixed(base.decimals), base.decimals) : usdToUnits(usd, price, base.decimals);
    const q = await zeroex.quote({ chainId: chain.chainId, sellToken: base.address, buyToken: lp.VIRTUAL, sellAmount, taker: wallet, slippageBps: settings.slippage_bps, fee });
    const virtualIn = q.minBuyAmount; // the least the 0x swap delivers; any more stays in the wallet
    const out = await lp.curveBuyQuote(token, virtualIn, buyTax);
    if (out === 0n) throw new TradeBlocked('The curve gives nothing for this amount.');
    const back = await lp.curveSellQuote(token, out, sellTax);
    const lossPct = Number((virtualIn - back) * 10000n / virtualIn) / 100;
    if (lossPct > settings.max_round_trip_loss_pct) throw new TradeBlocked(`Selling straight back on the curve would lose ${lossPct.toFixed(1)}%, above your ${settings.max_round_trip_loss_pct}% limit.`);
    checks.push({ check: 'sell_back', ok: true, detail: `selling straight back on the curve loses ${lossPct.toFixed(1)}% (the launchpad's taxes included; limit ${settings.max_round_trip_loss_pct}%)` });
    const p = plan({ chainName, chain, side, token, base, baseKey, price, quote: q, valueUsd: usd, checks, wallet });
    p.route = { ...route, virtual_in: virtualIn.toString(), expected_out: out.toString(), min_out: (out * (10000n - slip) / 10000n).toString() };
    p.summary.text = `Buy $${usd.toFixed(2)} of ${token} on Virtuals' bonding curve, paying with ${baseKey} (swapped into VIRTUAL first)`;
    p.summary.buy_amount = out.toString();
    p.summary.min_buy_amount = p.route.min_out;
    return p;
  }

  const fraction = Number(sellFraction ?? 1);
  if (!(fraction > 0 && fraction <= 1)) throw new TradeBlocked('sell_fraction must be above 0 and at most 1 (1 sells everything).');
  const balance = await tokenBalance(chainName, wallet, token);
  if (balance === 0n) throw new TradeBlocked('Your wallet holds none of this token.');
  const amount = balance * BigInt(Math.round(fraction * 10000)) / 10000n;
  if (amount === 0n) throw new TradeBlocked('That fraction of your holding rounds to nothing.');
  const virtualOut = await lp.curveSellQuote(token, amount, sellTax);
  const minVirtual = virtualOut * (10000n - slip) / 10000n;
  if (minVirtual === 0n) throw new TradeBlocked('The curve gives nothing for this amount.');
  // The 0x leg sells VIRTUAL the curve sale delivers in the same batch, so the wallet doesn't hold it yet.
  const q = await zeroex.quote({ chainId: chain.chainId, sellToken: lp.VIRTUAL, buyToken: base.address, sellAmount: minVirtual, taker: wallet, slippageBps: settings.slippage_bps, fee, fundedInBatch: true });
  checks.push({ check: 'sell', ok: true, detail: 'Sells skip the buy checks: a sale is how you get out.' });
  const p = plan({ chainName, chain, side, token, base, baseKey, price, quote: q, valueUsd: unitsToUsd(q.minBuyAmount, price, base.decimals), sellFraction: fraction, checks, wallet });
  p.route = { ...route, amount: amount.toString(), min_virtual: minVirtual.toString() };
  p.summary.text = `Sell ${Math.round(fraction * 100)}% of ${token} on Virtuals' bonding curve, then swap the VIRTUAL into ${baseKey} (about $${p.valueUsd.toFixed(2)})`;
  return p;
}

/** A token on a bonding curve is always new: the bundle and insider check runs before every buy. */
async function curveBundleCheck({ chainName, token, checks, acknowledgeRisks }) {
  const launch = await require('../services/launches').forTrade({ chain: chainName, token });
  if (launch.risk === 'block') throw new TradeBlocked(`RektBull's bundle check found a critical risk: ${launch.flags.find(f => f.severity === 'critical').title}. Not buying.`);
  const high = [
    ...(launch.risk === 'confirm' ? launch.flags.filter(f => f.severity === 'high').map(f => ({ id: 'bundle', ...f })) : []),
    ...(launch.risk === 'unknown' ? [{ id: 'bundle_unchecked', severity: 'high', title: 'RektBull couldn\'t check this new token for a bundled launch', evidence: launch.detail, source: 'Launch Safety' }] : []),
  ];
  if (high.length && !acknowledgeRisks) {
    const err = new TradeBlocked(`RektBull's checks found ${high.length} high risk${high.length > 1 ? 's' : ''}: ${high.map(f => f.title).join('; ')}. Read them, then confirm to go ahead.`);
    err.needsAcknowledgement = true;
    err.risks = high;
    throw err;
  }
  checks.push({ check: 'bundle', ok: true, detail: `launch check: ${launch.detail}`, flags: launch.flags || [] });
}

/**
 * A four.meme token still on its bonding curve (BNB Chain), priced in BNB. Buys and sells are made on
 * four.meme's TokenManager2, which charges its own fee (1% now) both ways. RektBull's 1%:
 *   - a buy paid with USDT or USDC swaps it into BNB through 0x with the fee inside that swap (as on
 *     every trade), then buyTokenAMAP with that BNB and a minimum out;
 *   - a buy paid with BNB has no swap to carry the fee: buyTokenAMAP spends 99% of the BNB, and the
 *     other 1% is a plain transfer to the fee wallet after it, in the same batch (atomicRequired), as
 *     claim fees are (docs/PAYMENTS.md). A wallet that can't batch sends the buy first, then the fee;
 *   - a sell calls sellToken with an integrator fee of 1% to the fee wallet, paid by four.meme's
 *     contract from the sale in the same call (so only if the sale goes through); for USDT or USDC
 *     the BNB is then swapped through 0x without a second fee.
 * sellToken checks its minimum before the integrator fee comes off (checked on a copy of BNB
 * Chain), so what the wallet is sure to get is that minimum less the most the fee can be.
 */
async function fourMemeCurve({ chainName, chain, wallet, side, token, base, baseKey, price, settings, checks, amountUsd, sellFraction, acknowledgeRisks, pad }) {
  const lp = require('../services/launchpads');
  if (pad.token_manager !== lp.FOURMEME.tokenManager || pad.version !== 2) throw new TradeBlocked('This four.meme token is on an older four.meme contract, which RektBull doesn\'t trade. Trade it on four.meme itself.');
  if (pad.quote !== 'bnb') throw new TradeBlocked(`This four.meme token is priced in ${pad.quote_symbol}, not BNB. RektBull trades four.meme curves priced in BNB only, for now.`);
  const { buy_tax_pct: fmFee, progress_pct: progress } = pad.curve;
  const slip = BigInt(settings.slippage_bps);
  checks.push({ check: 'launchpad', ok: true, detail: `A four.meme token on its bonding curve (${progress}% sold; it graduates to PancakeSwap at ${pad.curve.graduates_at} BNB raised), traded on four.meme's own contract with its ${fmFee}% fee each way`, source: pad.source });
  const route = { kind: 'fourmeme_curve', token_manager: lp.FOURMEME.tokenManager };

  if (side === 'buy') {
    if (fmFee * 2 * 100 > settings.max_tax_bps) throw new TradeBlocked(`four.meme's fees (${fmFee}% to buy, ${fmFee}% to sell) are above your ${settings.max_tax_bps / 100}% limit.`);
    if (baseKey === 'WBNB') throw new TradeBlocked('A four.meme curve is bought with BNB: pay with BNB, USDT or USDC.');
    const usd = Number(amountUsd);
    if (!(usd > 0)) throw new TradeBlocked('amount_usd must be a positive number for a buy.');
    if (usd > settings.max_trade_usd) throw new TradeBlocked(`$${usd} is over your per-trade amount of $${settings.max_trade_usd}. Change it in your trading settings.`);
    checks.push({ check: 'per_trade_amount', ok: true, detail: `$${usd} of your $${settings.max_trade_usd} per trade` });
    await curveBundleCheck({ chainName, token, checks, acknowledgeRisks });
    let q, funds, payFee = null;
    if (baseKey === 'BNB') {
      // Paid in BNB: 99% to the curve, 1% to the fee wallet as its own transfer (no swap to carry it).
      const total = ethers.parseUnits((usd / price).toFixed(12), 18); // 12 places: no float noise in the last digits
      const have = await tokenBalance(chainName, wallet, NATIVE);
      if (have < total) throw new TradeBlocked(`Your wallet holds ${ethers.formatEther(have)} BNB of the ${ethers.formatEther(total)} BNB this buy needs (and a little more for gas).`);
      const feeBps = env.swapFeeWalletEvm ? BigInt(Math.min(env.swapFeeBps, MAX_FEE_BPS)) : 0n;
      const fee = total * feeBps / 10000n;
      funds = total - fee;
      if (fee > 0n) payFee = { amount: fee, bps: Number(feeBps) };
      q = { sellAmount: total, buyAmount: funds, minBuyAmount: funds, taxBps: 0, fee: null, feeAmount: 0n, transaction: null, allowanceSpender: null };
    } else {
      q = await zeroex.quote({ chainId: chain.chainId, sellToken: base.address, buyToken: NATIVE, sellAmount: ethers.parseUnits(usd.toFixed(base.decimals), base.decimals), taker: wallet, slippageBps: settings.slippage_bps, fee: swapFee(base) });
      funds = q.minBuyAmount; // the least BNB the 0x swap delivers; any more stays in the wallet
    }
    const est = await lp.fourMemeBuyQuote(token, funds);
    if (est.manager !== lp.FOURMEME.tokenManager || est.msgValue !== funds) throw new TradeBlocked('four.meme\'s helper quoted this buy in a way RektBull doesn\'t expect: not using it.');
    if (est.amount === 0n) throw new TradeBlocked('The curve gives nothing for this amount.');
    const back = (await lp.fourMemeSellQuote(token, est.amount)).funds;
    const lossPct = Number((funds - back) * 10000n / funds) / 100;
    if (lossPct > settings.max_round_trip_loss_pct) throw new TradeBlocked(`Selling straight back on the curve would lose ${lossPct.toFixed(1)}%, above your ${settings.max_round_trip_loss_pct}% limit.`);
    checks.push({ check: 'sell_back', ok: true, detail: `selling straight back on the curve loses ${lossPct.toFixed(1)}% (four.meme's fees included; limit ${settings.max_round_trip_loss_pct}%)` });
    const p = plan({ chainName, chain, side, token, base, baseKey, price, quote: q, valueUsd: usd, checks, wallet });
    p.route = { ...route, funds: funds.toString(), expected_out: est.amount.toString(), min_out: (est.amount * (10000n - slip) / 10000n).toString() };
    p.summary.text = `Buy $${usd.toFixed(2)} of ${token} on four.meme's bonding curve, paying with ${baseKey}${baseKey === 'BNB' ? '' : ' (swapped into BNB first)'}`;
    if (baseKey === 'BNB') {
      p.route.pay = 'bnb';
      if (payFee) {
        Object.assign(p.route, { fee_bps: payFee.bps, fee_amount: payFee.amount.toString(), fee_recipient: env.swapFeeWalletEvm.toLowerCase() });
        p.summary.fee = { pct: payFee.bps / 100, asset: 'BNB', amount: ethers.formatEther(payFee.amount), usd: Math.round(unitsToUsd(payFee.amount, price, 18) * 100) / 100, taken_by: 'a separate transfer to RektBull, sent with the buy and after it' };
      }
    }
    p.summary.buy_amount = est.amount.toString();
    p.summary.min_buy_amount = p.route.min_out;
    return p;
  }

  if (baseKey === 'WBNB') throw new TradeBlocked('A four.meme curve pays out BNB: sell for BNB, USDT or USDC.');
  const fraction = Number(sellFraction ?? 1);
  if (!(fraction > 0 && fraction <= 1)) throw new TradeBlocked('sell_fraction must be above 0 and at most 1 (1 sells everything).');
  const balance = await tokenBalance(chainName, wallet, token);
  if (balance === 0n) throw new TradeBlocked('Your wallet holds none of this token.');
  // four.meme sells only whole multiples of 10^9 of a token's smallest units (else it reverts 'GW',
  // seen on a copy of BNB Chain): rounded down, what's left is under a billionth of a token.
  let amount = balance * BigInt(Math.round(fraction * 10000)) / 10000n;
  amount -= amount % lp.FOURMEME_SELL_UNIT;
  if (amount === 0n) throw new TradeBlocked('That fraction of your holding rounds to nothing.');
  const est = await lp.fourMemeSellQuote(token, amount);
  const minFunds = est.funds * (10000n - slip) / 10000n;
  if (minFunds === 0n) throw new TradeBlocked('The curve gives nothing for this amount.');
  // RektBull's 1%, taken by four.meme's contract from the sale (on the sale before four.meme's own fee).
  const feeBps = env.swapFeeWalletEvm ? BigInt(Math.min(env.swapFeeBps, MAX_FEE_BPS, lp.FOURMEME_MAX_FEE_BPS)) : 0n;
  // The sale before four.meme's fee, for a given amount after it: four.meme takes its rate, or its minimum fee if larger.
  const fmBps = BigInt(Math.round(fmFee * 100));
  const minFee = BigInt(pad.curve.min_fee_wei || 0);
  const gross = f => { const a = f * 10000n / (10000n - fmBps) + 1n; return a > f + minFee ? a : f + minFee; };
  const sure = minFunds - (feeBps ? gross(minFunds) * feeBps / 10000n + 1n : 0n); // the least BNB the wallet gets from the sale
  if (sure <= 0n) throw new TradeBlocked('The curve gives nothing for this amount after fees.');
  checks.push({ check: 'sell', ok: true, detail: 'Sells skip the buy checks: a sale is how you get out.' });
  const bnbPrice = await basePrice(chain.bases.BNB);
  const feeExpected = (est.funds + est.fee) * feeBps / 10000n;
  const feeView = feeBps ? { pct: Number(feeBps) / 100, asset: 'BNB', amount: ethers.formatEther(feeExpected), usd: Math.round(unitsToUsd(feeExpected, bnbPrice, 18) * 100) / 100, taken_by: 'paid by four.meme\'s contract from the sale, in the same transaction' } : null;
  const r = { ...route, amount: amount.toString(), min_funds: minFunds.toString(), fee_bps: Number(feeBps), fee_recipient: feeBps ? env.swapFeeWalletEvm.toLowerCase() : null };
  let p;
  if (baseKey === 'BNB') {
    const q = { sellAmount: amount, buyAmount: est.funds - feeExpected, minBuyAmount: sure, taxBps: 0, fee: null, feeAmount: 0n, transaction: null, allowanceSpender: null };
    p = plan({ chainName, chain, side, token, base, baseKey, price, quote: q, valueUsd: unitsToUsd(sure, bnbPrice, 18), sellFraction: fraction, checks, wallet });
    p.summary.text = `Sell ${Math.round(fraction * 100)}% of ${token} on four.meme's bonding curve for BNB (at least ${ethers.formatEther(sure)} BNB, about $${p.valueUsd.toFixed(2)})`;
  } else {
    // RektBull's fee was taken on the curve: this swap carries none. The BNB comes from the sale earlier in the same batch.
    const q = await zeroex.quote({ chainId: chain.chainId, sellToken: NATIVE, buyToken: base.address, sellAmount: sure, taker: wallet, slippageBps: settings.slippage_bps, fee: null, fundedInBatch: true });
    p = plan({ chainName, chain, side, token, base, baseKey, price, quote: q, valueUsd: unitsToUsd(q.minBuyAmount, price, base.decimals), sellFraction: fraction, checks, wallet });
    p.summary.text = `Sell ${Math.round(fraction * 100)}% of ${token} on four.meme's bonding curve, then swap ${ethers.formatEther(sure)} BNB into ${baseKey} (about $${p.valueUsd.toFixed(2)})`;
    r.bnb_to_base = sure.toString();
  }
  p.route = r;
  p.summary.fee = feeView;
  return p;
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
