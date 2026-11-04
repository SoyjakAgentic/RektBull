/**
 * The weekly newsletter, with the email provider as a stand-in: double
 * opt-in (one confirmation, nothing else until it's clicked), the same answer
 * whoever signs up, signed links, a published digest sent once to confirmed
 * subscribers in resumable batches, nothing sent without a postal address,
 * one-click unsubscribe that deletes the address, and an address that
 * doesn't take mail removed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
const ADMIN = '0x' + 'ad'.repeat(20);
Object.assign(process.env, { JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', ADMIN_WALLETS: ADMIN, RESEND_API_KEY: 'test', PUBLIC_URL: 'https://rektbull.test', ...(DB ? { DATABASE_URL: DB } : {}) });
const env = require('../src/config/env');
const newsletter = require('../src/services/newsletter');
const { email } = require('../src/alerts/transports');

test('the email: escaped Markdown, the byline, the page link, the postal address and the unsubscribe link', () => {
  env.operatorPostalAddress = '1 Test Street, Testville';
  const m = newsletter.compose({ week_start: '2026-10-26', byline: 'Written by RektBull Research', text: '## Hacks\n- **$6.4B** lost <script> [DefiLlama hacks]', facts: [] }, 7);
  assert.equal(m.subject, 'RektBull Research: the week of 26 October 2026');
  assert.match(m.html, /<h3[^>]*>Hacks<\/h3>\n<ul[^>]*>\n<li><strong>\$6\.4B<\/strong> lost &lt;script&gt; \[DefiLlama hacks\]<\/li>/);
  assert.ok(!m.html.includes('<script>'));
  assert.match(m.text, /Written by RektBull Research/);
  assert.match(m.text, /https:\/\/rektbull\.test\/research\?week=2026-10-26/);
  assert.match(m.text, /1 Test Street, Testville/);
  assert.equal(m.unsubscribeUrl, newsletter.unsubscribeUrl(7));
  assert.match(m.text, /Unsubscribe: https:\/\/rektbull\.test\/v1\/newsletter\/unsubscribe\?s=7&t=/);
  const facts = newsletter.compose({ week_start: '2026-10-26', byline: 'Written by RektBull Research', text: null, facts: [{ text: '3 exploits', source: 'DefiLlama hacks' }] }, 7);
  assert.match(facts.text, /- 3 exploits \[DefiLlama hacks\]/, 'with no write-up, the facts are the email');
  assert.match(newsletter.parseEmail({ email: 'nope' }).error, /doesn't look like an email/);
  assert.equal(newsletter.parseEmail({ email: ' Me@Example.COM ' }).email, 'me@example.com');
});

test('sign-up, confirm, the weekly send, unsubscribe', { skip: !DB && 'set TEST_DATABASE_URL' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  const sent = [];
  let bounce = null;
  email.send = async m => { if (m.to === bounce) throw Object.assign(new Error('email: invalid recipient'), { permanent: true }); sent.push(m); };

  const server = require('../src/app').createApp().listen(0);
  t.after(async () => { server.close(); await db.getPool().end(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const signUp = async to => { const r = await fetch(base + '/v1/newsletter', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: to }) }); return { status: r.status, body: await r.json() }; };
  const follow = async url => { const r = await fetch(url.replace('https://rektbull.test', base), { redirect: 'manual' }); return r.headers.get('location'); };

  // Sign-up: one confirmation email, the same answer every time.
  const first = await signUp('Reader@Example.com');
  assert.equal(first.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'reader@example.com');
  assert.match(sent[0].subject, /Confirm/);
  const again = await signUp('reader@example.com');
  assert.deepEqual(again.body, first.body, 'the same answer');
  assert.equal(sent.length, 1, 'not resent within 10 minutes');
  assert.equal((await signUp('nope')).status, 400);

  // A link with a wrong signature does nothing; the real one confirms.
  const confirmLink = sent[0].text.match(/https:\/\/\S+confirm\S+/)[0];
  assert.equal(await follow(confirmLink.replace(/t=.*/, 't=forged')), '/research?newsletter=bad-link#newsletter');
  assert.equal(await follow(confirmLink), '/research?newsletter=confirmed#newsletter');
  const confirmed = await signUp('reader@example.com');
  assert.deepEqual(confirmed.body, first.body, 'a confirmed address gets the same answer: the form says nothing about who subscribes');
  assert.equal(sent.length, 1, 'and no email');
  await signUp('pending@example.com'); // never confirms
  await signUp('bounces@example.com');
  await follow(sent.at(-1).text.match(/https:\/\/\S+confirm\S+/)[0]);
  assert.deepEqual(await newsletter.counts(), { confirmed: 2, pending: 1 });

  // A per-IP daily limit on sign-ups: five a day (the bad address above wasn't counted).
  const limited = await signUp('one-too-many@example.com');
  assert.deepEqual([limited.status, limited.body.message], [429, 'Too many sign-ups from here today. Try again tomorrow.']);

  // Nothing is sent for a draft, or without a postal address.
  await db.query(`INSERT INTO research_digests (week_start, week_end, facts, checked, status) VALUES ('2026-10-26', '2026-11-02', $1, 'x', 'draft')`, [JSON.stringify({ items: [{ section: 'Hacks', text: '3 exploits', source: 'DefiLlama hacks' }], not_checked: [] })]);
  sent.length = 0;
  assert.deepEqual(await newsletter.tick(), { sent: 0 }, 'a draft isn\'t sent');
  await db.query(`UPDATE research_digests SET status = 'published', text = '## Hacks\n3 exploits [DefiLlama hacks].', reviewed_at = now() WHERE week_start = '2026-10-26'`);
  env.operatorPostalAddress = '';
  assert.equal((await newsletter.tick()).blocked, 'no postal address');
  assert.equal(sent.length, 0);
  env.operatorPostalAddress = '1 Test Street, Testville';

  // Sent in batches to confirmed subscribers only, each once; an address that doesn't take mail is removed.
  bounce = 'bounces@example.com';
  assert.deepEqual(await newsletter.tick({ limit: 1 }), { sent: 1, week: '2026-10-26' });
  assert.deepEqual(await newsletter.tick({ limit: 5 }), { sent: 0, week: '2026-10-26' }, 'the bounce');
  assert.deepEqual(sent.map(m => m.to), ['reader@example.com'], 'confirmed only, never the pending one');
  assert.match(sent[0].text, /Written by RektBull Research[\s\S]*3 exploits \[DefiLlama hacks\][\s\S]*1 Test Street/);
  assert.equal((await db.query(`SELECT 1 FROM newsletter_subscribers WHERE email = 'bounces@example.com'`)).rowCount, 0);
  assert.deepEqual(await newsletter.tick(), { sent: 0, finished: true });
  assert.deepEqual(await newsletter.tick(), { sent: 0 }, 'a week goes out once');
  assert.equal(sent.length, 1);

  // Unsubscribe: the link in the email, or one click from the mail app; the address is deleted.
  const unsub = sent[0].unsubscribeUrl;
  assert.equal((await fetch(unsub.replace('https://rektbull.test', base).replace(/t=.*/, 't=forged'), { method: 'POST' })).status, 400);
  assert.equal((await fetch(unsub.replace('https://rektbull.test', base), { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 200);
  assert.equal((await db.query(`SELECT 1 FROM newsletter_subscribers WHERE email = 'reader@example.com'`)).rowCount, 0, 'deleted');
  assert.equal(await follow(unsub), '/research?newsletter=unsubscribed#newsletter', 'a used link still says done');

  // Unconfirmed sign-ups go after 7 days.
  await db.query(`UPDATE newsletter_subscribers SET created_at = now() - interval '8 days' WHERE email = 'pending@example.com'`);
  await require('../src/privacy/retention').purge();
  assert.equal((await db.query(`SELECT 1 FROM newsletter_subscribers WHERE email = 'pending@example.com'`)).rowCount, 0);
});
