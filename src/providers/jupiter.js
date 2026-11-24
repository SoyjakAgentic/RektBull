/**
 * Jupiter's Swap API v2 (api.jup.ag/swap/v2; developers.jup.ag/docs/swap, read
 * 15 November 2026). Jupiter retired the Metis v1 API's upkeep and is phasing
 * out lite-api.jup.ag; v2 answers without a key at 0.5 requests a second, and
 * a free key (JUPITER_API_KEY, sent as x-api-key) raises that.
 *
 * - build: the swap's instructions (not an assembled transaction), from
 *   Jupiter's Router, which charges no swap fee of its own. Routes include
 *   pump.fun's bonding curve, PumpSwap and Raydium LaunchLab. RektBull adds
 *   its own fee transfer to the same transaction (trade/solana.js).
 * - quote: a price only (the Meta-Aggregator's /order without a taker), for
 *   checks such as selling a token straight back.
 */
const axios = require('axios');
const env = require('../config/env');
const { track } = require('./usage');

const URL = 'https://api.jup.ag/swap/v2';
const MAX_ACCOUNTS = 48;
const RETRY_MS = 2100; // one retry after a rate limit: the keyless limit is one request per two seconds

class JupiterError extends Error {
  constructor(message, status) { super(message); this.status = status; this.isJupiter = true; }
}

// Tests replace this to avoid the network.
let transport = async (path, params) => {
  const get = () => axios.get(`${URL}${path}`, { params, headers: env.jupiterApiKey ? { 'x-api-key': env.jupiterApiKey } : {}, timeout: 15000 });
  return track('jupiter', async () => {
    try {
      return (await get()).data;
    } catch (err) {
      if (err.response?.status !== 429) throw err;
      await new Promise(r => setTimeout(r, RETRY_MS));
      return (await get()).data;
    }
  });
};
const setTransport = fn => { transport = fn; };

const reason = err => err.response?.data?.error?.message || err.response?.data?.error || err.response?.data?.message || err.message;

async function call(path, params) {
  try {
    return await transport(path, params);
  } catch (err) {
    if (err.isProviderLimit) throw err;
    const status = err.response?.status;
    throw new JupiterError(`Jupiter ${status === 429 ? 'is rate-limiting RektBull just now' : `refused the request (${typeof reason(err) === 'string' ? reason(err) : 'no reason given'})`}`, status);
  }
}

/** The swap's instructions for `taker` to sign, with its lookup tables and a recent blockhash. */
async function build({ inputMint, outputMint, amount, slippageBps, taker, maxAccounts = MAX_ACCOUNTS }) {
  // At most 48 accounts in the route, so RektBull's own instructions still fit Solana's 1,232-byte limit
  // (fewer when exits ride in the same transaction: trade/solana.js).
  const r = await call('/build', { inputMint, outputMint, amount: String(amount), slippageBps, taker, maxAccounts });
  if (!r?.swapInstruction || !r.outAmount) throw new JupiterError('Jupiter found no route for this trade.');
  return r;
}

/** What selling `amount` would return, or null when Jupiter has no route. A price only: nothing to sign. */
async function quote({ inputMint, outputMint, amount }) {
  try {
    const r = await call('/order', { inputMint, outputMint, amount: String(amount) });
    return r?.outAmount ? BigInt(r.outAmount) : null;
  } catch (err) {
    if (err.isJupiter && err.status >= 400 && err.status < 500 && err.status !== 429) return null; // no route
    throw err;
  }
}

module.exports = { build, quote, setTransport, JupiterError, URL };
