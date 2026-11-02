/**
 * Alert channels end to end against a real Postgres: linking Telegram (with
 * Telegram's webhook played here), confirming an email, a browser push
 * subscription, then risk monitor alerts going out to each channel that wants
 * them, with retries, channels switched off when they can't work, and
 * unsubscribing. The three providers are stand-ins (no network); the Web Push
 * request itself is built for real by the web-push library.
 * Runs only when TEST_DATABASE_URL is set.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const DB = process.env.TEST_DATABASE_URL;

test('alert channels: link, deliver, retry, switch off, unsubscribe', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const webpush = require('web-push');
  const vapid = webpush.generateVAPIDKeys();
  Object.assign(process.env, {
    DATABASE_URL: DB, JWT_SECRET: 'test-secret', PUBLIC_URL: 'https://rektbull.test',
    TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_BOT_USERNAME: 'RektBullTestBot', TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
    RESEND_API_KEY: 're_test', VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  });
  for (const k of Object.keys(require.cache)) if (k.includes('/src/')) delete require.cache[k]; // pick up the env above

  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());

  const transports = require('../src/alerts/transports');
  const sent = { telegram: [], email: [], push: [] };
  let telegramFails = null, pushFails = null;
  transports.telegram.send = async (chatId, m) => { if (telegramFails) throw telegramFails; sent.telegram.push({ chatId, ...m }); };
  transports.email.send = async msg => { sent.email.push(msg); };
  transports.push.send = async (sub, payload) => { if (pushFails) throw pushFails; sent.push.push({ sub, payload }); };
  const dispatch = require('../src/alerts/dispatch');

  const { createApp } = require('../src/app');
  const { issueToken } = require('../src/auth/siwe');
  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { rows: [acct] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', ['0x' + 'ab'.repeat(20)]);
  const token = issueToken(acct);
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, redirect: 'manual', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, location: r.headers.get('location'), body: await r.json().catch(() => null) };
  };
  const hook = (text, chat = { id: 777, type: 'private' }, secret = 'hook-secret') => call('POST', '/v1/telegram/webhook', { message: { chat, text, from: { username: 'alice' } } }, { 'x-telegram-bot-api-secret-token': secret });

  await t.test('Telegram: a one-time link; only Telegram (with the secret) can complete it', async () => {
    const list = await call('GET', '/v1/alerts/channels');
    assert.deepEqual(list.body.available, { telegram: true, email: true, push: true });
    assert.equal(list.body.push_public_key, vapid.publicKey);
    const start = await call('POST', '/v1/alerts/channels/telegram');
    const code = new URL(start.body.link).searchParams.get('start');
    assert.match(start.body.link, /^https:\/\/t\.me\/RektBullTestBot\?start=/);
    assert.equal((await hook(`/start ${code}`, undefined, 'wrong')).status, 403, 'a forged webhook is refused');
    assert.equal((await hook(`/start ${code}`, { id: 9, type: 'group' })).body.linked, undefined, 'groups are ignored');
    assert.equal((await hook(`/start ${code}`)).body.linked, true);
    assert.equal((await hook(`/start ${code}`, { id: 888, type: 'private' })).body.linked, undefined, 'a code works once');
    assert.match(sent.telegram.at(-1).text, /expired or was already used/);
    const ch = (await call('GET', '/v1/alerts/channels')).body.channels;
    assert.deepEqual(ch.map(c => [c.kind, c.label, c.active, c.min_severity]), [['telegram', '@alice', true, 'medium']]);
  });

  await t.test('email: a confirmation link, once; bad addresses refused', async () => {
    assert.equal((await call('POST', '/v1/alerts/channels/email', { email: 'not an email' })).status, 400);
    const r = await call('POST', '/v1/alerts/channels/email', { email: 'Alice@Example.com' });
    assert.equal(r.body.to, 'alice@example.com');
    const url = sent.email.at(-1).text.match(/https:\/\/rektbull\.test(\S+)/)[1];
    assert.equal((await call('GET', url)).location, '/safety?email=confirmed#monitor-card');
    assert.equal((await call('GET', url)).location, '/safety?email=expired#monitor-card', 'a confirmation link works once');
    for (let i = 0; i < 2; i++) await call('POST', '/v1/alerts/channels/email', { email: `x${i}@example.com` });
    assert.equal((await call('POST', '/v1/alerts/channels/email', { email: 'y@example.com' })).status, 429, 'three confirmation emails a day');
  });

  let pushSub;
  await t.test('push: a browser subscription; the request web-push builds is signed (VAPID) and encrypted', async () => {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    pushSub = { endpoint: 'https://push.example.test/abc', keys: { p256dh: ecdh.getPublicKey('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
    assert.equal((await call('POST', '/v1/alerts/channels/push', { subscription: { endpoint: 'http://insecure' } })).status, 400);
    assert.equal((await call('POST', '/v1/alerts/channels/push', { subscription: pushSub, label: 'This browser' })).body.kind, 'push');
    const req = webpush.generateRequestDetails(pushSub, JSON.stringify({ title: 'x' }), { vapidDetails: { subject: 'mailto:a@b.c', publicKey: vapid.publicKey, privateKey: vapid.privateKey } });
    assert.equal(req.headers['Content-Encoding'], 'aes128gcm');
    assert.match(req.headers.Authorization, /^vapid t=.+, k=/);
  });

  const alert = async (severity, title = `A ${severity} alert`, extra = {}) => {
    const { rows } = await db.query(
      `INSERT INTO monitor_alerts (account_id, wallet, kind, severity, title, detail, dedupe_key) VALUES ($1, $2, 'new_approval', $3, $4, $5, $6) RETURNING id`,
      [acct.id, '0x' + 'cd'.repeat(20), severity, title, JSON.stringify({ reasons: [{ text: 'Flagged for phishing.', source: 'GoPlus (data from SlowMist)' }], ...extra }), crypto.randomUUID()]);
    await dispatch.enqueue([rows[0].id]);
    return rows[0].id;
  };
  const deliveries = async id => (await db.query('SELECT c.kind, d.status, d.attempts, d.last_error FROM alert_deliveries d JOIN alert_channels c ON c.id = d.channel_id WHERE d.alert_id = $1 ORDER BY c.kind', [id])).rows;

  await t.test('an alert goes to every channel that wants it, with its reasons, sources and a link', async () => {
    const before = { ...Object.fromEntries(Object.entries(sent).map(([k, v]) => [k, v.length])) };
    const id = await alert('critical', 'New critical-risk approval: <script>x</script>');
    assert.equal(await dispatch.tick(), 3);
    assert.deepEqual((await deliveries(id)).map(d => [d.kind, d.status]), [['email', 'sent'], ['push', 'sent'], ['telegram', 'sent']]);
    const tg = sent.telegram.at(-1);
    assert.equal(tg.chatId, '777');
    assert.match(tg.text, /^CRITICAL: New critical-risk approval/);
    assert.match(tg.text, /Flagged for phishing\. \(GoPlus \(data from SlowMist\)\)/);
    assert.equal(tg.url, `https://rektbull.test/safety?wallet=0x${'cd'.repeat(20)}#approvals-card`);
    const em = sent.email.at(-1);
    assert.equal(em.to, 'alice@example.com');
    assert.ok(!em.html.includes('<script>'), 'nothing in an alert becomes markup');
    assert.match(em.html, /&lt;script&gt;/);
    assert.match(em.unsubscribeUrl, /\/v1\/alerts\/unsubscribe\?c=\d+&t=/);
    assert.equal(sent.push.at(-1).payload.url, tg.url);
    assert.equal(sent.email.length, before.email + 1);
    assert.equal(await dispatch.tick(), 0, 'each delivery is sent once');
  });

  await t.test('each channel gets only the severities it asked for', async () => {
    const info = await alert('info');
    assert.deepEqual(await deliveries(info), [], 'default: medium and above');
    const ch = (await call('GET', '/v1/alerts/channels')).body.channels;
    const email = ch.find(c => c.kind === 'email');
    assert.equal((await call('PATCH', `/v1/alerts/channels/${email.id}`, { min_severity: 'info' })).body.min_severity, 'info');
    assert.equal((await call('PATCH', `/v1/alerts/channels/${email.id}`, { min_severity: 'loud' })).status, 400);
    const info2 = await alert('info');
    assert.deepEqual((await deliveries(info2)).map(d => d.kind), ['email']);
    await dispatch.tick();
  });

  await t.test('a failed send is retried later; a channel that can never work is switched off', async () => {
    telegramFails = new Error('Telegram: Too Many Requests');
    const id = await alert('high');
    await dispatch.tick();
    const tg = (await deliveries(id)).find(d => d.kind === 'telegram');
    assert.deepEqual([tg.status, tg.attempts], ['pending', 1]);
    telegramFails = null;
    await db.query(`UPDATE alert_deliveries SET next_attempt_at = now() WHERE status = 'pending'`);
    await dispatch.tick();
    assert.equal((await deliveries(id)).find(d => d.kind === 'telegram').status, 'sent');

    pushFails = Object.assign(new Error('push: the browser unsubscribed'), { permanent: true });
    const id2 = await alert('high');
    await dispatch.tick();
    assert.equal((await deliveries(id2)).find(d => d.kind === 'push').status, 'failed');
    const push = (await call('GET', '/v1/alerts/channels')).body.channels.find(c => c.kind === 'push');
    assert.deepEqual([push.active, push.disabled_reason], [false, 'push: the browser unsubscribed']);
    const id3 = await alert('high');
    assert.deepEqual((await deliveries(id3)).map(d => d.kind), ['email', 'telegram'], 'nothing more is queued for it');
    await dispatch.tick();
  });

  await t.test('stopping: /stop in Telegram, and the one-click unsubscribe in emails', async () => {
    assert.equal((await hook('/stop')).body.stopped, true);
    const em = sent.email.at(-1);
    const u = new URL(em.unsubscribeUrl);
    assert.equal((await call('GET', `${u.pathname}?c=${u.searchParams.get('c')}&t=forged`)).location, '/safety?email=bad-link#monitor-card');
    assert.equal((await call('POST', u.pathname + u.search)).body.ok, true, 'one-click (RFC 8058)');
    const ch = (await call('GET', '/v1/alerts/channels')).body.channels;
    assert.ok(ch.every(c => !c.active), 'all three off');
    assert.equal((await call('POST', '/v1/alerts/test')).body.message, 'No channel is linked yet.');
    // Linking Telegram again brings it back.
    const code = new URL((await call('POST', '/v1/alerts/channels/telegram')).body.link).searchParams.get('start');
    await hook(`/start ${code}`);
    const test2 = await call('POST', '/v1/alerts/test');
    assert.deepEqual(test2.body.sent, ['telegram']);
    assert.match(sent.telegram.at(-1).text, /^INFO: Test alert/);
  });
});
