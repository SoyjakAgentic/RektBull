/**
 * Where yield proposals can put money: one list, read by the rates, the
 * positions, the rules, the calls and the risk watcher.
 *
 * Carried over from soyjak-agentic (services/defiVenues.js), whose addresses
 * were copied from each protocol's own published source:
 *   - Aave v3 pools, assets, aTokens and oracles: Aave's address book
 *     (@bgd-labs/aave-address-book, AaveV3Ethereum / AaveV3Base /
 *     AaveV3Arbitrum). Arbitrum's USDC is native USDC, not bridged USDC.e.
 *   - Compound v3 USDC markets: compound-finance/comet, deployments/
 *     {mainnet,base,arbitrum}/usdc/roots.json.
 *   - Spark sUSDC vaults: sparkdotfi/spark-address-registry (SUSDC), vault
 *     source in sparkdotfi/spark-vaults.
 * Checked again onchain on 2 November 2026: every Aave reserve's aToken is
 * the one listed, every Comet's baseToken and every Spark vault's asset() is
 * the chain's USDC, and each Aave oracle prices WETH.
 *
 * Curve 3pool and Uniswap v3, which Soyjak kept only so old positions could
 * be left, aren't carried over: RektBull has no positions there to leave.
 */
const CHAINS = {
  ethereum: { label: 'Ethereum', chainId: 1, explorer: 'https://etherscan.io', aaveOracle: '0x54586be62e3c3580375ae3723c145253060ca0c2' },
  base: { label: 'Base', chainId: 8453, explorer: 'https://basescan.org', aaveOracle: '0x2cc0fc26ed4563a5ce5e8bdcfe1a2878676ae156' },
  arbitrum: { label: 'Arbitrum', chainId: 42161, explorer: 'https://arbiscan.io', aaveOracle: '0xb56c2f0b653b2e0b10c9b928c8580ac5df02c7c7' },
};

const TOKENS = {
  ethereum: {
    USDC: { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, stable: true },
    USDT: { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6, stable: true },
    WETH: { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', decimals: 18, stable: false },
  },
  base: {
    USDC: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, stable: true },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18, stable: false },
  },
  arbitrum: {
    USDC: { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6, stable: true },
    USDT: { address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', decimals: 6, stable: true },
    WETH: { address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', decimals: 18, stable: false },
  },
};

// status: 'open' takes deposits; 'exit_only' can only be left (an admin
// closing a venue would set it here).
const VENUES = [
  { protocol: 'aave-v3', chain: 'ethereum', kind: 'aave', name: 'Aave v3', pool: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', assets: ['USDC', 'USDT', 'WETH'], aTokens: { USDC: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c', USDT: '0x23878914efe38d27c4d67ab83ed1b93a74d4086a', WETH: '0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8' }, status: 'open' },
  { protocol: 'aave-v3', chain: 'base', kind: 'aave', name: 'Aave v3', pool: '0xa238dd80c259a72e81d7e4664a9801593f98d1c5', assets: ['USDC', 'WETH'], aTokens: { USDC: '0x4e65fe4dba92790696d040ac24aa414708f5c0ab', WETH: '0xd4a0e0b9149bcee3c920d2e00b5de09138fd8bb7' }, status: 'open' },
  { protocol: 'aave-v3', chain: 'arbitrum', kind: 'aave', name: 'Aave v3', pool: '0x794a61358d6845594f94dc1db02a252b5b4814ad', assets: ['USDC', 'USDT', 'WETH'], aTokens: { USDC: '0x724dc807b04555b71ed48a6896b6f41593b8c637', USDT: '0x6ab707aca953edaefbc4fd23ba73294241490620', WETH: '0xe50fa9b3c56ffb159cb0fca61f5c9d750e8128c8' }, status: 'open' },

  { protocol: 'compound-v3', chain: 'ethereum', kind: 'comet', name: 'Compound v3 (USDC market)', comet: '0xc3d688b66703497daa19211eedff47f25384cdc3', assets: ['USDC'], status: 'open' },
  { protocol: 'compound-v3', chain: 'base', kind: 'comet', name: 'Compound v3 (USDC market)', comet: '0xb125e6687d4313864e53df431d5425969c15eb2f', assets: ['USDC'], status: 'open' },
  { protocol: 'compound-v3', chain: 'arbitrum', kind: 'comet', name: 'Compound v3 (USDC market)', comet: '0x9c4ec768c28520b50860ea7a15bd7213a9ff58bf', assets: ['USDC'], status: 'open' },

  // USDC in, the Sky Savings Rate out: the vault turns USDC into sUSDS through Sky's PSM.
  { protocol: 'spark-susdc', chain: 'ethereum', kind: 'spark', name: 'Spark sUSDC (Sky Savings Rate)', vault: '0xbc65ad17c5c0a2a4d159fa5a503f4992c7b545fe', assets: ['USDC'], status: 'open' },
  { protocol: 'spark-susdc', chain: 'base', kind: 'spark', name: 'Spark sUSDC (Sky Savings Rate)', vault: '0x3128a0f7f0ea68e7b7c9b00afa7e41045828e858', assets: ['USDC'], status: 'open' },
  { protocol: 'spark-susdc', chain: 'arbitrum', kind: 'spark', name: 'Spark sUSDC (Sky Savings Rate)', vault: '0x940098b108fb7d0a7e374f6eded7760787464609', assets: ['USDC'], status: 'open' },
];

const SPARK_SSR_SOURCE = VENUES.find(v => v.kind === 'spark' && v.chain === 'ethereum').vault;

class YieldRefused extends Error {
  constructor(message, status = 422, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

function chainOf(chain) {
  const c = CHAINS[chain];
  if (!c) throw new YieldRefused(`chain must be one of ${Object.keys(CHAINS).join(', ')}`, 400);
  return c;
}

function tokenOf(chain, asset) {
  const t = TOKENS[chain]?.[String(asset || '').toUpperCase()];
  if (!t) throw new YieldRefused(`${asset} isn't one of the assets on ${chainOf(chain).label} (${Object.keys(TOKENS[chain] || {}).join(', ')})`, 400);
  return t;
}

const venue = (protocol, chain) => VENUES.find(v => v.protocol === protocol && v.chain === chain) || null;

/** The contract a deposit goes to (and that must be approved to take the asset). */
const venueAddress = v => (v.kind === 'aave' ? v.pool : v.kind === 'comet' ? v.comet : v.vault);

/** The token a position is held in: the aToken, the Comet balance, or the vault's shares. */
const positionToken = (v, asset) => (v.kind === 'aave' ? v.aTokens[asset] : v.kind === 'comet' ? v.comet : v.vault);

module.exports = { CHAINS, TOKENS, VENUES, SPARK_SSR_SOURCE, YieldRefused, chainOf, tokenOf, venue, venueAddress, positionToken };
