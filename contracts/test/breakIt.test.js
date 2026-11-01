/**
 * Milestone 0: try to break every guarantee in docs/SESSION_KEYS.md.
 *
 * Runs on a copy of Base Sepolia (see hardhat.config.js), so the delegation
 * contracts are MetaMask's real deployed ones, not copies:
 * DelegationManager, EIP7702StatelessDeleGator, and the Redeemer, Timestamp,
 * AllowedTargets and AllowedMethods enforcers (v1.3.0).
 *
 * The user is a plain wallet upgraded with EIP-7702. RektBull's session key
 * holds a delegation from it. Each test below is something a hacked RektBull
 * (or anyone else) might try, and must fail.
 */
const assert = require('node:assert/strict');
const hre = require('hardhat');
const { ethers } = hre;
const { DELEGATOR_CONTRACTS } = require('@metamask/delegation-deployments');
const abis = require('@metamask/delegation-abis');
const core = require('@metamask/delegation-core');

const MM = DELEGATOR_CONTRACTS['1.3.0'][84532];
const DAY = 24 * 60 * 60;
const USD = n => BigInt(Math.round(n * 1e8)); // 8-decimal USD
const usdc = n => ethers.parseUnits(String(n), 6);
const SINGLE_DEFAULT_MODE = ethers.ZeroHash;

// Custom errors from MetaMask's contracts and ours, decoded so a test checks *why* it failed.
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

/** Passes only if the promise rejects; returns the error text for a reason check. */
async function fails(promise, reason) {
  let err = null;
  try { await (await promise).wait?.(); } catch (e) { err = e; }
  assert.ok(err, `expected it to fail${reason ? ` (${reason})` : ''}, but it went through`);
  const text = [err.shortMessage, err.message, err.reason, err.data, err.info?.error?.message, decodeError(err)].filter(Boolean).join(' | ');
  if (reason) assert.match(text, reason, `failed, but for another reason: ${text.slice(0, 400)}`);
  return text;
}

describe('RektBull Trade Router: break-it tests', function () {
  let funder, user, session, attacker, feeWallet;
  let USDC, WETH, usdcFeed, wethFeed, venue, router, dm;
  let delegation;

  const fund = async addr => ethers.provider.send('hardhat_setBalance', [addr, '0x' + (10n ** 20n).toString(16)]);

  async function signDelegation({ delegate, delegator, caveats, salt }, signer) {
    const domain = { name: 'DelegationManager', version: '1', chainId: 84532, verifyingContract: MM.DelegationManager };
    const types = {
      Delegation: [
        { name: 'delegate', type: 'address' }, { name: 'delegator', type: 'address' },
        { name: 'authority', type: 'bytes32' }, { name: 'caveats', type: 'Caveat[]' }, { name: 'salt', type: 'uint256' },
      ],
      Caveat: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }],
    };
    const value = { delegate, delegator, authority: core.ROOT_AUTHORITY, caveats: caveats.map(c => ({ enforcer: c.enforcer, terms: c.terms })), salt };
    const signature = await signer.signTypedData(domain, types, value);
    return { delegate, delegator, authority: core.ROOT_AUTHORITY, caveats, salt, signature };
  }

  /** The caveats every RektBull delegation carries. */
  function rektbullCaveats({ expiry, redeemer }) {
    return [
      { enforcer: MM.RedeemerEnforcer, terms: core.createRedeemerTerms({ redeemers: [redeemer] }), args: '0x' },
      { enforcer: MM.TimestampEnforcer, terms: core.createTimestampTerms({ afterThreshold: 0, beforeThreshold: expiry }), args: '0x' },
      { enforcer: MM.AllowedTargetsEnforcer, terms: core.createAllowedTargetsTerms({ targets: [router.target] }), args: '0x' },
      { enforcer: MM.AllowedMethodsEnforcer, terms: core.createAllowedMethodsTerms({ selectors: [router.interface.getFunction('swap').selector] }), args: '0x' },
    ];
  }

  /** RektBull's session key (or whoever `by` is) redeems `d` to make one call. */
  function redeem(d, target, data, by = session) {
    const context = core.encodeDelegations([d]);
    const execution = ethers.solidityPacked(['address', 'uint256', 'bytes'], [target, 0, data]);
    return dm.connect(by).redeemDelegations([context], [SINGLE_DEFAULT_MODE], [execution]);
  }

  /** Router calldata for swapping `amountIn` USDC to WETH through the mock venue. */
  async function swapCall({ amountIn, rate = fairRate(), to, venueFn = 'swap', minAmountOut = 0n, tokenIn = USDC, tokenOut = WETH }) {
    const venueData = venueFn === 'swap'
      ? venue.interface.encodeFunctionData('swap', [tokenIn.target, tokenOut.target, amountIn - amountIn / 100n, rate, to ?? router.target])
      : venue.interface.encodeFunctionData('greedy', [tokenIn.target, tokenOut.target, amountIn - amountIn / 100n, rate]);
    return router.interface.encodeFunctionData('swap', [{
      tokenIn: tokenIn.target, tokenOut: tokenOut.target, amountIn, minAmountOut,
      venue: venue.target, spender: venue.target, venueCalldata: venueData, deadline: (await now()) + 600,
    }]);
  }
  // USDC (6 dec) -> WETH (18 dec) at $3,000/ETH: 1e6 USDC raw buys 1e18/3000 WETH raw.
  const fairRate = (pctOfFair = 100) => (10n ** 18n * 10n ** 12n / 3000n) * BigInt(pctOfFair) / 100n;

  before(async function () {
    const code = await ethers.provider.getCode(MM.DelegationManager);
    assert.ok(code.length > 2, 'MetaMask DelegationManager not found on the forked chain');
    [funder] = await ethers.getSigners();
    user = ethers.Wallet.createRandom().connect(ethers.provider);
    session = ethers.Wallet.createRandom().connect(ethers.provider);
    attacker = ethers.Wallet.createRandom().connect(ethers.provider);
    feeWallet = ethers.Wallet.createRandom().address;
    for (const w of [user, session, attacker]) await fund(w.address);

    const Token = await ethers.getContractFactory('MockERC20');
    USDC = await Token.deploy('USD Coin', 'USDC', 6);
    WETH = await Token.deploy('Wrapped Ether', 'WETH', 18);
    const Feed = await ethers.getContractFactory('MockFeed');
    usdcFeed = await Feed.deploy(8, 100000000n); // $1.00
    wethFeed = await Feed.deploy(8, 300000000000n); // $3,000
    venue = await (await ethers.getContractFactory('MockVenue')).deploy();
    router = await (await ethers.getContractFactory('RektBullTradeRouter')).deploy(
      feeWallet, 100, 200, ethers.ZeroAddress,
      [venue.target], [USDC.target, WETH.target], [usdcFeed.target, wethFeed.target], [DAY, DAY],
    );
    dm = new ethers.Contract(MM.DelegationManager, abis.DelegationManager, ethers.provider);
    errorIfaces.push(dm.interface, new ethers.Interface(abis.EIP7702StatelessDeleGator), router.interface);

    // 1. The user's wallet becomes a MetaMask smart account (EIP-7702), sponsored by someone else.
    const auth = await user.authorize({ address: MM.EIP7702StatelessDeleGatorImpl, nonce: await user.getNonce(), chainId: 84532 });
    await (await funder.sendTransaction({ type: 4, to: user.address, data: '0x', authorizationList: [auth], gasLimit: 200000 })).wait();
    const userCode = await ethers.provider.getCode(user.address);
    assert.equal(userCode.toLowerCase(), ('0xef0100' + MM.EIP7702StatelessDeleGatorImpl.slice(2)).toLowerCase(), 'EIP-7702 upgrade did not take');

    // 2. The user's own setup: USDC, an approval to the router, and their limits ($100 a trade, $1,000 a day, 7 days).
    await USDC.mint(user.address, usdc(10_000));
    await (await USDC.connect(user).approve(router.target, ethers.MaxUint256)).wait();
    const expiry = (await now()) + 7 * DAY;
    await (await router.connect(user).setLimits(USD(100), USD(1000), DAY, expiry)).wait();

    // 3. The user grants RektBull's session key a delegation.
    delegation = await signDelegation({ delegate: session.address, delegator: user.address, caveats: rektbullCaveats({ expiry, redeemer: session.address }), salt: 1n }, user);
  });

  it('works: a $50 swap lands in the user\'s wallet, 1% goes to the fee wallet', async function () {
    const before = await WETH.balanceOf(user.address);
    await (await redeem(delegation, router.target, await swapCall({ amountIn: usdc(50) }))).wait();
    const got = (await WETH.balanceOf(user.address)) - before;
    assert.equal(got, usdc(50) * 99n / 100n * fairRate() / 10n ** 18n);
    assert.equal(await USDC.balanceOf(feeWallet), usdc(0.5));
    assert.equal(await USDC.balanceOf(router.target), 0n, 'the router keeps nothing');
    assert.equal(await WETH.balanceOf(router.target), 0n, 'the router keeps nothing');
  });

  describe('a hacked RektBull cannot take funds', function () {
    it('cannot transfer the user\'s tokens to itself', async function () {
      await fails(redeem(delegation, USDC.target, USDC.interface.encodeFunctionData('transfer', [attacker.address, usdc(100)])), /target|allowed/i);
      assert.equal(await USDC.balanceOf(attacker.address), 0n);
    });
    it('cannot approve itself to spend the user\'s tokens', async function () {
      await fails(redeem(delegation, USDC.target, USDC.interface.encodeFunctionData('approve', [attacker.address, ethers.MaxUint256])), /target|allowed/i);
      assert.equal(await USDC.allowance(user.address, attacker.address), 0n);
    });
    it('cannot call any contract but the router', async function () {
      await fails(redeem(delegation, venue.target, await swapCall({ amountIn: usdc(10) })), /target|allowed/i);
    });
    it('cannot have the exchange pay the output to someone else', async function () {
      await fails(redeem(delegation, router.target, await swapCall({ amountIn: usdc(50), to: attacker.address })), /BelowMinimum/);
      assert.equal(await WETH.balanceOf(attacker.address), 0n);
    });
    it('cannot let the exchange take more than the trade', async function () {
      await fails(redeem(delegation, router.target, await swapCall({ amountIn: usdc(50), venueFn: 'greedy' })), /VenueFailed|allowance/i);
    });
    it('cannot trade at a bad price to skim value (10% below the reference price)', async function () {
      await fails(redeem(delegation, router.target, await swapCall({ amountIn: usdc(50), rate: fairRate(90) })), /BelowMinimum/);
    });
    it('can only lose up to the 2% price bound (1% below passes)', async function () {
      await (await redeem(delegation, router.target, await swapCall({ amountIn: usdc(10), rate: fairRate(99) }))).wait();
    });
    it('cannot raise the user\'s limits, or call revoke on their behalf', async function () {
      const far = (await now()) + 365 * DAY;
      await fails(redeem(delegation, router.target, router.interface.encodeFunctionData('setLimits', [USD(1e9), USD(1e9), DAY, far])), /method|allowed/i);
      await fails(redeem(delegation, router.target, router.interface.encodeFunctionData('revoke', [])), /method|allowed/i);
    });
  });

  describe('a hacked RektBull cannot charge more than 1%', function () {
    it('the fee is fixed in the contract and paid only to the fee wallet', async function () {
      assert.equal(await router.FEE_BPS(), 100n);
      assert.equal(await router.FEE_WALLET(), feeWallet);
      // The only functions that change anything: a user's own limits, their revoke, and a swap.
      const writes = router.interface.fragments.filter(f => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability)).map(f => f.name).sort();
      assert.deepEqual(writes, ['revoke', 'setLimits', 'swap'], 'no function can change the fee, venues or price feeds');
    });
    it('a router with a fee above 1% cannot be deployed', async function () {
      const F = await ethers.getContractFactory('RektBullTradeRouter');
      await fails(F.deploy(feeWallet, 101, 200, ethers.ZeroAddress, [venue.target], [USDC.target], [usdcFeed.target], [DAY]), /BadConfig/);
    });
  });

  describe('limits hold', function () {
    it('refuses a trade over the per-trade limit ($150 > $100)', async function () {
      await fails(redeem(delegation, router.target, await swapCall({ amountIn: usdc(150) })), /OverTradeLimit/);
    });
    it('refuses trades over the daily limit, and allows them again the next day', async function () {
      // $70 is already spent today by the tests above (50 + 10 + 10).
      for (let i = 0; i < 9; i++) await (await redeem(delegation, router.target, await swapCall({ amountIn: usdc(100) }))).wait();
      await fails(redeem(delegation, router.target, await swapCall({ amountIn: usdc(100) })), /OverPeriodLimit/);
      await advance(DAY + 1);
      await usdcFeed.set(100000000n, await now()); await wethFeed.set(300000000000n, await now());
      await (await redeem(delegation, router.target, await swapCall({ amountIn: usdc(100) }))).wait();
    });
    it('refuses to trade on a stale price', async function () {
      await wethFeed.set(300000000000n, (await now()) - 2 * DAY);
      await fails(redeem(delegation, router.target, await swapCall({ amountIn: usdc(10) })), /StalePrice/);
      await wethFeed.set(300000000000n, await now());
    });
  });

  describe('prices it can trust', function () {
    it('refuses to trade while the Base sequencer is down, or just after it restarts', async function () {
      const Feed = await ethers.getContractFactory('MockFeed');
      const seq = await Feed.deploy(0, 0n); // 0 = up
      const r = await (await ethers.getContractFactory('RektBullTradeRouter')).deploy(
        feeWallet, 100, 200, seq.target, [venue.target], [USDC.target, WETH.target], [usdcFeed.target, wethFeed.target], [DAY, DAY]);
      await seq.setStartedAt((await now()) - 7200);
      await usdcFeed.set(100000000n, await now()); await wethFeed.set(300000000000n, await now());
      assert.ok((await r.valueUsd(USDC.target, usdc(1))) > 0n, 'works while the sequencer is up');
      await seq.set(1n, await now()); // down
      await fails(r.valueUsd(USDC.target, usdc(1)), /SequencerDown/);
      await seq.set(0n, await now()); await seq.setStartedAt((await now()) - 60); // back up a minute ago
      await fails(r.valueUsd(USDC.target, usdc(1)), /SequencerDown/);
    });
    it('refuses a trade past its deadline', async function () {
      const data = router.interface.encodeFunctionData('swap', [{
        tokenIn: USDC.target, tokenOut: WETH.target, amountIn: usdc(10), minAmountOut: 0n,
        venue: venue.target, spender: venue.target, venueCalldata: '0x', deadline: (await now()) - 1,
      }]);
      await fails(redeem(delegation, router.target, data), /Expired/);
    });
  });

  describe('only RektBull\'s session key, only until expiry or revocation', function () {
    it('another key cannot use the permission', async function () {
      await fails(redeem(delegation, router.target, await swapCall({ amountIn: usdc(10) }), attacker), /delegate|redeemer|invalid/i);
    });
    it('a permission naming the attacker as delegate is refused by the redeemer rule', async function () {
      const expiry = (await now()) + DAY;
      const d = await signDelegation({ delegate: attacker.address, delegator: user.address, caveats: rektbullCaveats({ expiry, redeemer: session.address }), salt: 2n }, user);
      await fails(redeem(d, router.target, await swapCall({ amountIn: usdc(10) }), attacker), /redeemer|allowed/i);
    });
    it('a permission not signed by the user is refused', async function () {
      const expiry = (await now()) + DAY;
      const forged = await signDelegation({ delegate: session.address, delegator: user.address, caveats: rektbullCaveats({ expiry, redeemer: session.address }), salt: 3n }, attacker);
      await fails(redeem(forged, router.target, await swapCall({ amountIn: usdc(10) })), /signature|invalid/i);
    });
    it('stops working after its expiry', async function () {
      const soon = (await now()) + 60;
      const d = await signDelegation({ delegate: session.address, delegator: user.address, caveats: rektbullCaveats({ expiry: soon, redeemer: session.address }), salt: 4n }, user);
      await advance(120);
      await usdcFeed.set(100000000n, await now()); await wethFeed.set(300000000000n, await now());
      await fails(redeem(d, router.target, await swapCall({ amountIn: usdc(10) })), /expired|timestamp/i);
    });
    it('stops working when the user disables the delegation', async function () {
      const expiry = (await now()) + DAY;
      const d = await signDelegation({ delegate: session.address, delegator: user.address, caveats: rektbullCaveats({ expiry, redeemer: session.address }), salt: 5n }, user);
      await (await redeem(d, router.target, await swapCall({ amountIn: usdc(10) }))).wait(); // works first
      const asStruct = { ...d, caveats: d.caveats };
      await (await dm.connect(user).disableDelegation(asStruct)).wait();
      await fails(redeem(d, router.target, await swapCall({ amountIn: usdc(10) })), /disabled|CannotUseADisabledDelegation/i);
    });
    it('stops all trading when the user calls revoke on the router', async function () {
      await (await router.connect(user).revoke()).wait();
      await fails(redeem(delegation, router.target, await swapCall({ amountIn: usdc(10) })), /LimitsOff/);
    });
  });

  describe('nobody else can use the user\'s approval', function () {
    it('another account calling the router directly trades only its own funds', async function () {
      // The attacker has no limits and no funds; the router pulls only from msg.sender.
      await fails(router.connect(attacker).swap({
        tokenIn: USDC.target, tokenOut: WETH.target, amountIn: usdc(10), minAmountOut: 0n,
        venue: venue.target, spender: venue.target, venueCalldata: '0x', deadline: (await now()) + 600,
      }), /LimitsOff/);
      assert.equal(await USDC.allowance(user.address, router.target), ethers.MaxUint256, 'the user\'s approval is untouched');
    });
  });
});
