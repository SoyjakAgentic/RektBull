/**
 * End-to-end against a real Postgres and a fake Base RPC node.
 * Runs only when TEST_DATABASE_URL is set (it drops and recreates the schema):
 *   TEST_DATABASE_URL=postgres://user:pass@localhost/rektbull_test npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
const MNEMONIC = ethers.Mnemonic.fromPhrase('test test test test test test test test test test test junk');
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

// A fake Base node: serves whatever logs and receipts the test puts here.
const chain = { block: 1000, logs: [], receipts: {} };
function fakeRpc() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const { method, params, id } = JSON.parse(body);
      let result = null;
      if (method === 'eth_blockNumber') result = ethers.toQuantity(chain.block);
      if (method === 'eth_getLogs') {
        const f = params[0];
        result = chain.logs.filter(l => Number(l.blockNumber) >= Number(f.fromBlock) && Number(l.blockNumber) <= Number(f.toBlock) && l.address === f.address);
      }
      if (method === 'eth_getTransactionReceipt') result = chain.receipts[params[0]] || null;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
}

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));

test('RektBull end to end', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const rpc = fakeRpc();
  const rpcPort = await listen(rpc);
  Object.assign(process.env, {
    DATABASE_URL: DB,
    JWT_SECRET: 'test-secret',
    CRYPTO_DEPOSIT_XPUB: ethers.HDNodeWallet.fromMnemonic(MNEMONIC, "m/44'/60'/0'/0").neuter().extendedKey,
    PAYMENT_CHAINS: 'base',
    RPC_URLS_BASE: `http://127.0.0.1:${rpcPort}`,
    ANTHROPIC_API_KEY: '',
    NEW_WALLET_CHECK_CHAINS: 'base', // the fake Base node: no history read, so the full allowance
  });

  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();

  const express = require('express');
  require('express-async-errors');
  const { createApp, errorHandler } = require('../src/app');
  const { optionalAuth } = require('../src/middleware/auth');
  const { paidRoute } = require('../src/payments/gate');
  const credits = require('../src/payments/credits');
  const watcher = require('../src/payments/watcher');

  // The real app, plus two test routes behind the real payment gate.
  const app = express();
  app.use(express.json());
  app.use(optionalAuth);
  let calls = 0;
  app.post('/test/quick', paidRoute('token_quick_check', { validate: () => ({ ok: true }), run: async () => ({ done: ++calls }) }));
  app.post('/test/quick-fails', paidRoute('token_quick_check', { validate: () => ({ ok: true }), run: async () => { throw new Error('provider down'); } }));
  app.post('/test/report', paidRoute('token_report', { validate: () => ({ ok: true }), run: async () => ({ done: true }) }));
  app.use('/test', errorHandler);
  app.use(createApp());
  const server = http.createServer(app);
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => { server.close(); rpc.close(); await db.getPool().end(); });

  let token = null;
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };

  // ── The pages ──
  const home = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), '/safety');
  for (const page of ['/safety', '/trade']) {
    const r = await fetch(base + page);
    assert.equal(r.status, 200, page);
    assert.match(await r.text(), /<nav class="nav">/);
  }
  assert.ok((await call('GET', '/v1/tokens/chains')).body.chains.includes('base'));

  // ── Sign in with a wallet ──
  const wallet = ethers.Wallet.createRandom();
  const nonce = await call('POST', '/v1/auth/nonce', { address: wallet.address, chain_id: 8453 });
  assert.equal(nonce.status, 200);
  const wrong = await call('POST', '/v1/auth/verify', { challenge_id: nonce.body.challenge_id, signature: await ethers.Wallet.createRandom().signMessage(nonce.body.message) });
  assert.equal(wrong.status, 401, 'another wallet\'s signature is refused');
  const ok = await call('POST', '/v1/auth/verify', { challenge_id: nonce.body.challenge_id, signature: await wallet.signMessage(nonce.body.message) });
  assert.equal(ok.status, 200);
  token = ok.body.token;
  const replay = await call('POST', '/v1/auth/verify', { challenge_id: nonce.body.challenge_id, signature: await wallet.signMessage(nonce.body.message) });
  assert.equal(replay.status, 401, 'a sign-in request works once');
  const accountId = ok.body.account.id;

  // ── Free points (30 a month; a quick check costs 1), then 402 ──
  const pts = () => call('GET', '/v1/me').then(r => r.body.points);
  assert.equal((await pts()).allowance, 30);
  assert.equal((await pts()).left, 30);
  for (let i = 0; i < 20; i++) assert.equal((await call('POST', '/test/quick')).body.run.paid_with, 'points');
  assert.equal((await call('POST', '/test/quick')).status, 402, 'at most 20 point-paid runs a day from one IP address');
  await db.query("DELETE FROM free_usage WHERE product = 'points_ip'"); // a new day for the IP cap
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/test/quick')).body.run.paid_with, 'points');
  assert.equal((await pts()).left, 0);
  const noMoney = await call('POST', '/test/quick');
  assert.equal(noMoney.status, 402);
  assert.equal(noMoney.body.credits_balance_cents, 0);
  assert.match(noMoney.body.pay_with.credits, /POST \/v1\/invoices/);
  assert.match(noMoney.body.pay_with.points, /free points are used up/);
  assert.match(noMoney.body.pay_with.safety_pro, /pro_30d/);

  // ── Credits, and refunds when a run fails ──
  await credits.add(accountId, 100, 'adjustment', 'test:grant');
  assert.equal(await credits.add(accountId, 100, 'adjustment', 'test:grant'), false, 'the same ref is never written twice');
  assert.equal((await call('POST', '/test/quick')).body.run.paid_with, 'credits');
  assert.equal(await credits.balance(accountId), 75);
  assert.equal((await call('POST', '/test/quick-fails')).status, 500);
  assert.equal(await credits.balance(accountId), 75, 'a failed run is refunded');
  assert.equal((await pts()).left, 0, 'a refunded credit run gives back credits, not points');
  assert.equal((await call('POST', '/test/report')).status, 402, 'a $3 report needs more than 75 cents');

  // ── Report is refused before charging when AI isn't configured ──
  const report = await call('POST', '/v1/tokens/report', { chain: 'base', token_address: USDC_BASE });
  assert.equal(report.status, 400);
  assert.equal(await credits.balance(accountId), 75);

  // ── Top up for a pass with USDC on Base, through the watcher ──
  const inv = await call('POST', '/v1/invoices', { chain: 'base', token: 'USDC', product: 'pro_30d' });
  assert.equal(inv.status, 201);
  assert.equal(inv.body.amount_cents, 900);
  const depositTo = inv.body.send.to;
  assert.equal(depositTo, ethers.HDNodeWallet.fromMnemonic(MNEMONIC, "m/44'/60'/0'/0/1").address.toLowerCase(), 'first account gets child 1');

  const log = {
    address: USDC_BASE,
    topics: [watcher.TRANSFER, watcher.padTopic(wallet.address), watcher.padTopic(depositTo)],
    data: ethers.toBeHex(9000000n, 32), // 9 USDC
    transactionHash: '0x' + 'ab'.repeat(32), logIndex: '0x0', blockNumber: ethers.toQuantity(1001),
  };
  chain.block = 1001;
  chain.logs.push(log);
  chain.receipts[log.transactionHash] = { status: '0x1', logs: [log] };

  await watcher.tick();
  assert.equal(await credits.balance(accountId), 75, 'not credited before 12 confirmations');
  chain.block = 1013;
  await watcher.tick();
  await watcher.tick(); // a second pass must not credit it again
  const me = await call('GET', '/v1/me');
  assert.equal(me.body.credits_cents, 75, '900 deposited, 900 spent on the pass');
  assert.equal(me.body.passes[0].product, 'pro_30d');
  assert.equal((await call('GET', `/v1/invoices/${inv.body.id}`)).body.status, 'paid');
  assert.equal((await call('POST', '/test/quick')).body.run.paid_with, 'pass');
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/test/report')).body.run.paid_with, 'pass', 'Safety Pro includes 5 reports a month');
  assert.deepEqual((await call('GET', '/v1/me')).body.pass_included.token_report, { allowance: 5, used: 5, left: 0 });
  assert.equal((await call('POST', '/test/report')).status, 402, 'the sixth needs credits ($3, and there are 75 cents)');
  assert.equal((await call('GET', '/v1/me')).body.passes[0].title, 'Safety Pro, 30 days');

  // ── A reorged deposit is never credited ──
  const ghost = { ...log, transactionHash: '0x' + 'cd'.repeat(32), blockNumber: ethers.toQuantity(1014) };
  chain.block = 1014;
  chain.logs.push(ghost);
  await watcher.tick();
  chain.block = 1030; // confirmed depth, but the receipt is gone
  await watcher.tick();
  const { rows } = await db.query('SELECT status FROM deposits WHERE tx_hash = $1', [ghost.transactionHash]);
  assert.equal(rows[0].status, 'reorged');
  assert.equal(await credits.balance(accountId), 75);
});
