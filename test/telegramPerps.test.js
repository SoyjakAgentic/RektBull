/**
 * Hyperliquid perps from Telegram (telegram/perps.js), against Postgres
 * (TEST_DATABASE_URL), a stand-in Telegram that records what the bot sends,
 * and a stand-in Hyperliquid. Market data is the real answer recorded in
 * test/fixtures/hyperliquid.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
const agentKey = ethers.Wallet.createRandom();
Object.assign(process.env, {
  JWT_SECRET: 'test-secret', NEW_WALLET_CHECK_CHAINS: '', PUBLIC_URL: 'https://rektbull.test', DATABASE_URL: DB || '',
  HL_ENABLED: 'true', HL_NETWORK: 'testnet', HL_AUTO_ENABLED: 'true', HL_AGENT_ADDRESS: agentKey.address,
  HL_BUILDER_ADDRESS: '0x' + 'b1'.repeat(20), HL_BUILDER_FEE_TENTHS_BPS: '10',
  TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
});
require('../src/providers/llama').protocols = async () => [];
const hl = require('../src/providers/hyperliquid');
const env = require('../src/config/env');
const auto = require('../src/hyperliquid/auto');
const bot = require('../src/providers/telegramBot');

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hyperliquid', `${name}.json`), 'utf8'));
const wallet = ethers.Wallet.createRandom().address.toLowerCase();
const CHAT = '5550001';

test('perps from Telegram: switched on from the page, an open confirmed with a tap, its result sent back, closing always', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());
  require('../src/admin/settings').reset();
  const tg = require('../src/telegram/perps');
  const channels = require('../src/alerts/channels');

  // The stand-ins: what the bot sends, and Hyperliquid.
  const said = [];
  const buttons = [];
  bot.send = async (chat, text) => { said.push({ chat, text }); return { message_id: said.length }; };
  bot.buttons = async (chat, text, row) => { buttons.push({ chat, text, row }); return { message_id: 900 + buttons.length }; };
  bot.edit = async (chat, id, text) => { said.push({ chat, text, edited: id }); };
  bot.answer = async () => {};
  require('../src/alerts/transports').telegram.send = async (chat, m) => { said.push({ chat, text: m.text }); };
  const last = () => said.at(-1).text;
  const sent = [];
  let positions = [];
  hl._reset();
  hl.setTransport(async (p, body) => {
    if (p === '/exchange') {
      sent.push(body);
      if (body.action.type === 'order') return { status: 'ok', response: { type: 'order', data: { statuses: body.action.orders.map(o => (o.t.trigger ? { resting: { oid: 2 } } : { filled: { totalSz: '0.0015', avgPx: '65400', oid: 1 } })) } } };
      return { status: 'ok', response: { type: 'default' } };
    }
    return {
      metaAndAssetCtxs: fixture('metaAndAssetCtxs'),
      clearinghouseState: { marginSummary: { accountValue: '1000', totalMarginUsed: '0', totalNtlPos: '0' }, withdrawable: '1000', assetPositions: positions, time: Date.now() },
      frontendOpenOrders: [], extraAgents: [], maxBuilderFee: 10,
    }[body.type];
  });
  auto.setSignerForTests(agentKey);
  t.after(() => auto.setSignerForTests(null));

  // A webhook update for a private message, as Telegram sends it.
  const message = text => channels.telegramUpdate({ 'x-telegram-bot-api-secret-token': 'hook-secret' }, { message: { message_id: 1, chat: { id: Number(CHAT), type: 'private' }, from: { id: 1 }, text } });
  const tap = (data, chat = CHAT) => channels.telegramUpdate({ 'x-telegram-bot-api-secret-token': 'hook-secret' }, { callback_query: { id: 'q', data, message: { message_id: 901, chat: { id: Number(chat) } } } });

  const { rows: [acct] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [wallet]);
  const account = { id: acct.id, wallet };

  // Off until switched on from the page, with Telegram linked and automatic trading on.
  assert.deepEqual(await message('/perps'), { ok: true, perps: true });
  assert.match(last(), /Trading from Telegram is off for this chat/);
  await assert.rejects(tg.setEnabled(account, true), /Link Telegram first/);
  await db.query(`INSERT INTO alert_channels (account_id, kind, target, label, verified_at) VALUES ($1, 'telegram', $2, '@me', now())`, [acct.id, CHAT]);
  await assert.rejects(tg.setEnabled(account, true), /approve RektBull's agent/);
  const { rows: [g] } = await db.query(
    `INSERT INTO hl_auto_grants (id, account_id, wallet, agent_address, valid_until, max_trade_usd, max_day_usd, max_leverage, markets, country)
     VALUES (gen_random_uuid(), $1, $2, $3, now() + interval '20 days', 200, 500, 5, NULL, 'DE') RETURNING id`, [acct.id, wallet, env.hlAgentAddress]);
  const st = await tg.setEnabled(account, true);
  assert.deepEqual([st.linked, st.enabled], [true, true]);
  assert.match(st.risk, /could never withdraw or transfer/);

  // /perps: the grant and the positions, with their source.
  await message('/perps');
  assert.match(last(), /Automatic trading is on until .*at most \$200 a trade, \$500 opened in 24 hours \(\$0 used\), up to 5x, any deep market/);
  assert.match(last(), /No open positions/);

  // /long: checked, then a tap on Confirm. Coins are matched as Hyperliquid names them.
  await message('/long btc 100 3x sl 5');
  const ask = buttons.at(-1);
  assert.match(ask.text, /^Long BTC \$100 at 3x, stop-loss 5%\?/);
  assert.match(ask.text, /Fee: your own 0\.01%/);
  const [ok, cancel] = ask.row;
  assert.deepEqual([ok.text, cancel.text], ['Confirm', 'Cancel']);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM hl_auto_intents')).rows[0].n, 0, 'nothing queued before the tap');
  assert.deepEqual(await tap(ok.data, '999'), { ok: true, perps: true });
  assert.equal(last(), 'Already used.', 'another chat can\'t confirm it');
  await tap(ok.data);
  assert.match(last(), /^Queued: Long BTC \$100 at 3x, stop-loss 5%\. Sent within about 15 seconds/);
  await tap(ok.data);
  assert.equal(last(), 'Already used.', 'used once');
  const { rows: [intent] } = await db.query('SELECT * FROM hl_auto_intents');
  assert.deepEqual([intent.source, intent.side, intent.coin, Number(intent.size_usd), intent.leverage, Number(intent.stop_loss_pct), intent.notify_chat, intent.reason],
    ['user', 'long', 'BTC', 100, 3, 5, CHAT, 'From Telegram'], 'the user decided it: their own rate');
  // Sent by the trade service, with the user's own 0.01%; the result comes back to the chat.
  await auto.tick();
  const order = sent.find(s => s.action.type === 'order' && !s.action.orders[0].t.trigger);
  assert.deepEqual(order.action.builder, { b: env.hlBuilderAddress, f: 10 });
  assert.equal(last(), 'Done: Long BTC $100 at 3x, stop-loss 5%, $98.1 filled.');
  assert.equal(said.at(-1).chat, CHAT);

  // Cancel, and a confirmation that ran out.
  await message('/short ETH 50 2x');
  await tap(buttons.at(-1).row[1].data);
  assert.equal(last(), 'Cancelled: Short ETH $50 at 2x. Nothing was sent.');
  await message('/short ETH 50 2x');
  await db.query(`UPDATE telegram_pending SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`);
  await tap(buttons.at(-1).row[0].data);
  assert.match(last(), /ran out \(60 seconds\)/);

  // What's refused, and says why.
  await message('/long NOPE 10');
  assert.equal(last(), 'There\'s no NOPE market on Hyperliquid.');
  await message('/long BTC');
  assert.match(last(), /^Usage: \/long BTC 100 3x sl 5 tp 10/);
  await message('/long ATOM 20');
  assert.match(last(), /doesn't open positions in ATOM: open interest under/, 'thin markets: no automatic opens');
  await message('/long BTC 100 3x maybe');
  assert.match(last(), /didn't understand "maybe"/);
  // Over the limits: refused on Confirm by automatic trading's own checks.
  await message('/long BTC 300 2x');
  await tap(buttons.at(-1).row[0].data);
  assert.match(last(), /over your per-trade amount of \$200/);
  // Where the user was last seen on the site: a blocked place stops opens, not closes.
  await db.query(`UPDATE hl_auto_grants SET country = 'US' WHERE id = $1`, [g.id]);
  await message('/long BTC 20');
  assert.match(last(), /^Not opened: Hyperliquid perps trading isn't offered in US\. Open the Perps page on rektbull\.com from where you are now/);
  positions = [{ type: 'oneWay', position: { coin: 'BTC', szi: '0.0015', entryPx: '65400', positionValue: '98', unrealizedPnl: '1', liquidationPx: null, marginUsed: '33', leverage: { type: 'isolated', value: 3 }, maxLeverage: 40, cumFunding: { sinceOpen: '0' } } }];
  await message('/close btc');
  assert.match(last(), /^Closing BTC: sent within about 15 seconds/, 'a way out: no confirmation, no region check');
  const n = sent.length;
  await auto.tick();
  assert.equal(sent.at(-1).action.orders[0].r, true);
  assert.ok(sent.length > n);
  assert.match(last(), /^Done: Close BTC/);

  // /stopauto: RektBull stops using its agent at once, with no signature.
  await message('/stopauto');
  assert.match(last(), /^Stopped: RektBull no longer uses its agent for this account/);
  assert.equal((await db.query('SELECT status FROM hl_auto_grants WHERE id = $1', [g.id])).rows[0].status, 'revoked');

  // Switched off on the page: commands no longer trade. The rest of the bot is unchanged.
  await tg.setEnabled(account, false);
  await message('/perps');
  assert.match(last(), /Trading from Telegram is off/);
  await message('/help');
  assert.match(last(), /Hyperliquid perps: with automatic trading on and "Trade from Telegram" switched on/);

  // "Delete my data" removes the switch and any waiting confirmation.
  const myData = require('../src/privacy/myData');
  assert.deepEqual((await myData.exportAll({ id: acct.id })).telegram_trading.map(r => r.enabled), [false]);
});
