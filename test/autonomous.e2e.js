/**
 * Milestone 2, end to end: autonomous trading through a real MetaMask
 * delegation, on a local copy of Base Sepolia (MetaMask's real
 * DelegationManager, EIP-7702 delegator and enforcers), with the RektBull API,
 * the database, and the trade service's own engine doing the sending.
 *
 *   cd contracts && npm install && npx hardhat compile && cd ..
 *   TEST_DATABASE_URL=postgres://… node --test test/autonomous.e2e.js
 *
 * Not part of `npm test`: it needs the contracts built and starts a Hardhat node.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
const CONTRACTS = path.join(__dirname, '..', 'contracts');
const ART = n => JSON.parse(fs.readFileSync(path.join(CONTRACTS, 'artifacts', 'contracts', n), 'utf8'));
const built = fs.existsSync(path.join(CONTRACTS, 'artifacts', 'contracts', 'RektBullTradeRouter.sol', 'RektBullTradeRouter.json'));
const PORT = 8547;
const DAY = 86400;
const step = m => { if (process.env.E2E_DEBUG) console.error('STEP', m); };

function startNode() {
  return new Promise((resolve, reject) => {
    // Its own process group, so stopping it also stops the node npx starts.
    const node = spawn('npx', ['hardhat', 'node', '--port', String(PORT)], { cwd: CONTRACTS, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    node.stop = () => { try { process.kill(-node.pid, 'SIGTERM'); } catch { /* already gone */ } node.stdout.destroy(); node.stderr.destroy(); };
    const timer = setTimeout(() => reject(new Error('hardhat node did not start')), 120000);
    node.stdout.on('data', d => { if (/Started HTTP/.test(String(d))) { clearTimeout(timer); resolve(node); } });
    node.on('exit', code => { clearTimeout(timer); reject(new Error(`hardhat node exited ${code}`)); });
  });
}

test('autonomous trading, end to end', { skip: (!DB && 'set TEST_DATABASE_URL') || (!built && 'build the contracts first'), timeout: 600000 }, async t => {
  step('starting node');
  const node = await startNode();
  step('node up');
  t.after(() => node.stop());
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, 84532, { staticNetwork: true, cacheTimeout: -1 });
  const fund = a => provider.send('hardhat_setBalance', [a, '0x' + (10n ** 20n).toString(16)]);
  const now = async () => (await provider.getBlock('latest')).timestamp;

  const deployerKey = ethers.Wallet.createRandom();
  const deployer = new ethers.NonceManager(deployerKey.connect(provider));
  const user = ethers.Wallet.createRandom().connect(provider);
  const session = ethers.Wallet.createRandom().connect(provider);
  const feeWallet = ethers.Wallet.createRandom().address;
  for (const w of [deployerKey, user, session]) await fund(w.address);

  const deploy = async (file, name, args) => {
    const a = ART(`${file}/${name}.json`);
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, deployer).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  step('deploying');
  const USDC = await deploy('test/Mocks.sol', 'MockERC20', ['Test USD Coin', 'tUSDC', 6]);
  const WETH = await deploy('test/Mocks.sol', 'MockERC20', ['Test Wrapped Ether', 'tWETH', 18]);
  const usdcFeed = await deploy('test/Mocks.sol', 'MockFeed', [8, 100000000n]);
  const wethFeed = await deploy('test/Mocks.sol', 'MockFeed', [8, 300000000000n]);
  const venue = await deploy('test/Mocks.sol', 'MockVenue', []);
  const router = await deploy('RektBullTradeRouter.sol', 'RektBullTradeRouter', [feeWallet, 100, 200, ethers.ZeroAddress, [venue.target], [USDC.target, WETH.target], [usdcFeed.target, wethFeed.target], [DAY, DAY]]);

  Object.assign(process.env, {
    DATABASE_URL: DB, JWT_SECRET: 'test', TRADING_ENABLED: 'true',
    RPC_URLS_BASE_SEPOLIA: `http://127.0.0.1:${PORT}`,
    DEV_SESSION_KEY: session.privateKey, SESSION_KEY_ADDRESS: session.address.toLowerCase(),
    AUTO_TRADING_NETWORKS: JSON.stringify({ 84532: {
      name: 'base-sepolia', label: 'local fork', router: router.target, venue: { type: 'mock', address: venue.target },
      tokens: { tUSDC: { address: USDC.target, decimals: 6 }, tWETH: { address: WETH.target, decimals: 18 } }, defaultBase: 'tUSDC',
    } }),
  });

  step('db');
  const db = require('../src/config/db');
  t.after(() => db.getPool().end().catch(() => {}));
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  const { createApp } = require('../src/app');
  const { issueToken } = require('../src/auth/siwe');
  const autonomous = require('../src/trade/autonomous');
  const exits = require('../src/trade/exits');
  const { DELEGATOR_CONTRACTS } = require('@metamask/delegation-deployments');
  const MM = DELEGATOR_CONTRACTS['1.3.0'][84532];
  const server = createApp().listen(0);
  t.after(() => { server.close(); autonomous.close(); provider.destroy(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const { rows } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [user.address.toLowerCase()]);
  const token = issueToken(rows[0]);
  const api = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const run = async () => { await autonomous.tick(); await autonomous.tick(); }; // send, then confirm

  // ── The user's own setup, from their wallet ──
  step('7702 upgrade');
  const auth = await user.authorize({ address: MM.EIP7702StatelessDeleGatorImpl, nonce: await user.getNonce(), chainId: 84532 });
  await (await deployer.sendTransaction({ type: 4, to: user.address, data: '0x', authorizationList: [auth], gasLimit: 200000 })).wait();
  await (await USDC.mint(user.address, 5000n * 10n ** 6n)).wait();
  for (const tkn of [USDC, WETH]) await (await tkn.connect(user).approve(router.target, ethers.MaxUint256)).wait();

  await t.test('no permission can be granted before limits are set on the router', async () => {
    const r = await api('GET', '/v1/trading/auto/delegation?chain_id=84532');
    assert.equal(r.status, 422);
    assert.match(r.body.message, /limits/);
  });

  await (await router.connect(user).setLimits(500n * 10n ** 8n, 10000n * 10n ** 8n, DAY, (await now()) + 7 * DAY)).wait();

  await t.test('the user signs the delegation RektBull offers, and the registry accepts it', async () => {
    const tpl = await api('GET', '/v1/trading/auto/delegation?chain_id=84532');
    assert.equal(tpl.status, 200);
    const { domain, types, message } = tpl.body.typed_data;
    const { EIP712Domain, ...signTypes } = types;
    const signature = await user.signTypedData(domain, signTypes, message);
    const r = await api('POST', '/v1/trading/permissions', { chain_id: 84532, wallet_type: 'metamask', delegation: { ...tpl.body.delegation, signature } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.limits.perTradeUsd, 500);
    const lim = await api('GET', '/v1/trading/limits?chain_id=84532');
    assert.equal(lim.body.smart_account, true);
  });

  await t.test('an automatic $100 buy: simulated, signed by the session key, confirmed, recorded', async () => {
    const q = await api('POST', '/v1/trading/auto/intents', { chain_id: 84532, side: 'buy', token: 'tWETH', amount_usd: 100 });
    assert.equal(q.status, 201, JSON.stringify(q.body));
    await run();
    const [intent] = (await api('GET', '/v1/trading/auto/intents')).body.intents;
    assert.equal(intent.status, 'confirmed', intent.error);
    assert.equal(intent.result.fee, String(1n * 10n ** 6n), '1% of $100 in tUSDC');
    assert.ok(BigInt(await WETH.balanceOf(user.address)) > 0n, 'the tokens landed in the user\'s own wallet');
    assert.equal(await USDC.balanceOf(feeWallet), 1n * 10n ** 6n);
    const pos = (await api('GET', '/v1/trading/positions')).body.positions.find(p => p.chain === 'base-sepolia');
    assert.equal(pos.amount_raw, intent.result.amount_out);
    const sigs = await db.query('SELECT * FROM key_signatures');
    assert.equal(sigs.rows.length, 1, 'the signature was logged');
    assert.equal(sigs.rows[0].purpose, `redeem:${intent.id}`);
  });

  await t.test('a trade the router would refuse is never sent: it fails with the router\'s reason', async () => {
    await api('PUT', '/v1/trading/settings', { max_trade_usd: 1000 }); // RektBull's own setting allows it...
    await api('POST', '/v1/trading/auto/intents', { chain_id: 84532, side: 'buy', token: 'tWETH', amount_usd: 600 });
    await run();
    const [intent] = (await api('GET', '/v1/trading/auto/intents')).body.intents;
    assert.equal(intent.status, 'failed');
    assert.match(intent.error, /refused before sending: over your per-trade limit \(\$600 > \$500\)/, '...but the user\'s onchain limit wins');
    assert.equal(intent.tx_hash, null, 'nothing was sent');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM key_signatures')).rows[0].n, 1, 'and nothing was signed');
  });

  await t.test('a stale reference price stops trading', async () => {
    await (await wethFeed.set(300000000000n, (await now()) - 2 * DAY)).wait();
    await api('POST', '/v1/trading/auto/intents', { chain_id: 84532, side: 'buy', token: 'tWETH', amount_usd: 50 });
    await run();
    const [intent] = (await api('GET', '/v1/trading/auto/intents')).body.intents;
    assert.match(intent.error, /refused before sending: the reference price is out of date/);
    assert.equal(intent.tx_hash, null);
    await (await wethFeed.set(300000000000n, await now())).wait();
  });

  await t.test('take-profit: when the position is up 60%, the exit watcher sells it all, exempt from the limits', async () => {
    await (await wethFeed.set(480000000000n, await now())).wait(); // ETH $3,000 -> $4,800
    const usdcBefore = await USDC.balanceOf(user.address);
    await exits.tick();
    const [exit] = (await api('GET', '/v1/trading/auto/intents')).body.intents;
    assert.equal(exit.source, 'exit');
    const up = Number(/Take-profit: up (\d+\.\d)%/.exec(exit.reason)?.[1]);
    assert.ok(up > 50 && up < 60, `up ${up}%: 60% on the price, less the 1% fee paid on the buy`);
    await run();
    const [done] = (await api('GET', '/v1/trading/auto/intents')).body.intents;
    assert.equal(done.status, 'confirmed', done.error);
    assert.equal(done.result.counted_usd, 0, 'selling what the router bought counts nothing toward the limits');
    assert.ok((await USDC.balanceOf(user.address)) > usdcBefore, 'the proceeds went back to the user');
    const pos = (await api('GET', '/v1/trading/positions')).body.positions.find(p => p.chain === 'base-sepolia');
    assert.equal(pos, undefined, 'the position is closed');
  });

  await t.test('after "Stop trading", nothing more is queued or sent', async () => {
    const [perm] = (await api('GET', '/v1/trading/permissions')).body.permissions;
    await api('POST', `/v1/trading/permissions/${perm.id}/revoke`);
    const r = await api('POST', '/v1/trading/auto/intents', { chain_id: 84532, side: 'buy', token: 'tWETH', amount_usd: 50 });
    assert.equal(r.status, 422);
    assert.match(r.body.message, /no active automatic-trading permission/);
  });
});
