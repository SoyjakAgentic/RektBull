/**
 * Market data from DexScreener's free, keyless API: the token's trading
 * pairs, liquidity, volume, price and when its first pair was created, and
 * the website and social links the project gave DexScreener (unchecked: the
 * token page checks each against GoPlus's phishing list before showing it).
 */
const axios = require('axios');
const { EVM, SOLANA } = require('./chains');
const { track } = require('./usage');

/** The project's own links on its main pair: websites and socials, https only. */
function links(info) {
  const out = [];
  const add = (label, url) => {
    try {
      const u = new URL(String(url));
      if (u.protocol === 'https:' && !out.some(l => l.url === u.href)) out.push({ label: String(label || u.hostname).slice(0, 40), url: u.href });
    } catch { /* not a URL */ }
  };
  for (const w of info?.websites || []) add(w.label || 'Website', w.url);
  for (const s of info?.socials || []) add(s.type ? s.type[0].toUpperCase() + s.type.slice(1) : 'Social', s.url);
  return out.slice(0, 8);
}

async function market(chain, token) {
  const slug = chain === 'solana' ? SOLANA.dexscreener : EVM[chain]?.dexscreener;
  if (!slug) return { not_checked: `DexScreener does not cover ${chain}` };
  try {
    const data = await track('dexscreener', async () => (await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${token}`, { timeout: 10000 })).data);
    const pairs = (data?.pairs || []).filter(p => p.chainId === slug);
    if (!pairs.length) return { source: 'DexScreener', pairs: 0, note: 'No trading pairs found on this chain' };
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const top = pairs[0];
    const created = pairs.map(p => p.pairCreatedAt).filter(Boolean);
    return {
      source: 'DexScreener',
      pairs: pairs.length,
      price_usd: top.priceUsd ? Number(top.priceUsd) : null,
      liquidity_usd_total: Math.round(pairs.reduce((s, p) => s + (p.liquidity?.usd || 0), 0)),
      volume_24h_usd: Math.round(pairs.reduce((s, p) => s + (p.volume?.h24 || 0), 0)),
      fdv_usd: top.fdv ?? null,
      market_cap_usd: top.marketCap ?? null,
      first_pair_created_at: created.length ? new Date(Math.min(...created)).toISOString() : null,
      main_pair: { dex: top.dexId, address: top.pairAddress, quote: top.quoteToken?.symbol || null, url: top.url || null },
      change_24h_pct: typeof top.priceChange?.h24 === 'number' ? top.priceChange.h24 : null,
      links: links(top.info),
      token_name: top.baseToken?.address?.toLowerCase() === String(token).toLowerCase() ? top.baseToken.name : top.quoteToken?.name || null,
      token_symbol: top.baseToken?.address?.toLowerCase() === String(token).toLowerCase() ? top.baseToken.symbol : top.quoteToken?.symbol || null,
    };
  } catch (err) {
    return { not_checked: `DexScreener: ${err.message}` };
  }
}

module.exports = { market, links };
