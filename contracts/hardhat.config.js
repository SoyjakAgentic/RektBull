require('@nomicfoundation/hardhat-ethers');

const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';

module.exports = {
  solidity: {
    version: '0.8.24',
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun' },
  },
  networks: {
    hardhat: {
      hardfork: 'prague', // EIP-7702
      // Tests run on a copy of Base Sepolia, against MetaMask's real deployed contracts.
      forking: { url: BASE_SEPOLIA_RPC },
      chainId: 84532,
    },
    baseSepolia: {
      url: BASE_SEPOLIA_RPC,
      chainId: 84532,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  mocha: { timeout: 300000 },
};
