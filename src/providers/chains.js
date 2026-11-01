/**
 * The chains RektBull reads, and the RPC endpoints for each.
 *
 * RPC_URLS_<CHAIN> lists your own endpoints (comma-separated, e.g. an
 * Alchemy free-plan URL first). The public endpoint after them is the last
 * resort: free and keyless, but rate-limited and not for heavy use.
 */
const EVM = {
  ethereum: { chainId: 1, goplus: '1', dexscreener: 'ethereum', publicRpc: 'https://ethereum-rpc.publicnode.com', probe: '50000000000000000', probeLabel: '0.05 ETH' },
  base:     { chainId: 8453, goplus: '8453', dexscreener: 'base', publicRpc: 'https://mainnet.base.org', probe: '50000000000000000', probeLabel: '0.05 ETH' },
  arbitrum: { chainId: 42161, goplus: '42161', dexscreener: 'arbitrum', publicRpc: 'https://arb1.arbitrum.io/rpc', probe: '50000000000000000', probeLabel: '0.05 ETH' },
  optimism: { chainId: 10, goplus: '10', dexscreener: 'optimism', publicRpc: 'https://mainnet.optimism.io', probe: '50000000000000000', probeLabel: '0.05 ETH' },
  polygon:  { chainId: 137, goplus: '137', dexscreener: 'polygon', publicRpc: 'https://polygon-bor-rpc.publicnode.com', probe: '200000000000000000000', probeLabel: '200 POL' },
  bsc:      { chainId: 56, goplus: '56', dexscreener: 'bsc', publicRpc: 'https://bsc-dataseed.bnbchain.org', probe: '200000000000000000', probeLabel: '0.2 BNB' },
};

const SOLANA = { dexscreener: 'solana', publicRpc: 'https://api.mainnet-beta.solana.com' };

const ALL = [...Object.keys(EVM), 'solana'];

// Chains read only for trading permissions (not token checks): testnets.
const EXTRA_RPC = { 'base-sepolia': 'https://sepolia.base.org' };

function rpcUrls(chain) {
  const own = String(process.env[`RPC_URLS_${chain.toUpperCase().replace(/-/g, '_')}`] || '').split(',').map(s => s.trim()).filter(Boolean);
  const pub = chain === 'solana' ? SOLANA.publicRpc : EVM[chain]?.publicRpc || EXTRA_RPC[chain];
  return [...own, ...(pub ? [pub] : [])];
}

module.exports = { EVM, SOLANA, ALL, rpcUrls };
