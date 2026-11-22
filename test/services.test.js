/**
 * Service switches (admin/services.js) and free runs (payments/gate.js), on a
 * real Postgres: every service can be paused from the admin panel, logged with
 * a reason; a paused paid run is refused before any charge; a paused desk stops
 * new work while every way out stays open; a hidden one is also taken off the
 * menus, pages, sitemap and llms.txt, its desk page still opening by its link
 * (noindex, with a notice); the token report is free, paused and hidden by
 * default; a free run needs a sign-in and has daily caps, given back when it
 * fails. Runs only when TEST_DATABASE_URL is set.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
const ADMIN = '0x' + 'ad'.repeat(20);
const USER = '0x' + 'ab'.repeat(20);

test('service switches and free runs', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test-secret', PUBLIC_URL: 'https://rektbull.test', NEW_WALLET_CHECK_CHAINS: '', ADMIN_WALLETS: ADMIN, TRADING_ENABLED: 'true' });
  for (const k of Object.keys(require.cache)) if (k.includes('/src/')) delete require.cache[k];
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());
  const settings = require('../src/admin/settings');
  settings.reset();
  const services = require('../src/admin/services');
  const { issueToken } = require('../src/auth/siwe');
  // No country header in tests: clear the venues' region lists so the region check isn't what refuses.
  const regions = require('../src/compliance/regions');
  for (const v of ['polymarket', 'hyperliquid']) await regions.set(v, [], { wallet: ADMIN, reason: 'tests run from no country' });

  // The real app; and a test route behind the real payment gate, on its own app.
  const express = require('express');
  require('express-async-errors'); // as the app does: a failed run answers 500
  const { paidRoute, FREE_RUNS } = require('../src/payments/gate');
  const { optionalAuth } = require('../src/middleware/auth');
  const testApp = express();
  testApp.use(express.json());
  testApp.use(optionalAuth);
  let fail = false;
  testApp.post('/test/report', paidRoute('token_report', { validate: () => ({ ok: true }), run: async () => { if (fail) throw new Error('provider down'); return { done: true }; } }));
  testApp.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = require('../src/app').createApp().listen(0);
  const testServer = testApp.listen(0);
  t.after(() => { server.close(); testServer.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const testBase = `http://127.0.0.1:${testServer.address().port}`;

  const { rows: [admin] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [ADMIN]);
  const { rows: [user] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [USER]);
  const call = async (method, p, body, token = issueToken(user)) => {
    const r = await fetch((p.startsWith('/test/') ? testBase : base) + p, { method, signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* a page */ }
    return { status: r.status, body: json };
  };
  const asAdmin = (method, p, body) => call(method, p, body, issueToken(admin));
  const paused = r => r.status === 503 && r.body?.error === 'service_paused';

  await t.test('the admin panel lists every service; the token report is paused and hidden by default; changes need a reason and are logged', async () => {
    const ov = await asAdmin('GET', '/v1/admin/overview');
    const byId = Object.fromEntries(ov.body.services.map(s => [s.id, s]));
    assert.deepEqual([byId.token_report.state, byId.token_report.paused, byId.token_report.hidden, byId.token_report.default_state], ['hidden', true, true, 'hidden']);
    for (const id of ['token_quick_check', 'launch_check', 'presign_check', 'governance_summary', 'approval_cleanup', 'trade', 'perps', 'predictions', 'yield', 'claims', 'governance_votes', 'checkup']) assert.equal(byId[id].paused, false, id);
    assert.match(byId.trade.open, /Sells, cancels and revokes/);
    assert.equal((await call('PUT', '/v1/admin/services/trade', { paused: true, reason: 'not an admin' })).status, 403);
    assert.equal((await asAdmin('PUT', '/v1/admin/services/trade', { paused: true })).status, 400, 'a reason is required');
    assert.equal((await asAdmin('PUT', '/v1/admin/services/nope', { paused: true, reason: 'no such' })).status, 404);
    assert.equal((await asAdmin('PUT', '/v1/admin/services/trade', { paused: 'yes', reason: 'bad value' })).status, 400);
    assert.equal((await asAdmin('PUT', '/v1/admin/services/trade', { state: 'gone', reason: 'bad value' })).status, 400);
  });

  await t.test('a paused paid run is refused before any charge; the report is free once resumed', async () => {
    const r = await call('POST', '/test/report', {});
    assert.ok(paused(r));
    assert.match(r.body.message, /Token due diligence report is paused by RektBull for now\. Nothing was charged/);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM runs')).rows[0].n, 0, 'no run, no charge');
    assert.equal((await asAdmin('PUT', '/v1/admin/services/token_report', { paused: false, reason: 'try it free' })).status, 200);
    // Free: signed in only.
    const anon = await call('POST', '/test/report', {}, null);
    assert.equal(anon.status, 401);
    assert.equal(anon.body.error, 'sign_in_required');
    const ok = await call('POST', '/test/report', {});
    assert.equal(ok.status, 200);
    assert.equal(ok.body.run.paid_with, 'free');
    const { rows: [run] } = await db.query('SELECT payment_method, price_cents, status FROM runs');
    assert.deepEqual(run, { payment_method: 'free', price_cents: 0, status: 'succeeded' });
  });

  await t.test('free runs: capped a day per account; a failed run gives its use back', async () => {
    fail = true;
    assert.equal((await call('POST', '/test/report', {})).status, 500);
    fail = false;
    for (let i = 1; i < FREE_RUNS.per_account_per_day; i++) assert.equal((await call('POST', '/test/report', {})).status, 200, `run ${i + 1}`);
    const over = await call('POST', '/test/report', {});
    assert.equal(over.status, 429, 'the failed one was given back, so exactly the cap succeeded');
    assert.match(over.body.message, /up to 10 a day per account/);
  });

  await t.test('pausing is logged; back to the default stores nothing', async () => {
    await asAdmin('PUT', '/v1/admin/services/token_report', { state: 'paused', reason: 'shown, but paused' });
    await asAdmin('PUT', '/v1/admin/services/token_report', { state: 'hidden', reason: 'hold off again' });
    const { rows } = await db.query(`SELECT action, reason, after FROM admin_log WHERE key = 'service:token_report' ORDER BY id`);
    assert.deepEqual(rows.map(r => [r.action, r.reason]), [['service_on', 'try it free'], ['service_paused', 'shown, but paused'], ['service_hidden', 'hold off again']]);
    assert.equal(rows[2].after, null, 'hidden is its default: nothing stored');
    await settings.fresh();
    const c = require('../src/payments/catalog').publicCatalog().find(p => p.id === 'token_report');
    assert.deepEqual([c.paused, c.hidden], [true, true], 'the catalog says so, for the pages');
  });

  await t.test('desks: new work stops, every way out stays open', async () => {
    for (const id of ['trade', 'perps', 'predictions', 'yield', 'claims', 'governance_votes', 'checkup']) {
      assert.equal((await asAdmin('PUT', `/v1/admin/services/${id}`, { paused: true, reason: 'test' })).status, 200, id);
    }
    // Trade desk: buys refused; a sell gets past the switch (and is refused later for its own reasons, or not).
    assert.ok(paused(await call('POST', '/v1/trading/preview', { chain: 'base', side: 'buy', token: '0x' + '11'.repeat(20), amount_usd: 10 })));
    assert.ok(!paused(await call('POST', '/v1/trading/preview', { chain: 'nowhere', side: 'sell' })), 'selling stays open');
    assert.ok(paused(await call('POST', '/v1/trading/permissions', {})));
    assert.ok(!paused(await call('POST', '/v1/trading/permissions/00000000-0000-0000-0000-000000000000/revoke', {})), 'revoking stays open');
    // Perps: opening refused; closing gets through.
    assert.ok(paused(await call('POST', '/v1/hyperliquid/auto/intents', { side: 'long', coin: 'BTC', size_usd: 50 })));
    assert.ok(!paused(await call('POST', '/v1/hyperliquid/auto/intents', { side: 'close' })), 'closing stays open');
    assert.ok(paused(await call('POST', '/v1/hyperliquid/auto/grant', {})));
    assert.ok(!paused(await call('POST', '/v1/hyperliquid/auto/revoke', {})), 'revoking stays open');
    // Predictions: buying refused; selling, redeeming and withdrawing get through.
    assert.ok(paused(await call('POST', '/v1/polymarket/orders', { side: 'BUY', asset_id: '1' })));
    assert.ok(!paused(await call('POST', '/v1/polymarket/orders', { side: 'SELL', asset_id: 'x' })), 'selling stays open');
    assert.ok(paused(await call('POST', '/v1/polymarket/wallet/transactions', { kind: 'approvals' })));
    assert.ok(!paused(await call('POST', '/v1/polymarket/wallet/transactions', { kind: 'redeem' })), 'redeeming stays open');
    assert.ok(!paused(await call('POST', '/v1/polymarket/wallet/transactions', { kind: 'withdraw' })), 'withdrawing stays open');
    assert.ok(paused(await call('POST', '/v1/polymarket/auto/start', { accept: true })));
    assert.ok(!paused(await call('POST', '/v1/polymarket/auto/stop', {})), 'stopping automatic trading stays open');
    // Yield: a move or deposit refused; a withdrawal to the wallet gets through.
    const w = { wallet: USER, chain: 'base', asset: 'USDC', amount_usd: 10 };
    assert.ok(paused(await call('POST', '/v1/yield/moves/prepare', { ...w, to: 'aave' })));
    assert.ok(!paused(await call('POST', '/v1/yield/moves/prepare', { ...w, chain: 'nowhere', from: 'aave' })), 'withdrawing stays open');
    assert.ok(paused(await call('POST', '/v1/yield/auto/permissions', {})));
    // Claims, votes, the checkup.
    assert.ok(paused(await call('POST', '/v1/claims/check', { wallet: USER })));
    assert.ok(paused(await call('POST', '/v1/governance/votes/prepare', {})));
    assert.ok(paused(await call('POST', '/v1/checkup', { wallet: USER })));
    const r = await call('POST', '/v1/trading/preview', { chain: 'base', side: 'buy' });
    assert.match(r.body.message, /Trade desk .* is paused by RektBull for now\. Nothing was charged\. Still open: Sells, cancels and revokes\./);
    // Back on.
    await asAdmin('PUT', '/v1/admin/services/trade', { state: 'on', reason: 'done' });
    assert.ok(!paused(await call('POST', '/v1/trading/preview', { chain: 'nowhere', side: 'buy' })));
    assert.equal(await services.isPaused('trade'), false);
  });

  await t.test('hidden: off the menus, tiles, sitemap and llms.txt; the desk page still opens, noindex, with a notice', async () => {
    const page = async p => (await fetch(base + p, { signal: AbortSignal.timeout(15000) })).text();
    const shown = (html, id) => !new RegExp(`<(div|span) hidden data-service-hidden="${id}">`).test(html);
    await settings.fresh();
    // Paused but not hidden: still shown everywhere.
    let home = await page('/');
    assert.ok(shown(home, 'trade'), 'paused alone: the Trade tile and menu link stay');
    assert.match(await page('/sitemap.xml'), /\/trade</);
    // Hidden.
    assert.equal((await asAdmin('PUT', '/v1/admin/services/trade', { state: 'hidden', reason: 'hide the desk' })).status, 200);
    await settings.fresh();
    home = await page('/');
    assert.ok(!shown(home, 'trade'), 'the Trade tile and menu link are hidden');
    assert.match(home, /<span hidden data-service-hidden="trade"><a href="\/trade">Trade<\/a><\/span>/, 'the menu link');
    assert.doesNotMatch(await page('/sitemap.xml'), /\/trade</);
    assert.doesNotMatch(await page('/llms.txt'), /\]\([^)]*\/trade\)/);
    const desk = await page('/trade');
    assert.match(desk, /<meta name="robots" content="noindex">/);
    assert.doesNotMatch(desk, /<link rel="canonical"/);
    assert.match(desk, /data-service-notice="trade">Trade desk is paused for now\. Still open here: Sells, cancels and revokes\./);
    assert.ok(!shown(await page('/perps'), 'trade'), 'the Perps page\'s link back to Trade is hidden too');
    // A hidden check: its button on the Safety page; the token report is hidden by default.
    const safety = await page('/safety');
    assert.match(safety, /<span hidden data-service-hidden="token_report"><button id="report"/);
    assert.ok(shown(safety, 'token_quick_check'));
    // Back on: everything back.
    await asAdmin('PUT', '/v1/admin/services/trade', { state: 'on', reason: 'back' });
    await settings.fresh();
    assert.ok(shown(await page('/'), 'trade'));
    assert.match(await page('/sitemap.xml'), /\/trade</);
    assert.match(await page('/trade'), /<link rel="canonical"/);
  });
});
