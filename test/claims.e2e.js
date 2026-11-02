/**
 * Find money, end to end, on a local copy of Base Sepolia: a Uniswap-style
 * airdrop an admin adds, Merkl's Distributor (a stand-in at Merkl's own
 * address), a reward token and a points token that can't be transferred
 * yet, the RektBull API, real claims sent from the wallet, and the claim fee
 * read back from the receipts.
 *
 * Merkl's API is played by its cached answer; GoPlus and prices are
 * stand-ins. Simulations are real: each runs on the node and is rolled back.
 *
 *   cd contracts && npm install && npx hardhat compile && cd ..
 *   TEST_DATABASE_URL=postgres://… node --test test/claims.e2e.js
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
const built = fs.existsSync(path.join(CONTRACTS, 'artifacts', 'contracts', 'test', 'ClaimMocks.sol', 'MockMerklDistributor.json'));
const PORT = 8549;
const MERKL = '0x3ef3d8ba38ebe18db133cec108f4d14ce00dd9ae';
const coder = ethers.AbiCoder.defaultAbiCoder();

function startNode() {
  return new Promise((resolve, reject) => {
    const node = spawn('npx', ['hardhat', '--network', 'default', 'node', '--port', String(PORT)], { cwd: CONTRACTS, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    node.stop = () => { try { process.kill(-node.pid, 'SIGTERM'); } catch { /* already gone */ } node.stdout.destroy(); node.stderr.destroy(); };
    const timer = setTimeout(() => reject(new Error('hardhat node did not start')), 120000);
    node.stdout.on('data', d => { if (/Started HTTP/.test(String(d))) { clearTimeout(timer); resolve(node); } });
    node.on('exit', code => { clearTimeout(timer); reject(new Error(`hardhat node exited ${code}`)); });
  });
}

/** A sorted-pair Merkle tree (OpenZeppelin's MerkleProof): root and a proof per leaf. */
function tree(leaves) {
  const pair = (a, b) => (BigInt(a) < BigInt(b) ? ethers.keccak256(ethers.concat([a, b])) : ethers.keccak256(ethers.concat([b, a])));
  const layers = [leaves];
  while (layers.at(-1).length > 1) {
    const l = layers.at(-1); const next = [];
    for (let i = 0; i < l.length; i += 2) next.push(i + 1 < l.length ? pair(l[i], l[i + 1]) : l[i]);
    layers.push(next);
  }
  const proof = i => {
    const p = [];
    for (const l of layers.slice(0, -1)) { const s = i % 2 ? i - 1 : i + 1; if (s < l.length) p.push(l[s]); i = Math.floor(i / 2); }
    return p;
  };
  return { root: layers.at(-1)[0], proof };
}

test('find money, end to end', { skip: (!DB && 'set TEST_DATABASE_URL') || (!built && 'build the contracts first'), timeout: 600000 }, async t => {
  const node = await startNode();
  t.after(() => node.stop());
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, 84532, { staticNetwork: true, cacheTimeout: -1 });
  t.after(() => provider.destroy());
  const fund = a => provider.send('hardhat_setBalance', [a, '0x' + (10n ** 20n).toString(16)]);
  await provider.send('evm_mine', []);

  const deployerKey = ethers.Wallet.createRandom();
  const deployer = new ethers.NonceManager(deployerKey.connect(provider));
  const claimer = ethers.Wallet.createRandom().connect(provider);
  const admin = ethers.Wallet.createRandom();
  const other = ethers.Wallet.createRandom().address.toLowerCase();
  const third = ethers.Wallet.createRandom().address.toLowerCase();
  const feeWallet = ethers.Wallet.createRandom().address.toLowerCase();
  const me = claimer.address.toLowerCase();
  for (const w of [deployerKey, claimer]) await fund(w.address);
  const deploy = async (file, name, args) => {
    const a = ART(`${file}/${name}.json`);
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, deployer).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const send = async p => (await p).wait();

  // A Uniswap-style airdrop of AIR: 100 to the claimer, and two others.
  const air = await deploy('test/Mocks.sol', 'MockERC20', ['Airdrop', 'AIR', 18]);
  const AIR = air.target.toLowerCase();
  const drop = [[0, me, 100n * 10n ** 18n], [1, other, 40n * 10n ** 18n], [2, third, 7n * 10n ** 18n]];
  const dropTree = tree(drop.map(([i, a, v]) => ethers.solidityPackedKeccak256(['uint256', 'address', 'uint256'], [i, a, v])));
  const distributor = await deploy('test/ClaimMocks.sol', 'MockMerkleDistributor', [AIR, dropTree.root]);
  await send(air.mint(distributor.target, 147n * 10n ** 18n));
  const published = { merkleRoot: dropTree.root, tokenTotal: '0x' + (147n * 10n ** 18n).toString(16), claims: Object.fromEntries(drop.map(([i, a, v], k) => [ethers.getAddress(a), { index: i, amount: '0x' + v.toString(16), proof: dropTree.proof(k) }])) };

  // Merkl: its Distributor's code at its own address, a reward token (RWD) and points that can't move yet (PTS).
  const merklImpl = await deploy('test/ClaimMocks.sol', 'MockMerklDistributor', []);
  await provider.send('hardhat_setCode', [MERKL, await provider.getCode(merklImpl.target)]);
  const merkl = new ethers.Contract(MERKL, ART('test/ClaimMocks.sol/MockMerklDistributor.json').abi, deployer);
  const rwd = await deploy('test/Mocks.sol', 'MockERC20', ['Reward', 'RWD', 6]);
  const pts = await deploy('test/ClaimMocks.sol', 'MockLockedToken', [MERKL]);
  const RWD = rwd.target.toLowerCase(), PTS = pts.target.toLowerCase();
  await send(rwd.mint(MERKL, 2000n * 10n ** 6n));
  await send(pts.mint(MERKL, 1000n * 10n ** 18n));
  const rewards = [[me, RWD, 1000n * 10n ** 6n], [me, PTS, 500n * 10n ** 18n], [other, RWD, 5n * 10n ** 6n]];
  const merklTree = tree(rewards.map(([u, tk, v]) => ethers.keccak256(coder.encode(['address', 'address', 'uint256'], [u, tk, v]))));
  await send(merkl.setRoot(merklTree.root));
  const merklAnswer = user => rewards.map((r, k) => ({ r, k })).filter(({ r }) => r[0] === user).map(({ r: [, tk, v], k }) => ({
    chain_id: 84532, dispute_ends: null, token: tk, symbol: tk === RWD ? 'RWD' : 'PTS', decimals: tk === RWD ? 6 : 18, price: null,
    amount: v.toString(), pending: '0', root: merklTree.root, proofs: merklTree.proof(k), campaigns: 2,
  }));

  // The service, pointed at the local node.
  Object.assign(process.env, {
    DATABASE_URL: DB, JWT_SECRET: 'test', RPC_URLS_BASE_SEPOLIA: `http://127.0.0.1:${PORT}`, NEW_WALLET_CHECK_CHAINS: '',
    CLAIM_FEE_WALLET_EVM: feeWallet, ADMIN_WALLETS: admin.address,
  });
  require('../src/providers/chains').EVM['base-sepolia'] = { chainId: 84532 };
  let honeypot = null;
  require('../src/services/tokenRisk').goplus = async (_c, tk) => ({ source: 'GoPlus', honeypot: tk === honeypot, sell_tax_pct: 0 });
  require('../src/providers/prices').usdPrices = async ids => Object.fromEntries(ids.filter(id => id.endsWith(RWD)).map(id => [id, 1]));
  require('../src/providers/prices').usdPrice = async () => 3000;
  // eth_simulateV1, played by the node: each call sent from the wallet, then all rolled back.
  require('../src/services/presign').simulate = async (_chain, from, calls) => {
    const snap = await provider.send('evm_snapshot', []);
    try {
      await provider.send('hardhat_impersonateAccount', [from]);
      await fund(from);
      const out = [];
      for (const c of calls) {
        try {
          const hash = await provider.send('eth_sendTransaction', [{ from, to: c.to, data: c.data, value: c.value || '0x0', gas: '0x2dc6c0' }]);
          const r = await provider.getTransactionReceipt(hash);
          out.push({ status: r.status === 1 ? '0x1' : '0x0', gasUsed: ethers.toQuantity(r.gasUsed), logs: r.logs.map(l => ({ address: l.address, topics: l.topics, data: l.data })) });
        } catch (err) {
          out.push({ status: '0x0', gasUsed: '0x0', logs: [], error: { message: err.shortMessage || err.message } });
        }
      }
      return out;
    } finally {
      await provider.send('evm_revert', [snap]);
    }
  };

  const db = require('../src/config/db');
  t.after(() => db.getPool().end().catch(() => {}));
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  const cache = require('../src/lib/cache');
  for (const u of [me, other, third]) await cache.set(`merkl:rewards:${u}`, merklAnswer(u), 600);
  const claims = require('../src/services/claims');
  const { createApp } = require('../src/app');
  const { issueToken } = require('../src/auth/siwe');
  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const mkAccount = async wallet => issueToken((await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [wallet.toLowerCase()])).rows[0]);
  const adminToken = await mkAccount(admin.address);
  const proToken = await mkAccount(me);
  await db.query(`INSERT INTO passes (account_id, product, starts_at, ends_at) SELECT id, 'pro_30d', now(), now() + interval '30 days' FROM accounts WHERE wallet = $1`, [me]);
  const program = { slug: 'test-drop', name: 'Test Drop', chain: 'base-sepolia', distributor: distributor.target, token: AIR, format: 'uniswap', tree_url: 'https://example.org/tree.json', official_url: 'https://example.org/claim', source: 'the project\'s announcement' };

  await t.test('an airdrop is added only when its tree matches the distributor onchain', async () => {
    const parsed = claims.parseProgram(program);
    assert.equal(parsed.error, undefined);
    const wrong = { ...published, merkleRoot: ethers.id('another tree') };
    await assert.rejects(claims.addProgram(parsed, null, { fetchTree: async () => wrong }), /isn't the distributor's onchain root/);
    await assert.rejects(claims.addProgram(claims.parseProgram({ ...program, format: 'oz-standard', claim_signature: 'claim(address account,uint256 amount,bytes32[] proof)', claimed_signature: 'hasClaimed(address account)' }), null, { fetchTree: async () => published }), /StandardMerkleTree/);
    const added = await claims.addProgram(parsed, null, { fetchTree: async () => published });
    assert.equal(added.program.entries, 3);
    assert.equal(added.checks.root_matches_onchain, true);
    assert.equal(added.checks.simulated_claim.received, (100n * 10n ** 18n).toString(), 'a real claim was simulated');

    assert.equal((await call(adminToken, 'POST', '/v1/admin/airdrops', { ...program, slug: 'x2', tree_url: 'http://example.org/t.json' })).status, 400, 'trees come over https');
    assert.equal((await call(proToken, 'POST', '/v1/admin/airdrops', { ...program, slug: 'x3' })).status, 403, 'only admins add airdrops');
    assert.deepEqual((await call(null, 'GET', '/v1/claims/programs')).body.programs.map(p => p.slug), ['test-drop']);
  });

  let found;
  await t.test('the free check finds the airdrop and Merkl rewards, each checked onchain, at 5% (3% with Safety Pro)', async () => {
    const anon = await call(null, 'POST', '/v1/claims/check', { wallet: claimer.address });
    assert.equal(anon.status, 200, JSON.stringify(anon.body));
    assert.equal(anon.body.fee.rate, '5%');
    const pro = await call(proToken, 'POST', '/v1/claims/check', { wallet: claimer.address });
    assert.equal(pro.body.fee.rate, '3%');
    assert.equal(pro.body.fee.safety_pro, true);
    found = Object.fromEntries(pro.body.items.map(i => [i.token.symbol, i]));
    assert.deepEqual(Object.keys(found).sort(), ['AIR', 'PTS', 'RWD']);
    for (const i of Object.values(found)) {
      assert.equal(i.status, 'claimable', `${i.token.symbol}: ${i.reason}`);
      assert.ok(i.checks.length >= 3, 'each says what was checked');
      assert.equal(i._claim, undefined, 'claim internals stay on the server');
    }
    assert.equal(found.AIR.claimable, '100.0');
    assert.equal(found.AIR.source, 'program');
    assert.equal(found.RWD.claimable, '1000.0');
    assert.equal(found.RWD.claimable_usd, 1000);
    assert.equal(found.RWD.price_source, 'DefiLlama');
    assert.equal(pro.body.summary.claimable, 3);
    assert.equal(pro.body.summary.not_priced, 2);
    assert.ok(pro.body.sources.every(s => s.read));
  });

  await t.test('a Merkl claim is prepared with a 3% fee for RWD, and none for points that can\'t move', async () => {
    honeypot = RWD;
    const refused = await call(proToken, 'POST', '/v1/claims/prepare', { wallet: claimer.address, chain: 'base-sepolia', ids: [found.RWD.id] });
    assert.equal(refused.status, 422);
    assert.match(refused.body.message, /can't be sold/);
    honeypot = null;
    cache._memory.clear(); // GoPlus's answer is cached a day
    await db.query(`DELETE FROM cache WHERE key LIKE 'claims:goplus:%'`);

    const p = await call(proToken, 'POST', '/v1/claims/prepare', { wallet: claimer.address, chain: 'base-sepolia', ids: [found.RWD.id, found.PTS.id] });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.calls.length, 2, 'the claim, and one fee transfer');
    assert.equal(p.body.atomic, true);
    assert.equal(p.body.fee.bps, 300);
    assert.equal(p.body.fee.to, feeWallet);
    const [rw, pt] = ['RWD', 'PTS'].map(s => p.body.summary.find(x => x.token.symbol === s));
    assert.deepEqual([rw.receive, rw.fee, rw.keep], ['1000.0', '30.0', '970.0']);
    assert.equal(rw.fee_usd, 30);
    assert.equal(pt.fee_raw, '0');
    assert.match(pt.fee_reason, /can't be transferred yet/);
    const fee = new ethers.Interface(['function transfer(address,uint256)']).decodeFunctionData('transfer', p.body.calls[1].data);
    assert.deepEqual([p.body.calls[1].to, fee[0].toLowerCase(), fee[1]], [RWD, feeWallet, 30n * 10n ** 6n], 'a plain transfer of the fee, no approval');

    // The wallet sends them; RektBull reads the receipts.
    const hashes = [];
    for (const c of p.body.calls) { const tx = await claimer.sendTransaction({ to: c.to, data: c.data }); await tx.wait(); hashes.push(tx.hash); }
    const done = await call(null, 'POST', `/v1/claims/${p.body.claim_id}/confirm`, { tx_hashes: hashes });
    assert.equal(done.body.status, 'confirmed', JSON.stringify(done.body));
    assert.deepEqual(done.body.received, { [RWD]: (1000n * 10n ** 6n).toString(), [PTS]: (500n * 10n ** 18n).toString() });
    assert.deepEqual(done.body.fee_paid, { [RWD]: (30n * 10n ** 6n).toString() });
    assert.equal(await rwd.balanceOf(claimer.address), 970n * 10n ** 6n);
    assert.equal(await rwd.balanceOf(feeWallet), 30n * 10n ** 6n);
    const { rows: [row] } = await db.query('SELECT status, fee_bps, fee_wallet FROM claims WHERE id = $1', [p.body.claim_id]);
    assert.deepEqual(row, { status: 'confirmed', fee_bps: 300, fee_wallet: feeWallet });
  });

  await t.test('the airdrop claim, signed out, carries the 5% fee', async () => {
    const p = await call(null, 'POST', '/v1/claims/prepare', { wallet: claimer.address, chain: 'base-sepolia', ids: [found.AIR.id] });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual([p.body.summary[0].fee, p.body.summary[0].keep], ['5.0', '95.0']);
    const hashes = [];
    for (const c of p.body.calls) { const tx = await claimer.sendTransaction({ to: c.to, data: c.data }); await tx.wait(); hashes.push(tx.hash); }
    const done = await call(null, 'POST', `/v1/claims/${p.body.claim_id}/confirm`, { tx_hashes: hashes });
    assert.equal(done.body.status, 'confirmed');
    assert.equal(await air.balanceOf(feeWallet), 5n * 10n ** 18n);
  });

  await t.test('what was claimed isn\'t found again, and can\'t be prepared again', async () => {
    const again = await call(proToken, 'POST', '/v1/claims/check', { wallet: claimer.address });
    assert.deepEqual(again.body.items, []);
    const p = await call(proToken, 'POST', '/v1/claims/prepare', { wallet: claimer.address, chain: 'base-sepolia', ids: [found.AIR.id] });
    assert.equal(p.status, 422);
    assert.match(p.body.message, /wasn't found/);
  });

  await t.test('when Merkl\'s root onchain isn\'t the one its proofs are for, nothing is offered', async () => {
    await send(merkl.setRoot(ethers.id('next update')));
    const r = await call(null, 'POST', '/v1/claims/check', { wallet: other });
    const i = r.body.items.find(x => x.source === 'merkl');
    assert.equal(r.body.items.find(x => x.source === 'program').status, 'claimable', 'the other source is unaffected');
    assert.equal(i.status, 'updating');
    assert.match(i.reason, /publishing an update/);
    const p = await call(null, 'POST', '/v1/claims/prepare', { wallet: other, chain: 'base-sepolia', ids: [i.id] });
    assert.equal(p.status, 422);
  });

  await t.test('free checks are limited per day without signing in', async () => {
    let status = 200;
    for (let k = 0; k < 6 && status === 200; k++) status = (await call(null, 'POST', '/v1/claims/check', { wallet: third })).status;
    assert.equal(status, 429);
    assert.equal((await call(null, 'POST', '/v1/claims/check', { wallet: 'nope' })).status, 400, 'checked before it counts');
  });
});
