/**
 * The stablecoins RektBull accepts for credit top-ups, from soyjak-agentic's
 * tokenRegistry.js. Each one is counted at $1, so a deposit of 25 USDC is
 * 2,500 cents of credit. Confirmations follow soyjak-agentic's defaults.
 */
const STABLECOINS = {
  ethereum: {
    confirmations: 12,
    tokens: {
      USDT: { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6 },
      USDC: { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 },
    },
  },
  bsc: {
    confirmations: 15,
    tokens: {
      USDT: { address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18 },
      USDC: { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18 },
    },
  },
  base: {
    confirmations: 12,
    tokens: {
      USDC: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
    },
  },
};

/**
 * The x402 asset: USDC on Base, with its EIP-712 domain. X402_ASSET_ADDRESS
 * overrides the contract, for testing on Base Sepolia.
 */
const X402_ASSET = { address: process.env.X402_ASSET_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, name: 'USD Coin', version: '2' };

function stablecoin(chain, symbol) {
  const t = STABLECOINS[chain]?.tokens?.[String(symbol || '').toUpperCase()];
  if (!t) throw Object.assign(new Error(`${symbol} on ${chain} is not accepted; see GET /v1/payment-methods`), { status: 400 });
  return { chain, symbol: String(symbol).toUpperCase(), ...t };
}

/** Whole cents for a raw token amount, rounded down (a fraction of a cent is never credited). */
function rawToCents(raw, decimals) {
  const v = BigInt(raw);
  return Number((v * 100n) / 10n ** BigInt(decimals));
}

/** Raw token units for a number of cents. */
function centsToRaw(cents, decimals) {
  return (BigInt(cents) * 10n ** BigInt(decimals)) / 100n;
}

function methods(chains) {
  return chains.filter(c => STABLECOINS[c]).map(c => ({ chain: c, tokens: Object.keys(STABLECOINS[c].tokens), confirmations: STABLECOINS[c].confirmations }));
}

module.exports = { STABLECOINS, X402_ASSET, stablecoin, rawToCents, centsToRaw, methods };
