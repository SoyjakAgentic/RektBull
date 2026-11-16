/**
 * RektBullSafeModule against a real Safe 1.4.1 on a Base Sepolia fork: the re-review's findings (Fable 5.2, 16
 * November 2026, of the fixes made after the second AI audit), kept as regression tests. The setup is the
 * reviewer's own proof.
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

describe('RektBullSafeModule: the re-review\'s findings', function () {
  let deployer, session, attacker, USDC, WETH, venue, router, mod;
  const rate = 10n ** 30n / 3000n;
  async function swapParams(amountIn) {
    return { tokenIn: USDC.target, tokenOut: WETH.target, amountIn, minAmountOut: 0n, venue: venue.target, spender: venue.target,
      venueCalldata: venue.interface.encodeFunctionData('swap', [USDC.target, WETH.target, amountIn - amountIn / 100n, rate, router.target]),
      deadline: (await now()) + 600 };
  }
  async function newSafe(ownerAddrOverride) {
    const owner = ethers.Wallet.createRandom().connect(ethers.provider);
    await fund(owner.address);
    const setup = new ethers.Interface(SAFE_ABI).encodeFunctionData('setup', [ownerAddrOverride ? [owner.address, ownerAddrOverride] : [owner.address], 1, ethers.ZeroAddress, '0x', SAFE_FALLBACK, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
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


  it('N-1: revokeFor forwarded through a nested owner-Safe\'s fallback is refused; B\'s session stays', async function () {
    const A = await newSafe();
    await A.fromSafe(A.safe.target, A.safe.interface.encodeFunctionData('setFallbackHandler', [mod.target]));
    const B = await newSafe(A.safe.target); // Safe A is one of B's owners
    await B.fromSafe(mod.target, mod.interface.encodeFunctionData('setSession', [session.address, (await now()) + 20 * DAY]));
    const viaA = new ethers.Contract(A.safe.target, mod.interface, attacker);
    await assert.rejects(viaA.revokeFor(B.safe.target, { gasLimit: 500000 }));
    assert.equal((await mod.sessions(B.safe.target)).key, session.address, 'an outsider can\'t end B\'s session');
    // B's own owner still can, directly.
    await (await mod.connect(B.owner).revokeFor(B.safe.target)).wait();
    assert.equal((await mod.sessions(B.safe.target)).key, ethers.ZeroAddress);
  });

  it('N-2: retire() ends every session of a key at once, for good, even against a setSession signed earlier', async function () {
    const key = ethers.Wallet.createRandom().connect(ethers.provider);
    await fund(key.address);
    const one = await newSafe(), two = await newSafe();
    for (const s of [one, two]) await s.fromSafe(mod.target, mod.interface.encodeFunctionData('setSession', [key.address, (await now()) + 20 * DAY]));
    await (await mod.connect(key).swap(one.safe.target, await swapParams(usdc(100)))).wait(); // it trades
    await (await mod.connect(key).retire()).wait();
    assert.equal(await mod.retired(key.address), true);
    for (const s of [one, two]) await assert.rejects(mod.connect(key).swap.staticCall(s.safe.target, await swapParams(usdc(100))), /NotSessionKey/);
    // Naming the retired key again (a Safe transaction signed before the retire) is refused.
    await assert.rejects(one.fromSafe(mod.target, mod.interface.encodeFunctionData('setSession', [key.address, (await now()) + 20 * DAY])));
    // Another key still works for the Safe.
    await one.fromSafe(mod.target, mod.interface.encodeFunctionData('setSession', [session.address, (await now()) + 20 * DAY]));
    await (await mod.connect(session).swap(one.safe.target, await swapParams(usdc(100)))).wait();
  });

  it('N-4: SessionRevoked is emitted only when there was a session to end', async function () {
    const { safe, owner } = await newSafe();
    const none = await (await mod.connect(owner).revokeFor(safe.target)).wait();
    assert.equal(none.logs.length, 0, 'no session: no event');
    await assert.rejects(mod.connect(attacker).revokeFor(attacker.address), 'not a Safe');
    // renounce still works for the key, with exact calldata.
    const S = await newSafe();
    await S.fromSafe(mod.target, mod.interface.encodeFunctionData('setSession', [session.address, (await now()) + 20 * DAY]));
    const rc = await (await mod.connect(session).renounce(S.safe.target)).wait();
    assert.equal(rc.logs.length, 1);
    assert.equal((await mod.sessions(S.safe.target)).key, ethers.ZeroAddress);
  });
});
