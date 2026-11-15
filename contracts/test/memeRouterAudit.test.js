/**
 * The second AI audit of the Meme Router (Fable 5.2, November 2026): its proofs, kept as regression tests. Each
 * attack that was fixed must now fail; M-2 (a hacked executor fills a floor order at its floor) is the documented
 * worst case and stays as a test of that bound.
 */
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import { network } from 'hardhat';

const { ethers } = await network.create('local');
const E18 = 10n ** 18n;
const usdc = n => ethers.parseUnits(String(n), 6);
const now = async () => (await ethers.provider.getBlock('latest')).timestamp;
const types = { Order: [['account', 'address'], ['executor', 'address'], ['tokenIn', 'address'], ['tokenOut', 'address'], ['amountIn', 'uint256'], ['minAmountOut', 'uint256'], ['validAfter', 'uint64'], ['validUntil', 'uint64'], ['epoch', 'uint64'], ['salt', 'uint256']].map(([name, type]) => ({ name, type })) };
const reverts = async (p, name) => assert.rejects(p, e => new RegExp(name).test(e.message + JSON.stringify(e.data || '')));

describe('Meme Router: the second AI audit\'s findings', () => {
  let deployer, user, executor, attacker, feeWallet, USDC, MEME, WNAT, split, chainId;
  const dom = r => ({ name: 'RektBull Meme Router', version: '1', chainId, verifyingContract: r.target });
  const deploy = (venues, bases = [USDC.target, WNAT.target]) => ethers.deployContract('RektBullMemeRouter', [feeWallet.address, 100, WNAT.target, venues, bases]);
  before(async () => {
    [deployer, user, executor, attacker, feeWallet] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;
    USDC = await ethers.deployContract('MockERC20', ['USD Coin', 'USDC', 6]);
    MEME = await ethers.deployContract('MockERC20', ['Meme', 'MEME', 18]);
    WNAT = await ethers.deployContract('MockWrappedNative');
    split = await ethers.deployContract('AuditSplitVenue');
    await deployer.sendTransaction({ to: split.target, value: E18 });
  });

  it('M-1: a token can\'t be a venue (the wrapped native or a base asset), and an order can\'t trade a venue', async () => {
    const Router = await ethers.getContractFactory('RektBullMemeRouter');
    await reverts(Router.deploy(feeWallet.address, 100, WNAT.target, [split.target, WNAT.target], [USDC.target]), 'BadConfig');
    await reverts(Router.deploy(feeWallet.address, 100, WNAT.target, [split.target, USDC.target], [USDC.target]), 'BadConfig');
    // A token wrongly listed as a venue (not one the constructor can recognise): orders for it are refused.
    const JUNK = await ethers.deployContract('MockERC20', ['Junk', 'JUNK', 18]);
    const router = await deploy([split.target, JUNK.target]);
    await JUNK.mint(user.address, 10n * E18); await JUNK.connect(user).approve(router.target, ethers.MaxUint256);
    await MEME.mint(attacker.address, 1n); await MEME.connect(attacker).approve(router.target, 1n);
    const o = { account: attacker.address, executor: attacker.address, tokenIn: MEME.target, tokenOut: JUNK.target, amountIn: 1n, minAmountOut: 1n, validAfter: 0, validUntil: (await now()) + 3600, epoch: 0, salt: 1 };
    const f = { amountIn: 1n, venue: JUNK.target, spender: split.target, unwrapIn: false, minAmountOut: 0n, venueCalldata: JUNK.interface.encodeFunctionData('transferFrom', [user.address, router.target, 10n * E18]) };
    await reverts(router.connect(attacker).fill(o, await attacker.signTypedData(dom(router), types, o), f), 'NotAllowed');
    assert.equal(await JUNK.balanceOf(user.address), 10n * E18, 'the bystander kept everything they approved');
  });

  it('M-2 (documented worst case): a hacked executor can fill a stop-loss at its floor, never below it', async () => {
    const router = await deploy([split.target]);
    await MEME.mint(user.address, 1000n * E18); await MEME.connect(user).approve(router.target, ethers.MaxUint256);
    const o = { account: user.address, executor: executor.address, tokenIn: MEME.target, tokenOut: USDC.target, amountIn: 1000n * E18, minAmountOut: usdc(70), validAfter: 0, validUntil: (await now()) + 86400, epoch: 0, salt: 2 };
    const sig = await user.signTypedData(dom(router), types, o);
    const call = (toUser, toAttacker) => ({ amountIn: o.amountIn, venue: split.target, spender: split.target, unwrapIn: false, minAmountOut: 0n,
      venueCalldata: split.interface.encodeFunctionData('swapSplit', [MEME.target, USDC.target, o.amountIn, router.target, toUser, attacker.address, toAttacker]) });
    await reverts(router.connect(executor).fill(o, sig, call(usdc(70), usdc(30))), 'BelowLimit'); // 70 less the fee: under the floor
    const toRouter = usdc(70) * 10000n / 9900n + 1n;
    await (await router.connect(executor).fill(o, sig, call(toRouter, usdc(100) - toRouter))).wait();
    assert.ok(await USDC.balanceOf(user.address) >= usdc(70), 'the user got at least their floor');
  });

  it('L-1: an account that gains code after signing (EIP-7702) keeps the orders its key signed', async () => {
    const router = await deploy([split.target]);
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: w.address, value: E18 });
    await MEME.mint(w.address, 1000n * E18); await MEME.connect(w).approve(router.target, ethers.MaxUint256);
    const o = { account: w.address, executor: executor.address, tokenIn: MEME.target, tokenOut: USDC.target, amountIn: 1000n * E18, minAmountOut: usdc(70), validAfter: 0, validUntil: (await now()) + 86400, epoch: 0, salt: 3 };
    const sig = await w.signTypedData(dom(router), types, o);
    const f = { amountIn: o.amountIn, venue: split.target, spender: split.target, unwrapIn: false, minAmountOut: 0n, venueCalldata: split.interface.encodeFunctionData('swapSplit', [MEME.target, USDC.target, o.amountIn, router.target, usdc(100), attacker.address, 0]) };
    const noSig = await ethers.deployContract('AuditNoSig');
    await ethers.provider.send('hardhat_setCode', [w.address, await ethers.provider.getCode(noSig.target)]);
    await router.connect(executor).fill.staticCall(o, sig, f); // still fillable
    const other = ethers.Wallet.createRandom();
    await reverts(router.connect(executor).fill.staticCall(o, await other.signTypedData(dom(router), types, o), f), 'BadSignature');
  });

  it('L-2: native coin a venue hands back goes to the account (wrapped); the router keeps nothing', async () => {
    const router = await deploy([split.target]);
    await MEME.mint(user.address, 1000n * E18); await MEME.connect(user).approve(router.target, ethers.MaxUint256);
    const o = { account: user.address, executor: executor.address, tokenIn: MEME.target, tokenOut: USDC.target, amountIn: 1000n * E18, minAmountOut: usdc(70), validAfter: 0, validUntil: (await now()) + 86400, epoch: 0, salt: 4 };
    const f = { amountIn: o.amountIn, venue: split.target, spender: split.target, unwrapIn: false, minAmountOut: 0n, venueCalldata: split.interface.encodeFunctionData('swapWithNativeRebate', [MEME.target, USDC.target, o.amountIn, usdc(100), E18 / 10n]) };
    const before = await WNAT.balanceOf(user.address);
    await (await router.connect(executor).fill(o, await user.signTypedData(dom(router), types, o), f)).wait();
    assert.equal(await ethers.provider.getBalance(router.target), 0n);
    assert.equal(await WNAT.balanceOf(user.address) - before, E18 / 10n, 'the rebate reached the account, wrapped');
  });

  it('L-3: the executor\'s own minimum is enforced on top of the user\'s', async () => {
    const router = await deploy([split.target]);
    await MEME.mint(user.address, 1000n * E18); await MEME.connect(user).approve(router.target, ethers.MaxUint256);
    const o = { account: user.address, executor: executor.address, tokenIn: MEME.target, tokenOut: USDC.target, amountIn: 1000n * E18, minAmountOut: usdc(70), validAfter: 0, validUntil: (await now()) + 86400, epoch: 0, salt: 5 };
    const f = { amountIn: o.amountIn, venue: split.target, spender: split.target, unwrapIn: false, minAmountOut: usdc(99), venueCalldata: split.interface.encodeFunctionData('swapSplit', [MEME.target, USDC.target, o.amountIn, router.target, usdc(90), attacker.address, usdc(10)]) };
    await reverts(router.connect(executor).fill(o, await user.signTypedData(dom(router), types, o), f), 'BelowLimit'); // 89.1 after the fee: over the user's 70, under the fill's 99
  });
});
