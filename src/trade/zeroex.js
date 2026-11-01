/**
 * 0x Swap API (v2, AllowanceHolder), ported from soyjak-agentic's swapRules.js.
 *
 * The 1% fee is taken by 0x inside the swap, in the base asset (swapFeeToken),
 * and paid to the fee wallet. If 0x refuses the fee but not the trade, the
 * trade goes ahead without it, as in Soyjak: an exit must never wait on
 * RektBull's own setup.
 */
const axios = require('axios');
const env = require('../config/env');
const logger = require('../config/logger');
const { track } = require('../providers/usage');

const URL = 'https://api.0x.org';

class TradeBlocked extends Error {
  constructor(message) { super(message); this.status = 422; this.isTradeBlocked = true; }
}

// Tests replace this to avoid the network.
let transport = async (path, params) => {
  if (!env.zeroExApiKey) throw new TradeBlocked('Trading needs a 0x API key: set ZEROEX_API_KEY (0x has a free plan).');
  return track('0x', async () => (await axios.get(`${URL}${path}`, {
    params, headers: { '0x-api-key': env.zeroExApiKey, '0x-version': 'v2' }, timeout: 15000,
  })).data);
};
const setTransport = fn => { transport = fn; };

const feeParams = fee => (fee ? { swapFeeBps: fee.bps, swapFeeRecipient: fee.recipient, swapFeeToken: fee.token } : {});

async function withFee(path, params, fee) {
  if (!fee) return { data: await transport(path, params), fee: null };
  try {
    return { data: await transport(path, { ...params, ...feeParams(fee) }), fee };
  } catch (err) {
    if (err.response?.status !== 400) throw err;
    logger.warn('0x refused the swap fee; quoting without it', { detail: JSON.stringify(err.response.data || {}).slice(0, 300) });
    return { data: await transport(path, params), fee: null };
  }
}

/**
 * A quote: { sellAmount, buyAmount, minBuyAmount, taxBps, fee, feeAmount, transaction, allowanceSpender, raw }.
 * indicative: a price only (no wallet, no transaction), for previews and sell-back checks.
 */
async function quote({ chainId, sellToken, buyToken, sellAmount, taker, slippageBps, fee, indicative = false }) {
  const { data: q, fee: appliedFee } = await withFee(`/swap/allowance-holder/${indicative ? 'price' : 'quote'}`, {
    chainId, sellToken, buyToken, sellAmount: String(sellAmount), slippageBps, ...(taker ? { taker } : {}),
  }, fee);
  if (q.liquidityAvailable === false || !q.buyAmount || (!indicative && !q.transaction)) throw new TradeBlocked('0x found no liquidity for this trade.');
  if (!indicative && q.issues?.balance) throw new TradeBlocked(`Your wallet holds ${q.issues.balance.actual} of the ${q.issues.balance.expected} (smallest units) this trade needs.`);
  if (!indicative && q.issues?.simulationIncomplete) throw new TradeBlocked('0x could not simulate this trade, so it may fail or the token may not be sellable.');
  const meta = q.tokenMetadata || {};
  const taxBps = Math.max(
    Number(meta.buyToken?.buyTaxBps || 0), Number(meta.buyToken?.sellTaxBps || 0),
    Number(meta.sellToken?.buyTaxBps || 0), Number(meta.sellToken?.sellTaxBps || 0),
  );
  const out = {
    sellAmount: BigInt(q.sellAmount || sellAmount),
    buyAmount: BigInt(q.buyAmount),
    minBuyAmount: BigInt(q.minBuyAmount || q.buyAmount),
    taxBps,
    fee: appliedFee,
    transaction: q.transaction || null,
    allowanceSpender: q.issues?.allowance?.spender || null,
    raw: q,
  };
  out.feeAmount = feeAmount(appliedFee, { sellToken, sellAmount: out.sellAmount, buyAmount: out.buyAmount, reported: q.fees?.integratorFee?.amount });
  return out;
}

/** The fee in the fee token's smallest units: what 0x reports, else worked out from the side it's on. */
function feeAmount(fee, { sellToken, sellAmount, buyAmount, reported }) {
  if (!fee) return 0n;
  if (reported !== undefined && reported !== null && /^\d+$/.test(String(reported))) return BigInt(reported);
  const bps = BigInt(fee.bps);
  return String(fee.token).toLowerCase() === String(sellToken).toLowerCase()
    ? sellAmount * bps / 10000n
    : buyAmount * bps / (10000n - bps);
}

module.exports = { quote, feeAmount, setTransport, TradeBlocked };
