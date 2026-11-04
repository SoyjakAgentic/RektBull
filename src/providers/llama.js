/**
 * DefiLlama's free, keyless APIs for Discover: every protocol with its TVL,
 * fees in the last 24 hours, the hacks it has recorded, and chain TVLs.
 * Each answer is cut to what Discover shows and cached (the protocol list is
 * ~9 MB raw), so the site makes a few calls an hour whatever the traffic.
 */
const axios = require('axios');
const { track } = require('./usage');
const { cached } = require('../lib/cache');

const API = 'https://api.llama.fi';
const get = (path, timeout = 30000) => track('defillama', async () => (await axios.get(API + path, { timeout, maxContentLength: 64 * 1024 * 1024 })).data);

// RektBull's chains, as DefiLlama names them (protocol lists, chainTvls) and keys them (fee breakdowns, token addresses).
const CHAINS = {
  ethereum: { name: 'Ethereum', key: 'ethereum' },
  base: { name: 'Base', key: 'base' },
  arbitrum: { name: 'Arbitrum', key: 'arbitrum' },
  optimism: { name: 'Optimism', key: 'optimism' },
  polygon: { name: 'Polygon', key: 'polygon' },
  bsc: { name: 'Binance', key: 'bsc' },
  solana: { name: 'Solana', key: 'solana' },
};
const byName = Object.fromEntries(Object.entries(CHAINS).map(([id, c]) => [c.name, id]));

// Not dapps: exchanges' own wallets and whole chains.
const NOT_DAPPS = new Set(['CEX', 'Chain']);

/** "0x…" (Ethereum) or "bsc:0x…" → { chain, address } on a RektBull chain, or null. */
function tokenOf(address) {
  if (!address || typeof address !== 'string') return null;
  const [prefix, rest] = address.includes(':') ? address.split(':') : ['ethereum', address];
  const chain = Object.keys(CHAINS).find(id => CHAINS[id].key === prefix);
  if (!chain) return null;
  if (chain === 'solana' ? !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(rest) : !/^0x[0-9a-fA-F]{40}$/.test(rest)) return null;
  return { chain, address: chain === 'solana' ? rest : rest.toLowerCase() };
}

/** Every dapp with TVL, cut to what Discover uses. Cached 30 minutes. */
function protocols() {
  return cached('llama:protocols:v1', 1800, async () => {
    const rows = await get('/protocols');
    return rows.filter(p => !NOT_DAPPS.has(p.category) && (p.tvl > 0)).map(p => ({
      id: String(p.id), name: p.name, slug: p.slug, category: p.category || 'Other',
      chains: (p.chains || []).map(c => byName[c]).filter(Boolean), chain_count: (p.chains || []).length,
      tvl: p.tvl, chain_tvl: Object.fromEntries(Object.entries(CHAINS).map(([id, c]) => [id, p.chainTvls?.[c.name] || 0]).filter(([, v]) => v > 0)),
      change_1d: p.change_1d ?? null, change_7d: p.change_7d ?? null,
      audit_links: Array.isArray(p.audit_links) ? p.audit_links.slice(0, 3) : [],
      listed_at: p.listedAt || null, url: p.url || null, logo: p.logo || null,
      token: tokenOf(p.address),
      tvl_doubted: !!(p.misrepresentedTokens || p.wrongLiquidity),
    }));
  });
}

/** Fees in the last 24 hours by protocol id, overall and on each RektBull chain. Cached 30 minutes. */
function fees() {
  return cached('llama:fees:v1', 1800, async () => {
    const data = await get('/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true');
    const out = {};
    for (const p of data.protocols || []) {
      if (!p.defillamaId || !(p.total24h >= 0)) continue;
      const perChain = {};
      for (const [id, c] of Object.entries(CHAINS)) {
        const v = p.breakdown24h?.[c.key] ? Object.values(p.breakdown24h[c.key]).reduce((s, x) => s + (Number(x) || 0), 0) : 0;
        if (v > 0) perChain[id] = v;
      }
      out[String(p.defillamaId)] = { total: p.total24h, chains: perChain };
    }
    return out;
  });
}

/** Recorded hacks by protocol id, newest first. Cached 6 hours. */
function hacks() {
  return cached('llama:hacks:v1', 6 * 3600, async () => {
    const rows = await get('/hacks');
    const out = {};
    for (const h of rows) {
      if (!h.defillamaId) continue;
      (out[String(h.defillamaId)] ||= []).push({ date: h.date ? new Date(h.date * 1000).toISOString().slice(0, 10) : null, amount_usd: h.amount ?? null, technique: h.technique || h.classification || null, returned_usd: h.returnedFunds ?? null });
    }
    for (const list of Object.values(out)) list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return out;
  });
}

/** Every chain's TVL. Cached 30 minutes. */
function chains() {
  return cached('llama:chains:v1', 1800, async () => (await get('/v2/chains')).filter(c => c.tvl > 0).map(c => ({
    name: c.name, tvl: c.tvl, token: c.tokenSymbol || null, rektbull: byName[c.name] || (c.name === 'BSC' ? 'bsc' : null),
  })));
}

module.exports = { protocols, fees, hacks, chains, tokenOf, CHAINS };
