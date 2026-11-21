/**
 * Automatic Polymarket trading through RektBull's Session Key (polymarket/auto.js):
 * the disclosures, turning it on and off, the limits RektBull keeps, the region
 * check before each order, the order RektBull's key signs, and the fee charged
 * to AI credits only on a fill. Polymarket is a stand-in; keys are made at run
 * time. The database parts need TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ethers } = require('ethers');

const sessionKey = ethers.Wallet.createRandom();
const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, {
  JWT_SECRET: 'test-secret', NEW_WALLET_CHECK_CHAINS: '', DATABASE_URL: DB || '',
  POLYMARKET_ENABLED: 'true', POLYMARKET_AUTO_ENABLED: 'true', POLYMARKET_SESSION_ADDRESS: sessionKey.address,
  POLYMARKET_BUILDER_CODE: '0x' + 'aa'.repeat(32), POLYMARKET_AI_BUILDER_CODE: '0x' + 'bb'.repeat(32),
  POLYMARKET_BUILDER_API_KEY: 'k', POLYMARKET_BUILDER_API_SECRET: 'c2VjcmV0', POLYMARKET_BUILDER_API_PASSPHRASE: 'p',
});
const fx = name => JSON.parse(require('fs').readFileSync(path.join(__dirname, 'fixtures', 'polymarket', name), 'utf8'));

const auto = require('../src/polymarket/auto');
const settings = require('../src/admin/settings');

test('the disclosures name the duration, who keeps the limits, what it does, the fee and the most you can lose', () => {
  const d = auto.disclosures();
  assert.match(d.duration, /fixed term of 180 days/);
  assert.match(d.duration, /earlier date you choose/);
  assert.match(d.can_do, /doesn't let it withdraw/);
  assert.match(d.limits, /not onchain/);
  assert.match(d.what_it_does, /Only buys/); assert.match(d.what_it_does, /10 points/); assert.match(d.what_it_does, /at least \$25/); assert.match(d.what_it_does, /never sells/);
  assert.match(d.fee, /AI builder fee of 1% of what fills/); assert.match(d.fee, /automation fee of 1% of what fills, at least \$0\.25/);
  assert.match(d.fee, /Nothing is charged for an order that doesn't fill/);
  assert.match(d.most_you_can_lose, /Polymarket wallet/);
  assert.match(d.servers, /checks your country/);
});

test('the fee: 1% of what filled, never under $0.25', () => {
  assert.equal(auto.feeFor(10), 0.25);
  assert.equal(auto.feeFor(25), 0.25);
  assert.equal(auto.feeFor(100), 1);
  assert.equal(auto.feeFor(1234.56), 12.35);
});

test('the checks before each order: active, before the stop date, inside Polymarket\'s term, an allowed country', async () => {
  settings.reset();
  const later = new Date(Date.now() + 86400000).toISOString();
  const term = Math.floor(Date.now() / 1000) + 100 * 86400;
  const ok = { status: 'active', stop_at: later, valid_until: term, country: 'MX' };
  assert.equal(await auto.blockedReason(ok), null);
  assert.match(await auto.blockedReason({ ...ok, status: 'revoked' }), /isn't active/);
  assert.match(await auto.blockedReason({ ...ok, stop_at: new Date(Date.now() - 1000).toISOString() }), /stop date/);
  assert.match(await auto.blockedReason({ ...ok, valid_until: Math.floor(Date.now() / 1000) + 600 }), /nearly up/);
  assert.match(await auto.blockedReason({ ...ok, country: 'US' }), /isn't offered in US/);
  assert.match(await auto.blockedReason({ ...ok, country: null }), /country isn't known/);
  assert.match(await auto.blockedReason({ ...ok, country: 'CA-ON' }), /isn't offered in CA-ON/);
  assert.match(await auto.blockedReason({ ...ok, country: 'CA' }), /region isn't known/);
  assert.equal(await auto.blockedReason({ ...ok, country: 'CA-NS' }), null, 'another province of Canada is fine');
});

test('turning it on and off, and an automated entry', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());
  settings.reset();
  auto.setSignerForTests(sessionKey);

  // The user's wallet set-up is covered in polymarket.test.js; here the batch is a stand-in.
  const wallets = require('../src/polymarket/wallets');
  const prepared = [];
  const realPrepare = wallets.prepare;
  t.after(() => { wallets.prepare = realPrepare; });
  wallets.prepare = async (account, kind, input) => {
    prepared.push({ kind, input });
    const id = require('crypto').randomUUID();
    const detail = kind === 'session_authorize' ? { session_signer: input.session_signer.toLowerCase(), valid_until: Math.floor(Date.now() / 1000) + 4315 * 3600 } : { session_signer: input.session_signer };
    await db.query(`INSERT INTO polymarket_batches (id, account_id, signer, wallet, kind, nonce, deadline, calls, detail) VALUES ($1, $2, $3, $4, $5, '0', $6, '[]', $7)`,
      [id, account.id, account.wallet, WALLET.toLowerCase(), kind, Math.floor(Date.now() / 1000) + 600, JSON.stringify(detail)]);
    return { id, kind, wallet_type: 'deposit', wallet: WALLET, detail, typed_data: {}, steps: [] };
  };
  const WALLET = ethers.Wallet.createRandom().address;

  const { rows: [acct] } = await db.query(`INSERT INTO accounts (wallet) VALUES ('0x${'a1'.repeat(20)}') RETURNING *`);
  await db.query(`INSERT INTO passes (account_id, product, starts_at, ends_at) VALUES ($1, 'pro_30d', now(), now() + interval '30 days')`, [acct.id]);

  await t.test('it refuses without the user accepting, under the $25 minimum, or a stop date past Polymarket\'s term', async () => {
    await assert.rejects(auto.start(acct, { max_order_usd: 50, max_day_usd: 100, stop_days: 30 }, { country: 'MX' }), err => err.code === 'not_accepted');
    await assert.rejects(auto.start(acct, { accept: true, max_order_usd: 10, max_day_usd: 100, stop_days: 30 }, { country: 'MX' }), /\$25/);
    await assert.rejects(auto.start(acct, { accept: true, max_order_usd: 50, max_day_usd: 40, stop_days: 30 }, { country: 'MX' }), /at least max_order_usd/);
    await assert.rejects(auto.start(acct, { accept: true, max_order_usd: 50, max_day_usd: 100, stop_days: 180 }, { country: 'MX' }), /1 to 179/);
    assert.equal(prepared.length, 0, 'nothing prepared');
  });

  let sess;
  await t.test('turning it on prepares the authorization of RektBull\'s key; it is active once the relayer confirms it', async () => {
    const out = await auto.start(acct, { accept: true, max_order_usd: 50, max_day_usd: 80, stop_days: 30 }, { country: 'MX' });
    assert.equal(prepared[0].kind, 'session_authorize');
    assert.equal(prepared[0].input.session_signer, sessionKey.address.toLowerCase());
    assert.ok(out.disclosures.duration);
    ({ rows: [sess] } = await db.query('SELECT * FROM polymarket_sessions WHERE id = $1', [out.session_id]));
    assert.equal(sess.status, 'pending');
    assert.ok(Math.abs(new Date(sess.stop_at) - (Date.now() + 30 * 86400000)) < 60000, 'RektBull stops after the user\'s 30 days');
    await auto.batchSettled({ id: out.id, kind: 'session_authorize', status: 'confirmed' });
    ({ rows: [sess] } = await db.query('SELECT * FROM polymarket_sessions WHERE id = $1', [out.session_id]));
    assert.equal(sess.status, 'active');
    const o = await auto.overview(acct, 'MX');
    assert.equal(o.session.status, 'active');
    assert.equal(o.session.max_order_usd, 50);
  });

  // Stand-in Polymarket: the book and market, RektBull's key's CLOB credentials, and the order.
  const pm = require('../src/providers/polymarket');
  const desk = require('../src/polymarket/desk');
  const markets = require('../src/polymarket/markets');
  const book = { ...markets.presentBook(fx('book.json')), tick_size: '0.01', bids: [{ price: 0.5, size: 400 }], asks: [{ price: 0.52, size: 500 }, { price: 0.53, size: 500 }], best_bid: 0.5, best_ask: 0.52 };
  const realContext = desk.context;
  t.after(() => { desk.context = realContext; });
  desk.context = async () => ({ book, market: { platform_fee: null } });
  const sent = [];
  let matched = 50e6;
  pm.http.get = async url => (url.endsWith('/auth/derive-api-key') ? { status: 200, data: { apiKey: 'rk-key', secret: Buffer.from('s3cret').toString('base64'), passphrase: 'pp' } } : { status: 404, data: {} });
  pm.http.post = async (url, body, opts) => {
    sent.push({ url, body: JSON.parse(body), headers: opts.headers });
    return { status: 200, data: { success: true, orderID: `0xorder${sent.length}`, status: matched ? 'matched' : 'unmatched', makingAmount: String(matched) } };
  };
  const forecast = id => ({ id, market: 'alpha', question: 'Will alpha happen?' });
  const addForecast = async () => (await db.query(`INSERT INTO ai_forecasts (venue, stage, market, question, outcome, asset_id, ai_prob, market_prob, confidence, reasoning, sources, model, cost_usd)
    VALUES ('polymarket', 'research', 'alpha', 'Will alpha happen?', 'Yes', $1, 0.7, 0.52, 'high', 'r', '[]', 'm', 0.1) RETURNING id`, [book.asset_id])).rows[0].id;

  await t.test('automation off in the admin panel: nothing is placed', async () => {
    assert.equal(await auto.fromForecast(forecast(await addForecast()), { side: 'Yes', assetId: book.asset_id, priceLimit: 0.6 }), 0);
    assert.equal(sent.length, 0);
  });

  await settings.set('forecasts', { polymarket: true, polymarket_auto: true }, { wallet: '0xadmin', action: 'forecasts', reason: 'test' });

  await t.test('an entry: a fill-and-kill buy signed by RektBull\'s key for the Deposit Wallet, at most the per-order limit, fee on the fill', async () => {
    const fid = await addForecast();
    assert.equal(await auto.fromForecast(forecast(fid), { side: 'Yes', assetId: book.asset_id, priceLimit: 0.6 }), 1);
    const { body, headers } = sent[0];
    assert.equal(body.orderType, 'FAK');
    assert.equal(body.owner, 'rk-key', 'sent with RektBull\'s key\'s own CLOB API key');
    assert.equal(headers.POLY_ADDRESS, sessionKey.address);
    assert.equal(body.order.maker, WALLET); assert.equal(body.order.signer, WALLET);
    assert.equal(body.order.side, 'BUY'); assert.equal(body.order.signatureType, 3);
    assert.equal(body.order.builder, '0x' + 'bb'.repeat(32), 'carries RektBull\'s AI builder code');
    assert.ok(Number(body.order.makerAmount) <= 50e6, 'no more than the $50 per-order limit');
    assert.ok(body.order.signature.endsWith('6492649264926492649264926492649264926492649264926492649264926492'), 'in the session envelope');
    assert.ok(body.order.signature.toLowerCase().includes(sessionKey.address.slice(2).toLowerCase()), 'naming RektBull\'s key');
    const { rows: [o] } = await db.query('SELECT * FROM polymarket_auto_orders WHERE forecast_id = $1', [fid]);
    assert.equal(o.status, 'filled');
    assert.equal(Number(o.filled_usd), 50);
    assert.equal(Number(o.fee_usd), 0.5, '1% of $50');
    assert.equal(o.fee_paid_from, 'allowance');
  });

  await t.test('the same forecast is never traded twice for a user; the 24-hour limit cuts the next entry', async () => {
    const { rows: [{ id: fid }] } = await db.query('SELECT forecast_id AS id FROM polymarket_auto_orders LIMIT 1');
    assert.equal(await auto.fromForecast(forecast(fid), { side: 'Yes', assetId: book.asset_id, priceLimit: 0.6 }), 0);
    assert.equal(sent.length, 1);
    matched = 30e6;
    const f2 = await addForecast();
    assert.equal(await auto.fromForecast(forecast(f2), { side: 'Yes', assetId: book.asset_id, priceLimit: 0.6 }), 1);
    const { rows: [o] } = await db.query('SELECT * FROM polymarket_auto_orders WHERE forecast_id = $1', [f2]);
    assert.equal(Number(o.amount_usd), 30, '$80 a day less the $50 already filled');
    assert.equal(Number(o.fee_usd), 0.3);
    const f3 = await addForecast();
    assert.equal(await auto.fromForecast(forecast(f3), { side: 'Yes', assetId: book.asset_id, priceLimit: 0.6 }), 0, 'nothing left today');
    assert.equal(sent.length, 2);
  });

  await db.query(`UPDATE polymarket_auto_orders SET created_at = now() - interval '2 days'`);

  await t.test('past the forecast\'s price limit, nothing is sent; an order that doesn\'t fill costs nothing', async () => {
    const f = await addForecast();
    const r = await auto.place(sess, forecast(f), { side: 'Yes', assetId: book.asset_id, priceLimit: 0.5 });
    assert.equal(r.status, 'refused'); assert.match(r.error, /edge is gone/);
    assert.equal(sent.length, 2);
    matched = 0;
    const u = await auto.place(sess, forecast(await addForecast()), { side: 'Yes', assetId: book.asset_id, priceLimit: 0.6 });
    assert.equal(u.status, 'unfilled'); assert.equal(u.fee_usd, null);
    matched = 50e6;
  });

  await t.test('from a blocked country, or with no AI credits, nothing is placed', async () => {
    await auto.overview(acct, 'US');
    assert.equal(await auto.fromForecast(forecast(await addForecast()), { side: 'Yes', assetId: book.asset_id, priceLimit: 0.6 }), 0);
    await auto.overview(acct, 'MX');
    await db.query(`UPDATE passes SET ends_at = now() - interval '1 minute' WHERE account_id = $1`, [acct.id]);
    assert.equal(await auto.fromForecast(forecast(await addForecast()), { side: 'Yes', assetId: book.asset_id, priceLimit: 0.6 }), 0);
    await db.query(`UPDATE passes SET ends_at = now() + interval '30 days' WHERE account_id = $1`, [acct.id]);
    assert.equal(sent.length, 3, 'only the unfilled one above was sent');
  });

  await t.test('stopping ends it at once and prepares the revocation for the user\'s key', async () => {
    const out = await auto.stop(acct);
    assert.equal(out.stopped, true);
    assert.equal(prepared.at(-1).kind, 'session_revoke');
    const { rows: [s] } = await db.query('SELECT status FROM polymarket_sessions WHERE id = $1', [sess.id]);
    assert.equal(s.status, 'revoked');
    const { rows: [fresh] } = await db.query('SELECT * FROM polymarket_sessions WHERE id = $1', [sess.id]);
    assert.equal(await auto.fromForecast(forecast(await addForecast()), { side: 'Yes', assetId: book.asset_id, priceLimit: 0.6 }), 0);
    assert.equal(await auto.place(fresh, forecast(await addForecast()), { side: 'Yes', assetId: book.asset_id, priceLimit: 0.6 }), null);
    assert.equal(sent.length, 3);
  });

  await t.test('the worker ends keys past the user\'s stop date', async () => {
    await db.query(`UPDATE polymarket_sessions SET status = 'revoked'`);
    const out = await auto.start(acct, { accept: true, max_order_usd: 50, max_day_usd: 80, stop_days: 1 }, { country: 'MX' });
    await auto.batchSettled({ id: out.id, kind: 'session_authorize', status: 'confirmed' });
    await db.query(`UPDATE polymarket_sessions SET stop_at = now() - interval '1 minute' WHERE id = $1`, [out.session_id]);
    await auto.tick();
    const { rows: [s] } = await db.query('SELECT status FROM polymarket_sessions WHERE id = $1', [out.session_id]);
    assert.equal(s.status, 'ended');
  });
});
