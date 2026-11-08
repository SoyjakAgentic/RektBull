/**
 * Channel Poster against a real Postgres, through Telegram's webhook, with
 * the Telegram API, DefiLlama, Snapshot and Merkl as stand-ins: the bot
 * added to a channel, settings in the owner's private chat, drafts from each
 * topic (old news recorded on a topic's first run, not drafted), Post and
 * Skip taps (admins only, never twice, a failed post put back), expiry, and
 * the bot removed. Runs only when TEST_DATABASE_URL is set.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;

test('Channel Poster: setup, drafts, approval, expiry', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test-secret', PUBLIC_URL: 'https://rektbull.test', NEW_WALLET_CHECK_CHAINS: '', TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_BOT_USERNAME: 'RektBullBot', TELEGRAM_WEBHOOK_SECRET: 'hook-secret' });
  for (const k of Object.keys(require.cache)) if (k.includes('/src/')) delete require.cache[k];
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());

  const OWNER = { id: 501, first_name: 'Olive' }, STRANGER = { id: 502, first_name: 'Sam' };
  const CHANNEL = { id: -1009, type: 'channel', title: 'Bull Lend News' };
  const tg = require('../src/providers/telegramBot');
  const sent = [], offered = [], edits = [], answers = [];
  let channelDown = false;
  tg.send = async (chat, text) => { if (channelDown && chat === String(CHANNEL.id)) throw new Error('Telegram sendMessage: not enough rights'); sent.push({ chat: String(chat), text }); };
  tg.buttons = async (chat, text, row) => { offered.push({ chat: String(chat), text, row }); };
  tg.edit = async (chat, id, text) => { edits.push(text); };
  tg.answer = async (id, text) => { answers.push(text); };
  tg.member = async (_chat, user) => ({ status: Number(user) === OWNER.id ? 'administrator' : 'member' });
  // the alert channel's sendMessage, for /start in a private chat
  require('../src/alerts/transports').telegram.send = async (chat, m) => { sent.push({ chat: String(chat), text: m.text }); };

  const today = new Date().toISOString().slice(0, 10);
  const longAgo = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  let hacks = [
    { date: today, name: 'Base Bridge', amount_usd: 5e6, returned_usd: null, technique: 'Private Key Compromised', chains: ['Base'], source: 'https://rekt.example/bb' },
    { date: today, name: 'Eth Only', amount_usd: 9e6, chains: ['Ethereum'], source: null },
    { date: today, name: 'Small Base', amount_usd: 1e5, chains: ['Base'] },
    { date: longAgo, name: 'Old Base', amount_usd: 50e6, chains: ['Base'] },
  ];
  require('../src/providers/llama').hackList = async () => hacks;
  const now = Math.floor(Date.now() / 1000);
  require('../src/providers/snapshot').activeProposals = async spaces => (spaces[0] === 'bulllend.eth' ? [{ id: '0xp1', title: 'Raise the USDC cap', end: now + 2 * 86400 }, { id: '0xp2', title: 'Fund the audit', end: now + 10 * 3600 }] : []);
  let campaigns = [{ id: 'c1', chain: 'base', name: 'Supply USDC', protocol: { name: 'Bull Lend', defillama_slug: 'bull-lend' } }, { id: 'c9', chain: 'base', name: 'Other', protocol: { name: 'X', defillama_slug: 'x' } }];
  require('../src/providers/merkl').live = async chain => (chain === 'base' ? campaigns : []);
  const poster = require('../src/services/channelPoster');

  const server = require('../src/app').createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const hook = async update => (await fetch(base + '/v1/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'hook-secret' }, body: JSON.stringify(update) })).status;
  let mid = 0;
  const dm = (from, text) => hook({ message: { message_id: ++mid, chat: { id: from.id, type: 'private' }, from, text } });
  const tap = (from, data) => hook({ callback_query: { id: `q${++mid}`, from, data, message: { chat: { id: from.id }, message_id: mid } } });
  const lastSent = () => sent[sent.length - 1].text;

  /* ── /start explains the bot; the bot added to a channel ── */
  await dm(OWNER, '/start');
  assert.match(lastSent(), /^This is RektBull's bot\. It does three things:.*Channel Poster.*never DMs first\.$/s);
  assert.equal(await hook({ my_chat_member: { chat: CHANNEL, from: OWNER, old_chat_member: { status: 'left' }, new_chat_member: { status: 'administrator', can_post_messages: true, user: { id: 99 } } } }), 200);
  assert.equal(sent.at(-1).chat, String(OWNER.id));
  assert.match(lastSent(), /^Channel Poster is connected to Bull Lend News\./);

  /* ── settings, in the owner's private chat ── */
  await dm(OWNER, '/poster');
  assert.match(lastSent(), /^1\. Bull Lend News \(on\)\n {3}Topics: none yet/);
  await dm(STRANGER, '/poster_topics 1 hacks');
  assert.match(lastSent(), /^You have no channels yet\./, 'only the channels you added');
  await dm(OWNER, '/poster_topics 1 hacks,votes,nonsense');
  assert.equal(lastSent(), 'Topics are: hacks, votes, campaigns.');
  await dm(OWNER, '/poster_topics 1 hacks,votes,campaigns');
  await dm(OWNER, '/poster_chains 1 base');
  await dm(OWNER, '/poster_space 1 BullLend.eth');
  await dm(OWNER, '/poster_protocol 1 bull-lend');
  assert.match(lastSent(), /Topics: hacks, votes, campaigns\n {3}Chains: base\n {3}Snapshot space: bulllend\.eth\n {3}Protocol: bull-lend/);

  /* ── first run: open votes drafted; existing hacks and campaigns recorded, not drafted ── */
  await poster.tick();
  const status = async () => Object.fromEntries((await db.query('SELECT key, status FROM poster_drafts ORDER BY id')).rows.map(r => [r.key, r.status]));
  assert.deepEqual(await status(), { [`hack:${today}:Base Bridge`]: 'baseline', 'vote:0xp1': 'pending', 'vote:0xp2': 'pending', 'vote-closing:0xp2': 'pending', 'campaign:c1': 'baseline' });
  assert.equal(offered.length, 3);
  assert.ok(offered.every(o => o.chat === String(OWNER.id)));
  assert.match(offered[0].text, /^Draft for Bull Lend News \(votes in your snapshot space\):\n\n🗳 New vote: Raise the USDC cap\n\nVoting ends .* UTC\. Read the proposal and vote from your own wallet: https:\/\/snapshot\.box\/#\/s:bulllend\.eth\/proposal\/0xp1\n\nSource: Snapshot/);
  assert.deepEqual(offered[0].row.map(b => b.text), ['Post to the channel', 'Skip']);
  await poster.tick();
  assert.equal(offered.length, 3, 'nothing offered twice');

  /* ── later: a new hack on Base and a new campaign are drafted ── */
  hacks = [{ date: today, name: 'New Base Hack', amount_usd: 2.5e6, returned_usd: 1e6, technique: 'Oracle Manipulation', chains: ['Base'], source: 'https://rekt.example/nb' }, ...hacks];
  campaigns = [...campaigns, { id: 'c2', chain: 'base', name: 'Borrow ETH', protocol: { name: 'Bull Lend', defillama_slug: 'bull-lend' } }];
  await poster.tick();
  assert.equal(offered.length, 5);
  const hackDraft = offered.find(o => /New Base Hack/.test(o.text));
  assert.match(hackDraft.text, /⚠️ New Base Hack was hacked on .* \(Base\): \$2\.5M lost, by oracle manipulation\. \$1\.0M has been returned\.\n\nIf you used it, check what your wallet has approved.*\n\nSource: DefiLlama's hack record, https:\/\/rekt\.example\/nb/s);
  const campaignDraft = offered.find(o => /Borrow ETH/.test(o.text));
  assert.match(campaignDraft.text, /A Merkl reward campaign is live on Bull Lend \(base\): Borrow ETH\..*Not advice; rewards change and are never guaranteed\./s);
  assert.ok(!/\d+(\.\d+)?%/.test(campaignDraft.text), 'never a rate');

  /* ── approval: admins only, once; a failed post is put back ── */
  const id = Number(hackDraft.row[0].data.split(':')[2]);
  await tap(STRANGER, `cp:post:${id}`);
  assert.equal(answers.at(-1), 'Only an admin of the channel can do that.');
  channelDown = true;
  await tap(OWNER, `cp:post:${id}`);
  assert.match(answers.at(-1), /^Couldn't post it: not enough rights\. Check that I'm an admin who may post messages\./);
  assert.equal((await db.query('SELECT status FROM poster_drafts WHERE id = $1', [id])).rows[0].status, 'pending');
  channelDown = false;
  await tap(OWNER, `cp:post:${id}`);
  assert.equal(answers.at(-1), 'Posted.');
  assert.equal(sent.at(-1).chat, String(CHANNEL.id));
  assert.match(sent.at(-1).text, /^⚠️ New Base Hack was hacked/);
  assert.match(edits.at(-1), /^Posted to Bull Lend News ✓/);
  await tap(OWNER, `cp:post:${id}`);
  assert.equal(answers.at(-1), 'Already posted.');
  assert.equal(sent.filter(s => s.chat === String(CHANNEL.id)).length, 1, 'posted once');
  const skipId = Number(campaignDraft.row[1].data.split(':')[2]);
  await tap(OWNER, `cp:skip:${skipId}`);
  assert.equal(answers.at(-1), 'Skipped.');
  assert.equal((await db.query('SELECT status, decided_by FROM poster_drafts WHERE id = $1', [skipId])).rows[0].decided_by, String(OWNER.id));

  /* ── drafts left 3 days expire; the bot removed ── */
  await db.query(`UPDATE poster_drafts SET created_at = now() - interval '4 days' WHERE status = 'pending'`);
  await poster.tick();
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM poster_drafts WHERE status = 'pending'`)).rows[0].n, 0);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM poster_drafts WHERE status = 'expired'`)).rows[0].n, 3);
  await hook({ my_chat_member: { chat: CHANNEL, from: OWNER, old_chat_member: { status: 'administrator' }, new_chat_member: { status: 'left', user: { id: 99 } } } });
  await dm(OWNER, '/poster');
  assert.match(lastSent(), /^You have no channels yet\./);
});
