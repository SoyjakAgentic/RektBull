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

// Chainstack's limits on one subscription (its docs; the same on every plan): 20 transaction filters, 200 accounts in each list.
const MAX_FILTERS = 20;
const MAX_ACCOUNTS = 200;

const asFilter = f => ({ vote: false, failed: false, accountInclude: f.accountInclude || [], accountExclude: [], accountRequired: f.accountRequired || [] });
function checkFilters(filters) {
  const names = Object.keys(filters);
  if (!names.length || names.length > MAX_FILTERS) throw new Error(`a subscription takes 1 to ${MAX_FILTERS} transaction filters (${names.length} given)`);
  for (const [k, f] of Object.entries(filters)) {
    for (const list of ['accountInclude', 'accountRequired']) if ((f[list] || []).length > MAX_ACCOUNTS) throw new Error(`filter ${k}: at most ${MAX_ACCOUNTS} accounts in ${list}`);
    if (!(f.accountInclude || []).length && !(f.accountRequired || []).length) throw new Error(`filter ${k} has no accounts (the provider refuses a filter with no condition)`);
  }
}

/**
 * Opens a named subscription: one connection carrying several named
 * transaction filters ({ name: { accountInclude, accountRequired? } }, at
 * most 20, each list at most 200 accounts). onTransaction(update.transaction,
 * filterNames) is called for each confirmed, successful transaction that
 * matches, with the names of the filters it matched. updateFilters() changes
 * them on the live connection, and every restart uses the current set.
 * Returns a stop function. Does nothing when unset.
 */
async function subscribe(name, filters, onTransaction, control = { stopped: false }) {
  if (!configured() || control.stopped) return () => {};
  if (streams.has(name)) throw new Error(`a Yellowstone stream called ${name} is already open`);
  control.filters ||= filters;
  checkFilters(control.filters);
  const status = { connected: false, started_at: Date.now(), last_message_at: null, messages: 0, transactions: 0, reconnects: 0, last_error: null, filters: Object.keys(control.filters).length };
  const entry = { status, stream: null, timer: null, request: null, control };
  streams.set(name, entry);
  try {
    const lib = loadClient();
    const Client = lib.default || lib.Client;
    const client = new Client(env.yellowstoneGrpcUrl, env.yellowstoneGrpcToken, undefined, { backoff: { initialIntervalMs: 500, multiplier: 2, maxRetries: 20 }, policy: 'NoReplay' });
    const request = {
      accounts: {}, slots: {}, transactionsStatus: {}, blocks: {}, blocksMeta: {}, entry: {}, accountsDataSlice: [],
      transactions: Object.fromEntries(Object.entries(control.filters).map(([k, f]) => [k, asFilter(f)])),
      commitment: lib.CommitmentLevel ? lib.CommitmentLevel.CONFIRMED : 1,
    };
    entry.request = request;
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
      try { onTransaction(update.transaction, update.filters || []); } catch (err) { status.last_error = `a transaction couldn't be read: ${err.message}`; }
    });
    stream.on('error', err => {
      status.connected = false;
      status.last_error = String(err.message || err).replace(/token=[^&\s]+/gi, 'token=…').slice(0, 300);
      logger.warn('yellowstone stream ended', { name, error: status.last_error });
      // The client already spent its retries: start again in a minute, from scratch.
      clearInterval(entry.timer);
      streams.delete(name);
      // Unless it was stopped meanwhile: a worker that gave up its lock must never reopen it.
      if (!control.stopped) setTimeout(() => { if (!control.stopped) subscribe(name, control.filters, onTransaction, control).catch(e => logger.warn('yellowstone restart failed', { name, error: e.message })); }, 60000).unref();
    });
    let id = 1;
    entry.timer = setInterval(() => { try { stream.write({ ...request, ping: { id: id++ } }); } catch { /* the error handler sees it */ } }, PING_MS);
    entry.timer.unref();
  } catch (err) {
    status.connected = false;
    status.last_error = String(err.message || err).slice(0, 300);
    logger.warn('yellowstone stream could not open', { name, error: status.last_error });
  }
  // Stops it for good: whichever connection is current (after a restart, not the first), and any restart still to come.
  return () => {
    control.stopped = true;
    const cur = streams.get(name);
    if (!cur) return;
    clearInterval(cur.timer);
    try { cur.stream?.end?.(); } catch { /* already closed */ }
    streams.delete(name);
  };
}

/** One filter on its own subscription (the first use: pump.fun's program). */
const subscribeTransactions = (name, filter, onTransaction, control) => subscribe(name, { [name]: filter }, onTransaction, control);

/**
 * Replaces a subscription's filters on the live connection (the client sends
 * the new request; its reconnects use it too), and for any restart to come.
 * Returns false when there's no such subscription open.
 */
function updateFilters(name, filters) {
  checkFilters(filters);
  const e = streams.get(name);
  if (!e) return false;
  e.control.filters = filters;
  e.status.filters = Object.keys(filters).length;
  if (!e.request || !e.stream) return true; // still opening: it will use them
  e.request.transactions = Object.fromEntries(Object.entries(filters).map(([k, f]) => [k, asFilter(f)]));
  e.stream.write(e.request);
  return true;
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
  // Token balances before and after, summed per owner and mint (an owner can hold a mint in several accounts).
  const sum = list => {
    const out = new Map();
    for (const b of list || []) {
      if (!b.owner || !b.mint) continue;
      const k = `${b.owner}|${b.mint}`;
      out.set(k, (out.get(k) || 0n) + BigInt(b.uiTokenAmount?.amount || '0'));
      if (b.uiTokenAmount?.decimals !== undefined) decimals.set(b.mint, b.uiTokenAmount.decimals);
    }
    return out;
  };
  const decimals = new Map();
  const pre = sum(meta.preTokenBalances);
  const post = sum(meta.postTokenBalances);
  const balances = [...new Set([...pre.keys(), ...post.keys()])].map(k => {
    const [owner, mint] = k.split('|');
    return { owner, mint, pre: pre.get(k) || 0n, post: post.get(k) || 0n, decimals: decimals.get(mint) ?? null };
  });
  // SOL balances (lamports) before and after, per account key; the signers; the fee (paid by the first signer).
  const lamports = keys.map((address, i) => ({ address, pre: BigInt(meta.preBalances?.[i] ?? 0), post: BigInt(meta.postBalances?.[i] ?? 0) }));
  const signers = keys.slice(0, msg?.header?.numRequiredSignatures || 0);
  return { signature: info.signature ? b58(info.signature) : null, slot: t.slot ?? null, keys, signers, logs: meta.logMessages || [], instructions: ix, balances, lamports, fee: BigInt(meta.fee || 0), failed: !!meta.err };
}

module.exports = {
  SOURCE, MAX_FILTERS, MAX_ACCOUNTS, configured, status, subscribe, subscribeTransactions, updateFilters, readTransaction,
  _setClient: fn => { loadClient = fn; }, _reset: () => { for (const e of streams.values()) clearInterval(e.timer); streams.clear(); },
};
