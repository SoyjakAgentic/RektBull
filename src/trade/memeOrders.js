/**
 * Orders on BNB Chain and Base (docs/MEME_ROUTER.md, "The trade service"): a
 * limit buy, a stop-loss, a take-profit or a Meme Watch exit that the user's
 * wallet signs (an EIP-712 order) and RektBull's executor fills through the
 * Meme Router when it fires. The router lets the executor do one thing with an
 * order: trade the coins it names, at the user's price or better, before its
 * end date, through an exchange fixed when the router was deployed, with what
 * they bring going only to the user's wallet. Nobody holds the user's keys or
 * funds between transactions.
 *
 *   stop_loss        sells for the native coin (ETH, BNB) when the coins' value falls to the trigger (DexScreener);
 *   take_profit      sells when it rises to the trigger;
 *   meme_watch_exit  sells when Meme Watch raises a critical alert for the coin (myAgents' check);
 *   (a stop-loss placed with a copy of a followed wallet's buy, copy_wallet, also fires when that wallet sells
 *   the coin: copySellSignal, from the Wallet Tracker; at the market, never below its own floor);
 *   limit_buy        buys the coin with the user's wrapped native coin (WETH, WBNB, in their own wallet and
 *                    approved) when its price falls to their limit, after the Trade desk's buy checks, run
 *                    again before each fill.
 *
 * Unlike Solana, placing an order is only a signature: nothing is sent and
 * nothing is deposited. The user's wallet then approves the router for exactly
 * what their live orders on that coin trade (and, for a buy, wraps the native
 * coin), and cancels on the router itself (one order, or all of them at once).
 *
 * A fill: on BNB Chain, a coin still on its four.meme curve is traded on the
 * curve itself; everything else goes through 0x's AllowanceHolder, quoted with
 * the router as the taker. The executor's own minimum (the quote's, net of the
 * fee) is added to the user's; the whole fill runs first as a call, then is
 * signed by the executor's KMS key and sent. The router checks the user's price
 * again on what actually reached them; a fill below it fails onchain and costs
 * the user nothing. RektBull pays every fill's network fee from the executor's
 * own balance; the 1% covers it, and an order under $5 is refused.
 *
 * Off until the router is audited and deployed (MEME_ORDERS_ENABLED,
 * MEME_ROUTERS, MEME_ORDERS_EXECUTOR). The emergency stop for automatic trading
 * stops fills; cancelling is never blocked (it's the user's own call to the router).
 */
const crypto = require('crypto');
const { ethers } = require('ethers');
const env = require('../config/env');
const db = require('../config/db');
const logger = require('../config/logger');
const privateSend = require('./privateSend');
const exitRules = require('./exitRules');
const { cached } = require('../lib/cache');
const { rpcUrls } = require('../providers/chains');
const { TRADE_CHAINS } = require('./chains');
const tx = require('./memeOrderTx');
const zeroex = require('./zeroex');
const { TradeBlocked } = zeroex;

const KINDS = { stop_loss: 'Stop-loss', take_profit: 'Take-profit', meme_watch_exit: 'Meme Watch exit', limit_buy: 'Limit buy' };
const isBuy = row => row.kind === 'limit_buy';
const NATIVE = tx.NATIVE.toLowerCase();
const CHAINS = {
  base: {
    chainId: 8453, label: 'Base', native: 'ETH', wrapped: TRADE_CHAINS.base.bases.WETH.address, wrappedName: 'WETH', priceId: 'coingecko:ethereum',
    allowanceHolder: TRADE_CHAINS.base.allowanceHolder, explorerTx: TRADE_CHAINS.base.explorerTx, virtuals: true,
  },
  bsc: {
    chainId: 56, label: 'BNB Chain', native: 'BNB', wrapped: TRADE_CHAINS.bsc.bases.WBNB.address, wrappedName: 'WBNB', priceId: 'coingecko:binancecoin',
    allowanceHolder: TRADE_CHAINS.bsc.allowanceHolder, explorerTx: TRADE_CHAINS.bsc.explorerTx, fourMeme: true,
  },
};
const MAX_DAYS = 30;
const MIN_ORDER_USD = 5; // RektBull pays each fill's network fee out of its 1%
const FILL_SLIPPAGE_BPS = 500; // 0x's own check on a fill; the user's price, checked by the router, is what protects them
const RETRY_MS = { below_floor: 30_000, failed: 30_000, nothing: 5 * 60_000 };
const FILLS_PER_TICK = 5;
const PREPARED_TTL_MS = 30 * 60_000; // a prepared order never signed is forgotten after this
const NOT_SEEN_MS = 30 * 60_000; // a sent fill with no receipt after this is failed
const LOCK_ID = 727002; // pg advisory lock: one sender at a time for the executor's nonces
const EIP1271 = new ethers.Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);
// Multicall3, at the same address on Base and BNB Chain: many view calls in one eth_call (the once-a-minute read-back).
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const MC = new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
const MULTICALL_CHUNK = 300; // tiny view calls: about 3,000 gas each, so 300 stay far under any node's eth_call gas cap

const addr = a => /^0x[0-9a-f]{40}$/.test(String(a || '').toLowerCase());
const whole = (raw, decimals) => Number(ethers.formatUnits(BigInt(raw), decimals)); // exact digits first: 18 decimals overflow a float's
const fmt = n => n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 6 : 2 });
// The native coin, to 9 decimals and cut off, never rounded up: a floor shown is never better than the one signed.
const nat = wei => { const [i, f = ''] = ethers.formatEther(BigInt(wei)).split('.'); const d = f.slice(0, 9).replace(/0+$/, ''); return d ? `${i}.${d}` : i; };
const short = a => `${a.slice(0, 6)}…${a.slice(-4)}`;
const refuse = (message, status = 422) => Object.assign(new TradeBlocked(message), { status });

/* ── Configuration ── */

/** { routers: { chain: address }, executor } when orders are on; else { off: why }. */
function config() {
  if (!env.memeOrdersEnabled) return { off: 'Orders on BNB Chain and Base open once RektBull\'s Meme Router has been audited and deployed. Until then, sell from your own wallet on the Trade desk.' };
  const routers = {};
  for (const chain of Object.keys(CHAINS)) {
    const a = String(env.memeRouters?.[chain] || '').toLowerCase();
    if (addr(a)) routers[chain] = a;
  }
  if (!Object.keys(routers).length) return { off: 'Orders on BNB Chain and Base aren\'t set up here (MEME_ROUTERS).' };
  if (!addr(env.memeOrdersExecutor)) return { off: 'Orders on BNB Chain and Base aren\'t set up here (MEME_ORDERS_EXECUTOR).' };
  return { routers, executor: env.memeOrdersExecutor.toLowerCase() };
}

// One connection per chain, reused. No response cache: a stale nonce or balance is worse than another request.
const providers = new Map();
const rpcProvider = chain => {
  if (!providers.has(chain)) providers.set(chain, new ethers.JsonRpcProvider(rpcUrls(chain)[0], CHAINS[chain].chainId, { staticNetwork: true, cacheTimeout: -1 }));
  return providers.get(chain);
};
let providerFor = rpcProvider;
const provider = chain => providerFor(chain);

/** A view call on a contract: the decoded result (one value as itself). */
async function read(chain, to, iface, fn, args = []) {
  const raw = await provider(chain).call({ to, data: iface.encodeFunctionData(fn, args) });
  const r = iface.decodeFunctionResult(fn, raw);
  return r.length === 1 ? r[0] : r;
}
const ROUTER = tx.ROUTER;
const ERC20 = tx.ERC20;

/** Many view calls [{ target, iface, fn, args }] in one eth_call per MULTICALL_CHUNK (Multicall3): each { ok, value }. */
async function readMany(chain, calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += MULTICALL_CHUNK) {
    const part = calls.slice(i, i + MULTICALL_CHUNK);
    const data = MC.encodeFunctionData('aggregate3', [part.map(c => ({ target: c.target, allowFailure: true, callData: c.iface.encodeFunctionData(c.fn, c.args) }))]);
    const [results] = MC.decodeFunctionResult('aggregate3', await provider(chain).call({ to: MULTICALL3, data }));
    results.forEach((r, j) => {
      const c = part[j];
      if (!r.success || r.returnData === '0x') return out.push({ ok: false });
      try { out.push({ ok: true, value: c.iface.decodeFunctionResult(c.fn, r.returnData)[0] }); } catch { out.push({ ok: false }); }
    });
  }
  return out;
}

/**
 * The router as deployed, kept 10 minutes: code at the address, a fee of at
 * most 1%, the chain's wrapped native coin, 0x's AllowanceHolder as a venue;
 * on BNB Chain whether four.meme's TokenManager2 is one too; on Base whether
 * Virtuals' BondingV5 and FRouterV3 are, with VIRTUAL as a base asset, and
 * whether Virtuals' code is still what was checked (both are upgradeable
 * proxies: memeRouterParams.js). The router has no owner and can't be
 * changed, so this only catches a wrong address, and Virtuals' upgrades.
 */
async function routerCheck(chain, router) {
  return cached(`meme:router:${chain}:${router}`, 600, async () => {
    const c = CHAINS[chain];
    const lp = require('../services/launchpads');
    const code = await provider(chain).getCode(router);
    if (!code || code === '0x') return { ok: false, why: `RektBull's Meme Router isn't deployed at ${router} on ${c.label}.` };
    const [feeBps, feeWallet, wrapped, zeroexVenue, fourMeme] = await Promise.all([
      read(chain, router, ROUTER, 'FEE_BPS'), read(chain, router, ROUTER, 'FEE_WALLET'), read(chain, router, ROUTER, 'WRAPPED_NATIVE'),
      read(chain, router, ROUTER, 'isVenue', [c.allowanceHolder]),
      c.fourMeme ? read(chain, router, ROUTER, 'isVenue', [lp.FOURMEME.tokenManager]) : false,
    ]);
    if (Number(feeBps) > 100) return { ok: false, why: `The Meme Router on ${c.label} charges ${Number(feeBps) / 100}%, more than RektBull's 1%: not used.` };
    if (String(wrapped).toLowerCase() !== c.wrapped.toLowerCase()) return { ok: false, why: `The Meme Router on ${c.label} names another wrapped ${c.native}: not used.` };
    if (!zeroexVenue) return { ok: false, why: `The Meme Router on ${c.label} doesn't allow 0x's AllowanceHolder: not used.` };
    let virtuals = false, virtualsWhy = null;
    if (c.virtuals) {
      const [bonding, frouter, base] = await Promise.all([
        read(chain, router, ROUTER, 'isVenue', [lp.ADDR.bondingV5]), read(chain, router, ROUTER, 'isVenue', [lp.ADDR.frouterV3]), read(chain, router, ROUTER, 'isBase', [lp.VIRTUAL]).catch(() => false)]);
      const expected = require('./memeRouterParams').PARAMS[chain].implementations || {};
      const changed = [];
      for (const [proxy, impl] of Object.entries(expected)) {
        const now = '0x' + String(await provider(chain).getStorage(proxy, IMPLEMENTATION_SLOT)).slice(-40);
        if (now.toLowerCase() !== impl.toLowerCase()) changed.push(proxy === lp.ADDR.bondingV5 ? 'BondingV5' : 'FRouterV3');
      }
      if (!(bonding && frouter && base)) virtualsWhy = `the Meme Router on ${c.label} wasn't deployed with Virtuals' curve (BondingV5, FRouterV3, and VIRTUAL as a base asset)`;
      else if (changed.length) virtualsWhy = `Virtuals has upgraded ${changed.join(' and ')} since RektBull checked them, so orders on Virtuals curve coins wait until the new code is reviewed`;
      else virtuals = true;
    }
    return { ok: true, feeBps: Number(feeBps), feeWallet: String(feeWallet).toLowerCase(), fourMeme: !!fourMeme, virtuals, virtualsWhy };
  });
}
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'; // EIP-1967

/** The configuration for a chain, checked against it; throws a refusal saying why when orders can't be used. */
async function ready(chain) {
  const cfg = config();
  if (cfg.off) throw refuse(cfg.off, 503);
  if (!cfg.routers[chain]) throw refuse(`Orders on ${CHAINS[chain].label} aren't open yet.`, 503);
  const check = await routerCheck(chain, cfg.routers[chain]);
  if (!check.ok) throw refuse(check.why, 503);
  return { ...cfg, router: cfg.routers[chain], check };
}

/* ── Prices and routes ── */

/**
 * The launchpad curve a coin is still on, or null: four.meme's (BNB Chain, priced in BNB) or Virtuals' BondingV5
 * (Base, priced in VIRTUAL). { kind, name, pad, sellUnit }, or with `unsupported` (why) when the router can't trade
 * on it: Virtuals' old curve, a router deployed without Virtuals, or Virtuals' code upgraded since it was checked.
 */
async function curveOf(chain, token, check) {
  const lp = require('../services/launchpads');
  if (chain === 'bsc' && check.fourMeme) {
    const pad = await lp.identify('bsc', token).catch(() => null);
    if (pad?.launchpad === 'fourmeme' && pad.state === 'curve' && pad.quote === 'bnb' && pad.token_manager === lp.FOURMEME.tokenManager) {
      return { kind: 'fourmeme', name: 'four.meme\'s curve', pad, sellUnit: lp.FOURMEME_SELL_UNIT };
    }
    return null;
  }
  if (chain === 'base' && CHAINS.base.virtuals) {
    const pad = await lp.identify('base', token).catch(() => null);
    if (pad?.launchpad !== 'virtuals' || pad.state !== 'curve') return null;
    if (pad.version !== 5 || pad.bonding !== lp.ADDR.bondingV5 || pad.frouter !== lp.ADDR.frouterV3) {
      return { kind: 'virtuals', unsupported: 'This coin is on Virtuals\' old bonding curve, which orders don\'t trade on (nothing launches or is bought there). Sell it from your own wallet on the Trade desk.' };
    }
    if (!check.virtuals) return { kind: 'virtuals', unsupported: `Orders on Virtuals curve coins aren't open: ${check.virtualsWhy || 'the router can\'t trade on Virtuals\' curve'}.` };
    return { kind: 'virtuals', name: 'Virtuals\' curve (BondingV5)', pad, sellUnit: 1n };
  }
  return null;
}

/**
 * What orders on a coin are priced in: on Virtuals' curve, VIRTUAL (a sale pays it out, a buy spends it); everywhere
 * else the native coin (a sale pays out ETH or BNB, a buy spends WETH or WBNB from the user's wallet).
 */
function quoteAsset(chain, curve) {
  const c = CHAINS[chain];
  if (curve?.kind === 'virtuals') {
    const lp = require('../services/launchpads');
    return { virtual: true, out: lp.VIRTUAL, in: lp.VIRTUAL, symbol: 'VIRTUAL', spendName: 'VIRTUAL', priceId: 'coingecko:virtual-protocol' };
  }
  return { virtual: false, out: NATIVE, in: c.wrapped.toLowerCase(), symbol: c.native, spendName: c.wrappedName, priceId: c.priceId };
}
/** The same, for an order already placed (from the coins it trades). */
function quoteOfRow(row) {
  const lp = require('../services/launchpads');
  return quoteAsset(row.chain, (isBuy(row) ? row.token_in : row.token_out) === lp.VIRTUAL ? { kind: 'virtuals' } : null);
}
const usdOf = q => require('../providers/prices').usdPrice(q.priceId);

const noRoute = err => { if (err.isTradeBlocked) throw refuse(err.message, 503); throw err; };

/** What `amount` of the coin sells for now, in what its orders are priced in: { out, route, taxBps }. A curve's is after its fee. */
async function sellQuote(chain, token, amount, curve) {
  const lp = require('../services/launchpads');
  if (curve?.kind === 'fourmeme') return { out: (await lp.fourMemeSellQuote(token, amount)).funds, route: 'four.meme', taxBps: 0 };
  if (curve?.kind === 'virtuals') return { out: await lp.curveSellQuote(token, amount, curve.pad), route: 'Virtuals\' curve', taxBps: 0 };
  const q = await zeroex.quote({ chainId: CHAINS[chain].chainId, sellToken: token, buyToken: NATIVE, sellAmount: amount, indicative: true }).catch(noRoute);
  return { out: q.buyAmount, route: '0x', taxBps: q.taxBps };
}

/** What `spend` (the wrapped native coin, or VIRTUAL on Virtuals' curve) buys now: { out, route, taxBps }. */
async function buyQuote(chain, token, spend, curve) {
  const lp = require('../services/launchpads');
  if (curve?.kind === 'fourmeme') return { out: (await lp.fourMemeBuyQuote(token, spend)).amount, route: 'four.meme', taxBps: 0 };
  if (curve?.kind === 'virtuals') return { out: await lp.curveBuyQuote(token, spend, curve.pad), route: 'Virtuals\' curve', taxBps: 0 };
  const q = await zeroex.quote({ chainId: CHAINS[chain].chainId, sellToken: CHAINS[chain].wrapped, buyToken: token, sellAmount: spend, indicative: true }).catch(noRoute);
  return { out: q.buyAmount, route: '0x', taxBps: q.taxBps };
}

async function nativeUsd(chain) {
  return require('../providers/prices').usdPrice(CHAINS[chain].priceId);
}

/* ── Placing an order ── */

const num = (v, lo, hi, dflt, name) => {
  const n = v === undefined || v === null || v === '' ? dflt : Number(v);
  if (!(n >= lo && n <= hi)) throw refuse(`${name} must be from ${lo} to ${hi}.`, 400);
  return n;
};
const netOf = feeBps => gross => BigInt(gross) - BigInt(gross) * BigInt(feeBps) / 10000n;
const quoteSource = route => (route === 'four.meme' ? 'four.meme\'s helper contract (the coin is on its curve)'
  : route === 'Virtuals\' curve' ? 'Virtuals\' FRouterV3 (getAmountsOut: the coin is on its curve; Virtuals\' taxes from its factory)' : '0x price');

async function memeWatchOn(accountId) {
  if (require('../admin/agentStates').isOff('meme_watch')) return false;
  const { rows } = await db.query(`SELECT enabled FROM agent_settings WHERE account_id = $1 AND agent = 'meme_watch'`, [accountId]);
  return !!rows[0]?.enabled;
}

async function symbolOf(chain, token) {
  const ds = await require('../providers/dexscreener').pairs(chain, [token]).catch(() => ({}));
  if (ds[token]?.symbol) return ds[token].symbol;
  return read(chain, token, ERC20, 'symbol').then(s => String(s).slice(0, 20)).catch(() => short(token));
}

/** A sale's worst case, in plain words, shown before the user signs. */
function worstCase({ kind, amountWhole, symbol, minOut, validUntil, q }) {
  const date = new Date(validUntil).toISOString().slice(0, 10);
  const what = `your ${fmt(amountWhole)} ${symbol}`;
  return [
    kind === 'take_profit'
      ? `Worst case, even if RektBull were hacked: ${what} are sold for ${nat(minOut)} ${q.symbol} after the 1% fee (your target less your slippage), at a moment RektBull picks before ${date}. That is more than they would sell for now.`
      : `Worst case, even if RektBull were hacked: ${what} are sold for ${nat(minOut)} ${q.symbol} after the 1% fee (your floor), at a moment RektBull picks before ${date}, even if the market is higher then.`,
    `Nothing else of yours can be touched: your wallet approves the Meme Router for these coins only, and the router sends what they sell for only to your wallet, in the same transaction. RektBull never holds them.`,
    'If the price falls straight past your floor, the order can\'t fill below it: you keep the coins, and RektBull tells you.',
    'To stop it: cancel it here (your wallet sends the cancel to the router), or revoke the approval in your wallet. Either works at once, even while RektBull is paused.',
  ];
}

/** A limit buy's worst case, in plain words. */
function worstCaseBuy({ spend, minCoins, symbol, validUntil, c, q }) {
  const date = new Date(validUntil).toISOString().slice(0, 10);
  return [
    `Worst case, even if RektBull were hacked: your ${spend} ${q.spendName} buys ${fmt(minCoins)} ${symbol} (your limit less your slippage), the 1% fee included, at a moment RektBull picks before ${date}, even if the price is lower then.`,
    `Nothing else of yours can be touched: your wallet approves the Meme Router for this ${q.spendName} only, and the router sends the coins only to your wallet, in the same transaction. RektBull never holds them.`,
    q.virtual ? 'If the price never comes down to your limit, nothing is bought, and your VIRTUAL stays in your wallet.'
      : `If the price never comes down to your limit, nothing is bought, and your ${q.spendName} stays in your wallet (you can unwrap it into ${c.native} any time).`,
    'Before each fill, RektBull runs its token check again: a critical risk stops the buy, and you are told.',
    'To stop it: cancel it here (your wallet sends the cancel to the router), or revoke the approval in your wallet.',
  ];
}

/**
 * Checks, terms and the order for the user's wallet to sign (EIP-712). Nothing
 * is sent: the approval (and for a buy, the wrapping) come after the signature,
 * sized to every live order on the coin (sign()). Throws a refusal saying which
 * check failed.
 */
async function prepare(account, body = {}, ladder = null) {
  if (!ladder && String(body.kind || '') === 'take_profit' && body.steps !== undefined && body.steps !== null) return prepareSteps(account, body);
  const chain = String(body.chain || '').toLowerCase();
  if (!CHAINS[chain]) throw refuse('chain must be base or bsc.', 400);
  const cfg = await ready(chain);
  const c = CHAINS[chain];
  const owner = String(account.wallet || '').toLowerCase();
  if (!addr(owner)) throw refuse('Link an EVM wallet to your account to place orders on BNB Chain and Base.', 409);
  const kind = String(body.kind || '');
  if (!KINDS[kind]) throw refuse(`kind must be one of ${Object.keys(KINDS).join(', ')}.`, 400);
  const token = String(body.token || '').toLowerCase();
  if (!addr(token) || token === NATIVE || token === c.wrapped.toLowerCase()) throw refuse('token must be the address of the meme coin.', 400);
  const days = num(body.days, 1, MAX_DAYS, MAX_DAYS, 'days');
  if (kind === 'meme_watch_exit' && !(await memeWatchOn(account.id))) {
    throw refuse('A Meme Watch exit sells when Meme Watch raises a critical alert for the coin. Switch on Meme Watch in My agents first.', 409);
  }
  const settings = await require('./rules').settingsFor(account.id);
  const decimals = Number(await read(chain, token, ERC20, 'decimals').catch(() => { throw refuse(`That isn't a token on ${c.label}.`); }));
  const symbol = await symbolOf(chain, token);
  const curve = await curveOf(chain, token, cfg.check);
  if (curve?.unsupported) throw refuse(curve.unsupported, 409);
  const anti = curve?.kind === 'virtuals' ? curve.pad.curve?.anti_sniper : null;
  if (anti?.ends_at || anti?.starts_at) {
    throw refuse(`Virtuals' anti-sniper tax is ${anti.ends_at ? `running on this coin until ${anti.ends_at}` : `about to start on this coin (${anti.starts_at})`}: a fill now would pay it. Place the order once it's over.`, 409);
  }
  const q0 = quoteAsset(chain, curve); // what this order is priced in: the native coin, or VIRTUAL on Virtuals' curve
  const usd = await usdOf(q0);
  const validUntil = Date.now() + days * 86400_000;
  const net = netOf(cfg.check.feeBps);
  const checks = [];
  let order, t, refOut, extra = {};

  if (kind === 'limit_buy') {
    const spend = num(body.spend, 0.0001, 1000, NaN, 'spend');
    const dip = num(body.dip_pct, 1, 95, 20, 'dip_pct');
    const slip = num(body.slippage_pct, 0.5, 20, 3, 'slippage_pct');
    const amountIn = ethers.parseEther(String(spend));
    const spendUsd = Math.round(spend * usd * 100) / 100;
    if (spendUsd > settings.max_trade_usd) throw refuse(`$${spendUsd} is over your per-trade amount of $${settings.max_trade_usd}. Change it in your trading settings.`);
    if (spendUsd < MIN_ORDER_USD) throw refuse(`An order needs at least $${MIN_ORDER_USD} (this is $${spendUsd}): RektBull pays each fill's network fee out of its 1%.`);
    checks.push({ check: 'per_trade_amount', ok: true, detail: `$${spendUsd} of your $${settings.max_trade_usd} per trade`, source: `your trading settings; ${q0.symbol}'s price from DefiLlama` });
    if (q0.virtual) {
      // VIRTUAL can't be wrapped from ETH in the wallet: the user needs it already.
      const have = BigInt(await read(chain, q0.in, ERC20, 'balanceOf', [owner]));
      if (have < amountIn) throw refuse(`Your wallet holds ${nat(have)} VIRTUAL, and this buy spends ${spend}. Orders on a Virtuals curve coin are in VIRTUAL (its curve trades in it): get VIRTUAL first, on the Trade desk.`);
    }
    await buyChecks(chain, token, body, checks);
    const toTrade = tx.toTrade(amountIn, cfg.check.feeBps, false);
    const q = await buyQuote(chain, token, toTrade, curve);
    if (!q.out) throw refuse(`There is no route to buy this coin with ${q0.spendName} just now (${q.route}).`);
    if (q.taxBps) throw refuse(`This coin taxes transfers (${q.taxBps / 100}%, 0x), so an order can't be filled exactly. Trade it from your own wallet on the Trade desk.`);
    const back = await sellQuote(chain, token, curve ? q.out - q.out % curve.sellUnit : q.out, curve);
    if (!back.out) throw refuse('There is no route to sell this coin back: it may be a honeypot. Not placing a buy.');
    const lossPct = Number((amountIn - back.out) * 10000n / amountIn) / 100;
    if (lossPct > settings.max_round_trip_loss_pct) throw refuse(`Selling straight back would lose ${lossPct.toFixed(1)}%, above your ${settings.max_round_trip_loss_pct}% limit: the token may tax transfers, or its pool is thin.`);
    checks.push({ check: 'sell_back', ok: true, detail: `selling straight back loses ${lossPct.toFixed(1)}% (fees included; limit ${settings.max_round_trip_loss_pct}%)`, source: quoteSource(q.route) });
    refOut = q.out;
    const trigger = refOut * 10000n / BigInt(Math.round((100 - dip) * 100));
    const minOut = trigger * BigInt(Math.round((100 - slip) * 100)) / 10000n;
    if (minOut <= 0n) throw refuse('That limit rounds to no coins; spend more.', 400);
    t = { triggerOut: trigger, minOut, said: { spend, dip_pct: dip, slippage_pct: slip } };
    order = { tokenIn: q0.in, tokenOut: token, amountIn };
    extra = { spendUsd, worst: worstCaseBuy({ spend, minCoins: whole(minOut, decimals), symbol, validUntil, c, q: q0 }) };
  } else {
    const share = num(body.share_pct, 1, 100, 100, 'share_pct');
    const held = BigInt(await read(chain, token, ERC20, 'balanceOf', [owner]));
    if (held === 0n) throw refuse('Your wallet holds none of this coin.');
    let amountIn = held * BigInt(Math.round(share * 100)) / 10000n;
    if (curve) amountIn -= amountIn % curve.sellUnit; // four.meme sells whole multiples of 10^9 units only
    if (amountIn === 0n) throw refuse('That share of your holding rounds to nothing.');
    const q = await sellQuote(chain, token, amountIn, curve);
    if (!q.out) throw refuse(`There is no route to sell this coin for ${q0.symbol} just now (${q.route}), so an order couldn't be filled.`);
    if (q.taxBps) throw refuse(`This coin taxes transfers (${q.taxBps / 100}%, 0x), so an order can't be filled exactly. Sell it from your own wallet on the Trade desk.`);
    refOut = q.out;
    const valueUsd = Math.round(whole(refOut, 18) * usd * 100) / 100;
    if (valueUsd < MIN_ORDER_USD) throw refuse(`An order needs at least $${MIN_ORDER_USD} (these sell for $${valueUsd} now): RektBull pays each fill's network fee out of its 1%.`);
    t = require('./solanaOrders').terms(kind, refOut, body, settings, net);
    if (t.minOut <= 0n) throw refuse('That floor rounds to nothing; choose a higher one.', 400);
    checks.push({ check: 'holding', ok: true, detail: `${fmt(whole(amountIn, decimals))} of the ${fmt(whole(held, decimals))} ${symbol} in your wallet`, source: `${c.label} RPC (balanceOf)` });
    checks.push({ check: 'route', ok: true, detail: `they would sell for ${nat(refOut)} ${q0.symbol} now ($${valueUsd})`, source: quoteSource(q.route) });
    order = { tokenIn: token, tokenOut: q0.out, amountIn };
    extra = { worst: worstCase({ kind, amountWhole: whole(amountIn, decimals), symbol, minOut: t.minOut, validUntil, q: q0 }) };
    if (t.trailBps) extra.trail = exitRules.trailNote({ trailPct: t.said.trail_pct, start: nat(t.triggerOut), floor: nat(t.minOut), unit: q0.symbol });
  }

  const epoch = await read(chain, cfg.router, ROUTER, 'epochOf', [owner]);
  const o = tx.order({ account: owner, executor: cfg.executor, ...order, minAmountOut: t.minOut, validUntil: Math.floor(validUntil / 1000), epoch, salt: BigInt('0x' + crypto.randomBytes(32).toString('hex')) });
  const hash = tx.hash(c.chainId, cfg.router, o);
  // The router's own hash of the same order: a layout that drifted from the contract's is caught before anyone signs.
  if (String(await read(chain, cfg.router, ROUTER, 'hashOrder', [o])).toLowerCase() !== hash.toLowerCase()) throw refuse('The router hashes this order differently, so RektBull won\'t ask you to sign it.', 503);
  checks.push({ check: 'order', ok: true, detail: 'the router hashes this order exactly as your wallet will sign it', source: `the Meme Router on ${c.label} (hashOrder)` });

  const { rows: [row] } = await db.query(
    `INSERT INTO meme_orders (account_id, chain, chain_id, router, owner, kind, token, symbol, decimals, token_in, token_out, amount_in, min_out, trigger_out, ref_out, executor, valid_until, order_json, order_hash, spend_usd, trail_bps, peak_out, ladder, step, steps)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25) RETURNING *`,
    [account.id, chain, c.chainId, cfg.router, owner, kind, token, symbol, decimals, o.tokenIn.toLowerCase(), o.tokenOut.toLowerCase(), o.amountIn.toString(), t.minOut.toString(),
      t.triggerOut?.toString() ?? null, refOut.toString(), cfg.executor, new Date(validUntil), JSON.stringify(tx.toJson(o)), hash.toLowerCase(), extra.spendUsd ?? null,
      t.trailBps ?? null, t.trailBps ? refOut.toString() : null, ladder?.id ?? null, ladder?.step ?? null, ladder?.of ?? null]);
  const buy = kind === 'limit_buy';
  return {
    order: view(row),
    terms: t.said,
    worst_case: extra.worst,
    notes: [
      ...(extra.trail ? [extra.trail] : []),
      buy ? (q0.virtual ? 'After you sign, your wallet approves the Meme Router for exactly the VIRTUAL your buys on Virtuals curve coins spend.'
        : `After you sign, your wallet wraps the ${c.native} it needs into ${c.wrappedName} (if it hasn't enough) and approves the Meme Router for exactly what your buys on ${c.label} spend.`)
        : `After you sign, your wallet approves the Meme Router for exactly what your orders on this coin sell (unless it already has).`,
      ...(curve?.kind === 'fourmeme' ? ['This coin is still on its four.meme curve: fills trade on the curve itself until it graduates, then through 0x.'] : []),
      ...(curve?.kind === 'virtuals' ? [`This coin is still on Virtuals' bonding curve, which trades in VIRTUAL, so this order is in VIRTUAL: ${buy ? 'it spends VIRTUAL' : 'its sale pays out VIRTUAL'}. Fills trade on the curve itself (Virtuals' BondingV5) until the coin graduates, then through 0x, still in VIRTUAL. Virtuals' own tax (${curve.pad.curve?.[buy ? 'buy_tax_pct' : 'sell_tax_pct'] ?? 1}% now) is in the prices shown.`] : []),
    ],
    costs: {
      deposit: 'No deposit: the order is only a signature. Your wallet pays the network fee for the approval (and the wrapping) once.',
      fee: `RektBull's ${cfg.check.feeBps / 100}% of the ${q0.symbol} a fill ${buy ? 'spends' : 'brings'}, taken by the router. Nothing if it never fills. RektBull pays each fill's network fee.`,
      fee_wallet: cfg.check.feeWallet,
    },
    checks,
    chain_id: ethers.toBeHex(c.chainId),
    typed_data: tx.typedData(c.chainId, cfg.router, o),
  };
}

/**
 * Take-profits in steps (exitRules.parseSteps): one router order a step, each its part of the share, prepared
 * together. The wallet signs each (a signature only); once the last is signed, one approval covers them all
 * (fundingCalls counts every live order on the coin). If a step can't be prepared, none is kept.
 */
async function prepareSteps(account, body) {
  const steps = exitRules.parseSteps(body.steps);
  const share = num(body.share_pct, 1, 100, 100, 'share_pct');
  const id = crypto.randomBytes(8).toString('hex');
  const out = [];
  try {
    for (const [i, s] of steps.entries()) {
      const one = { ...body, steps: undefined, take_pct: s.take_pct, share_pct: share * s.part_pct / 100 };
      out.push(await prepare(account, one, { id, step: i + 1, of: steps.length }).catch(err => { err.message = `Step ${i + 1}: ${err.message}`; throw err; }));
    }
  } catch (err) {
    await db.query(`DELETE FROM meme_orders WHERE ladder = $1 AND state = 'prepared'`, [id]);
    throw err;
  }
  const first = out[0];
  const sym = first.order.symbol || 'coins';
  return {
    ladder: id,
    steps: out.map((p, i) => ({ step: i + 1, part_pct: steps[i].part_pct, ...p.terms, order: p.order, typed_data: p.typed_data, worst_case: p.worst_case })),
    orders: out.map(p => p.order),
    worst_case: out.flatMap((p, i) => p.worst_case.slice(0, 1).map(x => `Step ${i + 1}. ${x}`)).concat(first.worst_case.slice(1)),
    notes: [
      `${out.length} take-profits on ${sym}, placed together: ${out.map((p, i) => `${p.order.amount_whole.toLocaleString('en-US')} ${sym} when their value is up ${steps[i].take_pct}% (step ${i + 1})`).join('; ')}. Your wallet signs each one (a signature only), then approves the router once for all of them. Each fills on its own; cancel any of them on its own.`,
      ...first.notes.slice(1),
    ],
    costs: first.costs,
    checks: out.flatMap((p, i) => p.checks.map(c => ({ ...c, detail: `step ${i + 1}: ${c.detail}` }))),
    chain_id: first.chain_id,
    typed_data: first.typed_data,
    order: first.order,
  };
}

/** The Trade desk's buy checks (the token check, the bundle check for a young coin), added to `checks`. */
async function buyChecks(chain, token, body, checks) {
  const dd = require('../services/dueDiligence');
  const [risk, launch] = await Promise.all([dd.quickCheck({ chain, token }), require('../services/launches').forTrade({ chain, token })]);
  if (risk.incomplete) throw refuse(`RektBull couldn't check whether this token can be sold (${risk.incomplete}) Not placing a buy.`);
  if (risk.verdict === 'critical') throw refuse(`RektBull's token check found a critical risk: ${risk.flags.find(f => f.severity === 'critical')?.title}. Not placing a buy.`);
  if (launch.risk === 'block') throw refuse(`RektBull's bundle check found a critical risk: ${launch.flags.find(f => f.severity === 'critical').title}. Not placing a buy.`);
  const high = [
    ...risk.flags.filter(f => f.severity === 'high'),
    ...(launch.risk === 'confirm' ? launch.flags.filter(f => f.severity === 'high').map(f => ({ id: 'bundle', ...f })) : []),
    ...(launch.risk === 'unknown' ? [{ id: 'bundle_unchecked', severity: 'high', title: 'This token is under a week old and RektBull couldn\'t check it for a bundled launch', evidence: launch.detail, source: 'Launch Safety' }] : []),
  ];
  if (high.length && !body.acknowledge_risks) {
    const err = refuse(`RektBull's checks found ${high.length} high risk${high.length > 1 ? 's' : ''}: ${high.map(f => f.title).join('; ')}. Read them, then confirm to go ahead.`);
    err.needsAcknowledgement = true;
    err.risks = high;
    throw err;
  }
  checks.push({ check: 'token_risk', ok: true, detail: `verdict ${risk.verdict}${high.length ? ` (you confirmed ${high.length} high risk${high.length > 1 ? 's' : ''})` : ''}`, source: 'RektBull\'s token check' });
  if (launch.young) checks.push({ check: 'bundle', ok: launch.risk !== 'unknown', detail: launch.risk === 'unknown' ? `the bundle check couldn't run (${launch.detail}); you confirmed going ahead without it` : `launch check: ${launch.detail}`, source: 'Launch Safety' });
}

/** Is `signature` the order account's, for this order hash? The key's own first, then EIP-1271 (a contract wallet), as the router checks. */
async function signedBy(chain, router, owner, o, hash, signature) {
  try {
    if (tx.signer(CHAINS[chain].chainId, router, o, signature).toLowerCase() === owner) return true;
  } catch { /* not an EOA signature: try the wallet's contract */ }
  const code = await provider(chain).getCode(owner);
  if (!code || code === '0x') return false;
  const magic = await read(chain, owner, EIP1271, 'isValidSignature', [hash, signature]).catch(() => null);
  return String(magic).toLowerCase() === '0x1626ba7e';
}

/**
 * The user's wallet signed it: the signature checked, the order opened, and
 * the calls their wallet sends next, if any: wrapping the native coin (a buy)
 * and approving the router for every live order on that input.
 */
async function sign(account, id, body = {}) {
  const row = await own(account, id);
  if (row.state !== 'prepared') return { order: view(row), calls: await fundingCalls(row) };
  if (row.signature) return { order: view(row), calls: { chain_id: ethers.toBeHex(row.chain_id), calls: [] } }; // an exit already signed, waiting for its buy
  const signature = String(body.signature || '');
  if (!/^0x[0-9a-fA-F]{130,}$/.test(signature)) throw refuse('signature must be the wallet\'s EIP-712 signature (0x…).', 400);
  const o = tx.fromJson(row.order_json);
  if (!(await signedBy(row.chain, row.router, row.owner, o, row.order_hash, signature))) {
    throw refuse('That signature isn\'t your wallet\'s for this order. Nothing was placed.', 409);
  }
  if (BigInt(await read(row.chain, row.router, ROUTER, 'epochOf', [row.owner])) !== o.epoch) {
    throw refuse('You cancelled all your orders on this router since this one was prepared. Prepare it again.', 409);
  }
  // An exit with a buy waits, signed, for its buy to land (its approval is in the buy's own batch); it's dropped if the buy didn't go through.
  if (row.trade_id) {
    const { rows: [t] } = await db.query('SELECT status FROM trade_proposals WHERE id = $1', [row.trade_id]);
    if (!t || ['failed', 'cancelled', 'expired'].includes(t.status)) {
      await db.query(`DELETE FROM meme_orders WHERE id = $1 AND state = 'prepared'`, [row.id]);
      throw refuse('The buy didn\'t go through, so its exits weren\'t placed.', 409);
    }
    if (t.status !== 'confirmed') {
      const { rows: [waiting] } = await db.query(`UPDATE meme_orders SET signature = $2, updated_at = now() WHERE id = $1 AND state = 'prepared' RETURNING *`, [row.id, signature]);
      return { order: view(waiting || row), calls: { chain_id: ethers.toBeHex(row.chain_id), calls: [] } };
    }
  }
  const { rows: [done] } = await db.query(`UPDATE meme_orders SET state = 'open', signature = $2, updated_at = now() WHERE id = $1 AND state = 'prepared' RETURNING *`, [row.id, signature]);
  return { order: view(done || row), calls: await fundingCalls(done || row) };
}

/* ── Exits with a buy (trade/proposals.js) ── */

/**
 * A stop-loss and/or a take-profit with a buy on the Trade desk, for the coins
 * the buy is sure to bring (its minimum), valued at the buy's own price. They
 * are Meme Router orders, signed by the user's wallet right after it sends the
 * buy (a signature only, so the buy isn't held up), and the approval of the
 * router for them goes in the buy's own batch, after the swap. They open when
 * the trade service confirms the buy, and are dropped if it fails.
 *
 * Returns null (none asked), { off: why }, or { orders, approve, summary }.
 * Nothing is stored: recordExits() does once the trade is made.
 */
async function exitsForBuy({ accountId, owner, chain, token, minOut, buyAmount, valueUsd, taxBps = 0, exits, settings }) {
  const kinds = ['stop_loss', 'take_profit'].filter(k => exits?.[k]);
  if (!kinds.length) return null;
  const cfg = config();
  if (cfg.off) return { off: cfg.off };
  if (!CHAINS[chain]) return { off: 'exits with a buy are on BNB Chain, Base and Solana.' };
  const router = cfg.routers[chain];
  if (!router) return { off: `orders on ${CHAINS[chain].label} aren't open yet.` };
  const check = await routerCheck(chain, router);
  if (!check.ok) return { off: check.why };
  if (taxBps) return { off: `this coin taxes transfers (${taxBps / 100}%, 0x), so an order can't be filled exactly.` };
  // A coin on Virtuals' curve: its exits are in VIRTUAL, what the curve trades in.
  const curve = await curveOf(chain, String(token).toLowerCase(), check);
  if (curve?.unsupported) return { off: curve.unsupported.replace(/\.$/, '') };
  const q = quoteAsset(chain, curve);
  const c = CHAINS[chain];
  owner = String(owner).toLowerCase();
  token = String(token).toLowerCase();
  const amountIn = BigInt(minOut);
  const expected = BigInt(buyAmount);
  if (amountIn <= 0n || expected <= 0n) return { off: 'the buy has no minimum to cover.' };
  // What the coins the buy is sure to bring cost, at this buy's price.
  const coveredUsd = Number(valueUsd) * Number(amountIn * 1_000_000n / expected) / 1_000_000;
  if (coveredUsd < MIN_ORDER_USD) return { off: `an order needs at least $${MIN_ORDER_USD} (RektBull pays each fill's network fee out of its 1%), and the coins this buy is sure to bring cost $${coveredUsd.toFixed(2)}.` };
  const refOut = BigInt(Math.floor(coveredUsd / await usdOf(q) * 1e18)); // in what the exits pay out: ETH, BNB or VIRTUAL
  const days = num(exits.days, 1, MAX_DAYS, MAX_DAYS, 'days');
  const validUntil = Date.now() + days * 86400_000;
  const [decimals, symbol, epoch, allowance] = await Promise.all([
    read(chain, token, ERC20, 'decimals').then(Number), symbolOf(chain, token),
    read(chain, router, ROUTER, 'epochOf', [owner]), read(chain, token, ERC20, 'allowance', [owner, router]).then(BigInt),
  ]);
  const net = netOf(check.feeBps);
  // A copy's stop-loss can also sell when the copied wallet sells: only a wallet this account follows.
  const copyWallet = exits.copy_wallet && kinds.includes('stop_loss') ? await require('../services/walletTracker').followed(accountId, exits.copy_wallet) : null;
  const orders = [];
  for (const kind of kinds) {
    const t = require('./solanaOrders').terms(kind, refOut, exits, settings, net);
    if (t.minOut <= 0n) return { off: 'that floor rounds to nothing.' };
    const o = tx.order({ account: owner, executor: cfg.executor, tokenIn: token, tokenOut: q.out, amountIn, minAmountOut: t.minOut, validUntil: Math.floor(validUntil / 1000), epoch, salt: BigInt('0x' + crypto.randomBytes(32).toString('hex')) });
    orders.push({ kind, kind_name: KINDS[kind], order: o, hash: tx.hash(c.chainId, router, o), minOut: t.minOut, triggerOut: t.triggerOut, refOut, said: t.said, trailBps: t.trailBps ?? null,
      copyWallet: kind === 'stop_loss' ? copyWallet : null });
  }
  // The router's own hash of the first: a layout that drifted from the contract's is caught before anyone signs.
  if (String(await read(chain, router, ROUTER, 'hashOrder', [orders[0].order])).toLowerCase() !== orders[0].hash.toLowerCase()) {
    return { off: 'the router hashes these orders differently, so RektBull won\'t ask you to sign them.' };
  }
  // The approval: these coins for each exit, plus what's left of the account's other live orders on them (an approval
  // replaces the one before it). None when the router may already take that much.
  const { rows: [live] } = await db.query(
    `SELECT COALESCE(sum(amount_in - filled_in), 0)::text AS left FROM meme_orders
      WHERE account_id = $1 AND chain = $2 AND router = $3 AND token_in = $4 AND valid_until > now()
        AND (state IN ('open', 'triggered') OR (state = 'prepared' AND trade_id IS NOT NULL AND signature IS NOT NULL))`,
    [accountId, chain, router, token]);
  const approveAmount = amountIn * BigInt(kinds.length) + BigInt(live.left);
  const approve = allowance >= approveAmount ? null : { step: 'exit_approve', ...tx.approveCall(token, router, approveAmount) };
  const amountWhole = whole(amountIn, decimals);
  return {
    chain, router, executor: cfg.executor, token, symbol, decimals, validUntil, approve,
    orders,
    summary: {
      chain_label: c.label, native: q.symbol, ...(curve?.kind === 'virtuals' ? { note: 'The coin is on Virtuals\' curve, which trades in VIRTUAL: these exits pay out VIRTUAL.' } : {}),
      orders: orders.map(o => ({ kind: o.kind, kind_name: o.kind_name, trigger_native: nat(o.triggerOut), floor_native: nat(o.minOut), ...o.said, ...(o.copyWallet ? { sells_with: o.copyWallet } : {}) })),
      covers: `the ${fmt(amountWhole)} ${symbol} this buy is sure to bring (its minimum); anything it brings above that isn't covered`,
      ...(exits.copy_wallet && !copyWallet && kinds.includes('stop_loss') ? { copy_note: 'The stop-loss won\'t sell with that wallet: you don\'t follow it.' } : {}),
      how: `Your wallet signs ${orders.length > 1 ? 'them' : 'it'} right after it sends the buy (a signature, nothing is sent)${approve ? ', and the approval of RektBull\'s Meme Router for these coins is in the buy\'s own batch, after the swap' : ''}. ${orders.length > 1 ? 'They open' : 'It opens'} when the buy lands.`,
      worst_case: [
        ...orders.map(o => worstCase({ kind: o.kind, amountWhole, symbol, minOut: o.minOut, validUntil, q })[0]),
        ...(copyWallet ? [`The stop-loss also sells, at the market and never below its floor, when ${short(copyWallet)} sells ${symbol}: the Wallet Tracker sees the sale while you follow that wallet. If you stop following it, this is a plain stop-loss.`] : []),
        `Nothing else of yours can be touched: the approval covers only these coins, and the router sends what they sell for only to your wallet, in the same transaction. RektBull never holds them.`,
        ...(orders.length > 1 ? ['The two orders sell the same coins: once one has sold them, the other has nothing left to sell (cancel it on the Trade desk).'] : []),
        'To stop them: cancel them on the Trade desk (your wallet sends the cancel to the router), or revoke the approval in your wallet.',
      ],
      costs: { deposit: 'No deposit: an order is only a signature.', fee: `RektBull's ${check.feeBps / 100}% of the ${q.symbol} an exit brings, taken by the router. Nothing if it never fills. RektBull pays each fill's network fee.` },
    },
  };
}

/** The trade was made with exits: their rows, prepared, waiting for the user's signatures and for the buy. What the page asks the wallet to sign. */
async function recordExits(accountId, tradeId, plan) {
  if (!plan?.orders?.length) return [];
  const c = CHAINS[plan.chain];
  const out = [];
  for (const o of plan.orders) {
    const { rows: [row] } = await db.query(
      `INSERT INTO meme_orders (account_id, chain, chain_id, router, owner, kind, token, symbol, decimals, token_in, token_out, amount_in, min_out, trigger_out, ref_out, executor, valid_until, order_json, order_hash, trade_id, trail_bps, peak_out, copy_wallet)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23) RETURNING *`,
      [accountId, plan.chain, c.chainId, plan.router, o.order.account.toLowerCase(), o.kind, plan.token, plan.symbol, plan.decimals, plan.token, NATIVE, o.order.amountIn.toString(), o.minOut.toString(),
        o.triggerOut?.toString() ?? null, o.refOut.toString(), plan.executor, new Date(plan.validUntil), JSON.stringify(tx.toJson(o.order)), o.hash.toLowerCase(), tradeId,
        o.trailBps || null, o.trailBps ? o.refOut.toString() : null, o.copyWallet || null]);
    out.push({ id: Number(row.id), kind: o.kind, kind_name: o.kind_name, chain_id: ethers.toBeHex(c.chainId), typed_data: tx.typedData(c.chainId, plan.router, o.order) });
  }
  return out;
}

/**
 * What the user's wallet must send so the router can fill this order: the
 * approval for every live order on the same input (an approval replaces the
 * one before it), and for a buy, any wrapping still needed. { chain_id, calls }.
 */
async function fundingCalls(row) {
  const c = CHAINS[row.chain];
  const { rows: [live] } = await db.query(
    `SELECT COALESCE(sum(amount_in - filled_in), 0)::text AS left FROM meme_orders
      WHERE account_id = $1 AND chain = $2 AND router = $3 AND token_in = $4 AND state IN ('open', 'triggered') AND valid_until > now()`,
    [row.account_id, row.chain, row.router, row.token_in]);
  const need = BigInt(live.left);
  const calls = [];
  if (need === 0n) return { chain_id: ethers.toBeHex(c.chainId), calls };
  const [allowance, balance] = await Promise.all([
    read(row.chain, row.token_in, ERC20, 'allowance', [row.owner, row.router]).then(BigInt),
    read(row.chain, row.token_in, ERC20, 'balanceOf', [row.owner]).then(BigInt),
  ]);
  if (isBuy(row) && balance < need && !quoteOfRow(row).virtual) {
    const wrap = need - balance;
    const have = await provider(row.chain).getBalance(row.owner);
    if (have < wrap) throw refuse(`Your wallet holds ${nat(have)} ${c.native}, and your buys need ${nat(wrap)} more ${c.wrappedName}. Add ${c.native} and try again; the order stays open.`);
    calls.push({ ...tx.wrapCall(c.wrapped, wrap), label: `Wrap ${nat(wrap)} ${c.native} into ${c.wrappedName}` });
  }
  if (allowance < need) {
    calls.push({ ...tx.approveCall(row.token_in, row.router, need), label: `Approve the Meme Router for ${isBuy(row) ? `${nat(need)} ${quoteOfRow(row).spendName}` : `${fmt(whole(need, row.decimals))} ${row.symbol || 'coins'}`}` });
  }
  return { chain_id: ethers.toBeHex(c.chainId), calls };
}

/** The calls for the user's wallet to cancel: the order on the router, and the approval revoked when it was the last on that input. */
async function cancel(account, id) {
  const row = await own(account, id);
  if (['filled', 'cancelled'].includes(row.state)) return { order: view(row), done: true };
  if (row.state === 'prepared' && !row.signature) {
    await db.query(`DELETE FROM meme_orders WHERE id = $1 AND state = 'prepared'`, [row.id]);
    return { order: { ...view(row), state: 'cancelled' }, done: true };
  }
  const { rows: [others] } = await db.query(
    `SELECT count(*)::int AS n FROM meme_orders WHERE account_id = $1 AND chain = $2 AND router = $3 AND token_in = $4 AND id <> $5 AND state IN ('open', 'triggered') AND valid_until > now()`,
    [account.id, row.chain, row.router, row.token_in, row.id]);
  const last = !others.n;
  const calls = [{ ...tx.cancelCall(row.router, tx.fromJson(row.order_json)), label: 'Cancel the order on the Meme Router' }];
  if (last) calls.push({ ...tx.approveCall(row.token_in, row.router, 0n), label: 'Revoke the router\'s approval' });
  return { order: view(row), revokes_approval: last, chain_id: ethers.toBeHex(row.chain_id), calls };
}

/** Every order on one chain at once: the router's cancelAll (a new epoch), and every approval revoked. */
async function cancelAll(account, body = {}) {
  const chain = String(body.chain || '').toLowerCase();
  if (!CHAINS[chain]) throw refuse('chain must be base or bsc.', 400);
  const owner = String(account.wallet || '').toLowerCase();
  const { rows } = await db.query(`SELECT DISTINCT router, token_in FROM meme_orders WHERE account_id = $1 AND chain = $2 AND owner = $3 AND state IN ('open', 'triggered', 'expired')`, [account.id, chain, owner]);
  const routers = [...new Set([...rows.map(r => r.router), ...(config().routers?.[chain] ? [config().routers[chain]] : [])])];
  if (!routers.length) throw refuse(`You have no orders on ${CHAINS[chain].label}.`, 404);
  const calls = [
    ...routers.map(r => ({ ...tx.cancelAllCall(r), label: 'Cancel every order you signed on the Meme Router' })),
    ...rows.map(r => ({ ...tx.approveCall(r.token_in, r.router, 0n), label: 'Revoke the router\'s approval' })),
  ];
  return { chain_id: ethers.toBeHex(CHAINS[chain].chainId), calls };
}

/** After the wallet sent a cancel (or any time): the order's state from the router. */
async function refresh(account, id) {
  const row = await own(account, id);
  if (!['open', 'triggered', 'expired'].includes(row.state) && !(row.state === 'prepared' && row.signature)) return view(row);
  return view(await settle(row));
}

/** The order read back from the router: cancelled (one or all), filled, or as it was. */
async function settle(row) {
  const [cancelled, epoch, filled] = await Promise.all([
    read(row.chain, row.router, ROUTER, 'cancelled', [row.order_hash]),
    read(row.chain, row.router, ROUTER, 'epochOf', [row.owner]).then(BigInt),
    read(row.chain, row.router, ROUTER, 'filled', [row.order_hash]).then(BigInt),
  ]);
  const { rows: [pending] } = await db.query(`SELECT count(*)::int AS n FROM meme_order_fills WHERE order_id = $1 AND state = 'sent'`, [row.id]);
  return settleWith(row, { cancelled, epoch, filled }, pending.n > 0);
}

/** An order's state from what the router says ({ cancelled, epoch, filled }); a fill still in flight is confirmed first. */
async function settleWith(row, { cancelled, epoch, filled }, inFlight) {
  const o = tx.fromJson(row.order_json);
  let state = row.state;
  if (filled >= BigInt(row.amount_in) && !inFlight) state = 'filled';
  else if (cancelled || epoch !== o.epoch) state = 'cancelled';
  if (state === row.state && filled === BigInt(row.filled_in)) return row;
  const { rows: [done] } = await db.query('UPDATE meme_orders SET state = $2, filled_in = $3, updated_at = now() WHERE id = $1 RETURNING *', [row.id, state, filled.toString()]);
  return done;
}

async function own(account, id) {
  const { rows: [row] } = await db.query('SELECT * FROM meme_orders WHERE id = $1 AND account_id = $2', [Number(id) || 0, account.id]);
  if (!row) throw Object.assign(new Error('No such order.'), { status: 404 });
  return row;
}

/** The account's orders, newest first, with their fills. */
async function list(account) {
  // Exits signed with a buy show while they wait for it to land.
  const { rows } = await db.query(`SELECT * FROM meme_orders WHERE account_id = $1 AND (state <> 'prepared' OR signature IS NOT NULL) ORDER BY created_at DESC LIMIT 100`, [account.id]);
  const { rows: fills } = rows.length ? await db.query('SELECT * FROM meme_order_fills WHERE order_id = ANY($1::bigint[]) ORDER BY created_at', [rows.map(r => r.id)]) : { rows: [] };
  const cfg = config();
  return {
    enabled: !cfg.off, ...(cfg.off ? { why: cfg.off } : {}),
    chains: Object.entries(CHAINS).map(([name, c]) => ({ chain: name, label: c.label, native: c.native, open: !cfg.off && !!cfg.routers[name] })),
    orders: rows.map(r => ({ ...view(r), fills: fills.filter(f => f.order_id === r.id).map(f => fillView(r, f)) })),
  };
}

function fillView(r, f) {
  const c = CHAINS[r.chain];
  const q = quoteOfRow(r);
  const fee = f.fee ? (f.fee_on_output ? `${nat(f.fee)} ${q.symbol}` : isBuy(r) ? `${nat(f.fee)} ${q.spendName}` : `${fmt(whole(f.fee, r.decimals))} ${r.symbol || 'coins'}`) : null;
  return {
    tx_hash: f.tx_hash, state: f.state, route: f.route, fee, error: f.error, at: f.created_at, tx_url: c.explorerTx(f.tx_hash),
    ...(isBuy(r) ? { spent_native: nat(f.amount_in), coins: f.delivered ? whole(f.delivered, r.decimals) : null } : { sold_whole: whole(f.amount_in, r.decimals), delivered_native: f.delivered ? nat(f.delivered) : null }),
  };
}

function view(r) {
  const c = CHAINS[r.chain];
  const common = {
    id: Number(r.id), chain: r.chain, chain_label: c.label, native: quoteOfRow(r).symbol, kind: r.kind, kind_name: KINDS[r.kind], side: isBuy(r) ? 'buy' : 'sell', state: r.state,
    token: r.token, symbol: r.symbol, valid_until: r.valid_until, triggered_at: r.triggered_at, trigger_reason: r.trigger_reason, sells_with: r.copy_wallet || null,
    last_error: r.last_error, order_hash: r.order_hash, router: r.router, created_at: r.created_at,
    ...(r.trade_id ? { trade_id: r.trade_id, waiting_for_buy: r.state === 'prepared' } : {}),
  };
  if (isBuy(r)) {
    return {
      ...common, spend_native: nat(r.amount_in), spent_native: nat(r.filled_in), spend_usd: r.spend_usd === null || r.spend_usd === undefined ? null : Number(r.spend_usd),
      min_coins: whole(r.min_out, r.decimals), trigger_coins: r.trigger_out ? whole(r.trigger_out, r.decimals) : null,
      coins_when_placed: whole(r.ref_out, r.decimals), bought_coins: whole(r.delivered, r.decimals),
    };
  }
  return {
    ...common, amount_whole: whole(r.amount_in, r.decimals), sold_whole: whole(r.filled_in, r.decimals),
    floor_native: nat(r.min_out), trigger_native: r.trigger_out ? nat(r.trigger_out) : null, value_when_placed_native: nat(r.ref_out), delivered_native: nat(r.delivered),
    ...(r.trail_bps ? { trail_pct: r.trail_bps / 100, peak_native: nat(r.peak_out) } : {}),
    ...(r.ladder ? { ladder: r.ladder, step: r.step, steps: r.steps } : {}),
  };
}

/* ── Meme Watch ── */

/** A critical Meme Watch alert for a coin on BNB Chain or Base: every open Meme Watch exit on it fires. */
async function memeWatchSignal(chain, token, reason) {
  if (!env.databaseUrl || !CHAINS[chain] || !addr(token)) return 0;
  const { rowCount } = await db.query(
    `UPDATE meme_orders SET state = 'triggered', triggered_at = now(), trigger_reason = $3, next_attempt_at = now(), updated_at = now()
      WHERE chain = $1 AND token = $2 AND kind = 'meme_watch_exit' AND state = 'open' AND valid_until > now()`,
    [chain, String(token).toLowerCase(), JSON.stringify({ ...reason, at: new Date().toISOString() })]);
  if (rowCount) logger.info('meme orders: Meme Watch exits fired', { chain, token, orders: rowCount });
  return rowCount;
}

/**
 * A followed wallet sold a coin on BNB Chain or Base (the Wallet Tracker): the open stop-losses placed with copies
 * of its buys fire. They sell at the market, never below their own floor (the router checks it on every fill).
 */
async function copySellSignal(chain, wallet, token, reason) {
  if (!env.databaseUrl || !CHAINS[chain] || !addr(wallet) || !addr(token)) return 0;
  const { rowCount } = await db.query(
    `UPDATE meme_orders SET state = 'triggered', triggered_at = now(), trigger_reason = $4, next_attempt_at = now(), updated_at = now()
      WHERE chain = $1 AND copy_wallet = $2 AND token = $3 AND kind = 'stop_loss' AND state = 'open' AND valid_until > now()`,
    [chain, String(wallet).toLowerCase(), String(token).toLowerCase(), JSON.stringify({ ...reason, at: new Date().toISOString() })]);
  if (rowCount) logger.info('meme orders: copied wallet sold, stop-losses fired', { chain, wallet, token, orders: rowCount });
  return rowCount;
}

/* ── The trade service's pass ── */

async function alert(row, severity, id, title, text, source = 'RektBull\'s order service') {
  await require('../services/myAgents').raise(row.account_id, [{
    kind: 'meme_order', severity, wallet: row.owner, dedupe: `memeorder:${row.id}:${id}`, title: `${KINDS[row.kind]} on ${row.symbol || short(row.token)} (${CHAINS[row.chain].label}): ${title}`.slice(0, 200),
    detail: { reasons: [{ text, source }], order_id: Number(row.id), token: { chain: row.chain, token: row.token } },
  }]).catch(err => logger.warn('meme orders: alert not raised', { order: row.id, error: err.message }));
}

/**
 * Prepared orders never signed forgotten, ended orders marked (every pass),
 * and live orders read back from the routers, cancelled or filled from the
 * user's own wallet or elsewhere (once a minute, batched through Multicall3).
 */
let lastReadBack = 0;
async function reconcile({ force = false } = {}) {
  await db.query(`DELETE FROM meme_orders WHERE state = 'prepared' AND created_at < now() - make_interval(secs => $1) AND (trade_id IS NULL OR signature IS NULL)`, [PREPARED_TTL_MS / 1000]);
  // Exits with a buy: opened once the buy is confirmed onchain, dropped if it failed (nothing was approved or bought).
  await db.query(`DELETE FROM meme_orders m USING trade_proposals t WHERE m.trade_id = t.id AND m.state = 'prepared' AND t.status IN ('failed', 'cancelled', 'expired')`);
  const { rows: opened } = await db.query(
    `UPDATE meme_orders m SET state = 'open', updated_at = now() FROM trade_proposals t
      WHERE m.trade_id = t.id AND m.state = 'prepared' AND m.signature IS NOT NULL AND t.status = 'confirmed' RETURNING m.id`);
  if (opened.length) logger.info('meme orders: exits opened with their buys', { orders: opened.length });
  const { rows: ended } = await db.query(
    `UPDATE meme_orders o SET state = 'expired', updated_at = now() WHERE state IN ('open', 'triggered') AND valid_until < now()
       AND NOT EXISTS (SELECT 1 FROM meme_order_fills f WHERE f.order_id = o.id AND f.state = 'sent') RETURNING *`);
  for (const row of ended) {
    await alert(row, 'medium', 'expired', 'it has ended', 'It reached its end date without filling, so the router won\'t fill it any more. Your wallet\'s approval for the router is still there: revoke it on the Trade desk (Cancel) if you don\'t need it.');
  }
  if (!force && Date.now() - lastReadBack < 60_000) return;
  lastReadBack = Date.now();
  const routers = config().routers || {};
  const { rows } = await db.query(`SELECT * FROM meme_orders WHERE state IN ('open', 'triggered') ORDER BY id LIMIT 2000`);
  const live = rows.filter(r => routers[r.chain]);
  if (!live.length) return;
  const { rows: sent } = await db.query(`SELECT DISTINCT order_id FROM meme_order_fills WHERE state = 'sent' AND order_id = ANY($1::bigint[])`, [live.map(r => r.id)]);
  const inFlight = new Set(sent.map(r => String(r.order_id)));
  // One Multicall3 call per chain for up to about 100 orders (cancelled and filled for each, epochOf once per wallet),
  // instead of three calls an order: the read-back runs before the pass's fills, so this keeps them from waiting.
  for (const chain of [...new Set(live.map(r => r.chain))]) {
    const mine = live.filter(r => r.chain === chain);
    const owners = [...new Set(mine.map(r => `${r.router}|${r.owner}`))];
    let got;
    try {
      got = await readMany(chain, [
        ...owners.map(k => { const [router, owner] = k.split('|'); return { target: router, iface: ROUTER, fn: 'epochOf', args: [owner] }; }),
        ...mine.flatMap(r => [{ target: r.router, iface: ROUTER, fn: 'cancelled', args: [r.order_hash] }, { target: r.router, iface: ROUTER, fn: 'filled', args: [r.order_hash] }]),
      ]);
    } catch (err) {
      logger.warn('meme orders: orders not read back', { chain, orders: mine.length, error: err.message });
      continue;
    }
    const epochs = new Map(owners.map((k, i) => [k, got[i]]));
    for (const [i, row] of mine.entries()) {
      const epoch = epochs.get(`${row.router}|${row.owner}`);
      const [cancelled, filled] = [got[owners.length + 2 * i], got[owners.length + 2 * i + 1]];
      if (!epoch.ok || !cancelled.ok || !filled.ok) continue; // read again next minute
      await settleWith(row, { cancelled: cancelled.value, epoch: BigInt(epoch.value), filled: BigInt(filled.value) }, inFlight.has(String(row.id)))
        .catch(err => logger.warn('meme orders: order not read back', { order: row.id, error: err.message }));
    }
  }
}

/** Stop-losses, take-profits and limit buys whose trigger is reached, by DexScreener's price, marked to fill. */
/**
 * An order against a coin's price (USD) and the native coin's: { reason } when it fires, else { distance }, how far
 * it is from its trigger (0.1 = 10% to go). The trade pass uses DexScreener's price; the stream (memeStream.js) the
 * price in a pool's own events.
 */
function checkPrice(row, p, usd, source) {
  const left = BigInt(row.amount_in) - BigInt(row.filled_in);
  if (left <= 0n || !(p > 0) || !(usd > 0) || !row.trigger_out) return { distance: null };
  const trigger = BigInt(row.trigger_out) * left / BigInt(row.amount_in);
  if (trigger <= 0n) return { distance: null };
  if (isBuy(row)) {
    // What the wrapped coin left would buy now (less the fee), against the coins at the user's limit.
    const coins = BigInt(Math.floor(whole(tx.toTrade(left, 100, false), 18) * usd / p * 10 ** row.decimals));
    if (coins >= trigger) return { reason: { price_usd: p, native_usd: usd, coins_now: whole(coins, row.decimals), coins_at_limit: whole(trigger, row.decimals), source } };
    return { distance: Number(trigger - coins) / Number(trigger) };
  }
  const value = BigInt(Math.floor(whole(left, row.decimals) * p / usd * 1e18));
  const fires = row.kind === 'stop_loss' ? value <= trigger : value >= trigger;
  if (fires) return { reason: { price_usd: p, native_usd: usd, value_native: nat(value), trigger_native: nat(trigger), source } };
  return { distance: Math.abs(Number(value - trigger)) / Number(trigger) };
}

/** Marks an open order fired, with why. True when this call fired it. */
async function fire(id, reason) {
  const { rowCount } = await db.query(`UPDATE meme_orders SET state = 'triggered', triggered_at = now(), trigger_reason = $2, next_attempt_at = now(), updated_at = now() WHERE id = $1 AND state = 'open'`, [id, JSON.stringify(reason)]);
  return rowCount > 0;
}

// The last prices the trade pass read, per chain: { at, native_usd, pairs } (memeStream.js arms its subscriptions from them).
const lastSeen = {};

async function triggers() {
  const { rows } = await db.query(`SELECT * FROM meme_orders WHERE state = 'open' AND kind IN ('stop_loss', 'take_profit', 'limit_buy') AND valid_until > now()`);
  for (const chain of [...new Set(rows.map(r => r.chain))]) {
    const mine = rows.filter(r => r.chain === chain);
    const tokens = [...new Set(mine.map(r => r.token))];
    const virtual = mine.some(r => quoteOfRow(r).virtual);
    const [pairs, usd, virtualUsd] = await Promise.all([
      cached(`meme:orders:prices:${chain}:${crypto.createHash('sha1').update(tokens.join(',')).digest('hex')}`, 10, () => require('../providers/dexscreener').pairs(chain, tokens)),
      nativeUsd(chain),
      virtual ? usdOf(quoteAsset(chain, { kind: 'virtuals' })) : null,
    ]);
    lastSeen[chain] = { at: Date.now(), native_usd: usd, virtual_usd: virtualUsd, pairs };
    for (const row of mine) {
      const q = quoteOfRow(row);
      const source = `DexScreener (the coin's most liquid pair) and DefiLlama (${q.symbol})`;
      const p = pairs[row.token]?.price_usd;
      const quoteUsd = q.virtual ? virtualUsd : usd;
      if (row.trail_bps && p > 0 && quoteUsd > 0) {
        // A trailing stop: raised to trail_bps under the highest value seen two checks in a row (exitRules.trail), never lowered.
        const tr = exitRules.trail(row, BigInt(Math.floor(whole(row.amount_in, row.decimals) * p / quoteUsd * 1e18)));
        await db.query(`UPDATE meme_orders SET peak_out = $2, trigger_out = $3, last_value_out = $4, updated_at = now() WHERE id = $1 AND state = 'open'`, [row.id, tr.peak.toString(), tr.trigger.toString(), tr.last.toString()]);
        row.trigger_out = tr.trigger.toString();
      }
      const c = checkPrice(row, p, quoteUsd, source);
      if (c.reason) await fire(row.id, c.reason);
    }
  }
}

/** The fills sent earlier: confirmed from the router's Filled event, or failed. */
async function confirmFills() {
  const { rows } = await db.query(
    `SELECT f.*, o.account_id, o.chain, o.router, o.kind, o.symbol, o.token, o.owner, o.decimals, o.order_hash, o.amount_in AS order_amount
       FROM meme_order_fills f JOIN meme_orders o ON o.id = f.order_id WHERE f.state = 'sent' ORDER BY f.id LIMIT 100`);
  for (const f of rows) {
    const c = CHAINS[f.chain];
    const failed = async error => {
      await db.query(`UPDATE meme_order_fills SET state = 'failed', error = $2 WHERE id = $1`, [f.id, String(error).slice(0, 500)]);
      await db.query(`UPDATE meme_orders SET last_error = $2, next_attempt_at = now() + make_interval(secs => $3), updated_at = now() WHERE id = $1`, [f.order_id, String(error).slice(0, 500), RETRY_MS.failed / 1000]);
    };
    const receipt = await provider(f.chain).getTransactionReceipt(f.tx_hash).catch(() => null);
    if (!receipt) {
      const age = Date.now() - new Date(f.created_at).getTime();
      if (f.sent_via === 'private' && !f.public_at && f.raw_tx && age > privateSend.graceMs()) await sendPublicly(f, failed);
      else if (age > NOT_SEEN_MS) await failed('it wasn\'t seen onchain within 30 minutes');
      continue;
    }
    if (receipt.status !== 1) { await failed('it reverted onchain'); continue; }
    const ev = tx.filledEvents(receipt.logs, f.router, f.owner).find(e => e.orderHash.toLowerCase() === f.order_hash);
    if (!ev) { await failed('the transaction made no fill of this order'); continue; }
    await db.query(`UPDATE meme_order_fills SET state = 'confirmed', amount_in = $2, delivered = $3, fee = $4, fee_on_output = $5, confirmed_at = now() WHERE id = $1`,
      [f.id, ev.amountIn.toString(), ev.amountOut.toString(), ev.fee.toString(), ev.feeOnOutput]);
    const filled = BigInt(await read(f.chain, f.router, ROUTER, 'filled', [f.order_hash]));
    const { rows: [o] } = await db.query(
      `UPDATE meme_orders SET filled_in = GREATEST(filled_in, $2), delivered = delivered + $3, last_error = NULL, attempts = 0,
         state = CASE WHEN GREATEST(filled_in, $2) >= amount_in THEN 'filled' ELSE state END, updated_at = now() WHERE id = $1 RETURNING *`,
      [f.order_id, filled.toString(), ev.amountOut.toString()]);
    const source = `${c.label} transaction ${f.tx_hash.slice(0, 10)}…, the Meme Router's Filled event`;
    // RektBull Points: a rebate of the 1% this fill paid, priced now (rewards/points.js). Never blocks the fill.
    if (ev.fee > 0n) {
      await usdOf(quoteOfRow(o))
        .then(usd => (usd > 0 ? require('../rewards/points').safeCredit({ accountId: o.account_id, source: 'order_fill', ref: f.tx_hash, feeUsd: whole(ev.fee, 18) * usd }) : null))
        .catch(err => logger.warn('meme orders: a fill\'s Points rebate was not priced', { fill: f.tx_hash, error: err.message }));
    }
    if (isBuy(o)) {
      await alert(o, 'high', `fill:${f.tx_hash}`, o.state === 'filled' ? 'bought' : 'bought in part',
        `Bought ${fmt(whole(ev.amountOut, o.decimals))} ${o.symbol || 'coins'}, sent to your wallet, for ${nat(ev.amountIn)} of your ${quoteOfRow(o).spendName} (RektBull's fee: ${nat(ev.fee)} ${quoteOfRow(o).spendName}, included). What wasn't used went back to your wallet.`, source);
    } else {
      await alert(o, 'high', `fill:${f.tx_hash}`, o.state === 'filled' ? 'sold' : 'sold in part',
        `Sold ${fmt(whole(ev.amountIn, o.decimals))} ${o.symbol || 'coins'} for ${nat(ev.amountOut)} ${quoteOfRow(o).symbol}, sent to your wallet (RektBull's fee: ${nat(ev.fee)} ${quoteOfRow(o).symbol}).`, source);
    }
  }
}

/**
 * A fill sent privately that hasn't landed: the same signed transaction (same hash, same nonce, so it can only land
 * once) sent the usual way. If the chain's RPC refuses it, it can't land, and nor can the executor's later fills on
 * that chain, whose nonces come after it: they're marked failed too, and every one is filled again at the next pass.
 */
async function sendPublicly(f, failed) {
  await db.query(`UPDATE meme_order_fills SET public_at = now() WHERE id = $1`, [f.id]);
  try {
    await provider(f.chain).broadcastTransaction(f.raw_tx);
    logger.warn('meme orders: a private fill hadn\'t landed; sent the usual way too', { order: f.order_id, tx: f.tx_hash, relays: f.relays });
  } catch (err) {
    const m = err.shortMessage || err.message || String(err);
    if (/already known|known transaction|nonce too low|nonce has already been used/i.test(m)) return; // it's out there, or it landed
    await failed(`it didn't land privately and the usual way refused it: ${m}`);
    const { rows: later } = await db.query(
      `UPDATE meme_order_fills f SET state = 'failed', error = $3
         FROM meme_orders o WHERE f.order_id = o.id AND o.chain = $1 AND f.state = 'sent' AND f.nonce > $2 RETURNING f.order_id`,
      [f.chain, f.nonce, 'an earlier fill from RektBull\'s executor didn\'t go through, so this one couldn\'t land: it\'s sent again']);
    if (later.length) await db.query(`UPDATE meme_orders SET next_attempt_at = now(), updated_at = now() WHERE id = ANY($1::bigint[])`, [later.map(r => r.order_id)]);
  }
}

/**
 * The executor's next nonce on a chain whose fills go to privacy RPCs: the chain's own count, or one past the last
 * fill still out there, whichever is higher (the chain's RPC can't count transactions it hasn't seen).
 */
async function nextNonce(chain, address, p) {
  const pending = Number(await p.getTransactionCount(address, 'pending'));
  const { rows: [r] } = await db.query(
    `SELECT max(f.nonce) AS n FROM meme_order_fills f JOIN meme_orders o ON o.id = f.order_id WHERE o.chain = $1 AND f.state = 'sent' AND f.nonce IS NOT NULL`, [chain]);
  return Math.max(pending, r.n === null ? 0 : Number(r.n) + 1);
}

/**
 * The route for a fill, with the router as the trader: { venue, spender, venueCalldata, unwrapIn, quotedOut, minAmountOut, route }.
 * quotedOut and minAmountOut are what reaches the user (after the fee on a sale).
 */
async function route(row, cfg, amount, minimum, curve = undefined) {
  const c = CHAINS[row.chain];
  const buy = isBuy(row);
  const toTrade = tx.toTrade(amount, cfg.check.feeBps, !buy);
  const net = netOf(cfg.check.feeBps);
  const lp = require('../services/launchpads');
  if (curve === undefined) curve = await curveOf(row.chain, row.token, cfg.check);
  // An order is traded on a curve only in what that curve is priced in (an order placed in ETH stays on 0x).
  const q = quoteOfRow(row);
  if (curve?.kind === 'virtuals' && q.virtual) {
    if (curve.unsupported) throw refuse(curve.unsupported);
    // Virtuals' BondingV5, called by the router, with FRouterV3 approved for exactly this fill's VIRTUAL or coins.
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    if (buy) {
      const out = await lp.curveBuyQuote(row.token, toTrade, curve.pad);
      return { venue: lp.ADDR.bondingV5, spender: lp.ADDR.frouterV3, unwrapIn: false, quotedOut: out, minAmountOut: 0n, route: 'Virtuals\' curve',
        venueCalldata: lp.BONDING_V5.encodeFunctionData('buy', [toTrade, row.token, minimum, deadline]) };
    }
    // Virtuals' own minimum: what leaves the user their price after the router's fee (the router checks it again).
    const minOut = (minimum * 10000n + BigInt(10000 - cfg.check.feeBps) - 1n) / BigInt(10000 - cfg.check.feeBps);
    const out = await lp.curveSellQuote(row.token, toTrade, curve.pad);
    return { venue: lp.ADDR.bondingV5, spender: lp.ADDR.frouterV3, unwrapIn: false, quotedOut: net(out), minAmountOut: 0n, route: 'Virtuals\' curve',
      venueCalldata: lp.BONDING_V5.encodeFunctionData('sell', [toTrade, row.token, minOut, deadline]) };
  }
  if (curve?.kind === 'fourmeme' && !q.virtual) {
    if (buy) {
      // The curve is bought with BNB: the router unwraps the user's WBNB for it (unwrapIn) and wraps back what's unused.
      const q = await lp.fourMemeBuyQuote(row.token, toTrade);
      return { venue: lp.FOURMEME.tokenManager, spender: lp.FOURMEME.tokenManager, unwrapIn: true, quotedOut: q.amount, minAmountOut: 0n, route: 'four.meme',
        venueCalldata: lp.TOKEN_MANAGER.encodeFunctionData('buyTokenAMAP', [row.token, toTrade, minimum]) };
    }
    // four.meme's own minimum: what leaves the user their price after the router's fee (the router checks it again).
    const minFunds = (minimum * 10000n + BigInt(10000 - cfg.check.feeBps) - 1n) / BigInt(10000 - cfg.check.feeBps);
    const q = await lp.fourMemeSellQuote(row.token, toTrade);
    return { venue: lp.FOURMEME.tokenManager, spender: lp.FOURMEME.tokenManager, unwrapIn: false, quotedOut: net(q.funds), minAmountOut: 0n, route: 'four.meme',
      venueCalldata: lp.TOKEN_MANAGER.encodeFunctionData('sellToken(uint256,address,uint256,uint256)', [0n, row.token, toTrade, minFunds]) };
  }
  // 0x: the order's own coins (its sale's output is the native coin, or VIRTUAL for a coin that left Virtuals' curve).
  const zx = await zeroex.quote({ chainId: c.chainId, sellToken: row.token_in, buyToken: buy ? row.token : row.token_out, sellAmount: toTrade, taker: row.router, slippageBps: FILL_SLIPPAGE_BPS, fundedInBatch: true });
  // Only through 0x's AllowanceHolder, the venue fixed in the router, and with no native coin sent along.
  if (String(zx.transaction?.to || '').toLowerCase() !== c.allowanceHolder.toLowerCase()) throw refuse(`0x's quote names ${zx.transaction?.to}, not its AllowanceHolder.`);
  if (BigInt(zx.transaction.value || 0) !== 0n) throw refuse('0x\'s quote sends native coin along, which a fill never does.');
  if (zx.sellAmount !== toTrade) throw refuse('0x quoted a different amount than the fill trades.');
  return { venue: c.allowanceHolder, spender: c.allowanceHolder, unwrapIn: false, venueCalldata: zx.transaction.data, route: '0x',
    quotedOut: buy ? zx.buyAmount : net(zx.buyAmount), minAmountOut: buy ? zx.minBuyAmount : net(zx.minBuyAmount) };
}

/** One fill of a triggered order. Records what happened; throws only on a bug. */
async function attempt(row, cfg, exec) {
  const buy = isBuy(row);
  const c = CHAINS[row.chain];
  const name = row.symbol || 'coins';
  const q = quoteOfRow(row);
  const TITLES = { below_floor: buy ? 'it can\'t fill at your limit' : 'it can\'t fill at your floor', nothing: buy ? `it has no ${q.spendName} to buy with` : 'it has nothing to sell', risk: 'RektBull\'s token check stopped it' };
  const later = async (error, ms, alertId = null, alertText = null) => {
    await db.query(`UPDATE meme_orders SET last_error = $2, last_attempt_at = now(), next_attempt_at = now() + make_interval(secs => $3), attempts = attempts + 1, updated_at = now() WHERE id = $1`, [row.id, error.slice(0, 500), ms / 1000]);
    if (alertId) await alert(row, 'high', alertId, TITLES[alertId], alertText);
  };
  const o = tx.fromJson(row.order_json);
  const [filled, held, allowed] = await Promise.all([
    read(row.chain, row.router, ROUTER, 'filled', [row.order_hash]).then(BigInt),
    read(row.chain, row.token_in, ERC20, 'balanceOf', [row.owner]).then(BigInt),
    read(row.chain, row.token_in, ERC20, 'allowance', [row.owner, row.router]).then(BigInt),
  ]);
  let amount = o.amountIn - filled;
  if (held < amount) amount = held;
  if (allowed < amount) amount = allowed;
  const curve = await curveOf(row.chain, row.token, cfg.check);
  if (!buy && curve?.kind === 'fourmeme' && !q.virtual) amount -= amount % curve.sellUnit;
  if (amount <= 0n) {
    const text = buy
      ? (held === 0n ? `Your wallet's ${q.spendName} is gone (${q.virtual ? 'spent or moved' : 'unwrapped or spent'}).` : `The approval for your ${q.spendName} was revoked or used up.`)
      : (held === 0n ? 'Your wallet no longer holds these coins.' : 'The approval for these coins was revoked or used up.');
    return later(`nothing to ${buy ? 'buy with' : 'sell'}: ${text}`, RETRY_MS.nothing, 'nothing', `${text} The order stays open until its end date; approve again from the Trade desk, or cancel it there.`);
  }
  const minimum = tx.minimumFor(o.minAmountOut, amount, o.amountIn);
  if (buy) {
    const risk = await require('../services/dueDiligence').quickCheck({ chain: row.chain, token: row.token }).catch(err => ({ incomplete: err.message }));
    if (risk.incomplete) return later(`the token check couldn't run (${risk.incomplete}): not buying until it can`, RETRY_MS.failed);
    if (risk.verdict === 'critical') {
      const flag = risk.flags.find(f => f.severity === 'critical');
      return later(`the token check found a critical risk: ${flag?.title}`, RETRY_MS.nothing, 'risk', `It fired, but RektBull's token check now finds a critical risk in ${name}: ${flag?.title}. Nothing was bought. Cancel the order on the Trade desk.`);
    }
  }
  let r;
  try {
    r = await route(row, cfg, amount, minimum, curve);
  } catch (err) {
    if (!err.isTradeBlocked) throw err;
    return later(`no route: ${err.message}`, RETRY_MS.failed);
  }
  // A trigger from the stream (memeStream.js) is confirmed by the fill's own quote first: a price misread from a pool's
  // event must not sell anyone's coins early. Not confirmed: back to watching, nothing sent, nobody alerted.
  if (row.trigger_reason?.stream && row.kind !== 'meme_watch_exit' && row.trigger_out) {
    const part = BigInt(row.trigger_out) * amount / BigInt(row.amount_in);
    const gross = buy ? r.quotedOut : r.quotedOut * 10000n / BigInt(10000 - cfg.check.feeBps);
    const confirmed = buy || row.kind === 'take_profit' ? gross * 100n >= part * 98n : gross * 100n <= part * 102n;
    if (!confirmed) {
      await db.query(`UPDATE meme_orders SET state = 'open', triggered_at = NULL, trigger_reason = NULL, last_error = $2, updated_at = now() WHERE id = $1 AND state = 'triggered'`,
        [row.id, `the stream's price wasn't confirmed by ${r.route}'s quote, so it's back to watching`]);
      return;
    }
  }
  const below = got => (buy
    ? `It fired, but ${nat(amount)} ${q.spendName} would buy about ${fmt(whole(got, row.decimals))} ${name}, fewer than your limit of ${fmt(whole(minimum, row.decimals))}, so the router won't let it fill. It keeps trying while it's open.`
    : `It fired, but ${fmt(whole(amount, row.decimals))} ${name} would sell for about ${nat(got)} ${q.symbol}, below your floor of ${nat(minimum)} ${q.symbol} after the fee, so the router won't let it fill. It keeps trying while it's open; you can also sell from your own wallet on the Trade desk.`);
  if (r.quotedOut < minimum) {
    return later(`below the ${buy ? 'limit' : 'floor'}: ${r.route} quotes ${buy ? `${fmt(whole(r.quotedOut, row.decimals))} coins` : `${nat(r.quotedOut)} ${q.symbol} after the fee`}, ${buy ? fmt(whole(minimum, row.decimals)) : nat(minimum)} needed`,
      RETRY_MS.below_floor, 'below_floor', below(r.quotedOut));
  }
  const call = tx.fillCall(row.router, o, row.signature, { amountIn: amount, venue: r.venue, spender: r.spender, venueCalldata: r.venueCalldata, unwrapIn: r.unwrapIn, minAmountOut: r.minAmountOut });
  const p = provider(row.chain);
  try {
    await p.call({ from: exec.address, ...call });
  } catch (err) {
    const e = tx.routerError(err?.data || err?.info?.error?.data || err?.error?.data || err?.message);
    if (e?.name === 'BelowLimit') return later(`below the ${buy ? 'limit' : 'floor'} (${r.route}: the router's BelowLimit)`, RETRY_MS.below_floor, 'below_floor', below(BigInt(e.args[0])));
    return later(`in a simulation the fill fails: ${e ? e.name : (err.shortMessage || err.message)}`.slice(0, 400), RETRY_MS.failed);
  }
  const signer = exec.signer;
  // BNB Chain: privately, to builders (privateSend.js), so nobody watching the public mempool can trade around it.
  const relays = privateSend.relays(row.chain);
  const nonce = relays.length ? await nextNonce(row.chain, exec.address, p) : undefined;
  const t = await signer.populateTransaction({ ...call, value: 0n, ...(nonce === undefined ? {} : { nonce }) });
  t.gasLimit = (BigInt(t.gasLimit) * 13n) / 10n;
  const fee = await p.getFeeData();
  const gasCost = t.gasLimit * (t.maxFeePerGas ?? t.gasPrice ?? fee.maxFeePerGas ?? fee.gasPrice ?? 0n);
  if ((await p.getBalance(exec.address)) < gasCost) {
    logger.error('meme orders: the executor is out of gas money', { chain: row.chain, executor: exec.address });
    return later(`RektBull's executor hasn't enough ${c.native} for the network fee: RektBull has been told`, RETRY_MS.failed);
  }
  const unsigned = ethers.Transaction.from({ ...t, from: undefined });
  await require('./signers').logSignature(exec.address, unsigned.unsignedHash, `meme_fill:${row.id}`);
  const raw = await signer.signTransaction(t);
  const hash = ethers.keccak256(raw);
  // Recorded before it's broadcast, so a crash between the two is checked against the chain, never resent blindly
  // (one meant for the privacy RPCs is sent the usual way once its grace period is over, the same transaction).
  await db.query(`INSERT INTO meme_order_fills (order_id, tx_hash, amount_in, quoted_out, route, nonce, raw_tx, sent_via) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [row.id, hash, amount.toString(), r.quotedOut.toString(), r.route, Number(t.nonce), raw, relays.length ? 'private' : 'public']);
  await db.query(`UPDATE meme_orders SET last_attempt_at = now(), attempts = attempts + 1, next_attempt_at = now() + interval '30 seconds', updated_at = now() WHERE id = $1`, [row.id]);
  if (relays.length) {
    const sent = await privateSend.sendEvm(row.chain, raw);
    if (sent.accepted.length) {
      await db.query(`UPDATE meme_order_fills SET relays = $2 WHERE tx_hash = $1`, [hash, sent.accepted]);
      return;
    }
    // Every privacy RPC refused it: the usual way at once, since an exit must never wait on a relay.
    await db.query(`UPDATE meme_order_fills SET public_at = now() WHERE tx_hash = $1`, [hash]);
  }
  try {
    await p.broadcastTransaction(raw);
  } catch (err) {
    await db.query(`UPDATE meme_order_fills SET state = 'failed', error = $2 WHERE tx_hash = $1`, [hash, `not sent: ${err.shortMessage || err.message}`.slice(0, 500)]);
  }
}

/* ── The executor ── */

let testExecutor = null;
/** RektBull's executor on a chain: { address, signer }, its key in KMS, and the address users' orders name. */
async function executor(chain) {
  if (testExecutor) return testExecutor(chain, provider(chain));
  if (!env.kmsMemeExecutorKeyVersion) throw new Error('no executor key configured (KMS_MEME_EXECUTOR_KEY_VERSION)');
  const { KmsSigner } = require('./kmsSigner');
  const signer = new KmsSigner({ keyVersion: env.kmsMemeExecutorKeyVersion }, provider(chain));
  const address = (await signer.getAddress()).toLowerCase();
  if (address !== env.memeOrdersExecutor) throw new Error(`the executor key is ${address}, but MEME_ORDERS_EXECUTOR says ${env.memeOrdersExecutor}: users' orders name the latter`);
  return { address, signer };
}

/**
 * The trade service's pass (SERVICE_ROLE=trade), every TRADE_TICK_MS: orders
 * read back from the routers, sent fills confirmed, triggers checked, and the
 * fired orders filled (unless the emergency stop for automatic trading is on),
 * one sender at a time so the executor's nonces never collide.
 */
async function tick() {
  const cfg = config();
  if (cfg.off || !env.databaseUrl) return { skipped: cfg.off || 'no database' };
  const client = await db.getPool().connect();
  try {
    const { rows: [lock] } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
    if (!lock.ok) return { skipped: 'another instance is sending' };
    try {
      await reconcile();
      await confirmFills();
      await triggers().catch(err => logger.warn('meme orders: prices not read', { error: err.message }));
      if (await require('../admin/stops').isStopped('auto_trading')) return { stopped: true };
      return await fillTriggered(cfg);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

/** The fired orders due a fill, one at a time (the caller holds the sender's lock). */
async function fillTriggered(cfg) {
  const { rows } = await db.query(
    `SELECT o.* FROM meme_orders o WHERE o.state = 'triggered' AND o.valid_until > now() AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= now())
       AND NOT EXISTS (SELECT 1 FROM meme_order_fills f WHERE f.order_id = o.id AND f.state = 'sent')
     ORDER BY o.triggered_at LIMIT $1`, [FILLS_PER_TICK]);
  let attempted = 0;
  const execs = new Map();
  for (const row of rows) {
    try {
      const ready = await routerCheck(row.chain, row.router);
      if (!ready.ok || cfg.routers[row.chain] !== row.router) continue;
      if (!execs.has(row.chain)) execs.set(row.chain, await executor(row.chain));
      const exec = execs.get(row.chain);
      if (exec.address !== row.executor) throw new Error('the executor key isn\'t the one this order names');
      attempted++;
      await attempt(row, { ...cfg, router: row.router, check: ready }, exec);
    } catch (err) {
      logger.error('meme orders: a fill attempt failed', { order: row.id, error: err.message });
      await db.query(`UPDATE meme_orders SET last_error = $2, next_attempt_at = now() + interval '60 seconds', updated_at = now() WHERE id = $1`, [row.id, `RektBull's order service: ${err.message}`.slice(0, 500)]);
    }
  }
  return { attempted };
}

/**
 * Fills fired orders now, between passes (the stream fired them: memeStream.js). Takes the sender's lock, waiting
 * up to about 2 seconds for a pass that holds it; if the pass keeps it longer, that pass fills them.
 */
async function fillNow() {
  const cfg = config();
  if (cfg.off || !env.databaseUrl) return { skipped: cfg.off || 'no database' };
  const client = await db.getPool().connect();
  try {
    let got = false;
    for (let i = 0; i < 8 && !got; i++) {
      ({ rows: [{ ok: got }] } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]));
      if (!got) await new Promise(r => setTimeout(r, 250));
    }
    if (!got) return { skipped: 'a pass is sending: it fills them' };
    try {
      if (await require('../admin/stops').isStopped('auto_trading')) return { stopped: true };
      return await fillTriggered(cfg);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

module.exports = {
  KINDS, CHAINS, MIN_ORDER_USD,
  config, ready, routerCheck, prepare, sign, cancel, cancelAll, refresh, list, memeWatchSignal, copySellSignal, tick, fundingCalls, exitsForBuy, recordExits,
  checkPrice, fire, fillNow, lastSeen: chain => lastSeen[chain] || null, read, curveOf, quoteOfRow, quoteAsset, sellQuote, buyQuote, nativeUsd, isBuy,
  _attempt: attempt, _reconcile: reconcile, _triggers: triggers, _confirmFills: confirmFills, _route: route,
  _setProvider: fn => { providerFor = fn || rpcProvider; providers.clear(); },
  _setExecutor: fn => { testExecutor = fn; },
};
