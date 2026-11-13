/**
 * GeckoTerminal's free, keyless API: the pools trending on a network, and the
 * newest ones; and for the token page, a pool's latest trades and its price
 * candles. Its free plan allows about 30 calls a minute, so each list is
 * cached for 5 minutes (14 lists at most: a call every ~20 seconds at worst),
 * a pool's trades for 15 seconds and its candles for a minute or more.
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

/** A GET on GeckoTerminal; its free plan answers 429 when calls bunch up: wait once, then give up. */
async function get(path, params) {
  const fetch = () => track('geckoterminal', async () => (await axios.get(`https://api.geckoterminal.com/api/v2${path}`, {
    params, headers: { accept: 'application/json' }, timeout: 15000,
  })).data);
  return fetch().catch(async err => {
    if (err.response?.status !== 429) throw err;
    await new Promise(r => setTimeout(r, module.exports.RETRY_MS));
    return fetch();
  });
}

const POOL = /^0x[0-9a-f]{40}$/;

/**
 * A pool's latest trades of one token (newest first, at most 50): buy or sell
 * as seen from that token, whichever side of the pool it is on.
 */
function trades(chain, pool, token) {
  const net = NETWORKS[chain];
  pool = String(pool).toLowerCase(); token = String(token).toLowerCase();
  if (!net || !POOL.test(pool) || !POOL.test(token)) throw new Error(`no trades for ${pool} on ${chain}`);
  return cached(`gt:trades:${chain}:${pool}:${token}`, 15, async () => {
    const data = await get(`/networks/${net}/pools/${pool}/trades`);
    return (data.data || []).map(t => t.attributes || {}).map(a => {
      const bought = String(a.to_token_address).toLowerCase() === token;
      const sold = String(a.from_token_address).toLowerCase() === token;
      if (!bought && !sold) return null;
      return {
        at: a.block_timestamp || null, side: bought ? 'buy' : 'sell',
        tokens: n(bought ? a.to_token_amount : a.from_token_amount), usd: n(a.volume_in_usd),
        price_usd: n(bought ? a.price_to_in_usd : a.price_from_in_usd),
        wallet: a.tx_from_address ? String(a.tx_from_address).toLowerCase() : null, tx: a.tx_hash || null,
      };
    }).filter(Boolean).slice(0, 50);
  });
}

// Candle sizes the token page offers: GeckoTerminal's timeframe, aggregate, how many, and how long to cache them.
const CANDLES = { '5m': ['minute', 5, 144, 60], '1h': ['hour', 1, 168, 300], '1d': ['day', 1, 180, 1800] };

/** A pool's price candles for one token, in dollars, oldest first: [[unix seconds, open, high, low, close, volume], …]. */
function candles(chain, pool, token, size = '1h') {
  const net = NETWORKS[chain];
  const c = CANDLES[size];
  pool = String(pool).toLowerCase(); token = String(token).toLowerCase();
  if (!net || !c || !POOL.test(pool) || !POOL.test(token)) throw new Error(`no candles for ${pool} on ${chain}`);
  const [timeframe, aggregate, limit, ttl] = c;
  return cached(`gt:candles:${chain}:${pool}:${token}:${size}`, ttl, async () => {
    const data = await get(`/networks/${net}/pools/${pool}/ohlcv/${timeframe}`, { aggregate, limit, currency: 'usd', token });
    return (data.data?.attributes?.ohlcv_list || []).map(r => r.map(Number)).filter(r => r.length >= 6 && r.every(Number.isFinite)).sort((a, b) => a[0] - b[0]);
  });
}

/** The trending or newest pools on a chain, with each pool's base token. */
function pools(kind, chain) {
  const net = NETWORKS[chain];
  if (!net || !KINDS[kind]) throw new Error(`no ${kind} list for ${chain}`);
  return cached(`gt:${kind}:${chain}`, 300, async () => {
    const data = await get(`/networks/${net}/${KINDS[kind]}`, { include: 'base_token,quote_token' });
    const tokens = Object.fromEntries((data.included || []).filter(i => i.type === 'token').map(i => [i.id, i.attributes || {}]));
    return (data.data || []).map(p => pool(p, tokens));
  });
}

module.exports = { pools, trades, candles, NETWORKS, KINDS, CANDLES, RETRY_MS: 3000 };
