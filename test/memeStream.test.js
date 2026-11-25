/**
 * Triggers over WebSocket for orders on BNB Chain and Base (src/trade/memeStream.js, src/providers/evmStream.js):
 * prices read from a pool's own events; the stream client's subscriptions, routing, counting and reconnects; and on
 * the real database with a stand-in chain and a stand-in WebSocket: only orders near their trigger watched; a price
 * from the stream fires an order and fills it at once, but only once the fill's own quote confirms it; Meme Watch's
 * insider transfers fire its exits; the daily budget; the switch.
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

/** A stand-in WebSocket: answers subscribes with ids, and lets the test push logs or drop the connection. */
const sockets = [];
let subN = 0;
class FakeSocket {
  constructor(url) {
    this.url = url; this.readyState = 0; this.subs = new Map(); this.sent = [];
    sockets.push(this);
    setImmediate(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(text) {
    const m = JSON.parse(text);
    this.sent.push(m);
    let result = null;
    if (m.method === 'eth_subscribe') { result = `0xs${++subN}`; this.subs.set(result, m.params[1]); }
    if (m.method === 'eth_unsubscribe') { this.subs.delete(m.params[0]); result = true; }
    if (m.method === 'eth_chainId') result = '0x2105';
    setImmediate(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) }));
  }
  push(sub, log) { this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: sub, result: log } }) }); }
  subFor(pred) { return [...this.subs.entries()].find(([, f]) => pred(f))?.[0]; }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
}
const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
const word = v => ethers.toBeHex(BigInt(v), 32).slice(2);

test('a pool\'s price from its own events: v2 Sync (both forms), v3 Swap (both forms), v4 Swap', () => {
  // A v2 pool with WETH as token0 (100) and the coin as token1 (2,000,000): the coin is worth 0.00005 WETH.
  const sync = { topics: [T.syncV2], data: '0x' + word(100n * 10n ** 18n) + word(2_000_000n * 10n ** 18n) };
  const r = stream.ratioOf(sync);
  assert.equal(r, 20000);
  assert.equal(stream.priceIn(r, 1, 18, 18), 0.00005);
  assert.equal(stream.ratioOf({ ...sync, topics: [T.syncSolidly] }), 20000, 'Aerodrome\'s form');
  // A v3 swap at sqrtPriceX96 = 2 * 2^96: 4 raw token1 per raw token0; with 6-decimal USDC as token1 and an 18-decimal coin as token0, $4e-12 a coin.
  const sqrt = 2n * 2n ** 96n;
  const v3 = { topics: [T.swapV3, '0x' + '0'.repeat(64), '0x' + '0'.repeat(64)], data: '0x' + word(1) + word(1) + word(sqrt) + word(0) + word(0) };
  assert.equal(stream.ratioOf(v3), 4);
  assert.equal(stream.priceIn(4, 0, 6, 18) * 1e12, 4, 'token0 the coin');
  assert.equal(stream.ratioOf({ ...v3, topics: [T.swapPcsV3], data: v3.data + word(0) + word(0) }), 4, 'PancakeSwap v3\'s form');
  assert.equal(stream.ratioOf({ topics: [T.swapV4, '0x' + '1'.repeat(64), '0x' + '0'.repeat(64)], data: '0x' + word(1) + word(1) + word(sqrt) + word(0) + word(0) + word(0) }), 4);
  assert.equal(stream.ratioOf({ topics: [T.transfer], data: '0x' }), null, 'not a price');
  assert.equal(stream.V4_POOL_MANAGER.base, '0x498581ff718922c3f8e6a244956af099b2652b2b');
});

test('a pool whose events don\'t agree with DexScreener\'s price isn\'t used: it stays on polling', async () => {
  const st = stream._state;
  const key = 'pool:0x' + 'c1'.repeat(20);
  st.watches.base = { [key]: { type: 'pool', chain: 'base', token: '0x' + 'b1'.repeat(20), pool: '0x' + 'c1'.repeat(20), decimals: 18, quote_decimals: 18, ref: 0.00005, quote_usd: 3000, native_usd: 3000, orient: null } };
  // 0.01 or 100 WETH a coin, either way round: neither within 30% of 0.00005.
  stream._onLog('base', key, { topics: [T.syncV2], data: '0x' + word(100n * 10n ** 18n) + word(10_000n * 10n ** 18n) });
  await stream._drain();
  assert.ok(st.bad.has(key));
  assert.equal(st.watches.base[key].orient, null, 'never priced');
  st.bad.clear(); st.watches.base = {};
});

test('the stream client: subscribes what it\'s asked, routes each log to its key, counts what the provider bills, resubscribes after a drop', async () => {
  sockets.length = 0;
  evmStream._setSocket(url => new FakeSocket(url));
  const got = [];
  const c = evmStream.connect('base', 'wss://node.example/key', { onLog: (key, log) => got.push([key, log.n]) });
  await c.sync({ a: { address: '0x' + '1'.repeat(40) }, b: { address: '0x' + '2'.repeat(40) } });
  await settle();
  const ws = sockets[0];
  assert.equal(ws.subs.size, 2);
  ws.push(ws.subFor(f => f.address.startsWith('0x1')), { n: 1 });
  ws.push(ws.subFor(f => f.address.startsWith('0x2')), { n: 2 });
  ws.push('0xunknown', { n: 3 });
  assert.deepEqual(got, [['a', 1], ['b', 2]]);
  assert.equal(c.counts().total, 5, 'two subscribes and three pushed logs (a log for a dropped subscription is still billed)');
  assert.deepEqual(c.counts().byKey, { a: 2, b: 2 });
  // Asked for b alone: a goes.
  await c.sync({ b: { address: '0x' + '2'.repeat(40) } });
  await settle();
  assert.equal(ws.subs.size, 1);
  assert.ok(ws.sent.some(m => m.method === 'eth_unsubscribe'));
  // The connection drops: it comes back by itself and subscribes b again.
  ws.close();
  await new Promise(r => setTimeout(r, 1200));
  await settle();
  assert.equal(sockets.length, 2);
  assert.equal(sockets[1].subs.size, 1);
  assert.equal(c.status().reconnects, 1);
  c.close();
  evmStream._setSocket(null);
});

test('triggers over WebSocket, end to end: armed near the trigger, fired by a pool\'s event, confirmed by the quote, filled at once; insiders; the budget; the switch', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  const cache = require('../src/lib/cache');
  const fresh = async () => { cache._memory.clear(); await db.query('DELETE FROM cache'); };
  await fresh();
  const { standIn, ROUTER_BASE, AH, WETH, BULL } = require('./helpers/memeChain');
  const orders = require('../src/trade/memeOrders');
  const tx = require('../src/trade/memeOrderTx');
  const user = ethers.Wallet.createRandom();
  const exec = ethers.Wallet.createRandom();
  const owner = user.address.toLowerCase();
  const POOL = '0x' + 'c0'.repeat(20);
  const saved = { ...env };
  Object.assign(env, { memeOrdersEnabled: true, memeRouters: { base: ROUTER_BASE }, memeOrdersExecutor: exec.address.toLowerCase(), memeStreamWsBase: 'wss://node.example/base-key', memeStreamWsBsc: '' });
  const chain = standIn();
  orders._setProvider(name => chain.provider(orders.CHAINS[name].chainId));
  let nonce = 0;
  orders._setExecutor(async name => ({
    address: exec.address.toLowerCase(),
    signer: { populateTransaction: async c => ({ to: c.to, data: c.data, value: 0n, chainId: orders.CHAINS[name].chainId, nonce: nonce++, gasLimit: 300_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n, type: 2 }), signTransaction: t2 => exec.signTransaction(t2) },
  }));
  chain.native.set(exec.address.toLowerCase(), 10n ** 18n);
  sockets.length = 0;
  evmStream._setSocket(url => new FakeSocket(url));

  const zeroex = require('../src/trade/zeroex');
  const dexscreener = require('../src/providers/dexscreener');
  const prices = require('../src/providers/prices');
  const lp = require('../src/services/launchpads');
  const orig = { pairs: dexscreener.pairs, usd: prices.usdPrice, identify: lp.identify };
  t.after(async () => {
    stream.halt();
    dexscreener.pairs = orig.pairs; prices.usdPrice = orig.usd; lp.identify = orig.identify;
    orders._setProvider(null); orders._setExecutor(null); evmStream._setSocket(null); Object.assign(env, saved);
    await db.getPool().end();
  });
  // 0x: a sale of BULL brings `sellRate` wei of ETH per whole coin.
  let sellRate = 5n * 10n ** 13n;
  zeroex.setTransport(async (path, params) => {
    const buyAmount = String(BigInt(params.sellAmount) * sellRate / 10n ** 18n);
    return { liquidityAvailable: true, sellAmount: params.sellAmount, buyAmount, minBuyAmount: String(BigInt(buyAmount) * 97n / 100n), ...(path.endsWith('/quote') ? { transaction: { to: AH, data: '0xc0ffee', value: '0' } } : {}) };
  });
  let priceUsd = 0.15; // 1,000 BULL = $150 = 0.05 ETH at $3,000
  dexscreener.pairs = async (c, tokens) => Object.fromEntries(tokens.map(tk => [tk, { price_usd: priceUsd, symbol: 'BULL', pair: POOL, dex: 'uniswap', labels: ['v2'], price_native: priceUsd / 3000, quote: WETH }]));
  prices.usdPrice = async () => 3000;
  lp.identify = async () => ({ launchpad: null });
  const admin = require('../src/admin/settings');
  await admin.set('meme_stream', { on: true }, { wallet: 'admin', action: 'meme_stream', reason: 'test' });

  const { rows: [{ id: acct }] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id', [owner]);
  const account = { id: acct, wallet: owner };
  chain.hold(BULL, owner, 1000n * 10n ** 18n);
  chain.approve(BULL, owner, ROUTER_BASE, 2000n * 10n ** 18n);
  const sign = async p => { const { EIP712Domain, ...types } = p.typed_data.types; return user.signTypedData(p.typed_data.domain, types, p.typed_data.message); };
  const place = async body => { const p = await orders.prepare(account, { chain: 'base', token: BULL, ...body }); await orders.sign(account, p.order.id, { signature: await sign(p) }); return p.order; };
  // A stop-loss: fires when 1,000 BULL fall to 0.04 ETH (down 20%), never below 0.0297 after the fee.
  const sl = await place({ kind: 'stop_loss', stop_pct: 20, floor_pct: 40 });
  // The trade pass reads prices; the stream plans from them. A sync the stream pushes, from a pool with WETH as token0.
  const pass = async () => { await fresh(); await orders._triggers(); await stream.plan(); await settle(); };
  const syncAt = coinPriceEth => ({ address: POOL, topics: [T.syncV2], data: '0x' + word(100n * 10n ** 18n) + word(BigInt(Math.round(100 / coinPriceEth)) * 10n ** 18n), transactionHash: '0x' + 'ab'.repeat(32), blockNumber: '0x10' });

  // 1. Far from its trigger (0.0467 ETH against 0.04: 17% away): not watched.
  priceUsd = 0.14;
  await pass();
  const ws = sockets[0];
  assert.ok(ws, 'connected');
  assert.equal(ws.subs.size, 0, 'nothing near its trigger');
  // 2. Within 15%: its pool is subscribed (v2 and v3 events, both forms).
  priceUsd = 0.13;
  await pass();
  const sub = ws.subFor(f => f.address === POOL);
  assert.ok(sub, 'the coin\'s most liquid pool');
  assert.deepEqual(ws.subs.get(sub).topics, [[T.syncV2, T.syncSolidly, T.swapV3, T.swapPcsV3]]);
  // A trade at DexScreener's price: the side the coin is on is settled; nothing fires.
  ws.push(sub, syncAt(0.13 / 3000));
  await stream._drain();
  assert.equal((await orders.list(account)).orders[0].state, 'open');
  // 3. A price from the stream that the fill's quote doesn't confirm: back to watching, nothing sent.
  ws.push(sub, syncAt(0.000035)); // 1,000 BULL = 0.035 ETH: under the stop
  await stream._drain();
  let row = (await orders.list(account)).orders.find(o => o.id === sl.id);
  assert.equal(row.state, 'open');
  assert.match(row.last_error, /wasn't confirmed by 0x's quote/);
  assert.equal(chain.sent.length, 0);
  // 4. The market really fell: the stream fires it and it's filled at once, without waiting for the pass.
  sellRate = 35n * 10n ** 12n;
  ws.push(sub, syncAt(0.000035));
  await stream._drain();
  assert.equal(chain.sent.length, 1, 'filled at once');
  row = (await orders.list(account)).orders.find(o => o.id === sl.id);
  assert.equal(row.state, 'triggered');
  assert.equal(row.trigger_reason.stream, true);
  assert.match(row.trigger_reason.source, /the pool's own Sync event, pushed over the chain's WebSocket/);
  const sent = tx.ROUTER.parseTransaction({ data: ethers.Transaction.from(chain.sent[0].raw).data });
  assert.equal(sent.name, 'fill');

  // 5. Meme Watch: an exit on the coin, and its launch-bundle group (10% of the supply). Moves inside the group don't count;
  // sales out of it do, once each; at 20% of what it bought, the exit fires and is filled.
  const W1 = '0x' + 'a1'.repeat(20), W2 = '0x' + 'a2'.repeat(20), OUT = '0x' + 'dd'.repeat(20);
  await db.query(`INSERT INTO agent_settings (account_id, agent, enabled, snapshot) VALUES ($1, 'meme_watch', true, $2)`,
    [acct, JSON.stringify({ positions: { [`base:${BULL}`]: { groups: [{ funder: '0x' + 'f0'.repeat(20), wallets: [{ address: W1 }, { address: W2 }], bought_pct: 10 }] } } })]);
  const mw = await place({ kind: 'meme_watch_exit', floor_pct: 50 });
  await pass();
  const ins = ws.subFor(f => f.address === BULL);
  assert.ok(ins, 'the coin\'s Transfers from the group\'s wallets');
  assert.deepEqual(ws.subs.get(ins).topics, [T.transfer, [ethers.zeroPadValue(W1, 32), ethers.zeroPadValue(W2, 32)]]);
  const transfer = (from, to, amount, i) => ({ address: BULL, topics: [T.transfer, ethers.zeroPadValue(from, 32), ethers.zeroPadValue(to, 32)], data: ethers.toBeHex(amount, 32), transactionHash: '0x' + String(i).padStart(64, '0'), logIndex: '0x1' });
  const E24 = 10n ** 24n; // the group bought 10% of a billion coins: 1e26 raw; 20% of that is 2e25
  ws.push(ins, transfer(W1, W2, 30n * E24, 1)); // inside the group
  ws.push(ins, transfer(W1, OUT, 10n * E24, 2)); // 10%
  ws.push(ins, transfer(W1, OUT, 10n * E24, 2)); // the same log again (a reconnect): counted once
  await stream._drain();
  assert.equal((await orders.list(account)).orders.find(o => o.id === mw.id).state, 'open');
  ws.push(ins, transfer(W2, OUT, 12n * E24, 3)); // 22%
  await stream._drain();
  const mwRow = (await orders.list(account)).orders.find(o => o.id === mw.id);
  assert.equal(mwRow.state, 'triggered');
  assert.match(mwRow.trigger_reason.alert, /sold 22% of what they bought/);
  assert.equal(chain.sent.length, 2, 'the exit filled at once');

  // 6. The daily budget: once it's used, prices go back to polling (the pool is unsubscribed); the insiders stay.
  sellRate = 5n * 10n ** 13n; // placed at 0x's price before the fall: 500 BULL = 0.025 ETH, stop at 0.02
  const sl2 = await place({ kind: 'stop_loss', share_pct: 50, stop_pct: 20, floor_pct: 40 });
  assert.ok(sl2.id);
  await place({ kind: 'meme_watch_exit', share_pct: 50, floor_pct: 50 }); // the first has fired: a new one, still watched
  priceUsd = 0.13;
  await pass();
  const pool2 = ws.subFor(f => f.address === POOL);
  assert.ok(pool2, 'armed again for the new stop-loss');
  await admin.set('meme_stream', { on: true, daily_budget: 1000 }, { wallet: 'admin', action: 'meme_stream', reason: 'test' });
  for (let i = 0; i < 1000; i++) ws.push('0xnobody', {});
  await pass();
  assert.equal(ws.subFor(f => f.address === POOL), undefined, 'over budget: the pool is dropped');
  assert.ok(ws.subFor(f => f.address === BULL), 'the insiders\' filter stays');
  const health = await stream.health();
  assert.equal(health.state, 'live');
  assert.match(health.note, /over budget: prices back on polling until tomorrow/);

  // 7. Switched off: the connection closes.
  await admin.set('meme_stream', { on: false }, { wallet: 'admin', action: 'meme_stream', reason: 'test' });
  await stream.plan();
  await settle();
  assert.equal(ws.readyState, 3);
  assert.equal((await stream.health()).state, 'off');
  assert.throws(() => stream.check({ daily_budget: 5 }), /daily_budget must be a whole number from 1000/);
});
