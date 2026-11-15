/**
 * The live launch feed on Solana (Trade desk, stage 2): pump.fun's new coins,
 * the curves nearest to graduating, and the coins that just graduated to
 * PumpSwap. The same three columns as on Base and BNB Chain
 * (liveLaunches.js), read differently, because reading pump.fun's own events
 * would mean fetching thousands of transactions a minute:
 *
 *   new                 GeckoTerminal's newest pools on Solana (two pages, every
 *                       20 seconds), the ones on pump.fun's curve priced in SOL
 *                       (its "pump-fun" dex: the pool's address is the coin's
 *                       bonding curve);
 *   nearest to graduating  the busiest pump.fun curves (GeckoTerminal, by
 *                       transactions in 24 hours) and the new ones, each curve
 *                       read from the chain in one call: how much of the 793.1
 *                       million tokens for sale is sold (pump.fun's Global
 *                       account sets that figure, read once a day);
 *   just graduated      new and busy PumpSwap pools whose coin's pump.fun curve
 *                       the chain shows as complete.
 *
 * Each card of the newest launches also carries what the mint itself says: a
 * freeze or mint authority still set (read from the chain in one call).
 *
 * The cost: two GeckoTerminal calls every 20 seconds and two more a minute
 * (its free plan allows about 30 a minute), and two RPC calls every 20
 * seconds (about 260,000 a month on RPC_URLS_SOLANA, for everyone at once:
 * the read is shared, through the cache, by every visitor and instance).
 */
const k = require('@solana/kit');
const rpc = require('../providers/rpc');
const gt = require('../providers/geckoterminal');
const cache = require('../lib/cache');

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const GLOBAL = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';
const REFRESH_S = 20;
const NEW_WINDOW_S = 60 * 60;
const GRADUATED_WINDOW_S = 24 * 3600;
const STATE_TTL_S = 24 * 3600;
const PAGES = 2; // 40 of the newest pools on Solana per read
const SHOW = { new: 30, graduating: 10, graduated: 20 };
const FLAGGED = 6;
const MAX_CURVES = 100; // getMultipleAccounts reads at most 100 accounts at once

/** pump.fun's Global account: how many tokens each curve has for sale (offset 89; the layout read from its account, 15 November 2026). */
function pumpGlobal() {
  return cache.cached('launches:solana:pump-global', 86400, async () => {
    const r = await rpc.solanaRpc('getAccountInfo', [GLOBAL, { encoding: 'base64' }]);
    const v = r?.value;
    if (!v || v.owner !== PUMP) throw new Error('pump.fun\'s Global account couldn\'t be read');
    const b = Buffer.from(v.data[0], 'base64');
    return { initial_real_token_reserves: b.readBigUInt64LE(89).toString(), fee_bps: Number(b.readBigUInt64LE(105)) };
  });
}

/** A bonding curve account: [discriminator, virtual token, virtual SOL, real token, real SOL, supply, complete, …]. */
function decodeCurve(v) {
  if (!v || v.owner !== PUMP) return null;
  const b = Buffer.from(v.data[0], 'base64');
  if (b.length < 49) return null;
  return { real_token: b.readBigUInt64LE(24), real_sol: b.readBigUInt64LE(32), complete: b[48] === 1 };
}

/** The bonding curve's address for a pump.fun coin. */
async function curveOf(mint) {
  const [pda] = await k.getProgramDerivedAddress({ programAddress: k.address(PUMP), seeds: [new TextEncoder().encode('bonding-curve'), k.getAddressEncoder().encode(k.address(mint))] });
  return pda;
}

/** Many accounts in calls of 100. */
async function accounts(addresses, encoding = 'base64') {
  const out = [];
  for (let i = 0; i < addresses.length; i += MAX_CURVES) {
    const r = await rpc.solanaRpc('getMultipleAccounts', [addresses.slice(i, i + MAX_CURVES), { encoding }]);
    out.push(...(r?.value || []));
  }
  return out;
}

const isMint = a => typeof a === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
// pump.fun also runs curves priced in other tokens (USDC, other coins): the feed keeps to the ones priced in SOL,
// whose progress and SOL raised it can read the same way.
const inSol = p => p.quote === 'SOL';
const item = (kind, p, extra = {}) => ({
  kind, chain: 'solana', launchpad: 'pumpfun', launchpad_name: kind === 'graduated' ? 'pump.fun → PumpSwap' : 'pump.fun',
  token: p.token.address, symbol: p.token.symbol, name: p.token.name, at: p.created_at, key: p.pool, pool: p.pool, ...extra,
});

/** Reads the newest pools into the kept state: new pump.fun curves, and PumpSwap pools whose curve is complete. */
async function advance(state) {
  const st = state && state.started_at ? state : { launches: [], graduated: [], started_at: new Date().toISOString() };
  const seen = new Set([...st.launches, ...st.graduated].map(i => i.key));
  const pools = [];
  for (let page = 1; page <= PAGES; page++) pools.push(...await gt.newPoolsPage('solana', page)); // one after the other: GeckoTerminal's free plan
  // Busy PumpSwap pools opened in the last day: graduations from before the feed started.
  const busy = await gt.dexPools('solana', 'pumpswap').catch(() => []);
  const now = Date.now();
  const within = (p, s) => p.created_at && now - Date.parse(p.created_at) < s * 1000;
  for (const p of pools) {
    if (p.dex === 'pump-fun' && inSol(p) && isMint(p.token.address) && !seen.has(p.pool) && within(p, NEW_WINDOW_S)) { seen.add(p.pool); st.launches.push(item('new', p)); }
  }
  const candidates = [...pools, ...busy].filter(p => p.dex === 'pumpswap' && isMint(p.token.address) && !seen.has(p.pool) && within(p, GRADUATED_WINDOW_S));
  if (candidates.length) {
    const curves = await accounts(await Promise.all(candidates.map(p => curveOf(p.token.address))));
    candidates.forEach((p, n) => {
      const c = decodeCurve(curves[n]);
      if (c && c.complete && !seen.has(p.pool)) { seen.add(p.pool); st.graduated.push(item('graduated', p)); }
    });
  }
  const after = s => i => now - Date.parse(i.at) < s * 1000;
  st.launches = st.launches.filter(after(NEW_WINDOW_S)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 200);
  st.graduated = st.graduated.filter(after(GRADUATED_WINDOW_S)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 100);
  st.read_at = new Date().toISOString();
  return st;
}

/** The curves nearest to graduating, from the busiest pump.fun pools and the new ones, each read from the chain. */
async function graduating(st) {
  const busy = await gt.dexPools('solana', 'pump-fun').catch(() => []);
  const byPool = new Map();
  for (const p of [...busy.filter(inSol).map(b => item('near', b)), ...st.launches]) if (isMint(p.token) && !byPool.has(p.pool)) byPool.set(p.pool, p);
  const list = [...byPool.values()].slice(0, MAX_CURVES);
  const [g, curves] = await Promise.all([pumpGlobal(), accounts(list.map(p => p.pool))]);
  const initial = BigInt(g.initial_real_token_reserves);
  const rows = list.map((p, n) => {
    const c = decodeCurve(curves[n]);
    if (!c || c.complete || initial === 0n) return null;
    const sold = initial > c.real_token ? initial - c.real_token : 0n;
    return { token: p.token, symbol: p.symbol, name: p.name, launchpad: 'pumpfun', launchpad_name: 'pump.fun', progress_pct: Number(sold * 1000n / initial) / 10, in_curve: Number(c.real_sol) / 1e9, symbol_in_curve: 'SOL', tradable: true };
  }).filter(Boolean);
  return {
    items: rows.sort((a, b) => b.progress_pct - a.progress_pct).slice(0, SHOW.graduating),
    source: `the busiest pump.fun curves (GeckoTerminal) and the newest ones, each curve read from the chain: how much of its ${(Number(initial) / 1e12).toFixed(1)} million tokens for sale is sold (pump.fun's Global account)`,
  };
}

/** What the newest coins' mints say: a freeze or mint authority still set. In the same shape as GoPlus's card flags. */
async function mintFlags(tokens) {
  if (!tokens.length) return {};
  const got = await accounts(tokens, 'jsonParsed').catch(() => null);
  if (!got) return Object.fromEntries(tokens.map(t => [t, { not_checked: 'the mint couldn\'t be read' }]));
  return Object.fromEntries(tokens.map((t, n) => {
    const info = got[n]?.data?.parsed?.info;
    if (!info) return [t, { not_checked: 'not a mint' }];
    const flags = [];
    if (info.freezeAuthority) flags.push({ level: 'bad', text: 'Its issuer can freeze any holder\'s tokens', source: 'Solana RPC (the mint)' });
    if (info.mintAuthority) flags.push({ level: 'warn', text: 'More can be minted', source: 'Solana RPC (the mint)' });
    if (!flags.length) flags.push({ level: 'ok', text: 'No mint or freeze authority left', source: 'Solana RPC (the mint)' });
    return [t, { flags, source: 'Solana RPC (the mint)' }];
  }));
}

/** Reads (at most once every 20 seconds for everyone) and keeps what it found. */
function refresh() {
  return cache.cached('launches:live:read:solana', REFRESH_S, async () => {
    const stateKey = 'launches:live:state:solana';
    const before = await cache.get(stateKey);
    try {
      const st = await advance(before);
      await cache.set(stateKey, st, STATE_TTL_S);
      return { state: st };
    } catch (err) {
      return { state: before || null, not_checked: `the newest pools couldn't be read just now: ${err.message}` };
    }
  });
}

let inflight = null;

async function view() {
  if (!inflight) inflight = refresh().finally(() => { inflight = null; });
  const { state: st, not_checked: notChecked } = await inflight;
  const { LaunchesRefused } = require('./launches');
  if (!st) throw new LaunchesRefused(notChecked || 'The live feed isn\'t ready yet; try again in a few seconds.', 503);
  const newest = st.launches.slice(0, SHOW.new);
  const flags = await cache.cached(`launches:live:solana:flags:${newest.slice(0, FLAGGED).map(i => i.token).join(',')}`, 300, () => mintFlags(newest.slice(0, FLAGGED).map(i => i.token)));
  const near = await graduating(st).catch(err => ({ items: [], not_checked: `couldn't be read: ${err.message}` }));
  const hours = Math.min(24, (Date.now() - Date.parse(st.started_at)) / 3600000);
  return {
    chain: 'solana', chain_name: 'Solana', read_at: st.read_at, refresh_seconds: REFRESH_S,
    ...(notChecked ? { not_checked: notChecked } : {}),
    columns: {
      new: { items: newest.map((i, n) => (n < FLAGGED ? { ...i, flags: flags[i.token] } : i)), source: `pump.fun's new coins, from GeckoTerminal's newest pools on Solana, read every ${REFRESH_S} seconds` },
      graduating: near,
      // Busy PumpSwap pools of the last day fill this in from the start; quieter ones only from when the feed started reading.
      graduated: { items: st.graduated.slice(0, SHOW.graduated), hours_covered: Math.max(1, Math.round(hours * 10) / 10), source: 'PumpSwap pools (GeckoTerminal: the newest, and the busiest of the last day) whose coin\'s pump.fun curve the chain shows as complete' },
    },
    note: 'Most new tokens go to zero, and many are scams. Nothing here is a recommendation or financial advice. A buy runs RektBull\'s full token check and the bundle check first.',
  };
}

const live = () => cache.cached('launches:live:view:solana', 5, view);

module.exports = { live, advance, graduating, mintFlags, decodeCurve, curveOf, pumpGlobal, REFRESH_S, PUMP };
