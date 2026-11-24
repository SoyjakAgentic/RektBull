/**
 * The order service's own orders and calls (src/trade/memeOrderTx.js) against the Meme Router itself,
 * on a blank local chain with stand-in tokens and an exchange: the EIP-712 order the user's wallet
 * signs hashes as the router hashes it; the executor's fill, the user's approval, cancel and
 * cancel-all, encoded by the service, do what they say; the Filled event reads back.
 * So the service's layouts can't drift from the contract's.
 */
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import { createRequire } from 'node:module';
import { network } from 'hardhat';

const require = createRequire(import.meta.url);
const tx = require('../../src/trade/memeOrderTx.js');
const { ethers } = await network.create('local');
const E18 = 10n ** 18n;

describe('the order service\'s orders and calls, against the Meme Router', () => {
  let user, executor, feeWallet, MEME, USDC, WNAT, venue, router, chainId;
  before(async () => {
    [, user, executor, feeWallet] = await ethers.getSigners();
    MEME = await ethers.deployContract('MockERC20', ['Meme', 'MEME', 18]);
    USDC = await ethers.deployContract('MockERC20', ['USD Coin', 'USDC', 6]);
    WNAT = await ethers.deployContract('MockWrappedNative');
    venue = await ethers.deployContract('MockVenue');
    router = await ethers.deployContract('RektBullMemeRouter', [feeWallet.address, 100, WNAT.target, [venue.target], [USDC.target, WNAT.target]]);
    chainId = (await ethers.provider.getNetwork()).chainId;
    await MEME.mint(user.address, 10_000n * E18);
  });
  const now = async () => (await ethers.provider.getBlock('latest')).timestamp;
  const send = async (signer, call) => (await signer.sendTransaction({ to: call.to, data: call.data, value: BigInt(call.value || 0) })).wait();

  it('signs, approves and fills a sale for a base coin as the service builds them; the Filled event reads back', async () => {
    const o = tx.order({ account: user.address, executor: executor.address, tokenIn: MEME.target, tokenOut: USDC.target, amountIn: 1000n * E18, minAmountOut: 500_000n, validUntil: (await now()) + 3600, epoch: await router.epochOf(user.address), salt: 7n });
    const td = tx.typedData(chainId, router.target, o);
    const { EIP712Domain, ...types } = td.types;
    assert.ok(EIP712Domain.length === 4);
    const signature = await user.signTypedData(td.domain, types, td.message);
    assert.equal(tx.hash(chainId, router.target, o), await router.hashOrder(o), 'the service\'s hash is the router\'s');
    assert.equal(tx.signer(chainId, router.target, o, signature), user.address);
    // The approval, for exactly the order's coins.
    await send(user, tx.approveCall(MEME.target, router.target, o.amountIn));
    assert.equal(await MEME.allowance(user.address, router.target), o.amountIn);
    // The stand-in exchange pays 1 USDC per 1,000 MEME to the router; the fee (on the output, a base coin) is 1%.
    const venueCalldata = venue.interface.encodeFunctionData('swap', [MEME.target, USDC.target, o.amountIn, 1000n, router.target]);
    const call = tx.fillCall(router.target, o, signature, { amountIn: o.amountIn, venue: venue.target, spender: venue.target, venueCalldata, unwrapIn: false, minAmountOut: 0n });
    const before = await USDC.balanceOf(user.address);
    const receipt = await send(executor, call);
    assert.equal((await USDC.balanceOf(user.address)) - before, 990_000n, '99% to the user');
    assert.equal(await USDC.balanceOf(feeWallet.address), 10_000n, '1% to the fee wallet');
    const [ev] = tx.filledEvents(receipt.logs, router.target, user.address);
    assert.deepEqual([ev.orderHash, ev.amountIn, ev.fee, ev.feeOnOutput, ev.amountOut], [await router.hashOrder(o), o.amountIn, 10_000n, true, 990_000n]);
    assert.equal(tx.minimumFor(o.minAmountOut, o.amountIn / 2n, o.amountIn), o.minAmountOut / 2n);
  });

  it('a fill below the user\'s price fails with BelowLimit, read by the service', async () => {
    const o = tx.order({ account: user.address, executor: executor.address, tokenIn: MEME.target, tokenOut: USDC.target, amountIn: 1000n * E18, minAmountOut: 5_000_000n, validUntil: (await now()) + 3600, epoch: 0n, salt: 8n });
    const td = tx.typedData(chainId, router.target, o);
    const { EIP712Domain: _d, ...types } = td.types;
    const signature = await user.signTypedData(td.domain, types, td.message);
    await send(user, tx.approveCall(MEME.target, router.target, o.amountIn));
    const venueCalldata = venue.interface.encodeFunctionData('swap', [MEME.target, USDC.target, o.amountIn, 1000n, router.target]);
    const call = tx.fillCall(router.target, o, signature, { amountIn: o.amountIn, venue: venue.target, spender: venue.target, venueCalldata, unwrapIn: false, minAmountOut: 0n });
    let err = null;
    try { await ethers.provider.call({ from: executor.address, ...call }); } catch (e) { err = e; }
    const why = tx.routerError(err?.data || err?.info?.error?.data || err?.message);
    assert.equal(why?.name, 'BelowLimit');
  });

  it('the user\'s cancel and cancel-all, as the service builds them, stop fills', async () => {
    const mk = async salt => {
      const o = tx.order({ account: user.address, executor: executor.address, tokenIn: MEME.target, tokenOut: USDC.target, amountIn: E18, minAmountOut: 1n, validUntil: (await now()) + 3600, epoch: await router.epochOf(user.address), salt });
      return o;
    };
    const a = await mk(9n);
    await send(user, tx.cancelCall(router.target, a));
    assert.equal(await router.cancelled(await router.hashOrder(a)), true);
    const b = await mk(10n);
    await send(user, tx.cancelAllCall(router.target));
    assert.equal(await router.epochOf(user.address), b.epoch + 1n, 'every order signed before is dead');
    // Wrapping, for a limit buy: the user's own native coin into the wrapped coin.
    const w0 = await WNAT.balanceOf(user.address);
    await send(user, tx.wrapCall(WNAT.target, E18));
    assert.equal((await WNAT.balanceOf(user.address)) - w0, E18);
  });
});
