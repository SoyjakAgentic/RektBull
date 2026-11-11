/**
 * The RektBull Meme Router: try to break every guarantee it makes (docs/MEME_ROUTER.md).
 *
 * Runs on a blank local chain with stand-in tokens and exchanges. The user signs an order;
 * RektBull's executor key fills it. Each test is something a hacked RektBull (or anyone
 * else) might try, and must fail, or a guarantee that must hold on an honest fill.
 */
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import { network } from 'hardhat';

const { ethers } = await network.create('local');

const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const E18 = 10n ** 18n;
const usdc = n => ethers.parseUnits(String(n), 6);

async function now() { return (await ethers.provider.getBlock('latest')).timestamp; }
async function advance(seconds) { await ethers.provider.send('evm_increaseTime', [seconds]); await ethers.provider.send('evm_mine', []); }

let routerIface;
/** Passes only if the call fails; checks the router's own error when one is named. */
async function fails(promise, reason) {
  let err = null;
  try { await (await promise).wait?.(); } catch (e) { err = e; }
  assert.ok(err, `expected it to fail${reason ? ` (${reason})` : ''}, but it went through`);
  const data = String(err.data || '').match(/0x[0-9a-f]{8,}/i)?.[0];
  let decoded = '';
  try { const e = data && routerIface.parseError(data); if (e) decoded = `${e.name}(${e.args.join(',')})`; } catch { /* not ours */ }
  const text = [decoded, err.shortMessage, err.message, err.reason].filter(Boolean).join(' | ');
  if (reason) assert.match(text, reason, `failed, but for another reason: ${text.slice(0, 400)}`);
  return text;
}

describe('RektBull Meme Router: break-it tests', function () {
  let deployer, user, executor, attacker, feeWallet;
  let USDC, MEME, WNAT, venue, nativeVenue, router, smart;
  let domain;
  const types = {
    Order: [
      { name: 'account', type: 'address' }, { name: 'executor', type: 'address' },
      { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' }, { name: 'minAmountOut', type: 'uint256' },
      { name: 'validAfter', type: 'uint64' }, { name: 'validUntil', type: 'uint64' },
      { name: 'epoch', type: 'uint64' }, { name: 'salt', type: 'uint256' },
    ],
  };
  let salt = 0n;

  /** An order from `account`, signed by `signer`, filled by RektBull's executor unless named. */
  async function order(signer, fields) {
    const t = await now();
    const o = {
      account: signer.address, executor: executor.address, tokenIn: MEME.target, tokenOut: USDC.target,
      amountIn: 1000n * E18, minAmountOut: usdc(95), validAfter: 0, validUntil: t + 86400, epoch: 0, salt: ++salt, ...fields,
    };
    return { o, sig: await signer.signTypedData(domain, types, o) };
  }

  /**
   * A fill through the stand-in exchange, paying `rate` (output units per 1e18 of input) to `to` (the router by default).
   * It trades the whole input when the fee comes off the output (a base asset), else the input less 1%.
   */
  function viaVenue({ amountIn, tokenIn = MEME.target, tokenOut = USDC.target, rate, to = router.target }) {
    const traded = [USDC.target, WNAT.target].includes(tokenOut) ? amountIn : amountIn - amountIn / 100n;
    return { amountIn, venue: venue.target, spender: venue.target, venueCalldata: venue.interface.encodeFunctionData('swap', [tokenIn, tokenOut, traded, rate, to]), unwrapIn: false };
  }
  const PER_1000 = usdc => usdc * E18 / (1000n * E18); // a rate paying `usdc` for 1,000 MEME

  before(async () => {
    [deployer, user, executor, attacker, feeWallet] = await ethers.getSigners();
    USDC = await ethers.deployContract('MockERC20', ['USD Coin', 'USDC', 6]);
    MEME = await ethers.deployContract('MockERC20', ['Meme', 'MEME', 18]);
    WNAT = await ethers.deployContract('MockWrappedNative');
    venue = await ethers.deployContract('MockVenue');
    nativeVenue = await ethers.deployContract('MockNativeVenue');
    router = await ethers.deployContract('RektBullMemeRouter', [feeWallet.address, 100, WNAT.target, [venue.target, nativeVenue.target], [USDC.target, WNAT.target]]);
    routerIface = router.interface;
    domain = { name: 'RektBull Meme Router', version: '1', chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: router.target };
    await MEME.mint(user.address, 100_000n * E18);
    await USDC.mint(user.address, usdc(10_000));
    await MEME.connect(user).approve(router.target, ethers.MaxUint256);
    await USDC.connect(user).approve(router.target, ethers.MaxUint256);
    await deployer.sendTransaction({ to: nativeVenue.target, value: 100n * E18 });
  });

  it('can only be deployed with a fee of at most 1%, to a real fee wallet, with exchanges named', async () => {
    await fails(ethers.deployContract('RektBullMemeRouter', [feeWallet.address, 101, WNAT.target, [venue.target], []]), /BadConfig/);
    await fails(ethers.deployContract('RektBullMemeRouter', [ethers.ZeroAddress, 100, WNAT.target, [venue.target], []]), /BadConfig/);
    await fails(ethers.deployContract('RektBullMemeRouter', [feeWallet.address, 100, WNAT.target, [], []]), /BadConfig/);
    assert.equal(await router.FEE_BPS(), 100n);
  });

  it('a sale for a base asset: the output goes to the user, 1% of it to the fee wallet, at least the user\'s price', async () => {
    const { o, sig } = await order(user, {}); // sell 1,000 MEME for at least 95 USDC after the fee
    const before = { user: await USDC.balanceOf(user.address), fee: await USDC.balanceOf(feeWallet.address), meme: await MEME.balanceOf(user.address) };
    await (await router.connect(executor).fill(o, sig, viaVenue({ amountIn: o.amountIn, rate: PER_1000(usdc(100)) }))).wait();
    const got = (await USDC.balanceOf(user.address)) - before.user;
    const fee = (await USDC.balanceOf(feeWallet.address)) - before.fee;
    assert.deepEqual([got, fee], [usdc(99), usdc(1)], '100 USDC out: 99 to the user, 1 (1%) to the fee wallet');
    assert.equal(before.meme - await MEME.balanceOf(user.address), 1000n * E18);
    assert.deepEqual([await USDC.balanceOf(router.target), await MEME.balanceOf(router.target)], [0n, 0n], 'the router keeps nothing');
    assert.equal(await router.filled(await router.hashOrder(o)), o.amountIn);
  });

  it('a buy with a base asset: 1% of the input to the fee wallet, the tokens to the user', async () => {
    const { o, sig } = await order(user, { tokenIn: USDC.target, tokenOut: MEME.target, amountIn: usdc(100), minAmountOut: 900n * E18 });
    const rate = 10n * E18 * E18 / usdc(1); // 10 MEME per USDC
    const before = { meme: await MEME.balanceOf(user.address), fee: await USDC.balanceOf(feeWallet.address) };
    await (await router.connect(executor).fill(o, sig, viaVenue({ amountIn: o.amountIn, tokenIn: USDC.target, tokenOut: MEME.target, rate }))).wait();
    assert.equal((await MEME.balanceOf(user.address)) - before.meme, 990n * E18, '99 USDC traded at 10 MEME each');
    assert.equal((await USDC.balanceOf(feeWallet.address)) - before.fee, usdc(1));
    assert.equal(await MEME.balanceOf(feeWallet.address), 0n, 'never a fee in the meme coin');
  });

  it('a price below the user\'s own limit is refused (a bad price, a sandwich)', async () => {
    const { o, sig } = await order(user, {}); // at least 95 USDC for 1,000 MEME
    // 95 USDC out, less the 1% fee, is 94.05: below the user's 95.
    await fails(router.connect(executor).fill(o, sig, viaVenue({ amountIn: o.amountIn, rate: PER_1000(usdc(95)) })), /BelowLimit/);
  });

  it('an exchange paying someone else is refused', async () => {
    const { o, sig } = await order(user, {});
    await fails(router.connect(executor).fill(o, sig, viaVenue({ amountIn: o.amountIn, rate: PER_1000(usdc(200)), to: attacker.address })), /BelowLimit\(0,/);
  });

  it('partial fills: pro rata at the user\'s price, never more than the order in all', async () => {
    const { o, sig } = await order(user, {});
    const rate = usdc(100) * E18 / (1000n * E18);
    const part = (amountIn) => ({ amountIn, venue: venue.target, spender: venue.target, venueCalldata: venue.interface.encodeFunctionData('swap', [MEME.target, USDC.target, amountIn, rate, router.target]), unwrapIn: false });
    await (await router.connect(executor).fill(o, sig, part(400n * E18))).wait();
    await (await router.connect(executor).fill(o, sig, part(600n * E18))).wait();
    await fails(router.connect(executor).fill(o, sig, part(1n)), /Overfilled/);
    // A part at a price that's fine for the whole order but not pro rata is refused too.
    const { o: o2, sig: sig2 } = await order(user, {});
    const thin = usdc(40) * E18 / (500n * E18); // 40 USDC for 500 MEME: below 47.5
    await fails(router.connect(executor).fill(o2, sig2, { ...part(500n * E18), venueCalldata: venue.interface.encodeFunctionData('swap', [MEME.target, USDC.target, 500n * E18, thin, router.target]) }), /BelowLimit/);
  });

  it('only the executor the user named can fill it', async () => {
    const { o, sig } = await order(user, {});
    await fails(router.connect(attacker).fill(o, sig, viaVenue({ amountIn: o.amountIn, rate: PER_1000(usdc(100)) })), /NotExecutor/);
  });

  it('a forged or changed order is refused: another account, a lower price, a bigger size', async () => {
    const { o, sig } = await order(user, {});
    const f = viaVenue({ amountIn: o.amountIn, rate: PER_1000(usdc(100)) });
    const forged = await order(attacker, { account: user.address }); // signed by the attacker for the user's account
    await fails(router.connect(executor).fill(forged.o, forged.sig, f), /BadSignature/);
    await fails(router.connect(executor).fill({ ...o, minAmountOut: 1n }, sig, f), /BadSignature/);
    await fails(router.connect(executor).fill({ ...o, amountIn: o.amountIn * 10n }, sig, f), /BadSignature/);
    await fails(router.connect(executor).fill({ ...o, executor: attacker.address }, sig, f), /NotExecutor/);
    await fails(router.connect(attacker).fill({ ...o, executor: attacker.address }, sig, f), /BadSignature/);
  });

  it('a token that taxes transfers: the user\'s price is checked on what reaches their wallet (found by the security review)', async () => {
    const TAX = await ethers.deployContract('MockTaxToken');
    const taxRouter = await ethers.deployContract('RektBullMemeRouter', [feeWallet.address, 100, WNAT.target, [venue.target], [USDC.target]]);
    const taxDomain = { ...domain, verifyingContract: taxRouter.target };
    await (await USDC.connect(user).approve(taxRouter.target, ethers.MaxUint256)).wait();
    const t = await now();
    // Buy with 100 USDC: 99 traded at 10 TAX each = 990 TAX to the router, 940.5 after the 5% tax reach the user.
    const base = { account: user.address, executor: executor.address, tokenIn: USDC.target, tokenOut: TAX.target, amountIn: usdc(100), validAfter: 0, validUntil: t + 3600, epoch: 0 };
    const fillFor = () => ({ amountIn: usdc(100), venue: venue.target, spender: venue.target, unwrapIn: false, venueCalldata: venue.interface.encodeFunctionData('swap', [USDC.target, TAX.target, usdc(99), 10n * E18 * E18 / usdc(1), taxRouter.target]) });
    const tooHigh = { ...base, minAmountOut: 950n * E18, salt: 1n };
    await fails(taxRouter.connect(executor).fill(tooHigh, await user.signTypedData(taxDomain, types, tooHigh), fillFor()), /BelowLimit/);
    const fair = { ...base, minAmountOut: 940n * E18, salt: 2n };
    const before = await TAX.balanceOf(user.address);
    await (await taxRouter.connect(executor).fill(fair, await user.signTypedData(taxDomain, types, fair), fillFor())).wait();
    assert.equal((await TAX.balanceOf(user.address)) - before, 9405n * E18 / 10n);
  });

  it('an order with no minimum is refused: it could be filled at any price (found by the fuzz tests)', async () => {
    const { o, sig } = await order(user, { minAmountOut: 0n });
    await fails(router.connect(executor).fill(o, sig, viaVenue({ amountIn: o.amountIn, rate: 1n })), /NotAllowed/);
  });

  it('outside its window, or cancelled, it can\'t be filled; only the account can cancel its orders', async () => {
    const rate = PER_1000(usdc(100));
    const later = await order(user, { validAfter: (await now()) + 3600 });
    await fails(router.connect(executor).fill(later.o, later.sig, viaVenue({ amountIn: later.o.amountIn, rate })), /NotYetValid/);
    const soon = await order(user, { validUntil: (await now()) + 60 });
    await advance(120);
    await fails(router.connect(executor).fill(soon.o, soon.sig, viaVenue({ amountIn: soon.o.amountIn, rate })), /Expired/);

    const one = await order(user, {});
    await fails(router.connect(attacker).cancel(one.o), /NotAllowed/);
    await (await router.connect(user).cancel(one.o)).wait();
    await fails(router.connect(executor).fill(one.o, one.sig, viaVenue({ amountIn: one.o.amountIn, rate })), /OrderCancelled/);

    const a = await order(user, {});
    const b = await order(user, {});
    await (await router.connect(user).cancelAll()).wait();
    await fails(router.connect(executor).fill(a.o, a.sig, viaVenue({ amountIn: a.o.amountIn, rate })), /OrderCancelled/);
    await fails(router.connect(executor).fill(b.o, b.sig, viaVenue({ amountIn: b.o.amountIn, rate })), /OrderCancelled/);
    // New orders carry the new epoch.
    const c = await order(user, { epoch: 1 });
    await (await router.connect(executor).fill(c.o, c.sig, viaVenue({ amountIn: c.o.amountIn, rate }))).wait();
  });

  it('only exchanges fixed at deployment are called or approved', async () => {
    const { o, sig } = await order(user, { epoch: 1 });
    const f = viaVenue({ amountIn: o.amountIn, rate: PER_1000(usdc(100)) });
    await fails(router.connect(executor).fill(o, sig, { ...f, venue: MEME.target, venueCalldata: MEME.interface.encodeFunctionData('transfer', [attacker.address, 1n]) }), /NotAllowed/);
    await fails(router.connect(executor).fill(o, sig, { ...f, spender: attacker.address }), /NotAllowed/);
  });

  it('an exchange can\'t take more than this fill\'s input', async () => {
    const { o, sig } = await order(user, { epoch: 1 });
    const greedy = { amountIn: o.amountIn, venue: venue.target, spender: venue.target, venueCalldata: venue.interface.encodeFunctionData('greedy', [MEME.target, USDC.target, o.amountIn, PER_1000(usdc(200))]), unwrapIn: false };
    const before = await MEME.balanceOf(user.address);
    await fails(router.connect(executor).fill(o, sig, greedy), /VenueFailed|allowance|ERC20InsufficientAllowance/);
    assert.equal(await MEME.balanceOf(user.address), before, 'nothing moved');
  });

  it('a contract wallet (EIP-1271, like a Safe) signs its orders through its owner; another key can\'t', async () => {
    const owner = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: owner.address, value: E18 });
    smart = await ethers.deployContract('MockSmartAccount', [owner.address]);
    await MEME.mint(smart.target, 1000n * E18);
    await (await smart.connect(owner).exec(MEME.target, MEME.interface.encodeFunctionData('approve', [router.target, ethers.MaxUint256]))).wait();
    const o = { account: smart.target, executor: executor.address, tokenIn: MEME.target, tokenOut: USDC.target, amountIn: 1000n * E18, minAmountOut: usdc(95), validAfter: 0, validUntil: (await now()) + 86400, epoch: 0, salt: ++salt };
    const hash = await router.hashOrder(o);
    const f = viaVenue({ amountIn: o.amountIn, rate: PER_1000(usdc(100)) });
    const other = ethers.Wallet.createRandom();
    await fails(router.connect(executor).fill(o, other.signingKey.sign(hash).serialized, f), /BadSignature/);
    await (await router.connect(executor).fill(o, owner.signingKey.sign(hash).serialized, f)).wait();
    assert.equal(await USDC.balanceOf(smart.target), usdc(99), 'the output went to the contract wallet');
  });

  it('a sale for the native coin: the user gets native, 1% of it to the fee wallet', async () => {
    const { o, sig } = await order(user, { tokenOut: NATIVE, amountIn: 1000n * E18, minAmountOut: E18 * 99n / 100n, epoch: 1 });
    const f = { amountIn: o.amountIn, venue: nativeVenue.target, spender: nativeVenue.target, venueCalldata: nativeVenue.interface.encodeFunctionData('sellForNative', [MEME.target, o.amountIn, E18 / 1000n, router.target]), unwrapIn: false };
    const before = { user: await ethers.provider.getBalance(user.address), fee: await ethers.provider.getBalance(feeWallet.address) };
    await (await router.connect(executor).fill(o, sig, f)).wait(); // the executor pays the gas, not the user
    assert.equal((await ethers.provider.getBalance(user.address)) - before.user, E18 * 99n / 100n);
    assert.equal((await ethers.provider.getBalance(feeWallet.address)) - before.fee, E18 / 100n);
    assert.equal(await ethers.provider.getBalance(router.target), 0n);
  });

  it('a buy paid in wrapped native, sent to the exchange as native; unused native comes back wrapped', async () => {
    await WNAT.connect(user).deposit({ value: 2n * E18 });
    await (await WNAT.connect(user).approve(router.target, ethers.MaxUint256)).wait();
    const { o, sig } = await order(user, { tokenIn: WNAT.target, tokenOut: MEME.target, amountIn: E18, minAmountOut: 800n * E18, epoch: 1 });
    const toTrade = E18 * 99n / 100n;
    const refund = E18 / 10n; // the exchange hands some back
    const f = { amountIn: E18, venue: nativeVenue.target, spender: nativeVenue.target, venueCalldata: nativeVenue.interface.encodeFunctionData('buyWithNative', [MEME.target, 1000n * E18, router.target, refund]), unwrapIn: true };
    const before = { meme: await MEME.balanceOf(user.address), wnat: await WNAT.balanceOf(user.address), fee: await WNAT.balanceOf(feeWallet.address) };
    await (await router.connect(executor).fill(o, sig, f)).wait();
    assert.equal((await MEME.balanceOf(user.address)) - before.meme, (toTrade - refund) * 1000n, 'tokens for the native it used');
    assert.equal(before.wnat - await WNAT.balanceOf(user.address), E18 - refund, 'the unused native came back, wrapped');
    assert.equal((await WNAT.balanceOf(feeWallet.address)) - before.fee, E18 / 100n, '1% of the input, in wrapped native');
    assert.deepEqual([await WNAT.balanceOf(router.target), await ethers.provider.getBalance(router.target)], [0n, 0n]);
    // Unwrapping is only for the wrapped native coin as input.
    const bad = await order(user, { tokenIn: USDC.target, tokenOut: MEME.target, amountIn: usdc(1), minAmountOut: 1n, epoch: 1 });
    await fails(router.connect(executor).fill(bad.o, bad.sig, { ...f, amountIn: usdc(1) }), /NotAllowed/);
  });

  it('can\'t pull from anyone but the order\'s account, even with their approval in place', async () => {
    // The user has approved the router for everything; an order for the attacker's own account can't touch the user's tokens.
    const { o, sig } = await order(attacker, { epoch: 0 });
    const before = await MEME.balanceOf(user.address);
    await fails(router.connect(executor).fill(o, sig, viaVenue({ amountIn: o.amountIn, rate: PER_1000(usdc(100)) })), /ERC20InsufficientAllowance|ERC20InsufficientBalance/);
    assert.equal(await MEME.balanceOf(user.address), before);
  });
});
