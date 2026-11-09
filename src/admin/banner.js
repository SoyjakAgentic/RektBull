/**
 * A short notice on every page, set in the admin panel (maintenance, an
 * incident). Plain text only, and its link can only point inside RektBull,
 * so a hijacked admin session can't use it to send visitors elsewhere.
 */
const settings = require('./settings');

const MAX_TEXT = 200;
const LEVELS = ['info', 'warn'];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Checks an admin's banner: { text, level?, link?, until? }; returns what to store. */
function check(input = {}) {
  const text = String(input.text || '').replace(/\s+/g, ' ').trim();
  if (!text) throw Object.assign(new Error('The banner needs text.'), { status: 400 });
  if (text.length > MAX_TEXT) throw Object.assign(new Error(`Keep it to ${MAX_TEXT} characters.`), { status: 400 });
  const level = input.level || 'info';
  if (!LEVELS.includes(level)) throw Object.assign(new Error(`level must be ${LEVELS.join(' or ')}.`), { status: 400 });
  const link = input.link ? String(input.link).trim() : null;
  if (link && !/^\/[a-z0-9/_#?=&.-]*$/i.test(link)) throw Object.assign(new Error('The link must be a page on RektBull, starting with / (for example /about).'), { status: 400 });
  let until = null;
  if (input.until) {
    const t = new Date(input.until);
    if (Number.isNaN(t.getTime()) || t <= new Date() || t > new Date(Date.now() + 31 * 86400000)) throw Object.assign(new Error('until must be a time in the next 31 days.'), { status: 400 });
    until = t.toISOString();
  }
  return { text, level, ...(link ? { link } : {}), ...(until ? { until } : {}) };
}

/** The banner now, or null (none set, or past its end). */
function current() {
  const b = settings.get('banner');
  if (!b || (b.until && new Date(b.until) <= new Date())) return null;
  return b;
}

/** The banner's HTML, for the <!--#banner--> slot in the shared header. */
function html() {
  const b = current();
  if (!b) return '';
  return `<div class="site-banner ${b.level === 'warn' ? 'warn' : ''}" role="status"><div class="wrap">${esc(b.text)}${b.link ? ` <a href="${esc(b.link)}">More</a>` : ''}</div></div>`;
}

module.exports = { check, current, html, MAX_TEXT };
