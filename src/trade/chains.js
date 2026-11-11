/**
 * Chains RektBull trades on when the user signs each trade: Base, Ethereum and
 * Arbitrum (milestone 4); Solana comes in milestone 5. Automatic trading has
 * its own list (trade/networks.js), one Trade Router per chain.
 *
 * Every 0x trade goes through 0x's AllowanceHolder: a quote naming any other
 * contract, or an approval to any other spender, is refused (trade/calls.js).
 */
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

const TRADE_CHAINS = {
  base: {
    chainId: 8453,
    label: 'Base',
    allowanceHolder: '0x0000000000001ff3684f28c67538d4d072c22734',
    explorerTx: hash => `https://basescan.org/tx/${hash}`,
    bases: {
      USDC: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, usd: 1 },
      ETH: { address: NATIVE, decimals: 18, priceId: 'coingecko:ethereum' },
      WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18, priceId: 'coingecko:ethereum' },
    },
    defaultBase: 'USDC',
  },
  ethereum: {
    chainId: 1,
    label: 'Ethereum',
    allowanceHolder: '0x0000000000001ff3684f28c67538d4d072c22734',
    explorerTx: hash => `https://etherscan.io/tx/${hash}`,
    bases: {
      USDC: { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, usd: 1 },
      ETH: { address: NATIVE, decimals: 18, priceId: 'coingecko:ethereum' },
      WETH: { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', decimals: 18, priceId: 'coingecko:ethereum' },
    },
    defaultBase: 'USDC',
  },
  arbitrum: {
    chainId: 42161,
    label: 'Arbitrum',
    allowanceHolder: '0x0000000000001ff3684f28c67538d4d072c22734',
    explorerTx: hash => `https://arbiscan.io/tx/${hash}`,
    bases: {
      USDC: { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6, usd: 1 },
      ETH: { address: NATIVE, decimals: 18, priceId: 'coingecko:ethereum' },
      WETH: { address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', decimals: 18, priceId: 'coingecko:ethereum' },
    },
    defaultBase: 'USDC',
  },
};

function tradeChain(name) {
  const c = TRADE_CHAINS[String(name || '').toLowerCase()];
  if (!c) throw Object.assign(new Error(`trading is available on: ${Object.keys(TRADE_CHAINS).join(', ')}`), { status: 400 });
  return c;
}

module.exports = { TRADE_CHAINS, tradeChain, NATIVE };
