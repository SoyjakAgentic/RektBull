/**
 * Meme Watch on Solana, streamed (src/services/insiderWatch.js): a sale is a
 * group's wallets, together, holding less of the coin after a transaction;
 * the wallets ride the pump.fun stream as filters of 200, at most 19; each
 * sale is recorded once, alerting the accounts that hold the coin (the group's
 * first sale, then each 20% of what it bought, under the same keys as the
 * 6-hour check). The Yellowstone client and Solana RPC are stand-ins.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { getAddressEncoder } = require('@solana/kit');

const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, { DATABASE_URL: DB || '' });
const env = require('../src/config/env');
const yellowstone = require('../src/providers/yellowstone');
const iw = require('../src/services/insiderWatch');

const MINT = 'Ce9JBbxPQx2cAJjhFi9NEkmqGJGTVFBTHmYSGFTwpump';
const OTHER = 'Cx3BiUwpVNYTN8QWFQXSBqHG2yKzYWg2PczbvYeDpump';
const FUNDER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const W1 = '8sNW9oXSdyMZSHHRrRwnXGgS7WhW1gMTFSuUWhMkMvD5';
const W2 = 'FLkA8e9yqSSu3pNswV8tQSqqD8Zz5FKtsTWw6Py8VSaQ';
const STRANGER = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const group = { mint: MINT, funder: FUNDER, wallets: new Set([W1, W2]), bought_pct: 10, accounts: new Set(), symbol: 'BULL' };
const bal = (owner, mint, pre, post) => ({ owner, mint, pre: BigInt(pre), post: BigInt(post) });

test('a sale: the group holds less after the transaction; moves inside the group, other coins and strangers don\'t count', () => {
  const by = iw.indexOf([group]);
  assert.deepEqual(iw.salesIn({ balances: [bal(W1, MINT, 1000, 400)] }, by).map(x => [x.group.funder, x.sold]), [[FUNDER, 600n]]);
  assert.deepEqual(iw.salesIn({ balances: [bal(W1, MINT, 1000, 0), bal(W2, MINT, 0, 1000)] }, by), [], 'from one of its wallets to another: not a sale');
  assert.deepEqual(iw.salesIn({ balances: [bal(W1, MINT, 1000, 0), bal(W2, MINT, 0, 700)] }, by).map(x => x.sold), [300n], 'only what left the group');
  assert.deepEqual(iw.salesIn({ balances: [bal(W1, OTHER, 1000, 0), bal(STRANGER, MINT, 1000, 0)] }, by), [], 'another coin, or a wallet not in the group');
  assert.deepEqual(iw.salesIn({ balances: [bal(W1, MINT, 0, 500)] }, by), [], 'buying more isn\'t selling');
  assert.deepEqual(iw.salesIn({ failed: true, balances: [bal(W1, MINT, 1000, 0)] }, by), []);
});

test('the filters: 200 wallets each, at most 19 beside pump.fun\'s; the rest are left to the 6-hour check', () => {
  const wallets = n => Array.from({ length: n }, (_, i) => `W${String(i).padStart(5, '0')}`);
  const g = n => [{ ...group, wallets: new Set(wallets(n)) }];
  const f = iw.filtersFor(g(450));
  assert.deepEqual(Object.values(f.filters).map(x => x.accountInclude.length), [200, 200, 50]);
  assert.deepEqual([f.wallets, f.watched, f.overflow], [450, 450, 0]);
  const big = iw.filtersFor(g(4000));
  assert.deepEqual([Object.keys(big.filters).length, big.watched, big.overflow], [19, 3800, 200]);
  assert.deepEqual(iw.filtersFor([]).filters, {});
  // The provider refuses what Chainstack would.
  Object.assign(env, { yellowstoneGrpcUrl: 'https://x.example:443', yellowstoneGrpcToken: 't' });
  try {
    assert.throws(() => yellowstone.updateFilters('none', Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, { accountInclude: ['a'] }]))), /1 to 20 transaction filters/);
    assert.throws(() => yellowstone.updateFilters('none', { a: { accountInclude: wallets(201) } }), /at most 200 accounts/);
    assert.throws(() => yellowstone.updateFilters('none', { a: { accountInclude: [] } }), /no accounts/);
    assert.equal(yellowstone.updateFilters('none', { a: { accountInclude: ['x'] } }), false, 'no such subscription open');
  } finally { Object.assign(env, { yellowstoneGrpcUrl: '', yellowstoneGrpcToken: '' }); }
});

test('through the stream: the wallets as filters, a sale within seconds, alerts to the holders once', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  const ps = require('../src/services/pumpStream');
  t.after(async () => { ps.halt(); yellowstone._reset(); Object.assign(env, { yellowstoneGrpcUrl: '', yellowstoneGrpcToken: '' }); await db.getPool().end(); });

  // Two accounts hold BULL with Meme Watch on; a third has it off.
  const acct = async w => (await db.query('INSERT INTO accounts (solana_wallet) VALUES ($1) RETURNING id', [w])).rows[0].id;
  const [a, b, off] = [await acct(W1.replace(/.$/, 'A')), await acct(W1.replace(/.$/, 'B')), await acct(W1.replace(/.$/, 'C'))];
  const snapshot = { positions: { [`solana:${MINT}`]: { symbol: 'BULL', groups: [{ funder: FUNDER, wallets: [{ address: W1 }, { address: W2 }], bought_pct: 10, reported_pct: 10 }] } } };
  for (const [id, on] of [[a, true], [b, true], [off, false]]) {
    await db.query(`INSERT INTO agent_settings (account_id, agent, enabled, snapshot, next_run_at) VALUES ($1, 'meme_watch', $2, $3, now() + interval '1 hour')`, [id, on, JSON.stringify(snapshot)]);
  }
  const list = await iw.watchlist();
  assert.deepEqual(list.map(g => [g.mint, g.funder, [...g.wallets].sort(), [...g.accounts].sort()]), [[MINT, FUNDER, [W2, W1].sort(), [a, b].sort()]]);

  // 1,000,000,000 in supply: the group bought 10%, 100,000,000.
  const rpc = require('../src/providers/rpc');
  const orig = rpc.solanaRpc;
  t.after(() => { rpc.solanaRpc = orig; });
  rpc.solanaRpc = async method => { if (method === 'getTokenSupply') return { value: { amount: '1000000000', decimals: 6 } }; throw new Error(method); };

  // The stream: pump.fun's program, and the group's wallets, on one subscription.
  let opened = null;
  class Client {
    async connect() {}
    async subscribeWithReconnect(request) { opened = { request, stream: Object.assign(new EventEmitter(), { writes: [], write(r) { this.writes.push(JSON.parse(JSON.stringify(r))); }, end() {} }) }; return opened.stream; }
  }
  yellowstone._setClient(() => ({ default: Client, CommitmentLevel: { CONFIRMED: 1 } }));
  Object.assign(env, { yellowstoneGrpcUrl: 'https://yellowstone.example:443', yellowstoneGrpcToken: 'test-token' });
  assert.equal(await ps.start(), true);
  const until = async fn => { for (let i = 0; i < 100 && !(await fn()); i++) await new Promise(r => setTimeout(r, 30)); };
  await until(() => opened.stream.writes.some(w => w.transactions['watch-0']));
  const sent = opened.stream.writes.find(w => w.transactions['watch-0']);
  assert.deepEqual(Object.keys(sent.transactions), ['pumpfun', 'watch-0'], 'one subscription: pump.fun and the wallets');
  assert.deepEqual(sent.transactions['watch-0'].accountInclude, [W2, W1].sort());
  assert.equal(iw.summary().watched, 2);

  // W2 sells 30,000,000: 3% of the supply, 30% of what the group bought.
  const key = x => Uint8Array.from(getAddressEncoder().encode(x));
  const tokenBal = (owner, amount) => ({ accountIndex: 1, mint: MINT, owner, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount: String(amount), decimals: 6 } });
  const sale = (sig, pre, post) => ({
    type: 'Update', update: { filters: ['watch-0'], transaction: { slot: '300000001', transaction: {
      signature: new Uint8Array(64).fill(sig), transaction: { message: { accountKeys: [key(W2)], instructions: [] } },
      meta: { err: undefined, logMessages: [], innerInstructions: [], preTokenBalances: [tokenBal(W2, pre)], postTokenBalances: [tokenBal(W2, post)] },
    } } },
  });
  opened.stream.emit('data', sale(7, 50000000, 20000000));
  const alerts = async () => (await db.query(`SELECT account_id, severity, title, dedupe_key FROM monitor_alerts ORDER BY id`)).rows;
  await until(async () => (await alerts()).length >= 4);
  const got = await alerts();
  assert.deepEqual(got.map(x => [x.account_id, x.severity]).sort(), [[a, 'critical'], [a, 'high'], [b, 'critical'], [b, 'high']].sort((x, y) => (x[0] - y[0]) || x[1].localeCompare(y[1])), 'both holders, nobody with Meme Watch off');
  assert.ok(got.some(x => x.title === 'BULL on solana: a launch-bundle wallet just sold'));
  assert.ok(got.some(x => x.title === 'BULL on solana: launch-bundle wallets are selling (30% of what they bought is gone)'));
  assert.ok(got.some(x => x.dedupe_key === `meme:solana:${MINT}:insiders:${FUNDER}:1`), 'the 6-hour check\'s own key: it won\'t send this again');
  const { rows: [{ detail }] } = await db.query(`SELECT detail FROM monitor_alerts WHERE severity = 'high' LIMIT 1`);
  assert.match(detail.reasons[0].text, /together hold 3% of the supply less after transaction/);
  assert.equal(detail.sell, `/trade?chain=solana&token=${MINT}&side=sell&fraction=100#trade-card`);

  // The same transaction again (a reconnect can resend it): nothing new. A second sale, to 45%: only the next step.
  opened.stream.emit('data', sale(7, 50000000, 20000000));
  opened.stream.emit('data', sale(8, 20000000, 5000000));
  await until(async () => (await alerts()).length >= 6);
  await new Promise(r => setTimeout(r, 200));
  const after = await alerts();
  assert.equal(after.length, 6, 'one new critical alert each');
  assert.deepEqual(after.slice(4).map(x => x.dedupe_key), [`meme:solana:${MINT}:insiders:${FUNDER}:2`, `meme:solana:${MINT}:insiders:${FUNDER}:2`]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM solana_insider_sells')).rows[0].n, 2, 'each sale recorded once');
  assert.match((await ps.health()).note || '', /Meme Watch: 2 launch-bundle wallets on 1 coin watched|No fresh state/);
});
