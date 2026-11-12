/**
 * The Trade Router's mainnet deployments, rehearsed on a copy of each chain.
 * On Base: the pre-flight passes with the real parameters in config/base.json
 * and catches each kind of wrong parameter; the deployed router and Safe
 * Module read back exactly as configured; and the verification catches a
 * wrong setting or the wrong code at an address. On Ethereum and Arbitrum:
 * the real parameters pass, the sequencer rule holds (none only on Ethereum),
 * and the deployment reads back with a live price for every token.
 */
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import { network, artifacts } from 'hardhat';
import { loadParams, routerArgs, checkSources, preflight, verifyDeployment, sameCode, autoTradingEntry } from '../scripts/lib/routerDeploy.js';

const { ethers } = await network.create('baseMainnetFork');
await ethers.provider.send('evm_mine', []); // calls can't run at the fork block itself

const SAFE_L2 = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762';
const SAFE_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
const SAFE_FALLBACK = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';
const SAFE_SETUP = 'function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)';
const FACTORY_ABI = ['function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)', 'event ProxyCreation(address indexed proxy, address singleton)'];

const params = loadParams('base');

/** A 2-of-3 Safe for the fees, made with Safe's real factory (the same addresses on every chain here). */
async function makeSafe(eth, deployer) {
  const owners = [0, 1, 2].map(() => eth.Wallet.createRandom().address);
  const setup = new eth.Interface([SAFE_SETUP]).encodeFunctionData('setup', [owners, 2, eth.ZeroAddress, '0x', SAFE_FALLBACK, eth.ZeroAddress, 0, eth.ZeroAddress]);
  const factory = new eth.Contract(SAFE_FACTORY, FACTORY_ABI, deployer);
  const rc = await (await factory.createProxyWithNonce(SAFE_L2, setup, 1n)).wait();
  return rc.logs.map(l => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'ProxyCreation').args.proxy;
}
const copy = () => structuredClone(params);
const failed = results => results.filter(r => !r.ok).map(r => r.name);

describe('Base mainnet deployment', function () {
  let deployer, safe, router, safeModule, art;

  before(async function () {
    [deployer] = await ethers.getSigners();
    art = { router: await artifacts.readArtifact('RektBullTradeRouter'), module: await artifacts.readArtifact('RektBullSafeModule') };
    safe = await makeSafe(ethers, deployer);
  });

  it('the audited sources and compiler settings are what will be compiled; only the sources listed as awaiting audit fail, and they do', function () {
    // Until the re-audit, the changed Trade Router and the never-audited Safe Module must be refused at
    // deployment (awaitingAudit in the config); everything else must match the audited commit.
    const awaiting = Object.keys(params.awaitingAudit || {}).map(s => `source ${s}`);
    assert.deepEqual(failed(checkSources(params, art.router)), awaiting);
    // Taking an entry off the list doesn't make an unaudited change pass: git still compares with the audited commit.
    const q = structuredClone(params);
    delete q.awaitingAudit['contracts/RektBullTradeRouter.sol'];
    assert.ok(failed(checkSources(q, art.router)).includes('source contracts/RektBullTradeRouter.sol'), 'the changed router fails the git check');
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

for (const chain of ['ethereum', 'arbitrum']) {
  describe(`${chain} mainnet deployment`, function () {
    let eth, p, deployer, safe, art;
    const failedOn = async (change, opts = {}) => { const q = structuredClone(p); change(q); return failed(await preflight(eth, q, { feeWallet: safe, ...opts })); };

    before(async function () {
      eth = (await network.create(`${chain}MainnetFork`)).ethers;
      await eth.provider.send('evm_mine', []);
      p = loadParams(chain);
      [deployer] = await eth.getSigners();
      art = { router: await artifacts.readArtifact('RektBullTradeRouter'), module: await artifacts.readArtifact('RektBullSafeModule') };
      safe = await makeSafe(eth, deployer);
    });

    it('the pre-flight passes with the real parameters and a Safe as the fee wallet', async function () {
      const results = await preflight(eth, p, { feeWallet: safe });
      assert.deepEqual(failed(results), [], JSON.stringify(results.filter(r => !r.ok)));
      assert.equal(results.filter(r => r.name.startsWith('heartbeat ')).length, p.tokens.length);
    });

    it(chain === 'ethereum' ? 'Ethereum may have no sequencer feed, and a wrong one is caught' : 'an L2 must have its sequencer feed', async function () {
      if (chain === 'ethereum') {
        assert.deepEqual(await failedOn(q => { q.sequencerUptimeFeed = { address: '0xFdB631F5EE196F0ed6FAa767959853A9F217697D', description: 'L2 Sequencer Uptime Status Feed' }; }), ['sequencer feed'], 'Arbitrum\'s feed has no code on Ethereum');
      } else {
        assert.deepEqual(await failedOn(q => { q.sequencerUptimeFeed = null; }), ['sequencer feed']);
        assert.deepEqual(await failedOn(q => { q.chainId = 1; }), ['chain']);
      }
    });

    it('deploys, reads back with a live price for every token, and gives the server its entry', async function () {
      const router = await (await eth.getContractFactory('RektBullTradeRouter')).deploy(...routerArgs(p, safe));
      const rtx = router.deploymentTransaction();
      await rtx.wait();
      const safeModule = await (await eth.getContractFactory('RektBullSafeModule')).deploy(router.target);
      await safeModule.deploymentTransaction().wait();
      const dep = { chainId: p.chainId, deployer: deployer.address, feeWallet: safe, router: router.target, routerTx: rtx.hash, safeModule: safeModule.target };
      const results = await verifyDeployment(eth, p, dep, art);
      assert.deepEqual(failed(results), [], JSON.stringify(results.filter(r => !r.ok)));
      assert.equal(results.filter(r => / price through the router$/.test(r.name)).length, p.tokens.length);
      const entry = autoTradingEntry(p, dep)[String(p.chainId)];
      assert.equal(entry.label, p.label);
      assert.equal(entry.explorerTx, `${p.explorer}/tx/`);
      if (chain === 'ethereum') assert.equal(entry.sendRpc, 'https://rpc.flashbots.net/fast', 'Ethereum trades go through Flashbots Protect');
      else assert.ok(entry.tokens.USDT && !entry.tokens['USD₮0'], 'Arbitrum\'s USD₮0 is offered as USDT');
    });
  });
}
