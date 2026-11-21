/**
 * AI forecasts on Polymarket (docs/AI_PROPOSALS.md).
 *
 * 1. Screen: the cheap model (FORECAST_SCREEN_MODEL) reads the busiest open
 *    markets in groups of 20, from Polymarket's own data only, gives each a
 *    probability and flags the few worth researching.
 * 2. Research: the stronger model (FORECAST_MODEL) researches each flagged
 *    market with web search, at most `research_per_day` a day. A forecast
 *    keeps only sources the search actually returned; one with no real source
 *    is dropped, never stored as a guess.
 * 3. Propose: a researched forecast whose probability beats the market price by
 *    `edge_pct` points or more, at medium or high confidence, is offered to
 *    the users who asked for proposals (forecasts/proposals.js), only while
 *    `polymarket_proposals` is on.
 * 4. Resolve: once a market resolves, each forecast on it is scored (Brier
 *    score) against the market's own price when the forecast was made. The
 *    track record is public.
 *
 * Each forecast is made once per market and shared, so the cost grows with
 * the markets read, not with users. Nothing here trades.
 */
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const markets = require('../polymarket/markets');
const fsettings = require('./settings');
const proposals = require('./proposals');

const GROUP = 20;
const SOURCE = 'Polymarket\'s Gamma API';

/** The last JSON object or array in a model's answer (in a ```json block, or bare). */
function lastJson(text) {
  const blocks = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1]);
  for (const c of [...blocks.reverse(), text]) {
    const s = String(c).trim();
    // Whichever comes first is the outer value: an object can hold an array (its sources), and an array objects.
    const pairs = [['[', ']'], ['{', '}']].filter(([o]) => s.includes(o)).sort((x, y) => s.indexOf(x[0]) - s.indexOf(y[0]));
    for (const [open, close] of pairs) {
      const i = s.indexOf(open); const j = s.lastIndexOf(close);
      if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch { /* try the next */ } }
    }
  }
  return null;
}
const prob = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 1 ? Math.round(n * 10000) / 10000 : null; };

/** The binary markets the screen reads: open, taking orders, ending after tomorrow, busiest first. */
async function candidates(limit) {
  const out = [];
  for (let offset = 0; out.length < limit && offset < limit * 3; offset += 50) {
    const page = await markets.browse({ limit: 50, offset });
    for (const e of page.events) {
      for (const m of e.markets) {
        if (out.length >= limit) break;
        const o = m.outcomes[0];
        if (!m.accepting_orders || m.outcomes.length !== 2 || !o?.asset_id || !(o.price > 0 && o.price < 1)) continue;
        if (m.end_date && Date.parse(m.end_date) < Date.now() + 86400000) continue;
        out.push({ slug: m.slug, question: m.question, outcome: o.name, asset_id: o.asset_id, other: m.outcomes[1], price: o.price, end_date: m.end_date, volume_24h_usd: m.volume_24h_usd, event: e.title });
      }
    }
    if (!page.events.length) break;
  }
  return out;
}

const SCREEN_SYSTEM = `You are a careful forecaster screening prediction markets. For each market, estimate the probability that the named outcome happens, from what you know and from base rates. You have no web access here: if you aren't sure, give a probability close to the market price and do not flag it. Flag "research": true only for the few markets where you have a concrete reason to think the price is materially wrong (at least 8 points), and say the reason in a few words. Never invent facts. Answer with a JSON array only: [{"slug": "...", "prob": 0.0-1.0, "research": true|false, "why": "..."}].`;

async function screen(c, s) {
  const claude = require('../ai/claude');
  const list = await candidates(s.markets);
  const made = [];
  for (let i = 0; i < list.length; i += GROUP) {
    const group = list.slice(i, i + GROUP);
    const prompt = `Today is ${new Date().toISOString().slice(0, 10)}. Markets (price = the market's probability for the named outcome):\n` +
      JSON.stringify(group.map(m => ({ slug: m.slug, question: m.question, outcome: m.outcome, price: m.price, ends: m.end_date, event: m.event })));
    let out;
    try { out = await claude.analyze({ model: env.forecastScreenModel, system: SCREEN_SYSTEM, prompt, maxTokens: 4000, effort: 'low' }); } catch (err) {
      logger.warn('forecast screen failed', { error: err.message }); continue;
    }
    const answers = lastJson(out.text);
    if (!Array.isArray(answers)) { logger.warn('forecast screen: no JSON array in the answer'); continue; }
    const each = out.usd / group.length;
    for (const a of answers) {
      const m = group.find(x => x.slug === a?.slug);
      const p = prob(a?.prob);
      if (!m || p === null) continue;
      const { rows: [f] } = await db.query(
        `INSERT INTO ai_forecasts (venue, stage, market, question, outcome, asset_id, ai_prob, market_prob, research, reasoning, model, cost_usd)
         VALUES ('polymarket', 'screen', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [m.slug, m.question, m.outcome, m.asset_id, p, m.price, !!a.research, String(a.why || '').slice(0, 500), out.model, each],
      );
      made.push({ ...f, candidate: m });
    }
  }
  return made;
}

const RESEARCH_SYSTEM = `You are a superforecaster. Research the market with web search, read its resolution rules closely, weigh base rates and the latest evidence, and estimate the probability that the named outcome happens by the market's rules. Cite only pages your searches returned. If the evidence is thin, say so and keep the probability near the market price with low confidence. Never invent facts. End with a JSON object in a \`\`\`json block: {"prob": 0.0-1.0, "confidence": "low"|"medium"|"high", "reasoning": "at most 120 words", "resolution_notes": "how the rules decide it", "sources": ["https://..."]}.`;

/** Researches one market; returns the stored forecast, or null when there was no real source. */
async function research(m, s) {
  const claude = require('../ai/claude');
  const detail = await markets.marketBySlug(m.slug).catch(() => null);
  const rules = detail?.market?.description || '(the rules couldn\'t be read)';
  const prompt = `Today is ${new Date().toISOString().slice(0, 10)}.\nMarket: ${m.question}\nOutcome to forecast: ${m.outcome}\nMarket price for it: ${m.price}\nEnds: ${m.end_date || 'not set'}\nResolution rules (from Polymarket): ${String(rules).slice(0, 4000)}`;
  const out = await claude.analyze({ model: env.forecastModel, system: RESEARCH_SYSTEM, prompt, maxTokens: 8000, webSearches: s.web_searches, effort: 'medium' });
  const a = lastJson(out.text);
  const p = prob(a?.prob);
  const seen = new Set(out.urls);
  const sources = (Array.isArray(a?.sources) ? a.sources : []).filter(u => seen.has(u)).slice(0, 8); // only what the search returned
  const confidence = ['low', 'medium', 'high'].includes(a?.confidence) ? a.confidence : 'low';
  if (p === null || !sources.length) {
    logger.info('forecast research dropped: no probability or no real source', { market: m.slug });
    return null;
  }
  const reasoning = `${String(a.reasoning || '').slice(0, 1200)}${a.resolution_notes ? `\nHow it resolves: ${String(a.resolution_notes).slice(0, 600)}` : ''}`;
  const { rows: [f] } = await db.query(
    `INSERT INTO ai_forecasts (venue, stage, market, question, outcome, asset_id, ai_prob, market_prob, confidence, reasoning, sources, model, cost_usd)
     VALUES ('polymarket', 'research', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [m.slug, m.question, m.outcome, m.asset_id, p, m.price, confidence, reasoning, JSON.stringify(sources), out.model, out.usd],
  );
  return f;
}

/** What to propose from a researched forecast: buy the outcome the AI favours, if the edge is big enough. */
function proposalFor(f, m, s) {
  if (!['medium', 'high'].includes(f.confidence)) return null;
  const p = Number(f.ai_prob); const price = Number(f.market_prob); const need = s.edge_pct / 100;
  if (p - price >= need) return { side: m.outcome, assetId: m.asset_id, priceLimit: Math.round((p - need) * 1000) / 1000 };
  if (price - p >= need && m.other?.asset_id) return { side: m.other.name, assetId: m.other.asset_id, priceLimit: Math.round((1 - p - need) * 1000) / 1000 };
  return null;
}

async function propose(f, m, s) {
  const plan = proposalFor(f, m, s);
  if (!plan) return 0;
  let n = 0;
  for (const sub of await proposals.subscribers('polymarket')) {
    const p = await proposals.offer(sub.account_id, { forecast: f, side: plan.side, assetId: plan.assetId, priceLimit: plan.priceLimit, priceUsd: s.proposal_usd }).catch(err => { logger.error('AI proposal failed', { error: err.message }); return null; });
    if (p) n++;
  }
  return n;
}

/** Scores forecasts on markets that have resolved: 1 if the outcome happened, 0 if not. */
async function resolve() {
  const { rows } = await db.query(`SELECT DISTINCT market FROM ai_forecasts WHERE venue = 'polymarket' AND resolved_at IS NULL AND created_at < now() - interval '1 hour' LIMIT 100`);
  let n = 0;
  for (const { market } of rows) {
    const detail = await markets.marketBySlug(market).catch(() => null);
    const m = detail?.market;
    if (!m?.closed) continue;
    for (const o of m.outcomes) {
      const v = o.price >= 0.99 ? 1 : o.price <= 0.01 ? 0 : null;
      if (v === null) continue;
      const { rowCount } = await db.query(
        `UPDATE ai_forecasts SET resolved_value = $3, resolved_at = now(), brier_ai = power(ai_prob - $3, 2), brier_market = CASE WHEN market_prob IS NULL THEN NULL ELSE power(market_prob - $3, 2) END
         WHERE venue = 'polymarket' AND market = $1 AND outcome = $2 AND resolved_at IS NULL`, [market, o.name, v]);
      n += rowCount;
    }
  }
  return n;
}

/** One pass of the worker: score what resolved, then screen, research and propose when it's time. */
async function tick({ force = false } = {}) {
  const s = fsettings.get();
  if (!s.polymarket || !env.databaseUrl) return { off: true };
  const resolved = await resolve().catch(err => { logger.warn('forecast resolve failed', { error: err.message }); return 0; });
  const { rows: [last] } = await db.query(`SELECT max(created_at) AS at FROM ai_forecasts WHERE venue = 'polymarket' AND stage = 'screen'`);
  if (!force && last.at && Date.now() - new Date(last.at).getTime() < s.refresh_hours * 3600000) return { resolved, screened: 0 };
  const screened = await screen(null, s);
  const { rows: [{ n: doneToday }] } = await db.query(`SELECT COUNT(*)::int AS n FROM ai_forecasts WHERE venue = 'polymarket' AND stage = 'research' AND created_at > now() - interval '24 hours'`);
  let budget = Math.max(0, s.research_per_day - doneToday);
  // The flagged ones, biggest disagreement with the price first, each researched at most once a day.
  const flagged = screened.filter(f => f.research).sort((a, b) => Math.abs(b.ai_prob - b.market_prob) - Math.abs(a.ai_prob - a.market_prob));
  let researched = 0; let offered = 0; let automated = 0;
  for (const f of flagged) {
    if (budget <= 0) break;
    const { rows: recent } = await db.query(`SELECT 1 FROM ai_forecasts WHERE venue = 'polymarket' AND stage = 'research' AND market = $1 AND created_at > now() - interval '24 hours'`, [f.market]);
    if (recent.length) continue;
    budget--;
    const r = await research(f.candidate, s).catch(err => { logger.warn('forecast research failed', { market: f.market, error: err.message }); return null; });
    if (!r) continue;
    researched++;
    if (s.polymarket_proposals) offered += await propose(r, f.candidate, s);
    if (s.polymarket_auto) {
      // Automated entries use the stricter edge (polymarket/auto.js); only for users who authorized RektBull's Session Key.
      const plan = proposalFor(r, f.candidate, { ...s, edge_pct: s.auto_edge_pct });
      if (plan) automated += await require('../polymarket/auto').fromForecast(r, plan).catch(err => { logger.error('automated Polymarket entries failed', { error: err.message }); return 0; });
    }
  }
  logger.info('Polymarket forecasts', { resolved, screened: screened.length, researched, offered, automated });
  return { resolved, screened: screened.length, researched, offered, automated };
}

/** The public track record: how the AI's forecasts scored against the market's own prices, once resolved. */
async function trackRecord(venue = 'polymarket') {
  const { rows } = await db.query(`SELECT stage, COUNT(*)::int AS n, AVG(brier_ai)::float AS ai, AVG(brier_market)::float AS market,
      SUM(CASE WHEN brier_ai < brier_market THEN 1 ELSE 0 END)::int AS beat, SUM(cost_usd)::float AS cost
    FROM ai_forecasts WHERE venue = $1 AND resolved_at IS NOT NULL GROUP BY stage`, [venue]);
  const { rows: [open] } = await db.query(`SELECT COUNT(*)::int AS n FROM ai_forecasts WHERE venue = $1 AND resolved_at IS NULL`, [venue]);
  const { rows: recent } = await db.query(`SELECT market, question, outcome, ai_prob, market_prob, resolved_value, brier_ai, brier_market, confidence, created_at, resolved_at
    FROM ai_forecasts WHERE venue = $1 AND stage = 'research' AND resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT 20`, [venue]);
  const r4 = v => (v === null || v === undefined ? null : Math.round(v * 10000) / 10000);
  return {
    venue, open: open.n,
    stages: rows.map(r => ({ stage: r.stage, resolved: r.n, brier_ai: r4(r.ai), brier_market: r4(r.market), ai_beat_market: r.beat, ai_cost_usd: r4(r.cost) })),
    how: 'Each forecast is scored with the Brier score, (probability − outcome)², when its market resolves, and so is the market\'s own price at the time it was made. Lower is better. The AI is useful only where its score beats the market\'s.',
    recent: recent.map(f => ({ market: f.market, question: f.question, outcome: f.outcome, ai_prob: Number(f.ai_prob), market_prob: Number(f.market_prob), happened: Number(f.resolved_value) === 1, brier_ai: Number(f.brier_ai), brier_market: Number(f.brier_market), confidence: f.confidence, made_at: f.created_at, resolved_at: f.resolved_at })),
    source: SOURCE,
  };
}

module.exports = { tick, screen, research, propose, proposalFor, resolve, trackRecord, candidates, lastJson };
