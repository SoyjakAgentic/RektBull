/**
 * Event logs pushed over a WebSocket (eth_subscribe "logs"), one connection per
 * chain, for trade/memeStream.js. The URL is the provider's WebSocket endpoint
 * (Chainstack's, with its key in the URL: MEME_STREAM_WS_BASE and
 * MEME_STREAM_WS_BSC, in the environment's secret settings, never the repo or
 * chat).
 *
 * - sync(filters) keeps the live subscriptions equal to `filters` ({ key: filter }):
 *   new keys are subscribed, missing ones unsubscribed, unchanged ones left alone.
 * - Reconnects by itself (1 s, doubling to 30 s) and subscribes everything again.
 *   Nothing is replayed: the trade service's polling covers what happened meanwhile.
 * - Asks eth_chainId every 4 minutes: Chainstack closes a connection idle for an hour.
 * - Counts what the provider bills: each subscribe, and each pushed log (Chainstack: one
 *   request each). Per key and per UTC day, flushed to provider_usage every minute.
 */
const logger = require('../config/logger');
const usage = require('./usage');

const KEEPALIVE_MS = 4 * 60_000;
const FLUSH_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

let makeSocket = url => new WebSocket(url); // Node 22's own WebSocket

const hostOf = url => { try { return new URL(url).hostname; } catch { return 'ws'; } };
const today = () => new Date().toISOString().slice(0, 10);

/**
 * A connection for one chain. onLog(key, log) gets each pushed log with the key of the filter it matched.
 * Returns { sync, close, status, counts }.
 */
function connect(chain, url, { onLog, onStatus = () => {} } = {}) {
  const provider = `ws:${hostOf(url)}`;
  let ws = null;
  let closed = false;
  let backoff = 1000;
  let nextId = 1;
  let reconnectTimer = null;
  const pending = new Map(); // request id -> { resolve, reject }
  const wanted = new Map(); // key -> filter (what sync asked for)
  const live = new Map(); // key -> { id: subscription id, filter }
  const byId = new Map(); // subscription id -> key
  const status = { chain, provider, connected: false, since: null, last_message_at: null, last_error: null, reconnects: 0 };
  const day = { date: today(), total: 0, byKey: new Map() };
  let unflushed = 0;

  const count = (key, n = 1) => {
    if (day.date !== today()) { day.date = today(); day.total = 0; day.byKey.clear(); }
    day.total += n;
    unflushed += n;
    if (key) day.byKey.set(key, (day.byKey.get(key) || 0) + n);
  };
  const flusher = setInterval(() => { const n = unflushed; unflushed = 0; usage.add(provider, n); }, FLUSH_MS);
  flusher.unref?.();

  function request(method, params) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== 1) return reject(new Error('not connected'));
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method}: no answer in 15 s`)); }, 15_000).unref?.();
    });
  }

  async function subscribe(key, filter) {
    count(key);
    const id = await request('eth_subscribe', ['logs', filter]);
    live.set(key, { id, filter });
    byId.set(id, key);
  }
  async function unsubscribe(key) {
    const s = live.get(key);
    live.delete(key);
    if (!s) return;
    byId.delete(s.id);
    await request('eth_unsubscribe', [s.id]).catch(() => {}); // a dead connection drops it anyway
  }

  /** Makes the live subscriptions match `filters`. Failures are logged and retried on the next sync. */
  async function sync(filters) {
    wanted.clear();
    for (const [k, f] of Object.entries(filters)) wanted.set(k, f);
    if (!status.connected) return;
    for (const key of [...live.keys()]) {
      if (!wanted.has(key) || JSON.stringify(wanted.get(key)) !== JSON.stringify(live.get(key).filter)) await unsubscribe(key);
    }
    for (const [key, filter] of wanted) {
      if (live.has(key)) continue;
      await subscribe(key, filter).catch(err => logger.warn('evm stream: not subscribed', { chain, key, error: err.message }));
    }
  }

  function open() {
    if (closed) return;
    try { ws = makeSocket(url); } catch (err) { status.last_error = err.message; return later(); }
    ws.onopen = () => {
      status.connected = true; status.since = new Date().toISOString(); status.last_error = null; backoff = 1000;
      live.clear(); byId.clear();
      onStatus({ ...status });
      sync(Object.fromEntries(wanted)).catch(err => logger.warn('evm stream: resubscribe failed', { chain, error: err.message }));
    };
    ws.onmessage = ev => {
      status.last_message_at = Date.now();
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
      if (m.id !== undefined && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        return m.error ? p.reject(new Error(m.error.message || 'error')) : p.resolve(m.result);
      }
      if (m.method === 'eth_subscription' && m.params?.result) {
        const key = byId.get(m.params.subscription);
        count(key || null);
        if (key) {
          try { onLog(key, m.params.result); } catch (err) { logger.warn('evm stream: a log was not handled', { chain, key, error: err.message }); }
        }
      }
    };
    ws.onerror = ev => { status.last_error = ev?.message || 'connection error'; };
    ws.onclose = () => {
      status.connected = false;
      for (const p of pending.values()) p.reject(new Error('connection closed'));
      pending.clear();
      onStatus({ ...status });
      later();
    };
  }
  function later() {
    if (closed) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { status.reconnects++; open(); }, backoff);
    reconnectTimer.unref?.();
    backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
  }
  const keepalive = setInterval(() => { if (status.connected) { count(null); request('eth_chainId', []).catch(() => {}); } }, KEEPALIVE_MS);
  keepalive.unref?.();

  open();
  return {
    sync,
    close() {
      closed = true;
      clearInterval(keepalive); clearInterval(flusher); clearTimeout(reconnectTimer);
      usage.add(provider, unflushed); unflushed = 0;
      try { ws?.close(); } catch { /* already closed */ }
    },
    status: () => ({ ...status, subscriptions: live.size }),
    counts: () => ({ date: day.date, total: day.total, byKey: Object.fromEntries(day.byKey) }),
    _socket: () => ws,
  };
}

module.exports = { connect, _setSocket: fn => { makeSocket = fn || (url => new WebSocket(url)); } };
