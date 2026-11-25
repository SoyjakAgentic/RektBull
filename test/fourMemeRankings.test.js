/**
 * Wallet rankings on BNB Chain (src/services/walletRankings.js, src/trade/memeStream.js): four.meme's trades over the
 * WebSocket stream, on the real database with a stand-in WebSocket. The filter on TokenManager2's own events; coins
 * priced in BNB only; a coin's creator left out; five coins closed ranks a wallet, in BNB; the budget of its own, which
 * drops the filter when it's used and doesn't count against the order triggers' budget; the order service can be off.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, { DATABASE_URL: DB || '', JWT_SECRET: 'test-secret' });
const env = require('../src/config/env');
const evmStream = require('../src/providers/evmStream');
const stream = require('../src/trade/memeStream');
const { T } = stream;

const sockets = [];
let subN = 0;
class FakeSocket {
  constructor(url) {
    this.url = url; this.readyState = 0; this.subs = new Map();
    sockets.push(this);
    setImmediate(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(text) {
    const m = JSON.parse(text);
    let result = null;
    if (m.method === 'eth_subscribe') { result = `0xs${++subN}`; this.subs.set(result, m.params[1]); }
    if (m.method === 'eth_unsubscribe') { this.subs.delete(m.params[0]); result = true; }
    if (m.method === 'eth_chainId') result = '0x38';
    setImmediate(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) }));
  }
  push(sub, log) { this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: sub, result: log } }) }); }
  subFor(pred) { return [...this.subs.entries()].find(([, f]) => pred(f))?.[0]; }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
}
const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
const word = v => ethers.toBeHex(BigInt(v), 32).slice(2);
const E18 = 10n ** 18n;

test('wallet rankings on BNB Chain: four.meme\'s trades, BNB-quoted only, ranked in BNB, under a budget of their own', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  const cache = require('../src/lib/cache');
  cache._memory.clear();
  const saved = { ...env };
  // The order service off (no Meme Router yet): the rankings stream BNB Chain on their own.
  Object.assign(env, { memeOrdersEnabled: false, memeStreamWsBsc: 'wss://node.example/bsc-key', memeStreamWsBase: '' });
  sockets.length = 0;
  evmStream._setSocket(url => new FakeSocket(url));
  const lp = require('../src/services/launchpads');
  const prices = require('../src/providers/prices');
  const orig = { identify: lp.identify, usd: prices.usdPrice };
  const COINS = [1, 2, 3, 4, 5, 6].map(i => '0x' + String(i).repeat(40));
  const USD1_COIN = '0x' + 'e'.repeat(40);
  lp.identify = async (chain, token) => ({ launchpad: 'fourmeme', state: 'curve', quote: token === USD1_COIN ? 'usd1' : 'bnb' });
  prices.usdPrice = async id => (id === 'coingecko:binancecoin' ? 600 : 150);
  t.after(async () => {
    stream.halt();
    lp.identify = orig.identify; prices.usdPrice = orig.usd;
    evmStream._setSocket(null); Object.assign(env, saved);
    await db.getPool().end();
  });
  const admin = require('../src/admin/settings');
  await admin.set('meme_stream', { on: true, rankings_daily_budget: 40 }, { wallet: 'admin', action: 'meme_stream', reason: 'test' });

  // The filter: TokenManager2's purchases, sales and creations, nothing else.
  await stream.plan();
  await settle();
  const ws = sockets[0];
  assert.match(ws.url, /bsc-key/);
  const sub = ws.subFor(f => f.address === stream.FOURMEME_TM2);
  assert.ok(sub, 'four.meme\'s TokenManager2 is watched, with the order service off');
  assert.deepEqual(ws.subs.get(sub).topics, [[T.fmBuy, T.fmSell, T.fmCreate]]);
  assert.equal(T.fmBuy, '0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942', 'the topic seen in TokenManager2\'s own logs');

  const W = '0x' + 'a1'.repeat(20), DEV = '0x' + 'de'.repeat(20);
  let n = 0;
  const log = (topic, words) => ({ address: stream.FOURMEME_TM2, topics: [topic], data: '0x' + words.map(word).join(''), transactionHash: '0x' + String(++n).padStart(64, '0'), logIndex: '0x0' });
  // TokenPurchase/TokenSale: token, account, price, amount, cost, fee, offers, funds
  const trade = (isBuy, token, who, cost) => log(isBuy ? T.fmBuy : T.fmSell, [token, who, 1, 1_000_000n * E18, cost, cost / 100n, 0, 0]);
  const create = (token, creator) => log(T.fmCreate, [creator, token, 7, 0, 0, 0, 0, 0]);

  // A coin's creator trading their own coin; a coin priced in USD1: neither counted.
  ws.push(sub, create(COINS[0], DEV));
  ws.push(sub, trade(true, COINS[0], DEV, E18));
  ws.push(sub, trade(true, USD1_COIN, W, E18));
  ws.push(sub, trade(false, USD1_COIN, W, 2n * E18));
  // Six coins, each bought for 1 BNB (plus four.meme's 1%) and sold for 1.5 BNB (less 1%): +0.475 BNB each. The first
  // was bought in the second it was created: a snipe, counted apart, its profit not counted.
  for (const c of COINS) { ws.push(sub, trade(true, c, W, E18)); ws.push(sub, trade(false, c, W, 3n * E18 / 2n)); }
  await stream._drain();
  const ranker = require('../src/services/walletRankings').forChain('bsc');
  assert.equal(ranker._state().positions.size, 0, 'every coin sold: closed');
  assert.equal(await ranker.flush(), 1, 'one wallet-day written');
  const { rows: [day] } = await db.query(`SELECT chain, wallet, realised::bigint AS r, coins, wins, snipes FROM wallet_pnl_daily`);
  assert.deepEqual([day.chain, day.wallet, Number(day.r), day.coins, day.wins, day.snipes], ['bsc', W, 2_375_000_000, 5, 5, 1],
    'in gwei: 2.375 BNB from five coins; the snipe, the creator\'s trade and the USD1 coin\'s left out');

  const top = await require('../src/services/walletRankings').top('7d', 'bsc');
  assert.deepEqual([top.chain, top.unit, top.venue, top.stream], ['bsc', 'BNB', 'four.meme', true]);
  assert.equal(top.wallets.length, 1);
  assert.deepEqual([top.wallets[0].wallet, top.wallets[0].realised_native, top.wallets[0].realised_usd, top.wallets[0].coins], [W, 2.375, 1425, 5]);
  assert.match(top.wallets[0].explorer, /^https:\/\/bscscan\.com\/address\/0x/);
  assert.match(top.rules.join(' '), /four\.meme's bonding curves \(coins priced in BNB\).*daily budget can run out/);
  assert.match(top.source, /TokenManager2's TokenPurchase and TokenSale events/);
  assert.equal((await require('../src/services/walletRankings').top('7d', 'solana')).wallets.length, 0, 'Solana\'s ranking is apart');

  // The budget: 16 events so far today. At the cap the filter is dropped until tomorrow, and the triggers' budget is untouched.
  await admin.set('meme_stream', { on: true, rankings_daily_budget: 16 }, { wallet: 'admin', action: 'meme_stream', reason: 'test' });
  await stream.plan();
  await settle();
  assert.equal(ws.subFor(f => f.address === stream.FOURMEME_TM2), undefined, 'budget used: no more four.meme events today');
  const h = await stream.health();
  assert.match(h.note, /wallet rankings: 16 of 16 four\.meme events today \(budget used: the ranking is partial until tomorrow\)/);
  assert.equal(stream._state.budgetHit.bsc, false, 'the rankings\' events don\'t count against the order triggers\' budget');
  // Switched off (a budget of 0): BNB Chain isn't streamed for them at all.
  await admin.set('meme_stream', { on: true, rankings_daily_budget: 0 }, { wallet: 'admin', action: 'meme_stream', reason: 'test' });
  await stream.plan();
  await settle();
  assert.equal(ws.readyState, 3, 'nothing else on BNB Chain: the connection closes');
  assert.equal(stream.rankingsOn(), false);
});
