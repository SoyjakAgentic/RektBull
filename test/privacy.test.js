/**
 * What the privacy page promises, checked against the code and a real
 * Postgres: the page itself, downloading and deleting your data, the
 * retention periods, hashed IP addresses, and what a pre-sign check keeps.
 * Runs only when TEST_DATABASE_URL is set.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;

test('privacy: the page, download, delete, retention, hashed IPs, minimal pre-sign records', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test-secret', NEW_WALLET_CHECK_CHAINS: '', OPERATOR_NAME: 'Bull & <Co>', PRIVACY_CONTACT: 'privacy@rektbull.test' });
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
  const { rows: [acct] } = await db.query(`INSERT INTO accounts (wallet, email) VALUES ($1, 'me@example.com') RETURNING id, wallet`, ['0x' + 'ab'.repeat(20)]);
  const token = issueToken(acct);
  const call = async (method, p, body, tok = token) => {
    const r = await fetch(base + p, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, location: r.headers.get('location'), body: await r.json().catch(() => null) };
  };

  await t.test('the page names the operator and contact (escaped), and has no placeholders left', async () => {
    const html = await (await fetch(base + '/privacy')).text();
    assert.match(html, /RektBull is run by Bull &amp; &lt;Co&gt;\./);
    assert.match(html, /mailto:privacy@rektbull\.test/);
    assert.ok(!html.includes('{{'), 'no placeholder left');
    assert.equal((await call('GET', '/privacy.html')).location, '/privacy', 'the raw file is never served');
    for (const page of ['/safety', '/extension', '/trade']) assert.match(await (await fetch(base + page)).text(), /href="\/privacy"/, `${page} links to it`);
  });

  // Data across features.
  await require('../src/payments/credits').add(acct.id, 500, 'adjustment', 'test:grant');
  await db.query(`INSERT INTO monitored_wallets (account_id, wallet, label) VALUES ($1, $2, 'main')`, [acct.id, acct.wallet]);
  await db.query(`INSERT INTO monitor_alerts (account_id, wallet, kind, severity, title, dedupe_key) VALUES ($1, $2, 'depeg', 'high', 'x', 'k1')`, [acct.id, acct.wallet]);
  await db.query(`INSERT INTO alert_channels (account_id, kind, target, label, verified_at) VALUES ($1, 'telegram', '777', '@me', now())`, [acct.id]);
  const ext = (await call('POST', '/v1/extension/tokens', { label: 'Chrome' })).body.token;

  await t.test('a pre-sign check keeps only the kind of request and the chain; free-use limits key on a hashed IP', async () => {
    const msg = ethers.hexlify(ethers.toUtf8Bytes('hello'));
    const r = await call('POST', '/v1/presign/check', { chain_id: 8453, from: acct.wallet, origin: 'https://secret-site.example', method: 'personal_sign', params: [msg, acct.wallet] }, ext);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const { rows } = await db.query(`SELECT input FROM runs WHERE product = 'presign_check'`);
    assert.deepEqual(rows[0].input, { method: 'personal_sign', chain_id: 8453 });
    await call('POST', '/v1/approvals/preview', { wallet: 'bad' }, null); // validated first: no counter
    const { rows: subjects } = await db.query('SELECT subject FROM free_usage');
    assert.ok(subjects.length, 'a point-paid run counted against the IP cap');
    assert.ok(subjects.every(s => !/127\.0\.0\.1|::1|ip:/.test(s.subject)), `no raw IP stored: ${subjects.map(s => s.subject)}`);
    assert.ok(subjects.some(s => /^iph:[A-Za-z0-9_-]{22}$/.test(s.subject)));
  });

  await t.test('download: everything about the account in one file; not with an extension token', async () => {
    const r = await call('GET', '/v1/me/export');
    assert.equal(r.status, 200);
    assert.equal(r.body.account.email, 'me@example.com');
    assert.equal(r.body.credit_ledger[0].delta_cents, 500);
    assert.equal(r.body.monitored_wallets[0].label, 'main');
    assert.equal(r.body.alert_channels[0].label, '@me');
    assert.equal(r.body.extension_links[0].label, 'Chrome');
    assert.ok(!JSON.stringify(r.body).includes(ext), 'the extension token itself is never exported');
    assert.equal((await call('GET', '/v1/me/export', null, ext)).status, 401);
  });

  await t.test('delete: personal data goes, payment records stay; it needs DELETE, a real sign-in, and no automatic trading running', async () => {
    assert.equal((await call('POST', '/v1/me/delete', { confirm: 'yes' })).status, 400);
    assert.equal((await call('POST', '/v1/me/delete', { confirm: 'DELETE' }, ext)).status, 401, 'an extension token can\'t');
    await db.query(`INSERT INTO trade_permissions (id, account_id, wallet, chain_id, wallet_type, router, delegate, delegation, delegation_hash, expires_at) VALUES (gen_random_uuid(), $1, $2, 84532, 'metamask', '0xr', '0xd', '{}', 'h1', now() + interval '1 day')`, [acct.id, acct.wallet]);
    const refused = await call('POST', '/v1/me/delete', { confirm: 'DELETE' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /Stop automatic trading first/);
    await db.query(`UPDATE trade_permissions SET status = 'revoked' WHERE account_id = $1`, [acct.id]);
    const r = await call('POST', '/v1/me/delete', { confirm: 'DELETE' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.removed.alert_channels, r.body.removed.monitored_wallets, r.body.removed.monitor_alerts, r.body.removed.extension_links, r.body.removed.email], [1, 1, 1, 1, 1]);
    const after = (await call('GET', '/v1/me/export')).body;
    assert.equal(after.account.email, null);
    assert.deepEqual([after.monitored_wallets, after.alert_channels, after.extension_links, after.monitor_alerts], [[], [], [], []]);
    assert.ok(after.credit_ledger.length && after.runs.length, 'payment records stay');
    assert.equal((await call('GET', '/v1/me', null, ext)).status, 401, 'the extension link is gone');
  });

  await t.test('retention: old rows go on the stated periods, recent ones stay', async () => {
    const q = (sql, p = []) => db.query(sql, p);
    await q(`INSERT INTO siwe_challenges (id, wallet, message, expires_at) VALUES (gen_random_uuid(), 'w', 'old', now() - interval '2 days'), (gen_random_uuid(), 'w', 'new', now() + interval '5 minutes')`);
    await q(`INSERT INTO free_usage (subject, product, day, count) VALUES ('iph:old', 'p', CURRENT_DATE - 41, 1), ('iph:new', 'p', CURRENT_DATE - 39, 1)`);
    await q(`INSERT INTO period_usage (subject, key, period, allowance) VALUES ('account:999', 'points', to_char(now() - interval '14 months', 'YYYY-MM'), 30), ('account:999', 'points', to_char(now() - interval '12 months', 'YYYY-MM'), 30)`);
    await q(`INSERT INTO monitor_alerts (account_id, wallet, kind, severity, title, dedupe_key, created_at) VALUES ($1, 'w', 'depeg', 'high', 'old', 'o', now() - interval '13 months'), ($1, 'w', 'depeg', 'high', 'new', 'n', now() - interval '11 months')`, [acct.id]);
    const done = await require('../src/privacy/retention').purge();
    assert.ok(Object.values(done).some(n => n > 0));
    assert.deepEqual((await q(`SELECT message FROM siwe_challenges WHERE wallet = 'w'`)).rows.map(r => r.message), ['new']);
    assert.deepEqual((await q(`SELECT subject FROM free_usage WHERE product = 'p'`)).rows.map(r => r.subject), ['iph:new']);
    assert.equal((await q(`SELECT count(*)::int AS n FROM period_usage WHERE subject = 'account:999'`)).rows[0].n, 1);
    assert.deepEqual((await q(`SELECT title FROM monitor_alerts WHERE wallet = 'w'`)).rows.map(r => r.title), ['new']);
  });
});
