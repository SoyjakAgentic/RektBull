/**
 * Hyperliquid's public API (hyperliquid.gitbook.io/hyperliquid-docs, read
 * 16 November 2026): POST /info for data, POST /exchange for signed actions.
 * No key: Hyperliquid limits by IP, 1,200 "weight" a minute across REST calls
 * (docs: for-developers/api/rate-limits-and-user-limits).
 *
 * - info: counted through usage.track('hyperliquid'); answers that are the
 *   same for everyone (meta, prices) are shared between requests here, and
 *   the slow-changing ones through lib/cache.
 * - exchange: relays an action that is ALREADY SIGNED, by the user's wallet or
 *   by an agent key. This file never signs and never sees a key.
 *
 * A weight budget is kept here, so RektBull refuses a read with a plain
 * message before Hyperliquid would block the server's address.
 */
const axios = require('axios');
const env = require('../config/env');
const { track } = require('./usage');
const { cached } = require('../lib/cache');

const URLS = { mainnet: 'https://api.hyperliquid.xyz', testnet: 'https://api.hyperliquid-testnet.xyz' };
const SOURCE = 'Hyperliquid\'s info API';
/** Weights from Hyperliquid's rate-limit page: these few are 2, userRole is 60, every other documented info request is 20. */
const LIGHT = new Set(['l2Book', 'allMids', 'clearinghouseState', 'orderStatus', 'spotClearinghouseState', 'exchangeStatus']);
const weightOf = type => (LIGHT.has(type) ? 2 : type === 'userRole' ? 60 : 20);

class HyperliquidError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; this.isHyperliquid = true; }
}

const network = () => (env.hlNetwork === 'testnet' ? 'testnet' : 'mainnet');
const isMainnet = () => network() === 'mainnet';
const baseUrl = () => URLS[network()];

// Tests replace this to avoid the network: (path, body) -> the parsed answer.
let transport = async (path, body) => (await axios.post(`${baseUrl()}${path}`, body, { timeout: 10000, headers: { 'content-type': 'application/json' } })).data;
const setTransport = fn => { transport = fn; };

/* The weight used in the last minute, by this process. */
let spent = []; // [time, weight]
function spend(weight, now = Date.now()) {
  spent = spent.filter(([t]) => now - t < 60000);
  const used = spent.reduce((n, [, w]) => n + w, 0);
  if (used + weight > env.hlWeightPerMinute) throw new HyperliquidError('RektBull is reading Hyperliquid as fast as Hyperliquid allows just now. Try again in a few seconds.', 503);
  spent.push([now, weight]);
}
const weightUsed = (now = Date.now()) => spent.filter(([t]) => now - t < 60000).reduce((n, [, w]) => n + w, 0);

const why = err => {
  const d = err.response?.data;
  return typeof d === 'string' ? d : d?.response || d?.error || err.message;
};

/* Answers shared for a few seconds in this process, with one request in flight per key. */
const recent = new Map(); // key -> { at, value } | { pending }
async function shared(key, ms, fn) {
  const hit = recent.get(key);
  if (hit?.pending) return hit.pending;
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const pending = fn().then(value => { recent.set(key, { at: Date.now(), value }); return value; }, err => { recent.delete(key); throw err; });
  recent.set(key, { pending });
  if (recent.size > 5000) for (const [k, v] of recent) { if (!v.pending && Date.now() - v.at > 60000) recent.delete(k); }
  return pending;
}

/**
 * One info request. `ms` shares the answer in this process for that long;
 * `ttl` (seconds) also keeps it in the shared cache, for answers that change slowly.
 */
async function info(body, { ms = 0, ttl = 0 } = {}) {
  const key = `hl:${network()}:${JSON.stringify(body)}`;
  const read = () => track('hyperliquid', async () => {
    spend(weightOf(body.type));
    try {
      return await transport('/info', body);
    } catch (err) {
      if (err.isHyperliquid) throw err;
      const status = err.response?.status;
      throw new HyperliquidError(status === 429 ? 'Hyperliquid is rate-limiting RektBull just now. Try again in a minute.' : `Hyperliquid's info API didn't answer (${String(why(err)).slice(0, 200)})`, status === 429 ? 503 : 502);
    }
  });
  const viaCache = ttl ? () => cached(key, ttl, read) : read;
  return ms || ttl ? shared(key, ms || ttl * 1000, viaCache) : viaCache();
}

/**
 * Sends a signed action to Hyperliquid and returns its answer as it is.
 * payload: { action, nonce, signature, vaultAddress?, expiresAfter? }.
 */
async function exchange(payload) {
  return track('hyperliquid-exchange', async () => {
    spend(1 + Math.floor((payload.action?.orders?.length || payload.action?.cancels?.length || 0) / 40));
    try {
      return await transport('/exchange', payload);
    } catch (err) {
      if (err.isHyperliquid) throw err;
      const status = err.response?.status;
      throw new HyperliquidError(status === 429 ? 'Hyperliquid is rate-limiting RektBull just now. Nothing was sent; try again in a minute.' : `Hyperliquid didn't accept the request (${String(why(err)).slice(0, 200)})`, status === 429 ? 503 : 502);
    }
  });
}

const _reset = () => { spent = []; recent.clear(); };

module.exports = { info, exchange, setTransport, network, isMainnet, baseUrl, weightOf, weightUsed, HyperliquidError, SOURCE, URLS, _reset };
