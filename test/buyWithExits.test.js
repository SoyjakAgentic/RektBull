/**
 * Exits with a Solana buy (trade/solana.js, solanaOrders.exitsForBuy): a
 * stop-loss and/or a take-profit placed in the same transaction as the buy,
 * on a real Jupiter route recorded from mainnet (test/fixtures/jupiter), so
 * the transaction's size is the real one. The largest set that fits is used;
 * what's left out is said; the orders are recorded only when the trade is made.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const k = require('@solana/kit');

const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, { DATABASE_URL: DB || '', JWT_SECRET: 'test-secret', TRADING_ENABLED: 'true' });
const env = require('../src/config/env');
const solana = require('../src/trade/solana');
const op = require('../src/trade/solanaOrderProgram');
const jupiter = require('../src/providers/jupiter');
const rpc = require('../src/providers/rpc');

const PROGRAM = 'CYiK4necGUc4CZZmGM9CALRAurATaE1qR3dc6UJoUAsZ';
const FEE_WALLET = 'FeeWa11et1111111111111111111111111111111111';
const EXECUTOR = 'J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf';
const USER = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB'; // the taker the fixtures were built for (a test-only key)
const PUMP = '3QkTHofooopp7XkBDqjRDC2k1mbkG1d1QTdU8NDRpump';
const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'jupiter', `${name}.json`), 'utf8'));
const enc = k.getAddressEncoder();
const TABLES = {};
for (const [t, list] of Object.entries(fixture('buy-pump').addressesByLookupTableAddress)) {
  TABLES[t] = { owner: 'AddressLookupTab1e1111111111111111111111111', data: [Buffer.concat([Buffer.alloc(56), ...list.map(a => Buffer.from(enc.encode(k.address(a))))]).toString('base64'), 'base64'] };
}
const b64 = b => [Buffer.from(b).toString('base64'), 'base64'];
const tokenData = amount => { const d = Buffer.alloc(165); d.writeBigUInt64LE(BigInt(amount), 64); return b64(d); };
const decode = base64 => {
  const t = k.getTransactionDecoder().decode(Buffer.from(base64, 'base64'));
  const m = k.getCompiledTransactionMessageDecoder().decode(t.messageBytes);
  return { t, ixs: m.instructions.map(i => ({ program: m.staticAccounts[i.programAddressIndex], data: Buffer.from(i.data || []) })) };
};
/** The order account place_order would write (the stand-in chain's simulation). */
function orderFromPlace(data, owner) {
  const d = Buffer.from(data);
  return Buffer.concat([op.DISC.order, Buffer.from(enc.encode(owner)), d.subarray(16, 48), d.subarray(48, 80), d.subarray(80, 112), d.subarray(112, 113), d.subarray(113, 129), Buffer.alloc(8), d.subarray(129, 145), d.subarray(8, 16), Buffer.from([255])]);
}

function stage(t, { orders = true, volumes = false, curve = true } = {}) {
  const st = { sims: [] };
  const saved = { ...env };
  Object.assign(env, { solanaOrdersEnabled: orders, solanaOrdersProgramId: PROGRAM, solanaOrdersExecutor: EXECUTOR, solanaOrdersFeeWallet: FEE_WALLET, solanaOrdersLookupTable: '', swapFeeWalletSolana: FEE_WALLET });
  jupiter.setTransport(async (p, params) => {
    if (p === '/build') return fixture('buy-pump');
    if (p === '/order') return { outAmount: '9600000' };
    throw new Error(`unexpected ${p}`);
  });
  const realRpc = rpc.solanaRpc;
  const mint = Buffer.alloc(82); mint[44] = 6; mint[45] = 1;
  rpc.solanaRpc = async (method, params) => {
    if (method === 'getBalance') return { value: 5_000_000 };
    if (method === 'getGenesisHash') return 'devnet';
    if (method === 'getAccountInfo') return { value: params[0] === PROGRAM ? { executable: true, data: { parsed: { info: { programData: 'PD' } } } } : { data: { parsed: { info: { authority: null } } } } };
    if (method === 'getMultipleAccounts') {
      const transit = await op.transitOf(PROGRAM, USER);
      const vols = [await op.volumeOf(op.P.pumpFun, transit), await op.volumeOf(op.P.pumpAmm, transit)];
      const curveAt = await op.bondingCurveOf(PUMP);
      return { value: params[0].map(a => (TABLES[a] || (a === PUMP ? { owner: op.P.token2022, lamports: 1, data: b64(mint) }
        : a === USER ? { owner: op.P.system, lamports: 1_000_000_000 }
          : a === curveAt && curve ? { owner: op.P.pumpFun, lamports: 1, data: b64(Buffer.alloc(8)) }
            : vols.includes(a) && volumes ? { owner: op.P.pumpFun, lamports: 1844400, data: b64(Buffer.alloc(137)) } : null))) };
    }
    if (method === 'simulateTransaction') {
      const { ixs } = decode(params[0]);
      st.sims.push(Buffer.from(params[0], 'base64').length);
      const places = ixs.filter(i => i.program === PROGRAM && i.data.subarray(0, 8).equals(op.DISC.placeOrder));
      return { value: { err: null, unitsConsumed: 120000, accounts: [{ data: tokenData(349604509500) }, ...places.map(p => ({ data: b64(orderFromPlace(p.data, USER)) }))] } };
    }
    if (method === 'getRecentPrioritizationFees') return [];
    if (method === 'getLatestBlockhash') return { value: { blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', lastValidBlockHeight: 500 } };
    throw new Error(`unexpected ${method}`);
  };
  const prices = require('../src/providers/prices');
  const rules = require('../src/trade/rules');
  const dd = require('../src/services/dueDiligence');
  const launches = require('../src/services/launches');
  const real = { price: prices.basePrice, settings: rules.settingsFor, quick: dd.quickCheck, forTrade: launches.forTrade, pairs: require('../src/providers/dexscreener').pairs };
  prices.basePrice = async () => 100;
  rules.settingsFor = async () => ({ ...rules.DEFAULT_SETTINGS });
  dd.quickCheck = async () => ({ verdict: 'low', flags: [] });
  launches.forTrade = async () => ({ young: false, risk: 'ok', detail: 'old', flags: [] });
  require('../src/providers/dexscreener').pairs = async () => ({ [PUMP]: { symbol: 'PUMPY' } });
  t.after(() => {
    rpc.solanaRpc = realRpc; Object.assign(env, saved);
    prices.basePrice = real.price; rules.settingsFor = real.settings; dd.quickCheck = real.quick; launches.forTrade = real.forTrade; require('../src/providers/dexscreener').pairs = real.pairs;
  });
  return st;
}
// A fresh schema for every test here (the exits read and write solana_orders).
if (DB) {
  test.before(async () => {
    const db = require('../src/config/db');
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await require('../src/config/migrate').migrate();
  });
  test.after(async () => { await require('../src/config/db').getPool().end(); });
}
const buy = exits => solana.prepare({ accountId: 1, wallet: USER, side: 'buy', token: PUMP, amountUsd: 1, exits });
const MIN_OUT = 349604509500n * 9900n / 10000n;

test('a stop-loss in the same transaction as a pump.fun buy: placed for what the buy is sure to bring, its approval for exactly that', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  stage(t, { volumes: true });
  const p = await buy({ stop_loss: true, stop_pct: 20, floor_pct: 40 });
  assert.equal(p.summary.exits.orders.length, 1);
  assert.equal(p.summary.exits.orders[0].kind, 'stop_loss');
  assert.match(p.summary.exits.covers, /349,604\.51 PUMPY|346,108\.46 PUMPY/);
  assert.match(p.summary.exits.worst_case[0], /^Worst case, even if RektBull were hacked: your 346,108\.46 PUMPY are sold for .* SOL after the 1% fee \(your floor\)/);
  assert.equal(p.exits.length, 1);
  assert.equal(p.exits[0].amountIn, MIN_OUT, 'the buy\'s minimum');
  // At the buy's own price: what the minimum cost, down 20% and 40% (less the 1%).
  const ref = 9_900_000n * MIN_OUT / 349604509500n;
  assert.equal(p.exits[0].triggerOut, ref * 8000n / 10000n);
  assert.equal(p.exits[0].minOut, ref * 6000n / 10000n - ref * 6000n / 10000n / 100n);
  assert.ok(p.checks.some(c => c.check === 'exits'));
  const { t: tx, ixs } = decode(p.solana.transaction);
  assert.deepEqual(Object.keys(tx.signatures), [USER], 'only the user signs');
  assert.ok(p.solana.bytes <= 1232, `${p.solana.bytes} bytes`);
  const place = ixs.filter(i => i.program === PROGRAM);
  assert.equal(place.length, 1);
  assert.equal(place[0].data.readBigUInt64LE(113), MIN_OUT);
  const approve = ixs.find(i => i.program === op.P.token2022 && i.data[0] === 13);
  assert.equal(approve.data.readBigUInt64LE(1), MIN_OUT, 'an approval for exactly those coins');
  // The buy itself is unchanged: the fee transfer still goes, and the orders come after it.
  assert.ok(ixs.findIndex(i => i.program === PROGRAM) > ixs.findIndex(i => i.program === op.P.system && i.data.readUInt32LE(0) === 2));
});

test('too big for one transaction: the largest set that fits, saying what was left out', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  // Both exits, and this wallet's first pump.fun order (its volume accounts): over 1,232 bytes, with or without them;
  // the stop-loss alone fits, and the fill service will open the volume accounts.
  const st = stage(t, { volumes: false });
  const p = await buy({ stop_loss: true, take_profit: true });
  assert.deepEqual(p.summary.exits.orders.map(o => o.kind), ['stop_loss']);
  assert.match(p.summary.exits.note, /Only the stop-loss fitted/);
  assert.ok(p.solana.bytes <= 1232);
  assert.equal(decode(p.solana.transaction).ixs.filter(i => i.program === op.P.pumpFun || i.program === op.P.pumpAmm).length, 0, 'no volume accounts: they didn\'t fit');
  // They come in a small setup transaction of their own, signed and paid by the user just before the buy.
  const setup = decode(p.solana.setup.transaction);
  assert.deepEqual(Object.keys(setup.t.signatures), [USER]);
  assert.deepEqual(setup.ixs.map(i => i.program), [op.P.pumpFun, op.P.pumpAmm]);
  assert.ok(setup.ixs.every(i => i.data.equals(op.DISC.initVolume)));
  assert.equal(p.summary.exits.setup_sol, '0.0036888');
  assert.match(p.summary.exits.costs.volume_accounts_note, /your wallet signs them first, in a small setup transaction of their own/);
  assert.ok(st.sims.length >= 1);
});

test('orders off: the buy goes alone, saying why', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  stage(t, { orders: false });
  const p = await buy({ stop_loss: true });
  assert.match(p.summary.exits.none, /^No exits were added: Orders on Solana open once RektBull's order program has been audited and deployed/);
  assert.equal(p.exits, undefined);
  assert.equal(decode(p.solana.transaction).ixs.filter(i => i.program === PROGRAM).length, 0);
});

test('the trade records its exits as prepared orders; preview records nothing', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  stage(t, { volumes: true });
  const { rows: [acct] } = await db.query('INSERT INTO accounts (solana_wallet) VALUES ($1) RETURNING id', [USER]);
  const account = { id: acct.id, solana_wallet: USER };
  const proposals = require('../src/trade/proposals');
  const input = { chain: 'solana', side: 'buy', token: PUMP, base: 'SOL', amount_usd: 1, exits: { stop_loss: true, stop_pct: 25 } };
  const pv = await proposals.preview(account, input);
  assert.equal(pv.plan.summary.exits.orders[0].kind, 'stop_loss');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM solana_orders')).rows[0].n, 0, 'a preview stores nothing');
  const tr = await proposals.trade(account, input);
  const { rows } = await db.query('SELECT kind, state, amount_in, order_address, source, owner FROM solana_orders');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].kind, rows[0].state, rows[0].amount_in, rows[0].owner], ['stop_loss', 'prepared', String(MIN_OUT), USER]);
  assert.equal(rows[0].source, await op.ataOf(USER, op.P.token2022, PUMP));
  const placed = decode(tr.calls.transaction).ixs.find(i => i.program === PROGRAM);
  assert.ok(placed, 'the order is in the transaction the wallet gets');
  assert.equal(rows[0].order_address, await op.orderOf(PROGRAM, USER, placed.data.readBigUInt64LE(8)), 'the row is the order in that transaction');

  // A copy of a followed wallet's buy: its stop-loss also sells when that wallet sells (the Wallet Tracker's signal).
  const COPIED = 'Cop1edWa11et1111111111111111111111111111111';
  const copyInput = { ...input, exits: { ...input.exits, copy_wallet: COPIED } };
  assert.match((await proposals.preview(account, copyInput)).plan.summary.exits.copy_note, /you don't follow it/);
  await db.query(`INSERT INTO followed_wallets (account_id, address, family) VALUES ($1, $2, 'solana')`, [account.id, COPIED]);
  const cpv = await proposals.preview(account, copyInput);
  assert.equal(cpv.plan.summary.exits.orders[0].sells_with, COPIED);
  assert.ok(cpv.plan.summary.exits.worst_case.some(w => /also sells, at the market and never below its floor, when Cop1…1111 sells/.test(w)));
  await proposals.trade(account, copyInput);
  const { rows: [cp] } = await db.query(`SELECT id, copy_wallet FROM solana_orders WHERE copy_wallet IS NOT NULL`);
  assert.equal(cp.copy_wallet, COPIED);
  await db.query(`UPDATE solana_orders SET state = 'open'`);
  const orders = require('../src/trade/solanaOrders');
  assert.equal(await orders.copySellSignal(USER, PUMP, {}), 0, 'another wallet\'s sale: nothing');
  assert.equal(await orders.copySellSignal(COPIED, PUMP, { copy: { wallet: COPIED } }), 1, 'only the copy\'s stop-loss fires');
  const { rows: states } = await db.query(`SELECT copy_wallet, state FROM solana_orders ORDER BY id`);
  assert.deepEqual(states.map(r => r.state), ['open', 'triggered']);
});
