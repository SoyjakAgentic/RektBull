/**
 * Meme coin proposals (docs/MEME_PROPOSALS.md): rules pick, the AI explains.
 *
 * 1. Watch: young coins on Base, BNB Chain and Solana, kept in a watchlist
 *    (meme_watchlist) from GeckoTerminal's newest and trending pools and the
 *    launchpads' just-graduated lists, each run. Trending lists alone are
 *    mostly coins months old, so the young ones have to be gathered over time.
 * 2. Rules (code, not AI): each watched coin's figures from DexScreener (30 a
 *    call). A coin passes only within the stated limits on liquidity, volume,
 *    buys, age, buying against selling and price moves (RULES below), with none
 *    of the warning signs its own trading shows. Passing coins are ranked by a
 *    stated score (turnover × buying pressure). Dead coins leave the watchlist.
 * 3. Checks: the top few are checked: GoPlus's flags (EVM), the mint's
 *    authorities (Solana), and for a coin under a week old the bundle and
 *    insider check. A failed check drops the coin, and so does a check that
 *    couldn't run: nothing unchecked is proposed.
 * 4. Explain: the cheap model (MEME_PROPOSAL_MODEL, Haiku by default) writes a
 *    short reason from those facts only. A reason naming a number that isn't
 *    in the facts is thrown away and a plain one from the facts is used
 *    (CLAUDE.md: never let AI fill gaps with guesses).
 * 5. Score: every coin that passed the rules is priced again 1 hour and 24
 *    hours later, the picks and all the rest, so the public scorecard compares
 *    the picks with everything the rules let through.
 *
 * Signals are shared: the AI cost grows with runs, not users. Nothing here
 * trades: a user acting on a proposal opens the Trade desk, whose checks run
 * again, and signs the trade themselves.
 */
const crypto = require('crypto');
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const gt = require('../providers/geckoterminal');
const dexscreener = require('../providers/dexscreener');
const fsettings = require('../forecasts/settings');

const CHAINS = ['base', 'bsc', 'solana'];
const CHAIN_NAMES = { base: 'Base', bsc: 'BNB Chain', solana: 'Solana' };
const DS = 'DexScreener (24-hour figures, all its pairs)';

/** The rules, in one place: the page and the docs show them as they are. */
const RULES = {
  min_age_hours: 1,          // no first-hour sniping
  max_age_days: 14,
  min_change_1h_pct: -10,    // not falling hard
  max_change_1h_pct: 50,     // and not a spike to chase
  max_change_24h_pct: 300,
  min_buy_ratio: 1.1,        // more buys than sells...
  max_buy_ratio: 4,          // ...but not the one-way buying a coin that can't be sold shows
  drop_after_hours: 6,       // a watched coin this old trading under a tenth of the volume minimum leaves the watchlist
};

const num = v => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
const round = (v, d = 2) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

/**
 * Whether one coin passes the rules, from its DexScreener figures (dexscreener.pairs):
 * { pass, why, facts, score }. `s` holds the admin-set thresholds
 * (meme_min_liquidity_usd, meme_min_volume_usd, meme_min_buys).
 */
function screen(p, s, now = Date.now()) {
  const ageH = p.created_at ? (now - Date.parse(p.created_at)) / 3600000 : null;
  const buys = num(p.buys_24h); const sells = num(p.sells_24h);
  const ratio = buys !== null && sells !== null ? buys / Math.max(1, sells) : null;
  const facts = {
    price_usd: num(p.price_usd), liquidity_usd: round(num(p.liquidity_usd), 0), volume_24h_usd: round(num(p.volume_24h_usd), 0),
    market_cap_usd: round(num(p.market_cap_usd), 0), change_1h_pct: round(num(p.change_1h_pct), 1), change_24h_pct: round(num(p.change_24h_pct), 1),
    buys_24h: buys, sells_24h: sells, age_hours: round(ageH, 1), buy_ratio: round(ratio, 2), source: DS,
  };
  const no = why => ({ pass: false, why, facts, score: 0 });
  if (!(facts.price_usd > 0)) return no('no price');
  if (ageH === null || ageH < RULES.min_age_hours) return no(`under ${RULES.min_age_hours} hour old`);
  if (ageH > RULES.max_age_days * 24) return no(`over ${RULES.max_age_days} days old`);
  if (!(facts.liquidity_usd >= s.meme_min_liquidity_usd)) return no(`liquidity under $${s.meme_min_liquidity_usd}`);
  if (!(facts.volume_24h_usd >= s.meme_min_volume_usd)) return no(`24-hour volume under $${s.meme_min_volume_usd}`);
  if (!(buys >= s.meme_min_buys)) return no(`under ${s.meme_min_buys} buys in 24 hours`);
  if (!(ratio >= RULES.min_buy_ratio)) return no('not more buys than sells');
  if (ratio > RULES.max_buy_ratio) return no('one-way buying');
  if (facts.change_1h_pct === null || facts.change_1h_pct < RULES.min_change_1h_pct || facts.change_1h_pct > RULES.max_change_1h_pct) return no('the last hour\'s move is outside the limits');
  if (facts.change_24h_pct !== null && facts.change_24h_pct > RULES.max_change_24h_pct) return no('up too far in 24 hours');
  const bad = require('../services/discover').poolSignals({ ...p, created_at: p.created_at }, now).filter(x => x.level === 'bad');
  if (bad.length) return no(bad[0].text);
  // Turnover (how much trades against the pool, capped at 10x) times buying pressure (capped at 3), nudged by the last hour.
  const score = Math.min(10, facts.volume_24h_usd / facts.liquidity_usd) * Math.min(3, ratio) * (1 + facts.change_1h_pct / 100);
  return { pass: true, facts, score: round(score, 4) };
}

/**
 * The safety checks on one pick, each naming its source: { ok, checks, why }.
 * A failed check, or one that couldn't run, means no proposal.
 */
async function checksFor(chain, token, ageHours) {
  const checks = [];
  if (chain === 'solana') {
    const got = (await require('../services/solanaLaunches').mintFlags([token]))[token] || { not_checked: 'the mint couldn\'t be read' };
    if (got.not_checked) return { ok: false, why: `the mint couldn't be checked: ${got.not_checked}`, checks };
    checks.push({ check: 'mint', flags: got.flags, source: got.source });
    if (got.flags.some(f => f.level === 'bad' || f.level === 'warn')) return { ok: false, why: got.flags[0].text, checks };
  } else {
    const f = await require('../services/discover').flags({ chain, token });
    if (f.not_checked) return { ok: false, why: `GoPlus couldn't be read: ${f.not_checked}`, checks };
    checks.push({ check: 'goplus', flags: f.flags, facts: f.facts, source: f.source });
    const bad = f.flags.filter(x => x.level === 'bad');
    if (bad.length) return { ok: false, why: bad[0].text, checks };
    if (f.facts.buy_tax_pct > 5 || f.facts.sell_tax_pct > 5) return { ok: false, why: 'a tax over 5%', checks };
  }
  if (ageHours < require('../services/launches').YOUNG_HOURS) {
    let r;
    try { r = await require('../services/launchSafety').check({ chain, token }); } catch (err) {
      return { ok: false, why: `the bundle check couldn't run: ${err.message}`, checks };
    }
    checks.push({ check: 'bundle', verdict: r.verdict, summary: r.summary, source: (r.sources || []).join('; ') || 'RektBull Launch Safety' });
    if (r.verdict === 'bundle_found') return { ok: false, why: 'a launch bundle was found', checks };
  }
  return { ok: true, checks };
}

/* ── the AI's explanation, from the facts only ── */

const EXPLAIN_SYSTEM = `You explain, for a crypto trader, why a set of rules picked a meme coin. You are given the facts the rules read and the safety checks it passed, each with its source.
Write from those facts only. Do not add news, opinions about the project, price targets or predictions, and no number that isn't in the facts.
Say plainly that most meme coins lose most of their value. Do not call the coin safe.
Answer with JSON only: {"reason": "two or three short sentences", "risks": ["short risk", ...]} with at most three risks, each from the facts or the checks.`;

/** Every number a text names, as written (1,234.5 → 1234.5). */
const numbersIn = text => [...String(text).matchAll(/\d[\d,]*(?:\.\d+)?/g)].map(m => Number(m[0].replace(/,/g, ''))).filter(n => !Number.isNaN(n));

/** Whether every number in the text is one of the facts' numbers, as given or as a whole number or the usual roundings. */
function onlyFactNumbers(text, facts) {
  const allowed = new Set();
  const add = v => {
    const n = Number(v); if (!Number.isFinite(n)) return;
    for (const x of [n, Math.abs(n), Math.round(n), Math.round(Math.abs(n)), round(Math.abs(n), 1), round(Math.abs(n), 2), Math.abs(n) / 1000, Math.abs(n) / 1e6, round(Math.abs(n) / 1000, 1), round(Math.abs(n) / 1e6, 1), round(Math.abs(n) / 1000, 0), round(Math.abs(n) / 1e6, 0)]) allowed.add(x);
  };
  const walk = o => { if (o && typeof o === 'object') Object.values(o).forEach(walk); else add(o); };
  walk(facts);
  [1, 7, 14, 24].forEach(add); // the rules' own periods: 1 hour, a week, 14 days, 24 hours
  return numbersIn(text).every(n => allowed.has(n));
}

/** A plain reason from the facts, when the AI's can't be used. */
function plainReason(f) {
  return `It passed RektBull's rules: $${Math.round(f.volume_24h_usd).toLocaleString('en-US')} traded in 24 hours against $${Math.round(f.liquidity_usd).toLocaleString('en-US')} of liquidity, ${f.buys_24h} buys to ${f.sells_24h} sells, ${f.change_1h_pct}% in the last hour (${DS}). Most meme coins lose most of their value.`;
}

async function explain(pick, checks) {
  const facts = { chain: CHAIN_NAMES[pick.chain], symbol: pick.symbol, ...pick.facts, checks: checks.map(c => ({ check: c.check, verdict: c.verdict, summary: c.summary, flags: c.flags?.map(x => x.text), source: c.source })) };
  const fallback = { reason: plainReason(pick.facts), risks: ['Most meme coins lose most of their value'], model: null, usd: 0 };
  if (!require('../ai/claude').available()) return fallback;
  let out;
  try {
    out = await require('../ai/claude').analyze({ model: env.memeProposalModel, system: EXPLAIN_SYSTEM, prompt: JSON.stringify(facts), maxTokens: 600, effort: 'low' });
  } catch (err) {
    logger.warn('meme explanation failed', { token: pick.token, error: err.message });
    return fallback;
  }
  const a = require('../forecasts/polymarket').lastJson(out.text);
  const reason = String(a?.reason || '').slice(0, 600);
  const risks = (Array.isArray(a?.risks) ? a.risks : []).map(r => String(r).slice(0, 160)).slice(0, 3);
  if (!reason || !onlyFactNumbers([reason, ...risks].join(' '), facts)) {
    logger.info('meme explanation dropped: empty, or a number not in the facts', { token: pick.token });
    return { ...fallback, model: out.model, usd: out.usd };
  }
  return { reason, risks, model: out.model, usd: out.usd };
}

/* ── the watchlist ── */

const norm = (chain, t) => (chain === 'solana' ? String(t || '') : String(t || '').toLowerCase());

const PACE = { ms: 2500 };
const pace = () => new Promise(r => setTimeout(r, PACE.ms));

/** Adds the coins seen in this run's sources to the watchlist; each source that couldn't be read is skipped and logged. */
async function gather() {
  let added = 0;
  const add = async (chain, token, symbol, source) => {
    token = norm(chain, token);
    if (!token || (chain !== 'solana' && !/^0x[0-9a-f]{40}$/.test(token))) return;
    const { rowCount } = await db.query('INSERT INTO meme_watchlist (chain, token, symbol, source) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [chain, token, symbol || null, source]);
    added += rowCount;
  };
  for (const chain of CHAINS) {
    const lists = [
      ['GeckoTerminal trending pools', () => gt.pools('trending', chain)],
      ['GeckoTerminal newest pools', () => gt.newPoolsPage(chain, 1)],
      ['GeckoTerminal newest pools', () => gt.newPoolsPage(chain, 2)],
    ];
    for (const [source, read] of lists) {
      await pace(); // GeckoTerminal's free plan allows about 30 calls a minute, shared with the live feed
      const pools = await read().catch(err => { logger.warn('meme watchlist: a source couldn\'t be read', { chain, source, error: err.message }); return []; });
      for (const p of pools) await add(chain, p.token?.address, p.token?.symbol, source);
    }
    // The launchpads' just-graduated coins (Virtuals, four.meme, pump.fun): the live feed's own reads.
    await pace();
    const live = await require('../services/liveLaunches').live({ chain }).catch(err => { logger.warn('meme watchlist: the live feed couldn\'t be read', { chain, error: err.message }); return null; });
    for (const i of live?.columns?.graduated?.items || []) await add(chain, i.agent_token || i.token, i.symbol, 'just graduated (the live feed)');
  }
  // Past 14 days: out.
  await db.query(`UPDATE meme_watchlist SET dropped_at = now() WHERE dropped_at IS NULL AND first_seen < now() - make_interval(days => $1)`, [RULES.max_age_days]);
  return added;
}

/** Every watched coin's figures, per chain from DexScreener; coins dead after `drop_after_hours` leave the watchlist. */
async function watched(s, now = Date.now()) {
  const { rows } = await db.query('SELECT chain, token, symbol FROM meme_watchlist WHERE dropped_at IS NULL ORDER BY first_seen DESC LIMIT 3000');
  const out = [];
  for (const chain of CHAINS) {
    const list = rows.filter(r => r.chain === chain);
    if (!list.length) continue;
    const got = await dexscreener.pairs(chain, list.map(r => r.token)).catch(err => { logger.warn('meme screen: DexScreener unreadable', { chain, error: err.message }); return null; });
    if (!got) continue;
    const dead = [];
    for (const r of list) {
      const p = got[r.token];
      if (!p) continue;
      const ageH = p.created_at ? (now - Date.parse(p.created_at)) / 3600000 : 0;
      if (ageH >= RULES.drop_after_hours && !(p.volume_24h_usd >= s.meme_min_volume_usd / 10)) { dead.push(r.token); continue; }
      out.push({ chain, token: r.token, symbol: p.symbol || r.symbol, name: p.name, pool: p.pair, stats: p });
    }
    if (dead.length) await db.query('UPDATE meme_watchlist SET dropped_at = now() WHERE chain = $1 AND token = ANY($2)', [chain, dead]);
  }
  return out;
}

/* ── one run ── */

/** Gathers, screens, checks, explains and stores one run; offers the picks while proposals are on. */
async function run(s = fsettings.get()) {
  const runId = crypto.randomUUID();
  const now = Date.now();
  await db.query('INSERT INTO meme_runs (id) VALUES ($1)', [runId]);
  const added = await gather();
  const passed = [];
  for (const c of await watched(s, now)) {
    const r = screen(c.stats, s, now);
    if (r.pass) passed.push({ chain: c.chain, token: c.token, symbol: c.symbol, name: c.name, pool: c.pool, ...r });
  }
  passed.sort((a, b) => b.score - a.score);
  // Each coin counts at most once a day: a coin picked in the last day isn't picked again, and one already kept
  // in the last day isn't kept again as one of "all the rest" (so busy coins don't weigh more in the comparison).
  const { rows: recent } = await db.query(`SELECT chain, token, bool_or(picked) AS picked FROM meme_signals WHERE created_at > now() - interval '24 hours' GROUP BY chain, token`);
  const recentSet = new Set(recent.filter(r => r.picked).map(r => `${r.chain}:${r.token}`));
  const keptSet = new Set(recent.map(r => `${r.chain}:${r.token}`));
  const picks = [];
  for (const c of passed) {
    if (picks.length >= s.meme_picks) break;
    if (recentSet.has(`${c.chain}:${c.token}`)) continue;
    const ck = await checksFor(c.chain, c.token, c.facts.age_hours).catch(err => ({ ok: false, why: err.message, checks: [] }));
    c.checks = ck.checks;
    if (!ck.ok) { c.dropped = ck.why; continue; }
    picks.push(c);
  }
  for (const p of picks) Object.assign(p, await explain(p, p.checks));
  const pickSet = new Set(picks);
  const stored = [];
  for (const c of passed) {
    const picked = pickSet.has(c);
    if (!picked && keptSet.has(`${c.chain}:${c.token}`)) continue;
    const { rows: [row] } = await db.query(
      `INSERT INTO meme_signals (run_id, chain, token, symbol, name, pool, picked, score, price_usd, facts, checks, reason, risks, model, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [runId, c.chain, c.token, c.symbol, c.name, c.pool, picked, c.score, c.facts.price_usd, JSON.stringify(c.facts), c.checks ? JSON.stringify(c.checks) : null,
        picked ? c.reason : null, picked ? JSON.stringify(c.risks) : null, picked ? c.model : null, picked ? c.usd : null]);
    if (picked) stored.push(row);
  }
  let offered = 0;
  if (s.meme_proposals) {
    const proposals = require('../forecasts/proposals');
    for (const sig of stored) {
      for (const sub of await proposals.subscribers('meme')) {
        const p = await proposals.offerSignal(sub.account_id, { signal: sig, priceUsd: s.meme_proposal_usd }).catch(err => { logger.error('meme proposal failed', { error: err.message }); return null; });
        if (p) offered++;
      }
    }
  }
  await db.query('UPDATE meme_runs SET finished_at = now(), added = $2, passed = $3, picked = $4, offered = $5 WHERE id = $1', [runId, added, passed.length, stored.length, offered]);
  logger.info('meme signals', { watched_added: added, passed: passed.length, picked: stored.length, offered });
  return { run_id: runId, added, passed: passed.length, picked: stored.length, offered, dropped: passed.filter(c => c.dropped).map(c => ({ token: c.token, why: c.dropped })) };
}

/* ── picks as the user sees them: the price now, and expiry ── */

/** Offered meme picks older than `meme_expiry_hours` expire (all accounts, or one). Returns how many. */
async function expire(accountId = null, s = fsettings.get()) {
  const { rowCount } = await db.query(`UPDATE ai_proposals p SET status = 'expired', acted_at = now()
    FROM meme_signals g WHERE g.id = p.signal_id AND p.venue = 'meme' AND p.status = 'offered'
      AND g.created_at < now() - make_interval(hours => $1) ${accountId ? 'AND p.account_id = $2' : ''}`,
  accountId ? [s.meme_expiry_hours, accountId] : [s.meme_expiry_hours]);
  return rowCount;
}

/**
 * The price now of each pick in a list of presented proposals (proposals.present), read from DexScreener in one
 * call per chain and cached a minute: adds { now: { price_usd, change_pct, source, read_at } }, or
 * { now: { not_checked } } when it couldn't be read. Picks that expired or were dismissed aren't priced.
 */
async function withPriceNow(list) {
  const picks = list.filter(p => p.venue === 'meme' && p.signal && ['offered', 'approved'].includes(p.status));
  const byChain = {};
  for (const p of picks) (byChain[p.chain] ||= new Set()).add(p.signal.token);
  const read = {};
  await Promise.all(Object.entries(byChain).map(async ([chain, set]) => {
    const tokens = [...set].sort();
    try {
      read[chain] = await require('../lib/cache').cached(`memes:now:${chain}:${tokens.join(',')}`, 60, async () => ({ prices: await dexscreener.prices(chain, tokens), read_at: new Date().toISOString() }));
    } catch (err) { read[chain] = { not_checked: `DexScreener couldn't be read: ${err.message}` }; }
  }));
  for (const p of picks) {
    const r = read[p.chain];
    const now = r?.prices?.[p.signal.token];
    if (r?.not_checked) p.now = { not_checked: r.not_checked };
    else if (!(now > 0)) p.now = { not_checked: 'DexScreener has no pair for it now', price_usd: 0 };
    else p.now = { price_usd: now, change_pct: round((now / p.signal.price_usd - 1) * 100, 1), source: 'DexScreener', read_at: r.read_at };
  }
  return list;
}

/* ── the scorecard ── */

/** Prices every signal again 1 hour and 24 hours after it, in batches per chain (DexScreener). */
async function score() {
  let n = 0;
  for (const [col, at, after] of [['price_1h', 'scored_1h_at', '1 hour'], ['price_24h', 'scored_24h_at', '24 hours']]) {
    const { rows } = await db.query(`SELECT id, chain, token FROM meme_signals WHERE ${at} IS NULL AND created_at <= now() - interval '${after}' AND created_at > now() - interval '${after}' - interval '6 hours' ORDER BY created_at LIMIT 300`);
    const byChain = {};
    for (const r of rows) (byChain[r.chain] ||= []).push(r);
    for (const [chain, list] of Object.entries(byChain)) {
      const prices = await dexscreener.prices(chain, [...new Set(list.map(r => r.token))]).catch(err => { logger.warn('meme score: DexScreener unreadable', { error: err.message }); return null; });
      if (!prices) continue;
      for (const r of list) {
        // A coin with no pair left has no price: it's scored as gone (0), which is what holders got.
        await db.query(`UPDATE meme_signals SET ${col} = $2, ${at} = now() WHERE id = $1`, [r.id, prices[r.token] ?? 0]);
        n++;
      }
    }
  }
  // Signals past the window that were never priced (the source was down the whole time) are closed without a price.
  await db.query(`UPDATE meme_signals SET scored_1h_at = now() WHERE scored_1h_at IS NULL AND created_at < now() - interval '7 hours'`);
  await db.query(`UPDATE meme_signals SET scored_24h_at = now() WHERE scored_24h_at IS NULL AND created_at < now() - interval '30 hours'`);
  return n;
}

/** The public scorecard: picks against every coin the rules let through, at 1 hour and 24 hours. */
async function trackRecord() {
  const { rows } = await db.query(`SELECT picked,
      COUNT(*) FILTER (WHERE price_1h IS NOT NULL)::int AS n_1h,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY price_1h / price_usd - 1) FILTER (WHERE price_1h IS NOT NULL)::float AS median_1h,
      AVG(CASE WHEN price_1h > price_usd THEN 1.0 ELSE 0 END) FILTER (WHERE price_1h IS NOT NULL)::float AS up_1h,
      COUNT(*) FILTER (WHERE price_24h IS NOT NULL)::int AS n_24h,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY price_24h / price_usd - 1) FILTER (WHERE price_24h IS NOT NULL)::float AS median_24h,
      AVG(CASE WHEN price_24h > price_usd THEN 1.0 ELSE 0 END) FILTER (WHERE price_24h IS NOT NULL)::float AS up_24h,
      AVG(CASE WHEN price_24h <= price_usd * 0.5 THEN 1.0 ELSE 0 END) FILTER (WHERE price_24h IS NOT NULL)::float AS halved_24h
    FROM meme_signals GROUP BY picked`);
  const pct = v => (v === null || v === undefined ? null : Math.round(v * 1000) / 10);
  const one = picked => {
    const r = rows.find(x => x.picked === picked) || {};
    return { scored_1h: r.n_1h || 0, median_1h_pct: pct(r.median_1h), up_1h_pct: pct(r.up_1h), scored_24h: r.n_24h || 0, median_24h_pct: pct(r.median_24h), up_24h_pct: pct(r.up_24h), halved_24h_pct: pct(r.halved_24h) };
  };
  const { rows: recent } = await db.query(`SELECT chain, token, symbol, price_usd, price_1h, price_24h, created_at FROM meme_signals
    WHERE picked AND scored_24h_at IS NOT NULL ORDER BY created_at DESC LIMIT 20`);
  return {
    picks: one(true), all_passed: one(false),
    recent: recent.map(r => ({
      chain: r.chain, token: r.token, symbol: r.symbol, picked_at: r.created_at,
      change_1h_pct: r.price_1h === null ? null : pct(Number(r.price_1h) / Number(r.price_usd) - 1),
      change_24h_pct: r.price_24h === null ? null : pct(Number(r.price_24h) / Number(r.price_usd) - 1),
    })),
    rules: RULES,
    how: 'Each pick\'s price when it was picked against its price 1 hour and 24 hours later (DexScreener; a coin with no pair left counts as 0). "All the rest" is every other coin the rules let through in the same runs, so the picks can be compared with the rules alone. Only picks scored at 24 hours are listed; newer ones stay private to the users they were offered to.',
    sources: [DS, 'GeckoTerminal\'s newest and trending pools, and the launchpads\' just-graduated coins (what is watched)'],
  };
}

/** One pass of the worker: score what's due, then run the rules when it's time. */
async function tick({ force = false } = {}) {
  const s = fsettings.get();
  if (!env.databaseUrl) return { off: true };
  const scored = await score().catch(err => { logger.warn('meme score failed', { error: err.message }); return 0; });
  await expire(null, s).catch(err => logger.warn('meme expiry failed', { error: err.message }));
  if (!s.memes) return { off: true, scored };
  // Due a refresh interval after the last run started, whether or not it picked anything (30 seconds' slack
  // for the worker's one-minute clock).
  const { rows: [last] } = await db.query('SELECT max(started_at) AS at FROM meme_runs');
  if (!force && last.at && Date.now() - new Date(last.at).getTime() < s.meme_refresh_minutes * 60000 - 30000) return { scored, ran: false };
  return { scored, ran: true, ...(await run(s)) };
}

module.exports = { PACE, tick, run, score, expire, withPriceNow, screen, gather, watched, checksFor, explain, onlyFactNumbers, numbersIn, plainReason, trackRecord, RULES, CHAINS, CHAIN_NAMES };
