/**
 * Milestone 3: the break-it tests, for Safe and Coinbase Smart Wallet.
 *
 * Runs on a copy of Base Sepolia against the real deployed wallets:
 *   - a Safe 1.4.1 (SafeL2 + proxy factory) using the RektBull Safe Module;
 *   - a Coinbase Smart Wallet (Coinbase's factory) with a Coinbase spend
 *     permission to the Trade Router, through Coinbase's real Spend
 *     Permission Manager.
 * Each test is something a hacked RektBull (or anyone else) might try, and
 * must fail, the same as test/breakIt.test.js does for MetaMask.
 */
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import { network } from 'hardhat';

const { ethers } = await network.create();

const SAFE_L2 = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762';
const SAFE_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
const SAFE_FALLBACK = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';
const CB_FACTORY = '0xba5ed110efdba3d005bfc882d75358acbbb85842';
const SPM = '0xf85210B21cC50302F477BA56686d2019dC9b67Ad';
const DAY = 86400;
const USD = n => BigInt(Math.round(n * 1e8));
const usdc = n => ethers.parseUnits(String(n), 6);

const SAFE_ABI = [
  'function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'function enableModule(address module)', 'function disableModule(address prevModule, address module)', 'function isModuleEnabled(address module) view returns (bool)',
];
const SAFE_FACTORY_ABI = ['function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)', 'event ProxyCreation(address indexed proxy, address singleton)'];
const CB_FACTORY_ABI = ['function createAccount(bytes[] owners, uint256 nonce) payable returns (address)', 'function getAddress(bytes[] owners, uint256 nonce) view returns (address)'];
const CB_WALLET_ABI = ['function execute(address target, uint256 value, bytes data) payable', 'function addOwnerAddress(address owner)'];
const PERM = '(address account, address spender, address token, uint160 allowance, uint48 period, uint48 start, uint48 end, uint256 salt, bytes extraData)';
const SPM_ABI = [`function approve(${PERM} spendPermission) returns (bool)`, `function revoke(${PERM} spendPermission)`, `function isApproved(${PERM} spendPermission) view returns (bool)`, `function isRevoked(${PERM} spendPermission) view returns (bool)`];

async function now() { return (await ethers.provider.getBlock('latest')).timestamp; }
async function advance(s) { await ethers.provider.send('evm_increaseTime', [s]); await ethers.provider.send('evm_mine', []); }
const fund = a => ethers.provider.send('hardhat_setBalance', [a, '0x' + (10n ** 20n).toString(16)]);

const ifaces = [];
function decode(err) {
  const raw = String(err.data || '').match(/0x[0-9a-f]{8,}/i)?.[0] || String(err.message || '').match(/return data: (0x[0-9a-f]+)/i)?.[1];
  const out = [];
  let data = raw;
  // Unwrap SafeCallFailed(bytes) to show the router's own error inside it.
  for (let depth = 0; data && depth < 3; depth++) {
    let hit = null;
    for (const i of ifaces) { try { hit = i.parseError(data); if (hit) break; } catch { /* next */ } }
    if (!hit) break;
    out.push(hit.name);
    data = hit.name === 'SafeCallFailed' || hit.name === 'VenueFailed' ? hit.args[0] : null;
  }
  return out.join(' > ');
}
async function fails(promise, reason) {
  let err = null;
  try { await (await promise).wait?.(); } catch (e) { err = e; }
  assert.ok(err, `expected it to fail (${reason}), but it went through`);
  const text = [err.shortMessage, err.message, decode(err)].filter(Boolean).join(' | ');
  if (reason) assert.match(text, reason, `failed, but for another reason: ${text.slice(0, 400)}`);
}

describe('Safe and Coinbase Smart Wallet: break-it tests', function () {
  let deployer, session, attacker, feeWallet;
  let USDC, WETH, usdcFeed, wethFeed, venue, router, mod;
  const fairRate = (pct = 100) => (10n ** 30n / 3000n) * BigInt(pct) / 100n;
  const sellRate = () => 3000n * 10n ** 6n;

  async function swapParams({ amountIn, tokenIn = USDC, tokenOut = WETH, rate = fairRate(), to }) {
    const fee = amountIn / 100n;
    return {
      tokenIn: tokenIn.target, tokenOut: tokenOut.target, amountIn, minAmountOut: 0n,
      venue: venue.target, spender: venue.target,
      venueCalldata: venue.interface.encodeFunctionData('swap', [tokenIn.target, tokenOut.target, amountIn - fee, rate, to ?? router.target]),
      deadline: (await now()) + 600,
    };
  }

  before(async function () {
    assert.ok((await ethers.provider.getCode(SAFE_L2)).length > 2, 'Safe not found on the forked chain');
    assert.ok((await ethers.provider.getCode(SPM)).length > 2, 'Coinbase Spend Permission Manager not found');
    [deployer] = await ethers.getSigners();
    session = ethers.Wallet.createRandom().connect(ethers.provider);
    attacker = ethers.Wallet.createRandom().connect(ethers.provider);
    feeWallet = ethers.Wallet.createRandom().address;
    for (const w of [session, attacker]) await fund(w.address);
    const Token = await ethers.getContractFactory('MockERC20');
    USDC = await Token.deploy('USD Coin', 'USDC', 6);
    WETH = await Token.deploy('Wrapped Ether', 'WETH', 18);
    const Feed = await ethers.getContractFactory('MockFeed');
    usdcFeed = await Feed.deploy(8, 100000000n);
    wethFeed = await Feed.deploy(8, 300000000000n);
    venue = await (await ethers.getContractFactory('MockVenue')).deploy();
    router = await (await ethers.getContractFactory('RektBullTradeRouter')).deploy(
      feeWallet, 100, 200, ethers.ZeroAddress, SPM, [venue.target], [USDC.target, WETH.target], [usdcFeed.target, wethFeed.target], [DAY, DAY]);
    mod = await (await ethers.getContractFactory('RektBullSafeModule')).deploy(router.target);
    ifaces.push(router.interface, mod.interface);
  });

  // ── Safe ───────────────────────────────────────────────────────────────
  describe('Safe, through the RektBull Safe Module', function () {
    let owner, safe;
    /** A transaction from the Safe, signed by its one owner (pre-validated: the owner sends it). */
    async function fromSafe(to, data) {
      const sig = ethers.concat([ethers.zeroPadValue(owner.address, 32), ethers.ZeroHash, '0x01']);
      return (await safe.connect(owner).execTransaction(to, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, sig)).wait();
    }

    before(async function () {
      owner = ethers.Wallet.createRandom().connect(ethers.provider);
      await fund(owner.address);
      const setup = new ethers.Interface(SAFE_ABI).encodeFunctionData('setup', [[owner.address], 1, ethers.ZeroAddress, '0x', SAFE_FALLBACK, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
      const factory = new ethers.Contract(SAFE_FACTORY, SAFE_FACTORY_ABI, deployer);
      const rc = await (await factory.createProxyWithNonce(SAFE_L2, setup, BigInt(Date.now()))).wait();
      const proxy = rc.logs.map(l => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'ProxyCreation').args.proxy;
      safe = new ethers.Contract(proxy, SAFE_ABI, ethers.provider);
      // The owners' setup: enable the module, approve the router, set limits, name the session key.
      await fromSafe(proxy, safe.interface.encodeFunctionData('enableModule', [mod.target]));
      for (const t of [USDC, WETH]) await fromSafe(t.target, t.interface.encodeFunctionData('approve', [router.target, ethers.MaxUint256]));
      await fromSafe(router.target, router.interface.encodeFunctionData('setLimits', [USD(500), USD(10_000), DAY, (await now()) + 7 * DAY]));
      await fromSafe(mod.target, mod.interface.encodeFunctionData('setSession', [session.address, (await now()) + 7 * DAY]));
      await USDC.mint(proxy, usdc(5_000));
    });

    it('works: the session key trades for the Safe; the tokens land in the Safe, 1% to the fee wallet', async function () {
      const feeBefore = await USDC.balanceOf(feeWallet);
      await (await mod.connect(session).swap(safe.target, await swapParams({ amountIn: usdc(100) }))).wait();
      assert.ok((await WETH.balanceOf(safe.target)) > 0n);
      assert.equal((await USDC.balanceOf(feeWallet)) - feeBefore, usdc(1));
      assert.equal(await WETH.balanceOf(session.address), 0n, 'nothing goes to the session key');
    });
    it('another key cannot trade for the Safe', async function () {
      await fails(mod.connect(attacker).swap(safe.target, await swapParams({ amountIn: usdc(10) })), /NotSessionKey/);
    });
    it('the session key cannot hand its power to another key', async function () {
      await (await mod.connect(session).setSession(attacker.address, (await now()) + DAY)).wait(); // only sets a session for the caller itself
      await fails(mod.connect(attacker).swap(safe.target, await swapParams({ amountIn: usdc(10) })), /NotSessionKey/);
    });
    it('the module can only ever call the router\'s swap: it has no other way to act for a Safe', async function () {
      const writes = mod.interface.fragments.filter(f => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability)).map(f => f.name).sort();
      assert.deepEqual(writes, ['revoke', 'setSession', 'swap']);
    });
    it('the router\'s rules still apply: over the Safe\'s per-trade limit, output sent elsewhere, a bad price', async function () {
      await fails(mod.connect(session).swap(safe.target, await swapParams({ amountIn: usdc(600) })), /SafeCallFailed > OverTradeLimit/);
      await fails(mod.connect(session).swap(safe.target, await swapParams({ amountIn: usdc(50), to: attacker.address })), /BelowMinimum/);
      await fails(mod.connect(session).swap(safe.target, await swapParams({ amountIn: usdc(50), rate: fairRate(90) })), /BelowMinimum/);
      assert.equal(await WETH.balanceOf(attacker.address), 0n);
    });
    it('a Safe that never named a session key cannot be traded', async function () {
      await fails(mod.connect(session).swap(attacker.address, await swapParams({ amountIn: usdc(10) })), /NotSessionKey/);
    });
    it('a session longer than 30 days cannot be set', async function () {
      await fails(fromSafe(mod.target, mod.interface.encodeFunctionData('setSession', [session.address, (await now()) + 31 * DAY])), /GS013|BadSession|reverted/);
    });
    it('the owners can stop it: revoke on the module', async function () {
      await fromSafe(mod.target, mod.interface.encodeFunctionData('revoke', []));
      await fails(mod.connect(session).swap(safe.target, await swapParams({ amountIn: usdc(10) })), /NotSessionKey/);
      await fromSafe(mod.target, mod.interface.encodeFunctionData('setSession', [session.address, (await now()) + 7 * DAY])); // back on for the next test
    });
    it('the owners can stop it: disable the module', async function () {
      await fromSafe(safe.target, safe.interface.encodeFunctionData('disableModule', ['0x0000000000000000000000000000000000000001', mod.target]));
      assert.equal(await safe.isModuleEnabled(mod.target), false);
      await fails(mod.connect(session).swap(safe.target, await swapParams({ amountIn: usdc(10) })), /GS104|reverted/);
    });
    it('a session ends by itself at its expiry', async function () {
      await fromSafe(safe.target, safe.interface.encodeFunctionData('enableModule', [mod.target]));
      await fromSafe(mod.target, mod.interface.encodeFunctionData('setSession', [session.address, (await now()) + 60]));
      await advance(120);
      await usdcFeed.set(100000000n, await now()); await wethFeed.set(300000000000n, await now());
      await fails(mod.connect(session).swap(safe.target, await swapParams({ amountIn: usdc(10) })), /SessionExpired/);
    });
  });

  // ── Coinbase Smart Wallet ─────────────────────────────────────────────
  describe('Coinbase Smart Wallet, through a spend permission to the router', function () {
    let owner, wallet, spm, usdcPerm, wethPerm;
    const exec = (to, data) => wallet.connect(owner).execute(to, 0, data).then(t => t.wait());

    before(async function () {
      owner = ethers.Wallet.createRandom().connect(ethers.provider);
      await fund(owner.address);
      const factory = new ethers.Contract(CB_FACTORY, CB_FACTORY_ABI, deployer);
      const owners = [ethers.AbiCoder.defaultAbiCoder().encode(['address'], [owner.address])];
      const nonce = BigInt(Date.now());
      // Not factory.getAddress(): on an ethers contract that is ethers' own method (the contract's address).
      const addr = await factory.getFunction('getAddress')(owners, nonce);
      await (await factory.createAccount(owners, nonce)).wait();
      wallet = new ethers.Contract(addr, CB_WALLET_ABI, ethers.provider);
      spm = new ethers.Contract(SPM, SPM_ABI, ethers.provider);
      await (await wallet.connect(owner).addOwnerAddress(SPM)).wait(); // how Coinbase enables spend permissions
      const t = await now();
      usdcPerm = { account: addr, spender: router.target, token: USDC.target, allowance: usdc(2_000), period: DAY, start: t, end: t + 7 * DAY, salt: 1n, extraData: '0x' };
      wethPerm = { ...usdcPerm, token: WETH.target, allowance: ethers.parseEther('10'), salt: 2n };
      for (const p of [usdcPerm, wethPerm]) await exec(SPM, spm.interface.encodeFunctionData('approve', [p]));
      await exec(router.target, router.interface.encodeFunctionData('setLimits', [USD(500), USD(10_000), DAY, t + 7 * DAY]));
      await exec(router.target, router.interface.encodeFunctionData('setOperator', [session.address]));
      await USDC.mint(addr, usdc(5_000));
      await usdcFeed.set(100000000n, await now()); await wethFeed.set(300000000000n, await now());
    });

    it('works: RektBull\'s key starts a trade; the router pulls through the permission and the tokens land in the wallet', async function () {
      assert.equal(await spm.isApproved(usdcPerm), true);
      const feeBefore = await USDC.balanceOf(feeWallet);
      await (await router.connect(session).swapWithSpendPermission(usdcPerm, await swapParams({ amountIn: usdc(100) }))).wait();
      assert.ok((await WETH.balanceOf(wallet.target)) > 0n, 'the tokens landed in the user\'s wallet');
      assert.equal((await USDC.balanceOf(feeWallet)) - feeBefore, usdc(1));
      assert.equal(await USDC.balanceOf(router.target), 0n, 'the router keeps nothing');
      assert.equal(await WETH.balanceOf(session.address), 0n, 'nothing goes to the session key');
    });
    it('only the operator the wallet named can start a trade', async function () {
      await fails(router.connect(attacker).swapWithSpendPermission(usdcPerm, await swapParams({ amountIn: usdc(10) })), /NotAllowed/);
    });
    it('a permission to anyone but the router is refused, and a permission for another token too', async function () {
      await fails(router.connect(session).swapWithSpendPermission({ ...usdcPerm, spender: session.address }, await swapParams({ amountIn: usdc(10) })), /NotAllowed/);
      await fails(router.connect(session).swapWithSpendPermission(wethPerm, await swapParams({ amountIn: usdc(10) })), /NotAllowed/);
    });
    it('the router\'s rules still apply, and a refused trade moves nothing', async function () {
      const before = await USDC.balanceOf(wallet.target);
      await fails(router.connect(session).swapWithSpendPermission(usdcPerm, await swapParams({ amountIn: usdc(600) })), /OverTradeLimit/);
      await fails(router.connect(session).swapWithSpendPermission(usdcPerm, await swapParams({ amountIn: usdc(50), to: attacker.address })), /BelowMinimum/);
      await fails(router.connect(session).swapWithSpendPermission(usdcPerm, await swapParams({ amountIn: usdc(50), rate: fairRate(90) })), /BelowMinimum/);
      assert.equal(await USDC.balanceOf(wallet.target), before, 'nothing left the wallet');
      assert.equal(await WETH.balanceOf(attacker.address), 0n);
    });
    it('Coinbase\'s own allowance is a second cap: past it, the permission refuses', async function () {
      // $100 is spent today; three more $500 trades reach $1,600, and a fourth would pass the $2,000 permission.
      for (let i = 0; i < 3; i++) await (await router.connect(session).swapWithSpendPermission(usdcPerm, await swapParams({ amountIn: usdc(500) }))).wait();
      await fails(router.connect(session).swapWithSpendPermission(usdcPerm, await swapParams({ amountIn: usdc(500) })), /reverted|Exceeded|allowance/i);
    });
    it('selling what the router bought goes through the token\'s own permission, exempt from the limits', async function () {
      const bought = await router.boughtByRouter(wallet.target, WETH.target);
      const before = await USDC.balanceOf(wallet.target);
      await (await router.connect(session).swapWithSpendPermission(wethPerm, await swapParams({ amountIn: bought, tokenIn: WETH, tokenOut: USDC, rate: sellRate() }))).wait();
      assert.ok((await USDC.balanceOf(wallet.target)) > before, 'the proceeds went back to the wallet');
    });
    it('another wallet\'s permission cannot be used: no operator named, or a different one', async function () {
      const other = { ...usdcPerm, account: attacker.address };
      await fails(router.connect(session).swapWithSpendPermission(other, await swapParams({ amountIn: usdc(10) })), /NotAllowed/);
    });
    it('the wallet can stop it: revoke on the router clears the operator', async function () {
      await exec(router.target, router.interface.encodeFunctionData('revoke', []));
      assert.equal(await router.operatorOf(wallet.target), ethers.ZeroAddress);
      await fails(router.connect(session).swapWithSpendPermission(usdcPerm, await swapParams({ amountIn: usdc(10) })), /NotAllowed/);
    });
    it('the wallet can stop it: revoking the spend permission with Coinbase', async function () {
      const t = await now();
      await exec(router.target, router.interface.encodeFunctionData('setLimits', [USD(500), USD(10_000), DAY, t + 7 * DAY]));
      await exec(router.target, router.interface.encodeFunctionData('setOperator', [session.address]));
      await exec(SPM, spm.interface.encodeFunctionData('revoke', [usdcPerm]));
      // Coinbase keeps approval and revocation apart: a revoked permission stays "approved" but is revoked, and can't be spent.
      assert.equal(await spm.isRevoked(usdcPerm), true);
      await fails(router.connect(session).swapWithSpendPermission(usdcPerm, await swapParams({ amountIn: usdc(10) })), /reverted|Unauthorized|revoked/i);
    });
  });
});
