/**
 * Polymarket's public APIs (docs.polymarket.com, read 16 November 2026). All
 * keyless and free; every call is counted (providers/usage) and, where it can
 * be reused, cached.
 *
 *   Gamma    https://gamma-api.polymarket.com   events and markets
 *   CLOB     https://clob.polymarket.com        order books, builder trades
 *   Data v2  https://data-api.polymarket.com    positions, resolution state
 *   Relayer  https://relayer-v2.polymarket.com  gasless wallet transactions (needs RektBull's Builder API key)
 *
 * Nothing here places an order: orders go from the user's browser straight to
 * the CLOB (public/polymarket.js), signed by the user's wallet, with CLOB
 * credentials that never reach this server.
 */
const crypto = require('crypto');
const axios = require('axios');
const env = require('../config/env');
const { track } = require('./usage');
const { cached } = require('../lib/cache');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const DATA = 'https://data-api.polymarket.com';
const RELAYER = 'https://relayer-v2.polymarket.com';
const SOURCES = {
  gamma: 'Polymarket Gamma API (gamma-api.polymarket.com)',
  clob: 'Polymarket CLOB API (clob.polymarket.com)',
  data: 'Polymarket Data API v2 (data-api.polymarket.com)',
  relayer: 'Polymarket Relayer (relayer-v2.polymarket.com)',
};

/** Tests replace these. */
const http = {
  get: (url, opts) => axios.get(url, opts),
  post: (url, body, opts) => axios.post(url, body, opts),
};

/** A read that failed, naming which Polymarket API and why. */
class PolymarketUnavailable extends Error {
  constructor(source, why, status = 502) {
    super(`${SOURCES[source]} couldn't be read: ${why}`);
    this.status = status; this.source = SOURCES[source]; this.isPolymarketUnavailable = true;
  }
}

const reason = err => {
  const body = err.response?.data;
  const said = body && (body.error || body.errorMsg || body.message || (typeof body === 'string' ? body : null));
  return said ? `${String(said).slice(0, 200)} (HTTP ${err.response.status})` : err.response ? `HTTP ${err.response.status}` : err.message;
};

async function read(source, base, path, params) {
  try {
    return await track(`polymarket-${source}`, async () => (await http.get(base + path, { params, timeout: 10000 })).data);
  } catch (err) {
    if (err.isProviderLimit) throw new PolymarketUnavailable(source, err.message, 503);
    throw new PolymarketUnavailable(source, reason(err));
  }
}

const key = (name, params) => `polymarket:${name}:${crypto.createHash('sha1').update(JSON.stringify(params)).digest('hex').slice(0, 16)}`;

/* ── Gamma: events and markets ── */

/** Open events, biggest 24-hour volume first (or by `order`). */
function events({ limit = 20, offset = 0, tag = null, order = 'volume24hr' } = {}) {
  const params = { active: true, closed: false, archived: false, limit, offset, order, ascending: false, ...(tag ? { tag_slug: tag } : {}) };
  return cached(key('events', params), 60, () => read('gamma', GAMMA, '/events', params));
}

async function event(slug) {
  const rows = await cached(key('event', slug), 30, () => read('gamma', GAMMA, '/events', { slug }));
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function market(slug) {
  const rows = await cached(key('market', slug), 30, () => read('gamma', GAMMA, '/markets', { slug }));
  return Array.isArray(rows) ? rows[0] || null : null;
}

/** Gamma's search over events (GET /public-search). */
async function search(q, { limit = 20 } = {}) {
  const params = { q, limit_per_type: limit, events_status: 'active' };
  const out = await cached(key('search', params), 60, () => read('gamma', GAMMA, '/public-search', params));
  return out?.events || [];
}

/* ── CLOB: books, builder trades ── */

/** One outcome's order book. Fresh for 2 seconds: prices move. */
function book(tokenId) {
  return cached(key('book', tokenId), 2, () => read('clob', CLOB, '/book', { token_id: tokenId }));
}

/** Trades matched with a builder code (public). One page; pass next_cursor for the next ('LTE=' ends). */
function builderTrades(builderCode, { cursor = null, after = null } = {}) {
  return read('clob', CLOB, '/builder/trades', { builder_code: builderCode, ...(cursor ? { next_cursor: cursor } : {}), ...(after ? { after } : {}) });
}

/* ── Data API v2: positions, resolution ── */

/** A wallet's positions with Polymarket's own PnL figures. Follows the cursor, up to `pages`. */
async function positions(wallet, { pages = 5 } = {}) {
  const w = String(wallet).toLowerCase();
  return cached(key('positions', w), 15, async () => {
    const out = []; let cursor = null;
    for (let i = 0; i < pages; i++) {
      const page = await read('data', DATA, '/v2/positions', { user: w, ...(cursor ? { cursor } : {}) });
      out.push(...(page?.data || []));
      cursor = page?.pagination?.next_cursor || null;
      if (!cursor) return { positions: out, complete: true };
    }
    return { positions: out, complete: false };
  });
}

/** The resolution lifecycle of one condition (UMA or V2 oracle): status, was_disputed, source. Null when Polymarket has no row. */
async function resolution(conditionId) {
  const out = await cached(key('resolution', conditionId), 60, () => read('data', DATA, '/v2/resolutions', { condition: conditionId }));
  return out?.data?.[0] || null;
}

/** Whether a Deposit Wallet exists at `address` (a public relayer read). */
const deployed = address => read('relayer', RELAYER, '/deployed', { address, type: 'WALLET' });
/** The next nonce for a Deposit Wallet batch signed by `signer` (a public relayer read). */
const walletNonce = signer => read('relayer', RELAYER, '/v1/account/transactions/params', { address: signer, type: 'WALLET' });

/* ── Relayer: gasless wallet transactions, with RektBull's own Builder API key ── */

const builderConfigured = () => !!(env.polymarketBuilderApiKey && env.polymarketBuilderApiSecret && env.polymarketBuilderApiPassphrase);

/**
 * The Builder API key headers for one relayer request (docs: trading/wallets-auth, "Create New Accounts"):
 * urlsafe base64 of HMAC-SHA256(base64decode(secret), timestamp + method + path + body).
 */
function builderHeaders(method, path, body = '', now = Math.floor(Date.now() / 1000)) {
  const secret = Buffer.from(String(env.polymarketBuilderApiSecret).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const sig = crypto.createHmac('sha256', secret).update(`${now}${method}${path}${body}`).digest('base64').replace(/\+/g, '-').replace(/\//g, '_');
  return { POLY_BUILDER_API_KEY: env.polymarketBuilderApiKey, POLY_BUILDER_TIMESTAMP: String(now), POLY_BUILDER_PASSPHRASE: env.polymarketBuilderApiPassphrase, POLY_BUILDER_SIGNATURE: sig };
}

async function relayer(method, path, { params, body } = {}) {
  if (!builderConfigured()) throw new PolymarketUnavailable('relayer', 'RektBull\'s Polymarket Builder API key is not set on this server (POLYMARKET_BUILDER_API_KEY, _SECRET, _PASSPHRASE)', 503);
  // The exact bytes signed are the exact bytes sent.
  const raw = body === undefined ? '' : JSON.stringify(body);
  try {
    return await track('polymarket-relayer', async () => {
      const headers = { ...builderHeaders(method, path, raw), ...(raw ? { 'content-type': 'application/json' } : {}) };
      const res = method === 'GET'
        ? await http.get(RELAYER + path, { params, headers, timeout: 15000 })
        : await http.post(RELAYER + path, raw, { headers, timeout: 15000, transformRequest: [d => d] });
      return res.data;
    });
  } catch (err) {
    if (err.isProviderLimit) throw new PolymarketUnavailable('relayer', err.message, 503);
    throw new PolymarketUnavailable('relayer', reason(err));
  }
}

module.exports = {
  GAMMA, CLOB, DATA, RELAYER, SOURCES, http, PolymarketUnavailable,
  events, event, market, search, book, builderTrades, positions, resolution,
  relayer, builderHeaders, builderConfigured, deployed, walletNonce,
};
