/**
 * The weekly newsletter: the published digest, by email, to people who asked.
 *
 * - Sign-up is double opt-in: an address gets one confirmation email, and
 *   nothing else until its link is clicked. The answer to a sign-up is the
 *   same whether the address was new, pending or already confirmed, so the
 *   form can't be used to learn who subscribes.
 * - Unsubscribing (a link in every email, and one-click from the mail app,
 *   RFC 8058) deletes the address. Unconfirmed sign-ups are deleted after
 *   7 days (src/privacy/retention.js).
 * - Each email carries the operator's postal address (OPERATOR_POSTAL_ADDRESS),
 *   which US law (CAN-SPAM) asks of commercial email; nothing is sent without it.
 * - Sending is resumable: each digest is sent in batches by the worker, and
 *   every send is recorded, so a restart picks up where it stopped.
 * - Sponsored posts the owner added to the week (src/services/sponsored.js)
 *   go above and below the digest, each in its own box, labelled.
 * Links are signed (HMAC), so nothing secret is stored.
 */
const crypto = require('crypto');
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const { email } = require('../alerts/transports');

class NewsletterRefused extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[A-Za-z]{2,24}$/;
const RESEND_MINUTES = 10;
const sign = (what, id) => crypto.createHmac('sha256', env.jwtSecret || 'unset').update(`newsletter:${what}:${id}`).digest('base64url');
const valid = (what, id, token) => {
  const expected = Buffer.from(sign(what, Number(id)));
  const got = Buffer.from(String(token || ''));
  return !!env.jwtSecret && /^\d+$/.test(String(id)) && got.length === expected.length && crypto.timingSafeEqual(got, expected);
};
const confirmUrl = id => `${env.publicUrl}/v1/newsletter/confirm?s=${id}&t=${sign('confirm', id)}`;
const unsubscribeUrl = id => `${env.publicUrl}/v1/newsletter/unsubscribe?s=${id}&t=${sign('unsubscribe', id)}`;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function parseEmail(body = {}) {
  const to = String(body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(to)) return { error: 'That doesn\'t look like an email address.' };
  return { email: to };
}

/** Starts (or restarts) a sign-up. Always answers the same way. */
async function subscribe(address) {
  if (!email.enabled()) throw new NewsletterRefused('The newsletter isn\'t set up on this server yet.', 503);
  const { rows: [s] } = await db.query(
    `INSERT INTO newsletter_subscribers (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING *`, [address],
  );
  const recently = s.confirm_sent_at && Date.now() - new Date(s.confirm_sent_at) < RESEND_MINUTES * 60000;
  if (!s.confirmed_at && !recently) {
    await db.query('UPDATE newsletter_subscribers SET confirm_sent_at = now() WHERE id = $1', [s.id]);
    const url = confirmUrl(s.id);
    await email.send({
      to: address, subject: 'Confirm the RektBull weekly digest',
      text: `Confirm that you'd like RektBull Research's weekly digest at this address:\n${url}\n\nIf you didn't ask for it, ignore this email: nothing more will be sent.`,
      html: `<p>Confirm that you'd like RektBull Research's weekly digest at this address:</p><p><a href="${esc(url)}">Yes, send me the weekly digest</a></p><p style="color:#5d6673;font-size:12px">If you didn't ask for it, ignore this email: nothing more will be sent.</p>`,
    });
  }
  return { ok: true, message: 'Check your inbox: if this address isn\'t subscribed yet, a confirmation link is on its way.' };
}

async function confirm(id, token) {
  if (!valid('confirm', id, token)) return false;
  const { rowCount } = await db.query('UPDATE newsletter_subscribers SET confirmed_at = COALESCE(confirmed_at, now()) WHERE id = $1', [Number(id)]);
  return rowCount > 0;
}

/** Deletes the address. A valid link for an address already gone still counts as done. */
async function unsubscribe(id, token) {
  if (!valid('unsubscribe', id, token)) return false;
  await db.query('DELETE FROM newsletter_subscribers WHERE id = $1', [Number(id)]);
  return true;
}

/* ── the email ── */

/** The digest's Markdown as simple, escaped HTML (headings, lists, bold, paragraphs). */
function mdToHtml(md) {
  const out = [];
  let list = false;
  const inline = s => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  for (const raw of String(md || '').split('\n')) {
    const line = raw.trim();
    const item = line.match(/^[-*]\s+(.*)/);
    if (!item && list) { out.push('</ul>'); list = false; }
    if (!line) continue;
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) out.push(`<h${Math.min(4, h[1].length + 1)} style="margin:18px 0 6px">${inline(h[2])}</h${Math.min(4, h[1].length + 1)}>`);
    else if (item) { if (!list) { out.push('<ul style="padding-left:20px">'); list = true; } out.push(`<li>${inline(item[1])}</li>`); } else out.push(`<p style="margin:8px 0">${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('\n');
}

/** A sponsored post, set apart and labelled: as text, and as escaped HTML. */
const adText = s => `--- ${s.label}: ${s.sponsor} ---\n${s.headline}\n${s.body}\n${s.url} (${s.site})\n${s.disclosure}\n---`;
const adHtml = s => `<div style="border:1px solid #dde1e7;border-radius:12px;padding:12px 14px;margin:16px 0;background:#f6f7f9">
<p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#5d6673">${esc(s.label)} · ${esc(s.sponsor)}</p>
<p style="margin:0 0 4px;font-weight:700"><a href="${esc(s.url)}" style="color:#15181d">${esc(s.headline)}</a></p>
<p style="margin:0 0 4px">${esc(s.body)}</p>
<p style="margin:0;font-size:12px;color:#5d6673"><a href="${esc(s.url)}" style="color:#2346d6">${esc(s.site)}</a> · ${esc(s.disclosure)}</p>
</div>`;

function compose(d, subscriberId) {
  const when = new Date(`${d.week_start}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const page = `${env.publicUrl}/research?week=${d.week_start}`;
  const unsub = unsubscribeUrl(subscriberId);
  const body = d.text || d.facts.map(f => `- ${f.text} [${f.source}]`).join('\n');
  const ads = { top: (d.sponsored || []).filter(s => s.placement === 'top'), bottom: (d.sponsored || []).filter(s => s.placement === 'bottom') };
  const textAds = list => list.map(s => `\n${adText(s)}\n`).join('');
  const footer = `You get this because you subscribed at ${env.publicUrl.replace(/^https?:\/\//, '')}. Not financial advice.\n${env.operatorName}, ${env.operatorPostalAddress}`;
  return {
    subject: `RektBull Research: the week of ${when}`,
    text: `RektBull Research: the week of ${when}\n${d.byline}\n${textAds(ads.top)}\n${body}\n${textAds(ads.bottom)}\nRead it on the site, with every fact and its source: ${page}\n\n${footer}\nUnsubscribe: ${unsub}`,
    html: `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:600px;color:#15181d;line-height:1.55">
<p style="color:#2346d6;font-weight:700;margin:0">RektBull Research</p>
<h1 style="font-size:22px;margin:4px 0">The week of ${esc(when)}</h1>
<p style="color:#5d6673;font-size:13px;margin:0 0 12px">${esc(d.byline)}</p>
${ads.top.map(adHtml).join('\n')}
${mdToHtml(body)}
${ads.bottom.map(adHtml).join('\n')}
<p style="margin:20px 0"><a href="${esc(page)}" style="background:#2346d6;color:#fff;padding:10px 16px;border-radius:999px;text-decoration:none">Read it with every fact and its source</a></p>
<hr style="border:0;border-top:1px solid #dde1e7">
<p style="color:#5d6673;font-size:12px">${esc(footer).replace('\n', '<br>')}<br><a href="${esc(unsub)}">Unsubscribe</a> (one click; your address is deleted)</p>
</div>`,
    unsubscribeUrl: unsub,
  };
}

/** The worker's tick: sends the latest published digest to the next batch of confirmed subscribers. */
async function tick({ limit = env.newsletterPerTick } = {}) {
  if (!env.databaseUrl || !email.enabled()) return { sent: 0 };
  const { rows: [d] } = await db.query(
    `SELECT week_start FROM research_digests WHERE status = 'published' AND emailed_at IS NULL AND reviewed_at > now() - interval '7 days' ORDER BY week_start DESC LIMIT 1`,
  );
  if (!d) return { sent: 0 };
  if (!env.operatorPostalAddress) { logger.warn('newsletter: not sent, OPERATOR_POSTAL_ADDRESS is not set (commercial email must carry a postal address)'); return { sent: 0, blocked: 'no postal address' }; }
  const week = new Date(d.week_start).toISOString().slice(0, 10);
  const digest = await require('./research').digest(week);
  const { rows: subs } = await db.query(
    `SELECT s.id, s.email FROM newsletter_subscribers s
      WHERE s.confirmed_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM newsletter_sends n WHERE n.week_start = $1 AND n.subscriber_id = s.id)
      ORDER BY s.id LIMIT $2`, [week, limit],
  );
  if (!subs.length) {
    await db.query('UPDATE research_digests SET emailed_at = now() WHERE week_start = $1', [week]);
    logger.info('newsletter: finished sending', { week });
    return { sent: 0, finished: true };
  }
  let sent = 0;
  for (const s of subs) {
    let error = null;
    try { await email.send({ to: s.email, ...compose(digest, s.id) }); sent++; } catch (err) {
      error = err.message.slice(0, 300);
      if (err.permanent) await db.query('DELETE FROM newsletter_subscribers WHERE id = $1', [s.id]); // the address doesn't take mail
    }
    await db.query('INSERT INTO newsletter_sends (week_start, subscriber_id, error) SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM newsletter_subscribers WHERE id = $2) ON CONFLICT DO NOTHING', [week, s.id, error]);
  }
  return { sent, week };
}

async function counts() {
  const { rows: [c] } = await db.query('SELECT count(*) FILTER (WHERE confirmed_at IS NOT NULL)::int AS confirmed, count(*) FILTER (WHERE confirmed_at IS NULL)::int AS pending FROM newsletter_subscribers');
  return c;
}

module.exports = { subscribe, confirm, unsubscribe, tick, compose, mdToHtml, parseEmail, counts, confirmUrl, unsubscribeUrl, NewsletterRefused };
