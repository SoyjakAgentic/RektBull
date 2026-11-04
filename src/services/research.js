/**
 * Research: the hack tracker and the weekly digest.
 *
 * The hack tracker is DefiLlama's record of exploits, newest first, with
 * totals and the techniques that keep recurring.
 *
 * The weekly digest is written in two steps, so the AI can't add anything:
 *   1. Facts: gathered from RektBull's own data (hacks that week, stablecoins
 *      off their peg or losing supply, DeFi's money and fees, the biggest
 *      movers among large dapps, live reward campaigns), each with its source.
 *      Stored as they were.
 *   2. Text: Claude writes those facts up, told to use only them, cite each
 *      fact's source, and never predict or recommend. With no AI available the
 *      digest is the facts alone; the page shows them either way.
 * One digest a week, for the Monday-to-Monday week (UTC) just ended; the
 * worker makes it on Monday from 06:00 UTC.
 */
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const llama = require('../providers/llama');

class ResearchRefused extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const DAY = 86400000;
const usd = v => {
  if (v === null || v === undefined) return 'an amount not recorded';
  const a = Math.abs(v);
  const [d, s] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, ''];
  return `$${(v / d).toLocaleString('en-US', { maximumFractionDigits: d === 1 ? 0 : 1 })}${s}`;
};
const iso = d => d.toISOString().slice(0, 10);

/** The Monday (UTC) of the week before the one `at` is in: the last full week. */
function lastWeek(at = new Date()) {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const thisMonday = new Date(d - ((d.getUTCDay() + 6) % 7) * DAY);
  return { start: new Date(thisMonday - 7 * DAY), end: thisMonday };
}

/* ── the hack tracker ── */

function parseHacks(q = {}) {
  const days = q.days === undefined ? 90 : Number(q.days);
  if (![30, 90, 365, 3650].includes(days)) return { error: 'days must be 30, 90, 365 or 3650' };
  const technique = q.technique ? String(q.technique).slice(0, 80) : null;
  return { days, technique };
}

async function hacks({ days = 90, technique = null } = {}, now = Date.now()) {
  let list;
  try { list = await llama.hackList(); } catch (err) { throw new ResearchRefused(`DefiLlama didn't answer (${err.message}). Try again in a minute.`, 503); }
  const since = d => iso(new Date(now - d * DAY));
  const sum = rows => rows.reduce((t, h) => t + (h.amount_usd || 0), 0);
  const window = d => list.filter(h => h.date && h.date >= since(d));
  const stats = [30, 90, 365].map(d => { const w = window(d); return { days: d, count: w.length, lost_usd: Math.round(sum(w)), returned_usd: Math.round(w.reduce((t, h) => t + (h.returned_usd || 0), 0)), unrecorded: w.filter(h => h.amount_usd === null).length }; });
  const inWindow = window(days);
  const byTech = {};
  for (const h of inWindow) {
    const k = h.technique || h.classification || 'Not recorded';
    (byTech[k] ||= { technique: k, count: 0, lost_usd: 0 }).count++;
    byTech[k].lost_usd += h.amount_usd || 0;
  }
  return {
    days, technique, stats,
    techniques: Object.values(byTech).sort((a, b) => b.lost_usd - a.lost_usd || b.count - a.count).slice(0, 10).map(t => ({ ...t, lost_usd: Math.round(t.lost_usd) })),
    hacks: inWindow.filter(h => !technique || (h.technique || h.classification || 'Not recorded') === technique).slice(0, 200),
    source: 'DefiLlama hacks (each exploit\'s date, amount, technique and funds returned)',
    note: 'An amount not recorded is shown as not recorded, never as zero. Not every exploit is recorded, and amounts are as reported at the time.',
  };
}

/* ── the weekly digest: facts first ── */

async function gatherFacts(start, end) {
  const facts = { week_start: iso(start), week_end: iso(end), items: [], not_checked: [] };
  const add = (section, text, source, data = {}) => facts.items.push({ section, text, source, ...data });
  const part = async (what, fn) => { try { await fn(); } catch (err) { facts.not_checked.push({ check: what, reason: err.message }); } };

  await part('hacks', async () => {
    const week = (await llama.hackList()).filter(h => h.date >= iso(start) && h.date < iso(end));
    const total = week.reduce((t, h) => t + (h.amount_usd || 0), 0);
    add('Hacks', week.length ? `${week.length} exploit${week.length === 1 ? '' : 's'} recorded, ${usd(total)} lost in all` : 'No exploit recorded this week', 'DefiLlama hacks', { count: week.length, lost_usd: Math.round(total) });
    for (const h of week.sort((a, b) => (b.amount_usd || 0) - (a.amount_usd || 0)).slice(0, 6)) {
      add('Hacks', `${h.name} (${h.date}): ${usd(h.amount_usd)} lost${h.technique ? `, ${h.technique}` : ''}${h.returned_usd ? `; ${usd(h.returned_usd)} returned` : ''}${h.chains.length ? `; ${h.chains.slice(0, 3).join(', ')}` : ''}`, 'DefiLlama hacks', { name: h.name });
    }
  });
  await part('DeFi totals', async () => {
    const o = await require('./markets').overview();
    if (o.tvl) add('Where the money is', `Money locked in DeFi: ${usd(o.tvl.usd)}, ${o.tvl.change_7d_pct >= 0 ? 'up' : 'down'} ${Math.abs(o.tvl.change_7d_pct)}% on the week`, o.sources.tvl);
    if (o.dex_volume) add('Where the money is', `DEX trading in the last 24 hours: ${usd(o.dex_volume.usd_24h)}`, o.sources.dex_volume);
    if (o.fees) add('Where the money is', `Fees users paid in the last 24 hours: ${usd(o.fees.usd_24h)}`, o.sources.fees);
    if (o.stablecoins) add('Stablecoins', `US dollar stablecoins: ${usd(o.stablecoins.usd)} in all, ${o.stablecoins.change_7d_pct >= 0 ? 'up' : 'down'} ${Math.abs(o.stablecoins.change_7d_pct)}% on the week`, o.sources.stablecoins);
    for (const n of o.not_checked) facts.not_checked.push(n);
  });
  await part('stablecoin pegs', async () => {
    const s = await require('./markets').stablecoinList({ limit: 40 });
    const flagged = s.stablecoins.filter(c => c.signals.some(x => x.level !== 'ok'));
    if (!flagged.length) add('Stablecoins', 'All of the 40 largest US dollar stablecoins were within 0.5% of their peg, with no supply down 10% in a week', s.source);
    for (const c of flagged.slice(0, 6)) add('Stablecoins', `${c.symbol} (${usd(c.supply_usd)} supply): ${c.signals.filter(x => x.level !== 'ok').map(x => x.text).join('; ')}`, s.source, { symbol: c.symbol });
  });
  await part('dapp movers', async () => {
    const d = await require('./discover').dapps({ limit: 100 });
    const moved = d.dapps.filter(x => x.change_7d_pct !== null && x.tvl_usd >= 5e8).sort((a, b) => a.change_7d_pct - b.change_7d_pct);
    for (const x of moved.slice(0, 3)) if (x.change_7d_pct < -5) add('Where the money is', `${x.name} (${x.category}): TVL ${usd(x.tvl_usd)}, down ${Math.abs(x.change_7d_pct)}% on the week`, 'DefiLlama protocols');
    for (const x of moved.slice(-3).reverse()) if (x.change_7d_pct > 5) add('Where the money is', `${x.name} (${x.category}): TVL ${usd(x.tvl_usd)}, up ${x.change_7d_pct}% on the week`, 'DefiLlama protocols');
  });
  await part('reward campaigns', async () => {
    const c = await require('./opportunities').campaigns({ limit: 3 });
    add('Reward campaigns', `${c.total} live reward campaigns with $50K or more in them on RektBull's six chains`, 'Merkl', { count: c.total });
    for (const x of c.campaigns) add('Reward campaigns', `${x.name} (${x.chain_name}): ${x.apr_pct}% extra rewards a year, ${usd(x.tvl_usd)} in it`, 'Merkl');
  });
  return facts;
}

const SYSTEM = `You write RektBull's weekly digest for crypto users, from a list of facts you are given.
Rules:
- Use only the facts given. Never add a fact, number, name, cause or context that isn't in them, and never guess.
- After each sentence that states a fact, put its source in brackets, exactly as given, e.g. "[DefiLlama hacks]".
- Never predict prices or outcomes, never recommend buying, selling, moving funds or voting, and never call anything safe.
- Plain English, short sentences, no hype. Numbers as given.
Write Markdown with these sections, in this order, leaving out any with no facts:
## The week in brief
(two or three sentences on what stands out, from the facts)
## Hacks
## Stablecoins
## Where the money is
## Reward campaigns
About 350 words in all.`;

async function writeUp(facts) {
  const claude = require('../ai/claude');
  if (!claude.available()) return { text: null, model: null };
  const prompt = `Week: ${facts.week_start} to ${facts.week_end} (UTC).\nFacts (section | fact | source):\n${facts.items.map(i => `- ${i.section} | ${i.text} | ${i.source}`).join('\n')}${facts.not_checked.length ? `\nNot checked this week (say so where it matters): ${facts.not_checked.map(n => `${n.check} (${n.reason})`).join('; ')}` : ''}`;
  const out = await claude.write({ system: SYSTEM, prompt, maxTokens: 1500 });
  return { text: out.text, model: out.model };
}

/** Makes (or remakes) the digest for the week starting `start`. */
async function makeDigest({ start, end } = lastWeek()) {
  const facts = await module.exports.gatherFacts(start, end);
  if (!facts.items.length) throw new ResearchRefused(`No facts could be gathered (${facts.not_checked.map(n => n.reason).join('; ')})`, 503);
  let written = { text: null, model: null };
  try { written = await writeUp(facts); } catch (err) { facts.not_checked.push({ check: 'the written summary', reason: err.message }); }
  await db.query(
    `INSERT INTO research_digests (week_start, week_end, facts, text, model) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (week_start) DO UPDATE SET facts = EXCLUDED.facts, text = EXCLUDED.text, model = EXCLUDED.model, created_at = now()`,
    [iso(start), iso(end), JSON.stringify(facts), written.text, written.model],
  );
  return digest(iso(start));
}

/** The worker's hourly tick: makes last week's digest once, from Monday 06:00 UTC. */
async function tick(now = new Date()) {
  if (!env.databaseUrl) return null;
  const week = lastWeek(now);
  if (now - week.end < 6 * 3600000) return null;
  const { rows } = await db.query('SELECT 1 FROM research_digests WHERE week_start = $1', [iso(week.start)]);
  if (rows.length) return null;
  logger.info('research: making the weekly digest', { week: iso(week.start) });
  return makeDigest(week);
}

const shape = r => (r ? {
  week_start: iso(new Date(r.week_start)), week_end: iso(new Date(r.week_end)),
  text: r.text, model: r.model, facts: r.facts.items, not_checked: r.facts.not_checked, made_at: r.created_at,
  note: r.text ? 'Written by AI from the facts below only; each fact names its source. Not advice.' : 'The facts for the week, each with its source. Not advice.',
} : null);

async function digest(week) {
  if (week && !/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new ResearchRefused('week must be a date (YYYY-MM-DD)');
  const { rows } = week
    ? await db.query('SELECT * FROM research_digests WHERE week_start = $1', [week])
    : await db.query('SELECT * FROM research_digests ORDER BY week_start DESC LIMIT 1');
  if (!rows.length) throw new ResearchRefused(week ? 'No digest for that week.' : 'No digest yet: the first is made on the Monday after launch.', 404);
  return shape(rows[0]);
}

async function digests() {
  const { rows } = await db.query('SELECT week_start, week_end, text IS NOT NULL AS written FROM research_digests ORDER BY week_start DESC LIMIT 52');
  return rows.map(r => ({ week_start: iso(new Date(r.week_start)), week_end: iso(new Date(r.week_end)), written: r.written }));
}

module.exports = { hacks, parseHacks, gatherFacts, makeDigest, tick, digest, digests, lastWeek, SYSTEM, ResearchRefused };
