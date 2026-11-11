/**
 * Discover: what's out there, with its safety facts next to its popularity.
 *
 * - Dapps ranked by TVL, fees or weekly change (DefiLlama), each with the
 *   facts that say how much to trust it: hacks DefiLlama recorded, whether an
 *   audit is listed, how long it has been listed, and whether DefiLlama doubts
 *   its TVL. A missing fact is said to be missing, never filled in.
 * - Categories and chains, summed from the same data.
 * - Trending and new tokens (GeckoTerminal pools), with the warning signs
 *   their own market data shows. GoPlus's flags for one token on request
 *   (its free plan answers one token a call), and the paid quick check a click away.
 *
 * Nothing here is a recommendation. Rankings are popularity; the signals are
 * patterns worth a look, each with its source.
 */
const llama = require('../providers/llama');
const gt = require('../providers/geckoterminal');
const { cached } = require('../lib/cache');

class DiscoverRefused extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const CHAIN_IDS = Object.keys(llama.CHAINS);
const CHAIN_NAMES = { ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon', bsc: 'BNB Chain', solana: 'Solana' };
const SORTS = ['tvl', 'fees', 'change_7d'];
const DAY = 86400000;
const usd = v => {
  const a = Math.abs(v);
  const [d, s] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, ''];
  return `$${(v / d).toLocaleString('en-US', { maximumFractionDigits: d === 1 ? 2 : 1 })}${s}`;
};

/* ── input ── */

function parseDapps(q = {}) {
  const chain = q.chain || null;
  if (chain && !CHAIN_IDS.includes(chain)) return { error: `chain must be one of ${CHAIN_IDS.join(', ')}` };
  const sort = q.sort || 'tvl';
  if (!SORTS.includes(sort)) return { error: `sort must be one of ${SORTS.join(', ')}` };
  const limit = q.limit === undefined ? 50 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { error: 'limit must be 1 to 100' };
  const category = q.category ? String(q.category).slice(0, 60) : null;
  return { chain, sort, limit, category };
}

function parseTokens(q = {}) {
  const list = q.list || 'trending';
  if (!gt.KINDS[list]) return { error: 'list must be trending or new' };
  const chain = q.chain || 'base';
  if (!gt.NETWORKS[chain]) return { error: `chain must be one of ${Object.keys(gt.NETWORKS).join(', ')}` };
  return { list, chain };
}

function parseFlags(q = {}) {
  const chain = q.chain;
  if (!CHAIN_IDS.includes(chain)) return { error: `chain must be one of ${CHAIN_IDS.join(', ')}` };
  const token = String(q.token || '').trim();
  if (chain === 'solana' ? !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token) : !/^0x[0-9a-fA-F]{40}$/.test(token)) return { error: 'token must be the token\'s address' };
  return { chain, token: chain === 'solana' ? token : token.toLowerCase() };
}

/* ── dapps ── */

/** The safety facts for one dapp, as signals with their source. */
function dappSignals(p, hackList, now = Date.now()) {
  const out = [];
  for (const h of hackList.slice(0, 2)) {
    out.push({ level: 'bad', text: `Hacked ${h.date || '(date not recorded)'}${h.amount_usd ? `: ${usd(h.amount_usd)} lost` : ''}${h.technique ? ` (${h.technique})` : ''}${h.returned_usd ? `, ${usd(h.returned_usd)} returned` : ''}`, source: 'DefiLlama hacks' });
  }
  if (!p.audit_links.length) out.push({ level: 'warn', text: 'No audit listed', source: 'DefiLlama' });
  if (p.listed_at && now - p.listed_at * 1000 < 90 * DAY) out.push({ level: 'warn', text: `Listed ${Math.max(1, Math.round((now - p.listed_at * 1000) / DAY))} days ago`, source: 'DefiLlama' });
  if (p.tvl_doubted) out.push({ level: 'warn', text: 'DefiLlama notes its TVL may be misreported', source: 'DefiLlama' });
  if (p.change_7d !== null && p.change_7d <= -30) out.push({ level: 'warn', text: `TVL down ${Math.round(-p.change_7d)}% in a week`, source: 'DefiLlama' });
  if (!out.length) out.push({ level: 'ok', text: `No hack recorded; ${p.audit_links.length} audit link${p.audit_links.length === 1 ? '' : 's'} listed`, source: 'DefiLlama' });
  return out;
}

async function dapps({ chain = null, category = null, sort = 'tvl', limit = 50 } = {}) {
  const [protos, feesR, hacksR] = await Promise.allSettled([llama.protocols(), llama.fees(), llama.hacks()]);
  if (protos.status === 'rejected') throw new DiscoverRefused(`DefiLlama didn't answer (${protos.reason.message}). Try again in a minute.`, 503);
  const notChecked = [];
  if (feesR.status === 'rejected') notChecked.push({ check: 'fees in the last 24 hours', reason: feesR.reason.message });
  if (hacksR.status === 'rejected') notChecked.push({ check: 'recorded hacks', reason: hacksR.reason.message });
  const feeOf = id => (feesR.status === 'fulfilled' ? (chain ? feesR.value.protocols[id]?.chains?.[chain] : feesR.value.protocols[id]?.total) ?? null : null);
  const hackOf = id => (hacksR.status === 'fulfilled' ? hacksR.value[id] || [] : []);

  const inScope = protos.value.filter(p => !chain || p.chain_tvl[chain] > 0);
  const categories = Object.entries(inScope.reduce((m, p) => { m[p.category] = (m[p.category] || 0) + (chain ? p.chain_tvl[chain] : p.tvl); return m; }, {}))
    .sort((a, b) => b[1] - a[1]).slice(0, 25).map(([c]) => c);
  const rows = inScope.filter(p => !category || p.category === category).map(p => ({
    id: p.id, name: p.name, category: p.category,
    tvl_usd: Math.round(chain ? p.chain_tvl[chain] : p.tvl),
    change_7d_pct: p.change_7d === null ? null : Math.round(p.change_7d * 10) / 10,
    fees_24h_usd: feeOf(p.id) === null ? null : Math.round(feeOf(p.id)),
    chains: p.chains.map(c => CHAIN_NAMES[c]), more_chains: Math.max(0, p.chain_count - p.chains.length),
    listed_since: p.listed_at ? new Date(p.listed_at * 1000).toISOString().slice(0, 10) : null,
    signals: dappSignals(p, hackOf(p.id)),
    links: { defillama: `https://defillama.com/protocol/${p.slug}`, site: p.url, record: p.tvl >= 10e6 && /^[a-z0-9-]{1,80}$/.test(p.slug || '') ? `/dapps/${p.slug}` : null },
    token: p.token ? { ...p.token, check: `/safety?chain=${p.token.chain}&token=${p.token.address}` } : null,
  }));
  const key = { tvl: r => r.tvl_usd, fees: r => r.fees_24h_usd ?? -1, change_7d: r => r.change_7d_pct ?? -Infinity }[sort];
  rows.sort((a, b) => key(b) - key(a));
  return {
    chain, category, sort, total: rows.length, dapps: rows.slice(0, limit), categories,
    not_checked: notChecked,
    sources: ['DefiLlama protocols (TVL, weekly change, audits listed, listing date)', 'DefiLlama fees (last 24 hours)', 'DefiLlama hacks'],
    note: 'A ranking shows how much is in a dapp, not whether it is safe. No hack recorded and an audit listed are not proof of safety.',
  };
}

/* ── categories and chains ── */

async function categories({ chain = null } = {}) {
  const protos = await llama.protocols().catch(err => { throw new DiscoverRefused(`DefiLlama didn't answer (${err.message}). Try again in a minute.`, 503); });
  const groups = {};
  for (const p of protos) {
    const tvl = chain ? p.chain_tvl[chain] || 0 : p.tvl;
    if (!(tvl > 0)) continue;
    const g = (groups[p.category] ||= { category: p.category, tvl_usd: 0, dapps: 0, top: [], before: 0 });
    g.tvl_usd += tvl; g.dapps += 1; g.top.push([p.name, tvl]);
    if (p.change_7d !== null && p.change_7d > -100) g.before += tvl / (1 + p.change_7d / 100); else g.before += tvl;
  }
  const rows = Object.values(groups).map(g => ({
    category: g.category, tvl_usd: Math.round(g.tvl_usd), dapps: g.dapps,
    change_7d_pct: g.before > 0 ? Math.round((g.tvl_usd / g.before - 1) * 1000) / 10 : null,
    top: g.top.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n),
  })).sort((a, b) => b.tvl_usd - a.tvl_usd).slice(0, 30);
  return { chain, categories: rows, source: 'DefiLlama protocols, summed by category', note: 'The weekly change is worked out from each dapp\'s own weekly change.' };
}

async function chainList() {
  const [list, protos] = await Promise.all([llama.chains(), llama.protocols()]).catch(err => { throw new DiscoverRefused(`DefiLlama didn't answer (${err.message}). Try again in a minute.`, 503); });
  const counts = Object.fromEntries(CHAIN_IDS.map(id => [id, protos.filter(p => p.chain_tvl[id] > 0).length]));
  const rows = list.sort((a, b) => b.tvl - a.tvl).slice(0, 25).map(c => ({
    name: c.rektbull ? CHAIN_NAMES[c.rektbull] : c.name, tvl_usd: Math.round(c.tvl), token: c.token,
    dapps: c.rektbull ? counts[c.rektbull] : null, rektbull: c.rektbull || null,
  }));
  return { chains: rows, source: 'DefiLlama chains (TVL); dapps counted from DefiLlama protocols', note: 'RektBull checks wallets on Ethereum, Base, Arbitrum, Optimism, Polygon and BNB Chain, and tokens on Solana too.' };
}

/* ── tokens ── */

/** The warning signs a pool's own market data shows. */
function poolSignals(p, now = Date.now()) {
  const out = [];
  const src = 'GeckoTerminal';
  if (p.created_at) {
    const h = (now - Date.parse(p.created_at)) / 3600000;
    if (h < 1) out.push({ level: 'warn', text: `Pool opened ${Math.max(1, Math.round(h * 60))} minutes ago`, source: src });
    else if (h < 24) out.push({ level: 'warn', text: `Pool opened ${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'} ago`, source: src });
    else if (h < 24 * 7) out.push({ level: 'warn', text: `Pool opened ${Math.round(h / 24)} days ago`, source: src });
  }
  if (p.liquidity_usd !== null && p.liquidity_usd < 50000) out.push({ level: 'warn', text: `Liquidity ${usd(p.liquidity_usd)}: a large sale moves the price a lot`, source: src });
  if (p.buys_24h >= 20 && p.sells_24h === 0) out.push({ level: 'bad', text: `${p.buys_24h} buys and no sells in 24 hours: a common sign of a token that can't be sold (a pattern, not proof)`, source: src });
  else if (p.buys_24h >= 50 && p.sells_24h !== null && p.sells_24h < p.buys_24h / 20) out.push({ level: 'warn', text: `${p.buys_24h} buys but only ${p.sells_24h} sells in 24 hours`, source: src });
  if (p.change_24h_pct !== null && p.change_24h_pct >= 300) out.push({ level: 'warn', text: `Up ${Math.round(p.change_24h_pct)}% in 24 hours`, source: src });
  if (p.change_24h_pct !== null && p.change_24h_pct <= -60) out.push({ level: 'bad', text: `Down ${Math.round(-p.change_24h_pct)}% in 24 hours`, source: src });
  return out;
}

async function tokens({ list = 'trending', chain = 'base' } = {}) {
  let pools;
  try { pools = await gt.pools(list, chain); } catch (err) {
    throw new DiscoverRefused(`GeckoTerminal didn't answer (${err.response?.status === 429 ? 'its free plan is busy' : err.message}). Try again in a minute.`, 503);
  }
  const seen = new Set();
  const rows = [];
  for (const p of pools) {
    if (!p.token.address || seen.has(p.token.address)) continue;
    seen.add(p.token.address);
    rows.push({
      ...p, chain, chain_name: CHAIN_NAMES[chain],
      signals: poolSignals(p),
      check: `/safety?chain=${chain}&token=${p.token.address}`,
      flags_available: true,
    });
  }
  return {
    list, chain, tokens: rows,
    source: `GeckoTerminal ${list === 'new' ? 'newest' : 'trending'} pools on ${CHAIN_NAMES[chain]} (refreshed every 5 minutes)`,
    note: list === 'new'
      ? 'New pools are where most scams start. Nothing here is a recommendation: check a token before you buy it.'
      : 'Trending means trading activity, not quality. Nothing here is a recommendation: check a token before you buy it.',
  };
}

/** GoPlus's flags for one token, cached 6 hours (its free plan answers one token a call). */
async function flags({ chain, token }) {
  if (chain === 'solana') return { chain, token, not_checked: 'Free flags cover EVM tokens. The quick check covers Solana tokens.' };
  const tokenRisk = require('./tokenRisk');
  let g;
  try {
    g = await cached(`discover:flags:${chain}:${token}`, 6 * 3600, async () => {
      const r = await tokenRisk.goplus(chain, token);
      if (r.not_checked) throw new Error(r.not_checked); // never cache a miss
      return r;
    });
  } catch (err) { return { chain, token, not_checked: err.message }; }
  const out = [];
  const add = (cond, level, text) => { if (cond) out.push({ level, text, source: 'GoPlus' }); };
  add(g.honeypot, 'bad', 'Flagged as a honeypot: buyers may not be able to sell');
  add(g.cannot_sell_all, 'bad', 'Holders can\'t sell all of it');
  add(g.sell_tax_pct > 10 || g.buy_tax_pct > 10, 'bad', `Tax: ${g.buy_tax_pct ?? '?'}% to buy, ${g.sell_tax_pct ?? '?'}% to sell`);
  add(g.owner_change_balance, 'bad', 'The owner can change balances');
  add(g.hidden_owner, 'bad', 'Has a hidden owner');
  add(g.take_back_ownership, 'warn', 'Ownership can be taken back');
  add(g.mintable, 'warn', 'More can be minted');
  add(g.pausable, 'warn', 'Transfers can be paused');
  add(g.blacklist, 'warn', 'Has a blacklist');
  add(g.proxy, 'warn', 'Upgradeable (a proxy): its code can change');
  add(g.top10_people_pct > 50, 'warn', `Top 10 holders (not pools or lockers) hold ${g.top10_people_pct}%`);
  if (!out.length) out.push({ level: 'ok', text: 'None of GoPlus\'s red flags', source: 'GoPlus' });
  return {
    chain, token, flags: out,
    facts: { buy_tax_pct: g.buy_tax_pct, sell_tax_pct: g.sell_tax_pct, holders: g.holder_count, top10_people_pct: g.top10_people_pct, lp_locked_pct: g.lp_locked_pct },
    source: 'GoPlus token security (cached for 6 hours)',
    note: 'GoPlus\'s flags only. The quick check also tests a buy and a sell, reads the contract\'s owner powers and names each source.',
  };
}

module.exports = { dapps, categories, chainList, tokens, flags, parseDapps, parseTokens, parseFlags, dappSignals, poolSignals, DiscoverRefused, CHAIN_NAMES };
