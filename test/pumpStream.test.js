/**
 * pump.fun's events over Yellowstone gRPC (src/providers/yellowstone.js,
 * src/services/pumpStream.js): the events read with the layouts in pump.fun's
 * published IDL, built here byte by byte; the stream through a stand-in
 * client; and the Solana launch feed reading it while it's live and polling
 * otherwise. No network: the client, RPC and DexScreener are stand-ins.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { getAddressEncoder } = require('@solana/kit');

Object.assign(process.env, { DATABASE_URL: '' });
const env = require('../src/config/env');
const yellowstone = require('../src/providers/yellowstone');
const ps = require('../src/services/pumpStream');
const cache = require('../src/lib/cache');

const PUMP = ps.PUMP;
const MINT = 'Ce9JBbxPQx2cAJjhFi9NEkmqGJGTVFBTHmYSGFTwpump';
const MINT2 = 'Cx3BiUwpVNYTN8QWFQXSBqHG2yKzYWg2PczbvYeDpump';
const CURVE = '8sNW9oXSdyMZSHHRrRwnXGgS7WhW1gMTFSuUWhMkMvD5';
const POOL = 'FLkA8e9yqSSu3pNswV8tQSqqD8Zz5FKtsTWw6Py8VSaQ';
const USER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/* ── borsh, as pump.fun writes it ── */
const pk = a => Buffer.from(getAddressEncoder().encode(a));
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = n => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const str = s => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
const bool = v => Buffer.from([v ? 1 : 0]);
const T = 1795000000;

const createEvent = ({ mint = MINT, quote = SOL, symbol = 'BULL', name = 'Bull Coin', at = T } = {}) => Buffer.concat([ps.DISC.create,
  str(name), str(symbol), str('https://ipfs.io/ipfs/x'), pk(mint), pk(CURVE), pk(USER), pk(USER), i64(at),
  u64(1073000000000000n), u64(30000000000n), u64(793100000000000n), u64(1000000000000000n), pk('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), bool(false), bool(false), pk(quote),
  u64(0), u64(0), bool(false), Buffer.from([0])]);
const tradeEvent = ({ mint = MINT, realToken = 400000000000000n, realSol = 42000000000n, full = true, quote = SOL, at = T + 60 } = {}) => Buffer.concat([ps.DISC.trade,
  pk(mint), u64(1000000000), u64(5000000000000), bool(true), pk(USER), i64(at), u64(70000000000n), u64(500000000000000n), u64(realSol), u64(realToken),
  ...(full ? [pk(USER), u64(95), u64(9500000), pk(USER), u64(30), u64(3000000), bool(true), u64(0), u64(0), u64(1000000000), i64(T), str('buy'), bool(false), u64(0), u64(0), u64(0), u64(0),
    u32(2), pk(USER), u16(5000), pk(CURVE), u16(5000), pk(quote), u64(0), u64(0), u64(0), u64(0), u64(0), u64(0)] : [])]);
const completeEvent = (at = T + 120) => Buffer.concat([ps.DISC.complete, pk(USER), pk(MINT), pk(CURVE), i64(at), pk(SOL)]);
const migrateEvent = (at = T + 125) => Buffer.concat([ps.DISC.migrate, pk(USER), pk(MINT), u64(206900000000000n), u64(84990000000n), u64(15000000n), pk(CURVE), i64(at), pk(POOL), pk(SOL)]);

test('pump.fun\'s events, read with its IDL\'s layouts; later fields it adds don\'t matter', () => {
  const c = ps.decodeEvent(createEvent());
  assert.deepEqual([c.type, c.name, c.symbol, c.mint, c.bonding_curve, c.creator, c.timestamp, c.quote_mint], ['create', 'Bull Coin', 'BULL', MINT, CURVE, USER, T, SOL]);
  const t = ps.decodeEvent(tradeEvent());
  assert.deepEqual([t.type, t.mint, t.is_buy, t.real_token_reserves, t.real_sol_reserves, t.quote_mint], ['trade', MINT, true, 400000000000000n, 42000000000n, SOL], 'read past the shareholders list to quote_mint');
  assert.deepEqual([t.fee, t.creator, t.creator_fee], [9500000n, USER, 3000000n], 'pump.fun\'s fee, the coin\'s creator and the creator\'s fee (for the wallet rankings)');
  const older = ps.decodeEvent(tradeEvent({ full: false }));
  assert.deepEqual([older.real_token_reserves, older.quote_mint], [400000000000000n, undefined], 'a shorter event still gives the reserves; no quote means SOL');
  assert.deepEqual(Object.values(ps.decodeEvent(completeEvent())).slice(0, 4), ['complete', USER, MINT, CURVE]);
  const m = ps.decodeEvent(migrateEvent());
  assert.deepEqual([m.type, m.mint, m.pool, m.quote_mint], ['migrate', MINT, POOL, SOL]);
  assert.equal(ps.decodeEvent(Buffer.concat([Buffer.alloc(8, 7), Buffer.alloc(40)])), null, 'another event: skipped');
  assert.equal(ps.decodeEvent(createEvent().subarray(0, 30)), null, 'cut short: skipped, not guessed');
});

test('found as self-CPI events or as log lines; failed transactions and non-SOL curves left out', () => {
  const cpi = { failed: false, logs: [], instructions: [{ program: PUMP, data: Buffer.concat([ps.EVENT_TAG, createEvent()]) }, { program: USER, data: Buffer.concat([ps.EVENT_TAG, tradeEvent()]) }] };
  assert.deepEqual(ps.eventsOf(cpi).map(e => e.type), ['create'], 'only the pump.fun program\'s own events');
  const logs = { failed: false, instructions: [], logs: ['Program 6EF8… invoke [1]', `Program data: ${tradeEvent().toString('base64')}`] };
  assert.deepEqual(ps.eventsOf(logs).map(e => e.type), ['trade']);
  assert.deepEqual(ps.eventsOf({ ...cpi, failed: true }), []);

  const s = ps.emptyState();
  for (const e of [createEvent(), createEvent({ mint: MINT2, quote: USDC, symbol: 'USDCOIN' }), tradeEvent(), tradeEvent({ mint: MINT2, quote: USDC })].map(ps.decodeEvent)) ps.apply(e, T * 1000, s);
  assert.deepEqual([...s.creates.keys()], [MINT], 'a curve priced in USDC is left out, as in the polled feed');
  assert.deepEqual([...s.curves.keys()], [MINT]);
  ps.apply(ps.decodeEvent(completeEvent()), T * 1000, s);
  ps.apply(ps.decodeEvent(migrateEvent()), T * 1000, s);
  assert.equal(s.curves.size, 0, 'a completed curve isn\'t "nearest to graduating"');
  assert.deepEqual(s.graduated.get(MINT), { mint: MINT, pool: POOL, at: (T + 120) * 1000 }, 'graduated at completion, with its PumpSwap pool from the migration');
  ps.prune((T + 2 * 86400) * 1000, s);
  assert.deepEqual([s.creates.size, s.graduated.size], [0, 0], 'kept a day, then dropped');
});

test('the stream: off until set; through the client, into the feed while it\'s live; the admin panel says which', async t => {
  t.after(() => { ps.halt(); yellowstone._reset(); Object.assign(env, { yellowstoneGrpcUrl: '', yellowstoneGrpcToken: '' }); });
  // Not set: nothing connects, and the panel says the feed polls.
  assert.equal(yellowstone.configured(), false);
  assert.equal(await ps.start(), false);
  assert.match((await ps.health()).note, /aren't set: the Solana launch feed polls GeckoTerminal/);

  // A stand-in for the Yellowstone client.
  let opened = null;
  class Client {
    constructor(url, token, channel, reconnect) { opened = { url, token, reconnect }; }
    async connect() {}
    async subscribeWithReconnect(request) { opened.request = request; opened.stream = Object.assign(new EventEmitter(), { writes: [], write(r) { this.writes.push(r); }, end() {} }); return opened.stream; }
  }
  yellowstone._setClient(() => ({ default: Client, CommitmentLevel: { CONFIRMED: 1 } }));
  Object.assign(env, { yellowstoneGrpcUrl: 'https://yellowstone.example:443', yellowstoneGrpcToken: 'test-token' });
  assert.equal(await ps.start(), true);
  assert.deepEqual([opened.url, opened.token, opened.reconnect.policy], ['https://yellowstone.example:443', 'test-token', 'NoReplay']);
  assert.deepEqual(opened.request.transactions.pumpfun, { vote: false, failed: false, accountInclude: [PUMP], accountExclude: [], accountRequired: [] }, 'only pump.fun\'s transactions, filtered by the provider');
  assert.equal(opened.request.commitment, 1, 'confirmed');

  // A transaction as the client delivers it: pump.fun's events as self-CPI inner instructions.
  const key = a => Uint8Array.from(getAddressEncoder().encode(a));
  const tx = (...events) => {
    const message = { accountKeys: [key(USER), key(PUMP)], instructions: [{ programIdIndex: 1, data: new Uint8Array([1]) }] };
    const inner = events.map(e => ({ programIdIndex: 1, data: Uint8Array.from(Buffer.concat([ps.EVENT_TAG, e])) }));
    const meta = { err: undefined, logMessages: [], innerInstructions: [{ index: 0, instructions: inner }] };
    const info = { signature: new Uint8Array(64).fill(1), transaction: { message }, meta };
    return { type: 'Update', update: { transaction: { slot: '300000000', transaction: info } } };
  };
  // Events stamped now, so they count as the last hour's.
  const ts = Math.floor(Date.now() / 1000);
  opened.stream.emit('data', tx(createEvent({ at: ts }), tradeEvent({ at: ts })));
  opened.stream.emit('data', { type: 'Disconnected', partialBanks: [], replayFromSlot: null });
  assert.equal(yellowstone.status('pumpfun').live, true);
  assert.equal(yellowstone.status('pumpfun').reconnects, 1);
  assert.equal(ps._state().events, 2);

  // Written to the shared cache for the web role (every 2 seconds).
  await new Promise(r => setTimeout(r, 2300));
  const s = await ps.fresh();
  assert.ok(s, 'fresh while live');
  assert.equal(s.launches[0].symbol, 'BULL');
  assert.equal((await ps.health()).state, 'live');

  // The feed reads it: stand-ins for pump.fun's Global account and the mints.
  const rpc = require('../src/providers/rpc');
  const orig = rpc.solanaRpc;
  t.after(() => { rpc.solanaRpc = orig; });
  rpc.solanaRpc = async (method, params) => {
    if (method === 'getAccountInfo') { const b = Buffer.alloc(120); b.writeBigUInt64LE(793100000000000n, 89); b.writeBigUInt64LE(95n, 105); return { value: { owner: PUMP, data: [b.toString('base64'), 'base64'] } }; }
    if (method === 'getMultipleAccounts') return { value: params[0].map(() => ({ data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } })) };
    throw new Error(method);
  };
  const feed = await require('../src/services/solanaLaunches').view();
  assert.equal(feed.streamed, true);
  assert.deepEqual(feed.columns.new.items.map(i => [i.symbol, i.name, i.token, i.pool]), [['BULL', 'Bull Coin', MINT, CURVE]]);
  assert.equal(feed.columns.new.items[0].flags.flags[0].text, 'No mint or freeze authority left');
  assert.match(feed.columns.new.source, /streamed as the chain confirms them \(Yellowstone gRPC\)/);
  const near = feed.columns.graduating.items[0];
  assert.deepEqual([near.token, near.progress_pct, near.in_curve], [MINT, 49.5, 42], '(793.1M − 400M) of 793.1M sold; 42 SOL in the curve');

  // Graduated, then the stream goes quiet: the feed stops trusting it.
  opened.stream.emit('data', tx(completeEvent(ts), migrateEvent(ts)));
  await new Promise(r => setTimeout(r, 2300));
  const after = await require('../src/services/solanaLaunches').view();
  assert.deepEqual(after.columns.graduated.items.map(i => [i.symbol, i.pool]), [['BULL', POOL]]);
  assert.equal(after.columns.graduating.items.length, 0);
  const stale = { ...(await cache.get(ps.STATE_KEY)), written_at: new Date(Date.now() - 60000).toISOString() };
  await cache.set(ps.STATE_KEY, stale, 300);
  assert.equal(await ps.fresh(), null, 'over 30 seconds old: not used');
  assert.equal((await ps.health()).state, 'down');
});
