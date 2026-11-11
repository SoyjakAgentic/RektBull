/**
 * The Launches desk: new tokens on Base, Ethereum, Arbitrum and BNB Chain, each with the
 * checks RektBull already has, and trading through the Trade desk (the
 * user's wallet signs; 0x routes the trade, 1% fee).
 *
 * - feed(): the newest pools (GeckoTerminal), with the warning signs their
 *   own market data shows and GoPlus's flags for the newest few (both free;
 *   cached). Nothing in the feed is a recommendation.
 * - forTrade(): what a buy of a young token adds to the Trade desk's checks:
 *   Launch Safety's bundle and insider check (free inside a trade: the 1%
 *   fee pays for it). A critical bundle finding stops the buy; a high one
 *   needs the buyer to confirm they've read it.
 *
 * - Launchpads (services/launchpads.js): each token's launchpad (Clanker,
 *   Zora, Virtuals on Base; four.meme on BNB Chain) read from the launchpad's
 *   own contract, and the newest tokens still on Virtuals' and four.meme's
 *   bonding curves, traded on those curves. pump.fun comes in a later phase.
 */
const { cached } = require('../lib/cache');
const gt = require('../providers/geckoterminal');
const dexscreener = require('../providers/dexscreener');
const discover = require('./discover');
const launchpads = require('./launchpads');

class LaunchesRefused extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const CHAINS = ['base', 'ethereum', 'arbitrum', 'bsc'];
const NAMES = { base: 'Base', ethereum: 'Ethereum', arbitrum: 'Arbitrum', bsc: 'BNB Chain' };
/** Chains whose launchpads RektBull reads, and what it reads there. */
const PAD_CHAINS = { base: 'Clanker\'s, Zora\'s and Virtuals\' contracts', bsc: 'four.meme\'s contract' };
/** A token is "young" for the extra launch checks while its first pool is under this old. */
const YOUNG_HOURS = 7 * 24;
/** GoPlus's free plan answers one token a call: the feed checks the newest few, cached for 6 hours. */
const FLAGGED_IN_FEED = 8;
const EXCHANGES = { 'uniswap-v4': 'Uniswap v4', 'uniswap-v3': 'Uniswap v3', 'uniswap-v2': 'Uniswap v2', uniswap_v2: 'Uniswap v2', uniswap_v3: 'Uniswap v3', aerodrome: 'Aerodrome', sushiswap: 'SushiSwap', pancakeswap: 'PancakeSwap' };
const exchangeName = id => {
  const s = String(id || '');
  const hit = Object.keys(EXCHANGES).find(k => s.startsWith(k));
  return hit ? EXCHANGES[hit] : s.replace(/[-_](base|ethereum|arbitrum|eth|bsc)$/i, '').replace(/[-_]/g, ' ');
};

function parse(q = {}) {
  const chain = String(q.chain || 'base').toLowerCase();
  if (!CHAINS.includes(chain)) return { error: `chain must be one of: ${CHAINS.join(', ')}.` };
  return { chain };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch(err => ({ not_checked: err.message })); }
  }));
  return out;
}

/** The newest tokens on a chain, newest first, with their warning signs. */
async function feed({ chain = 'base' } = {}) {
  let list;
  try { list = await discover.tokens({ list: 'new', chain }); } catch (err) {
    throw new LaunchesRefused(err.message, err.status || 503);
  }
  const rows = list.tokens
    .filter(t => t.token.address)
    .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0))
    .map(t => ({
      chain, token: t.token.address.toLowerCase(), symbol: t.token.symbol, name: t.token.name,
      pool: t.pool, exchange: exchangeName(t.dex), quote: t.quote,
      created_at: t.created_at, price_usd: t.price_usd, liquidity_usd: t.liquidity_usd, volume_24h_usd: t.volume_24h_usd,
      market_cap_usd: t.market_cap_usd ?? t.fdv_usd, change_1h_pct: t.change_1h_pct, buys_24h: t.buys_24h, sells_24h: t.sells_24h,
      signals: t.signals,
    }));
  const [flags, pads] = await Promise.all([
    pool(rows.slice(0, FLAGGED_IN_FEED), 2, r => discover.flags({ chain, token: r.token })),
    PAD_CHAINS[chain] ? pool(rows, 3, r => launchpads.identify(chain, r.token)) : [],
  ]);
  rows.forEach((r, i) => {
    r.flags = i < FLAGGED_IN_FEED ? flags[i] : null;
    const pad = pads[i];
    r.launchpad = pad?.launchpad ? { id: pad.launchpad, name: pad.name, link: pad.link } : null;
  });
  return {
    chain, chain_name: NAMES[chain], tokens: rows,
    sources: [list.source, `GoPlus token security for the newest ${FLAGGED_IN_FEED} (cached 6 hours)`, ...(PAD_CHAINS[chain] ? [`each token's launchpad, read from ${PAD_CHAINS[chain]}`] : [])],
    note: 'New tokens are where most scams start, and most new tokens go to zero. Nothing here is a recommendation or financial advice. Buying runs RektBull\'s full checks first, and stops the trade when one finds a critical risk.',
  };
}

/** One token's launch card: its market, GoPlus's flags, and its age. */
async function card({ chain, token }) {
  if (!CHAINS.includes(chain)) throw new LaunchesRefused(`chain must be one of: ${CHAINS.join(', ')}.`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(token || ''))) throw new LaunchesRefused('token must be a contract address.');
  token = token.toLowerCase();
  const [market, flags, pad] = await Promise.all([
    cached(`launches:market:${chain}:${token}`, 120, () => dexscreener.market(chain, token)),
    discover.flags({ chain, token }),
    launchpads.identify(chain, token).catch(err => ({ launchpad: null, not_checked: err.message })),
  ]);
  const ageHours = market.first_pair_created_at ? Math.round((Date.now() - Date.parse(market.first_pair_created_at)) / 360000) / 10 : null;
  return {
    chain, token, market, flags, launchpad: pad.launchpad ? pad : null, age_hours: ageHours, young: ageHours === null || ageHours < YOUNG_HOURS,
    launch_check: `/safety?chain=${chain}&token=${token}#check-card`,
    note: 'Information with its sources, not financial advice. A buy runs the full token check and, for a token under a week old, the bundle check, before your wallet is asked to sign.',
  };
}

/**
 * The bundle and insider check a buy of a young token adds to the Trade
 * desk's checks: { young, check, risk: 'block' | 'confirm' | 'ok' | 'unknown', flags }.
 * Never throws: a check that couldn't run says why, and the buyer must confirm.
 */
async function forTrade({ chain, token }) {
  if (!CHAINS.includes(chain)) return { young: false, risk: 'ok', detail: 'not checked on this chain' };
  const market = await cached(`launches:market:${chain}:${token}`, 120, () => dexscreener.market(chain, token)).catch(err => ({ not_checked: err.message }));
  const ageHours = market.first_pair_created_at ? (Date.now() - Date.parse(market.first_pair_created_at)) / 3600000 : null;
  if (ageHours !== null && ageHours >= YOUNG_HOURS) return { young: false, risk: 'ok', detail: `its first pool opened ${Math.round(ageHours / 24)} days ago (DexScreener)` };
  let r;
  try {
    r = await require('./launchSafety').check({ chain, token });
  } catch (err) {
    return { young: true, risk: 'unknown', detail: `the bundle check couldn't run: ${err.message}`, flags: [] };
  }
  const flags = r.flags.filter(f => f.severity !== 'info');
  const risk = flags.some(f => f.severity === 'critical') ? 'block' : flags.some(f => f.severity === 'high') ? 'confirm' : 'ok';
  return { young: true, risk, verdict: r.verdict, detail: r.summary, flags, groups: r.groups.length, sources: r.sources };
}

const CURVES = {
  base: { pad: 'Virtuals', list: () => launchpads.newestOnCurve(10), source: 'Virtuals\' Bonding contract on Base, read onchain (refreshed every 2 minutes)', dex: 'Uniswap' },
  bsc: { pad: 'four.meme', list: () => launchpads.newestOnFourMeme(10), source: 'four.meme\'s TokenManager2 and helper contracts on BNB Chain, read onchain (refreshed every 2 minutes); tokens priced in BNB with at least 1% of the curve sold', dex: 'PancakeSwap' },
};

/** The newest tokens still on a launchpad's bonding curve: Virtuals (Base) or four.meme (BNB Chain), each with how far it is to graduating. */
async function curves({ chain = 'base' } = {}) {
  const c = CURVES[chain];
  if (!c) throw new LaunchesRefused(`chain must be one of: ${Object.keys(CURVES).join(', ')}.`);
  let list;
  try { list = await c.list(); } catch (err) { throw new LaunchesRefused(`${c.pad}'s contract couldn't be read just now (${err.message}). Try again in a minute.`, 503); }
  return {
    chain, launchpad: c.pad, tokens: list.map(t => ({ token: t.token, ticker: t.ticker, launchpad: t.name, link: t.link, curve: t.curve })),
    source: c.source,
    note: `Tokens on a bonding curve are bought and sold on the launchpad's own contract until they graduate to ${c.dex}. Most never graduate. Nothing here is a recommendation or financial advice.`,
  };
}

module.exports = { curves, feed, card, forTrade, parse, exchangeName, LaunchesRefused, CHAINS, YOUNG_HOURS, FLAGGED_IN_FEED };
