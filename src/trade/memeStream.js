/**
 * Triggers over WebSocket for orders on BNB Chain and Base (docs/MEME_ROUTER.md,
 * "Triggers over WebSocket"). The trade pass reads DexScreener's price (kept 10
 * seconds) every 15 seconds, so an order can fire up to about 25 seconds late.
 * Here the chain pushes the events that move a coin's price, and an order fires
 * and is filled within about a block (0.2 s on Base, 0.45 s on BNB Chain) plus
 * the fill's own quote and signature.
 *
 * Every pushed log is a request on the provider's plan (Chainstack: 1 each), and
 * a busy meme pool trades thousands of times a day, so the stream is narrow:
 *
 * - Prices: only for orders near their trigger. An open stop-loss, take-profit
 *   or limit buy within `arm_pct` (15%) of its trigger, by the trade pass's
 *   last DexScreener price, has its coin's most liquid pool subscribed: at most
 *   `max_pools` (10) per chain, the closest first. The price is read from the
 *   pool's own event, no further call: Sync (Uniswap v2 and PancakeSwap v2,
 *   and Aerodrome's form), Swap (Uniswap v3 and Aerodrome's concentrated pools,
 *   and PancakeSwap v3's form), and Swap on Uniswap v4's PoolManager filtered
 *   by the pool's id. Which side of the pool the coin is on is settled the first
 *   time, against DexScreener's price; a pool whose events don't agree with it
 *   within 30% isn't used (it stays on polling).
 * - A coin still on a launchpad's curve (four.meme on BNB Chain, Virtuals'
 *   BondingV5 on Base): its own Transfer events (the launchpads' events don't
 *   index the coin), and on one, the curve's quote for each order on it, at
 *   most once a second.
 * - Meme Watch: for coins with an open Meme Watch exit, Transfers out of their
 *   launch-bundle wallets (Meme Watch's groups). Each is recorded once
 *   (meme_insider_sells); when a group's sales since the stream started watching
 *   reach 20% of what it bought (the 6-hour check's step), its exits fire.
 * - A budget: `daily_budget` pushed logs a day across both chains (150,000,
 *   about 4.5 million a month). At it, the price and curve subscriptions stop
 *   until the next UTC day; the insiders' stay (they're rare).
 *
 * A fired order is filled at once (memeOrders.fillNow), and a price from the
 * stream is confirmed by the fill's own quote before anything is sent, so a
 * misread price can't sell anyone's coins early. Nothing depends on the stream:
 * the trade pass keeps polling, and catches what happened while it was down.
 * Off until the URLs are set (MEME_STREAM_WS_BASE, MEME_STREAM_WS_BSC) and
 * it's switched on in the admin panel. One trade service instance streams
 * (a Postgres advisory lock); any other waits on standby.
 */
const { ethers } = require('ethers');
const env = require('../config/env');
const db = require('../config/db');
const logger = require('../config/logger');
const cache = require('../lib/cache');
const settings = require('../admin/settings');
const evmStream = require('../providers/evmStream');
const orders = require('./memeOrders');
const tx = require('./memeOrderTx');
const { TRADE_CHAINS } = require('./chains');

const SETTINGS_KEY = 'meme_stream';
const DEFAULTS = { on: false, daily_budget: 150000, max_pools: 10, arm_pct: 15 };
const LIMITS = { daily_budget: [1000, 20000000], max_pools: [0, 100], arm_pct: [1, 50] };
const get = () => ({ ...DEFAULTS, ...(settings.get(SETTINGS_KEY) || {}) });
function check(input) {
  const out = {};
  if (input.on !== undefined) out.on = !!input.on;
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    if (input[k] === undefined) continue;
    const v = Number(input[k]);
    if (!(Number.isInteger(v) && v >= lo && v <= hi)) throw Object.assign(new Error(`${k} must be a whole number from ${lo} to ${hi}.`), { status: 400 });
    out[k] = v;
  }
  return out;
}

const PLAN_MS = 15_000;
const LOCK_ID = 727004;
const STATE_KEY = 'meme:stream:state';
const CALIBRATE_PCT = 30; // a pool's price must agree with DexScreener's within this to be used
const INSIDER_STEP_PCT = 20; // the 6-hour check's step
const CURVE_DEBOUNCE_MS = 1000;
const MAX_TOPIC_WALLETS = 100; // insider wallets in one filter

const T = {
  syncV2: ethers.id('Sync(uint112,uint112)'),
  syncSolidly: ethers.id('Sync(uint256,uint256)'), // Aerodrome's (and Velodrome-style) pools
  swapV3: ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)'),
  swapPcsV3: ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)'),
  swapV4: ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'),
  transfer: ethers.id('Transfer(address,address,uint256)'),
};
// Uniswap v4's PoolManager (the same code at both, checked onchain 25 November 2026).
const V4_POOL_MANAGER = { base: '0x498581ff718922c3f8e6a244956af099b2652b2b', bsc: '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df' };
const ZERO = '0x0000000000000000000000000000000000000000';

const urls = () => Object.fromEntries(Object.entries({ base: env.memeStreamWsBase, bsc: env.memeStreamWsBsc }).filter(([, u]) => /^wss?:\/\//.test(u || '')));
const configured = () => Object.keys(urls()).length > 0;

/* ── Reading a price from a pool's event ── */

const word = (data, i) => BigInt('0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64));
/** The pool's price as token1's raw units per token0's raw unit, from its event; null for an event that isn't one. */
function ratioOf(log) {
  const t0 = log.topics?.[0];
  if (t0 === T.syncV2 || t0 === T.syncSolidly) {
    const [r0, r1] = [word(log.data, 0), word(log.data, 1)];
    return r0 > 0n && r1 > 0n ? Number(r1) / Number(r0) : null;
  }
  if (t0 === T.swapV3 || t0 === T.swapPcsV3 || t0 === T.swapV4) {
    const sqrt = Number(word(log.data, 2)) / 2 ** 96;
    return sqrt > 0 ? sqrt * sqrt : null;
  }
  return null;
}
/** The coin's price in its pair's quote coin: orient 0 when the coin is token0, 1 when it's token1. */
const priceIn = (ratio, orient, decimals, quoteDecimals) => (orient === 0 ? ratio : 1 / ratio) * 10 ** (decimals - quoteDecimals);

/* ── State ── */

const st = { conns: {}, watches: {}, budgetHit: {}, lock: null, leading: false, timer: null, pending: new Set(), bad: new Set(), lastCurve: new Map(), status: {} };

function track(p) {
  st.pending.add(p);
  p.finally(() => st.pending.delete(p));
  return p;
}

/** What the plan wants subscribed on a chain: { key: filter }, with each key's watch. */
async function planChain(chain, s, rows, groupsByToken, quoteDecimals) {
  const filters = {};
  const watches = {};
  const conn = st.conns[chain];
  const over = conn && conn.counts().total >= s.daily_budget;
  st.budgetHit[chain] = !!over;
  // Prices: the orders closest to their trigger, within arm_pct.
  const seen = orders.lastSeen(chain);
  if (!over && seen && Date.now() - seen.at < 120_000) {
    const near = new Map(); // token -> { distance, rows }
    for (const row of rows.filter(r => ['stop_loss', 'take_profit', 'limit_buy'].includes(r.kind))) {
      const pair = seen.pairs[row.token];
      const c = orders.checkPrice(row, pair?.price_usd, orders.quoteOfRow(row).virtual ? seen.virtual_usd : seen.native_usd, 'plan');
      if (c.distance === null || c.distance === undefined || c.distance > s.arm_pct / 100) continue;
      const cur = near.get(row.token) || { distance: Infinity, rows: [], pair };
      cur.distance = Math.min(cur.distance, c.distance);
      cur.rows.push(row);
      near.set(row.token, cur);
    }
    const ranked = [...near.entries()].sort((a, b) => a[1].distance - b[1].distance).slice(0, s.max_pools);
    for (const [token, n] of ranked) {
      const check = await orders.routerCheck(chain, orders.config().routers[chain]).catch(() => null);
      const curve = check?.ok ? await orders.curveOf(chain, token, check).catch(() => null) : null;
      if (curve?.unsupported) continue; // nothing can fill there: no subscription
      if (curve) {
        filters[`curve:${token}`] = { address: token, topics: [T.transfer] };
        watches[`curve:${token}`] = { type: 'curve', chain, token, curve };
        continue;
      }
      const p = n.pair;
      if (!p?.pair || !(p.price_native > 0) || !p.quote) continue;
      const v4 = /^0x[0-9a-f]{64}$/i.test(p.pair);
      const key = `pool:${p.pair.toLowerCase()}`;
      if (st.bad.has(key)) continue;
      const dQ = await quoteDecimals(chain, p.quote).catch(() => null);
      if (dQ === null) continue;
      filters[key] = v4 ? { address: V4_POOL_MANAGER[chain], topics: [T.swapV4, p.pair.toLowerCase()] } : { address: p.pair.toLowerCase(), topics: [[T.syncV2, T.syncSolidly, T.swapV3, T.swapPcsV3]] };
      const prev = st.watches[chain]?.[key];
      watches[key] = {
        type: 'pool', chain, token, pool: p.pair.toLowerCase(), v4, decimals: n.rows[0].decimals, quote_decimals: dQ,
        ref: p.price_native, quote_usd: p.price_usd / p.price_native, native_usd: seen.native_usd, virtual_usd: seen.virtual_usd, dex: p.dex,
        orient: prev?.pool === p.pair.toLowerCase() ? prev.orient : null,
      };
    }
  }
  // Meme Watch: the launch-bundle wallets of coins with an open Meme Watch exit.
  for (const token of [...new Set(rows.filter(r => r.kind === 'meme_watch_exit').map(r => r.token))]) {
    const groups = groupsByToken.get(`${chain}:${token}`) || [];
    const wallets = [...new Set(groups.flatMap(g => [...g.wallets]))].sort();
    for (let i = 0; i < wallets.length; i += MAX_TOPIC_WALLETS) {
      const key = `insiders:${token}:${i / MAX_TOPIC_WALLETS}`;
      filters[key] = { address: token, topics: [T.transfer, wallets.slice(i, i + MAX_TOPIC_WALLETS).map(w => ethers.zeroPadValue(w, 32))] };
      watches[key] = { type: 'insiders', chain, token, groups };
    }
  }
  return { filters, watches };
}

/** Meme Watch's launch-bundle groups, by `chain:token`, from every enabled Meme Watch's snapshot. */
async function insiderGroups() {
  if (require('../admin/agentStates').isOff('meme_watch')) return new Map();
  const { rows } = await db.query(`SELECT snapshot FROM agent_settings WHERE agent = 'meme_watch' AND enabled`);
  const out = new Map();
  for (const r of rows) {
    for (const [key, p] of Object.entries(r.snapshot?.positions || {})) {
      if (!/^(base|bsc):0x[0-9a-f]{40}$/.test(key) || !Array.isArray(p.groups)) continue;
      const list = out.get(key) || [];
      for (const g of p.groups) {
        if (!g.funder || !Array.isArray(g.wallets) || !(g.bought_pct > 0)) continue;
        let cur = list.find(x => x.funder === g.funder);
        if (!cur) { cur = { funder: String(g.funder).toLowerCase(), wallets: new Set(), bought_pct: g.bought_pct }; list.push(cur); }
        for (const w of g.wallets) if (w?.address && /^0x[0-9a-fA-F]{40}$/.test(w.address)) cur.wallets.add(w.address.toLowerCase());
      }
      out.set(key, list);
    }
  }
  return out;
}

const quoteDecimalsOf = async (chain, quote) => {
  quote = String(quote).toLowerCase();
  const c = TRADE_CHAINS[chain];
  if (quote === ZERO || quote === orders.CHAINS[chain].wrapped.toLowerCase()) return 18;
  const base = Object.values(c.bases).find(b => b.address.toLowerCase() === quote);
  if (base) return base.decimals;
  return cache.cached(`meme:stream:decimals:${chain}:${quote}`, 86400, async () => Number(await orders.read(chain, quote, tx.ERC20, 'decimals')));
};

/** One planning pass: who leads, what to subscribe on each chain, and the health state. */
async function plan() {
  const s = get();
  if (!s.on || !configured() || orders.config().off || !env.databaseUrl) { stopAll(); return { off: true }; }
  if (!(await lead())) return { standby: true };
  const chains = Object.keys(urls()).filter(c => orders.config().routers?.[c]);
  const { rows } = await db.query(`SELECT * FROM meme_orders WHERE state = 'open' AND valid_until > now() AND chain = ANY($1)`, [chains]);
  const groups = await insiderGroups();
  for (const chain of chains) {
    if (!st.conns[chain]) {
      st.conns[chain] = evmStream.connect(chain, urls()[chain], { onLog: (key, log) => onLog(chain, key, log), onStatus: x => { st.status[chain] = x; } });
    }
    const { filters, watches } = await planChain(chain, s, rows.filter(r => r.chain === chain), groups, quoteDecimalsOf);
    st.watches[chain] = watches;
    st.rows = rows;
    await st.conns[chain].sync(filters);
  }
  for (const chain of Object.keys(st.conns)) if (!chains.includes(chain)) { st.conns[chain].close(); delete st.conns[chain]; delete st.watches[chain]; }
  await cache.set(STATE_KEY, stateNow(s), 120).catch(() => {});
  return { chains };
}

function stateNow(s = get()) {
  return {
    written_at: new Date().toISOString(), on: s.on, daily_budget: s.daily_budget, worker: `${require('os').hostname()}:${process.pid}`,
    chains: Object.fromEntries(Object.entries(st.conns).map(([chain, c]) => {
      const w = Object.values(st.watches[chain] || {});
      return [chain, { ...c.status(), today: c.counts().total, over_budget: !!st.budgetHit[chain], pools: w.filter(x => x.type === 'pool').length, curves: w.filter(x => x.type === 'curve').length, insider_filters: w.filter(x => x.type === 'insiders').length }];
    })),
    not_used: [...st.bad],
  };
}

/* ── Handling what's pushed ── */

function onLog(chain, key, log) {
  const w = st.watches[chain]?.[key];
  if (!w || log.removed) return;
  if (w.type === 'pool') return track(onPrice(chain, key, w, log).catch(err => logger.warn('meme stream: a price was not handled', { chain, key, error: err.message })));
  if (w.type === 'curve') return track(onCurve(chain, w).catch(err => logger.warn('meme stream: a curve trade was not handled', { chain, key, error: err.message })));
  if (w.type === 'insiders') return track(onInsider(chain, w, log).catch(err => logger.warn('meme stream: an insider transfer was not handled', { chain, key, error: err.message })));
}

// The orders watched, from the last plan. Firing one twice is harmless: the database fires an order only while it's open
// (orders.fire), so one sent back to watching (its quote didn't confirm the stream's price) can fire again on the next event.
const openRows = (chain, token, kinds) => (st.rows || []).filter(r => r.chain === chain && r.token === token && kinds.includes(r.kind));

async function fireAndFill(fired) {
  if (!fired.some(Boolean)) return;
  const r = await orders.fillNow();
  logger.info('meme stream: fired, filling now', { orders: fired.filter(Boolean).length, fill: r });
}

async function onPrice(chain, key, w, log) {
  const ratio = ratioOf(log);
  if (!(ratio > 0) || !Number.isFinite(ratio)) return;
  if (w.orient === null) {
    // Which side the coin is on: the one that agrees with DexScreener's price.
    const near = o => Math.abs(priceIn(ratio, o, w.decimals, w.quote_decimals) / w.ref - 1) * 100 <= CALIBRATE_PCT;
    const fits = [0, 1].filter(near);
    if (fits.length !== 1) {
      st.bad.add(key);
      logger.warn('meme stream: a pool\'s events don\'t match DexScreener\'s price; not used', { chain, pool: w.pool, dex: w.dex });
      return;
    }
    w.orient = fits[0];
  }
  const priceUsd = priceIn(ratio, w.orient, w.decimals, w.quote_decimals) * w.quote_usd;
  const source = `the pool's own ${log.topics[0] === T.swapV4 ? 'Swap event (Uniswap v4)' : log.topics[0] === T.syncV2 || log.topics[0] === T.syncSolidly ? 'Sync event' : 'Swap event'}, pushed over the chain's WebSocket (transaction ${String(log.transactionHash).slice(0, 10)}…); confirmed by the fill's own quote before anything is sent`;
  const fired = [];
  for (const row of openRows(chain, w.token, ['stop_loss', 'take_profit', 'limit_buy'])) {
    const c = orders.checkPrice(row, priceUsd, orders.quoteOfRow(row).virtual ? w.virtual_usd : w.native_usd, source);
    if (c.reason) {
      const ok = await orders.fire(row.id, { ...c.reason, stream: true, pool: w.pool, block: log.blockNumber ? Number(log.blockNumber) : null });
      fired.push(ok);
    }
  }
  await fireAndFill(fired);
}

async function onCurve(chain, w) {
  const last = st.lastCurve.get(w.token) || 0;
  if (Date.now() - last < CURVE_DEBOUNCE_MS) return;
  st.lastCurve.set(w.token, Date.now());
  const fired = [];
  for (const row of openRows(chain, w.token, ['stop_loss', 'take_profit', 'limit_buy'])) {
    const left = BigInt(row.amount_in) - BigInt(row.filled_in);
    if (left <= 0n) continue;
    const trigger = BigInt(row.trigger_out) * left / BigInt(row.amount_in);
    const q = orders.quoteOfRow(row);
    const source = `${w.curve.name}'s quote, read after the coin traded (its Transfer, pushed over the chain's WebSocket)`;
    let reason = null;
    if (orders.isBuy(row)) {
      const coins = (await orders.buyQuote(chain, row.token, tx.toTrade(left, 100, false), w.curve)).out;
      if (coins >= trigger) reason = { coins_now: Number(ethers.formatUnits(coins, row.decimals)), coins_at_limit: Number(ethers.formatUnits(trigger, row.decimals)), source };
    } else {
      const amount = left - left % w.curve.sellUnit;
      if (amount <= 0n) continue;
      const out = (await orders.sellQuote(chain, row.token, amount, w.curve)).out * left / amount;
      if (row.kind === 'stop_loss' ? out <= trigger : out >= trigger) reason = { value: `${ethers.formatEther(out)} ${q.symbol}`, trigger: `${ethers.formatEther(trigger)} ${q.symbol}`, source };
    }
    if (reason) fired.push(await orders.fire(row.id, { ...reason, stream: true }));
  }
  await fireAndFill(fired);
}

async function onInsider(chain, w, log) {
  if (log.topics?.[0] !== T.transfer || log.topics.length < 3) return;
  const from = ethers.getAddress('0x' + log.topics[1].slice(26)).toLowerCase();
  const to = ethers.getAddress('0x' + log.topics[2].slice(26)).toLowerCase();
  const g = w.groups.find(x => x.wallets.has(from));
  if (!g || g.wallets.has(to)) return; // not this group's, or a move between its own wallets
  const amount = BigInt(log.data);
  const { rowCount } = await db.query(
    `INSERT INTO meme_insider_sells (chain, token, funder, wallet, tx_hash, log_index, amount) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
    [chain, w.token, g.funder, from, log.transactionHash, Number(log.logIndex), amount.toString()]);
  if (!rowCount) return; // seen before (a reconnect)
  const { rows: [sum] } = await db.query(`SELECT COALESCE(sum(amount), 0)::text AS sold FROM meme_insider_sells WHERE chain = $1 AND token = $2 AND funder = $3`, [chain, w.token, g.funder]);
  const supply = BigInt(await cache.cached(`meme:stream:supply:${chain}:${w.token}`, 86400, async () => String(await orders.read(chain, w.token, tx.ERC20, 'totalSupply'))));
  const bought = supply * BigInt(Math.round(g.bought_pct * 100)) / 10000n;
  if (bought <= 0n) return;
  const soldPct = Number(BigInt(sum.sold) * 10000n / bought) / 100;
  if (soldPct < INSIDER_STEP_PCT) return;
  const n = await orders.memeWatchSignal(chain, w.token, {
    source: 'Meme Watch (the stream): Transfers out of the launch-bundle wallets, pushed over the chain\'s WebSocket',
    alert: `launch-bundle wallets have sold ${soldPct.toFixed(0)}% of what they bought (since the stream started watching)`,
    funder: g.funder, tx: log.transactionHash,
  });
  if (n) await fireAndFill([true]);
}

/* ── Leading, starting, stopping ── */

async function lead() {
  if (st.leading) {
    try { await st.lock.query('SELECT 1'); return true; } catch (err) { logger.warn('meme stream lost its lock: stopping', { error: err.message }); stopAll(); return false; }
  }
  const client = await db.getPool().connect();
  try {
    const { rows: [r] } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
    if (!r.ok) { client.release(); return false; }
  } catch (err) { client.release(err); throw err; }
  client.on('error', () => stopAll());
  st.lock = client;
  st.leading = true;
  logger.info('meme stream: leading (WebSocket triggers on BNB Chain and Base)');
  return true;
}

function stopAll() {
  for (const c of Object.values(st.conns)) c.close();
  st.conns = {}; st.watches = {}; st.rows = [];
  if (st.lock) {
    const client = st.lock;
    st.lock = null;
    client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {}).finally(() => client.release());
  }
  st.leading = false;
}

/** The trade service's start: plans every 15 seconds (it does nothing while off). */
function start() {
  if (st.timer) return;
  const run = () => plan().catch(err => logger.warn('meme stream: plan failed', { error: err.message }));
  st.timer = setInterval(run, PLAN_MS);
  st.timer.unref?.();
  run();
}
function halt() { clearInterval(st.timer); st.timer = null; stopAll(); }

/** For the admin panel (the web role reads what the trade service wrote). */
async function health(now = Date.now()) {
  const name = 'Order triggers on BNB Chain and Base (WebSocket)';
  const s = get();
  if (!configured()) return { name, state: 'not set', note: 'MEME_STREAM_WS_BASE and MEME_STREAM_WS_BSC aren\'t set: orders fire on the trade pass\'s polling (up to about 25 seconds).' };
  if (!s.on) return { name, state: 'off', note: 'Switched off in the admin panel: orders fire on the trade pass\'s polling (up to about 25 seconds).' };
  const x = await cache.get(STATE_KEY).catch(() => null);
  const fresh = x && now - Date.parse(x.written_at) < 120_000;
  const live = fresh && Object.values(x.chains || {}).some(c => c.connected);
  const today = Object.values(x?.chains || {}).reduce((a, c) => a + (c.today || 0), 0);
  return {
    name, state: live ? 'live' : 'down', today, budget: s.daily_budget, chains: x?.chains || {}, worker: x?.worker || null,
    note: live
      ? `${today.toLocaleString('en-US')} of today's ${s.daily_budget.toLocaleString('en-US')} pushed logs used. ${Object.entries(x.chains).map(([c, v]) => `${c}: ${v.pools} pools, ${v.curves} curves, ${v.insider_filters} insider filters${v.over_budget ? ' (over budget: prices back on polling until tomorrow)' : ''}`).join('; ')}.${x.not_used?.length ? ` ${x.not_used.length} pool(s) not used (their events didn't match DexScreener's price).` : ''}`
      : 'No fresh state from the trade service: orders fire on its polling until the stream is back.',
  };
}

module.exports = {
  DEFAULTS, LIMITS, get, check, configured, plan, start, halt, health, T, V4_POOL_MANAGER, ratioOf, priceIn, SETTINGS_KEY,
  _state: st, _drain: () => Promise.all([...st.pending]), _onLog: onLog, _stopAll: stopAll,
};
