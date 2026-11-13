/**
 * The chains RektBull reads, and the RPC endpoints for each.
 *
 * RPC_URLS_<CHAIN> lists your own endpoints (comma-separated, e.g. an
 * Alchemy free-plan URL first). The public endpoint after them is the last
 * resort: free and keyless, but rate-limited and not for heavy use.
 * `blockscout` is the chain's public Blockscout explorer, used keyless as the
 * explorer of last resort (providers/explorer.js).
 */
const EVM = {
  ethereum: { chainId: 1, goplus: '1', dexscreener: 'ethereum', blockscout: 'eth.blockscout.com', publicRpc: 'https://ethereum-rpc.publicnode.com', probe: '50000000000000000', probeLabel: '0.05 ETH' },
  base:     { chainId: 8453, goplus: '8453', dexscreener: 'base', blockscout: 'base.blockscout.com', publicRpc: 'https://mainnet.base.org', probe: '50000000000000000', probeLabel: '0.05 ETH' },
  arbitrum: { chainId: 42161, goplus: '42161', dexscreener: 'arbitrum', blockscout: 'arbitrum.blockscout.com', publicRpc: 'https://arb1.arbitrum.io/rpc', probe: '50000000000000000', probeLabel: '0.05 ETH' },
  optimism: { chainId: 10, goplus: '10', dexscreener: 'optimism', blockscout: 'optimism.blockscout.com', publicRpc: 'https://mainnet.optimism.io', probe: '50000000000000000', probeLabel: '0.05 ETH' },
  polygon:  { chainId: 137, goplus: '137', dexscreener: 'polygon', blockscout: 'polygon.blockscout.com', publicRpc: 'https://polygon-bor-rpc.publicnode.com', probe: '200000000000000000000', probeLabel: '200 POL' },
  bsc:      { chainId: 56, goplus: '56', dexscreener: 'bsc', publicRpc: 'https://bsc-dataseed.bnbchain.org', probe: '200000000000000000', probeLabel: '0.2 BNB' },
};

const SOLANA = { dexscreener: 'solana', publicRpc: 'https://api.mainnet-beta.solana.com' };

const ALL = [...Object.keys(EVM), 'solana'];

// Chains read only for trading permissions (not token checks): testnets.
const EXTRA_RPC = { 'base-sepolia': 'https://sepolia.base.org' };

// Event logs (eth_getLogs): the public endpoints above refuse them (Base's answers "request limit
// reached", BNB Chain's "limit exceeded"); publicnode's keyless ones answer small ranges (checked
// 13 November 2026). Your own RPC_URLS_<CHAIN> are asked first, as for every call.
const LOGS_RPC = { base: 'https://base-rpc.publicnode.com', bsc: 'https://bsc-rpc.publicnode.com', ethereum: 'https://ethereum-rpc.publicnode.com', arbitrum: 'https://arbitrum-one-rpc.publicnode.com' };

function rpcUrls(chain) {
  const own = String(process.env[`RPC_URLS_${chain.toUpperCase().replace(/-/g, '_')}`] || '').split(',').map(s => s.trim()).filter(Boolean);
  const pub = chain === 'solana' ? SOLANA.publicRpc : EVM[chain]?.publicRpc || EXTRA_RPC[chain];
  return [...own, ...(pub ? [pub] : [])];
}

/** Where to ask for event logs: your own endpoints, then a keyless one that answers them. */
function logsRpcUrls(chain) {
  const own = String(process.env[`RPC_URLS_${chain.toUpperCase().replace(/-/g, '_')}`] || '').split(',').map(s => s.trim()).filter(Boolean);
  return [...new Set([...own, ...(LOGS_RPC[chain] ? [LOGS_RPC[chain]] : rpcUrls(chain).slice(own.length))])];
}

module.exports = { EVM, SOLANA, ALL, rpcUrls, logsRpcUrls, LOGS_RPC };
