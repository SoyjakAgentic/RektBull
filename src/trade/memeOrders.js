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
    allowanceHolder: TRADE_CHAINS.base.allowanceHolder, explorerTx: TRADE_CHAINS.base.explorerTx,
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
const nat = wei => fmt(whole(wei, 18));
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
 * most 1%, the chain's wrapped native coin, 0x's AllowanceHolder as a venue,
 * and on BNB Chain whether four.meme's TokenManager2 is one too. The router
 * has no owner and can't be changed, so this only catches a wrong address.
 */
async function routerCheck(chain, router) {
  return cached(`meme:router:${chain}:${router}`, 600, async () => {
    const c = CHAINS[chain];
    const code = await provider(chain).getCode(router);
    if (!code || code === '0x') return { ok: false, why: `RektBull's Meme Router isn't deployed at ${router} on ${c.label}.` };
    const [feeBps, feeWallet, wrapped, zeroexVenue, fourMeme] = await Promise.all([
      read(chain, router, ROUTER, 'FEE_BPS'), read(chain, router, ROUTER, 'FEE_WALLET'), read(chain, router, ROUTER, 'WRAPPED_NATIVE'),
      read(chain, router, ROUTER, 'isVenue', [c.allowanceHolder]),
      c.fourMeme ? read(chain, router, ROUTER, 'isVenue', [require('../services/launchpads').FOURMEME.tokenManager]) : false,
    ]);
    if (Number(feeBps) > 100) return { ok: false, why: `The Meme Router on ${c.label} charges ${Number(feeBps) / 100}%, more than RektBull's 1%: not used.` };
    if (String(wrapped).toLowerCase() !== c.wrapped.toLowerCase()) return { ok: false, why: `The Meme Router on ${c.label} names another wrapped ${c.native}: not used.` };
    if (!zeroexVenue) return { ok: false, why: `The Meme Router on ${c.label} doesn't allow 0x's AllowanceHolder: not used.` };
    return { ok: true, feeBps: Number(feeBps), feeWallet: String(feeWallet).toLowerCase(), fourMeme: !!fourMeme };
  });
}

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

/** Is the coin on a four.meme curve priced in BNB, traded by the TokenManager2 the router allows? */
async function onFourMemeCurve(chain, token, check) {
  if (chain !== 'bsc' || !check.fourMeme) return false;
  const lp = require('../services/launchpads');
  const pad = await lp.identify('bsc', token).catch(() => null);
  return pad?.launchpad === 'fourmeme' && pad.state === 'curve' && pad.quote === 'bnb' && pad.token_manager === lp.FOURMEME.tokenManager;
}

const noRoute = err => { if (err.isTradeBlocked) throw refuse(err.message, 503); throw err; };

/** What `amount` of the coin sells for now, in the native coin: { out, route, taxBps }. four.meme's is after its fee. */
async function sellQuote(chain, token, amount, curve) {
  if (curve) {
    const q = await require('../services/launchpads').fourMemeSellQuote(token, amount);
    return { out: q.funds, route: 'four.meme', taxBps: 0 };
  }
  const q = await zeroex.quote({ chainId: CHAINS[chain].chainId, sellToken: token, buyToken: NATIVE, sellAmount: amount, indicative: true }).catch(noRoute);
  return { out: q.buyAmount, route: '0x', taxBps: q.taxBps };
}

/** What `spend` of the wrapped native coin buys now: { out, route, taxBps }. */
async function buyQuote(chain, token, spend, curve) {
  if (curve) {
    const q = await require('../services/launchpads').fourMemeBuyQuote(token, spend);
    return { out: q.amount, route: 'four.meme', taxBps: 0 };
  }
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
const SELL_UNIT = () => require('../services/launchpads').FOURMEME_SELL_UNIT;

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
function worstCase({ kind, amountWhole, symbol, minOut, validUntil, c }) {
  const date = new Date(validUntil).toISOString().slice(0, 10);
  const what = `your ${fmt(amountWhole)} ${symbol}`;
  return [
    kind === 'take_profit'
      ? `Worst case, even if RektBull were hacked: ${what} are sold for ${nat(minOut)} ${c.native} after the 1% fee (your target less your slippage), at a moment RektBull picks before ${date}. That is more than they would sell for now.`
      : `Worst case, even if RektBull were hacked: ${what} are sold for ${nat(minOut)} ${c.native} after the 1% fee (your floor), at a moment RektBull picks before ${date}, even if the market is higher then.`,
    `Nothing else of yours can be touched: your wallet approves the Meme Router for these coins only, and the router sends what they sell for only to your wallet, in the same transaction. RektBull never holds them.`,
    'If the price falls straight past your floor, the order can\'t fill below it: you keep the coins, and RektBull tells you.',
    'To stop it: cancel it here (your wallet sends the cancel to the router), or revoke the approval in your wallet. Either works at once, even while RektBull is paused.',
  ];
}

/** A limit buy's worst case, in plain words. */
function worstCaseBuy({ spend, minCoins, symbol, validUntil, c }) {
  const date = new Date(validUntil).toISOString().slice(0, 10);
  return [
    `Worst case, even if RektBull were hacked: your ${spend} ${c.wrappedName} buys ${fmt(minCoins)} ${symbol} (your limit less your slippage), the 1% fee included, at a moment RektBull picks before ${date}, even if the price is lower then.`,
    `Nothing else of yours can be touched: your wallet approves the Meme Router for this ${c.wrappedName} only, and the router sends the coins only to your wallet, in the same transaction. RektBull never holds them.`,
    `If the price never comes down to your limit, nothing is bought, and your ${c.wrappedName} stays in your wallet (you can unwrap it into ${c.native} any time).`,
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
async function prepare(account, body = {}) {
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
  const curve = await onFourMemeCurve(chain, token, cfg.check);
  const usd = await nativeUsd(chain);
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
    checks.push({ check: 'per_trade_amount', ok: true, detail: `$${spendUsd} of your $${settings.max_trade_usd} per trade`, source: `your trading settings; ${c.native}'s price from DefiLlama` });
    await buyChecks(chain, token, body, checks);
    const toTrade = tx.toTrade(amountIn, cfg.check.feeBps, false);
    const q = await buyQuote(chain, token, toTrade, curve);
    if (!q.out) throw refuse(`There is no route to buy this coin with ${c.wrappedName} just now (${q.route}).`);
    if (q.taxBps) throw refuse(`This coin taxes transfers (${q.taxBps / 100}%, 0x), so an order can't be filled exactly. Trade it from your own wallet on the Trade desk.`);
    const back = await sellQuote(chain, token, curve ? q.out - q.out % SELL_UNIT() : q.out, curve);
    if (!back.out) throw refuse('There is no route to sell this coin back: it may be a honeypot. Not placing a buy.');
    const lossPct = Number((amountIn - back.out) * 10000n / amountIn) / 100;
    if (lossPct > settings.max_round_trip_loss_pct) throw refuse(`Selling straight back would lose ${lossPct.toFixed(1)}%, above your ${settings.max_round_trip_loss_pct}% limit: the token may tax transfers, or its pool is thin.`);
    checks.push({ check: 'sell_back', ok: true, detail: `selling straight back loses ${lossPct.toFixed(1)}% (fees included; limit ${settings.max_round_trip_loss_pct}%)`, source: q.route === 'four.meme' ? 'four.meme\'s helper contract' : '0x price' });
    refOut = q.out;
    const trigger = refOut * 10000n / BigInt(Math.round((100 - dip) * 100));
    const minOut = trigger * BigInt(Math.round((100 - slip) * 100)) / 10000n;
    if (minOut <= 0n) throw refuse('That limit rounds to no coins; spend more.', 400);
    t = { triggerOut: trigger, minOut, said: { spend, dip_pct: dip, slippage_pct: slip } };
    order = { tokenIn: c.wrapped, tokenOut: token, amountIn };
    extra = { spendUsd, worst: worstCaseBuy({ spend, minCoins: whole(minOut, decimals), symbol, validUntil, c }) };
  } else {
    const share = num(body.share_pct, 1, 100, 100, 'share_pct');
    const held = BigInt(await read(chain, token, ERC20, 'balanceOf', [owner]));
    if (held === 0n) throw refuse('Your wallet holds none of this coin.');
    let amountIn = held * BigInt(Math.round(share * 100)) / 10000n;
    if (curve) amountIn -= amountIn % SELL_UNIT(); // four.meme sells whole multiples of 10^9 units only
    if (amountIn === 0n) throw refuse('That share of your holding rounds to nothing.');
    const q = await sellQuote(chain, token, amountIn, curve);
    if (!q.out) throw refuse(`There is no route to sell this coin for ${c.native} just now (${q.route}), so an order couldn't be filled.`);
    if (q.taxBps) throw refuse(`This coin taxes transfers (${q.taxBps / 100}%, 0x), so an order can't be filled exactly. Sell it from your own wallet on the Trade desk.`);
    refOut = q.out;
    const valueUsd = Math.round(whole(refOut, 18) * usd * 100) / 100;
    if (valueUsd < MIN_ORDER_USD) throw refuse(`An order needs at least $${MIN_ORDER_USD} (these sell for $${valueUsd} now): RektBull pays each fill's network fee out of its 1%.`);
    t = require('./solanaOrders').terms(kind, refOut, body, settings, net);
    if (t.minOut <= 0n) throw refuse('That floor rounds to nothing; choose a higher one.', 400);
    checks.push({ check: 'holding', ok: true, detail: `${fmt(whole(amountIn, decimals))} of the ${fmt(whole(held, decimals))} ${symbol} in your wallet`, source: `${c.label} RPC (balanceOf)` });
    checks.push({ check: 'route', ok: true, detail: `they would sell for ${nat(refOut)} ${c.native} now ($${valueUsd})`, source: q.route === 'four.meme' ? 'four.meme\'s helper contract (the coin is on its curve)' : '0x price' });
    order = { tokenIn: token, tokenOut: NATIVE, amountIn };
    extra = { worst: worstCase({ kind, amountWhole: whole(amountIn, decimals), symbol, minOut: t.minOut, validUntil, c }) };
  }

  const epoch = await read(chain, cfg.router, ROUTER, 'epochOf', [owner]);
  const o = tx.order({ account: owner, executor: cfg.executor, ...order, minAmountOut: t.minOut, validUntil: Math.floor(validUntil / 1000), epoch, salt: BigInt('0x' + crypto.randomBytes(32).toString('hex')) });
  const hash = tx.hash(c.chainId, cfg.router, o);
  // The router's own hash of the same order: a layout that drifted from the contract's is caught before anyone signs.
  if (String(await read(chain, cfg.router, ROUTER, 'hashOrder', [o])).toLowerCase() !== hash.toLowerCase()) throw refuse('The router hashes this order differently, so RektBull won\'t ask you to sign it.', 503);
  checks.push({ check: 'order', ok: true, detail: 'the router hashes this order exactly as your wallet will sign it', source: `the Meme Router on ${c.label} (hashOrder)` });

  const { rows: [row] } = await db.query(
    `INSERT INTO meme_orders (account_id, chain, chain_id, router, owner, kind, token, symbol, decimals, token_in, token_out, amount_in, min_out, trigger_out, ref_out, executor, valid_until, order_json, order_hash, spend_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING *`,
    [account.id, chain, c.chainId, cfg.router, owner, kind, token, symbol, decimals, o.tokenIn.toLowerCase(), o.tokenOut.toLowerCase(), o.amountIn.toString(), t.minOut.toString(),
      t.triggerOut?.toString() ?? null, refOut.toString(), cfg.executor, new Date(validUntil), JSON.stringify(tx.toJson(o)), hash.toLowerCase(), extra.spendUsd ?? null]);
  const buy = kind === 'limit_buy';
  return {
    order: view(row),
    terms: t.said,
    worst_case: extra.worst,
    notes: [
      buy ? `After you sign, your wallet wraps the ${c.native} it needs into ${c.wrappedName} (if it hasn't enough) and approves the Meme Router for exactly what your buys on ${c.label} spend.`
        : `After you sign, your wallet approves the Meme Router for exactly what your orders on this coin sell (unless it already has).`,
      ...(curve ? [`This coin is still on its four.meme curve: fills trade on the curve itself until it graduates, then through 0x.`] : []),
    ],
    costs: {
      deposit: 'None: the order is only a signature. Your wallet pays the network fee for the approval (and the wrapping) once.',
      fee: `RektBull's ${cfg.check.feeBps / 100}% of the ${c.native} a fill ${buy ? 'spends' : 'brings'}, taken by the router. Nothing if it never fills. RektBull pays each fill's network fee.`,
      fee_wallet: cfg.check.feeWallet,
    },
    checks,
    chain_id: ethers.toBeHex(c.chainId),
    typed_data: tx.typedData(c.chainId, cfg.router, o),
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
  const signature = String(body.signature || '');
  if (!/^0x[0-9a-fA-F]{130,}$/.test(signature)) throw refuse('signature must be the wallet\'s EIP-712 signature (0x…).', 400);
  const o = tx.fromJson(row.order_json);
  if (!(await signedBy(row.chain, row.router, row.owner, o, row.order_hash, signature))) {
    throw refuse('That signature isn\'t your wallet\'s for this order. Nothing was placed.', 409);
  }
  if (BigInt(await read(row.chain, row.router, ROUTER, 'epochOf', [row.owner])) !== o.epoch) {
    throw refuse('You cancelled all your orders on this router since this one was prepared. Prepare it again.', 409);
  }
  const { rows: [done] } = await db.query(`UPDATE meme_orders SET state = 'open', signature = $2, updated_at = now() WHERE id = $1 AND state = 'prepared' RETURNING *`, [row.id, signature]);
  return { order: view(done || row), calls: await fundingCalls(done || row) };
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
  if (isBuy(row) && balance < need) {
    const wrap = need - balance;
    const have = await provider(row.chain).getBalance(row.owner);
    if (have < wrap) throw refuse(`Your wallet holds ${nat(have)} ${c.native}, and your buys need ${nat(wrap)} more ${c.wrappedName}. Add ${c.native} and try again; the order stays open.`);
    calls.push({ ...tx.wrapCall(c.wrapped, wrap), label: `Wrap ${nat(wrap)} ${c.native} into ${c.wrappedName}` });
  }
  if (allowance < need) {
    calls.push({ ...tx.approveCall(row.token_in, row.router, need), label: `Approve the Meme Router for ${isBuy(row) ? `${nat(need)} ${c.wrappedName}` : `${fmt(whole(need, row.decimals))} ${row.symbol || 'coins'}`}` });
  }
  return { chain_id: ethers.toBeHex(c.chainId), calls };
}

/** The calls for the user's wallet to cancel: the order on the router, and the approval revoked when it was the last on that input. */
async function cancel(account, id) {
  const row = await own(account, id);
  if (['filled', 'cancelled'].includes(row.state)) return { order: view(row), done: true };
  if (row.state === 'prepared') {
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
  if (!['open', 'triggered', 'expired'].includes(row.state)) return view(row);
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
  const { rows } = await db.query(`SELECT * FROM meme_orders WHERE account_id = $1 AND state <> 'prepared' ORDER BY created_at DESC LIMIT 100`, [account.id]);
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
  const fee = f.fee ? (f.fee_on_output ? `${nat(f.fee)} ${c.native}` : isBuy(r) ? `${nat(f.fee)} ${c.wrappedName}` : `${fmt(whole(f.fee, r.decimals))} ${r.symbol || 'coins'}`) : null;
  return {
    tx_hash: f.tx_hash, state: f.state, route: f.route, fee, error: f.error, at: f.created_at, tx_url: c.explorerTx(f.tx_hash),
    ...(isBuy(r) ? { spent_native: nat(f.amount_in), coins: f.delivered ? whole(f.delivered, r.decimals) : null } : { sold_whole: whole(f.amount_in, r.decimals), delivered_native: f.delivered ? nat(f.delivered) : null }),
  };
}

function view(r) {
  const c = CHAINS[r.chain];
  const common = {
    id: Number(r.id), chain: r.chain, chain_label: c.label, native: c.native, kind: r.kind, kind_name: KINDS[r.kind], side: isBuy(r) ? 'buy' : 'sell', state: r.state,
    token: r.token, symbol: r.symbol, valid_until: r.valid_until, triggered_at: r.triggered_at, trigger_reason: r.trigger_reason,
    last_error: r.last_error, order_hash: r.order_hash, router: r.router, created_at: r.created_at,
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
  await db.query(`DELETE FROM meme_orders WHERE state = 'prepared' AND created_at < now() - make_interval(secs => $1)`, [PREPARED_TTL_MS / 1000]);
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
async function triggers() {
  const { rows } = await db.query(`SELECT * FROM meme_orders WHERE state = 'open' AND kind IN ('stop_loss', 'take_profit', 'limit_buy') AND valid_until > now()`);
  for (const chain of [...new Set(rows.map(r => r.chain))]) {
    const mine = rows.filter(r => r.chain === chain);
    const tokens = [...new Set(mine.map(r => r.token))];
    const [pairs, usd] = await Promise.all([
      cached(`meme:orders:prices:${chain}:${crypto.createHash('sha1').update(tokens.join(',')).digest('hex')}`, 10, () => require('../providers/dexscreener').pairs(chain, tokens)),
      nativeUsd(chain),
    ]);
    for (const row of mine) {
      const p = pairs[row.token]?.price_usd;
      if (!(p > 0) || !(usd > 0)) continue;
      const left = BigInt(row.amount_in) - BigInt(row.filled_in);
      if (left <= 0n) continue;
      const trigger = BigInt(row.trigger_out) * left / BigInt(row.amount_in);
      const source = `DexScreener (the coin's most liquid pair) and DefiLlama (${CHAINS[chain].native})`;
      let reason = null;
      if (isBuy(row)) {
        // What the wrapped coin left would buy now (less the fee), against the coins at the user's limit.
        const coins = BigInt(Math.floor(whole(tx.toTrade(left, 100, false), 18) * usd / p * 10 ** row.decimals));
        if (coins >= trigger) reason = { price_usd: p, native_usd: usd, coins_now: whole(coins, row.decimals), coins_at_limit: whole(trigger, row.decimals), source };
      } else {
        const value = BigInt(Math.floor(whole(left, row.decimals) * p / usd * 1e18));
        if (row.kind === 'stop_loss' ? value <= trigger : value >= trigger) reason = { price_usd: p, native_usd: usd, value_native: nat(value), trigger_native: nat(trigger), source };
      }
      if (reason) await db.query(`UPDATE meme_orders SET state = 'triggered', triggered_at = now(), trigger_reason = $2, next_attempt_at = now(), updated_at = now() WHERE id = $1 AND state = 'open'`, [row.id, JSON.stringify(reason)]);
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
      if (Date.now() - new Date(f.created_at).getTime() > NOT_SEEN_MS) await failed('it wasn\'t seen onchain within 30 minutes');
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
    if (isBuy(o)) {
      await alert(o, 'high', `fill:${f.tx_hash}`, o.state === 'filled' ? 'bought' : 'bought in part',
        `Bought ${fmt(whole(ev.amountOut, o.decimals))} ${o.symbol || 'coins'}, sent to your wallet, for ${nat(ev.amountIn)} of your ${c.wrappedName} (RektBull's fee: ${nat(ev.fee)} ${c.wrappedName}, included). What wasn't used went back to your wallet.`, source);
    } else {
      await alert(o, 'high', `fill:${f.tx_hash}`, o.state === 'filled' ? 'sold' : 'sold in part',
        `Sold ${fmt(whole(ev.amountIn, o.decimals))} ${o.symbol || 'coins'} for ${nat(ev.amountOut)} ${c.native}, sent to your wallet (RektBull's fee: ${nat(ev.fee)} ${c.native}).`, source);
    }
  }
}

/**
 * The route for a fill, with the router as the trader: { venue, spender, venueCalldata, unwrapIn, quotedOut, minAmountOut, route }.
 * quotedOut and minAmountOut are what reaches the user (after the fee on a sale).
 */
async function route(row, cfg, amount, minimum) {
  const c = CHAINS[row.chain];
  const buy = isBuy(row);
  const toTrade = tx.toTrade(amount, cfg.check.feeBps, !buy);
  const net = netOf(cfg.check.feeBps);
  if (await onFourMemeCurve(row.chain, row.token, cfg.check)) {
    const lp = require('../services/launchpads');
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
  const q = await zeroex.quote({ chainId: c.chainId, sellToken: row.token_in, buyToken: buy ? row.token : NATIVE, sellAmount: toTrade, taker: row.router, slippageBps: FILL_SLIPPAGE_BPS, fundedInBatch: true });
  // Only through 0x's AllowanceHolder, the venue fixed in the router, and with no native coin sent along.
  if (String(q.transaction?.to || '').toLowerCase() !== c.allowanceHolder.toLowerCase()) throw refuse(`0x's quote names ${q.transaction?.to}, not its AllowanceHolder.`);
  if (BigInt(q.transaction.value || 0) !== 0n) throw refuse('0x\'s quote sends native coin along, which a fill never does.');
  if (q.sellAmount !== toTrade) throw refuse('0x quoted a different amount than the fill trades.');
  return { venue: c.allowanceHolder, spender: c.allowanceHolder, unwrapIn: false, venueCalldata: q.transaction.data, route: '0x',
    quotedOut: buy ? q.buyAmount : net(q.buyAmount), minAmountOut: buy ? q.minBuyAmount : net(q.minBuyAmount) };
}

/** One fill of a triggered order. Records what happened; throws only on a bug. */
async function attempt(row, cfg, exec) {
  const buy = isBuy(row);
  const c = CHAINS[row.chain];
  const name = row.symbol || 'coins';
  const TITLES = { below_floor: buy ? 'it can\'t fill at your limit' : 'it can\'t fill at your floor', nothing: buy ? `it has no ${c.wrappedName} to buy with` : 'it has nothing to sell', risk: 'RektBull\'s token check stopped it' };
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
  if (!buy && await onFourMemeCurve(row.chain, row.token, cfg.check)) amount -= amount % SELL_UNIT();
  if (amount <= 0n) {
    const text = buy
      ? (held === 0n ? `Your wallet's ${c.wrappedName} is gone (unwrapped or spent).` : `The approval for your ${c.wrappedName} was revoked or used up.`)
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
    r = await route(row, cfg, amount, minimum);
  } catch (err) {
    if (!err.isTradeBlocked) throw err;
    return later(`no route: ${err.message}`, RETRY_MS.failed);
  }
  const below = got => (buy
    ? `It fired, but ${nat(amount)} ${c.wrappedName} would buy about ${fmt(whole(got, row.decimals))} ${name}, fewer than your limit of ${fmt(whole(minimum, row.decimals))}, so the router won't let it fill. It keeps trying while it's open.`
    : `It fired, but ${fmt(whole(amount, row.decimals))} ${name} would sell for about ${nat(got)} ${c.native}, below your floor of ${nat(minimum)} ${c.native} after the fee, so the router won't let it fill. It keeps trying while it's open; you can also sell from your own wallet on the Trade desk.`);
  if (r.quotedOut < minimum) {
    return later(`below the ${buy ? 'limit' : 'floor'}: ${r.route} quotes ${buy ? `${fmt(whole(r.quotedOut, row.decimals))} coins` : `${nat(r.quotedOut)} ${c.native} after the fee`}, ${buy ? fmt(whole(minimum, row.decimals)) : nat(minimum)} needed`,
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
  const t = await signer.populateTransaction({ ...call, value: 0n });
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
  // Recorded before it's broadcast, so a crash between the two is checked against the chain, never resent blindly.
  await db.query(`INSERT INTO meme_order_fills (order_id, tx_hash, amount_in, quoted_out, route) VALUES ($1, $2, $3, $4, $5)`, [row.id, hash, amount.toString(), r.quotedOut.toString(), r.route]);
  await db.query(`UPDATE meme_orders SET last_attempt_at = now(), attempts = attempts + 1, next_attempt_at = now() + interval '30 seconds', updated_at = now() WHERE id = $1`, [row.id]);
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
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

module.exports = {
  KINDS, CHAINS, MIN_ORDER_USD,
  config, ready, routerCheck, prepare, sign, cancel, cancelAll, refresh, list, memeWatchSignal, tick, fundingCalls,
  _attempt: attempt, _reconcile: reconcile, _triggers: triggers, _confirmFills: confirmFills, _route: route,
  _setProvider: fn => { providerFor = fn || rpcProvider; providers.clear(); },
  _setExecutor: fn => { testExecutor = fn; },
};
