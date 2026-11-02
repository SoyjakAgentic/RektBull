/**
 * Approval cleanup, end to end, on a local copy of Base Sepolia: real
 * Multicall3 and Uniswap Permit2, real approvals of every kind, the RektBull
 * API and the payment gate. The explorer is played by the local node's own
 * logs; GoPlus and prices are stand-ins (they don't cover a testnet).
 *
 *   cd contracts && npm install && npx hardhat compile && cd ..
 *   TEST_DATABASE_URL=postgres://… node --test test/approvals.e2e.js
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
const built = fs.existsSync(path.join(CONTRACTS, 'artifacts', 'contracts', 'test', 'Mocks.sol', 'MockNFT.json'));
const PORT = 8548;
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

function startNode() {
  return new Promise((resolve, reject) => {
    const node = spawn('npx', ['hardhat', '--network', 'default', 'node', '--port', String(PORT)], { cwd: CONTRACTS, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    node.stop = () => { try { process.kill(-node.pid, 'SIGTERM'); } catch { /* already gone */ } node.stdout.destroy(); node.stderr.destroy(); };
    const timer = setTimeout(() => reject(new Error('hardhat node did not start')), 120000);
    node.stdout.on('data', d => { if (/Started HTTP/.test(String(d))) { clearTimeout(timer); resolve(node); } });
    node.on('exit', code => { clearTimeout(timer); reject(new Error(`hardhat node exited ${code}`)); });
  });
}

test('approval cleanup, end to end', { skip: (!DB && 'set TEST_DATABASE_URL') || (!built && 'build the contracts first'), timeout: 600000 }, async t => {
  const node = await startNode();
  t.after(() => node.stop());
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, 84532, { staticNetwork: true, cacheTimeout: -1 });
  t.after(() => provider.destroy());
  const fund = a => provider.send('hardhat_setBalance', [a, '0x' + (10n ** 20n).toString(16)]);
  await provider.send('evm_mine', []);
  const forkBlock = await provider.getBlockNumber();

  const deployerKey = ethers.Wallet.createRandom();
  const deployer = new ethers.NonceManager(deployerKey.connect(provider));
  const owner = ethers.Wallet.createRandom().connect(provider);
  for (const w of [deployerKey, owner]) await fund(w.address);
  const deploy = async (file, name, args) => {
    const a = ART(`${file}/${name}.json`);
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, deployer).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const tA = await deploy('test/Mocks.sol', 'MockERC20', ['Token A', 'TKA', 6]);
  const tB = await deploy('test/Mocks.sol', 'MockERC20', ['Token B', 'TKB', 18]);
  const nft = await deploy('test/Mocks.sol', 'MockNFT', []);
  const venue = await deploy('test/Mocks.sol', 'MockVenue', []); // stands in for an unknown, unverified contract
  const A = tA.target.toLowerCase(), B = tB.target.toLowerCase(), N = nft.target.toLowerCase(), V = venue.target.toLowerCase();
  const drainer = ethers.Wallet.createRandom().address.toLowerCase();
  const nftDrainer = ethers.Wallet.createRandom().address.toLowerCase();
  const p2Spender = ethers.Wallet.createRandom().address.toLowerCase();
  const old = ethers.Wallet.createRandom().address.toLowerCase();

  // The owner's history: risky, ordinary and closed approvals.
  const send = async p => (await p).wait();
  await send(tA.mint(owner.address, 1000n * 10n ** 6n));
  await send(tB.mint(owner.address, 50n * 10n ** 18n));
  await send(nft.mint(owner.address, 1));
  const asOwner = c => c.connect(owner);
  await send(asOwner(tA).approve(drainer, ethers.MaxUint256));                 // unlimited, to a flagged wallet
  await send(asOwner(tB).approve(V, 100n * 10n ** 18n));                       // limited, to an unverified contract
  await send(asOwner(tA).approve(PERMIT2, ethers.MaxUint256));                 // the usual Permit2 approval
  const permit2 = new ethers.Contract(PERMIT2, ['function approve(address token, address spender, uint160 amount, uint48 expiration)', 'function allowance(address,address,address) view returns (uint160,uint48,uint48)'], owner);
  const in30d = (await provider.getBlock('latest')).timestamp + 30 * 86400;
  await send(permit2.approve(A, p2Spender, 500n * 10n ** 6n, in30d));          // a Permit2 allowance, to a wallet
  await send(asOwner(nft).setApprovalForAll(nftDrainer, true));                // the whole collection, to a wallet
  await send(asOwner(tB).approve(old, 5n));                                    // given, then
  await send(asOwner(tB).approve(old, 0n));                                    // taken back: closed

  // The service, pointed at the local node.
  Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test', APPROVAL_CHAINS: 'base-sepolia', RPC_URLS_BASE_SEPOLIA: `http://127.0.0.1:${PORT}`, NEW_WALLET_CHECK_CHAINS: 'base-sepolia' });
  require('../src/providers/chains').EVM['base-sepolia'] = { chainId: 84532 };
  // The explorer: the node's own logs since the fork, in the explorer's shape.
  let explorerDown = false;
  require('../src/providers/explorer').explorerLogs = async (chain, { address, topic0, topic1 }) => {
    assert.equal(chain, 'base-sepolia');
    if (explorerDown) throw new Error('explorer: rate limited');
    const logs = await provider.send('eth_getLogs', [{ fromBlock: ethers.toQuantity(forkBlock + 1), toBlock: 'latest', ...(address ? { address } : {}), topics: [topic0 || null, topic1 || null] }]);
    return { logs, complete: true };
  };
  const goplus = require('../src/providers/goplus');
  const ghost = ethers.Wallet.createRandom().address.toLowerCase();
  let goplusAsked = 0;
  goplus.approvalsOf = async () => { goplusAsked++; return { source: 'GoPlus', approvals: [{ kind: 'erc20', token: A, spender: drainer }, { kind: 'erc20', token: B, spender: ghost }] }; };
  goplus.addressRisk = async (chain, a) => (a === drainer ? { source: 'GoPlus (data from SlowMist)', flags: ['phishing', 'theft'] } : { source: 'GoPlus', flags: [] });
  goplus.contractRisk = async (chain, a) => (a === PERMIT2.toLowerCase() ? { source: 'GoPlus', known: true, open_source: true, trusted: true, name: 'Permit2', malicious: [] }
    : a === V ? { source: 'GoPlus', known: true, open_source: false, trusted: false, malicious: [] } : { source: 'GoPlus', known: false });
  let tkaPrice = 2;
  require('../src/providers/prices').usdPrices = async ids => (ids.includes(`base-sepolia:${A}`) ? { [`base-sepolia:${A}`]: tkaPrice } : {});

  const db = require('../src/config/db');
  t.after(() => db.getPool().end().catch(() => {}));
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  const approvals = require('../src/services/approvals');

  let chainResult;
  await t.test('finds every open approval, and only open ones, from the explorer; GoPlus is not asked', async () => {
    const s = await approvals.scan(owner.address, { refresh: true });
    chainResult = s.chains[0];
    assert.equal(chainResult.read, true, chainResult.reason);
    const keys = chainResult.approvals.map(a => `${a.kind}:${a.token.address}:${a.spender.address}`).sort();
    assert.deepEqual(keys, [
      `erc20:${A}:${drainer}`, `erc20:${A}:${PERMIT2.toLowerCase()}`, `erc20:${B}:${V}`, `nft_all:${N}:${nftDrainer}`, `permit2:${A}:${p2Spender}`,
    ].sort());
    assert.ok(!keys.some(k => k.includes(old)), 'an approval set back to 0 is closed');
    assert.equal(goplusAsked, 0, 'the explorer read the whole history, so GoPlus\'s allowance is saved');
    assert.ok(chainResult.approvals.every(a => a.found_by.join() === 'explorer logs'));
  });

  await t.test('when the explorer fails, GoPlus is the fallback, and the chain still decides what is open', async () => {
    explorerDown = true;
    try {
      const s = await approvals.scan(owner.address, { refresh: true });
      const c = s.chains[0];
      assert.equal(goplusAsked, 1);
      assert.equal(c.read, true);
      assert.deepEqual(c.approvals.map(a => a.spender.address), [drainer], 'only what GoPlus knows of, and still open onchain');
      assert.deepEqual(c.approvals[0].found_by, ['GoPlus']);
      assert.ok(!JSON.stringify(c).includes(ghost), 'what GoPlus lists but the chain says is closed is left out');
      assert.ok(c.not_checked.some(n => /explorer: rate limited/.test(n.reason)), 'the explorer\'s failure is reported');
    } finally {
      explorerDown = false;
    }
  });

  await t.test('rates each one with reasons that name their sources, and values what is at risk', () => {
    const get = (kind, spender) => chainResult.approvals.find(a => a.kind === kind && a.spender.address === spender);
    const d = get('erc20', drainer);
    assert.equal(d.severity, 'critical');
    assert.ok(d.reasons.some(r => /phishing, theft/.test(r.text) && /SlowMist/.test(r.source)));
    assert.ok(d.reasons.some(r => /plain wallet/.test(r.text) && /RPC/.test(r.source)));
    assert.equal(d.allowance.amount, 'unlimited');
    assert.equal(d.value_at_risk_usd, 2000, 'all 1,000 TKA at $2');
    assert.equal(d.token.symbol, 'TKA');

    const v = get('erc20', V);
    assert.equal(v.severity, 'medium', 'limited, but to a contract whose source is not published');
    assert.ok(v.reasons.some(r => /source code isn't published/.test(r.text) && r.source === 'GoPlus'));
    assert.equal(v.allowance.amount, '100.0');
    assert.equal(v.value_at_risk_usd, null);
    assert.equal(v.value_note, 'not priced by DefiLlama');

    const p = get('erc20', PERMIT2.toLowerCase());
    assert.equal(p.severity, 'low');
    assert.equal(p.recommended, false);
    assert.equal(p.spender.label, 'Uniswap Permit2');

    const p2 = get('permit2', p2Spender);
    assert.equal(p2.severity, 'high');
    assert.equal(p2.allowance.amount, '500.0');
    assert.equal(p2.value_at_risk_usd, 1000, '500 TKA at $2 (less than the balance)');
    assert.ok(p2.expires_at);

    const n = get('nft_all', nftDrainer);
    assert.equal(n.severity, 'high');
    assert.equal(n.token.symbol, 'Test NFT');

    assert.deepEqual(chainResult.approvals.map(a => a.severity), ['critical', 'high', 'high', 'medium', 'low'], 'worst first');
    const sum = approvals.summary({ chains: [chainResult] });
    assert.equal(sum.open, 5);
    assert.equal(sum.to_revoke, 4);
    assert.equal(sum.value_at_risk_usd, 3000);
    assert.equal(sum.not_priced, 2, 'TKB (no price) and the NFT approval (NFTs are not priced)');
  });

  await t.test('the prepared revokes, signed by the owner, close exactly the chosen approvals', async () => {
    const ids = chainResult.approvals.filter(a => a.recommended).map(a => a.id);
    const calls = approvals.callsFor(chainResult, ids);
    assert.equal(calls.length, 4, 'three single revokes and one Permit2 lockdown');
    assert.ok(calls.every(c => c.chain_id === 84532 && c.value === '0x0'));
    assert.ok(calls.some(c => c.to.toLowerCase() === PERMIT2.toLowerCase() && /lockdown|Permit2/.test(c.label)));
    for (const c of calls) await send(owner.sendTransaction({ to: c.to, data: c.data }));

    assert.equal(await tA.allowance(owner.address, drainer), 0n);
    assert.equal(await tB.allowance(owner.address, V), 0n);
    assert.equal(await nft.isApprovedForAll(owner.address, nftDrainer), false);
    assert.equal((await permit2.allowance(owner.address, A, p2Spender))[0], 0n);
    assert.equal(await tA.allowance(owner.address, PERMIT2), ethers.MaxUint256, 'the one not chosen is untouched');

    const again = await approvals.scan(owner.address, { refresh: true });
    assert.deepEqual(again.chains[0].approvals.map(a => a.spender.label), ['Uniswap Permit2']);
  });

  await t.test('the API: a free preview that names nothing, then the cleanup for 5 points or $1', async () => {
    const credits = require('../src/payments/credits');
    const { issueToken } = require('../src/auth/siwe');
    const { createApp } = require('../src/app');
    const server = createApp().listen(0);
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, body, token) => {
      const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json() };
    };
    // A fresh wallet with a risky approval.
    const victim = ethers.Wallet.createRandom().connect(provider);
    await fund(victim.address);
    await send(tA.mint(victim.address, 10n * 10n ** 6n));
    await send(tA.connect(victim).approve(drainer, ethers.MaxUint256));

    const pv = await call('POST', '/v1/approvals/preview', { wallet: victim.address });
    assert.equal(pv.status, 200, JSON.stringify(pv.body));
    assert.equal(pv.body.summary.open, 1);
    assert.equal(pv.body.summary.to_revoke, 1);
    assert.equal(pv.body.summary.value_at_risk_usd, 20);
    assert.ok(!JSON.stringify(pv.body).includes(drainer), 'the preview says how many and how much, not which');
    assert.equal((await call('POST', '/v1/approvals/preview', { wallet: 'nope' })).status, 400);

    const unpaid = await call('POST', '/v1/approvals/cleanup', { wallet: victim.address });
    assert.equal(unpaid.status, 402);
    assert.match(unpaid.body.message, /Approval cleanup costs \$1\.00/);
    assert.match(unpaid.body.pay_with.points, /30 free points a month/);

    const { rows } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [victim.address.toLowerCase()]);
    const token = issueToken(rows[0]);
    const pts = async () => (await call('GET', '/v1/me', null, token)).body.points;
    assert.equal((await pts()).allowance, 30, 'the victim has sent a transaction: not a new wallet');

    const paid = await call('POST', '/v1/approvals/cleanup', { wallet: victim.address }, token);
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.run.paid_with, 'points');
    assert.equal(paid.body.run.points, 5);
    assert.equal(paid.body.chains[0].approvals[0].spender.address, drainer);
    assert.equal(paid.body.chains[0].revoke_calls.length, 1);
    assert.equal((await pts()).left, 25);

    // A wallet with nothing open: no charge, the points come back.
    const clean = ethers.Wallet.createRandom().address;
    const none = await call('POST', '/v1/approvals/cleanup', { wallet: clean }, token);
    assert.equal(none.status, 422);
    assert.match(none.body.message, /nothing to clean up, and you weren't charged/);
    assert.equal((await pts()).left, 25, 'points given back');

    // Out of points: $1 from credits.
    await db.query(`UPDATE period_usage SET used = allowance WHERE subject = $1 AND key = 'points'`, [`account:${rows[0].id}`]);
    await credits.add(rows[0].id, 1000, 'adjustment', 'test:grant');
    const byCredits = await call('POST', '/v1/approvals/cleanup', { wallet: victim.address }, token);
    assert.equal(byCredits.body.run.paid_with, 'credits');
    assert.equal(await credits.balance(rows[0].id), 900);

    // A brand-new wallet gets the smaller allowance.
    const fresh = ethers.Wallet.createRandom().address.toLowerCase();
    const f = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [fresh]);
    const freshPts = (await call('GET', '/v1/me', null, issueToken(f.rows[0]))).body.points;
    assert.deepEqual([freshPts.allowance, freshPts.new_wallet], [10, true]);

    for (let i = 0; i < 2; i++) await call('POST', '/v1/approvals/preview', { wallet: clean });
    const capped = await call('POST', '/v1/approvals/preview', { wallet: clean });
    assert.equal(capped.status, 429, 'three free previews a day without signing in');
  });

  await t.test('the risk monitor: Safety Pro only; then new approvals, an upgraded spender and a depeg become alerts, once', async () => {
    const credits = require('../src/payments/credits');
    const { issueToken } = require('../src/auth/siwe');
    const monitor = require('../src/services/monitor');
    // TKA stands in for a stablecoin on this chain, so a depeg can be shown.
    require('../src/payments/stablecoins').STABLECOINS['base-sepolia'] = { tokens: { TKA: { address: A, decimals: 6 } } };
    const { createApp } = require('../src/app');
    const server = createApp().listen(0);
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const { rows } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [ethers.Wallet.createRandom().address.toLowerCase()]);
    const acct = rows[0];
    const token = issueToken(acct);
    const call = async (method, p, body) => {
      const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json() };
    };

    const refused = await call('POST', '/v1/monitor/wallets', { wallet: owner.address });
    assert.equal(refused.status, 402);
    assert.equal(refused.body.offer, 'pro_30d');
    await credits.add(acct.id, 900, 'adjustment', 'test:pro');
    assert.equal((await call('POST', '/v1/passes/pro_30d')).status, 201);

    // The owner's wallet after the cleanup above: only the usual Permit2 approval is open.
    tkaPrice = 1; // TKA "stablecoin" on peg
    const started = await call('POST', '/v1/monitor/wallets', { wallet: owner.address, label: 'main' });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.deepEqual(started.body.alerts.map(a => a.kind), ['watching_started']);
    assert.match(started.body.alerts[0].title, /no risky approvals open/);
    assert.equal(started.body.wallet.summary.open, 1);

    // Something happens: a new unlimited approval to the flagged wallet, an approval to a proxy contract, and a depeg.
    const IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
    const setImpl = a => provider.send('hardhat_setStorageAt', [V, IMPL, ethers.zeroPadValue(a, 32)]);
    await setImpl('0x' + '11'.repeat(20));
    await send(tA.connect(owner).approve(drainer, ethers.MaxUint256));
    await send(tB.connect(owner).approve(V, 7n));
    tkaPrice = 0.92;
    const [row] = (await db.query('SELECT * FROM monitored_wallets WHERE account_id = $1', [acct.id])).rows;
    const raised = await monitor.check(row);
    assert.deepEqual(raised.map(a => `${a.kind}:${a.severity}`).sort(), ['depeg:high', 'new_approval:critical', 'new_approval:medium']);
    const drain = raised.find(a => a.severity === 'critical');
    assert.ok(drain.detail.reasons.some(r => /phishing/.test(r.text) && /SlowMist/.test(r.source)), 'the reason and its source travel with the alert');

    // The proxy's code is replaced: one alert; the same state again alerts nothing.
    await setImpl('0x' + '22'.repeat(20));
    const [row2] = (await db.query('SELECT * FROM monitored_wallets WHERE id = $1', [row.id])).rows;
    const upgraded = await monitor.check(row2);
    assert.deepEqual(upgraded.map(a => a.kind), ['spender_upgraded']);
    assert.equal(upgraded[0].detail.implementation_was, '0x' + '11'.repeat(20));
    const [row3] = (await db.query('SELECT * FROM monitored_wallets WHERE id = $1', [row.id])).rows;
    assert.deepEqual(await monitor.check(row3), [], 'nothing alerted twice (the depeg once a day)');

    // The API: alerts, unread count, mark read; at most 3 wallets; stop watching.
    const list = await call('GET', '/v1/monitor');
    assert.equal(list.body.active, true);
    assert.equal(list.body.unread_alerts, 5);
    assert.equal(list.body.wallets[0].label, 'main');
    const al = await call('GET', '/v1/monitor/alerts');
    assert.equal(al.body.alerts.length, 5);
    assert.equal(al.body.alerts[0].kind, 'spender_upgraded', 'newest first');
    await call('POST', '/v1/monitor/alerts/read', { ids: [al.body.alerts[0].id] });
    assert.equal((await call('GET', '/v1/monitor')).body.unread_alerts, 4);
    await call('POST', '/v1/monitor/alerts/read', {});
    assert.equal((await call('GET', '/v1/monitor')).body.unread_alerts, 0);
    for (let i = 0; i < 2; i++) assert.equal((await call('POST', '/v1/monitor/wallets', { wallet: ethers.Wallet.createRandom().address })).status, 200);
    assert.equal((await call('POST', '/v1/monitor/wallets', { wallet: ethers.Wallet.createRandom().address })).status, 409, 'Safety Pro watches up to 3 wallets');

    // When Safety Pro ends, checks pause.
    await db.query(`UPDATE passes SET ends_at = now() - interval '1 minute' WHERE account_id = $1`, [acct.id]);
    await db.query('UPDATE monitored_wallets SET next_check_at = now() WHERE account_id = $1', [acct.id]);
    await monitor.tick();
    const paused = await call('GET', '/v1/monitor');
    assert.equal(paused.body.active, false);
    assert.ok(paused.body.wallets.every(w => w.last_error === 'Paused: Safety Pro has ended'));
    assert.equal((await call('DELETE', `/v1/monitor/wallets/${row.id}`)).status, 200);
  });
});
