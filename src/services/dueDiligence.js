/**
 * Token due diligence: RektBull's first paid service.
 *
 * - quickCheck: the contract risk scan (tokenRisk) and its verdict. No AI.
 * - fullReport: the scan, market data (liquidity, volume, age), and a
 *   plain-English report written by Claude from only that data.
 *
 * Scans are cached for 6 hours and market data for 5 minutes, so popular
 * tokens cost one set of provider calls however many people check them.
 */
const { scanToken, SCAN_CHAINS } = require('./tokenRisk');
const { market } = require('../providers/dexscreener');
const { cached } = require('../lib/cache');
const claude = require('../ai/claude');

const SCAN_TTL = 6 * 60 * 60;
const MARKET_TTL = 5 * 60;
const REPORT_TTL = 60 * 60;

const isEvmAddress = a => /^0x[0-9a-fA-F]{40}$/.test(a);
const isSolanaMint = a => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

/** The checked { chain, token } from a request body, or { error }. */
function parseTarget(body = {}) {
  const chain = String(body.chain || '').toLowerCase();
  const raw = String(body.token_address || body.token || '').trim();
  if (!SCAN_CHAINS.includes(chain)) return { error: `chain must be one of: ${SCAN_CHAINS.join(', ')}` };
  if (chain === 'solana' ? !isSolanaMint(raw) : !isEvmAddress(raw)) {
    return { error: chain === 'solana' ? 'token_address must be a Solana mint address' : 'token_address must be a contract address (0x and 40 hex characters)' };
  }
  return { chain, token: chain === 'solana' ? raw : raw.toLowerCase() };
}

async function scan(chain, token) {
  return cached(`scan:${chain}:${token}`, SCAN_TTL, async () => {
    const out = await scanToken({ chain, token_address: token });
    if (out.error) throw Object.assign(new Error(out.error), { status: 400 });
    return out;
  });
}

/**
 * Every check that couldn't run, with its reason, so a result never looks
 * complete when it isn't: [{ check: 'goplus', reason: 'GoPlus does not cover this chain' }].
 */
function notChecked(checks = {}, market = null) {
  const out = [];
  const walk = (name, v, depth) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return;
    if (v.not_checked) return out.push({ check: name, reason: v.not_checked });
    if (typeof v.incomplete === 'string') out.push({ check: name, reason: v.incomplete });
    if (depth < 2) for (const [k, sub] of Object.entries(v)) walk(`${name}.${k}`, sub, depth + 1);
  };
  for (const [k, v] of Object.entries(checks)) walk(k, v, 0);
  if (market?.not_checked) out.push({ check: 'market', reason: market.not_checked });
  return out;
}

async function quickCheck({ chain, token }) {
  const s = await scan(chain, token);
  return {
    chain, token, checked_at: s.checked_at, verdict: s.verdict,
    ...(s.incomplete ? { incomplete: s.incomplete } : {}),
    flags: s.flags.filter(f => f.severity !== 'info'),
    disagreements: s.disagreements,
    not_checked: notChecked(s.checks),
    note: s.note,
  };
}

const SYSTEM = `You write token safety reports for RektBull, whose promise to users is "don't get rekt".

You are given the raw results of automated checks on one token: a contract risk scan (each flag names its source and severity) and market data. Write a short report for someone deciding whether to buy or keep holding it.

Rules:
- Use only the data given. If a check didn't run, say so plainly; never fill gaps with guesses or outside knowledge.
- Lead with the verdict in one sentence, then the biggest risks in order of severity.
- Explain each risk in everyday words: what could happen to the holder's money, and who could make it happen.
- Mention where sources disagree.
- Cover liquidity and age from the market data when present: thin liquidity or a very new token is a risk of its own.
- End with "What we couldn't check" if anything didn't run, then one line: "This is an automated check of known patterns, not financial advice or proof of safety."
- Plain Markdown with short sections. No more than about 400 words.`;

async function fullReport({ chain, token }) {
  const [s, m] = await Promise.all([scan(chain, token), cached(`market:${chain}:${token}`, MARKET_TTL, () => market(chain, token))]);
  return cached(`report:${chain}:${token}:${s.checked_at}`, REPORT_TTL, async () => {
    const data = { chain, token, scan: { verdict: s.verdict, incomplete: s.incomplete || null, flags: s.flags, disagreements: s.disagreements, checks: s.checks }, market: m };
    const ai = await claude.write({ system: SYSTEM, prompt: `Token check results (JSON):\n\n${JSON.stringify(data)}` });
    return {
      chain, token, checked_at: s.checked_at, verdict: s.verdict,
      ...(s.incomplete ? { incomplete: s.incomplete } : {}),
      report_markdown: ai.text,
      flags: s.flags, disagreements: s.disagreements, market: m,
      not_checked: notChecked(s.checks, m),
      written_by: ai.model,
    };
  });
}

module.exports = { parseTarget, quickCheck, fullReport, notChecked };
