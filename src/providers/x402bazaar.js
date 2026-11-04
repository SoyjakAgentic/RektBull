/**
 * Coinbase's x402 Bazaar: paid APIs that AI agents can call per request with
 * x402, as their makers list them, with Coinbase's 30-day usage counts.
 * Free and keyless. The list is long (over 100,000 endpoints, most of them
 * never called) and comes roughly busiest first, so the first 500 are read
 * and cached 6 hours: about 20 calls a day whatever the traffic.
 */
const axios = require('axios');
const { track } = require('./usage');
const { cached } = require('../lib/cache');

const API = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
const PAGES = 5;
const PAGE = 100;

/** Payment networks by CAIP-2 id; testnets are left out of everything. */
const NETWORKS = {
  'eip155:8453': { id: 'base', name: 'Base' },
  'eip155:1': { id: 'ethereum', name: 'Ethereum' },
  'eip155:42161': { id: 'arbitrum', name: 'Arbitrum' },
  'eip155:10': { id: 'optimism', name: 'Optimism' },
  'eip155:137': { id: 'polygon', name: 'Polygon' },
  'eip155:56': { id: 'bsc', name: 'BNB Chain' },
  'eip155:480': { id: 'worldchain', name: 'World Chain' },
  'eip155:143': { id: 'monad', name: 'Monad' },
  'eip155:196': { id: 'xlayer', name: 'X Layer' },
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': { id: 'solana', name: 'Solana' },
  // x402 v1 named networks
  base: { id: 'base', name: 'Base' },
  solana: { id: 'solana', name: 'Solana' },
  polygon: { id: 'polygon', name: 'Polygon' },
};
const TESTNETS = new Set(['eip155:84532', 'eip155:11155111', 'eip155:421614', 'eip155:11155420', 'eip155:80002', 'eip155:97', 'base-sepolia', 'solana-devnet', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', 'polygon-amoy']);

/** Stablecoins whose amounts can be read as US dollars: address (lowercase) → decimals. */
const USD_STABLES = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6, // USDC, Base
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6, // USDC, Ethereum
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 6, // USDC, Arbitrum
  '0x0b2c639c533813f4aa9d7837caf62653d097ff85': 6, // USDC, Optimism
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 6, // USDC, Polygon
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 18, // USDC, BNB Chain (18 decimals there)
  '0x55d398326f99059ff775485246999027b3197955': 18, // USDT, BNB Chain
  ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'.toLowerCase()]: 6, // USDC, Solana
};

const num = v => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** One listed endpoint, cut to what RektBull shows. Testnet-only endpoints come back null. */
function endpoint(item) {
  const accepts = (item.accepts || []).filter(a => !TESTNETS.has(a.network));
  const url = item.resource || accepts[0]?.resource;
  if (!url || !accepts.length) return null;
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
  const prices = accepts.map(a => {
    const decimals = USD_STABLES[String(a.asset || '').toLowerCase()];
    const raw = num(a.amount ?? a.maxAmountRequired);
    return decimals === undefined || raw === null ? null : raw / 10 ** decimals;
  }).filter(p => p !== null);
  const q = item.quality || {};
  return {
    url, host, secure: url.startsWith('https://'),
    service: String(item.serviceName || '').trim() || null,
    description: String(item.description || accepts[0]?.description || '').trim().slice(0, 300) || null,
    method: item.extensions?.bazaar?.info?.input?.method || null,
    tags: (item.tags || []).map(String).slice(0, 8),
    networks: [...new Set(accepts.map(a => NETWORKS[a.network]?.id || a.network))],
    network_names: [...new Set(accepts.map(a => NETWORKS[a.network]?.name || a.network))],
    price_usd: prices.length ? Math.min(...prices) : null,
    pay_to: [...new Set(accepts.map(a => String(a.payTo || '')).filter(Boolean))],
    pay_to_networks: Object.fromEntries(accepts.filter(a => a.payTo).map(a => [String(a.payTo), NETWORKS[a.network]?.id || a.network])),
    calls_30d: num(q.l30DaysTotalCalls) ?? 0,
    payers_30d: num(q.l30DaysUniquePayers) ?? 0,
    last_called_at: q.lastCalledAt || null,
    updated_at: item.lastUpdated || null,
  };
}

/** The first 500 listed endpoints (mainnets only), cached 6 hours. */
function listing() {
  return cached('x402bazaar:listing', 6 * 3600, async () => {
    const items = [];
    let total = null;
    for (let page = 0; page < PAGES; page++) {
      const data = await track('x402_bazaar', async () => (await axios.get(API, { params: { limit: PAGE, offset: page * PAGE }, timeout: 20000 })).data);
      total = data.pagination?.total ?? total;
      items.push(...(data.items || []));
      if ((data.items || []).length < PAGE) break;
    }
    return { endpoints: items.map(endpoint).filter(Boolean), listed_total: total, read: items.length, read_at: new Date().toISOString() };
  });
}

module.exports = { listing, endpoint, NETWORKS, TESTNETS, USD_STABLES };
