/**
 * Safety Pro renewal reminders: 7 days before, 1 day before and when a pass
 * has ended, each once per end date, none while a later pass extends it;
 * sent over the account's alert channels with a link to renew.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;

test('reminders: 7 days, 1 day, ended; once each; not while extended', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  Object.assign(process.env, { DATABASE_URL: DB, PUBLIC_URL: 'https://rektbull.example' });
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());
  const reminders = require('../src/payments/reminders');
  const { message } = require('../src/alerts/format');
  const now = new Date('2026-11-03T12:00:00Z');
  const day = 86400000;
  const acct = async (wallet, endsIn) => {
    const { rows: [a] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id', [wallet]);
    await db.query(`INSERT INTO passes (account_id, product, starts_at, ends_at) VALUES ($1, 'pro_30d', $2, $3)`, [a.id, new Date(now - 30 * day), new Date(+now + endsIn)]);
    return a.id;
  };
  const soon = await acct('0x' + '01'.repeat(20), 5 * day);
  const tomorrow = await acct('0x' + '02'.repeat(20), 12 * 3600000);
  const ended = await acct('0x' + '03'.repeat(20), -2 * 3600000);
  const extended = await acct('0x' + '04'.repeat(20), 3 * day);
  await db.query(`INSERT INTO passes (account_id, product, starts_at, ends_at) VALUES ($1, 'pro_30d', $2, $3)`, [extended, new Date(+now + 3 * day), new Date(+now + 33 * day)]);
  const farOff = await acct('0x' + '05'.repeat(20), 20 * day);
  // One account has a verified Telegram channel: its reminder is queued for delivery.
  const { rows: [ch] } = await db.query(`INSERT INTO alert_channels (account_id, kind, target, verified_at) VALUES ($1, 'telegram', '123', now()) RETURNING id`, [soon]);

  assert.equal(await reminders.tick({ now }), 3);
  const { rows } = await db.query(`SELECT account_id, title, kind, detail FROM monitor_alerts ORDER BY account_id`);
  assert.deepEqual(rows.map(r => Number(r.account_id)).sort(), [soon, tomorrow, ended].map(Number).sort());
  assert.ok(rows.every(r => r.kind === 'pass_renewal'));
  const by = Object.fromEntries(rows.map(r => [Number(r.account_id), r]));
  assert.match(by[soon].title, /^Your Safety Pro ends on 2026-11-08$/);
  assert.match(by[tomorrow].title, /ends tomorrow/);
  assert.match(by[ended].title, /has ended/);
  assert.match(by[ended].detail.reasons[0].text, /risk monitor is paused/);
  assert.ok(!by[extended] && !by[farOff], 'no reminder while a later pass extends it, or weeks ahead');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM alert_deliveries WHERE channel_id = $1', [ch.id])).rows[0].n, 1, 'sent to the account\'s channel');

  assert.equal(await reminders.tick({ now }), 0, 'each once');
  // 13 hours later the second account's pass has ended; four and a half days later the first is a day from its end.
  assert.equal(await reminders.tick({ now: new Date(+now + 13 * 3600000) }), 1, 'ended (account 2)');
  assert.equal(await reminders.tick({ now: new Date(+now + 4 * day + 13 * 3600000) }), 1, '1 day before (account 1)');

  const m = message({ kind: 'pass_renewal', title: by[soon].title, detail: by[soon].detail, wallet: '0x' + '01'.repeat(20), severity: 'medium' });
  assert.equal(m.subject, 'RektBull: Your Safety Pro ends on 2026-11-08');
  assert.equal(m.url, 'https://rektbull.example/safety#pro-card');
  assert.equal(m.action, 'Renew Safety Pro');
  assert.match(m.text, /Nothing renews by itself/);
});
