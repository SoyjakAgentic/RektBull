/**
 * USD prices from DefiLlama's free coins API, cached for a minute.
 * Stablecoins in the trading config carry a fixed $1 and never call out.
 */
const axios = require('axios');
const { track } = require('./usage');
const { cached } = require('../lib/cache');

async function usdPrice(priceId) {
  return cached(`price:${priceId}`, 60, async () => {
    const data = await track('defillama', async () => (await axios.get(`https://coins.llama.fi/prices/current/${priceId}`, { timeout: 10000 })).data);
    const p = data?.coins?.[priceId]?.price;
    if (!(p > 0)) throw Object.assign(new Error(`no USD price for ${priceId}`), { status: 503 });
    return p;
  });
}

/** The USD price of a trading base asset ({ usd } or { priceId }). */
const basePrice = base => (base.usd ? Promise.resolve(base.usd) : usdPrice(base.priceId));

module.exports = { usdPrice, basePrice };
