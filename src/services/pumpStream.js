/**
 * pump.fun's own events, streamed (providers/yellowstone.js): the coins
 * created, every buy and sell on their curves, and each curve completing and
 * moving to PumpSwap, seconds after the chain confirms them. It feeds the
 * Solana launch feed (solanaLaunches.js), and through it the meme picks'
 * watchlist, instead of polling GeckoTerminal every 20 seconds.
 *
 * The events are pump.fun's Anchor events, read with the layouts in pump.fun's
 * published IDL (github.com/pump-fun/pump-public-docs, idl/pump.json, read
 * 23 November 2026):
 *   CreateEvent                    name, symbol, uri, mint, bonding_curve, user, creator, timestamp,
 *                                  reserves, supply, token_program, flags, quote_mint, …
 *   TradeEvent                     mint, sol_amount, token_amount, is_buy, user, timestamp,
 *                                  virtual and real reserves, …, quote_mint, …
 *   CompleteEvent                  user, mint, bonding_curve, timestamp, quote_mint
 *   CompletePumpAmmMigrationEvent  user, mint, amounts, bonding_curve, timestamp, pool, quote_mint
 * And PumpSwap's (pump_amm, the AMM a curve moves to: idl/pump_amm.json in the
 * same repository, read 25 November 2026), for the pools of graduated coins the
 * wallet rankings still follow (walletRankings.pools(): a filter of its own):
 *   BuyEvent    timestamp, base_amount_out, …, user_quote_amount_in (the SOL the
 *               user paid, every fee included), pool, user, …, coin_creator
 *   SellEvent   timestamp, base_amount_in, …, user_quote_amount_out (the SOL the
 *               user got, after every fee), pool, user, …, coin_creator
 * Only the leading fields are needed; later fields pump.fun adds are ignored.
 * Each event is found either as a self-CPI inner instruction (Anchor's
 * emit_cpi: an 8-byte event tag, then the event's 8-byte discriminator) or as
 * a "Program data:" log line (emit!), whichever the program used.
 *
 * Curves priced in anything other than SOL are left out, as in the polled feed.
 *
 * Runs in the worker only. What it holds is kept in memory and written to the
 * shared cache every few seconds (STATE_KEY) for the web role to read; the
 * feed uses it only while it's fresh, and otherwise polls as before.
 */
const { getAddressDecoder } = require('@solana/kit');
const yellowstone = require('../providers/yellowstone');
const cache = require('../lib/cache');
const db = require('../config/db');
const logger = require('../config/logger');

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'; // PumpSwap
const STATE_KEY = 'launches:stream:solana';
const FLUSH_MS = 2000;
const FRESH_MS = 30000; // the feed trusts the stream's state while it was written within this
const NEW_WINDOW_MS = 3600000; // new coins kept for an hour
const KEEP_NAMES_MS = 24 * 3600000; // a coin's name and symbol kept for a day, for its graduation card
const TRADED_WINDOW_MS = 3600000; // a curve counts as active for an hour after its last trade
const MAX = { creates: 20000, curves: 5000, graduated: 200, written_curves: 300, written_new: 200 };

// pump.fun's IDL discriminators (sha256("event:<Name>")[0..8]).
const DISC = {
  create: Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]),
  trade: Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]),
  complete: Buffer.from([95, 114, 97, 156, 212, 46, 152, 8]),
  migrate: Buffer.from([189, 233, 93, 185, 92, 148, 234, 148]),
  // PumpSwap's (idl/pump_amm.json)
  swapBuy: Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]),
  swapSell: Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]),
};
// Anchor's tag before a self-CPI event (EVENT_IX_TAG, little-endian).
const EVENT_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const SOL_QUOTES = new Set(['So11111111111111111111111111111111111111112', '11111111111111111111111111111111']);

/** A borsh reader that says when it ran out, so a field pump.fun hasn't sent reads as undefined. */
class Reader {
  constructor(b) { this.b = b; this.o = 0; }
  has(n) { return this.o + n <= this.b.length; }
  take(n) { if (!this.has(n)) throw new RangeError('short'); const s = this.b.subarray(this.o, this.o + n); this.o += n; return s; }
  pubkey() { return getAddressDecoder().decode(Uint8Array.from(this.take(32))); }
  u64() { return this.take(8).readBigUInt64LE(0); }
  i64() { return this.take(8).readBigInt64LE(0); }
  u16() { return this.take(2).readUInt16LE(0); }
  bool() { return this.take(1)[0] === 1; }
  u8() { return this.take(1)[0]; }
  string() { const n = this.take(4).readUInt32LE(0); if (n > 1000) throw new RangeError('long'); return this.take(n).toString('utf8'); }
  /** Reads the rest only if it's there: undefined when pump.fun's event stops before it. */
  maybe(fn) { const at = this.o; try { return fn(); } catch { this.o = at; return undefined; } }
}

function decodeCreate(r) {
  const e = { type: 'create', name: r.string(), symbol: r.string(), uri: r.string(), mint: r.pubkey(), bonding_curve: r.pubkey(), user: r.pubkey(), creator: r.pubkey(), timestamp: Number(r.i64()) };
  r.maybe(() => { r.u64(); r.u64(); r.u64(); r.u64(); r.pubkey(); r.bool(); r.bool(); e.quote_mint = r.pubkey(); });
  return e;
}
function decodeTrade(r) {
  const e = {
    type: 'trade', mint: r.pubkey(), sol_amount: r.u64(), token_amount: r.u64(), is_buy: r.bool(), user: r.pubkey(), timestamp: Number(r.i64()),
    virtual_sol_reserves: r.u64(), virtual_token_reserves: r.u64(), real_sol_reserves: r.u64(), real_token_reserves: r.u64(),
  };
  // On to quote_mint: fee_recipient, fee_bps, fee, creator, creator_fee_bps, creator_fee, track_volume, two totals,
  // current_sol_volume, last_update_timestamp, ix_name, mayhem_mode, cashback bps and amount, buyback bps and amount, shareholders.
  r.maybe(() => {
    // The fees and the coin's creator are kept as read (the wallet rankings count what a trade cost, and leave out a coin's creator).
    r.pubkey(); r.u64(); e.fee = r.u64(); e.creator = r.pubkey(); r.u64(); e.creator_fee = r.u64();
    r.bool(); r.u64(); r.u64(); r.u64(); r.i64(); r.string(); r.bool(); r.u64(); r.u64(); r.u64(); r.u64();
    const n = r.take(4).readUInt32LE(0);
    if (n > 100) throw new RangeError('long');
    for (let i = 0; i < n; i++) { r.pubkey(); r.u16(); }
    e.quote_mint = r.pubkey();
  });
  return e;
}
function decodeComplete(r) {
  const e = { type: 'complete', user: r.pubkey(), mint: r.pubkey(), bonding_curve: r.pubkey(), timestamp: Number(r.i64()) };
  r.maybe(() => { e.quote_mint = r.pubkey(); });
  return e;
}
function decodeMigrate(r) {
  const e = { type: 'migrate', user: r.pubkey(), mint: r.pubkey(), mint_amount: r.u64(), sol_amount: r.u64(), pool_migration_fee: r.u64(), bonding_curve: r.pubkey(), timestamp: Number(r.i64()), pool: r.pubkey() };
  r.maybe(() => { e.quote_mint = r.pubkey(); });
  return e;
}
/** A PumpSwap trade: the coins moved, and the SOL the user paid or got with every fee in it. */
function decodeSwap(isBuy) {
  return r => {
    const timestamp = Number(r.i64());
    const base = r.u64();
    for (let i = 0; i < 11; i++) r.u64(); // the limit, four reserves, the gross amount, the LP and protocol fees and rates, the amount with the LP fee
    const quote = r.u64(); // user_quote_amount_in (a buy) or user_quote_amount_out (a sale)
    const pool = r.pubkey();
    const user = r.pubkey();
    r.pubkey(); r.pubkey(); r.pubkey(); r.pubkey(); // the user's two token accounts, the protocol fee recipient and its account
    return { type: 'swap', is_buy: isBuy, timestamp, base_amount: base, quote_amount: quote, pool, user, coin_creator: r.pubkey() };
  };
}
const DECODE = [[DISC.create, decodeCreate], [DISC.trade, decodeTrade], [DISC.complete, decodeComplete], [DISC.migrate, decodeMigrate],
  [DISC.swapBuy, decodeSwap(true)], [DISC.swapSell, decodeSwap(false)]];

/** One event from its bytes (discriminator first), or null when it isn't one of these or can't be read. */
function decodeEvent(bytes) {
  if (!bytes || bytes.length < 8) return null;
  const d = bytes.subarray(0, 8);
  const hit = DECODE.find(([disc]) => disc.equals(d));
  if (!hit) return null;
  try { return hit[1](new Reader(bytes.subarray(8))); } catch { return null; }
}

/** pump.fun's and PumpSwap's events in one transaction (from yellowstone.readTransaction), self-CPI first, else its log lines. */
function eventsOf(tx) {
  if (tx.failed) return [];
  const cpi = tx.instructions.filter(i => (i.program === PUMP || i.program === PUMP_AMM) && i.data.length > 16 && i.data.subarray(0, 8).equals(EVENT_TAG)).map(i => decodeEvent(i.data.subarray(8))).filter(Boolean);
  if (cpi.length) return cpi;
  return tx.logs.filter(l => l.startsWith('Program data: ')).map(l => decodeEvent(Buffer.from(l.slice(14), 'base64'))).filter(Boolean);
}
const inSol = e => e.quote_mint === undefined || SOL_QUOTES.has(e.quote_mint);

/* ── what the worker holds ── */

function emptyState() {
  return { creates: new Map(), curves: new Map(), graduated: new Map(), started_at: Date.now(), events: 0, changed: false };
}
let st = emptyState();

/** Takes one decoded event into the state. */
function apply(e, now = Date.now(), s = st) {
  if (!inSol(e)) return;
  s.events++;
  s.changed = true;
  const at = e.timestamp > 0 ? e.timestamp * 1000 : now;
  if (e.type === 'create') {
    s.creates.set(e.mint, { mint: e.mint, curve: e.bonding_curve, name: e.name, symbol: e.symbol, creator: e.creator, at });
  } else if (e.type === 'trade') {
    s.curves.set(e.mint, { mint: e.mint, real_token: e.real_token_reserves.toString(), real_sol: e.real_sol_reserves.toString(), last_trade_at: at, trades: (s.curves.get(e.mint)?.trades || 0) + 1 });
  } else if (e.type === 'complete') {
    s.curves.delete(e.mint);
    if (!s.graduated.has(e.mint)) s.graduated.set(e.mint, { mint: e.mint, pool: null, at });
  } else if (e.type === 'migrate') {
    s.curves.delete(e.mint);
    s.graduated.set(e.mint, { mint: e.mint, pool: e.pool, at: s.graduated.get(e.mint)?.at || at });
  }
}

/** Drops what's too old and keeps each map within bounds. */
function prune(now = Date.now(), s = st) {
  const cut = (map, keep, field, max) => {
    for (const [k, v] of map) if (now - v[field] > keep) map.delete(k);
    while (map.size > max) map.delete(map.keys().next().value); // oldest first: a Map keeps insertion order
  };
  cut(s.creates, KEEP_NAMES_MS, 'at', MAX.creates);
  cut(s.curves, TRADED_WINDOW_MS, 'last_trade_at', MAX.curves);
  cut(s.graduated, KEEP_NAMES_MS, 'at', MAX.graduated);
}

/** What's written for the feed: the last hour's new coins, the most-funded active curves, and the day's graduations. */
function snapshot(now = Date.now(), s = st) {
  const name = m => s.creates.get(m) || {};
  return {
    written_at: new Date(now).toISOString(), started_at: new Date(s.started_at).toISOString(), events: s.events,
    live: yellowstone.status('pumpfun').live,
    insiders: require('./insiderWatch').summary(), // Meme Watch's Solana wallets on the stream
    followed: require('./solanaTracker').summary(), // the Wallet Tracker's Solana wallets on the stream
    amm_pools: require('./walletRankings').poolSummary(), // PumpSwap pools on the stream, for the wallet rankings
    launches: [...s.creates.values()].filter(c => now - c.at < NEW_WINDOW_MS).sort((a, b) => b.at - a.at).slice(0, MAX.written_new),
    curves: [...s.curves.values()].sort((a, b) => (BigInt(b.real_sol) > BigInt(a.real_sol) ? 1 : -1)).slice(0, MAX.written_curves)
      .map(c => ({ ...c, symbol: name(c.mint).symbol || null, name: name(c.mint).name || null })),
    graduated: [...s.graduated.values()].sort((a, b) => b.at - a.at).map(g => ({ ...g, symbol: name(g.mint).symbol || null, name: name(g.mint).name || null })),
  };
}

/*
 * One worker streams at a time. Chainstack's $49 plan allows 2 connections at once (the owner's choice,
 * 23 November 2026): one streams, and the other is headroom for a deploy's overlap or a reconnect. So the
 * stream is held behind a Postgres advisory lock on a connection of its own. A second worker waits on
 * standby and tries again every STANDBY_MS; when the holder stops, or its database connection drops (which
 * frees the lock), one standby takes over. A holder that loses its connection stops streaming at once, so
 * two never stream together. With no database (local development), there's no lock.
 */
const LOCK_ID = 727020; // pg advisory lock: one pump.fun stream at a time (src/hyperliquid/auto.js: 727002; src/trade/autonomous.js: 727001)
let STANDBY_MS = 30000;
const HEARTBEAT_MS = 15000;

let stop = null;
let flusher = null;
let watcher = null;
let ranker = null;
let written = 0;
let lock = null; // { client, heartbeat } while this worker holds the lock
let standby = null;
let leading = false;
const WORKER = `${require('os').hostname()}:${process.pid}`;

/** Takes the lock on a connection of its own, or returns null when another worker holds it. */
async function acquire() {
  if (!require('../config/env').databaseUrl) return { client: null };
  const client = await db.getPool().connect();
  try {
    const { rows: [r] } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
    if (r.ok) return { client };
  } catch (err) {
    client.release(err);
    throw err;
  }
  client.release();
  return null;
}

/** Gives the lock back (or drops its connection, which frees it). */
function release(err) {
  if (!lock) return;
  const { client, heartbeat } = lock;
  lock = null;
  clearInterval(heartbeat);
  if (!client) return;
  if (err) { client.release(err); return; }
  client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {}).finally(() => client.release());
}

function waitOnStandby() {
  clearTimeout(standby);
  standby = setTimeout(() => { standby = null; lead().catch(err => logger.warn('pump stream standby check failed', { error: err.message })); }, STANDBY_MS);
  standby.unref();
}

/** The lock's connection failed: stop streaming at once (another worker may take over), then wait on standby. */
function lost(err) {
  if (!leading) return;
  logger.warn('pump stream lost its lock connection: stopping, on standby', { error: err.message });
  stopStream();
  release(err);
  leading = false;
  waitOnStandby();
}

/** Tries to become the worker that streams; on standby otherwise. True when this worker streams. */
async function lead() {
  if (leading) return true;
  let got;
  try { got = await acquire(); } catch (err) { logger.warn('pump stream lock not reached', { error: err.message }); waitOnStandby(); return false; }
  if (!got) { waitOnStandby(); return false; }
  leading = true;
  lock = { client: got.client, heartbeat: null };
  if (got.client) {
    got.client.on('error', lost);
    // A quiet connection can die unnoticed: ask it something every 15 seconds.
    lock.heartbeat = setInterval(() => { got.client.query('SELECT 1').catch(lost); }, HEARTBEAT_MS);
    lock.heartbeat.unref();
  }
  st = emptyState();
  // One subscription: pump.fun's program, and the launch-bundle wallets Meme Watch follows on Solana (insiderWatch.js).
  const insiders = require('./insiderWatch');
  const pumpFilter = { pumpfun: { accountInclude: [PUMP] } };
  const tracker = require('./solanaTracker');
  const rankings = require('./walletRankings'); // realised profit per wallet, from every trade on pump.fun's curves
  rankings.reset();
  stop = await yellowstone.subscribe('pumpfun', pumpFilter, t => {
    const tx = yellowstone.readTransaction(t);
    for (const e of eventsOf(tx)) { apply(e); rankings.onEvent(e); }
    insiders.onTransaction(tx);
    tracker.onTransaction(tx);
  });
  // The filters beside pump.fun's: PumpSwap's pools the wallet rankings follow (one filter, only when there are any: an
  // empty one would match every transaction), then the wallets users follow (the Wallet Tracker), then Meme Watch's insiders.
  const watch = async () => {
    try {
      const pools = rankings.pools();
      const amm = pools.length ? { pumpswap: { accountInclude: pools } } : {};
      const room = yellowstone.MAX_FILTERS - 1 - Object.keys(amm).length;
      const followed = await tracker.prepare(room);
      await insiders.refresh('pumpfun', { ...pumpFilter, ...amm, ...followed.filters }, room - Object.keys(followed.filters).length);
    } catch (err) { logger.warn('stream filters not refreshed', { error: err.message }); }
  };
  watch();
  watcher = setInterval(watch, 60000);
  watcher.unref();
  flusher = setInterval(() => {
    prune();
    if (!st.changed && Date.now() - written < 10000) return; // quiet: still written every 10 seconds, so the feed sees it's alive
    st.changed = false;
    written = Date.now();
    cache.set(STATE_KEY, { ...snapshot(), worker: WORKER }, 300).catch(err => logger.warn('pump stream state not written', { error: err.message }));
  }, FLUSH_MS);
  flusher.unref();
  ranker = setInterval(() => rankings.flush().catch(err => logger.warn('wallet rankings not written', { error: err.message })), rankings.FLUSH_MS);
  ranker.unref();
  logger.info('pump.fun stream started (Yellowstone gRPC)', { worker: WORKER });
  return true;
}

/** The worker's start: when YELLOWSTONE_GRPC_URL and its token are set, streams if no other worker does, else waits on standby. */
async function start() {
  if (!yellowstone.configured() || leading || standby) return leading;
  return lead();
}
function stopStream() { clearInterval(flusher); flusher = null; clearInterval(watcher); watcher = null; clearInterval(ranker); ranker = null; if (stop) stop(); stop = null; }
/** Stops streaming and gives the lock back (a standby elsewhere takes over). */
function halt() {
  clearTimeout(standby); standby = null;
  stopStream();
  release();
  leading = false;
}

/** The stream's state for the feed, or null when it's not running or not fresh. */
async function fresh(now = Date.now()) {
  const s = await cache.get(STATE_KEY);
  if (!s || !s.live || now - Date.parse(s.written_at) > FRESH_MS) return null;
  return s;
}

/** For the admin panel's health view (the web role reads what the worker wrote). */
async function health(now = Date.now()) {
  const name = 'pump.fun stream (Yellowstone gRPC)';
  if (!yellowstone.configured()) return { name, state: 'not set', note: 'YELLOWSTONE_GRPC_URL and YELLOWSTONE_GRPC_TOKEN aren\'t set: the Solana launch feed polls GeckoTerminal and RPC.' };
  const s = await cache.get(STATE_KEY).catch(() => null);
  const ok = s && s.live && now - Date.parse(s.written_at) <= FRESH_MS;
  return {
    name, state: ok ? 'live' : 'down', events: s?.events ?? 0, since: s?.started_at || null, last_written_at: s?.written_at || null, worker: s?.worker || null, insiders: s?.insiders || null,
    note: ok ? `The Solana launch feed reads the stream, from ${s.worker || 'the worker'} (one worker streams; any other waits on standby).${s.amm_pools ? ` Wallet rankings: ${s.amm_pools.watched} PumpSwap pools of graduated coins followed${s.amm_pools.overflow ? ` (${s.amm_pools.overflow} more not followed: their positions are dropped)` : ''}.` : ''}${s.insiders ? ` Meme Watch: ${s.insiders.watched} launch-bundle wallets on ${s.insiders.coins} coin${s.insiders.coins === 1 ? '' : 's'} watched as they trade${s.insiders.overflow ? `; ${s.insiders.overflow} more left to the 6-hour check (the stream's limit)` : ''}.` : ''}${s.followed ? ` Wallet Tracker: ${s.followed.watched} followed Solana wallets${s.followed.overflow ? `; ${s.followed.overflow} more than the stream takes, not followed` : ''}.` : ''}` : 'No fresh state from the worker: the Solana launch feed is polling GeckoTerminal and RPC until it\'s back.',
  };
}

module.exports = { LOCK_ID, acquire, lead, lost, health, PUMP, PUMP_AMM, STATE_KEY, FRESH_MS, DISC, EVENT_TAG, decodeEvent, eventsOf, apply, prune, snapshot, emptyState, start, halt, fresh, _state: () => st, _leading: () => leading, _setStandbyMs: ms => { STANDBY_MS = ms; } };
