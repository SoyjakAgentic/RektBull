/**
 * The RektBull Yield Router: try to break every guarantee it makes.
 *
 * Runs on a copy of Base mainnet (baseMainnetFork in hardhat.config.js), so
 * the venues are the real Aave v3, Compound v3 and Spark sUSDC, and the
 * delegation contracts are MetaMask's real deployed ones (v1.3.0).
 *
 * The user is a plain wallet upgraded with EIP-7702. RektBull's session key
 * holds a delegation that may only call the router's deposit, move and
 * withdraw. Each test is something a hacked RektBull (or anyone else) might
 * try, and must fail; or something that must always work (getting out).
 */
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import { network } from 'hardhat';
import { DELEGATOR_CONTRACTS } from '@metamask/delegation-deployments';
import * as abis from '@metamask/delegation-abis';
import * as core from '@metamask/delegation-core';

const { ethers } = await network.create('baseMainnetFork');

const CHAIN_ID = 8453;
const MM = DELEGATOR_CONTRACTS['1.3.0'][CHAIN_ID];
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';
const AAVE_POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
const AUSDC = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';
const AWETH = '0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7';
const COMET = '0xb125E6687d4313864e53df431d5425969c15Eb2F';
const SPARK = '0x3128a0F7f0ea68E7B7c9B00AFa7E41045828e858';
const SSR_ORACLE = '0x65d946e533748A998B1f0E430803e39A6388f7a1';
const KIND = { Aave: 1, Comet: 2, SparkL1: 3, SparkL2: 4 };
const DAY = 24 * 60 * 60;
const usdc = n => ethers.parseUnits(String(n), 6);
const SINGLE_DEFAULT_MODE = ethers.ZeroHash;

const errorIfaces = [];
function decodeError(err) {
  const data = String(err.data || '').match(/0x[0-9a-f]{8,}/i)?.[0] || String(err.message || '').match(/return data: (0x[0-9a-f]+)/i)?.[1];
  if (!data) return null;
  for (const iface of errorIfaces) {
    try { const e = iface.parseError(data); if (e) return `${e.name}(${e.args.join(',')})`; } catch { /* not this one */ }
  }
  return null;
}
async function now() { return (await ethers.provider.getBlock('latest')).timestamp; }
async function advance(seconds) { await ethers.provider.send('evm_increaseTime', [seconds]); await ethers.provider.send('evm_mine', []); }
async function fails(promise, reason) {
  let err = null;
  try { await (await promise).wait?.(); } catch (e) { err = e; }
  assert.ok(err, `expected it to fail${reason ? ` (${reason})` : ''}, but it went through`);
  const text = [err.shortMessage, err.message, err.reason, err.data, err.info?.error?.message, decodeError(err)].filter(Boolean).join(' | ');
  if (reason) assert.match(text, reason, `failed, but for another reason: ${text.slice(0, 400)}`);
  return text;
}

describe('RektBull Yield Router: break-it tests on Base mainnet', function () {
  let funder, user, session, attacker, feeWallet, router, dm, delegation, usdcToken;
  let low, high; // venue ids, by rate at the fork block
  const AAVE = 0, COMP = 1, SPK = 2, AAVE_WETH = 3;

  const fund = addr => ethers.provider.send('hardhat_setBalance', [addr, '0x' + (10n ** 20n).toString(16)]);
  const erc20 = a => new ethers.Contract(a, ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)'], ethers.provider);

  async function signDelegation({ delegate, delegator, caveats, salt }, signer) {
    const domain = { name: 'DelegationManager', version: '1', chainId: CHAIN_ID, verifyingContract: MM.DelegationManager };
    const types = {
      Delegation: [
        { name: 'delegate', type: 'address' }, { name: 'delegator', type: 'address' },
        { name: 'authority', type: 'bytes32' }, { name: 'caveats', type: 'Caveat[]' }, { name: 'salt', type: 'uint256' },
      ],
      Caveat: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }],
    };
    const value = { delegate, delegator, authority: core.ROOT_AUTHORITY, caveats: caveats.map(c => ({ enforcer: c.enforcer, terms: c.terms })), salt };
    return { delegate, delegator, authority: core.ROOT_AUTHORITY, caveats, salt, signature: await signer.signTypedData(domain, types, value) };
  }
  const selectors = () => ['deposit', 'move', 'withdraw'].map(n => router.interface.getFunction(n).selector);
  function yieldCaveats({ expiry, redeemer }) {
    return [
      { enforcer: MM.RedeemerEnforcer, terms: core.createRedeemerTerms({ redeemers: [redeemer] }), args: '0x' },
      { enforcer: MM.TimestampEnforcer, terms: core.createTimestampTerms({ afterThreshold: 0, beforeThreshold: expiry }), args: '0x' },
      { enforcer: MM.AllowedTargetsEnforcer, terms: core.createAllowedTargetsTerms({ targets: [router.target] }), args: '0x' },
      { enforcer: MM.AllowedMethodsEnforcer, terms: core.createAllowedMethodsTerms({ selectors: selectors() }), args: '0x' },
    ];
  }
  function redeem(d, target, data, by = session) {
    const execution = ethers.solidityPacked(['address', 'uint256', 'bytes'], [target, 0, data]);
    return dm.connect(by).redeemDelegations([core.encodeDelegations([d])], [SINGLE_DEFAULT_MODE], [execution], { gasLimit: 3_000_000 });
  }
  const call = (fn, args) => redeem(delegation, router.target, router.interface.encodeFunctionData(fn, args));

  /** The user puts money in a venue themselves (not through the router): how a position elsewhere comes about. */
  async function directDeposit(id, amount) {
    const target = [AAVE_POOL, COMET, SPARK][id];
    await (await usdcToken.connect(user).approve(target, amount)).wait();
    if (id === AAVE) await (await new ethers.Contract(AAVE_POOL, ['function supply(address,uint256,address,uint16)'], user).supply(USDC, amount, user.address, 0)).wait();
    else if (id === COMP) await (await new ethers.Contract(COMET, ['function supply(address,uint256)'], user).supply(USDC, amount)).wait();
    else await (await new ethers.Contract(SPARK, ['function deposit(uint256,address) returns (uint256)'], user).deposit(amount, user.address)).wait();
  }

  before(async function () {
    assert.ok((await ethers.provider.getCode(MM.DelegationManager)).length > 2, 'MetaMask DelegationManager not found on Base');
    [funder] = await ethers.getSigners();
    user = ethers.Wallet.createRandom().connect(ethers.provider);
    session = ethers.Wallet.createRandom().connect(ethers.provider);
    attacker = ethers.Wallet.createRandom().connect(ethers.provider);
    feeWallet = ethers.Wallet.createRandom().address;
    for (const w of [user, session, attacker]) await fund(w.address);
    usdcToken = erc20(USDC);

    // MIN_GAIN_BPS = 1 (0.01 point) so the moves below don't depend on the day's rates; the rule itself is tested with a reversed move.
    router = await (await ethers.getContractFactory('RektBullYieldRouter')).deploy(feeWallet, 10, 1, DAY, [
      { kind: KIND.Aave, target: AAVE_POOL, asset: USDC, position: AUSDC, rateSource: ethers.ZeroAddress },
      { kind: KIND.Comet, target: COMET, asset: USDC, position: COMET, rateSource: ethers.ZeroAddress },
      { kind: KIND.SparkL2, target: SPARK, asset: USDC, position: SPARK, rateSource: SSR_ORACLE },
      { kind: KIND.Aave, target: AAVE_POOL, asset: WETH, position: AWETH, rateSource: ethers.ZeroAddress },
    ]);
    dm = new ethers.Contract(MM.DelegationManager, abis.DelegationManager, ethers.provider);
    errorIfaces.push(dm.interface, new ethers.Interface(abis.EIP7702StatelessDeleGator), router.interface);

    const rates = await Promise.all([AAVE, COMP, SPK].map(i => router.rateOf(i)));
    const order = [AAVE, COMP, SPK].sort((a, b) => (rates[a] < rates[b] ? -1 : 1));
    [low, , high] = order;
    assert.ok(rates.every(r => r > 0n && r < 10n ** 18n), `rates read from the venues themselves (${rates.map(r => ethers.formatUnits(r, 16) + '%').join(', ')})`);

    // 5,000 USDC for the user, from Aave's USDC reserve.
    const reserve = await ethers.getImpersonatedSigner(AUSDC);
    await fund(AUSDC);
    await (await usdcToken.connect(reserve).transfer(user.address, usdc(5000))).wait();

    // 1. The user's wallet becomes a MetaMask smart account (EIP-7702).
    const auth = await user.authorize({ address: MM.EIP7702StatelessDeleGatorImpl, nonce: await user.getNonce(), chainId: CHAIN_ID });
    await (await funder.sendTransaction({ type: 4, to: user.address, data: '0x', authorizationList: [auth], gasLimit: 200000 })).wait();

    // 2. The user's own setup: approvals to the router (it only ever pulls from the caller), Comet's allow, and limits.
    for (const t of [USDC, AUSDC, SPARK]) await (await erc20(t).connect(user).approve(router.target, ethers.MaxUint256)).wait();
    await (await new ethers.Contract(COMET, ['function allow(address,bool)'], user).allow(router.target, true)).wait();
    await (await router.connect(user).setLimits([USDC], [usdc(2000)], (await now()) + 7 * DAY)).wait();

    // 3. The delegation to RektBull's session key: the router's deposit, move and withdraw, nothing else.
    delegation = await signDelegation({ delegate: session.address, delegator: user.address, caveats: yieldCaveats({ expiry: (await now()) + 7 * DAY, redeemer: session.address }), salt: 1n }, user);
  });

  it('works: a deposit lands in the user\'s own position, 0.1% goes to the fee wallet, the router keeps nothing', async function () {
    await (await call('deposit', [high, usdc(1000)])).wait(); // deposits go only to the best-paying venue (or within MIN_GAIN_BPS of it)
    const pos = await router.positionOf(high, user.address);
    assert.ok(pos >= usdc(998.99) && pos <= usdc(999.01), `position ${ethers.formatUnits(pos, 6)}`);
    assert.equal(await usdcToken.balanceOf(feeWallet), usdc(1));
    assert.equal(await usdcToken.balanceOf(router.target), 0n);
  });

  it('works: a move to the better-paying venue, after the interval; the position moves, nothing is left behind', async function () {
    await directDeposit(low, usdc(1000)); // a position the user opened elsewhere themselves
    await fails(call('move', [low, high, ethers.MaxUint256]), /TooSoon/);
    await advance(DAY + 1);
    await (await call('move', [low, high, ethers.MaxUint256])).wait();
    assert.ok(await router.positionOf(low, user.address) <= 1n, 'the old position is empty');
    const pos = await router.positionOf(high, user.address);
    assert.ok(pos >= usdc(1996.9), `moved ${ethers.formatUnits(pos, 6)}`);
    assert.ok(await usdcToken.balanceOf(feeWallet) >= usdc(1.998), 'the move paid 0.1%');
    assert.equal(await usdcToken.balanceOf(router.target), 0n);
  });

  describe('a hacked RektBull cannot take funds', function () {
    it('cannot transfer the user\'s USDC or aTokens, or approve anyone', async function () {
      await fails(redeem(delegation, USDC, usdcToken.interface.encodeFunctionData('transfer', [attacker.address, usdc(1)])), /target|allowed/i);
      await fails(redeem(delegation, AUSDC, usdcToken.interface.encodeFunctionData('transfer', [attacker.address, 1n])), /target|allowed/i);
      await fails(redeem(delegation, USDC, usdcToken.interface.encodeFunctionData('approve', [attacker.address, ethers.MaxUint256])), /target|allowed/i);
    });
    it('cannot call a venue directly (Comet\'s withdrawFrom to itself)', async function () {
      const comet = new ethers.Interface(['function withdrawFrom(address,address,address,uint256)']);
      await fails(redeem(delegation, COMET, comet.encodeFunctionData('withdrawFrom', [user.address, attacker.address, USDC, 1n])), /target|allowed/i);
    });
    it('cannot change the user\'s limits or call revoke on their behalf', async function () {
      await fails(call('setLimits', [[USDC], [usdc(1e9)], (await now()) + 365 * DAY]), /method|allowed/i);
      await fails(call('revoke', []), /method|allowed/i);
    });
    it('cannot use the user\'s approvals for itself: every call acts on the caller only', async function () {
      const before = await router.positionOf(high, user.address);
      await fails(router.connect(attacker).withdraw(high, usdc(10)));
      await fails(router.connect(attacker).move(high, low, usdc(10)));
      await fails(router.connect(attacker).deposit(low, usdc(10)), /LimitsOff/);
      assert.equal(await router.positionOf(high, user.address), before);
      assert.equal(await usdcToken.balanceOf(attacker.address), 0n);
    });
    it('withdrawals only ever pay the user', async function () {
      const before = await usdcToken.balanceOf(user.address);
      await (await call('withdraw', [high, usdc(100)])).wait();
      // At least what was asked. When Aave pays best at the fork block, moving 100 aUSDC can move
      // 1 unit more (Aave's rounding of scaled balances); the router redeems exactly what arrived,
      // so that unit is the user's own and goes to the user too.
      const paid = await usdcToken.balanceOf(user.address) - before;
      assert.ok(paid >= usdc(100) && paid <= usdc(100) + 1n, `paid ${paid}`);
      assert.equal(await usdcToken.balanceOf(attacker.address), 0n);
      assert.equal(await usdcToken.balanceOf(router.target), 0n, 'the router keeps nothing');
    });
  });

  describe('a hacked RektBull cannot churn the user\'s money for fees', function () {
    it('cannot move to a venue that pays less', async function () {
      await advance(DAY + 1);
      await fails(call('move', [high, low, usdc(10)]), /NotBetter/);
    });
    it('cannot move between different assets', async function () {
      await fails(call('move', [high, AAVE_WETH, usdc(10)]), /NotAllowed/);
    });
    it('at most one deposit or move per interval; a deposit soon after a withdrawal through the router pays no fee', async function () {
      const fees = await usdcToken.balanceOf(feeWallet);
      // Into the venue paying best now: the setup's own deposits lower that venue's rate, and on a day
      // two venues pay within a few hundredths of a point, that can put another one ahead of it.
      const rates = await Promise.all([AAVE, COMP, SPK].map(i => router.rateOf(i)));
      const best = [AAVE, COMP, SPK].reduce((a, b) => (rates[b] > rates[a] ? b : a));
      await (await call('deposit', [best, usdc(10)])).wait(); // 100 USDC was withdrawn through the router above
      assert.equal(await usdcToken.balanceOf(feeWallet), fees, 'withdrawing and depositing can\'t churn fees');
      await fails(call('deposit', [best, usdc(10)]), /TooSoon/);
    });
    it('cannot park the user\'s money in a venue paying clearly less than the best (a withdraw, then a deposit)', async function () {
      await advance(DAY + 1);
      const [rl, rh] = [await router.rateOf(low), await router.rateOf(high)];
      assert.ok(rl + (await router.MIN_GAIN_BPS()) * 10n ** 14n < rh, 'the fork block\'s rates are far enough apart');
      await fails(call('deposit', [low, usdc(10)]), /NotBestVenue/);
    });
    it('nothing above the user\'s per-asset limit, nothing in an asset without one', async function () {
      await advance(DAY + 1);
      await fails(call('deposit', [high, usdc(2001)]), /OverLimit/);
      await fails(call('deposit', [AAVE_WETH, 1n]), /OverLimit/);
    });
  });

  describe('the fee is fixed and capped at 0.1%', function () {
    it('only the user\'s own settings and the three permitted calls change anything', async function () {
      assert.equal(await router.FEE_BPS(), 10n);
      assert.equal(await router.FEE_WALLET(), feeWallet);
      const writes = router.interface.fragments.filter(f => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability)).map(f => f.name).sort();
      assert.deepEqual(writes, ['deposit', 'move', 'revoke', 'setLimits', 'withdraw'], 'no function can change the fee, the fee wallet or the venues');
    });
    it('a router with a fee above 0.1% cannot be deployed', async function () {
      const F = await ethers.getContractFactory('RektBullYieldRouter');
      await fails(F.deploy(feeWallet, 11, 100, DAY, [{ kind: KIND.Comet, target: COMET, asset: USDC, position: COMET, rateSource: ethers.ZeroAddress }]), /BadConfig/);
    });
  });

  describe('a hacked RektBull cannot push a borrowing user toward liquidation on Aave', function () {
    const POOL = new ethers.Interface([
      'function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)',
      'function borrow(address,uint256,uint256,uint16,address)', 'function repay(address,uint256,uint256,address) returns (uint256)',
    ]);
    it('refuses a withdrawal that would leave the user\'s Aave health factor under 1.5; allows a small one', async function () {
      // USDC can't back a loan on Aave's Base market (its LTV is 0), so the user borrows against WETH, the usual case.
      const pool = new ethers.Contract(AAVE_POOL, POOL, user);
      const weth = new ethers.Contract(WETH, ['function deposit() payable', 'function approve(address,uint256) returns (bool)'], user);
      await (await weth.deposit({ value: ethers.parseEther('1') })).wait();
      await (await weth.approve(AAVE_POOL, ethers.parseEther('1'))).wait();
      await (await new ethers.Contract(AAVE_POOL, ['function supply(address,uint256,address,uint16)'], user).supply(WETH, ethers.parseEther('1'), user.address, 0)).wait();
      const [collateral, , , lt] = await pool.getUserAccountData(user.address);
      // Borrow USDC so the health factor is about 2 (base units are USD with 8 decimals; USDC is about $1).
      await (await pool.borrow(USDC, collateral * lt / 10_000n / 2n / 100n, 2, 0, user.address)).wait();
      const [, , , , , hf] = await pool.getUserAccountData(user.address);
      assert.ok(hf > 19n * 10n ** 17n && hf < 21n * 10n ** 17n, `health factor about 2 (${ethers.formatUnits(hf, 18)})`);
      // Taking out 30% leaves about 1.4: still above Aave's own 1.0, so Aave would allow it; the router must not.
      const held = await erc20(AWETH).balanceOf(user.address);
      await (await erc20(AWETH).connect(user).approve(router.target, ethers.MaxUint256)).wait();
      await fails(call('withdraw', [AAVE_WETH, held * 30n / 100n]), /UnsafeHealthFactor/);
      // A small withdrawal that keeps it over 1.5 goes through, to the user.
      const before = await erc20(WETH).balanceOf(user.address);
      await (await call('withdraw', [AAVE_WETH, held / 100n])).wait();
      assert.ok(await erc20(WETH).balanceOf(user.address) > before, 'the small withdrawal reached the user');
      const [, , , , , hf2] = await pool.getUserAccountData(user.address);
      assert.ok(hf2 >= 15n * 10n ** 17n, 'still at least 1.5');
      await (await usdcToken.connect(user).approve(AAVE_POOL, ethers.MaxUint256)).wait();
      await (await pool.repay(USDC, ethers.MaxUint256, 2, user.address)).wait();
    });
  });

  describe('getting out is never blocked', function () {
    it('tokens someone sends the router can\'t jam it', async function () {
      const reserve = await ethers.getImpersonatedSigner(AUSDC);
      await (await usdcToken.connect(reserve).transfer(router.target, 1n)).wait();
      await (await call('withdraw', [high, usdc(1)])).wait();
    });
    it('after the user revokes (or limits expire), deposits and moves stop, withdrawals still pay the user', async function () {
      await (await router.connect(user).revoke()).wait();
      await advance(DAY + 1);
      await fails(call('deposit', [high, usdc(10)]), /LimitsOff/);
      await fails(call('move', [low, high, usdc(10)]), /LimitsOff|NotAllowed|NotBetter/);
      const before = await usdcToken.balanceOf(user.address);
      await (await call('withdraw', [high, ethers.MaxUint256])).wait();
      assert.ok(await router.positionOf(high, user.address) <= 1n, 'all of it');
      assert.ok(await usdcToken.balanceOf(user.address) - before > usdc(890), 'back in the user\'s wallet');
    });
    it('the user can always stop RektBull entirely: disabling the delegation ends it', async function () {
      await (await dm.connect(user).disableDelegation(delegation)).wait();
      await fails(call('withdraw', [high, 1n]), /disabled|CannotUseADisabledDelegation/i);
    });
  });
});
