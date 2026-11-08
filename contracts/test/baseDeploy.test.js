/**
 * The Base mainnet deployment, rehearsed on a copy of Base mainnet: the
 * pre-flight passes with the real parameters in config/base.json and catches
 * each kind of wrong parameter; the deployed router and Safe Module read back
 * exactly as configured; and the verification catches a wrong setting or the
 * wrong code at an address.
 */
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import { network, artifacts } from 'hardhat';
import { loadParams, routerArgs, checkSources, preflight, verifyDeployment, sameCode } from '../scripts/lib/baseDeploy.js';

const { ethers } = await network.create('baseMainnetFork');
await ethers.provider.send('evm_mine', []); // calls can't run at the fork block itself

const SAFE_L2 = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762';
const SAFE_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
const SAFE_FALLBACK = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';
const SAFE_SETUP = 'function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)';
const FACTORY_ABI = ['function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)', 'event ProxyCreation(address indexed proxy, address singleton)'];

const params = loadParams();
const copy = () => structuredClone(params);
const failed = results => results.filter(r => !r.ok).map(r => r.name);

describe('Base mainnet deployment', function () {
  let deployer, safe, router, safeModule, art;

  before(async function () {
    [deployer] = await ethers.getSigners();
    art = { router: await artifacts.readArtifact('RektBullTradeRouter'), module: await artifacts.readArtifact('RektBullSafeModule') };
    // A 2-of-3 Safe for the fees, made with Safe's real factory.
    const owners = [0, 1, 2].map(() => ethers.Wallet.createRandom().address);
    const setup = new ethers.Interface([SAFE_SETUP]).encodeFunctionData('setup', [owners, 2, ethers.ZeroAddress, '0x', SAFE_FALLBACK, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
    const factory = new ethers.Contract(SAFE_FACTORY, FACTORY_ABI, deployer);
    const rc = await (await factory.createProxyWithNonce(SAFE_L2, setup, 1n)).wait();
    safe = rc.logs.map(l => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'ProxyCreation').args.proxy;
  });

  it('the audited sources and compiler settings are what will be compiled', function () {
    assert.deepEqual(failed(checkSources(params, art.router)), []);
  });

  it('the pre-flight passes with the real parameters and a Safe as the fee wallet', async function () {
    const results = await preflight(ethers, params, { feeWallet: safe });
    assert.deepEqual(failed(results), [], JSON.stringify(results.filter(r => !r.ok)));
    assert.match(results.find(r => r.name === 'fee wallet').detail, /2 of 3 owners/);
  });

  it('the pre-flight refuses a fee wallet that is a plain address, or none', async function () {
    assert.deepEqual(failed(await preflight(ethers, params, { feeWallet: ethers.Wallet.createRandom().address })), ['fee wallet']);
    assert.deepEqual(failed(await preflight(ethers, params, { feeWallet: '' })), ['fee wallet']);
  });

  it('the pre-flight catches each kind of wrong parameter', async function () {
    const cases = [
      ['wrong token decimals', p => { p.tokens[0].decimals = 18; }, ['token USDC']],
      ['a feed for another asset', p => { p.tokens[1].feed.address = params.tokens[2].feed.address; }, ['feed ETH / USD']],
      // (the current price may also be older than that, so "feed USDC / USD" can fail with it)
      ['a price age no longer than the heartbeat', p => { p.tokens[0].maxAge = 86400; }, ['heartbeat USDC / USD'], ['feed USDC / USD']],
      ['a price age far longer than the heartbeat', p => { p.tokens[1].maxAge = 86400; }, ['heartbeat ETH / USD']],
      ['a heartbeat the feed does not keep', p => { p.tokens[2].feed.heartbeat = 300; p.tokens[2].maxAge = 450; }, ['heartbeat cbBTC / USD'], ['feed cbBTC / USD']],
      ['a fee above what the router allows', p => { p.feeBps = 150; }, ['fee']],
      ['the wrong chain', p => { p.chainId = 1; }, ['chain']],
      ['a venue with no code', p => { p.venues[0].address = ethers.Wallet.createRandom().address; }, ['venue 0x AllowanceHolder']],
    ];
    for (const [what, change, expected, alsoAllowed = []] of cases) {
      const p = copy();
      change(p);
      assert.deepEqual(failed(await preflight(ethers, p, { feeWallet: safe })).filter(n => !alsoAllowed.includes(n)), expected, what);
    }
  });

  it('deploys, and the deployment reads back exactly as configured', async function () {
    router = await (await ethers.getContractFactory('RektBullTradeRouter')).deploy(...routerArgs(params, safe));
    const rtx = router.deploymentTransaction();
    await rtx.wait();
    safeModule = await (await ethers.getContractFactory('RektBullSafeModule')).deploy(router.target);
    const mtx = safeModule.deploymentTransaction();
    await mtx.wait();
    const dep = { chainId: 8453, deployer: deployer.address, feeWallet: safe, router: router.target, routerTx: rtx.hash, safeModule: safeModule.target, safeModuleTx: mtx.hash };
    const results = await verifyDeployment(ethers, params, dep, art);
    assert.deepEqual(failed(results), [], JSON.stringify(results.filter(r => !r.ok)));
    assert.equal(results.filter(r => / price through the router$/.test(r.name)).length, 3, 'a live price for each token');
  });

  it('the verification catches a setting that differs from the parameters', async function () {
    const p = copy();
    p.feeBps = 50;
    p.tokens[0].maxAge = 86400 + 60;
    const dep = { chainId: 8453, feeWallet: safe, router: router.target, safeModule: safeModule.target };
    assert.deepEqual(failed(await verifyDeployment(ethers, p, dep, art)), ['fee', 'USDC feed']);
  });

  it('the verification catches the wrong code, the wrong sender and the wrong fee wallet', async function () {
    assert.equal(sameCode(await ethers.provider.getCode(safeModule.target), art.router), false);
    assert.equal(sameCode(await ethers.provider.getCode(router.target), art.module), false);
    // Same code, different settings: still the same code.
    const other = await (await ethers.getContractFactory('RektBullTradeRouter')).deploy(...routerArgs({ ...params, feeBps: 10 }, safe));
    assert.equal(sameCode(await ethers.provider.getCode(other.target), art.router), true);
    const dep = { chainId: 8453, deployer: ethers.Wallet.createRandom().address, feeWallet: deployer.address, router: router.target, routerTx: router.deploymentTransaction().hash };
    assert.deepEqual(failed(await verifyDeployment(ethers, params, dep, art)), ['fee wallet', 'router deployment']);
  });
});
