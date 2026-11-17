/**
 * RektBull Points (rewards/points.js): the rebate, once per fee, the
 * 1,000,000,000 cap, buying a subscription with points, and the places that
 * credit them (a confirmed swap, Polymarket's builder-trades feed). Needs
 * TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, { JWT_SECRET: 'test-secret', NEW_WALLET_CHECK_CHAINS: '', DATABASE_URL: DB || '' });

test('the rebate in points: 25% of the fee at $0.10 a point', () => {
  const points = require('../src/rewards/points');
  assert.equal(points.pointsFor(10), 25, '$10 of fees: $2.50 back, 25 points');
  assert.equal(points.pointsFor(0.004), 0.01);
  assert.equal(points.pointsFor(0), 0);
  assert.equal(points.CAP, 1_000_000_000);
  assert.match(points.config().token_note, /convertible 1:1 for a RektBull utility token at its token generation event/);
  assert.deepEqual(points.checkSettings({ point_usd: '0.2', rebate_bps: 3000 }), { point_usd: 0.2, rebate_bps: 3000 });
  assert.throws(() => points.checkSettings({ rebate_bps: 20000 }), /rebate_bps/);
});

test('earning, the cap, spending, and the trades that credit points', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());
  require('../src/admin/settings').reset();
  const points = require('../src/rewards/points');
  const newAccount = async () => (await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', ['0x' + crypto.randomBytes(20).toString('hex')])).rows[0];
  const a = await newAccount();

  await t.test('a fee is rebated once', async () => {
    const r = await points.credit({ accountId: a.id, source: 'swap', ref: 'trade-1', feeUsd: 10 });
    assert.equal(Number(r.points), 25);
    assert.equal(await points.credit({ accountId: a.id, source: 'swap', ref: 'trade-1', feeUsd: 10 }), null, 'the same fee again: nothing');
    assert.equal(await points.balance(a.id), 25);
    assert.equal(await points.credit({ accountId: a.id, source: 'not-a-source', ref: 'x', feeUsd: 10 }), null);
  });

  await t.test('buying a subscription with points', async () => {
    const pro = points.passPrices().find(p => p.id === 'pro_30d');
    assert.equal(pro.points, Math.ceil(pro.price_usd / 0.1));
    await assert.rejects(points.buyPass(a.id, 'pro_30d'), e => e instanceof points.NotEnoughPoints && /you have 25/.test(e.message));
    await points.credit({ accountId: a.id, source: 'perps', ref: 'fill-1', feeUsd: 40 }); // +100
    const out = await points.buyPass(a.id, 'pro_30d');
    assert.equal(out.points_spent, pro.points);
    assert.equal(out.pass.product, 'pro_30d');
    assert.equal(await points.balance(a.id), 125 - pro.points);
    await assert.rejects(points.buyPass(a.id, 'token_quick_check'), /not a subscription/);
  });

  await t.test('the confirmed swap a user signed (Solana here; EVM the same) earns the rebate of the fee its plan showed', async () => {
    const id = crypto.randomUUID();
    const before = await points.balance(a.id);
    await require('../src/trade/positions').settleSolana({ id, account_id: a.id, wallet: 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB', chain: 'solana', side: 'buy', token: 'So11111111111111111111111111111111111111112', amount_usd: 200, plan: { summary: { fee: { usd: 2 } } } }, { failed: false, amount: 5n });
    assert.equal(await points.balance(a.id), before + 5, '$2 fee: 5 points');
  });

  await t.test('Polymarket fills with RektBull\'s builder code, matched by the order RektBull prepared', async () => {
    const env = require('../src/config/env');
    const code = '0x' + 'bb'.repeat(32);
    Object.assign(env, { polymarketBuilderCode: code, polymarketTakerFeeBps: 1, polymarketMakerFeeBps: 1 });
    const hash = '0x' + 'cd'.repeat(32);
    await db.query(`INSERT INTO polymarket_orders (id, account_id, wallet, signer, wallet_type, asset_id, side, order_type, price, shares, notional_usd, builder, order_hash, prepared)
      VALUES ($1, $2, $3, $3, 'deposit', '1', 'BUY', 'FAK', 0.5, 2000, 1000, $4, $5, '{}')`, [crypto.randomUUID(), a.id, '0x' + '22'.repeat(20), code, hash]);
    const pm = require('../src/providers/polymarket');
    const trade = (id, extra = {}) => ({ id, tradeType: 'TAKER', takerOrderHash: hash, builder: code, maker: '0x' + '22'.repeat(20), sizeUsdc: '1000000000', status: 'TRADE_STATUS_CONFIRMED', ...extra });
    const pages = { '': { data: [trade('t1'), trade('t2', { status: 'TRADE_STATUS_MATCHED' })], next_cursor: 'MQ==' }, 'MQ==': { data: [trade('t3', { builder: '0x' + 'ee'.repeat(32) })], next_cursor: 'LTE=' } };
    const asked = [];
    pm.http.get = async (url, opts) => { asked.push(opts.params); return { data: pages[opts.params.next_cursor || ''] }; };
    require('../src/lib/cache')._memory.clear();
    const before = await points.balance(a.id);
    const out = await require('../src/polymarket/fills').tick();
    assert.equal(out.credited, 1, 'only the confirmed fill with RektBull\'s code');
    assert.equal(await points.balance(a.id), before + 0.25, '$1,000 at 0.01%: $0.10 fee, 0.25 points');
    assert.equal(asked[0].builder_code, code);
    require('../src/lib/cache')._memory.clear();
    assert.equal((await require('../src/polymarket/fills').tick()).credited, 0, 'read again: not credited twice');
  });

  await t.test('at most 1,000,000,000 points are ever issued', async () => {
    const b = await newAccount();
    const { rows: [{ issued }] } = await db.query('SELECT COALESCE(SUM(points), 0) AS issued FROM reward_points WHERE points > 0');
    await db.query(`INSERT INTO reward_points (account_id, points, kind, source, ref) VALUES ($1, $2, 'rebate', 'swap', 'filler')`, [b.id, points.CAP - Number(issued) - 10]);
    const last = await points.credit({ accountId: b.id, source: 'swap', ref: 'near-cap', feeUsd: 10 }); // wants 25, 10 left
    assert.equal(Number(last.points), 10);
    assert.match(last.note, /last 10 of the 1,000,000,000/);
    assert.equal(await points.credit({ accountId: b.id, source: 'swap', ref: 'after-cap', feeUsd: 10 }), null, 'none left: rebates stop');
    assert.deepEqual(await points.supply(), { cap: points.CAP, issued: points.CAP, remaining: 0 });
    assert.ok(await points.balance(a.id) > 0, 'points already earned stay');
  });

  await t.test('the API: balance, history and buying with points', async () => {
    const server = require('../src/app').createApp().listen(0);
    t.after(() => server.close());
    const token = require('../src/auth/siwe').issueToken(a);
    const call = async (method, p) => {
      const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      return { status: r.status, body: await r.json() };
    };
    const p = await call('GET', '/v1/points');
    assert.equal(p.status, 200);
    assert.ok(p.body.history.some(h => h.source === 'Polymarket trading fee'));
    assert.match(p.body.how, /25% of the trading fees/);
    assert.equal((await call('POST', '/v1/points/passes/pro_30d')).status, 402, 'not enough points left');
    const info = await (await fetch(`http://127.0.0.1:${server.address().port}/v1/points/info`)).json();
    assert.equal(info.cap, 1_000_000_000);
  });
});
