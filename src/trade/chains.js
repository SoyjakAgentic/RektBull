/**
 * Chains RektBull trades on. Base first (milestone 1); Ethereum and Arbitrum
 * come in milestone 4, Solana in milestone 5.
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
};

function tradeChain(name) {
  const c = TRADE_CHAINS[String(name || '').toLowerCase()];
  if (!c) throw Object.assign(new Error(`trading is available on: ${Object.keys(TRADE_CHAINS).join(', ')}`), { status: 400 });
  return c;
}

module.exports = { TRADE_CHAINS, tradeChain, NATIVE };
