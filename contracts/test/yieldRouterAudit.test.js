/**
 * The second AI audit of the Yield Router (Fable 5.2, November 2026): its proofs, kept as regression tests, on a
 * copy of Base mainnet with the parameters of scripts/deployYieldRouter.js (fee 0.1%, MIN_GAIN_BPS 100, one
 * deposit or move a day). Each now checks the fix.
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
const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const KIND = { Aave: 1, Comet: 2, SparkL1: 3, SparkL2: 4 };
const DAY = 24 * 60 * 60;
const usdc = n => ethers.parseUnits(String(n), 6);
const pct = r => ethers.formatUnits(r, 16) + '%';
const SINGLE_DEFAULT_MODE = ethers.ZeroHash;
const AAVE = 0, COMP = 1, SPK = 2, AAVE_WETH = 3;

async function now() { return (await ethers.provider.getBlock('latest')).timestamp; }
async function advance(seconds) { await ethers.provider.send('evm_increaseTime', [seconds]); await ethers.provider.send('evm_mine', []); }
const fund = addr => ethers.provider.send('hardhat_setBalance', [addr, '0x' + (10n ** 20n).toString(16)]);
const erc20 = a => new ethers.Contract(a, ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)'], ethers.provider);

async function reverts(promise, re) {
  let err = null;
  try { await (await promise).wait?.(); } catch (e) { err = e; }
  assert.ok(err, 'expected a revert');
  const text = [err.shortMessage, err.message, err.reason, err.data, err.info?.error?.message].filter(Boolean).join(' | ');
  if (re) assert.match(text, re, text.slice(0, 500));
  return text;
}

describe('Yield Router: the second AI audit\'s findings (Base mainnet fork, deployment parameters)', function () {
  let funder, session, feeWallet, router, dm, usdcToken, reserve;

  async function newUser(amount) {
    const user = ethers.Wallet.createRandom().connect(ethers.provider);
    await fund(user.address);
    if (amount) await (await usdcToken.connect(reserve).transfer(user.address, amount)).wait();
    const auth = await user.authorize({ address: MM.EIP7702StatelessDeleGatorImpl, nonce: await user.getNonce(), chainId: CHAIN_ID });
    await (await funder.sendTransaction({ type: 4, to: user.address, data: '0x', authorizationList: [auth], gasLimit: 200000 })).wait();
    for (const t of [USDC, AUSDC, SPARK, AWETH]) await (await erc20(t).connect(user).approve(router.target, ethers.MaxUint256)).wait();
    await (await new ethers.Contract(COMET, ['function allow(address,bool)'], user).allow(router.target, true)).wait();
    await (await router.connect(user).setLimits([USDC], [usdc(100000)], (await now()) + 30 * DAY)).wait();
    const caveats = [
      { enforcer: MM.RedeemerEnforcer, terms: core.createRedeemerTerms({ redeemers: [session.address] }), args: '0x' },
      { enforcer: MM.TimestampEnforcer, terms: core.createTimestampTerms({ afterThreshold: 0, beforeThreshold: (await now()) + 30 * DAY }), args: '0x' },
      { enforcer: MM.AllowedTargetsEnforcer, terms: core.createAllowedTargetsTerms({ targets: [router.target] }), args: '0x' },
      { enforcer: MM.AllowedMethodsEnforcer, terms: core.createAllowedMethodsTerms({ selectors: ['deposit', 'move', 'withdraw'].map(n => router.interface.getFunction(n).selector) }), args: '0x' },
    ];
    const domain = { name: 'DelegationManager', version: '1', chainId: CHAIN_ID, verifyingContract: MM.DelegationManager };
    const types = {
      Delegation: [{ name: 'delegate', type: 'address' }, { name: 'delegator', type: 'address' }, { name: 'authority', type: 'bytes32' }, { name: 'caveats', type: 'Caveat[]' }, { name: 'salt', type: 'uint256' }],
      Caveat: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }],
    };
    const value = { delegate: session.address, delegator: user.address, authority: core.ROOT_AUTHORITY, caveats: caveats.map(c => ({ enforcer: c.enforcer, terms: c.terms })), salt: 1n };
    const delegation = { ...value, caveats, signature: await user.signTypedData(domain, types, value) };
    return { user, delegation };
  }
  const redeemData = (delegation, fn, args) => dm.interface.encodeFunctionData('redeemDelegations', [
    [core.encodeDelegations([delegation])], [SINGLE_DEFAULT_MODE],
    [ethers.solidityPacked(['address', 'uint256', 'bytes'], [router.target, 0, router.interface.encodeFunctionData(fn, args)])],
  ]);
  const call = (delegation, fn, args) => session.sendTransaction({ to: dm.target, data: redeemData(delegation, fn, args), gasLimit: 3_000_000 });

  before(async function () {
    [funder] = await ethers.getSigners();
    session = ethers.Wallet.createRandom().connect(ethers.provider);
    feeWallet = ethers.Wallet.createRandom().address;
    await fund(session.address);
    usdcToken = erc20(USDC);
    reserve = await ethers.getImpersonatedSigner(AUSDC);
    await fund(AUSDC);
    // As deployed by scripts/deployYieldRouter.js: FEE_BPS 10, MIN_GAIN_BPS 100, MIN_INTERVAL one day.
    router = await (await ethers.getContractFactory('RektBullYieldRouter')).deploy(feeWallet, 10, 100, DAY, [
      { kind: KIND.Aave, target: AAVE_POOL, asset: USDC, position: AUSDC, rateSource: ethers.ZeroAddress },
      { kind: KIND.Comet, target: COMET, asset: USDC, position: COMET, rateSource: ethers.ZeroAddress },
      { kind: KIND.SparkL2, target: SPARK, asset: USDC, position: SPARK, rateSource: SSR_ORACLE },
      { kind: KIND.Aave, target: AAVE_POOL, asset: WETH, position: AWETH, rateSource: ethers.ZeroAddress },
    ]);
    dm = new ethers.Contract(MM.DelegationManager, abis.DelegationManager, ethers.provider);
  });

  it('M-1: a compromised key churning a user every day with a free flash loan gets at most one fee a week', async function () {
    const { user, delegation } = await newUser(usdc(50000));
    // The user's own position, in Aave.
    await (await usdcToken.connect(user).approve(AAVE_POOL, usdc(50000))).wait();
    await (await new ethers.Contract(AAVE_POOL, ['function supply(address,uint256,address,uint16)'], user).supply(USDC, usdc(50000), user.address, 0)).wait();

    // The compromised key puts the attack code on its own address (EIP-7702): it stays "the redeemer".
    const impl = await (await ethers.getContractFactory('AuditFlashChurn')).deploy();
    const auth = await session.authorize({ address: impl.target, nonce: await session.getNonce(), chainId: CHAIN_ID });
    await (await funder.sendTransaction({ type: 4, to: session.address, data: '0x', authorizationList: [auth], gasLimit: 200000 })).wait();
    const self = new ethers.Contract(session.address, impl.interface, session);
    // A cent of the attacker's own USDC for the venues' rounding on its own supply and withdrawal.
    await (await usdcToken.connect(reserve).transfer(session.address, usdc(0.01))).wait();
    const attackerStart = await usdcToken.balanceOf(session.address);

    const morphoHas = await usdcToken.balanceOf(MORPHO);
    console.log(`      Morpho lends ${ethers.formatUnits(morphoHas, 6)} USDC flash, free`);
    const worthStart = await router.positionOf(AAVE, user.address);
    let at = AAVE, refusedPlain = 0, moves = 0;
    const DAYS = 6;
    for (let day = 1; day <= DAYS; day++) {
      await advance(DAY + 1);
      const to = at === AAVE ? COMP : AAVE;
      const [rf, rt] = [await router.rateOf(at), await router.rateOf(to)];
      const data = redeemData(delegation, 'move', [at, to, ethers.MaxUint256]);
      // Without the flash loan: does the router's rule refuse this move?
      let plainRefused = false;
      try { await session.call({ to: dm.target, data, gasLimit: 3_000_000 }); } catch { plainRefused = true; }
      if (plainRefused) refusedPlain++;
      // With it: find a loan size that works (bounded by Aave's supply cap and Morpho's balance).
      let done = false;
      for (const size of [200e6, 100e6, 50e6, 25e6, 10e6, 5e6].map(n => usdc(n)).filter(s => s <= morphoHas)) {
        const args = [MORPHO, USDC, size, at === AAVE ? 1 : 2, at === AAVE ? AAVE_POOL : COMET, dm.target, data];
        try { await self.churn.staticCall(...args, { gasLimit: 6_000_000 }); } catch { continue; }
        await (await self.churn(...args, { gasLimit: 6_000_000 })).wait();
        console.log(`      day ${day}: ${at === AAVE ? 'Aave -> Compound' : 'Compound -> Aave'} (real rates ${pct(rf)} -> ${pct(rt)}; the rule ${plainRefused ? 'REFUSES' : 'allows'} it unaided); flash loan ${ethers.formatUnits(size, 6)} USDC: moved`);
        done = true; moves++;
        break;
      }
      if (!done) console.log(`      day ${day}: no flash size made the move pass (the rates are checked again after the move)`);
      else at = to;
    }
    const worthEnd = await router.positionOf(at, user.address);
    const fees = await usdcToken.balanceOf(feeWallet);
    const attackerCost = attackerStart - await usdcToken.balanceOf(session.address);
    console.log(`      ${moves} moves in ${DAYS} days; the rule refused ${refusedPlain} of them unaided. Fees taken: ${ethers.formatUnits(fees, 6)} USDC of ${ethers.formatUnits(worthStart, 6)} (${(Number(fees) / Number(worthStart) * 100).toFixed(3)}%). Position now ${ethers.formatUnits(worthEnd, 6)}. Attacker's USDC cost: ${attackerCost} units`);
    // Whatever the rates allow on the day (on this copy of Base the rates checked after the move refuse every leg),
    // the fee cooldown is the bound that always holds.
    assert.ok(fees <= worthStart / 1000n + 1n, `at most one 0.1% fee in the week (FEE_COOLDOWN), not one a day: ${ethers.formatUnits(fees, 6)} USDC`);
    assert.equal(await usdcToken.balanceOf(router.target), 0n);
  });

  it('L-2 (the report\'s L-1): the health-factor floor no longer blocks the exit of a position that backs nothing', async function () {
    const { user, delegation } = await newUser(usdc(3000));
    const pool = new ethers.Contract(AAVE_POOL, [
      'function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)',
      'function borrow(address,uint256,uint256,uint16,address)', 'function supply(address,uint256,address,uint16)',
      'function withdraw(address,uint256,address) returns (uint256)', 'function setUserUseReserveAsCollateral(address,bool)',
    ], user);
    const weth = new ethers.Contract(WETH, ['function deposit() payable', 'function approve(address,uint256) returns (bool)'], user);
    await (await weth.deposit({ value: ethers.parseEther('1') })).wait();
    await (await weth.approve(AAVE_POOL, ethers.parseEther('1'))).wait();
    await (await pool.supply(WETH, ethers.parseEther('1'), user.address, 0)).wait();
    // 1,000 USDC supplied to Aave and switched off as collateral (if Aave counts it at all): it backs nothing.
    await (await usdcToken.connect(user).approve(AAVE_POOL, usdc(1000))).wait();
    await (await pool.supply(USDC, usdc(1000), user.address, 0)).wait();
    try { await (await pool.setUserUseReserveAsCollateral(USDC, false)).wait(); } catch { /* already not collateral */ }
    const [collateral, , , lt] = await pool.getUserAccountData(user.address);
    // Borrow against the WETH to a health factor of about 1.4: the user's own choice, and fine by Aave.
    await (await pool.borrow(USDC, collateral * lt / 10_000n * 10n / 14n / 100n, 2, 0, user.address)).wait();
    const hf = (await pool.getUserAccountData(user.address))[5];
    assert.ok(hf > 13n * 10n ** 17n && hf < 15n * 10n ** 17n, `health factor ${ethers.formatUnits(hf, 18)}`);

    // Getting the USDC out through the router (what the service does on a critical warning): it goes through,
    // since it doesn't lower the health factor (one that would, under 1.5, is still refused: yieldRouter.test.js).
    const cash = await usdcToken.balanceOf(user.address);
    await (await call(delegation, 'withdraw', [AAVE, ethers.MaxUint256])).wait();
    assert.ok(await usdcToken.balanceOf(user.address) - cash >= usdc(999), 'the USDC came out to the user');
    const hfAfter = (await pool.getUserAccountData(user.address))[5];
    assert.ok(hfAfter >= hf - 10n ** 15n, 'and the health factor is where it was');
  });

  it('L-3 (the report\'s L-2): a one-unit withdrawal makes only one unit fee-free', async function () {
    const { user } = await newUser(usdc(60000));
    const best = [AAVE, COMP, SPK].sort((a, b) => 0)[0];
    const rates = await Promise.all([AAVE, COMP, SPK].map(i => router.rateOf(i)));
    const top = [AAVE, COMP, SPK].reduce((a, b) => (rates[b] > rates[a] ? b : a), best);
    await (await router.connect(user).deposit(top, usdc(100))).wait(); // pays 0.1 USDC
    await advance(8 * DAY); // past the fee cooldown
    await (await router.connect(user).withdraw(top, 1n)).wait(); // one millionth of a dollar out
    await advance(DAY + 1);
    const fees = await usdcToken.balanceOf(feeWallet);
    await (await router.connect(user).deposit(top, usdc(50000))).wait();
    assert.equal(await usdcToken.balanceOf(feeWallet) - fees, (usdc(50000) - 1n) * 10n / 10_000n, 'the fee on all but the one unit put back');
    // Putting back what was withdrawn, within the window: free.
    await advance(8 * DAY);
    const cash = await usdcToken.balanceOf(user.address);
    await (await router.connect(user).withdraw(top, usdc(1000))).wait();
    const back = await usdcToken.balanceOf(user.address) - cash;
    await advance(DAY + 1);
    const fees2 = await usdcToken.balanceOf(feeWallet);
    await (await router.connect(user).deposit(top, back)).wait();
    assert.equal(await usdcToken.balanceOf(feeWallet), fees2, 'no fee on putting back what came out');
  });
});
