/**
 * The wallet tracker: buys and sells told apart from transfers in a block's
 * Transfer logs (no network), then, against a real Postgres, following
 * wallets within the free and Safety Pro limits, and one read of a chain with
 * every provider a stand-in: the trade recorded once, an alert for each
 * follower with its checks and a ready buy, and where the chain was read up to.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const T = n => '0x' + n.toString(16).padStart(40, '0');
const W = T(0xaa01), OTHER = T(0xbb02), POOL = T(0xcc03), ROUTER = T(0xdd04), MEME = T(0xee05), LP = T(0xee06), NFT = T(0xee07);
const WETH = '0x4200000000000000000000000000000000000006', USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const pad = a => '0x' + a.slice(2).padStart(64, '0');
let idx = 0;
const log = (tx, token, from, to, amount, block = 100) => ({ address: token, transactionHash: tx, logIndex: '0x' + (idx++).toString(16), blockNumber: '0x' + block.toString(16), topics: [TRANSFER, pad(from), pad(to)], data: ethers.toBeHex(amount, 32) });
const H = n => '0x' + n.toString(16).padStart(64, '0');

test('wallet tracker: buys and sells, not transfers, from Transfer logs', async () => {
  require('../src/config/env').databaseUrl = '';
  const { tradesIn } = require('../src/services/walletTracker');
  const ZERO = T(0), AAVE = T(0xa0a0), VAULT = T(0xa1a1), WITHDRAWAL = ethers.id('Withdrawal(address,uint256)');
  const txs = {
    [H(2)]: { from: W, to: ROUTER, value: '0x6f05b59d3b20000' }, // 0.5 ETH
    [H(3)]: { from: OTHER, to: MEME, value: '0x0' }, // someone sent it the token (a call to the token's own transfer)
    [H(4)]: { from: W, to: ROUTER, value: '0x0' }, // a claim
  };
  const receipts = {
    // Sold for ETH: the router unwrapped 0.3 WETH for it.
    [H(5)]: { from: W, to: ROUTER, logs: [{ address: WETH, topics: [WITHDRAWAL, pad(ROUTER)], data: ethers.toBeHex(3n * 10n ** 17n, 32) }] },
    [H(6)]: { from: W, to: MEME, logs: [] }, // the token's own transfer
    [H(11)]: { from: W, to: MEME, logs: [] },
    [H(12)]: { from: W, to: VAULT, logs: [] }, // a deposit into a contract: nothing came back
  };
  const asked = [];
  const txOf = async h => { asked.push(h); return txs[h] || null; };
  const receiptOf = async h => { asked.push(h); return receipts[h] || null; };
  const logs = [
    log(H(1), USDC, W, POOL, 100_000000n), log(H(1), MEME, POOL, W, 5000n * 10n ** 18n), // swap: USDC for MEME
    log(H(2), MEME, POOL, W, 7n), // bought with ETH
    log(H(3), MEME, OTHER, W, 9n), // sent to it by someone else
    log(H(4), MEME, ROUTER, W, 9n), // claimed, nothing paid
    log(H(5), MEME, W, POOL, 3n), // sold for ETH
    log(H(6), MEME, W, OTHER, 4n), // a plain transfer
    log(H(7), MEME, W, POOL, 8n), log(H(7), WETH, POOL, W, 2n * 10n ** 17n), // sold for WETH
    log(H(8), LP, W, LP, 1n), log(H(8), MEME, LP, W, 5n), log(H(8), WETH, LP, W, 5n), // liquidity removed
    log(H(9), USDC, W, POOL, 10n), log(H(9), WETH, POOL, W, 1n), // USDC to WETH: nothing traded
    { ...log(H(10), NFT, POOL, W, 0n), topics: [TRANSFER, pad(POOL), pad(W), pad(T(1))], data: '0x' }, // an NFT
    log(H(11), MEME, W, OTHER, 4n), // W sends to OTHER, both followed: neither a sale nor a buy
    log(H(12), MEME, W, VAULT, 6n), // deposited, nothing back
    log(H(13), T(0xde01), W, ZERO, 50n), log(H(13), MEME, W, AAVE, 50n), // a loan repaid: its debt token burnt
    log(H(14), MEME, W, VAULT, 10n), log(H(14), T(0xde02), ZERO, W, 10n), // vault shares minted for it
  ];
  const got = await tradesIn('base', logs, new Set([W, OTHER]), txOf, receiptOf);
  const brief = got.map(t => [t.tx, t.wallet, t.side, t.token, t.amount, t.other.native ? `native:${t.other.amount}` : `${t.other.token}:${t.other.amount}`]);
  assert.deepEqual(brief, [
    [H(1), W, 'buy', MEME, 5000n * 10n ** 18n, `${USDC}:100000000`],
    [H(2), W, 'buy', MEME, 7n, 'native:500000000000000000'],
    [H(5), W, 'sell', MEME, 3n, 'native:300000000000000000'],
    [H(7), W, 'sell', MEME, 8n, `${WETH}:200000000000000000`],
  ]);

  // four.meme: a curve sale pays BNB out from its own contract, with no WBNB unwrapped.
  const bsc = await tradesIn('bsc', [log(H(20), MEME, W, '0x5c952063c7fc8610ffdb798152d69f0b9550762b', 9n)], new Set([W]), txOf,
    async () => ({ from: W, to: '0x5c952063c7fc8610ffdb798152d69f0b9550762b', logs: [{ address: '0x5c952063c7fc8610ffdb798152d69f0b9550762b', topics: [ethers.id('x')], data: '0x' }] }));
  assert.deepEqual(bsc.map(t => [t.side, t.other.native, t.other.amount]), [['sell', true, null]]);
  assert.ok(!asked.includes(H(1)) && !asked.includes(H(7)), 'a swap seen in the logs needs no extra call');
});

const DB = process.env.TEST_DATABASE_URL;
test('wallet tracker: follow, read a chain, alert each follower once', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test-secret', PUBLIC_URL: 'https://rektbull.test' });
  for (const k of Object.keys(require.cache)) if (k.includes('/src/')) delete require.cache[k];
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());

  const wt = require('../src/services/walletTracker');
  const passes = require('../src/payments/passes');
  const { rows: [a] } = await db.query(`INSERT INTO accounts (wallet) VALUES ('0x${'ab'.repeat(20)}') RETURNING id`);
  const { rows: [b] } = await db.query(`INSERT INTO accounts (wallet) VALUES ('0x${'cd'.repeat(20)}') RETURNING id`);
  const { rows: [c] } = await db.query(`INSERT INTO accounts (wallet) VALUES ('0x${'ef'.repeat(20)}') RETURNING id`);

  // Following: addresses checked, Solana recognised but not yet followed, 5 free, 25 with Safety Pro.
  await assert.rejects(wt.follow(a.id, { address: 'nope' }), /isn't a wallet address/);
  await assert.rejects(wt.follow(a.id, { address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' }), /Solana trading, which isn't here yet/);
  let l = await wt.follow(a.id, { address: W.toUpperCase().replace('0X', '0x'), label: 'Smart money' });
  assert.deepEqual(l.wallets.map(w => [w.address, w.label]), [[W, 'Smart money']]);
  for (let i = 1; i < 5; i++) await wt.follow(a.id, { address: T(0x5000 + i) });
  await wt.follow(a.id, { address: W }); // following again: no new row, the name kept
  assert.equal((await wt.list(a.id)).wallets.length, 5);
  await assert.rejects(wt.follow(a.id, { address: T(0x6000) }), err => err.status === 402 && err.offer === 'pro_30d' && /up to 5 wallets for free, and 25 with Safety Pro/.test(err.message));
  const realCovering = passes.covering;
  passes.covering = async id => (id === a.id ? { ends_at: new Date(Date.now() + 86400000) } : null);
  l = await wt.follow(a.id, { address: T(0x6000) });
  assert.deepEqual([l.wallets.length, l.limit, l.safety_pro], [6, 25, true]);
  passes.covering = realCovering;
  l = await wt.unfollow(a.id, l.wallets.find(w => w.address === T(0x6000)).id);
  assert.equal(l.wallets.length, 5);
  await assert.rejects(wt.unfollow(b.id, l.wallets[0].id), /not found/, 'only your own');
  await wt.follow(b.id, { address: W });
  await wt.follow(c.id, { address: W });
  await db.query(`INSERT INTO agent_settings (account_id, agent, enabled) VALUES ($1, 'wallet_tracker', false)`, [c.id]); // c switched its alerts off

  // The providers, as stand-ins.
  const rpc = require('../src/providers/rpc');
  const realRpc = rpc.evmRpc, realLogs = rpc.evmTopicLogs;
  let head = 1000;
  const logsAsked = [];
  let blockLogs = [];
  const ERC20 = new ethers.Interface(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
  rpc.evmRpc = async (chain, method, params) => {
    if (method === 'eth_blockNumber') return '0x' + (chain === 'base' ? head : 50).toString(16);
    if (method === 'eth_getTransactionByHash') return { from: W, to: ROUTER, value: '0x6f05b59d3b20000' };
    if (method === 'eth_getTransactionReceipt') return { from: W, to: ROUTER, logs: [] };
    if (method === 'eth_getBlockByNumber') return { timestamp: '0x' + (Number(params[0]) * 2).toString(16) }; // a block every 2 seconds
    if (method === 'eth_call') {
      const sel = params[0].data.slice(0, 10);
      if (sel === ERC20.getFunction('symbol').selector) return ERC20.encodeFunctionResult('symbol', [params[0].to === MEME ? 'MEME' : 'X']);
      return ERC20.encodeFunctionResult('decimals', [18]);
    }
    throw new Error(`unexpected ${method}`);
  };
  rpc.evmTopicLogs = async (chain, filter) => {
    logsAsked.push({ chain, from: Number(filter.fromBlock), to: Number(filter.toBlock), wallets: filter.topics[1] || filter.topics[2] });
    if (chain !== 'base') return [];
    const dir = filter.topics[1] ? 1 : 2;
    return blockLogs.filter(x => filter.topics[dir].includes(x.topics[dir]));
  };
  require('../src/providers/prices').usdPrices = async ids => Object.fromEntries(ids.filter(id => id.endsWith(WETH)).map(id => [id, 3000]));
  require('../src/services/tokenRisk').scanToken = async () => ({ verdict: 'high', flags: [{ severity: 'high', title: 'Its owner can change the tax', source: 'Verified source on Basescan' }] });
  require('../src/services/launches').forTrade = async () => ({ young: true, risk: 'ok', detail: 'no bundle found among the first buyers' });
  t.after(() => { rpc.evmRpc = realRpc; rpc.evmTopicLogs = realLogs; });

  // The first read starts at the newest block; nothing there yet.
  let r = await wt.tick();
  assert.deepEqual(r.find(x => x.chain === 'base'), { chain: 'base', blocks: 1, trades: 0 });
  assert.equal(new Set(logsAsked[0].wallets).size, 5, 'every followed wallet with alerts on, in one call (c\'s is the same as a\'s)');

  // Two blocks later W buys MEME with ETH.
  head = 1002;
  blockLogs = [log(H(42), MEME, POOL, W, 1234567n * 10n ** 18n, 1002)];
  logsAsked.length = 0;
  r = await wt.tick();
  assert.deepEqual(r.find(x => x.chain === 'base'), { chain: 'base', blocks: 2, trades: 1 });
  assert.deepEqual([logsAsked[0].from, logsAsked[0].to], [1001, 1002], 'only the blocks since the last read');
  const { rows: trades } = await db.query('SELECT * FROM wallet_trades');
  assert.equal(trades.length, 1);
  assert.deepEqual([trades[0].side, trades[0].token, trades[0].symbol, Number(trades[0].amount), Number(trades[0].usd)], ['buy', MEME, 'MEME', 1234567, 1500]);

  const { rows: alerts } = await db.query('SELECT * FROM monitor_alerts ORDER BY account_id');
  assert.deepEqual(alerts.map(x => String(x.account_id)), [String(a.id), String(b.id)], 'one for each follower with alerts on; none for c');
  const al = alerts[0];
  assert.equal(al.kind, 'wallet_trade');
  assert.equal(al.title, 'Smart money bought MEME on Base');
  assert.equal(al.severity, 'medium');
  assert.equal(al.detail.link, `/trade?chain=base&token=${MEME}&side=buy#trade-card`);
  assert.equal(al.detail.tx_url, `https://basescan.org/tx/${H(42)}`);
  assert.deepEqual(al.detail.reasons.map(x => x.text), [
    'Smart money bought 1.23M MEME for 0.5 ETH (about $1,500)',
    'RektBull\'s token check: high. Its owner can change the tax',
    'Bundle check (a token under a week old): no bundle found among the first buyers',
  ]);
  assert.match(al.detail.reasons[0].source, /read from the chain/);
  assert.equal(alerts[1].title, `${W.slice(0, 6)}…${W.slice(-4)} bought MEME on Base`, 'b gave it no name');

  const m = require('../src/alerts/format').message(al);
  assert.equal(m.subject, 'RektBull: Smart money bought MEME on Base');
  assert.equal(m.action, 'Review the buy');
  assert.equal(m.url, `https://rektbull.test/trade?chain=base&token=${MEME}&side=buy#trade-card`);

  // Read again over the same block: nothing new, no second alert.
  await db.query(`UPDATE wallet_tracker_cursors SET block = 1001 WHERE chain = 'base'`);
  await wt.tick();
  assert.equal((await db.query('SELECT count(*)::int AS n FROM monitor_alerts')).rows[0].n, 2);

  // A sale for USDC: a swap in the logs, no checks, the token page offered.
  head = 1004;
  blockLogs = [log(H(43), MEME, W, POOL, 1000n * 10n ** 18n, 1004), log(H(43), USDC, POOL, W, 250_000000n, 1004)];
  await wt.tick();
  const { rows: [sale] } = await db.query(`SELECT * FROM monitor_alerts WHERE account_id = $1 AND detail->>'side' = 'sell'`, [a.id]);
  assert.equal(sale.title, 'Smart money sold MEME on Base');
  assert.deepEqual(sale.detail.reasons.map(x => x.text), ['Smart money sold 1,000 MEME for 250 USDC']);
  assert.equal(sale.detail.link, `/token?chain=base&token=${MEME}`);
  assert.equal(require('../src/alerts/format').message(sale).action, 'See the token');

  // The page's list: the trade, with its links.
  l = await wt.list(a.id);
  assert.deepEqual(l.trades.map(x => [x.side, Number(x.amount)]), [['sell', 1000], ['buy', 1234567]], 'newest first');
  assert.deepEqual([l.trades[1].label, l.trades[1].buy, l.trades[1].page], ['Smart money', `/trade?chain=base&token=${MEME}&side=buy#trade-card`, `/token?chain=base&token=${MEME}`]);
  assert.deepEqual(l.trades[0].other, { token: USDC, symbol: 'USDC', amount: 250 });
  assert.equal((await wt.list(c.id)).alerts_on, false);

  // Far behind (the worker was down): starts again from the newest block instead of alerting old trades.
  head = 1004 + 60 + 50; // two minutes at a block every 2 seconds is 60 blocks
  logsAsked.length = 0;
  await wt.tick();
  assert.deepEqual([logsAsked[0].from, logsAsked[0].to], [head, head]);

  // The agent's card: set up, and its schedule.
  const card = (await require('../src/services/myAgents').list(a.id)).agents.find(x => x.id === 'wallet_tracker');
  assert.deepEqual([card.enabled, card.status.state, card.schedule], [true, 'on', 'Within seconds of each trade']);
  const none = (await require('../src/services/myAgents').list((await db.query(`INSERT INTO accounts (wallet) VALUES ('0x${'12'.repeat(20)}') RETURNING id`)).rows[0].id)).agents.find(x => x.id === 'wallet_tracker');
  assert.equal(none.status.state, 'needs_setup');

  // Your data: what you follow is in the export, and deleted with the rest.
  const myData = require('../src/privacy/myData');
  assert.deepEqual((await myData.exportAll({ id: b.id })).followed_wallets.map(w => w.address), [W]);
  const gone = await myData.deleteMine({ id: b.id }, { confirm: 'DELETE' });
  assert.equal(gone.removed.followed_wallets, 1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM followed_wallets WHERE account_id = $1', [b.id])).rows[0].n, 0);
});
