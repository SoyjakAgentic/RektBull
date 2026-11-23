/**
 * The Wallet Tracker on Solana (src/services/solanaTracker.js): trades read
 * from a transaction's own balances before and after; followed wallets on the
 * one Yellowstone subscription, ahead of Meme Watch's insiders; each trade
 * recorded once and alerted to its followers like the EVM tracker's. The
 * Yellowstone client, DexScreener and prices are stand-ins.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { getAddressEncoder } = require('@solana/kit');

const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, { DATABASE_URL: DB || '', JWT_SECRET: 'test-secret' });
const env = require('../src/config/env');
const yellowstone = require('../src/providers/yellowstone');
const st = require('../src/services/solanaTracker');

const W = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const OTHER = '8sNW9oXSdyMZSHHRrRwnXGgS7WhW1gMTFSuUWhMkMvD5';
const TOKEN = 'Ce9JBbxPQx2cAJjhFi9NEkmqGJGTVFBTHmYSGFTwpump';
const TOKEN2 = 'Cx3BiUwpVNYTN8QWFQXSBqHG2yKzYWg2PczbvYeDpump';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const SOL = 1000000000n;
const bal = (owner, mint, pre, post, decimals = 6) => ({ owner, mint, pre: BigInt(pre), post: BigInt(post), decimals });
// A transaction W signed and paid the fee for (5,000 lamports), with its SOL balance going from pre to post.
const tx = ({ balances = [], pre = 5n * SOL, post = 5n * SOL, keys = [W], failed = false } = {}) => ({
  signature: 'sig', slot: '1', failed, keys, signers: [keys[0]], fee: 5000n, balances,
  lamports: keys.map((address, i) => (i === 0 ? { address, pre, post } : { address, pre: 0n, post: 0n })),
});
const watched = new Set([W]);
const one = t => st.tradesIn(t, watched).map(x => [x.side, x.token, Number(x.amount_raw) / 10 ** x.decimals, x.other.symbol, Math.round(x.other.amount * 1e6) / 1e6]);

test('trades from a transaction\'s own balances: a buy, a sale, and what isn\'t a trade', () => {
  // Paid about 1 SOL (including a new token account's rent) for 1,000 TOKEN; the 5,000-lamport fee is added back.
  assert.deepEqual(one(tx({ post: 5n * SOL - 1002045000n, balances: [bal(W, TOKEN, 0, 1000000000)] })), [['buy', TOKEN, 1000, 'SOL', 1.00204]]);
  // Sold 500 TOKEN for 0.6 SOL.
  assert.deepEqual(one(tx({ post: 5n * SOL + 600000000n - 5000n, balances: [bal(W, TOKEN, 1000000000, 500000000)] })), [['sell', TOKEN, 500, 'SOL', 0.6]]);
  // Paid in USDC, or in wrapped SOL (Jupiter's way, its account closed for a rent refund).
  assert.deepEqual(one(tx({ balances: [bal(W, TOKEN, 0, 1000000), bal(W, USDC, 80000000, 30000000)] })), [['buy', TOKEN, 1, 'USDC', 50]]);
  assert.deepEqual(one(tx({ post: 5n * SOL + 2039280n - 5000n, balances: [bal(W, TOKEN, 0, 1000000), bal(W, WSOL, 1000000000, 0, 9)] })), [['buy', TOKEN, 1, 'SOL', 0.997961]]);
  // One token for another: a buy of what came in and a sale of what went out.
  assert.deepEqual(one(tx({ post: 5n * SOL - 5000n, balances: [bal(W, TOKEN, 7000000, 0), bal(W, TOKEN2, 0, 3000000)] })).map(x => x.slice(0, 3)), [['buy', TOKEN2, 3], ['sell', TOKEN, 7]]);
  // Not trades: an airdrop (only in), a transfer (only out), the fee alone, a failed transaction, someone else.
  assert.deepEqual(one(tx({ keys: [OTHER, W], balances: [bal(W, TOKEN, 0, 1000000)] })), [], 'an airdrop');
  assert.deepEqual(one(tx({ post: 5n * SOL - 5000n, balances: [bal(W, TOKEN, 1000000, 0)] })), [], 'a transfer out, paying only the fee');
  assert.deepEqual(one(tx({ post: 5n * SOL - 5000n })), []);
  assert.deepEqual(one(tx({ failed: true, post: 4n * SOL, balances: [bal(W, TOKEN, 0, 1000000)] })), []);
  assert.deepEqual(st.tradesIn(tx({ post: 4n * SOL, balances: [bal(W, TOKEN, 0, 1000000)] }), new Set([OTHER])), []);
});

test('the stream\'s transactions carry SOL balances, the signers, the fee and each token\'s decimals', () => {
  const key = a => Uint8Array.from(getAddressEncoder().encode(a));
  const tb = (owner, amount) => ({ accountIndex: 1, mint: TOKEN, owner, uiTokenAmount: { amount: String(amount), decimals: 6 } });
  const r = yellowstone.readTransaction({ slot: '5', transaction: {
    signature: new Uint8Array(64).fill(2),
    transaction: { message: { header: { numRequiredSignatures: 1 }, accountKeys: [key(W), key(OTHER)], instructions: [] } },
    meta: { fee: '5000', preBalances: ['5000000000', '0'], postBalances: ['3997955000', '0'], preTokenBalances: [], postTokenBalances: [tb(W, 1000000000)], logMessages: [], innerInstructions: [] },
  } });
  assert.deepEqual(r.signers, [W]);
  assert.equal(r.fee, 5000n);
  assert.deepEqual(r.lamports[0], { address: W, pre: 5000000000n, post: 3997955000n });
  assert.deepEqual(r.balances, [{ owner: W, mint: TOKEN, pre: 0n, post: 1000000000n, decimals: 6 }]);
});

test('following Solana wallets: only with the stream; their trades alerted to followers within seconds', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  const ps = require('../src/services/pumpStream');
  const wt = require('../src/services/walletTracker');
  t.after(async () => { ps.halt(); yellowstone._reset(); Object.assign(env, { yellowstoneGrpcUrl: '', yellowstoneGrpcToken: '' }); await db.getPool().end(); });
  const { rows: [{ id: acct }] } = await db.query(`INSERT INTO accounts (wallet) VALUES ('0x${'ab'.repeat(20)}') RETURNING id`);

  // Without the stream: refused, saying why.
  await assert.rejects(wt.follow(acct, { address: W }), err => err.status === 503 && /needs RektBull's Solana stream/.test(err.message));
  Object.assign(env, { yellowstoneGrpcUrl: 'https://yellowstone.example:443', yellowstoneGrpcToken: 'test-token' });
  const listed = await wt.follow(acct, { address: W, label: 'whale' });
  assert.deepEqual(listed.wallets.map(w => [w.address, w.family, w.label]), [[W, 'solana', 'whale']]);
  assert.ok(listed.chains.includes('Solana'));

  // Stand-ins: the token's symbol (DexScreener), SOL's price, and the checks a buy alert carries.
  require('../src/providers/dexscreener').pairs = async (chain, mints) => Object.fromEntries(mints.filter(m => m === TOKEN).map(m => [m, { symbol: 'BULL', name: 'Bull' }]));
  require('../src/providers/prices').usdPrice = async () => 150;
  const checked = [];
  wt.checksFor = async (chain, token) => { checked.push([chain, token]); return { verdict: 'ok', bundle: 'ok', reasons: [{ text: 'RektBull\'s token check: ok', source: 'test' }] }; };

  // The stream: pump.fun, then the followed wallet's filter.
  let opened = null;
  class Client {
    async connect() {}
    async subscribeWithReconnect(request) { opened = { request, stream: Object.assign(new EventEmitter(), { writes: [], write(r) { this.writes.push(JSON.parse(JSON.stringify(r))); }, end() {} }) }; return opened.stream; }
  }
  yellowstone._setClient(() => ({ default: Client, CommitmentLevel: { CONFIRMED: 1 } }));
  assert.equal(await ps.start(), true);
  const until = async fn => { for (let i = 0; i < 100 && !(await fn()); i++) await new Promise(r => setTimeout(r, 30)); };
  await until(() => opened.stream.writes.some(w => w.transactions['follow-0']));
  const sent = opened.stream.writes.find(w => w.transactions['follow-0']);
  assert.deepEqual(Object.keys(sent.transactions), ['pumpfun', 'follow-0']);
  assert.deepEqual(sent.transactions['follow-0'].accountInclude, [W]);

  // W buys 1,000 BULL for about 1 SOL.
  const key = a => Uint8Array.from(getAddressEncoder().encode(a));
  const tb = (owner, amount) => ({ accountIndex: 1, mint: TOKEN, owner, uiTokenAmount: { amount: String(amount), decimals: 6 } });
  const buy = sig => ({ type: 'Update', update: { filters: ['follow-0'], transaction: { slot: '300000002', transaction: {
    signature: new Uint8Array(64).fill(sig), transaction: { message: { header: { numRequiredSignatures: 1 }, accountKeys: [key(W), key(TOKEN)], instructions: [] } },
    meta: { err: undefined, fee: '5000', preBalances: ['5000000000', '0'], postBalances: ['3997955000', '0'], preTokenBalances: [], postTokenBalances: [tb(W, 1000000000)], logMessages: [], innerInstructions: [] },
  } } } });
  opened.stream.emit('data', buy(9));
  opened.stream.emit('data', buy(9)); // a reconnect's resend
  await until(async () => (await db.query('SELECT count(*)::int AS n FROM monitor_alerts')).rows[0].n >= 1);
  await st._drain();
  const { rows: trades } = await db.query('SELECT chain, wallet, side, token, symbol, amount::float8, other, usd::float8 FROM wallet_trades');
  assert.deepEqual(trades.map(x => [x.chain, x.wallet, x.side, x.token, x.symbol, x.amount, x.other.symbol, x.usd]), [['solana', W, 'buy', TOKEN, 'BULL', 1000, 'SOL', 150.31]], 'recorded once');
  const { rows: alerts } = await db.query('SELECT kind, severity, title, detail FROM monitor_alerts');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].title, 'whale bought BULL on Solana');
  assert.match(alerts[0].detail.reasons[0].text, /^whale bought 1,000 BULL for 1\.002 SOL \(about \$150\.31\)$/);
  assert.match(alerts[0].detail.reasons[0].source, /on Solana, read from the chain \(its balances before and after\)/);
  assert.equal(alerts[0].detail.link, `/trade?chain=solana&token=${TOKEN}&side=buy#trade-card`);
  assert.match(alerts[0].detail.tx_url, /^https:\/\/solscan\.io\/tx\//);
  assert.deepEqual(checked, [['solana', TOKEN]], 'the token check runs before the alert');
  const mine = await wt.list(acct);
  assert.deepEqual(mine.trades.map(x => [x.chain_name, x.side, x.symbol]), [['Solana', 'buy', 'BULL']]);
});
