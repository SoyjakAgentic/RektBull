/**
 * Extension tokens against a real Postgres: what a token the browser
 * extension holds can and can't do, and revoking it. The pre-sign check runs
 * through the payment gate (a point, or Safety Pro).
 * Runs only when TEST_DATABASE_URL is set.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;

test('extension tokens: only their routes, revocable; pre-sign checks cost a point', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test-secret', NEW_WALLET_CHECK_CHAINS: '' });
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());
  require('../src/providers/goplus').phishingSite = async () => ({ source: 'GoPlus', phishing: false });

  const { createApp } = require('../src/app');
  const { issueToken } = require('../src/auth/siwe');
  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { rows: [acct] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', ['0x' + 'ab'.repeat(20)]);
  const session = issueToken(acct);
  const call = async (token, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const made = await call(session, 'POST', '/v1/extension/tokens', { label: 'Chrome' });
  assert.equal(made.status, 201);
  const ext = made.body.token;
  assert.equal(made.body.expires_in_days, 180);

  // What it can do.
  assert.equal((await call(ext, 'GET', '/v1/me')).status, 200);
  assert.equal((await call(ext, 'GET', '/v1/monitor')).status, 200);
  const signIn = ethers.hexlify(ethers.toUtf8Bytes('hello'));
  const check = await call(ext, 'POST', '/v1/presign/check', { chain_id: 8453, from: acct.wallet, origin: 'https://app.example', method: 'personal_sign', params: [signIn, acct.wallet] });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.equal(check.body.verdict, 'low');
  assert.deepEqual([check.body.run.paid_with, check.body.run.points], ['points', 1]);
  assert.equal((await call(ext, 'POST', '/v1/presign/check', { method: 'eth_getBalance', params: [] })).status, 400, 'checked before charging');

  // What it can't do: anything else counts as signed out.
  for (const [m, p] of [['POST', '/v1/passes/pro_30d'], ['POST', '/v1/invoices'], ['POST', '/v1/extension/tokens'], ['POST', '/v1/monitor/wallets'], ['GET', '/v1/alerts/channels'], ['POST', '/v1/approvals/cleanup']]) {
    const r = await call(ext, m, p, m === 'GET' ? undefined : { wallet: acct.wallet });
    assert.ok([401, 402].includes(r.status), `${m} ${p} answered ${r.status}`);
    if (r.status === 402) assert.equal(r.body.credits_balance_cents, undefined, `${m} ${p} ran as signed out`);
  }

  // Listed, and revocable at once.
  const list = await call(session, 'GET', '/v1/extension/tokens');
  assert.deepEqual(list.body.tokens.map(x => x.label), ['Chrome']);
  assert.ok(list.body.tokens[0].last_used_at, 'last use is shown');
  assert.equal((await call(session, 'DELETE', `/v1/extension/tokens/${list.body.tokens[0].jti}`)).status, 200);
  assert.equal((await call(ext, 'GET', '/v1/me')).status, 401, 'a revoked token stops working at once');
  assert.deepEqual((await call(session, 'GET', '/v1/extension/tokens')).body.tokens, []);
});
