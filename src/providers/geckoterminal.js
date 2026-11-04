/**
 * GeckoTerminal's free, keyless API: the pools trending on a network, and the
 * newest ones. Its free plan allows about 30 calls a minute, so each list is
 * cached for 5 minutes (14 lists at most: a call every ~20 seconds at worst).
 */
const axios = require('axios');
const { track } = require('./usage');
const { cached } = require('../lib/cache');

// RektBull chain → GeckoTerminal network id.
const NETWORKS = { ethereum: 'eth', base: 'base', arbitrum: 'arbitrum', optimism: 'optimism', polygon: 'polygon_pos', bsc: 'bsc', solana: 'solana' };
const KINDS = { trending: 'trending_pools', new: 'new_pools' };

const n = v => (v === null || v === undefined || v === '' ? null : Number(v));

function pool(p, tokens) {
  const a = p.attributes || {};
  const base = tokens[p.relationships?.base_token?.data?.id] || {};
  const quote = tokens[p.relationships?.quote_token?.data?.id] || {};
  const tx = a.transactions?.h24 || {};
  return {
    pool: a.address, name: a.name, dex: p.relationships?.dex?.data?.id || null,
    token: { address: base.address || null, symbol: base.symbol || null, name: base.name || null },
    quote: quote.symbol || null,
    price_usd: n(a.base_token_price_usd),
    change_24h_pct: n(a.price_change_percentage?.h24), change_1h_pct: n(a.price_change_percentage?.h1),
    volume_24h_usd: n(a.volume_usd?.h24), liquidity_usd: n(a.reserve_in_usd),
    fdv_usd: n(a.fdv_usd), market_cap_usd: n(a.market_cap_usd),
    created_at: a.pool_created_at || null,
    buys_24h: tx.buys ?? null, sells_24h: tx.sells ?? null, buyers_24h: tx.buyers ?? null, sellers_24h: tx.sellers ?? null,
  };
}

/** The trending or newest pools on a chain, with each pool's base token. */
function pools(kind, chain) {
  const net = NETWORKS[chain];
  if (!net || !KINDS[kind]) throw new Error(`no ${kind} list for ${chain}`);
  return cached(`gt:${kind}:${chain}`, 300, async () => {
    const fetch = () => track('geckoterminal', async () => (await axios.get(`https://api.geckoterminal.com/api/v2/networks/${net}/${KINDS[kind]}`, {
      params: { include: 'base_token,quote_token' }, headers: { accept: 'application/json' }, timeout: 15000,
    })).data);
    // Its free plan answers 429 when calls bunch up: wait once, then give up (the page says so).
    const data = await fetch().catch(async err => {
      if (err.response?.status !== 429) throw err;
      await new Promise(r => setTimeout(r, module.exports.RETRY_MS));
      return fetch();
    });
    const tokens = Object.fromEntries((data.included || []).filter(i => i.type === 'token').map(i => [i.id, i.attributes || {}]));
    return (data.data || []).map(p => pool(p, tokens));
  });
}

module.exports = { pools, NETWORKS, KINDS, RETRY_MS: 3000 };
