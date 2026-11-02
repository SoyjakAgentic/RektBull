/**
 * Deploys the RektBull Trade Router to Base Sepolia, then runs one real
 * delegated trade through it and one attack that must fail:
 *
 *   DEPLOYER_PRIVATE_KEY=0x... npm run deploy:base-sepolia
 *
 * Testnet only. The deployer needs about 0.01 Base Sepolia ETH. Tokens, price
 * feeds and the exchange are test mocks (testnets have no real liquidity);
 * the delegation contracts are MetaMask's real deployed ones. Addresses are
 * written to deployments/base-sepolia.json.
 *
 * The test user and session key are throwaway wallets made by this script.
 */
import fs from 'node:fs';
import path from 'node:path';
import { network } from 'hardhat';
import { DELEGATOR_CONTRACTS } from '@metamask/delegation-deployments';
import * as abis from '@metamask/delegation-abis';
import * as core from '@metamask/delegation-core';

// The network chosen with --network (default: a local copy of Base Sepolia).
const { ethers } = await network.create();

const CHAIN_ID = 84532;
const MM = DELEGATOR_CONTRACTS['1.3.0'][CHAIN_ID];
const DAY = 86400;

async function main() {
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) throw new Error(`refusing to run on chain ${net.chainId}: this script is for Base Sepolia only`);
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error('set DEPLOYER_PRIVATE_KEY');
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`deployer ${deployer.address}, balance ${ethers.formatEther(bal)} ETH`);
  if (bal < ethers.parseEther('0.005')) throw new Error('the deployer needs at least 0.005 Base Sepolia ETH');

  const wait = async tx => (await tx).wait();
  const deploy = async (name, args = []) => {
    const c = await (await ethers.getContractFactory(name)).deploy(...args);
    await c.waitForDeployment();
    console.log(`${name.padEnd(20)} ${c.target}`);
    return c;
  };

  // ── Deploy ──
  const feeWallet = process.env.FEE_WALLET || deployer.address; // testnet: the deployer collects the test fees
  const USDC = await deploy('MockERC20', ['Test USD Coin', 'tUSDC', 6]);
  const WETH = await deploy('MockERC20', ['Test Wrapped Ether', 'tWETH', 18]);
  const usdcFeed = await deploy('MockFeed', [8, 100000000n]);
  const wethFeed = await deploy('MockFeed', [8, 300000000000n]);
  const venue = await deploy('MockVenue');
  const router = await deploy('RektBullTradeRouter', [
    feeWallet, 100, 200, ethers.ZeroAddress,
    [venue.target], [USDC.target, WETH.target], [usdcFeed.target, wethFeed.target], [DAY, DAY],
  ]);

  // ── A test user upgrades to a MetaMask smart account (EIP-7702), sets limits, grants a delegation ──
  const user = ethers.Wallet.createRandom().connect(ethers.provider);
  const session = ethers.Wallet.createRandom().connect(ethers.provider);
  await wait(deployer.sendTransaction({ to: user.address, value: ethers.parseEther('0.001') }));
  await wait(deployer.sendTransaction({ to: session.address, value: ethers.parseEther('0.001') }));

  const auth = await user.authorize({ address: MM.EIP7702StatelessDeleGatorImpl, nonce: await user.getNonce(), chainId: CHAIN_ID });
  const upgrade = await wait(deployer.sendTransaction({ type: 4, to: user.address, data: '0x', authorizationList: [auth], gasLimit: 200000 }));
  console.log(`EIP-7702 upgrade      ${upgrade.hash}`);

  await wait(USDC.mint(user.address, ethers.parseUnits('1000', 6)));
  await wait(USDC.connect(user).approve(router.target, ethers.MaxUint256));
  const now = (await ethers.provider.getBlock('latest')).timestamp;
  const expiry = now + 7 * DAY;
  await wait(router.connect(user).setLimits(500n * 10n ** 8n, 10000n * 10n ** 8n, DAY, expiry)); // the defaults: $500 a trade, $10,000 a day

  const caveats = [
    { enforcer: MM.RedeemerEnforcer, terms: core.createRedeemerTerms({ redeemers: [session.address] }), args: '0x' },
    { enforcer: MM.TimestampEnforcer, terms: core.createTimestampTerms({ afterThreshold: 0, beforeThreshold: expiry }), args: '0x' },
    { enforcer: MM.AllowedTargetsEnforcer, terms: core.createAllowedTargetsTerms({ targets: [router.target] }), args: '0x' },
    { enforcer: MM.AllowedMethodsEnforcer, terms: core.createAllowedMethodsTerms({ selectors: [router.interface.getFunction('swap').selector] }), args: '0x' },
  ];
  const signature = await user.signTypedData(
    { name: 'DelegationManager', version: '1', chainId: CHAIN_ID, verifyingContract: MM.DelegationManager },
    {
      Delegation: [{ name: 'delegate', type: 'address' }, { name: 'delegator', type: 'address' }, { name: 'authority', type: 'bytes32' }, { name: 'caveats', type: 'Caveat[]' }, { name: 'salt', type: 'uint256' }],
      Caveat: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }],
    },
    { delegate: session.address, delegator: user.address, authority: core.ROOT_AUTHORITY, caveats: caveats.map(c => ({ enforcer: c.enforcer, terms: c.terms })), salt: 1n },
  );
  const delegation = { delegate: session.address, delegator: user.address, authority: core.ROOT_AUTHORITY, caveats, salt: 1n, signature };
  const dm = new ethers.Contract(MM.DelegationManager, abis.DelegationManager, session);
  const redeem = (target, data) => [[core.encodeDelegations([delegation])], [ethers.ZeroHash], [ethers.solidityPacked(['address', 'uint256', 'bytes'], [target, 0, data])]];

  // ── One real delegated trade: $50 of tUSDC to tWETH, sent by RektBull's session key ──
  const rate = 10n ** 30n / 3000n;
  const amountIn = ethers.parseUnits('50', 6);
  const swapData = router.interface.encodeFunctionData('swap', [{
    tokenIn: USDC.target, tokenOut: WETH.target, amountIn, minAmountOut: 0n,
    venue: venue.target, spender: venue.target,
    venueCalldata: venue.interface.encodeFunctionData('swap', [USDC.target, WETH.target, amountIn * 99n / 100n, rate, router.target]),
    deadline: now + 3600,
  }]);
  const trade = await wait(dm.redeemDelegations(...redeem(router.target, swapData)));
  console.log(`delegated trade       ${trade.hash}`);
  console.log(`  user got ${ethers.formatEther(await WETH.balanceOf(user.address))} tWETH; fee wallet got ${ethers.formatUnits(await USDC.balanceOf(feeWallet), 6)} tUSDC`);

  // ── One attack, simulated (no gas spent): the session key tries to take the user's tUSDC ──
  let refused = null;
  try {
    await dm.redeemDelegations.staticCall(...redeem(USDC.target, USDC.interface.encodeFunctionData('transfer', [session.address, amountIn])));
  } catch (e) { refused = e.shortMessage || e.message; }
  console.log(`attack (take tUSDC)   ${refused ? `refused: ${refused.slice(0, 120)}` : 'NOT REFUSED - stop and investigate'}`);
  if (!refused) process.exitCode = 1;

  const out = {
    chainId: CHAIN_ID, deployedAt: new Date().toISOString(), deployer: deployer.address, feeWallet,
    metamaskDelegationFramework: '1.3.0', delegationManager: MM.DelegationManager, eip7702Delegator: MM.EIP7702StatelessDeleGatorImpl,
    contracts: { router: router.target, testUSDC: USDC.target, testWETH: WETH.target, usdcFeed: usdcFeed.target, wethFeed: wethFeed.target, mockVenue: venue.target },
    demo: { user: user.address, sessionKey: session.address, upgradeTx: upgrade.hash, tradeTx: trade.hash, attackRefused: !!refused },
  };
  const file = path.join(import.meta.dirname, '..', 'deployments', process.env.DEPLOY_OUT || 'base-sepolia.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nwritten to deployments/${path.basename(file)}\nexplorer: https://sepolia.basescan.org/address/${router.target}`);
}

main().catch(err => { console.error(err); process.exit(1); });
