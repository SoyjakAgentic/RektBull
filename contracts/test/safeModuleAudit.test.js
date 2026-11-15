/**
 * RektBullSafeModule against a real Safe 1.4.1 on a Base Sepolia fork: the second AI audit's findings (Fable
 * 5.2, November 2026), kept as regression tests. L-1 is fixed by procedure (revoke is the stop) and documented;
 * L-2 and I-1 are fixed in the contract.
 */
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import { network } from 'hardhat';

const { ethers } = await network.create();
const SAFE_L2 = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762';
const SAFE_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
const SAFE_FALLBACK = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';
const DAY = 86400;
const USD = n => BigInt(Math.round(n * 1e8));
const usdc = n => ethers.parseUnits(String(n), 6);
const SAFE_ABI = [
  'function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'function enableModule(address module)', 'function disableModule(address prevModule, address module)', 'function isModuleEnabled(address module) view returns (bool)',
  'function setFallbackHandler(address handler)',
];
const now = async () => (await ethers.provider.getBlock('latest')).timestamp;
const fund = a => ethers.provider.send('hardhat_setBalance', [a, '0x' + (10n ** 20n).toString(16)]);

describe('RektBullSafeModule: audit proofs', function () {
  let deployer, session, attacker, USDC, WETH, venue, router, mod;
  const rate = 10n ** 30n / 3000n;
  async function swapParams(amountIn) {
    return { tokenIn: USDC.target, tokenOut: WETH.target, amountIn, minAmountOut: 0n, venue: venue.target, spender: venue.target,
      venueCalldata: venue.interface.encodeFunctionData('swap', [USDC.target, WETH.target, amountIn - amountIn / 100n, rate, router.target]),
      deadline: (await now()) + 600 };
  }
  async function newSafe() {
    const owner = ethers.Wallet.createRandom().connect(ethers.provider);
    await fund(owner.address);
    const setup = new ethers.Interface(SAFE_ABI).encodeFunctionData('setup', [[owner.address], 1, ethers.ZeroAddress, '0x', SAFE_FALLBACK, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
    const factory = new ethers.Contract(SAFE_FACTORY, ['function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)', 'event ProxyCreation(address indexed proxy, address singleton)'], deployer);
    const rc = await (await factory.createProxyWithNonce(SAFE_L2, setup, BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1e9)))).wait();
    const proxy = rc.logs.map(l => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(l => l?.name === 'ProxyCreation').args.proxy;
    const safe = new ethers.Contract(proxy, SAFE_ABI, ethers.provider);
    const fromSafe = async (to, data) => {
      const sig = ethers.concat([ethers.zeroPadValue(owner.address, 32), ethers.ZeroHash, '0x01']);
      return (await safe.connect(owner).execTransaction(to, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, sig)).wait();
    };
    await USDC.mint(proxy, usdc(10_000));
    await fromSafe(proxy, safe.interface.encodeFunctionData('enableModule', [mod.target]));
    await fromSafe(USDC.target, USDC.interface.encodeFunctionData('approve', [router.target, ethers.MaxUint256]));
    await fromSafe(router.target, router.interface.encodeFunctionData('setLimits', [USD(500), USD(10_000), DAY, (await now()) + 20 * DAY]));
    return { safe, fromSafe, owner };
  }

  before(async function () {
    [deployer] = await ethers.getSigners();
    session = ethers.Wallet.createRandom().connect(ethers.provider);
    attacker = ethers.Wallet.createRandom().connect(ethers.provider);
    for (const w of [session, attacker]) await fund(w.address);
    const Token = await ethers.getContractFactory('MockERC20');
    USDC = await Token.deploy('USD Coin', 'USDC', 6);
    WETH = await Token.deploy('Wrapped Ether', 'WETH', 18);
    const Feed = await ethers.getContractFactory('MockFeed');
    const uf = await Feed.deploy(8, 100000000n), wf = await Feed.deploy(8, 300000000000n);
    venue = await (await ethers.getContractFactory('MockVenue')).deploy();
    await WETH.mint(venue.target, ethers.parseEther('1000'));
    router = await (await ethers.getContractFactory('RektBullTradeRouter')).deploy(
      ethers.Wallet.createRandom().address, 100, 200, ethers.ZeroAddress, ethers.ZeroAddress, [venue.target], [USDC.target, WETH.target], [uf.target, wf.target], [365 * DAY, 365 * DAY]);
    mod = await (await ethers.getContractFactory('RektBullSafeModule')).deploy(router.target);
  });

  it('L-1: disabling the module pauses a session; re-enabling brings it back, so revoke() is the stop (documented)', async function () {
    const { safe, fromSafe } = await newSafe();
    await fromSafe(mod.target, mod.interface.encodeFunctionData('setSession', [session.address, (await now()) + 20 * DAY]));
    await fromSafe(safe.target, safe.interface.encodeFunctionData('disableModule', ['0x0000000000000000000000000000000000000001', mod.target]));
    await assert.rejects(mod.connect(session).swap(safe.target, await swapParams(usdc(100))), 'refused while the module is disabled');
    await fromSafe(safe.target, safe.interface.encodeFunctionData('enableModule', [mod.target]));
    await (await mod.connect(session).swap(safe.target, await swapParams(usdc(100)))).wait(); // back: the documented behaviour
    // The stop: revoke(), after which re-enabling brings nothing back.
    await fromSafe(mod.target, mod.interface.encodeFunctionData('revoke', []));
    await fromSafe(safe.target, safe.interface.encodeFunctionData('disableModule', ['0x0000000000000000000000000000000000000001', mod.target]));
    await fromSafe(safe.target, safe.interface.encodeFunctionData('enableModule', [mod.target]));
    await assert.rejects(mod.connect(session).swap(safe.target, await swapParams(usdc(100))), 'a revoked session stays dead');
  });

  it('I-1: any single owner can revoke, the session key can renounce, and nobody else can do either', async function () {
    const { safe, fromSafe, owner } = await newSafe();
    const set = async () => fromSafe(mod.target, mod.interface.encodeFunctionData('setSession', [session.address, (await now()) + 20 * DAY]));
    await set();
    await assert.rejects(mod.connect(attacker).revokeFor(safe.target), /NotAllowed/);
    await assert.rejects(mod.connect(attacker).renounce(safe.target), /NotSessionKey/);
    await (await mod.connect(owner).revokeFor(safe.target)).wait();
    assert.equal((await mod.sessions(safe.target)).key, ethers.ZeroAddress, 'one owner stopped it');
    await set();
    await (await mod.connect(session).renounce(safe.target)).wait();
    assert.equal((await mod.sessions(safe.target)).key, ethers.ZeroAddress, 'the session key gave it up');
    await assert.rejects(mod.connect(session).swap(safe.target, await swapParams(usdc(100))), /NotSessionKey/);
  });

  it('L-2: an outsider must NOT be able to set or revoke a Safe\'s session through the Safe\'s fallback handler', async function () {
    const { safe, fromSafe } = await newSafe();
    // Misconfiguration: the module's address is (also) set as the Safe's fallback handler.
    await fromSafe(safe.target, safe.interface.encodeFunctionData('setFallbackHandler', [mod.target]));
    // Anyone now calls setSession ON THE SAFE; the Safe's fallback forwards it to the module with msg.sender = the Safe.
    const viaSafe = new ethers.Contract(safe.target, mod.interface, attacker);
    try { await (await viaSafe.setSession(attacker.address, (await now()) + 30 * DAY)).wait(); } catch { /* refused: good */ }
    const s = await mod.sessions(safe.target);
    let traded = true;
    try { await (await mod.connect(attacker).swap(safe.target, await swapParams(usdc(100)))).wait(); } catch { traded = false; }
    assert.equal(traded, false, 'the outsider traded for the Safe');
    assert.notEqual(s.key, attacker.address, 'an outsider named itself the Safe\'s session key');
  });
});
