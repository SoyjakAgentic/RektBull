/**
 * "At a glance": a few facts, rendered on the server into a data page, each
 * with its source and the time it was read. The pages' tables load by script,
 * which many crawlers (most AI ones among them) never run; this block gives
 * them, and anyone skimming, the page's key numbers in plain text.
 *
 * The facts come from the same cached services the page's own API calls use.
 * Each block is kept 5 minutes; a source that is slow (over 1.5 seconds) or
 * fails leaves the last good block, or none: the page is never held up.
 */
const logger = require('../config/logger');

const TTL = 5 * 60 * 1000;
const RETRY = 30 * 1000;
const WAIT = 1500;
const memo = new Map();

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = v => {
  if (v === null || v === undefined || Number.isNaN(v)) return 'not recorded';
  const a = Math.abs(v);
  const [d, s] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, ''];
  return `$${(v / d).toLocaleString('en-US', { maximumFractionDigits: d === 1 ? 0 : 1 })}${s}`;
};
const pct = v => (v === null || v === undefined ? null : `${v >= 0 ? 'up' : 'down'} ${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`);
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const day = iso => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Each page's facts: [{ text, source, href? }]. */
const FACTS = {
  async '/research'() {
    const research = require('../services/research');
    const [r, latest] = await Promise.all([
      research.hacks({ days: 90 }),
      require('../config/env').databaseUrl ? research.digest(null).catch(() => null) : null,
    ]);
    const label = { 30: 'In the last 30 days', 90: 'In the last 90 days', 365: 'In the last year' };
    const out = r.stats.map(s => ({ text: `${label[s.days] || `In the last ${s.days} days`}: ${usd(s.lost_usd)} lost in ${plural(s.count, 'recorded hack')}${s.unrecorded ? ` (${s.unrecorded} with no amount recorded)` : ''}${s.returned_usd ? `; ${usd(s.returned_usd)} returned` : ''}.`, source: r.source }));
    const top = r.techniques[0];
    if (top) out.push({ text: `The costliest way in over 90 days: ${top.technique}, ${usd(top.lost_usd)} across ${plural(top.count, 'hack')}.`, source: r.source });
    if (latest) out.push({ text: `The latest weekly digest covers the week of ${day(latest.week_start)}.`, source: 'RektBull Research', href: `/research/${latest.week_start}` });
    return out;
  },
  async '/markets'() {
    const markets = require('../services/markets');
    const [o, s] = await Promise.all([markets.overview(), markets.stablecoinList().catch(() => null)]);
    const out = [];
    if (o.tvl) out.push({ text: `Money locked in DeFi: ${usd(o.tvl.usd)}${pct(o.tvl.change_7d_pct) ? `, ${pct(o.tvl.change_7d_pct)} on the week` : ''}.`, source: o.sources.tvl });
    if (o.dex_volume) out.push({ text: `DEX trading in the last 24 hours: ${usd(o.dex_volume.usd_24h)}.`, source: o.sources.dex_volume });
    if (o.fees) out.push({ text: `Fees users paid in the last 24 hours: ${usd(o.fees.usd_24h)}.`, source: o.sources.fees });
    if (o.stablecoins) out.push({ text: `US dollar stablecoins: ${usd(o.stablecoins.usd)} in all${pct(o.stablecoins.change_7d_pct) ? `, ${pct(o.stablecoins.change_7d_pct)} on the week` : ''}.`, source: o.sources.stablecoins });
    if (s) {
      const flagged = s.stablecoins.filter(c => c.signals.some(x => x.level !== 'ok'));
      out.push({ text: flagged.length ? `${plural(flagged.length, 'stablecoin')} flagged (off peg by over 0.5%, or supply down 10% in a week): ${flagged.slice(0, 4).map(c => c.symbol).join(', ')}${flagged.length > 4 ? ' and more' : ''}.` : 'No large US dollar stablecoin is off its peg by over 0.5%, or down 10% in supply on the week.', source: s.source });
    }
    return out;
  },
  async '/agents'() {
    const r = await require('../services/agents').x402Services({ limit: 3 });
    const out = [{ text: `${plural(r.total, 'x402 service')} had 5 or more different payers in the last 30 days, from the busiest ${r.read.endpoints.toLocaleString('en-US')} of ${(r.read.listed || 0).toLocaleString('en-US')} listed endpoints.`, source: r.source }];
    if (r.services.length) out.push({ text: `Most used by different payers: ${r.services.map(s => `${s.name} (${s.payers_30d.toLocaleString('en-US')})`).join(', ')}.`, source: r.source });
    return out;
  },
  async '/discover'() {
    const r = await require('../services/discover').dapps({ sort: 'tvl', limit: 5 });
    return [
      { text: `Largest dapps by money locked: ${r.dapps.map(d => `${d.name} (${usd(d.tvl_usd)})`).join(', ')}.`, source: 'DefiLlama protocols' },
      { text: `${plural(r.total, 'dapp')} tracked, each with its hack and audit record.`, source: 'DefiLlama protocols and hacks' },
    ];
  },
};

function render(items, at) {
  const when = `${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}, ${at.toISOString().slice(11, 16)}`;
  return `<section class="card glance" aria-labelledby="glance-h">
      <h2 id="glance-h">At a glance</h2>
      <ul>
        ${items.map(i => `<li>${i.href ? `<a href="${esc(i.href)}">${esc(i.text)}</a>` : esc(i.text)} <span class="source">${esc(i.source)}</span></li>`).join('\n        ')}
      </ul>
      <p class="source">As of ${esc(when)} UTC. Facts from the sources named; none is advice.</p>
    </section>`;
}

const within = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms).unref())]);

/** The block for a page ('' if it has none, or none could be read). */
async function glance(route, now = Date.now()) {
  const fn = FACTS[route];
  if (!fn) return '';
  const hit = memo.get(route);
  if (hit && now < hit.until) return hit.html;
  try {
    const items = (await within(fn(), WAIT)).filter(i => i && i.text);
    const html = items.length ? render(items, new Date(now)) : '';
    memo.set(route, { html, until: now + TTL });
    return html;
  } catch (err) {
    logger.warn('at a glance: facts not read', { route, error: err.message });
    memo.set(route, { html: hit?.html || '', until: now + RETRY });
    return hit?.html || '';
  }
}

module.exports = { glance, FACTS, clear: () => memo.clear() };
