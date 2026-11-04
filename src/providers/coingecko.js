/**
 * CoinGecko's free, keyless API: the largest tokens by market cap. Its free
 * plan allows a few calls a minute and asks for attribution ("Data from
 * CoinGecko", shown wherever this is used), so the list is cached for 10
 * minutes: about 150 calls a day whatever the traffic. One retry after a 429.
 */
const axios = require('axios');
const { track } = require('./usage');
const { cached } = require('../lib/cache');

const n = v => (v === null || v === undefined ? null : Number(v));

function topTokens() {
  return cached('cg:top:v1', 600, async () => {
    const fetch = () => track('coingecko', async () => (await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
      params: { vs_currency: 'usd', order: 'market_cap_desc', per_page: 100, page: 1, price_change_percentage: '24h,7d' },
      headers: { accept: 'application/json' }, timeout: 15000,
    })).data);
    const rows = await fetch().catch(async err => {
      if (err.response?.status !== 429) throw err;
      await new Promise(r => setTimeout(r, module.exports.RETRY_MS));
      return fetch();
    });
    return rows.map(c => ({
      id: c.id, symbol: String(c.symbol || '').toUpperCase(), name: c.name, rank: c.market_cap_rank ?? null,
      price_usd: n(c.current_price), market_cap_usd: n(c.market_cap), volume_24h_usd: n(c.total_volume),
      change_24h_pct: n(c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h),
      change_7d_pct: n(c.price_change_percentage_7d_in_currency),
      from_ath_pct: n(c.ath_change_percentage), ath_date: c.ath_date ? c.ath_date.slice(0, 10) : null,
      supply_share: c.max_supply ? n(c.circulating_supply) / n(c.max_supply) : null,
    }));
  });
}

module.exports = { topTokens, RETRY_MS: 3000 };
