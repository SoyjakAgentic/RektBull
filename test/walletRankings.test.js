/**
 * Wallets ranked by realised profit (src/services/walletRankings.js): the
 * rules applied to pump.fun's trade events as the stream reads them, the day
 * sums written to the database, and the ranking with its exclusions.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, { DATABASE_URL: DB || '', JWT_SECRET: 'test-secret' });
const env = require('../src/config/env');
const wr = require('../src/services/walletRankings');

const SOL = 1_000_000_000n;
const T = 1795000000; // seconds
const A = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const DEV = '8sNW9oXSdyMZSHHRrRwnXGgS7WhW1gMTFSuUWhMkMvD5';
const mint = i => `Mint${String(i).padStart(40, '1')}`;
// A trade as pumpStream.decodeEvent gives it: sol_amount before fees; 1% to pump.fun and 0.3% to the creator.
const trade = (user, m, isBuy, solAmount, tokens, at = T + 100, creator = DEV) => ({
  type: 'trade', mint: m, user, is_buy: isBuy, sol_amount: BigInt(solAmount), token_amount: BigInt(tokens), timestamp: at,
  fee: BigInt(solAmount) / 100n, creator, creator_fee: BigInt(solAmount) * 3n / 1000n, quote_mint: 'So11111111111111111111111111111111111111112',
});
const day = d => d.days.get(`${A}|${new Date((T + 100) * 1000).toISOString().slice(0, 10)}`);

test('realised profit: what a sale brought less what that part cost, fees included; only what RektBull saw bought', () => {
  wr.reset();
  // Bought 1 SOL (plus 1.3% fees) of 1,000,000 tokens; sold half for 0.8 SOL, then the rest for 0.9 SOL.
  wr.onEvent(trade(A, mint(1), true, SOL, 1_000_000));
  wr.onEvent(trade(A, mint(1), false, 8n * SOL / 10n, 500_000));
  let s = wr._state();
  assert.equal(s.positions.size, 1, 'half sold: still open');
  assert.equal(day(s).coins, 0);
  wr.onEvent(trade(A, mint(1), false, 9n * SOL / 10n, 500_000));
  s = wr._state();
  assert.equal(s.positions.size, 0, 'all sold: closed');
  const d = day(s);
  const cost = 1.013e9;
  const proceeds = 0.8e9 * 0.987 + 0.9e9 * 0.987;
  assert.equal(Math.round(d.cost), cost);
  assert.equal(Math.round(d.realised), Math.round(proceeds - cost), 'about +0.665 SOL');
  assert.deepEqual([d.coins, d.wins, d.losses, d.snipes], [1, 1, 0, 0]);
  assert.equal(Math.round(d.best), Math.round(proceeds - cost));

  // A sale of coins RektBull never saw bought; more sold than was seen bought (only the part seen counts).
  wr.reset();
  wr.onEvent(trade(A, mint(2), false, SOL, 1_000_000));
  assert.equal(wr._state().days.size, 0, 'not counted');
  wr.onEvent(trade(A, mint(3), true, SOL, 1_000_000));
  wr.onEvent(trade(A, mint(3), false, 3n * SOL, 2_000_000)); // sells twice what it was seen buying
  const d2 = day(wr._state());
  assert.equal(Math.round(d2.realised), Math.round(1.5e9 * 0.987 - 1.013e9), 'half of the sale: the part seen bought');
  assert.equal(d2.losses, 0);
});

test('left out: a coin\'s creator, dust, snipes (counted apart), positions on a coin that left the curve, and old positions', () => {
  wr.reset();
  wr.onEvent(trade(DEV, mint(1), true, SOL, 1_000_000));
  wr.onEvent(trade(DEV, mint(1), false, 2n * SOL, 1_000_000));
  assert.equal(wr._state().days.size, 0, 'the creator trading their own coin');

  wr.onEvent(trade(A, mint(2), true, SOL / 100n, 1_000_000)); // 0.01 SOL: under 0.05
  assert.equal(wr._state().positions.size, 0, 'a position starting under 0.05 SOL');

  // A buy 1 second after the coin's creation: a snipe; its profit isn't counted, the snipe is.
  wr.onEvent({ type: 'create', mint: mint(3), timestamp: T + 99 });
  wr.onEvent(trade(A, mint(3), true, SOL, 1_000_000, T + 100));
  wr.onEvent(trade(A, mint(3), false, 5n * SOL, 1_000_000, T + 160));
  const d = day(wr._state());
  assert.deepEqual([d.coins, d.snipes, Math.round(d.realised)], [0, 1, 0]);

  // The coin left the curve: its open positions are dropped.
  wr.onEvent(trade(A, mint(4), true, SOL, 1_000_000));
  wr.onEvent({ type: 'complete', mint: mint(4), timestamp: T + 200 });
  assert.equal(wr._state().positions.has(`${A}:${mint(4)}`), false);

  // A position untouched for over 7 days is dropped (never realised).
  wr.onEvent(trade(A, mint(5), true, SOL, 1_000_000, T));
  wr.prune((T + 8 * 86400) * 1000);
  assert.equal(wr._state().positions.size, 0);

  // Curves priced in something other than SOL are left out.
  wr.onEvent({ ...trade(A, mint(6), true, SOL, 1_000_000), quote_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' });
  assert.equal(wr._state().positions.size, 0);
});

test('the rules are stated with the ranking', () => {
  const rules = wr.describe().join(' ');
  assert.match(rules, /Realised profit only/);
  assert.match(rules, /at least 5 coins closed/);
  assert.match(rules, /over 500 trades in a day \(bots\)/);
  assert.match(rules, /Past profit says nothing sure/);
});

test('the day sums are written each minute and the ranking applies the rules', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  require('../src/providers/prices').usdPrice = async () => 150;
  t.after(async () => { await db.getPool().end(); });
  const now = Math.floor(Date.now() / 1000);
  const wallets = { good: 'Good1111111111111111111111111111111111111111', few: 'Few11111111111111111111111111111111111111111', bot: 'Bot11111111111111111111111111111111111111111', sniper: 'Snipe111111111111111111111111111111111111111', loser: 'Lose1111111111111111111111111111111111111111' };
  // Each closes coins: good 6 wins of +0.5 SOL; few 3 wins of +5 SOL; loser 6 losses; sniper 1 counted win and 3 snipes.
  const round = (user, i, buy, sell, at = now) => { wr.onEvent(trade(user, mint(i), true, buy, 1_000_000, at)); wr.onEvent(trade(user, mint(i), false, sell, 1_000_000, at + 30)); };
  wr.reset();
  for (let i = 0; i < 6; i++) round(wallets.good, 100 + i, SOL, 3n * SOL / 2n);
  for (let i = 0; i < 3; i++) round(wallets.few, 200 + i, SOL, 6n * SOL);
  for (let i = 0; i < 6; i++) round(wallets.loser, 300 + i, SOL, SOL / 2n);
  for (let i = 0; i < 6; i++) round(wallets.bot, 400 + i, SOL, 4n * SOL);
  for (let i = 0; i < 600; i++) wr.onEvent(trade(wallets.bot, mint(999), true, 1, 1, now)); // 600 more trades today: a bot
  round(wallets.sniper, 500, SOL, 10n * SOL);
  for (let i = 0; i < 3; i++) { wr.onEvent({ type: 'create', mint: mint(510 + i), timestamp: now }); round(wallets.sniper, 510 + i, SOL, 20n * SOL); }
  assert.equal(await wr.flush(now * 1000), 5);
  // A second minute: the good wallet's sums add up.
  wr.onEvent(trade(wallets.good, mint(110), true, SOL, 1_000_000, now));
  wr.onEvent(trade(wallets.good, mint(110), false, 2n * SOL, 1_000_000, now + 30));
  await wr.flush(now * 1000);
  const { rows: [g] } = await db.query(`SELECT coins, wins, bot FROM wallet_pnl_daily WHERE wallet = $1`, [wallets.good]);
  assert.deepEqual(g, { coins: 7, wins: 7, bot: false });
  const { rows: [b] } = await db.query(`SELECT bot, trades FROM wallet_pnl_daily WHERE wallet = $1`, [wallets.bot]);
  assert.equal(b.bot, true);

  const top = await wr.top('7d');
  assert.deepEqual(top.wallets.map(w => w.wallet), [wallets.good], 'only the good wallet: few has 3 coins, the loser lost, the bot and the sniper are left out');
  const w = top.wallets[0];
  assert.equal(w.rank, 1);
  assert.equal(w.coins, 7);
  assert.equal(w.win_rate_pct, 100);
  assert.ok(w.realised_sol > 3 && w.realised_sol < 4.5, `${w.realised_sol}`);
  assert.equal(w.realised_usd, Math.round(w.realised_sol * 150));
  assert.match(top.source, /pump\.fun's bonding curves/);
  assert.equal(top.rules.length, wr.describe().length);

  // Over 35 days old: deleted by the retention job.
  await db.query(`INSERT INTO wallet_pnl_daily (chain, wallet, day, realised, coins) VALUES ('solana', 'Old', current_date - 40, 1, 1)`);
  await require('../src/privacy/retention').purge();
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM wallet_pnl_daily WHERE wallet = 'Old'`)).rows[0].n, 0);
  assert.equal(env.databaseUrl, DB);
});
