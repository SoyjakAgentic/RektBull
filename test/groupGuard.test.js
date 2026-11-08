/**
 * Group Guard against a real Postgres, through Telegram's webhook, with the
 * Telegram API and GoPlus as stand-ins: the bot added to a group, settings
 * by admins only, a phishing link removed (or flagged when it may not
 * delete), a look-alike of the official site, a fake contract, a honeypot on
 * the group's chain, impersonators on joining and posting, /check, admins
 * never checked, switched off, daily reply limits, and no message text kept.
 * Runs only when TEST_DATABASE_URL is set.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;

test('Group Guard: links, contracts, impersonators, commands and limits', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test-secret', PUBLIC_URL: 'https://rektbull.test', NEW_WALLET_CHECK_CHAINS: '', TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_BOT_USERNAME: 'RektBullBot', TELEGRAM_WEBHOOK_SECRET: 'hook-secret' });
  for (const k of Object.keys(require.cache)) if (k.includes('/src/')) delete require.cache[k];
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());

  const tg = require('../src/providers/telegramBot');
  const said = [], deleted = [];
  let mayDelete = true;
  const ADMINS = [{ user: { id: 1, first_name: 'Alice', last_name: 'Bull', username: 'alicebull' } }, { user: { id: 99, first_name: 'RektBull', is_bot: true } }];
  tg.reply = async (chat, replyTo, text) => { said.push({ chat, replyTo, text }); };
  tg.deleteMessage = async (chat, id) => { if (!mayDelete) throw new Error('not enough rights'); deleted.push({ chat, id }); };
  tg.admins = async () => ADMINS;
  require('../src/providers/goplus').phishingSite = async url => ({ source: 'GoPlus phishing site list', phishing: url === 'https://claim-uniswap.top' });
  const goplusAsked = [];
  require('../src/services/tokenRisk').goplus = async (chain, token) => { goplusAsked.push(`${chain}:${token}`); return token === '0x' + 'de'.repeat(20) ? { source: 'GoPlus', honeypot: true, sell_tax_pct: 0 } : { source: 'GoPlus', honeypot: false, buy_tax_pct: 1, sell_tax_pct: 1 }; };
  const guard = require('../src/services/groupGuard');

  const server = require('../src/app').createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const hook = async (update, secret = 'hook-secret') => {
    const r = await fetch(base + '/v1/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(update) });
    return r.status;
  };
  const CHAT = { id: -1001, type: 'supergroup', title: 'Bull Project' };
  let mid = 0;
  const post = (from, text, extra = {}) => hook({ message: { message_id: ++mid, chat: CHAT, from, text, ...extra } });
  const ALICE = { id: 1, first_name: 'Alice', last_name: 'Bull', username: 'alicebull' };
  const BOB = { id: 2, first_name: 'Bob' };
  const last = () => said[said.length - 1];

  /* ── added to the group ── */
  assert.equal(await hook({ my_chat_member: { chat: CHAT, from: ALICE, old_chat_member: { status: 'left' }, new_chat_member: { status: 'administrator', user: { id: 99 } } } }), 200);
  assert.match(last().text, /^RektBull Group Guard is here\..*Delete messages.*\/official_site example\.com.*I never DM anyone first\.\n\nChecked by RektBull · rektbull\.com$/s);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM guard_groups WHERE removed_at IS NULL')).rows[0].n, 1);
  assert.equal(await hook({ my_chat_member: { chat: CHAT } }, 'wrong'), 403, 'the webhook still needs its secret');

  /* ── settings: admins only ── */
  await post(BOB, '/official_site bullproject.io');
  assert.equal(last().text.split('\n')[0], 'Only this group\'s admins can change Group Guard\'s settings.');
  await post(ALICE, '/official_site https://www.bullproject.io/app');
  await post(ALICE, '/official_contract base 0x' + 'B0'.repeat(20));
  assert.match(last().text, /Official sites: bullproject\.io\.\nOfficial contracts: 0x(b0){20} \(base\)\.\nPosted tokens checked on: base\./);
  await post(ALICE, '/official_contract tron 0x12');
  assert.match(last().text, /^Use \/official_contract <chain> <address>/);

  /* ── a phishing link: removed, with the source ── */
  said.length = 0;
  await post(BOB, 'airdrop is live!! claim-uniswap.top/claim', { entities: [] });
  assert.deepEqual(deleted.map(d => d.id), [mid]);
  assert.match(last().text, /^⚠️ Removed a message with a link to claim-uniswap\.top, which GoPlus lists as a phishing site \(source: GoPlus phishing site list\)\./);
  assert.equal(last().replyTo, null, 'the message is gone, so no reply to it');
  mayDelete = false;
  await post(BOB, 'again', { entities: [{ type: 'text_link', offset: 0, length: 5, url: 'https://claim-uniswap.top' }] });
  assert.match(last().text, /^⚠️ This message has a link to claim-uniswap\.top.*Admins: give me the "Delete messages" right/s);
  assert.equal(last().replyTo, mid);
  mayDelete = true;

  /* ── a look-alike of the official site; the official one and other sites pass ── */
  said.length = 0;
  await post(BOB, 'new site https://bullproject-airdrop.xyz and docs at app.bullproject.io and github.com/x');
  assert.equal(said.length, 1);
  assert.match(said[0].text, /^⚠️ bullproject-airdrop\.xyz looks like bullproject\.io, this group's official site, but isn't it\./);
  said.length = 0;
  await post(BOB, 'see e.g. token.address for details');
  assert.equal(said.length, 0, 'words with dots aren\'t links');

  /* ── a fake contract; the official one passes; a honeypot on the group's chain ── */
  await post(BOB, 'CA: 0x' + 'b0'.repeat(20));
  assert.equal(said.length, 0, 'the official contract');
  await post(BOB, 'real CA is 0x' + 'cc'.repeat(20) + ' buy now');
  assert.match(last().text, /^⚠️ This isn't the official contract\. The official one, set by the group's admins: 0x(b0){20} \(base\)\./);
  said.length = 0;
  await post(BOB, 'check out 0x' + 'de'.repeat(20) + ' 🚀'); // no contract words: checked on the group's chains
  assert.match(last().text, /^⚠️ The token 0x(de){20} on base: GoPlus reports it as a honeypot: it can be bought but not sold \(source: GoPlus\)\. Full check: https:\/\/rektbull\.com\/safety\?chain=base&token=0x(de){20}/);

  /* ── impersonators: on joining, and when posting; once a day each ── */
  said.length = 0;
  const FAKE = { id: 3, first_name: 'A1ice', last_name: 'BuII' };
  await hook({ chat_member: { chat: CHAT, from: FAKE, old_chat_member: { status: 'left', user: FAKE }, new_chat_member: { status: 'member', user: FAKE } } });
  assert.match(last().text, /^⚠️ "A1ice BuII" isn't an admin of this group, but their name looks like admin Alice Bull's\. Admins and support never DM you first\./);
  await post(FAKE, 'hi, DM me for help');
  assert.equal(said.length, 1, 'flagged once a day');
  await post({ id: 4, first_name: 'Support', last_name: 'Team', username: 'bullproject_help' }, 'need help? message me');
  assert.match(last().text, /^⚠️ @bullproject_help isn't an admin of this group, but their name says "support"\./);

  /* ── admins aren't checked; /check for anyone ── */
  said.length = 0;
  await post(ALICE, 'never click claim-uniswap.top, it is a scam');
  assert.equal(said.length, 0);
  assert.equal(deleted.length, 1, 'an admin\'s message is never deleted');
  await post(BOB, '/check base 0x' + 'aa'.repeat(20));
  assert.match(last().text, /^0x(aa){20} on base: no honeypot, sell-limit or balance-changing flags \(source: GoPlus\)\. Taxes: 1% to buy, 1% to sell\. A clean result isn't proof of safety\./);
  await post(BOB, '/check solana abc');
  assert.match(last().text, /^Use \/check <chain> <address>/);

  /* ── switched off: silent; on again ── */
  await post(ALICE, '/guard_off');
  said.length = 0;
  await post(BOB, 'claim-uniswap.top');
  assert.equal(said.length, 0);
  await post(ALICE, '/guard_on');

  /* ── limits, counts, and no message text kept ── */
  const { rows } = await db.query(`SELECT kind, n FROM guard_counts WHERE chat_id = '-1001' ORDER BY kind`);
  const counts = Object.fromEntries(rows.map(r => [r.kind, r.n]));
  assert.equal(counts.phishing_removed, 2);
  assert.equal(counts.lookalike_warned, 1);
  assert.equal(counts.contract_warned, 1);
  assert.equal(counts.token_warned, 1);
  assert.equal(counts.impersonator_flagged, 2);
  const dump = JSON.stringify((await db.query('SELECT * FROM guard_groups')).rows) + JSON.stringify(rows);
  assert.ok(!/airdrop is live|DM me|scam/.test(dump), 'no message text is stored');
  await db.query(`UPDATE guard_counts SET n = $1 WHERE chat_id = '-1001' AND kind = 'replies'`, [guard.LIMITS.replies]);
  said.length = 0;
  await post(BOB, 'real CA is 0x' + 'cd'.repeat(20));
  assert.equal(said.length, 0, 'over the day\'s reply limit: quiet');
  assert.deepEqual(await guard.stats(), { groups: 1, last_30_days: { ...counts, replies: guard.LIMITS.replies + 1, contract_warned: 2 } });

  /* ── removed from the group ── */
  await hook({ my_chat_member: { chat: CHAT, from: ALICE, old_chat_member: { status: 'administrator' }, new_chat_member: { status: 'left', user: { id: 99 } } } });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM guard_groups WHERE removed_at IS NULL')).rows[0].n, 0);
  assert.ok(goplusAsked.length >= 2);
});
