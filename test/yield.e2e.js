/**
 * Yield proposals, end to end, on a local copy of Base mainnet: the real
 * Aave v3, Compound v3 and Spark sUSDC contracts, the RektBull API, moves
 * sent from the wallet (deposit, move, exit), the 0.1% fee read back from
 * the receipts, the risk watcher's warnings and its alerts.
 *
 * Market conditions change, so the rules' thresholds are relaxed here and
 * the move goes from whichever venue pays least to whichever pays most at
 * the fork block. Simulations run on the node and are rolled back.
 *
 *   TEST_DATABASE_URL=postgres://… node --test test/yield.e2e.js
 *   (BASE_MAINNET_RPC_URL to fork from your own endpoint)
 *
 * Not part of `npm test`: it starts a Hardhat node forking Base mainnet.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
const CONTRACTS = path.join(__dirname, '..', 'contracts');
const PORT = 8550;
const FORK = process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org';

function startNode() {
  return new Promise((resolve, reject) => {
    const node = spawn('npx', ['hardhat', '--network', 'default', 'node', '--port', String(PORT), '--fork', FORK, '--chain-id', '8453'], { cwd: CONTRACTS, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    node.stop = () => { try { process.kill(-node.pid, 'SIGTERM'); } catch { /* already gone */ } node.stdout.destroy(); node.stderr.destroy(); };
    const timer = setTimeout(() => reject(new Error('hardhat node did not start')), 120000);
    node.stdout.on('data', d => { if (/Started HTTP/.test(String(d))) { clearTimeout(timer); resolve(node); } });
    node.on('exit', code => { clearTimeout(timer); reject(new Error(`hardhat node exited ${code}`)); });
  });
}

test('yield proposals, end to end on a Base fork', { skip: !DB && 'set TEST_DATABASE_URL', timeout: 900000 }, async t => {
  const node = await startNode();
  t.after(() => node.stop());
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, 8453, { staticNetwork: true, cacheTimeout: -1 });
  t.after(() => provider.destroy());
  const fund = a => provider.send('hardhat_setBalance', [a, '0x' + (10n ** 20n).toString(16)]);
  await provider.send('evm_mine', []);

  const wallet = ethers.Wallet.createRandom().connect(provider);
  const me = wallet.address.toLowerCase();
  const feeWallet = ethers.Wallet.createRandom().address.toLowerCase();
  await fund(wallet.address);

  Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test', RPC_URLS_BASE: `http://127.0.0.1:${PORT}`, NEW_WALLET_CHECK_CHAINS: '', YIELD_FEE_WALLET_EVM: feeWallet });
  const venues = require('../src/yield/venues');
  const USDC = venues.TOKENS.base.USDC.address;
  // 1,000 USDC for the wallet, from Aave's USDC reserve (the aToken holds the cash).
  const reserve = venues.venue('aave-v3', 'base').aTokens.USDC;
  await provider.send('hardhat_impersonateAccount', [reserve]);
  await fund(reserve);
  const usdc = new ethers.Contract(USDC, ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], provider);
  await (await usdc.connect(new ethers.JsonRpcSigner(provider, reserve)).transfer(me, 1000n * 10n ** 6n)).wait();

  // Stand-ins: other chains aren't on this node, and DefiLlama isn't needed.
  require('../src/yield/rates').llamaRows = async () => null;
  const positions = require('../src/yield/positions');
  const realRead = positions.read;
  positions.read = (w, opts = {}) => realRead(w, { chains: ['base'], ...opts });
  // eth_simulateV1, played by the node: each call sent from the wallet, then all rolled back.
  require('../src/services/presign').simulate = async (_chain, from, calls) => {
    const snap = await provider.send('evm_snapshot', []);
    try {
      await provider.send('hardhat_impersonateAccount', [from]);
      const out = [];
      for (const c of calls) {
        try {
          const hash = await provider.send('eth_sendTransaction', [{ from, to: c.to, data: c.data, value: c.value || '0x0', gas: '0x7a1200' }]);
          const r = await provider.getTransactionReceipt(hash);
          out.push({ status: r.status === 1 ? '0x1' : '0x0', gasUsed: ethers.toQuantity(r.gasUsed), logs: r.logs.map(l => ({ address: l.address, topics: l.topics, data: l.data })) });
        } catch (err) { out.push({ status: '0x0', gasUsed: '0x0', logs: [], error: { message: err.shortMessage || err.message } }); }
      }
      return out;
    } finally { await provider.send('evm_revert', [snap]); }
  };
  const rules = require('../src/yield/rules');
  Object.assign(rules.RULES, { min_apy_gain_pct: 0, max_utilization_pct: 100, breakeven_days: 365 });

  const db = require('../src/config/db');
  t.after(() => db.getPool().end().catch(() => {}));
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  const { createApp } = require('../src/app');
  const { issueToken } = require('../src/auth/siwe');
  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const account = async w => (await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [w])).rows[0];
  const pro = await account(me);
  await db.query(`INSERT INTO passes (account_id, product, starts_at, ends_at) VALUES ($1, 'pro_30d', now(), now() + interval '30 days')`, [pro.id]);
  const proToken = issueToken(pro);
  const plainToken = issueToken(await account('0x' + '12'.repeat(20)));
  const send = async p => {
    const hashes = [];
    for (const c of p.calls) { const tx = await wallet.sendTransaction({ to: c.to, data: c.data }); const r = await tx.wait(); assert.equal(r.status, 1, c.label); hashes.push(tx.hash); }
    return hashes;
  };

  // The venues at the fork block, worst and best paying for USDC.
  const rates = (await call(null, 'GET', '/v1/yield/rates')).body.rates.filter(r => r.chain === 'base' && r.asset === 'USDC' && r.apy_pct !== null);
  assert.equal(rates.length, 3, 'Aave, Compound and Spark rates read from their contracts');
  rates.sort((a, b) => a.apy_pct - b.apy_pct);
  const [low, , high] = rates;

  await t.test('free: the wallet\'s balances and how many proposals; Safety Pro: the proposals themselves', async () => {
    const s = await call(null, 'POST', '/v1/yield/wallet', { wallet: me });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.deepEqual(s.body.idle.find(i => i.asset === 'USDC').amount, '1000.0');
    assert.ok(s.body.proposals_count >= 1);
    assert.equal(s.body.proposals, undefined, 'which ones is Safety Pro');
    assert.equal((await call(null, 'POST', '/v1/yield/proposals', { wallet: me })).status, 401);
    const no = await call(plainToken, 'POST', '/v1/yield/proposals', { wallet: me });
    assert.equal(no.status, 402);
    assert.equal(no.body.error, 'safety_pro_required');
    const yes = await call(proToken, 'POST', '/v1/yield/proposals', { wallet: me });
    const usdcProposal = yes.body.proposals.find(p => p.asset === 'USDC');
    assert.equal(usdcProposal.to.protocol, high.protocol, 'the best-paying venue');
    assert.equal(usdcProposal.kind, 'deposit');
    assert.ok(usdcProposal.checks.gas_usd_max >= 0 && usdcProposal.fee_usd > 0, 'gas and the fee are counted');
  });

  let into;
  await t.test('a deposit the user chose: the 0.1% fee, an exact approval, and the deposit, sent from the wallet', async () => {
    const p = await call(proToken, 'POST', '/v1/yield/moves/prepare', { wallet: me, chain: 'base', asset: 'USDC', to: low.protocol, amount_usd: 500 });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual(p.body.calls.map(c => c.step), ['fee', 'approve', 'deposit']);
    assert.deepEqual([p.body.summary.moved, p.body.summary.fee, p.body.summary.deposited], ['500.0', '0.5', '499.5']);
    const approve = new ethers.Interface(['function approve(address,uint256)']).decodeFunctionData('approve', p.body.calls[1].data);
    assert.equal(approve[1], 4995n * 10n ** 5n, 'exactly the deposit, never unlimited');
    const done = await call(null, 'POST', `/v1/yield/moves/${p.body.move_id}/confirm`, { tx_hashes: await send(p.body) });
    assert.equal(done.body.status, 'confirmed', JSON.stringify(done.body));
    assert.equal(done.body.fee_paid, '500000');
    assert.equal(await usdc.balanceOf(feeWallet), 500000n);
    const s = await call(proToken, 'POST', '/v1/yield/proposals', { wallet: me });
    into = s.body.positions.find(x => x.protocol === low.protocol);
    assert.ok(Number(into.amount) >= 499.49, `the position is there (${into?.amount})`);
  });

  await t.test('a proposed move to the better venue: withdraw, fee, approve, deposit; the position moves', async () => {
    const s = await call(proToken, 'POST', '/v1/yield/proposals', { wallet: me });
    const move = s.body.proposals.find(x => x.kind === 'move' && x.from.protocol === low.protocol);
    assert.ok(move, JSON.stringify(s.body.not_proposed));
    assert.equal(move.to.protocol, high.protocol);
    const p = await call(proToken, 'POST', '/v1/yield/moves/prepare', { wallet: me, chain: 'base', asset: 'USDC', from: low.protocol, to: high.protocol, all: true });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual(p.body.calls.map(c => c.step), ['withdraw', 'fee', 'approve', 'deposit']);
    assert.equal(p.body.atomic, true);
    const done = await call(null, 'POST', `/v1/yield/moves/${p.body.move_id}/confirm`, { tx_hashes: await send(p.body) });
    assert.equal(done.body.status, 'confirmed');
    const after = await call(proToken, 'POST', '/v1/yield/proposals', { wallet: me });
    const at = after.body.positions.find(x => x.protocol === high.protocol);
    assert.ok(Number(at.amount) > 498, `moved (${at?.amount})`);
    assert.ok(!after.body.positions.some(x => x.protocol === low.protocol && Number(x.amount) > 0.01), 'nothing left behind');
  });

  await t.test('refused: more than the wallet holds; a destination the risk watcher warns about; a non-Pro move', async () => {
    const big = await call(proToken, 'POST', '/v1/yield/moves/prepare', { wallet: me, chain: 'base', asset: 'USDC', to: low.protocol, amount_usd: 5000 });
    assert.equal(big.status, 422);
    assert.match(big.body.message, /less than/);
    await db.query(`INSERT INTO yield_risk_state (key, value) VALUES ('warnings', $1)`, [JSON.stringify({ [`${low.protocol}:base:USDC`]: { severity: 'critical', reason: 'test: a market in trouble', name: low.name, asset: 'USDC' } })]);
    const warned = await call(proToken, 'POST', '/v1/yield/moves/prepare', { wallet: me, chain: 'base', asset: 'USDC', to: low.protocol, amount_usd: 100 });
    assert.equal(warned.status, 422);
    assert.match(warned.body.message, /risk watcher warns/);
    assert.equal((await call(plainToken, 'POST', '/v1/yield/moves/prepare', { wallet: me, chain: 'base', asset: 'USDC', to: low.protocol, amount_usd: 100 })).status, 402);
    const listed = await call(null, 'GET', '/v1/yield/rates');
    assert.equal(listed.body.warnings[0].reason, 'test: a market in trouble', 'warnings are shown with the rates');
  });

  await t.test('a warning on a venue a watched wallet is in raises a risk monitor alert, linking to the exit', async () => {
    const { rows: [w] } = await db.query('INSERT INTO monitored_wallets (account_id, wallet) VALUES ($1, $2) RETURNING id', [pro.id, me]);
    const risk = require('../src/yield/risk');
    const n = await risk.alertHolders({ [`${high.protocol}:base:USDC`]: { severity: 'critical', reason: `${high.name} USDC on Base is 99% borrowed: withdrawals may stop.`, source: `${high.name}'s contracts onchain` } });
    assert.equal(n, 1);
    const { rows: [a] } = await db.query('SELECT * FROM monitor_alerts WHERE wallet_id = $1', [w.id]);
    assert.equal(a.kind, 'yield_risk');
    assert.match(a.title, /^Withdraw now: /);
    const m = require('../src/alerts/format').message(a);
    assert.match(m.url, /\/find\?wallet=0x[0-9a-f]{40}#yield-card$/);
    assert.equal(m.action, 'Review and withdraw');
    assert.equal(await risk.alertHolders({ [`${high.protocol}:base:USDC`]: { severity: 'critical', reason: 'again', source: 'x' } }), 0, 'not twice the same day');

    const d = await risk.detect({ chains: ['base'] });
    assert.ok(d.notRead.every(x => !/on base/.test(x.check)), JSON.stringify(d.notRead));
  });

  await t.test('an exit to the wallet: free, for anyone, never refused by the rules', async () => {
    await db.query(`UPDATE yield_risk_state SET value = $1 WHERE key = 'warnings'`, [JSON.stringify({ [`${high.protocol}:base:USDC`]: { severity: 'critical', reason: 'warned', name: high.name, asset: 'USDC' } })]);
    const before = await usdc.balanceOf(me);
    const p = await call(null, 'POST', '/v1/yield/moves/prepare', { wallet: me, chain: 'base', asset: 'USDC', from: high.protocol, all: true });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual(p.body.calls.map(c => c.step), ['withdraw']);
    assert.equal(p.body.summary.fee, '0.0');
    assert.match(p.body.summary.fee_reason, /free/);
    await send(p.body);
    assert.ok(await usdc.balanceOf(me) - before > 498n * 10n ** 6n, 'the money is back in the wallet');
  });
});
