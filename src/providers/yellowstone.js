/**
 * Solana's Yellowstone gRPC ("Geyser") stream: transactions pushed to RektBull
 * as the chain confirms them, filtered at the source, instead of RektBull
 * polling for them. Yellowstone is a standard several providers run
 * (Chainstack, Triton, Helius, QuickNode); the owner chose Chainstack's
 * add-on (23 November 2026). Switching provider is two settings:
 *
 *   YELLOWSTONE_GRPC_URL    the provider's gRPC endpoint (https://…:443)
 *   YELLOWSTONE_GRPC_TOKEN  its access token (a secret: the environment's
 *                           secret settings, never the repo, chat or an issue)
 *
 * Unset, nothing connects and every feature that would use it reads as it
 * did before (GeckoTerminal and RPC polling), saying which it used.
 *
 * One stream per subscriber, opened only by the worker (src/server.js), which
 * keeps what it learns in the shared cache for the web role to read. The
 * client reconnects by itself (subscribeWithReconnect, no replay: what
 * happened during an outage is filled in by the polling fallback). Each
 * connection goes through usage.track('yellowstone'), so the admin panel's
 * External services tab shows it; status() says whether it's live.
 */
const env = require('../config/env');
const logger = require('../config/logger');
const { track } = require('./usage');

const SOURCE = 'Solana\'s Yellowstone gRPC stream';
const PING_MS = 15000; // some load balancers drop a quiet stream; a ping keeps it open
const STALE_MS = 60000; // no message for a minute: treated as down until one comes

let loadClient = () => require('@triton-one/yellowstone-grpc');
const streams = new Map(); // name -> { status, stream, timer }

const configured = () => !!(env.yellowstoneGrpcUrl && env.yellowstoneGrpcToken);

/** What the admin panel and the features show: whether it's set up, live, and the last error. */
function status(name) {
  if (!configured()) return { configured: false, live: false, why: 'YELLOWSTONE_GRPC_URL and YELLOWSTONE_GRPC_TOKEN aren\'t set' };
  const s = streams.get(name)?.status;
  if (!s) return { configured: true, live: false, why: 'not started (it runs in the worker)' };
  const live = s.connected && s.last_message_at && Date.now() - s.last_message_at < STALE_MS;
  return { configured: true, live: !!live, ...s, ...(live ? {} : { why: s.last_error || 'no messages in the last minute' }) };
}

/**
 * Opens a named transaction stream. filter: { accountInclude, accountRequired? }.
 * onTransaction(update.transaction) is called for each confirmed, successful
 * transaction that matches. Returns a stop function. Does nothing when unset.
 */
async function subscribeTransactions(name, filter, onTransaction) {
  if (!configured()) return () => {};
  if (streams.has(name)) throw new Error(`a Yellowstone stream called ${name} is already open`);
  const status = { connected: false, started_at: Date.now(), last_message_at: null, messages: 0, transactions: 0, reconnects: 0, last_error: null };
  const entry = { status, stream: null, timer: null };
  streams.set(name, entry);
  try {
    const lib = loadClient();
    const Client = lib.default || lib.Client;
    const client = new Client(env.yellowstoneGrpcUrl, env.yellowstoneGrpcToken, undefined, { backoff: { initialIntervalMs: 500, multiplier: 2, maxRetries: 20 }, policy: 'NoReplay' });
    const request = {
      accounts: {}, slots: {}, transactionsStatus: {}, blocks: {}, blocksMeta: {}, entry: {}, accountsDataSlice: [],
      transactions: { [name]: { vote: false, failed: false, accountInclude: filter.accountInclude || [], accountExclude: [], accountRequired: filter.accountRequired || [] } },
      commitment: lib.CommitmentLevel ? lib.CommitmentLevel.CONFIRMED : 1,
    };
    await track('yellowstone', () => client.connect());
    const stream = await client.subscribeWithReconnect(request);
    entry.stream = stream;
    status.connected = true;
    stream.on('data', event => {
      status.last_message_at = Date.now();
      status.messages++;
      if (event.type === 'Disconnected') { status.reconnects++; return; }
      const update = event.type === 'Update' ? event.update : event;
      if (!update?.transaction?.transaction) return;
      status.transactions++;
      try { onTransaction(update.transaction); } catch (err) { status.last_error = `a transaction couldn't be read: ${err.message}`; }
    });
    stream.on('error', err => {
      status.connected = false;
      status.last_error = String(err.message || err).replace(/token=[^&\s]+/gi, 'token=…').slice(0, 300);
      logger.warn('yellowstone stream ended', { name, error: status.last_error });
      // The client already spent its retries: start again in a minute, from scratch.
      clearInterval(entry.timer);
      streams.delete(name);
      setTimeout(() => subscribeTransactions(name, filter, onTransaction).catch(e => logger.warn('yellowstone restart failed', { name, error: e.message })), 60000).unref();
    });
    let id = 1;
    entry.timer = setInterval(() => { try { stream.write({ ...request, ping: { id: id++ } }); } catch { /* the error handler sees it */ } }, PING_MS);
    entry.timer.unref();
  } catch (err) {
    status.connected = false;
    status.last_error = String(err.message || err).slice(0, 300);
    logger.warn('yellowstone stream could not open', { name, error: status.last_error });
  }
  return () => {
    clearInterval(entry.timer);
    try { entry.stream?.end?.(); } catch { /* already closed */ }
    streams.delete(name);
  };
}

/* ── reading a transaction update (the client's protobuf shapes) ── */

const { getAddressDecoder, getBase58Decoder } = require('@solana/kit');
// Account keys are 32 bytes (an address); a signature is 64 (plain base58).
const b58 = b => (typeof b === 'string' ? b : b.length === 32 ? getAddressDecoder().decode(Uint8Array.from(b)) : getBase58Decoder().decode(Uint8Array.from(b)));

/**
 * A transaction update in plain terms: its signature, every account key (the
 * message's, then the address-table ones the meta loaded), its log lines, and
 * every instruction (top-level and inner) as { program, data }.
 */
function readTransaction(t) {
  const info = t.transaction || t;
  const msg = info.transaction?.message;
  const meta = info.meta || {};
  const keys = [...(msg?.accountKeys || []), ...(meta.loadedWritableAddresses || []), ...(meta.loadedReadonlyAddresses || [])].map(b58);
  const ix = [];
  for (const i of msg?.instructions || []) ix.push({ program: keys[i.programIdIndex], data: Buffer.from(i.data || []) });
  for (const group of meta.innerInstructions || []) for (const i of group.instructions || []) ix.push({ program: keys[i.programIdIndex], data: Buffer.from(i.data || []) });
  return { signature: info.signature ? b58(info.signature) : null, slot: t.slot ?? null, keys, logs: meta.logMessages || [], instructions: ix, failed: !!meta.err };
}

module.exports = {
  SOURCE, configured, status, subscribeTransactions, readTransaction,
  _setClient: fn => { loadClient = fn; }, _reset: () => { for (const e of streams.values()) clearInterval(e.timer); streams.clear(); },
};
