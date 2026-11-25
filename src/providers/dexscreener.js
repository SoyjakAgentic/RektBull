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

/**
 * Many tokens on one chain, 30 a call (DexScreener's tokens/v1 endpoint): each
 * token's most liquid pair, as { [token]: { price_usd, liquidity_usd,
 * volume_24h_usd, market_cap_usd, change_1h_pct, change_24h_pct, buys_24h,
 * sells_24h, created_at, pair, symbol, name } }. Liquidity and volume are
 * summed over all its pairs. A token with no pair is left out.
 */
async function pairs(chain, tokens) {
  const slug = chain === 'solana' ? SOLANA.dexscreener : EVM[chain]?.dexscreener;
  if (!slug) throw new Error(`DexScreener does not cover ${chain}`);
  const out = {};
  for (let i = 0; i < tokens.length; i += 30) {
    const batch = tokens.slice(i, i + 30);
    const list = await track('dexscreener', async () => (await axios.get(`https://api.dexscreener.com/tokens/v1/${slug}/${batch.join(',')}`, { timeout: 10000 })).data);
    const by = {};
    for (const p of Array.isArray(list) ? list : []) {
      const addr = chain === 'solana' ? p.baseToken?.address : String(p.baseToken?.address || '').toLowerCase();
      if (batch.includes(addr) && p.priceUsd) (by[addr] ||= []).push(p);
    }
    for (const [addr, ps] of Object.entries(by)) {
      ps.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      const top = ps[0];
      const sum = f => ps.reduce((acc, p) => acc + (f(p) || 0), 0);
      const created = ps.map(p => p.pairCreatedAt).filter(Boolean);
      out[addr] = {
        price_usd: Number(top.priceUsd), liquidity_usd: sum(p => p.liquidity?.usd), volume_24h_usd: sum(p => p.volume?.h24),
        market_cap_usd: top.marketCap ?? top.fdv ?? null, change_1h_pct: top.priceChange?.h1 ?? null, change_24h_pct: top.priceChange?.h24 ?? null,
        buys_24h: sum(p => p.txns?.h24?.buys), sells_24h: sum(p => p.txns?.h24?.sells),
        created_at: created.length ? new Date(Math.min(...created)).toISOString() : null,
        pair: top.pairAddress || null, symbol: top.baseToken?.symbol || null, name: top.baseToken?.name || null,
        // The pair itself, for reading its price from the chain (trade/memeStream.js): which exchange, its version, and what it's priced in.
        dex: top.dexId || null, labels: top.labels || [], price_native: top.priceNative ? Number(top.priceNative) : null,
        quote: top.quoteToken?.address ? (chain === 'solana' ? top.quoteToken.address : String(top.quoteToken.address).toLowerCase()) : null, quote_symbol: top.quoteToken?.symbol || null,
      };
    }
  }
  return out;
}

/** Prices for many tokens on one chain: { [token]: price of its most liquid pair }. */
async function prices(chain, tokens) {
  const got = await module.exports.pairs(chain, tokens);
  return Object.fromEntries(Object.entries(got).map(([t, p]) => [t, p.price_usd]));
}

module.exports = { market, links, pairs, prices };
