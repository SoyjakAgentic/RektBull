/**
 * Research: the hack tracker and the weekly digest.
 *
 * The hack tracker is DefiLlama's record of exploits, newest first, with
 * totals and the techniques that keep recurring.
 *
 * The weekly digest is made the way Soyjak's content agents work (draft, a
 * separate check, then a person approves before anything is published), so
 * nothing in it rests on the AI's word:
 *   1. Facts: gathered from RektBull's own data, each with its source (the
 *      week's hacks; stablecoins off their peg or losing supply; DeFi's money
 *      and fees and the biggest movers; opportunities: new and large reward
 *      campaigns with their protocol's record, the best stablecoin rates on
 *      the venues RektBull reads, open votes in the DAOs it tracks). Stored
 *      as they were.
 *   2. Draft: the writer turns only those facts into the digest, citing each
 *      fact's source, never predicting or recommending.
 *   3. Fact-check: a separate pass removes every sentence the facts don't
 *      support, and any prediction or recommendation; what it removed is kept
 *      for the reviewer.
 *   4. Review: the owner is alerted, reads it on /research, may edit it, and
 *      publishes it or skips the week. Only then is it shown (as "Written by
 *      RektBull Research") and emailed to newsletter subscribers.
 * With no AI available, the facts alone can be published. One digest a week,
 * for the Monday-to-Monday week (UTC) just ended; the worker drafts it on
 * Monday from 06:00 UTC.
 */
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const llama = require('../providers/llama');

class ResearchRefused extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const DAY = 86400000;
const BYLINE = 'Written by RektBull Research';
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

/* ── 1. the facts ── */

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
  // Opportunities: the same three kinds as the Opportunities page (earn, rates, vote); claims are per wallet, so they're a link.
  await part('reward campaigns', async () => {
    const c = await require('./opportunities').campaigns({ limit: 100 });
    const caveat = x => { const bad = x.signals.filter(s => s.level === 'bad').map(s => s.text); return bad.length ? ` Note: ${bad.join('; ')}.` : ''; };
    const fresh = c.campaigns.filter(x => x.started_at && x.started_at >= iso(start) && x.started_at < iso(end));
    add('Opportunities', `${c.total} live reward campaigns with $50K or more in them on RektBull's six chains${fresh.length ? `, ${fresh.length} of them started this week` : ''}`, 'Merkl', { count: c.total });
    for (const x of fresh.slice(0, 3)) add('Opportunities', `New: ${x.name} (${x.chain_name}, ${x.action_label.toLowerCase()}): ${x.apr_pct}% extra rewards a year, ${usd(x.tvl_usd)} in it.${caveat(x)}`, 'Merkl; DefiLlama for the protocol\'s record');
    for (const x of c.campaigns.filter(y => !fresh.includes(y)).slice(0, 3)) add('Opportunities', `${x.name} (${x.chain_name}, ${x.action_label.toLowerCase()}): ${x.apr_pct}% extra rewards a year, ${usd(x.tvl_usd)} in it.${caveat(x)}`, 'Merkl; DefiLlama for the protocol\'s record');
  });
  await part('stablecoin rates', async () => {
    const rates = (await require('../yield/rates').listRates()).filter(r => r.apy_pct !== null && r.supply_open);
    for (const asset of ['USDC', 'USDT']) {
      const best = rates.filter(r => r.asset === asset).sort((a, b) => b.apy_pct - a.apy_pct)[0];
      if (best) add('Opportunities', `Highest ${asset} supply rate among the venues RektBull reads: ${best.name} on ${best.chain_label}, ${best.apy_pct}% a year (it changes with demand)`, best.source || `${best.name}'s contracts onchain`);
    }
  });
  await part('DAO votes', async () => {
    const governors = require('./governors');
    const open = [];
    for (const reg of governors.REGISTRY) {
      const g = await governors.readGovernor(reg.chain, reg.address).catch(() => null);
      if (!g) continue;
      for (const p of await governors.openProposals(g).catch(() => [])) if (p.state === 'Active') open.push({ gov: { ...g, name: reg.name }, p });
    }
    open.sort((a, b) => (a.p.hours_left ?? 1e9) - (b.p.hours_left ?? 1e9));
    if (!open.length) add('Opportunities', 'No onchain vote open in the DAOs RektBull tracks (Uniswap, Compound, ENS, Gitcoin, Hop, Arbitrum)', 'Each governor onchain');
    for (const { gov, p } of open.slice(0, 4)) add('Opportunities', `${gov.name} vote open: "${p.title}"${p.deadline?.at ? `, closing ${p.deadline.at.slice(0, 10)}${p.deadline.estimated ? ' (estimated)' : ''}` : ''}`, 'Each governor onchain');
  });
  return facts;
}

/* ── 2 and 3. the draft and the fact-check ── */

const SYSTEM = `You write RektBull Research's weekly digest for crypto users, from a list of facts you are given.
Rules:
- Use only the facts given. Never add a fact, number, name, cause or context that isn't in them, and never guess.
- After each sentence that states a fact, put its source in brackets, exactly as given, e.g. "[DefiLlama hacks]".
- Never predict prices or outcomes, never recommend buying, selling, moving funds, joining a campaign or voting, and never call anything safe. Opportunities are listed as facts, with any risk the facts mention.
- Plain English, short sentences, no hype. Numbers as given.
Write Markdown with these sections, in this order, leaving out any with no facts:
## The week in brief
(two or three sentences on what stands out, from the facts)
## Hacks
## Stablecoins
## Where the money is
## Opportunities
About 400 words in all.`;

const CHECK_SYSTEM = `You are RektBull Research's fact-checker. You get a draft digest and the facts it may use.
Return the draft exactly as written, except remove:
- any sentence that states something the facts don't support (a number, name, date, cause, comparison or claim not in them);
- any sentence that predicts, recommends an action, or calls something safe.
Don't add, reword or reorder anything else; keep headings and source brackets.
Reply with the checked draft, then a line containing only === REMOVED ===, then each removed sentence on its own line starting with "- ", or "- none".`;

const factLines = facts => facts.items.map(i => `- ${i.section} | ${i.text} | ${i.source}`).join('\n');

async function draftAndCheck(facts) {
  const claude = require('../ai/claude');
  const notes = [];
  if (!claude.available()) return { draft: null, checked: null, notes: [{ step: 'writing', reason: 'No AI is set up (ANTHROPIC_API_KEY): the facts can be published alone.' }] };
  let draft = null;
  try {
    const prompt = `Week: ${facts.week_start} to ${facts.week_end} (UTC).\nFacts (section | fact | source):\n${factLines(facts)}${facts.not_checked.length ? `\nNot checked this week (say so where it matters): ${facts.not_checked.map(n => `${n.check} (${n.reason})`).join('; ')}` : ''}`;
    draft = (await claude.write({ system: SYSTEM, prompt, maxTokens: 1600 })).text;
  } catch (err) { return { draft: null, checked: null, notes: [{ step: 'writing', reason: `The writer couldn't run (${err.message}): the facts can be published alone.` }] }; }
  let checked = null;
  try {
    const out = (await claude.write({ system: CHECK_SYSTEM, prompt: `Facts (section | fact | source):\n${factLines(facts)}\n\nDraft:\n${draft}`, maxTokens: 2000 })).text;
    const at = out.indexOf('=== REMOVED ===');
    if (at === -1) throw new Error('its answer wasn\'t in the expected form');
    checked = out.slice(0, at).trim();
    for (const line of out.slice(at + 15).split('\n').map(l => l.trim()).filter(l => l.startsWith('- ') && l !== '- none')) notes.push({ step: 'fact-check', removed: line.slice(2) });
    if (!checked) throw new Error('it returned nothing');
  } catch (err) { checked = null; notes.push({ step: 'fact-check', reason: `The fact-check couldn't run (${err.message}): review the draft closely.` }); }
  return { draft, checked, notes };
}

/* ── 4. review ── */

async function notifyOwners(week) {
  const { rows } = await db.query('SELECT id, wallet FROM accounts WHERE wallet = ANY($1::text[])', [env.adminWallets]);
  const raised = [];
  for (const a of rows) {
    const { rows: ins } = await db.query(
      `INSERT INTO monitor_alerts (account_id, wallet, kind, severity, title, detail, dedupe_key)
       VALUES ($1, $2, 'digest_draft', 'medium', $3, $4, $5) ON CONFLICT (account_id, dedupe_key) DO NOTHING RETURNING id`,
      [a.id, a.wallet, `Weekly digest ready for review: week of ${week}`, JSON.stringify({ reasons: [{ text: 'Read it, edit it if you like, then publish it or skip the week. Nothing goes out until you do.', source: 'RektBull Research' }], week }), `digest:${week}`],
    );
    if (ins.length) raised.push(ins[0].id);
  }
  if (raised.length) await require('../alerts/dispatch').enqueue(raised);
  return raised.length;
}

/** Drafts (or redrafts) the digest for the week starting `start`. A published week isn't redrafted. */
async function makeDigest({ start, end } = lastWeek()) {
  const { rows: had } = await db.query('SELECT status FROM research_digests WHERE week_start = $1', [iso(start)]);
  if (had[0]?.status === 'published') throw new ResearchRefused('That week\'s digest is already published.', 409);
  const facts = await module.exports.gatherFacts(start, end);
  if (!facts.items.length) throw new ResearchRefused(`No facts could be gathered (${facts.not_checked.map(n => n.reason).join('; ')})`, 503);
  const { draft, checked, notes } = await draftAndCheck(facts);
  await db.query(
    `INSERT INTO research_digests (week_start, week_end, facts, draft, checked, check_notes, status) VALUES ($1, $2, $3, $4, $5, $6, 'draft')
     ON CONFLICT (week_start) DO UPDATE SET facts = EXCLUDED.facts, draft = EXCLUDED.draft, checked = EXCLUDED.checked, check_notes = EXCLUDED.check_notes,
       status = 'draft', created_at = now(), reviewed_at = NULL, reviewed_by = NULL`,
    [iso(start), iso(end), JSON.stringify(facts), draft, checked, JSON.stringify(notes)],
  );
  await notifyOwners(iso(start)).catch(err => logger.warn('research: couldn\'t alert the owner', { error: err.message }));
  return draftView(iso(start));
}

/** The worker's hourly tick: drafts last week's digest once, from Monday 06:00 UTC. */
async function tick(now = new Date()) {
  if (!env.databaseUrl) return null;
  const week = lastWeek(now);
  if (now - week.end < 6 * 3600000) return null;
  const { rows } = await db.query('SELECT 1 FROM research_digests WHERE week_start = $1', [iso(week.start)]);
  if (rows.length) return null;
  logger.info('research: drafting the weekly digest', { week: iso(week.start) });
  return makeDigest(week);
}

const MAX_TEXT = 20000;

async function publish(week, { text, accountId }) {
  const { rows: [d] } = await db.query('SELECT * FROM research_digests WHERE week_start = $1', [week]);
  if (!d) throw new ResearchRefused('No digest for that week.', 404);
  if (d.status === 'published') throw new ResearchRefused('That week\'s digest is already published.', 409);
  let final = text === undefined ? (d.checked ?? d.draft) : text;
  if (final !== null && typeof final !== 'string') throw new ResearchRefused('text must be the digest\'s Markdown, or null for the facts alone');
  if (typeof final === 'string') { final = final.trim() || null; if (final && final.length > MAX_TEXT) throw new ResearchRefused(`The digest is over ${MAX_TEXT} characters.`); }
  await db.query(`UPDATE research_digests SET text = $2, status = 'published', reviewed_at = now(), reviewed_by = $3 WHERE week_start = $1`, [week, final, accountId]);
  logger.info('research: digest published', { week, edited: text !== undefined && text !== (d.checked ?? d.draft) });
  return digest(week);
}

async function skip(week, { accountId }) {
  const { rowCount } = await db.query(`UPDATE research_digests SET status = 'skipped', reviewed_at = now(), reviewed_by = $2 WHERE week_start = $1 AND status = 'draft'`, [week, accountId]);
  if (!rowCount) throw new ResearchRefused('No draft for that week.', 404);
  return { week_start: week, status: 'skipped' };
}

/* ── reading ── */

const shape = r => (r ? {
  week_start: iso(new Date(r.week_start)), week_end: iso(new Date(r.week_end)),
  byline: BYLINE, text: r.text, facts: r.facts.items, not_checked: r.facts.not_checked,
  published_at: r.reviewed_at,
  note: r.text ? 'From the facts below, each with its source. Not advice.' : 'The facts for the week, each with its source. Not advice.',
} : null);

async function digest(week) {
  if (week && !/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new ResearchRefused('week must be a date (YYYY-MM-DD)');
  const { rows } = week
    ? await db.query(`SELECT * FROM research_digests WHERE week_start = $1 AND status = 'published'`, [week])
    : await db.query(`SELECT * FROM research_digests WHERE status = 'published' ORDER BY week_start DESC LIMIT 1`);
  if (!rows.length) throw new ResearchRefused(week ? 'No digest for that week.' : 'No digest yet: the first is published the Monday after launch.', 404);
  const d = shape(rows[0]);
  return { ...d, sponsored: await require('./sponsored').forWeek(d.week_start) };
}

async function digests() {
  const { rows } = await db.query(`SELECT week_start, week_end, text IS NOT NULL AS written, reviewed_at FROM research_digests WHERE status = 'published' ORDER BY week_start DESC LIMIT 52`);
  return rows.map(r => ({ week_start: iso(new Date(r.week_start)), week_end: iso(new Date(r.week_end)), written: r.written, published_at: r.reviewed_at, url: `/research/${iso(new Date(r.week_start))}` }));
}

/** For the owner: a draft with everything needed to review it. */
async function draftView(week) {
  const { rows: [r] } = await db.query('SELECT * FROM research_digests WHERE week_start = $1', [week]);
  if (!r) throw new ResearchRefused('No digest for that week.', 404);
  return { ...shape(r), status: r.status, draft: r.draft, checked: r.checked, check_notes: r.check_notes, made_at: r.created_at, sponsored: await require('./sponsored').forWeek(week, { admin: true }) };
}

async function drafts() {
  const { rows } = await db.query(`SELECT week_start FROM research_digests WHERE status = 'draft' ORDER BY week_start DESC LIMIT 4`);
  return Promise.all(rows.map(r => draftView(iso(new Date(r.week_start)))));
}

module.exports = { hacks, parseHacks, gatherFacts, draftAndCheck, makeDigest, tick, publish, skip, digest, digests, drafts, draftView, lastWeek, SYSTEM, CHECK_SYSTEM, BYLINE, ResearchRefused };
