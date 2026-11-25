/**
 * Private submission of the executors' fills (docs/PRIVATE_SEND.md): a signed
 * fill sent where bots watching the public mempool can't see it and trade
 * around it (a "sandwich", which pushes a fill down to the user's floor).
 *
 *   - BNB Chain: privacy RPCs that hand transactions to block builders
 *     without broadcasting them (MEME_PRIVATE_SEND; by default 48 Club's and
 *     BlockRazor's "full privacy" mode, both listed as free by BNB Chain's MEV
 *     guide). The same signed transaction goes to each; only one can land.
 *   - Solana: Jito's sendTransaction with bundleOnly=true (SOLANA_JITO_URL), a
 *     single-transaction bundle that runs whole or not at all, with a tip to a
 *     Jito tip account in the same transaction, paid by RektBull's executor.
 *   - Base: none by default. Its sequencer orders transactions and there is no
 *     public mempool to watch.
 *
 * Never a reason for an exit to wait: if every relay refuses, the order
 * services send the same transaction the usual way at once, and one that
 * hasn't landed within PRIVATE_SEND_GRACE_MS is sent the usual way too. It's
 * the same signed transaction (same hash, same nonce or blockhash), so it can
 * only land once. Every call is counted (usage.track).
 */
const axios = require('axios');
const env = require('../config/env');
const { track } = require('../providers/usage');
const { cached } = require('../lib/cache');
const logger = require('../config/logger');

let transport = async (url, body, timeout) => (await axios.post(url, body, { timeout })).data;
let get = async (url, timeout) => (await axios.get(url, { timeout })).data;

const host = url => { try { return new URL(url).hostname; } catch { return 'relay'; } };
const NAMES = { 'rpc.48.club': '48 Club', 'bsc.blockrazor.xyz': 'BlockRazor' };
/** A relay's name for users and logs ("48 Club"), from its URL. */
const relayName = url => NAMES[host(url)] || host(url);

/** The privacy relays for an EVM chain ([] when none). */
function relays(chain) {
  return [].concat(env.memePrivateSend?.[chain] || []).filter(u => /^https:\/\//.test(u));
}

const graceMs = () => env.privateSendGraceMs;

/**
 * A signed EVM transaction to every privacy relay for its chain, at once:
 * { accepted: [names], refused: [{ relay, error }] }. A relay that answers
 * "already known" accepted it earlier.
 */
async function sendEvm(chain, raw) {
  const list = relays(chain);
  const results = await Promise.all(list.map(async url => {
    try {
      const data = await track(`private-send:${host(url)}`, () => transport(url, { jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }, 5000));
      if (data?.error && !/already known|known transaction/i.test(data.error.message || '')) throw new Error(data.error.message || 'refused');
      return { ok: true, relay: relayName(url) };
    } catch (err) {
      return { ok: false, relay: relayName(url), error: (err.response?.status ? `HTTP ${err.response.status}` : err.message || String(err)).slice(0, 200) };
    }
  }));
  const accepted = results.filter(r => r.ok).map(r => r.relay);
  const refused = results.filter(r => !r.ok).map(({ relay, error }) => ({ relay, error }));
  if (refused.length) logger.warn('private send: a relay refused a fill', { chain, refused });
  return { accepted, refused };
}

/* ── Jito (Solana) ── */

const jitoUrl = () => (env.solanaJitoUrl || '').replace(/\/+$/, '');
const JITO_MIN_TIP = 1000; // lamports: Jito's minimum for a bundle
let lastJitoSend = 0;

/** Jito's tip accounts (8), from the block engine, kept a day. Never in a lookup table (Jito's rule). */
async function tipAccounts() {
  return cached('jito:tip_accounts', 86_400, async () => {
    const data = await track('jito', () => transport(`${jitoUrl()}/api/v1/getTipAccounts`, { jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }, 5000));
    const list = [].concat(data?.result || []).filter(a => typeof a === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a));
    if (!list.length) throw new Error('Jito gave no tip accounts');
    return list;
  });
}

/**
 * The tip for a fill, in lamports: what bundles that landed lately paid (Jito's tip floor, kept a minute), the 75th
 * percentile for an exit that must land (a stop-loss, a Meme Watch exit), else the 50th; at least Jito's minimum,
 * at most SOLANA_JITO_TIP_MAX_LAMPORTS.
 */
async function tipLamports(urgent) {
  const max = Math.max(JITO_MIN_TIP, env.solanaJitoTipMaxLamports);
  let floor = null;
  try {
    floor = await cached('jito:tip_floor', 60, async () => {
      const data = await track('jito', () => get('https://bundles.jito.wtf/api/v1/bundles/tip_floor', 5000));
      const row = [].concat(data || [])[0] || {};
      return { p50: Number(row.landed_tips_50th_percentile), p75: Number(row.landed_tips_75th_percentile) };
    });
  } catch (err) {
    logger.warn('private send: Jito\'s tip floor not read', { error: err.message });
  }
  const sol = urgent ? floor?.p75 : floor?.p50;
  // Jito gives these in SOL (e.g. 0.00001); anything unreadable is the minimum.
  const lamports = Number.isFinite(sol) && sol > 0 ? Math.ceil(sol * 1e9) : JITO_MIN_TIP;
  return Math.min(max, Math.max(JITO_MIN_TIP, lamports));
}

/** Whether Solana fills go through Jito. */
const jitoOn = () => !!jitoUrl();

/**
 * A signed Solana transaction (base64, with its tip in it) to Jito as a single-transaction bundle: { ok, error }.
 * Jito allows one request a second from an address, so sends are spaced.
 */
async function sendJito(wire) {
  const wait = lastJitoSend + 1100 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastJitoSend = Date.now();
  try {
    const data = await track('jito', () => transport(`${jitoUrl()}/api/v1/transactions?bundleOnly=true`, { jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [wire, { encoding: 'base64' }] }, 5000));
    if (data?.error) throw new Error(data.error.message || 'refused');
    return { ok: true };
  } catch (err) {
    const error = (err.response?.status ? `HTTP ${err.response.status}` : err.message || String(err)).slice(0, 200);
    logger.warn('private send: Jito refused a fill', { error });
    return { ok: false, error };
  }
}

module.exports = {
  relays, relayName, sendEvm, graceMs, jitoOn, tipAccounts, tipLamports, sendJito, JITO_MIN_TIP,
  _setTransport: (post, getter) => { transport = post; if (getter) get = getter; lastJitoSend = 0; },
};
