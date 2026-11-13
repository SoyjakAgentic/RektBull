/**
 * One token's page (Trade desk, stage 1): what a trader looks at before a buy,
 * each part with its source, and a part that couldn't be read saying why.
 *
 * - page():    market (DexScreener), the project's links (each checked against
 *              GoPlus's phishing list; a listed one is shown but not linked),
 *              top holders (GoPlus, cached 6 hours, with pools, lockers, burn
 *              addresses and the creator marked), what the creator holds now
 *              (read from the chain), the launchpad and how close a curve is to
 *              graduating (the launchpad's own contract), and GoPlus's flags;
 * - trades():  the main pool's latest buys and sells (GeckoTerminal, 15 s);
 * - candles(): its price in dollars, in 5-minute, hourly or daily candles
 *              (GeckoTerminal), drawn by the page itself: no third-party
 *              script or frame is loaded in the visitor's browser.
 *
 * Free data only, every call through providers/usage.track() and cached.
 */
const { ethers } = require('ethers');
const { cached } = require('../lib/cache');
const dexscreener = require('../providers/dexscreener');
const gt = require('../providers/geckoterminal');
const goplus = require('../providers/goplus');
const discover = require('./discover');
const launchpads = require('./launchpads');
const { DEAD } = require('./tokenRisk');

const CHAINS = { base: 'Base', ethereum: 'Ethereum', arbitrum: 'Arbitrum', bsc: 'BNB Chain' };
const ERC20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)']);

class TokenPageRefused extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function parse(chain, token) {
  chain = String(chain || '').toLowerCase();
  if (!CHAINS[chain]) throw new TokenPageRefused(`chain must be one of: ${Object.keys(CHAINS).join(', ')}.`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(token || ''))) throw new TokenPageRefused('token must be a contract address.');
  return { chain, token: token.toLowerCase() };
}

const market = (chain, token) => cached(`launches:market:${chain}:${token}`, 120, () => dexscreener.market(chain, token));

/** The project's links, each checked against GoPlus's phishing list: ok, listed (not linked), or unchecked with why. */
async function checkedLinks(list) {
  return Promise.all((list || []).map(async l => {
    const origin = new URL(l.url).origin;
    try {
      const r = await goplus.phishingSite(origin);
      return { ...l, host: new URL(l.url).hostname, phishing: r.phishing === true, checked: true };
    } catch (err) {
      return { ...l, host: new URL(l.url).hostname, phishing: null, checked: false, not_checked: `GoPlus's phishing list couldn't be read: ${err.message}` };
    }
  }));
}

/** What an address holds of the token now, as a share of the supply, read from the chain (30 s). */
function holdsNow(chain, token, who) {
  return cached(`token:holds:${chain}:${token}:${who}`, 30, async () => {
    const { multicall } = require('./approvals');
    const [bal, supply] = await multicall(chain, [
      { target: token, iface: ERC20, fn: 'balanceOf', args: [who] },
      { target: token, iface: ERC20, fn: 'totalSupply', args: [] },
    ]);
    if (!bal.ok || !supply.ok) throw new Error('the token didn\'t answer balanceOf or totalSupply');
    const b = BigInt(bal.value[0]); const s = BigInt(supply.value[0]);
    return { pct: s > 0n ? Math.round(Number(b * 1000000n / s)) / 10000 : null };
  });
}

/** The token's page: everything but its trades and candles, which the page asks for itself. */
async function page(input) {
  const { chain, token } = parse(input.chain, input.token);
  const [m, gp, pad, flags] = await Promise.all([
    market(chain, token).catch(err => ({ not_checked: `DexScreener: ${err.message}` })),
    discover.goplusReport(chain, token).catch(err => ({ not_checked: err.message })),
    launchpads.identify(chain, token).catch(err => ({ launchpad: null, not_checked: `the launchpads couldn't be read: ${err.message}` })),
    discover.flags({ chain, token }),
  ]);
  const pool = m.main_pair?.address ? String(m.main_pair.address).toLowerCase() : null;

  // The creator: as GoPlus reports it, or the launchpad's own record; what they hold now, from the chain.
  const creatorAddress = (pad.launchpad === 'virtuals' && pad.creator) || gp.creator_address || null;
  const creatorSource = pad.launchpad === 'virtuals' && pad.creator ? 'Virtuals\' contract' : 'GoPlus';
  let creator;
  if (!creatorAddress) creator = { not_checked: gp.not_checked ? `GoPlus couldn't be read: ${gp.not_checked}` : 'GoPlus doesn\'t name a creator for this token' };
  else {
    try {
      const h = await holdsNow(chain, token, creatorAddress);
      creator = { address: creatorAddress, holds_pct: h.pct, source: `the creator from ${creatorSource}; what it holds, read now from ${CHAINS[chain]}` };
    } catch (err) {
      creator = { address: creatorAddress, holds_pct: null, not_checked: `what it holds couldn't be read from ${CHAINS[chain]}: ${err.message}`, source: `the creator from ${creatorSource}` };
    }
  }

  // Top holders, each marked: the main pool, a locker, a burn address, another contract, the creator.
  const holders = gp.not_checked ? { not_checked: `GoPlus couldn't be read: ${gp.not_checked}` } : {
    count: gp.holder_count ?? null,
    top10_people_pct: gp.top10_people_pct ?? null,
    top: (gp.top_holders || []).map(h => {
      const a = String(h.address || '').toLowerCase();
      const kind = DEAD.has(a) ? 'burn' : a === pool ? 'pool' : h.is_locked ? 'locked' : a === creatorAddress ? 'creator' : h.is_contract ? 'contract' : 'wallet';
      return { address: a, kind, tag: h.tag || null, pct: h.share === null || h.share === undefined ? null : Math.round(h.share * 1000000) / 10000 };
    }),
    source: 'GoPlus token security (cached for 6 hours)',
  };

  const links = await checkedLinks(m.links?.length ? m.links : pad.links || []);
  const ageHours = m.first_pair_created_at ? Math.round((Date.now() - Date.parse(m.first_pair_created_at)) / 360000) / 10 : null;
  return {
    chain, chain_name: CHAINS[chain], token,
    name: m.token_name || null, symbol: m.token_symbol || pad.ticker || null,
    market: m.not_checked ? { not_checked: m.not_checked } : {
      price_usd: m.price_usd ?? null, change_24h_pct: m.change_24h_pct ?? null, liquidity_usd: m.liquidity_usd_total ?? null,
      volume_24h_usd: m.volume_24h_usd ?? null, market_cap_usd: m.market_cap_usd ?? m.fdv_usd ?? null, pairs: m.pairs ?? 0,
      first_pair_created_at: m.first_pair_created_at || null, age_hours: ageHours, source: 'DexScreener (cached 2 minutes)',
    },
    pool: pool ? { address: pool, dex: m.main_pair.dex, quote: m.main_pair.quote, source: 'DexScreener: its most liquid pair' } : null,
    links: { list: links, source: m.links?.length ? 'the project\'s links on DexScreener' : pad.links?.length ? `the creator's links on ${pad.name}` : null,
      note: 'Links the project gave, each checked against GoPlus\'s phishing list. A listed site is shown but not linked.' },
    holders, creator,
    launchpad: pad.launchpad ? {
      id: pad.launchpad, name: pad.name, state: pad.state, link: pad.link, source: pad.source,
      curve: pad.curve ? { progress_pct: pad.curve.progress_pct, in_curve: pad.curve.in_curve, graduates_at: pad.curve.graduates_at ?? null, symbol: pad.curve.in_curve_symbol, buy_tax_pct: pad.curve.buy_tax_pct, sell_tax_pct: pad.curve.sell_tax_pct } : null,
      agent_token: pad.agent_token || null, facts: pad.facts || [],
    } : pad.not_checked ? { not_checked: pad.not_checked } : null,
    flags,
    note: 'Information with its sources, not financial advice. Most new tokens go to zero. A buy runs RektBull\'s full token check (and, for a token under a week old, the bundle check) before your wallet is asked to sign.',
  };
}

/** The main pool's latest trades, as seen from this token. */
async function trades(input) {
  const { chain, token } = parse(input.chain, input.token);
  const m = await market(chain, token).catch(() => ({}));
  const pool = m.main_pair?.address;
  if (!pool) return { chain, token, trades: [], not_checked: m.not_checked || 'DexScreener lists no pool for it yet', source: 'GeckoTerminal' };
  try {
    return { chain, token, pool: String(pool).toLowerCase(), trades: await gt.trades(chain, pool, token), source: 'GeckoTerminal (the latest trades in its most liquid pool, refreshed every 15 seconds)' };
  } catch (err) {
    return { chain, token, pool: String(pool).toLowerCase(), trades: [], not_checked: `GeckoTerminal couldn't be read: ${err.response?.status === 429 ? 'it\'s busy (free plan limit); try again in a minute' : err.message}`, source: 'GeckoTerminal' };
  }
}

/** The main pool's price candles for this token, in dollars. */
async function candles(input) {
  const { chain, token } = parse(input.chain, input.token);
  const size = String(input.size || '1h');
  if (!gt.CANDLES[size]) throw new TokenPageRefused(`size must be one of: ${Object.keys(gt.CANDLES).join(', ')}.`);
  const m = await market(chain, token).catch(() => ({}));
  const pool = m.main_pair?.address;
  if (!pool) return { chain, token, size, candles: [], not_checked: m.not_checked || 'DexScreener lists no pool for it yet, so there\'s no price history', source: 'GeckoTerminal' };
  try {
    return { chain, token, size, pool: String(pool).toLowerCase(), candles: await gt.candles(chain, pool, token, size), source: 'GeckoTerminal (its most liquid pool, in US dollars)' };
  } catch (err) {
    return { chain, token, size, pool: String(pool).toLowerCase(), candles: [], not_checked: `GeckoTerminal couldn't be read: ${err.response?.status === 429 ? 'it\'s busy (free plan limit); try again in a minute' : err.message}`, source: 'GeckoTerminal' };
  }
}

module.exports = { page, trades, candles, parse, TokenPageRefused, CHAINS };
