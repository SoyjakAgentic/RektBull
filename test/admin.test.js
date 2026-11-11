/**
 * The admin panel against a real Postgres: only admin wallets, a fresh
 * sign-in for every change, a reason and a log row for each; prices (with
 * their limits) reaching the catalog, the pages and the 402 answer; an agent
 * hidden (unlisted, still working by its link) and switched off (refused
 * before any charge, its users told once); and the emergency stops refusing
 * automatic trades. Runs only when TEST_DATABASE_URL is set.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
const ADMIN = '0x' + 'ad'.repeat(20);
const USER = '0x' + 'ab'.repeat(20);

test('admin panel: prices, agents and emergency stops', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test-secret', PUBLIC_URL: 'https://rektbull.test', NEW_WALLET_CHECK_CHAINS: '', ADMIN_WALLETS: ADMIN, TRADING_ENABLED: 'true' });
  for (const k of Object.keys(require.cache)) if (k.includes('/src/')) delete require.cache[k];
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());

  const jwt = require('jsonwebtoken');
  const { issueToken } = require('../src/auth/siwe');
  const settings = require('../src/admin/settings');
  settings.reset();
  const server = require('../src/app').createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const { rows: [admin] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [ADMIN]);
  const { rows: [user] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [USER]);
  const stale = jwt.sign({ sub: String(admin.id), wallet: admin.wallet, iat: Math.floor(Date.now() / 1000) - 20 * 60 }, 'test-secret', { expiresIn: '30d' });
  const call = async (method, p, body, token = issueToken(admin)) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* a page */ }
    return { status: r.status, body: json, text };
  };
  const page = async p => (await fetch(base + p)).text();

  /* ── who may use it ── */
  assert.equal((await call('GET', '/v1/admin/overview', null, null)).status, 401);
  assert.equal((await call('GET', '/v1/admin/overview', null, issueToken(user))).status, 403, 'not an admin wallet');
  assert.equal((await call('PUT', '/v1/admin/prices/contract_audit', { price_cents: 4900, reason: 'launch offer' }, issueToken(user))).status, 403);
  const old = await call('PUT', '/v1/admin/prices/contract_audit', { price_cents: 4900, reason: 'launch offer' }, stale);
  assert.equal(old.status, 401);
  assert.equal(old.body.error, 'sign_in_again', 'a change needs a sign-in from the last 15 minutes');
  const ov = await call('GET', '/v1/admin/overview', null, stale);
  assert.equal(ov.status, 200, 'reading is fine with an older sign-in');
  assert.deepEqual(ov.body.stops.map(s => [s.id, s.on]), [['auto_trading', false], ['auto_yield', false]]);
  assert.equal(ov.body.prices.products.find(p => p.id === 'yield_move').editable.length, 0, 'the yield fee is fixed');
  assert.equal(ov.body.agents.length, 12);
  assert.match(await page('/admin'), /<meta name="robots" content="noindex">/);

  /* ── prices: checked, logged, and everywhere at once ── */
  assert.equal((await call('PUT', '/v1/admin/prices/contract_audit', { price_cents: 4900 })).status, 400, 'a reason is required');
  assert.match((await call('PUT', '/v1/admin/prices/contract_audit', { price_cents: 0, reason: 'oops' })).body.message, /from \$0\.01 to \$1,000/);
  assert.match((await call('PUT', '/v1/admin/prices/contract_audit', { points: 3, reason: 'try' })).body.message, /only price_cents/);
  assert.match((await call('PUT', '/v1/admin/prices/yield_move', { fee_bps: 5, reason: 'try' })).body.message, /audited Yield Router/);
  assert.match((await call('PUT', '/v1/admin/prices/airdrop_claim', { fee_bps: 400, pro_fee_bps: 500, reason: 'try' })).body.message, /Safety Pro fee can't be more/);

  const set = await call('PUT', '/v1/admin/prices/contract_audit', { price_cents: 4900, reason: 'launch offer' });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.product.current, { price_cents: 4900 });
  assert.equal((await call('GET', '/v1/catalog', null, null)).body.products.find(p => p.id === 'contract_audit').price_cents, 4900);
  assert.match(await page('/agents/contract-audit'), /\$49 an audit/);
  assert.match(await page('/agents/contract-audit'), /"price":"49"/, 'the structured data offer too');
  assert.match(await page('/llms.txt'), /contract audit \$49\)/);
  const unpaid = await call('POST', '/v1/contracts/audit', { chain: 'base', address: '0x' + '12'.repeat(20) }, null);
  assert.equal(unpaid.status, 402);
  assert.equal(unpaid.body.message, 'Contract audit costs $49.00.', 'the paid route reads the price on each request');

  await call('PUT', '/v1/admin/prices/pro_30d', { price_cents: 1200, reason: 'new price' });
  assert.match(await page('/agents/wallet-guardian'), /Safety Pro: \$12 for 30 days or \$79 for a year/);
  assert.match((await call('PUT', '/v1/admin/ai-allowance', { cents_per_30_days: 1300, reason: 'more AI' })).body.message, /from \$0 to \$12/, 'never more than the pass costs');
  assert.equal((await call('PUT', '/v1/admin/ai-allowance', { cents_per_30_days: 300, reason: 'more AI' })).status, 200);
  assert.equal(require('../src/payments/catalog').SAFETY_PRO.ai_allowance.cents_per_30_days, 300);
  assert.equal((await call('PUT', '/v1/admin/free-points', { per_month: 40, reason: 'launch' })).status, 200);
  assert.equal((await call('GET', '/v1/catalog', null, null)).body.free_points.per_month, 40);
  assert.match(await page('/safety'), /for 40 free points a month/);
  assert.match((await call('PUT', '/v1/admin/free-points', { new_wallet: 50, reason: 'more for new' })).body.message, /new wallet can't get more/);

  const back = await call('DELETE', '/v1/admin/prices/contract_audit', { reason: 'offer over' });
  assert.deepEqual(back.body.product.current, { price_cents: 9900 });
  const { body: { log } } = await call('GET', '/v1/admin/log?key=price', null);
  assert.deepEqual(log.map(l => [l.action, l.key, l.before, l.after, l.reason, l.wallet]).slice(0, 3), [
    ['price_default', 'price:contract_audit', { price_cents: 4900 }, null, 'offer over', ADMIN],
    ['price', 'price:pro_30d', null, { price_cents: 1200 }, 'new price', ADMIN],
    ['price', 'price:contract_audit', null, { price_cents: 4900 }, 'launch offer', ADMIN],
  ]);

  /* ── an agent hidden: unlisted, still working by its link ── */
  assert.equal((await call('PUT', '/v1/admin/agents/token_watch', { state: 'hidden', reason: 'rework' })).status, 200);
  assert.ok(!(await call('GET', '/v1/my-agents/catalog', null, null)).body.agents.some(a => a.id === 'token_watch'));
  const tw = await page('/agents/token-watch');
  assert.match(tw, /<meta name="robots" content="noindex">/);
  assert.ok(!(await page('/agents')).includes('href="/agents/token-watch"'), 'not linked from the agents page');
  assert.ok(!(await page('/sitemap.xml')).includes('/agents/token-watch'), 'not in the sitemap');
  await db.query(`INSERT INTO agent_settings (account_id, agent, enabled, settings) VALUES ($1, 'token_watch', true, '{"tokens":[{"chain":"base","token":"0x${'cd'.repeat(20)}"}]}')`, [user.id]);
  const mine = await call('GET', '/v1/my-agents', null, issueToken(user));
  assert.ok(mine.body.agents.some(a => a.id === 'token_watch'), 'still shown to an account that uses it');

  /* ── an agent switched off: refused before any charge, its users told once ── */
  await db.query(`INSERT INTO alert_channels (account_id, kind, target, label, verified_at, min_severity) VALUES ($1, 'telegram', '777', '@me', now(), 'low')`, [user.id]);
  const off = await call('PUT', '/v1/admin/agents/token_watch', { state: 'off', reason: 'source down' });
  assert.equal(off.body.told, 1);
  const { rows: alerts } = await db.query(`SELECT kind, title FROM monitor_alerts WHERE account_id = $1`, [user.id]);
  assert.deepEqual(alerts, [{ kind: 'agent_paused', title: 'Token Watch is paused for now' }]);
  const mine2 = await call('GET', '/v1/my-agents', null, issueToken(user));
  assert.equal(mine2.body.agents.find(a => a.id === 'token_watch').status.state, 'paused');
  assert.equal((await call('PATCH', '/v1/my-agents/token_watch', { enabled: true }, issueToken(user))).status, 503);
  assert.equal(await require('../src/services/myAgents').isOn(user.id, 'token_watch'), false);
  assert.match(await page('/agents/token-watch'), /Paused for now/);

  await call('PUT', '/v1/admin/agents/contract_audit', { state: 'off', reason: 'analyzer upgrade' });
  await require('../src/payments/credits').add(user.id, 20000, 'adjustment', 'test:topup');
  const before = await require('../src/payments/credits').balance(user.id);
  const refused = await call('POST', '/v1/contracts/audit', { chain: 'base', address: '0x' + '12'.repeat(20) }, issueToken(user));
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error, 'agent_paused');
  assert.equal(await require('../src/payments/credits').balance(user.id), before, 'nothing charged');
  assert.ok(!(await page('/safety')).includes('id="audit-card"'), 'the Safety page stops offering it');
  assert.ok(!(await page('/agents')).includes('On request:'));
  await call('PUT', '/v1/admin/agents/contract_audit', { state: 'active', reason: 'back' });
  assert.ok((await page('/safety')).includes('id="audit-card"'));
  assert.equal((await call('PUT', '/v1/admin/agents/nope', { state: 'off', reason: 'no such' })).status, 404);

  /* ── emergency stops ── */
  const stop = await call('PUT', '/v1/admin/stops/auto_trading', { on: true, reason: 'incident' });
  assert.deepEqual(stop.body, { id: 'auto_trading', on: true });
  const autonomous = require('../src/trade/autonomous');
  await assert.rejects(autonomous.queue({ id: user.id, wallet: USER }, { chain_id: 84532, side: 'buy', token: 'tWETH', amount_usd: 10 }), /paused by RektBull/);
  assert.equal(await require('../src/admin/stops').isStopped('auto_trading'), true);
  assert.equal((await call('PUT', '/v1/admin/stops/auto_trading', { on: false, reason: 'resolved' })).status, 200);
  assert.equal(await require('../src/admin/stops').isStopped('auto_trading'), false);
  const { rows: stopLog } = await db.query(`SELECT action, reason FROM admin_log WHERE key = 'stop:auto_trading' ORDER BY id`);
  assert.deepEqual(stopLog, [{ action: 'stop_on', reason: 'incident' }, { action: 'stop_off', reason: 'resolved' }]);
});
