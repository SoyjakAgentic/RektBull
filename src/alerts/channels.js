/**
 * Linking and managing where alerts go.
 *
 *   Telegram: the user opens t.me/<bot>?start=<code>; Telegram tells our
 *   webhook that chat <id> started the bot with <code>; the code (one use,
 *   15 minutes) names the account, so the chat is linked. Nobody can link a
 *   chat to someone else's account without that account's code.
 *
 *   Email: a confirmation link (one use, 24 hours) is sent to the address;
 *   clicking it verifies the channel. Every alert email carries a one-click
 *   unsubscribe link signed with JWT_SECRET.
 *
 *   Push: the browser's own subscription, sent from the signed-in page.
 */
const crypto = require('crypto');
const db = require('../config/db');
const env = require('../config/env');
const { telegram, email, push } = require('./transports');
const { escapeHtml } = require('./format');

class ChannelRefused extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const MAX_EMAIL_CONFIRMATIONS_PER_DAY = 3;
const code = () => crypto.randomBytes(16).toString('base64url');

async function newCode(accountId, kind, target, minutes) {
  const c = code();
  await db.query('INSERT INTO alert_link_codes (code, account_id, kind, target, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))', [c, accountId, kind, target, minutes]);
  return c;
}

/** Uses a code once; returns its row or null when unknown, used or expired. */
async function useCode(c, kind) {
  const { rows } = await db.query(
    `UPDATE alert_link_codes SET used_at = now() WHERE code = $1 AND kind = $2 AND used_at IS NULL AND expires_at > now() RETURNING account_id, target`,
    [String(c || ''), kind],
  );
  return rows[0] || null;
}

async function upsertVerified(accountId, kind, target, label) {
  const { rows } = await db.query(
    `INSERT INTO alert_channels (account_id, kind, target, label, verified_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (account_id, kind, target) DO UPDATE SET verified_at = now(), disabled_at = NULL, disabled_reason = NULL, label = COALESCE(EXCLUDED.label, alert_channels.label)
     RETURNING *`,
    [accountId, kind, target, label],
  );
  return rows[0];
}

const present = c => ({
  id: c.id, kind: c.kind, label: c.label || (c.kind === 'push' ? 'This browser' : null), min_severity: c.min_severity,
  verified: !!c.verified_at, active: !!c.verified_at && !c.disabled_at, disabled_reason: c.disabled_reason, created_at: c.created_at,
});

async function list(accountId) {
  const { rows } = await db.query('SELECT * FROM alert_channels WHERE account_id = $1 ORDER BY created_at', [accountId]);
  return {
    channels: rows.map(present),
    available: { telegram: telegram.enabled(), email: email.enabled(), push: push.enabled() },
    push_public_key: env.vapidPublicKey || null,
  };
}

/* ── Telegram ── */
async function startTelegram(accountId) {
  if (!telegram.enabled()) throw new ChannelRefused('Telegram alerts are not set up on this server yet.', 503);
  const c = await newCode(accountId, 'telegram', null, 15);
  return { link: `https://t.me/${env.telegramBotUsername}?start=${c}`, expires_in_minutes: 15 };
}

const secretOk = got => {
  const a = Buffer.from(String(got || '')), b = Buffer.from(env.telegramWebhookSecret);
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
};

/** Telegram's webhook: "/start <code>" links the chat; "/stop" unlinks it. Always answers 200 for well-formed calls. */
async function telegramUpdate(headers, update) {
  if (!secretOk(headers['x-telegram-bot-api-secret-token'])) throw new ChannelRefused('forbidden', 403);
  // Groups and their members go to Group Guard (src/services/groupGuard.js). Always 200, or Telegram retries.
  const groupUpdate = update?.my_chat_member || update?.chat_member || ['group', 'supergroup'].includes((update?.message || update?.edited_message)?.chat?.type);
  if (groupUpdate) {
    if (!env.databaseUrl) return { ok: true };
    try { return await require('../services/groupGuard').handle(update); } catch (err) {
      require('../config/logger').error('group guard failed', { error: err.message });
      return { ok: true };
    }
  }
  const msg = update?.message;
  const chatId = msg?.chat?.id;
  const text = String(msg?.text || '').trim();
  if (!chatId || msg.chat.type !== 'private') return { ok: true };
  const reply = t => telegram.send(String(chatId), { text: t }).catch(() => {});
  const start = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{10,64})$/.exec(text);
  if (start) {
    const row = await useCode(start[1], 'telegram');
    if (!row) { await reply('This link has expired or was already used. Open RektBull and press "Connect Telegram" again.'); return { ok: true }; }
    const who = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name || 'Telegram';
    await upsertVerified(row.account_id, 'telegram', String(chatId), who);
    await reply('Linked. RektBull will send your alerts here (your AI agents and the risk monitor). Send /stop to turn them off.');
    return { ok: true, linked: true };
  }
  if (/^\/stop(?:@\w+)?$/.test(text)) {
    await db.query(`UPDATE alert_channels SET disabled_at = now(), disabled_reason = 'Turned off in Telegram (/stop)' WHERE kind = 'telegram' AND target = $1 AND disabled_at IS NULL`, [String(chatId)]);
    await reply('Alerts turned off. You can link this chat again from RektBull.');
    return { ok: true, stopped: true };
  }
  await reply('This bot only sends RektBull alerts. Link it from the AI agents or Safety page on rektbull.com.');
  return { ok: true };
}

/* ── Email ── */
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[A-Za-z]{2,24}$/;

async function startEmail(accountId, address) {
  if (!email.enabled()) throw new ChannelRefused('Email alerts are not set up on this server yet.', 503);
  const to = String(address || '').trim().toLowerCase();
  if (!EMAIL_RE.test(to)) throw new ChannelRefused('That doesn\'t look like an email address.');
  // Confirmation codes last a day, so the ones not yet expired are the ones sent in the last 24 hours.
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM alert_link_codes WHERE account_id = $1 AND kind = 'email' AND expires_at > now()`, [accountId]);
  if (rows[0].n >= MAX_EMAIL_CONFIRMATIONS_PER_DAY) throw new ChannelRefused('Too many confirmation emails today; try again tomorrow.', 429);
  const c = await newCode(accountId, 'email', to, 24 * 60);
  const url = `${env.publicUrl}/v1/alerts/confirm-email?code=${c}`;
  await email.send({
    to, subject: 'Confirm your RektBull alerts',
    text: `Confirm that RektBull may send your alerts (your AI agents and the risk monitor) to this address:\n${url}\n\nIf you didn't ask for this, ignore this email.`,
    html: `<p>Confirm that RektBull may send your alerts (your AI agents and the risk monitor) to this address:</p><p><a href="${escapeHtml(url)}">Confirm my email</a></p><p style="color:#5d6673;font-size:12px">If you didn't ask for this, ignore this email.</p>`,
  });
  return { sent: true, to };
}

async function confirmEmail(c) {
  const row = await useCode(c, 'email');
  if (!row) return null;
  return present(await upsertVerified(row.account_id, 'email', row.target, row.target));
}

const unsubscribeToken = channelId => crypto.createHmac('sha256', env.jwtSecret || 'unset').update(`unsubscribe:${channelId}`).digest('base64url');
const unsubscribeUrl = channelId => `${env.publicUrl}/v1/alerts/unsubscribe?c=${channelId}&t=${unsubscribeToken(channelId)}`;

async function unsubscribe(channelId, token) {
  const expected = Buffer.from(unsubscribeToken(Number(channelId)));
  const got = Buffer.from(String(token || ''));
  if (!env.jwtSecret || got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return false;
  await db.query(`UPDATE alert_channels SET disabled_at = now(), disabled_reason = 'Unsubscribed from an email' WHERE id = $1 AND disabled_at IS NULL`, [Number(channelId)]);
  return true;
}

/* ── Push ── */
async function addPush(accountId, subscription, label) {
  if (!push.enabled()) throw new ChannelRefused('Browser notifications are not set up on this server yet.', 503);
  const s = subscription || {};
  if (!/^https:\/\//.test(String(s.endpoint || '')) || !s.keys?.p256dh || !s.keys?.auth) throw new ChannelRefused('That isn\'t a browser push subscription.');
  const target = JSON.stringify({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } });
  return present(await upsertVerified(accountId, 'push', target, label ? String(label).slice(0, 60) : 'Browser'));
}

/* ── Settings ── */
async function update(accountId, id, { min_severity: sev }) {
  if (!SEVERITIES.includes(sev)) throw new ChannelRefused(`min_severity must be one of: ${SEVERITIES.join(', ')}`);
  const { rows } = await db.query('UPDATE alert_channels SET min_severity = $3 WHERE id = $1 AND account_id = $2 RETURNING *', [id, accountId, sev]);
  if (!rows.length) throw new ChannelRefused('not found', 404);
  return present(rows[0]);
}

async function remove(accountId, id) {
  const { rowCount } = await db.query('DELETE FROM alert_channels WHERE id = $1 AND account_id = $2', [id, accountId]);
  if (!rowCount) throw new ChannelRefused('not found', 404);
  return { ok: true };
}

module.exports = {
  list, startTelegram, telegramUpdate, startEmail, confirmEmail, unsubscribe, unsubscribeUrl, unsubscribeToken,
  addPush, update, remove, ChannelRefused, SEVERITIES,
};
