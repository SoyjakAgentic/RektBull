import { defineConfig } from 'hardhat/config';
import hardhatEthers from '@nomicfoundation/hardhat-ethers';
import hardhatNodeTestRunner from '@nomicfoundation/hardhat-node-test-runner';

const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';

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
    baseSepolia: {
      type: 'http',
      url: BASE_SEPOLIA_RPC,
      chainId: 84532,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
});
