/**
 * Sends alerts to every channel an account linked.
 *
 * enqueue(alertIds) makes one delivery per alert per active channel whose
 * min_severity the alert meets; tick() sends what's due. A failed send is
 * retried after 1, 5, 30 minutes, then 2 and 6 hours, then given up; a
 * channel that can never work again (bot blocked, push subscription gone,
 * address rejected) is switched off instead, with the reason shown to the
 * user. Each delivery is sent at most once.
 */
const db = require('../config/db');
const logger = require('../config/logger');
const transports = require('./transports');
const { message, emailHtml } = require('./format');
const channels = require('./channels');

const RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const BACKOFF_MINUTES = [1, 5, 30, 120, 360];
const PER_TICK = 50;

/** Queues the alerts for every active channel of their accounts that wants them. */
async function enqueue(alertIds) {
  if (!alertIds?.length) return 0;
  const { rowCount } = await db.query(
    `INSERT INTO alert_deliveries (alert_id, channel_id)
     SELECT a.id, c.id FROM monitor_alerts a
     JOIN alert_channels c ON c.account_id = a.account_id AND c.verified_at IS NOT NULL AND c.disabled_at IS NULL
     WHERE a.id = ANY($1::bigint[])
       AND (CASE a.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END)
        >= (CASE c.min_severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END)
     ON CONFLICT (alert_id, channel_id) DO NOTHING`,
    [alertIds.map(Number)],
  );
  return rowCount;
}

/** Sends one alert on one channel. */
async function sendOne(channel, alert) {
  const m = message(alert);
  if (channel.kind === 'telegram') return transports.telegram.send(channel.target, m);
  if (channel.kind === 'email') {
    const unsub = channels.unsubscribeUrl(channel.id);
    return transports.email.send({ to: channel.target, subject: m.subject, text: `${m.text}\n\n${m.action}: ${m.url}\n\nStop these emails: ${unsub}`, html: emailHtml(m, unsub), unsubscribeUrl: unsub });
  }
  if (channel.kind === 'push') return transports.push.send(JSON.parse(channel.target), { title: m.subject, body: m.text.split('\n').slice(1).join('\n'), url: m.url, tag: `rektbull-${alert.id}` });
  throw new Error(`unknown channel kind ${channel.kind}`);
}

/** Sends the deliveries that are due. Returns how many were tried. */
async function tick({ limit = PER_TICK } = {}) {
  const { rows } = await db.query(
    `SELECT d.id AS delivery_id, d.attempts, c.*, row_to_json(a.*) AS alert
     FROM alert_deliveries d JOIN alert_channels c ON c.id = d.channel_id JOIN monitor_alerts a ON a.id = d.alert_id
     WHERE d.status = 'pending' AND d.next_attempt_at <= now() ORDER BY d.next_attempt_at LIMIT $1`,
    [limit],
  );
  for (const r of rows) {
    if (r.disabled_at) {
      await db.query(`UPDATE alert_deliveries SET status = 'failed', last_error = 'channel switched off' WHERE id = $1`, [r.delivery_id]);
      continue;
    }
    try {
      await sendOne(r, r.alert);
      await db.query(`UPDATE alert_deliveries SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`, [r.delivery_id]);
    } catch (err) {
      const attempts = r.attempts + 1;
      if (err.permanent) {
        await db.query(`UPDATE alert_channels SET disabled_at = now(), disabled_reason = $2 WHERE id = $1`, [r.id, err.message.slice(0, 200)]);
        await db.query(`UPDATE alert_deliveries SET status = 'failed', attempts = $2, last_error = $3 WHERE id = $1`, [r.delivery_id, attempts, err.message.slice(0, 300)]);
      } else if (attempts > BACKOFF_MINUTES.length) {
        await db.query(`UPDATE alert_deliveries SET status = 'failed', attempts = $2, last_error = $3 WHERE id = $1`, [r.delivery_id, attempts, err.message.slice(0, 300)]);
      } else {
        await db.query(`UPDATE alert_deliveries SET attempts = $2, last_error = $3, next_attempt_at = now() + make_interval(mins => $4) WHERE id = $1`, [r.delivery_id, attempts, err.message.slice(0, 300), BACKOFF_MINUTES[attempts - 1]]);
      }
      logger.warn('alert delivery failed', { channel: r.kind, attempt: attempts, permanent: !!err.permanent, error: err.message });
    }
  }
  return rows.length;
}

/** A test alert to every active channel of the account, sent now. */
async function sendTest(accountId) {
  const { rows } = await db.query('SELECT * FROM alert_channels WHERE account_id = $1 AND verified_at IS NOT NULL AND disabled_at IS NULL', [accountId]);
  if (!rows.length) return { sent: [], failed: [], message: 'No channel is linked yet.' };
  const alert = { id: `test-${Date.now()}`, kind: 'test', severity: 'info', wallet: '0x0000000000000000000000000000000000000000', title: 'Test alert: your RektBull alerts arrive here', detail: { reasons: [{ text: 'This is only a test. Real alerts look like this, with the reasons and where the facts come from.', source: 'RektBull' }] } };
  const sent = [], failed = [];
  for (const c of rows) {
    try { await sendOne(c, alert); sent.push(c.kind); } catch (err) {
      failed.push({ kind: c.kind, error: err.message });
      if (err.permanent) await db.query(`UPDATE alert_channels SET disabled_at = now(), disabled_reason = $2 WHERE id = $1`, [c.id, err.message.slice(0, 200)]);
    }
  }
  return { sent, failed };
}

module.exports = { enqueue, tick, sendOne, sendTest, RANK, BACKOFF_MINUTES };
