/**
 * USD prices from DefiLlama's free coins API, cached for a minute.
 * Stablecoins in the trading config carry a fixed $1 and never call out.
 */
const axios = require('axios');
const { track } = require('./usage');
const { cached, get: cacheGet, set: cacheSet } = require('../lib/cache');

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

/**
 * USD prices for many tokens in one call: { 'base:0x…': 1.0, … }. Tokens
 * DefiLlama doesn't price are left out (the caller says "not priced").
 */
async function usdPrices(ids) {
  const out = {};
  const missing = [];
  for (const id of ids) {
    const hit = await cacheGet(`price:${id}`);
    if (hit !== undefined) out[id] = hit; else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    const data = await track('defillama', async () => (await axios.get(`https://coins.llama.fi/prices/current/${chunk.join(',')}`, { timeout: 15000 })).data);
    for (const id of chunk) {
      const p = data?.coins?.[id]?.price;
      if (p > 0) { out[id] = p; await cacheSet(`price:${id}`, p, 60); }
    }
  }
  return out;
}

module.exports = { usdPrice, basePrice, usdPrices };
