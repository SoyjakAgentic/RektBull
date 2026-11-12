import { defineConfig } from 'hardhat/config';
import hardhatEthers from '@nomicfoundation/hardhat-ethers';
import hardhatNodeTestRunner from '@nomicfoundation/hardhat-node-test-runner';

const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const BASE_MAINNET_RPC = process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org';
// Frame (frame.sh) signs with the hardware wallet connected to it; it never hands out a key.
const FRAME_RPC = process.env.FRAME_RPC_URL || 'http://127.0.0.1:1248';
const ETHEREUM_RPC = process.env.ETHEREUM_RPC_URL || 'https://ethereum-rpc.publicnode.com';
const ARBITRUM_RPC = process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc';
// Each chain the Trade Router is deployed on: a local copy (rehearsals and tests), the
// hardware wallet through Frame (the deployment), and read-only (verification).
const routerChain = (name, chainId, url) => ({
  [`${name}MainnetFork`]: { type: 'edr-simulated', chainType: 'l1', hardfork: 'prague', chainId, forking: { url } },
  [name]: { type: 'http', url: FRAME_RPC, chainId, accounts: 'remote' },
  [`${name}Read`]: { type: 'http', url, chainId, accounts: [] },
});

export default defineConfig({
  plugins: [hardhatEthers, hardhatNodeTestRunner],
  solidity: {
    version: '0.8.24',
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun' },
  },
  networks: {
    // Tests run on a copy of Base Sepolia, against MetaMask's real deployed contracts.
    default: {
      type: 'edr-simulated',
      chainType: 'l1',
      hardfork: 'prague', // EIP-7702
      chainId: 84532,
      forking: { url: BASE_SEPOLIA_RPC },
    },
    // The Yield Router's tests run on a copy of Base mainnet, against the real Aave, Compound and Spark.
    baseMainnetFork: {
      type: 'edr-simulated',
      chainType: 'l1',
      hardfork: 'prague',
      chainId: 8453,
      forking: { url: BASE_MAINNET_RPC },
    },
    // A blank local chain (no fork), for tests that need nothing deployed: the Meme Router's break-it tests.
    local: { type: 'edr-simulated', chainType: 'l1', hardfork: 'prague', chainId: 31337 },
    // A copy of BNB Chain, for checking four.meme's bonding-curve calls (scripts/fourMemeCheck.js). No router is deployed there.
    bscMainnetFork: {
      type: 'edr-simulated',
      chainType: 'l1',
      hardfork: 'prague',
      chainId: 56,
      forking: { url: process.env.BSC_RPC_URL || 'https://bsc-rpc.publicnode.com' },
    },
    ...routerChain('ethereum', 1, ETHEREUM_RPC),
    ...routerChain('arbitrum', 42161, ARBITRUM_RPC),
    baseSepolia: {
      type: 'http',
      url: BASE_SEPOLIA_RPC,
      chainId: 84532,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    // Base mainnet deployment: every signature is made on the hardware wallet behind Frame.
    // There is deliberately no way to give this network a private key (scripts/deployRouter.js).
    base: {
      type: 'http',
      url: FRAME_RPC,
      chainId: 8453,
      accounts: 'remote',
    },
    // Base mainnet, read only: for scripts/verifyRouter.js, which needs no wallet.
    baseRead: {
      type: 'http',
      url: BASE_MAINNET_RPC,
      chainId: 8453,
      accounts: [],
    },
  },
});
