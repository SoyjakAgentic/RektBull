/**
 * Safety Pro renewal reminders. Passes are prepaid and never renew
 * themselves (no recurring pulls), so RektBull reminds instead: 7 days
 * before a pass ends, 1 day before, and when it has ended. Each reminder is
 * a risk monitor alert (kind 'pass_renewal'), so it reaches the user on
 * whatever they linked (Telegram, email, browser push) and shows on the
 * Safety page; each is sent once per end date. Buying again extends the
 * pass from its end, so a reminder acted on early loses nothing.
 */
const db = require('../config/db');
const { product } = require('./catalog');

const DAY = 86400 * 1000;

function message(kind, endsAt) {
  const date = endsAt.toISOString().slice(0, 10);
  const m = product('pro_30d'); const y = product('pro_365d');
  const how = `Buy again on the Safety page to extend it from its end date: $${m.price_cents / 100} for 30 days or $${y.price_cents / 100} for a year, from credits or with any coin. Nothing renews by itself.`;
  if (kind === 'ended') return { title: 'Your Safety Pro has ended', text: `It ended on ${date}. The risk monitor is paused, and checks use free points again. ${how}` };
  if (kind === '1d') return { title: 'Your Safety Pro ends tomorrow', text: `It ends on ${date}, and the risk monitor pauses then. ${how}` };
  return { title: `Your Safety Pro ends on ${date}`, text: `That's in about a week. ${how}` };
}

const kindFor = (endsAt, now) => {
  const left = endsAt - now;
  return left <= 0 ? 'ended' : left <= DAY ? '1d' : '7d';
};

/** The worker's job (hourly): reminders that are due, each sent once. Returns how many were raised. */
async function tick({ now = new Date() } = {}) {
  const { rows } = await db.query(
    `SELECT p.account_id, a.wallet, max(p.ends_at) AS ends_at FROM passes p JOIN accounts a ON a.id = p.account_id
     GROUP BY p.account_id, a.wallet
     HAVING max(p.ends_at) > $1::timestamptz - interval '1 day' AND max(p.ends_at) <= $1::timestamptz + interval '7 days'`,
    [now],
  );
  const raised = [];
  for (const r of rows) {
    const endsAt = new Date(r.ends_at);
    const kind = kindFor(endsAt, now);
    const { rowCount } = await db.query('INSERT INTO pass_reminders (account_id, ends_at, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [r.account_id, endsAt, kind]);
    if (!rowCount) continue;
    const m = message(kind, endsAt);
    const { rows: ins } = await db.query(
      `INSERT INTO monitor_alerts (account_id, wallet, kind, severity, title, detail, dedupe_key)
       VALUES ($1, $2, 'pass_renewal', 'medium', $3, $4, $5) ON CONFLICT (account_id, dedupe_key) DO NOTHING RETURNING id`,
      [r.account_id, r.wallet, m.title, JSON.stringify({ reasons: [{ text: m.text, source: 'your RektBull account' }], ends_at: endsAt.toISOString() }), `pass:${endsAt.toISOString()}:${kind}`],
    );
    if (ins.length) raised.push(ins[0].id);
  }
  if (raised.length) await require('../alerts/dispatch').enqueue(raised);
  return raised.length;
}

module.exports = { tick, message, kindFor };
