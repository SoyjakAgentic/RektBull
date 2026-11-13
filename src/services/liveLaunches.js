/**
 * The live launch feed (Trade desk, stage 1): three columns that fill in by
 * themselves, read from the launchpads' own contract events rather than a
 * refreshed list:
 *
 *   new                 tokens launched in the last hour: Clanker's TokenCreated,
 *                       Zora's CoinCreatedV4 / CreatorCoinCreated / CoinCreated and
 *                       Virtuals' Launched (its current BondingV5) on Base; four.meme's
 *                       TokenCreate on BNB Chain;
 *   close to graduating curve tokens bought in the last hour, nearest to graduating:
 *                       four.meme's TokenPurchase (how much each curve has raised),
 *                       confirmed with four.meme's helper; on Base, Virtuals' curves;
 *   just graduated      the last 24 hours: four.meme's LiquidityAdded (its curve's
 *                       money goes to PancakeSwap) and Virtuals' Graduated.
 *
 * Event layouts: Clanker's, Zora's and Virtuals' from their verified source on
 * Sourcify; four.meme's implementation isn't verified, so its events were
 * matched by signature against its logs and the results checked with its
 * helper contract (13 November 2026). See docs/LAUNCHES.md.
 *
 * How it stays cheap: each chain is read at most once every 10 seconds for
 * everyone (the result is cached, in the database too, so every instance
 * shares it), and each read asks only for the blocks since the last one. The
 * 24 hours of graduations are filled in a few chunks per read, so a cold start
 * never makes dozens of calls at once. Logs come through providers/rpc.evmLogs
 * (your own RPC_URLS_<CHAIN> first, then a keyless endpoint that answers them).
 */
const { ethers } = require('ethers');
const rpc = require('../providers/rpc');
const cache = require('../lib/cache');
const launchpads = require('./launchpads');
const discover = require('./discover');

const REFRESH_S = 10;
const NEW_WINDOW_S = 60 * 60; // new launches kept for an hour
const BUYING_WINDOW_S = 60 * 60; // a curve counts as "being bought" for an hour after its last purchase
const GRADUATED_WINDOW_S = 24 * 3600;
const STATE_TTL_S = 24 * 3600;
const SHOW = { new: 30, graduating: 10, graduated: 20 };
const FLAGGED = 6; // the newest launches get GoPlus's flags on their card (a minute-old token often has no report yet)

const ev = s => ethers.EventFragment.from(s);
const CLANKER = new ethers.Interface(['event TokenCreated(address msgSender, address indexed tokenAddress, address indexed tokenAdmin, string tokenImage, string tokenName, string tokenSymbol, string tokenMetadata, string tokenContext, int24 startingTick, address poolHook, bytes32 poolId, address pairedToken, address locker, address mevModule, uint256 extensionsSupply, address[] extensions)']);
const ZORA = new ethers.Interface([
  'event CoinCreatedV4(address indexed caller, address indexed payoutRecipient, address indexed platformReferrer, address currency, string uri, string name, string symbol, address coin, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bytes32 poolKeyHash, string version)',
  'event CreatorCoinCreated(address indexed caller, address indexed payoutRecipient, address indexed platformReferrer, address currency, string uri, string name, string symbol, address coin, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bytes32 poolKeyHash, string version)',
  'event CoinCreated(address indexed caller, address indexed payoutRecipient, address indexed platformReferrer, address currency, string uri, string name, string symbol, address coin, address pool, string version)',
]);
// Virtuals' current launchpad, BondingV5 (verified on Sourcify); its old Bonding contract has had no launches since.
const VIRTUALS = new ethers.Interface([
  'event Launched(address indexed token, address indexed pair, uint256 virtualId, uint256 initialPurchase, uint256 initialPurchasedAmount, (uint8 launchMode, uint16 airdropBips, bool needAcf, uint8 antiSniperTaxType, bool isProject60days) launchParams)',
  'event Graduated(address indexed token, address agentToken)',
]);
const FOURMEME = new ethers.Interface([
  'event TokenCreate(address creator, address token, uint256 requestId, string name, string symbol, uint256 totalSupply, uint256 launchTime, uint256 launchFee)',
  'event TokenPurchase(address token, address account, uint256 price, uint256 amount, uint256 cost, uint256 fee, uint256 offers, uint256 funds)',
  'event LiquidityAdded(address base, uint256 offers, address quote, uint256 funds)',
]);

/** Each launchpad's contract and the events read from it, with what each one means for the feed. */
const PADS = {
  base: [
    { id: 'clanker', name: 'Clanker', address: launchpads.ADDR.clanker, iface: CLANKER, events: { TokenCreated: 'new' } },
    { id: 'zora', name: 'Zora', address: launchpads.ADDR.zora, iface: ZORA, events: { CoinCreatedV4: 'new', CreatorCoinCreated: 'new', CoinCreated: 'new' } },
    { id: 'virtuals', name: 'Virtuals', address: launchpads.ADDR.bondingV5, iface: VIRTUALS, events: { Launched: 'new', Graduated: 'graduated' } },
  ],
  bsc: [
    { id: 'fourmeme', name: 'four.meme', address: launchpads.FOURMEME.tokenManager, iface: FOURMEME, events: { TokenCreate: 'new', TokenPurchase: 'buy', LiquidityAdded: 'graduated' } },
  ],
};
const CHAIN_NAMES = { base: 'Base', bsc: 'BNB Chain' };
// Blocks per eth_getLogs call: well under what a keyless endpoint answers (20,000 results at most).
const CHUNK = { base: 2000, bsc: 2000 };
const GRAD_CHUNK = { base: 20000, bsc: 10000 }; // graduation events only, so far fewer results
const GRAD_CHUNKS_PER_READ = 3;

// Refusals answer like the Launches desk's own (400, or 503 while the chain can't be read).
const { LaunchesRefused: LiveRefused } = require('./launches');

const topicsFor = (chain, kinds) => {
  const t = [];
  for (const p of PADS[chain]) for (const [name, kind] of Object.entries(p.events)) if (kinds.includes(kind)) t.push(p.iface.getEvent(name).topicHash);
  return t;
};
const addressesFor = (chain, kinds) => PADS[chain].filter(p => Object.values(p.events).some(k => kinds.includes(k))).map(p => p.address);

/** The latest block, and how many seconds a block takes on this chain (measured over the last 1,000 blocks, cached an hour). */
async function headAndPace(chain) {
  const head = await rpc.evmRpc(chain, 'eth_getBlockByNumber', ['latest', false]);
  const n = Number(head.number); const ts = Number(head.timestamp);
  const spb = await cache.cached(`launches:live:pace:${chain}`, 3600, async () => {
    const old = await rpc.evmRpc(chain, 'eth_getBlockByNumber', ['0x' + (n - 1000).toString(16), false]);
    return Math.max(0.1, (ts - Number(old.timestamp)) / 1000);
  });
  return { n, ts, spb };
}

async function logs(chain, from, to, kinds, chunk) {
  const out = [];
  for (let a = from; a <= to; a += chunk) {
    const b = Math.min(to, a + chunk - 1);
    out.push(...await rpc.evmLogs(chain, { address: addressesFor(chain, kinds), topics: [topicsFor(chain, kinds)], fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }));
  }
  return out;
}

const lower = a => String(a).toLowerCase();

/** One log, decoded into a feed item, or null if it isn't one of ours. */
function decode(chain, log, at) {
  const pad = PADS[chain].find(p => p.address === lower(log.address));
  if (!pad) return null;
  let parsed;
  try { parsed = pad.iface.parseLog(log); } catch { return null; }
  if (!parsed || !pad.events[parsed.name]) return null;
  const a = parsed.args;
  const base = { chain, launchpad: pad.id, launchpad_name: pad.name, block: Number(log.blockNumber), at, tx: log.transactionHash, key: `${log.transactionHash}:${Number(log.logIndex)}` };
  switch (parsed.name) {
    case 'TokenCreated': return { kind: 'new', ...base, token: lower(a.tokenAddress), name: a.tokenName, symbol: a.tokenSymbol, creator: lower(a.tokenAdmin) };
    case 'CoinCreatedV4': case 'CreatorCoinCreated': case 'CoinCreated': return { kind: 'new', ...base, token: lower(a.coin), name: a.name, symbol: a.symbol, creator: lower(a.caller) };
    case 'Launched': return { kind: 'new', ...base, token: lower(a.token), name: null, symbol: null, creator: null, ...(a.launchParams?.isProject60days ? { project_60_days: true } : {}) };
    case 'TokenCreate': return { kind: 'new', ...base, token: lower(a.token), name: a.name, symbol: a.symbol, creator: lower(a.creator) };
    case 'TokenPurchase': return { kind: 'buy', ...base, token: lower(a.token), funds: a.funds.toString(), offers: a.offers.toString() };
    case 'LiquidityAdded': return { kind: 'graduated', ...base, token: lower(a.base), quote: lower(a.quote), funds: a.funds.toString() };
    case 'Graduated': return { kind: 'graduated', ...base, token: lower(a.token), agent_token: lower(a.agentToken) };
    default: return null;
  }
}

/** Reads the blocks since the last read into the kept state, and a little more of the graduation history. */
async function advance(chain, state) {
  const { n, ts, spb } = await headAndPace(chain);
  const at = block => new Date((ts - (n - block) * spb) * 1000).toISOString();
  const newBlocks = Math.ceil(NEW_WINDOW_S / spb);
  const st = state && state.head ? state : { head: n - newBlocks, launches: [], graduated: [], buying: {}, grad_from: n - newBlocks + 1, started_at: new Date().toISOString() };
  const from = Math.max(st.head + 1, n - newBlocks + 1); // a gap longer than the window starts the window afresh
  // After such a gap, the graduations in it haven't been read: read back from here again (what's already listed isn't listed twice).
  if (from > st.head + 1) st.grad_from = from;
  const seen = new Set([...st.launches, ...st.graduated].map(i => i.key));
  if (from <= n) {
    for (const log of await logs(chain, from, n, ['new', 'buy', 'graduated'], CHUNK[chain])) {
      const item = decode(chain, log, at(Number(log.blockNumber)));
      if (!item || seen.has(item.key)) continue;
      seen.add(item.key);
      if (item.kind === 'new') st.launches.push(item);
      if (item.kind === 'graduated') st.graduated.push(item);
      if (item.kind === 'buy') st.buying[item.token] = { funds: item.funds, offers: item.offers, at: item.at, block: item.block };
    }
  }
  // Graduations are rare: read back to 24 hours a few chunks at a time.
  const gradTarget = n - Math.ceil(GRADUATED_WINDOW_S / spb);
  for (let k = 0; k < GRAD_CHUNKS_PER_READ && st.grad_from > gradTarget; k++) {
    const to = st.grad_from - 1;
    const a = Math.max(gradTarget, to - GRAD_CHUNK[chain] + 1);
    for (const log of await logs(chain, a, to, ['graduated'], GRAD_CHUNK[chain])) {
      const item = decode(chain, log, at(Number(log.blockNumber)));
      if (item && !seen.has(item.key)) { seen.add(item.key); st.graduated.push(item); }
    }
    st.grad_from = a;
  }
  // Keep only what's shown: the last hour of launches and purchases, 24 hours of graduations (counted in blocks, the chain's own clock).
  const since = s => n - Math.ceil(s / spb);
  st.launches = st.launches.filter(i => i.block > since(NEW_WINDOW_S)).sort((a, b) => b.block - a.block).slice(0, 200);
  st.graduated = st.graduated.filter(i => i.block > since(GRADUATED_WINDOW_S)).sort((a, b) => b.block - a.block).slice(0, 100);
  st.buying = Object.fromEntries(Object.entries(st.buying).filter(([, b]) => b.block > since(BUYING_WINDOW_S)).sort((a, b) => b[1].block - a[1].block).slice(0, 300));
  st.head = n;
  st.read_at = new Date().toISOString();
  st.graduated_hours = Math.round(Math.min(GRADUATED_WINDOW_S, (n - st.grad_from) * spb) / 360) / 10;
  return st;
}

const SYMBOL = new ethers.Interface(['function symbol() view returns (string)', 'function name() view returns (string)']);
/** A token's symbol and name, read from it once (cached a day). */
function tokenNames(chain, token) {
  return cache.cached(`launches:live:names:${chain}:${token}`, 86400, async () => {
    const read = async fn => { try { return SYMBOL.decodeFunctionResult(fn, await rpc.evmRpc(chain, 'eth_call', [{ to: token, data: SYMBOL.encodeFunctionData(fn) }, 'latest']))[0]; } catch { return null; } };
    const [symbol, name] = await Promise.all([read('symbol'), read('name')]);
    return { symbol, name };
  });
}

/** Curves nearest to graduating. four.meme: the curves bought in the last hour that have raised most, confirmed with its helper. */
async function graduating(chain, st) {
  if (chain === 'bsc') {
    const top = Object.entries(st.buying).sort((a, b) => (BigInt(b[1].funds) > BigInt(a[1].funds) ? 1 : -1)).slice(0, 15);
    const rows = await Promise.all(top.map(async ([token, b]) => {
      const c = await launchpads.fourMemeCurve(token).catch(() => null); // cached 2 minutes per token
      if (!c || c.state !== 'curve' || !c.curve) return null;
      const names = await tokenNames(chain, token);
      return { token, symbol: names.symbol, name: names.name, launchpad: 'fourmeme', launchpad_name: 'four.meme', progress_pct: c.curve.progress_pct, in_curve: c.curve.in_curve, symbol_in_curve: c.curve.in_curve_symbol, last_buy_at: b.at, tradable: c.quote === 'bnb' };
    }));
    return { items: rows.filter(Boolean).sort((a, b) => b.progress_pct - a.progress_pct).slice(0, SHOW.graduating), source: 'four.meme\'s TokenPurchase events in the last hour, each curve\'s progress read from its helper contract (getTokenInfo)' };
  }
  const list = await launchpads.newestOnCurve().catch(() => []);
  return {
    items: list.map(t => ({ token: t.token, symbol: t.ticker, name: null, launchpad: 'virtuals', launchpad_name: 'Virtuals', progress_pct: t.curve.progress_pct, in_curve: t.curve.in_curve, symbol_in_curve: t.curve.in_curve_symbol, tradable: true }))
      .sort((a, b) => b.progress_pct - a.progress_pct).slice(0, SHOW.graduating),
    source: 'Virtuals\' BondingV5 contract (the newest tokens still on its curve)',
  };
}

const inflight = new Map();

/** Reads the chain (at most once every 10 seconds for everyone) and keeps what it found. */
function refresh(chain) {
  return cache.cached(`launches:live:read:${chain}`, REFRESH_S, async () => {
    const stateKey = `launches:live:state:${chain}`;
    const before = await cache.get(stateKey);
    try {
      const st = await advance(chain, before);
      await cache.set(stateKey, st, STATE_TTL_S);
      return { state: st };
    } catch (err) {
      // The last good read stands, marked with why it couldn't be updated.
      return { state: before || null, not_checked: `the launchpads' events couldn't be read just now: ${err.message}` };
    }
  });
}

/** GoPlus's flags for a launch's card, kept 5 minutes even when GoPlus has no report yet (so it isn't asked on every read). */
const flagsFor = (chain, token) => cache.cached(`launches:live:flags:${chain}:${token}`, 300, () => discover.flags({ chain, token }));

/** The three live columns for a chain (the same answer for everyone for 5 seconds). */
async function live({ chain = 'base' } = {}) {
  chain = String(chain).toLowerCase();
  if (!PADS[chain]) throw new LiveRefused(`The live feed reads the launchpads on ${Object.values(CHAIN_NAMES).join(' and ')}: chain must be one of ${Object.keys(PADS).join(', ')}.`);
  return cache.cached(`launches:live:view:${chain}`, 5, () => view(chain));
}

async function view(chain) {
  if (!inflight.has(chain)) inflight.set(chain, refresh(chain).finally(() => inflight.delete(chain)));
  const { state: st, not_checked: notChecked } = await inflight.get(chain);
  if (!st) throw new LiveRefused(notChecked || 'The live feed isn\'t ready yet; try again in a few seconds.', 503);

  // Names the events didn't carry (Virtuals' Launched), read from the token itself.
  const fresh = await Promise.all(st.launches.slice(0, SHOW.new).map(async (i, k) => ({
    ...i, ...(i.symbol ? {} : await tokenNames(chain, i.token)),
    ...(k < FLAGGED ? { flags: await flagsFor(chain, i.token) } : {}),
  })));
  const grads = await Promise.all(st.graduated.slice(0, SHOW.graduated).map(async i => ({ ...i, ...(await tokenNames(chain, i.token)) })));
  const near = await graduating(chain, st).catch(err => ({ items: [], not_checked: `couldn't be read: ${err.message}` }));
  const names = PADS[chain].map(p => p.name);
  return {
    chain, chain_name: CHAIN_NAMES[chain], read_at: st.read_at, head_block: st.head, refresh_seconds: REFRESH_S,
    ...(notChecked ? { not_checked: notChecked } : {}),
    columns: {
      new: { items: fresh, source: `${names.join(', ')}: their contracts' launch events on ${CHAIN_NAMES[chain]}, read every ${REFRESH_S} seconds` },
      graduating: near,
      graduated: { items: grads, hours_covered: st.graduated_hours, source: chain === 'bsc' ? 'four.meme\'s LiquidityAdded events (its curve\'s money goes to PancakeSwap)' : 'Virtuals\' Graduated events. Clanker and Zora coins trade on Uniswap from launch, so they never graduate' },
    },
    note: 'Most new tokens go to zero, and many are scams. Nothing here is a recommendation or financial advice. A buy runs RektBull\'s full token check and the bundle check first.',
  };
}

module.exports = { live, decode, advance, LiveRefused, PADS, REFRESH_S, NEW_WINDOW_S, GRADUATED_WINDOW_S };
