/**
 * Sponsored posts in the weekly digest, added by the owner.
 *
 * - At most two a week: one above the digest, one below. Plain text (a
 *   headline, up to 400 characters and a link), always labelled "Sponsored",
 *   naming who paid, kept apart from the digest (the writer and fact-check
 *   never see them).
 * - Added or changed only while the week is a draft; fixed once published.
 * - The link must be https, and is checked against GoPlus's phishing list
 *   when it's added (a listed link, or one that couldn't be checked, is
 *   refused) and again on every click: links go through RektBull's own
 *   redirect, which stops sending people to a site listed since.
 * - Each post is confirmed as not a promotion to buy, sell or invest in a
 *   cryptoasset (see docs/LAUNCH_PLAN.md: those are regulated in the UK and EU).
 * - Clicks are a plain count. Nothing about who clicked is kept.
 */
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');

class SponsoredRefused extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const LIMITS = { sponsor: 60, headline: 90, body: 400, url: 500 };
const PLACEMENTS = ['top', 'bottom'];
const LABEL = 'Sponsored';
const DISCLOSURE = 'A paid placement. Not checked or endorsed by RektBull, and not advice.';

const clickUrl = id => `${env.publicUrl}/v1/research/sponsored/${id}`;
const plain = s => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Validates what the owner typed. Returns { error } or the clean post. */
function parse(body = {}) {
  const placement = String(body.placement || '');
  if (!PLACEMENTS.includes(placement)) return { error: 'placement must be top or bottom' };
  const post = { placement };
  for (const k of ['sponsor', 'headline', 'body']) {
    post[k] = plain(body[k]);
    if (!post[k]) return { error: `${k} is needed` };
    if (post[k].length > LIMITS[k]) return { error: `${k} is over ${LIMITS[k]} characters` };
  }
  let url;
  try { url = new URL(String(body.url || '').trim()); } catch { return { error: 'url must be a full https:// link' }; }
  if (url.protocol !== 'https:') return { error: 'url must be a full https:// link' };
  if (url.username || url.password) return { error: 'url must not carry a username or password' };
  if (url.href.length > LIMITS.url) return { error: `url is over ${LIMITS.url} characters` };
  post.url = url.href;
  if (body.not_investment !== true) return { error: 'Confirm it isn\'t a promotion to buy, sell or invest in a cryptoasset (token, presale, staking or yield product).' };
  return post;
}

/** GoPlus's phishing list on the link's site. Throws if the check can't run. */
async function checkLink(url) {
  const r = await require('../providers/goplus').phishingSite(new URL(url).origin);
  return { phishing: r.phishing, source: r.source, checked_at: new Date().toISOString() };
}

async function draftWeek(week) {
  const { rows: [d] } = await db.query('SELECT status FROM research_digests WHERE week_start = $1', [week]);
  if (!d) throw new SponsoredRefused('No digest for that week.', 404);
  if (d.status !== 'draft') throw new SponsoredRefused(`That week's digest is ${d.status}: sponsored posts are fixed once it's reviewed.`, 409);
}

/** Adds (or replaces) the post at one placement in a week's draft. */
async function put(week, post, { accountId }) {
  await draftWeek(week);
  let check;
  try { check = await checkLink(post.url); } catch (err) {
    throw new SponsoredRefused(`The link couldn't be checked against GoPlus's phishing list (${err.message}). Try again shortly.`, 503);
  }
  if (check.phishing) throw new SponsoredRefused(`GoPlus's phishing list has ${new URL(post.url).hostname}. It can't be used.`, 422);
  const { rows: [r] } = await db.query(
    `INSERT INTO research_sponsored (week_start, placement, sponsor, headline, body, url, link_check, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (week_start, placement) DO UPDATE SET sponsor = EXCLUDED.sponsor, headline = EXCLUDED.headline, body = EXCLUDED.body, url = EXCLUDED.url,
       link_check = EXCLUDED.link_check, created_by = EXCLUDED.created_by, created_at = now(), clicks = 0
     RETURNING *`,
    [week, post.placement, post.sponsor, post.headline, post.body, post.url, JSON.stringify(check), accountId],
  );
  logger.info('research: sponsored post set', { week, placement: post.placement, sponsor: post.sponsor });
  return adminView(r);
}

async function remove(week, placement) {
  await draftWeek(week);
  const { rowCount } = await db.query('DELETE FROM research_sponsored WHERE week_start = $1 AND placement = $2', [week, placement]);
  if (!rowCount) throw new SponsoredRefused('No sponsored post there.', 404);
  return { removed: true };
}

const host = url => new URL(url).hostname.replace(/^www\./, '');

/** As readers see it: the label, who paid, the text, the site's name and the counted link. */
const publicView = r => ({ id: Number(r.id), placement: r.placement, label: LABEL, disclosure: DISCLOSURE, sponsor: r.sponsor, headline: r.headline, body: r.body, site: host(r.url), url: clickUrl(r.id) });
const adminView = r => ({ ...publicView(r), target: r.url, link_check: r.link_check, clicks: r.clicks });

/** A week's posts, top first. */
async function forWeek(week, { admin = false } = {}) {
  const { rows } = await db.query(`SELECT * FROM research_sponsored WHERE week_start = $1 ORDER BY placement DESC`, [week]);
  return rows.map(admin ? adminView : publicView);
}

/** For the owner: every post, newest week first, with clicks and how many it was emailed to. */
async function report() {
  const { rows } = await db.query(
    `SELECT s.*, d.status, (SELECT count(*)::int FROM newsletter_sends n WHERE n.week_start = s.week_start AND n.error IS NULL) AS emailed_to
       FROM research_sponsored s JOIN research_digests d USING (week_start) ORDER BY s.week_start DESC, s.placement DESC LIMIT 100`,
  );
  return rows.map(r => ({ week_start: r.week_start.toISOString().slice(0, 10), status: r.status, emailed_to: r.emailed_to, ...adminView(r) }));
}

/**
 * A click: where to send the reader, after checking the link again. Counted
 * only for a published week. A link listed since it was added isn't followed;
 * if the check can't run now, the one made when it was added stands.
 */
async function follow(id) {
  if (!/^\d{1,15}$/.test(String(id))) return { status: 404 };
  const { rows: [r] } = await db.query(
    `SELECT s.id, s.url FROM research_sponsored s JOIN research_digests d USING (week_start) WHERE s.id = $1 AND d.status = 'published'`, [id],
  );
  if (!r) return { status: 404 };
  const now = await checkLink(r.url).catch(err => { logger.warn('sponsored: link re-check failed', { id, error: err.message }); return null; });
  if (now?.phishing) {
    logger.warn('sponsored: link now on a phishing list, not followed', { id, url: r.url });
    return { status: 410, site: host(r.url), source: now.source };
  }
  await db.query('UPDATE research_sponsored SET clicks = clicks + 1 WHERE id = $1', [id]);
  return { status: 302, url: r.url };
}

module.exports = { parse, put, remove, forWeek, report, follow, clickUrl, publicView, LABEL, DISCLOSURE, LIMITS, SponsoredRefused };
