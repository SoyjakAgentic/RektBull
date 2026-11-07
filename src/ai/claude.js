/**
 * The one place RektBull calls Claude. The model and effort are settings
 * (REPORT_MODEL, REPORT_EFFORT), so trading cost against quality never needs
 * a code change.
 *
 * Server-side refusal fallback is on: if the model declines, the API re-runs
 * the request on a fallback model it picks by refusal category. A request
 * that every model declines comes back with stop_reason "refusal", which is
 * reported as an error so the run is refunded.
 */
const Anthropic = require('@anthropic-ai/sdk');
const env = require('../config/env');

let client = null;
function getClient() {
  if (!env.anthropicApiKey) throw Object.assign(new Error('AI reports are not set up: ANTHROPIC_API_KEY is not configured'), { status: 503 });
  if (!client) client = new Anthropic({ apiKey: env.anthropicApiKey });
  return client;
}

const available = () => !!env.anthropicApiKey;

/**
 * US$ per million tokens, to estimate what reports cost (Anthropic's list
 * prices, Nov 2026). A model not listed is still recorded, with no estimate.
 */
const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cache_read: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cache_read: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cache_read: 0.01 },
};

function estimateUsd(model, t) {
  const p = PRICES[model];
  if (!p) return null;
  return (t.input_tokens * p.input + t.output_tokens * p.output + (t.cache_read_tokens || 0) * p.cache_read) / 1e6;
}

/** One call's cost in USD; a model without a listed price is counted at the dearest listed one, never as free. */
function costOf(model, usage = {}) {
  const t = { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0, cache_read_tokens: usage.cache_read_input_tokens || 0 };
  const known = estimateUsd(model, t);
  if (known !== null) return known;
  return Math.max(...Object.keys(PRICES).map(m => estimateUsd(m, t)));
}

/** Adds one call's tokens to today's totals for the model. Never fails the report. */
async function recordUsage(model, usage = {}) {
  if (!env.databaseUrl) return;
  try {
    await require('../config/db').query(
      `INSERT INTO ai_usage (day, model, calls, input_tokens, output_tokens, cache_read_tokens) VALUES (CURRENT_DATE, $1, 1, $2, $3, $4)
       ON CONFLICT (day, model) DO UPDATE SET calls = ai_usage.calls + 1, input_tokens = ai_usage.input_tokens + $2,
         output_tokens = ai_usage.output_tokens + $3, cache_read_tokens = ai_usage.cache_read_tokens + $4`,
      [model, usage.input_tokens || 0, usage.output_tokens || 0, usage.cache_read_input_tokens || 0],
    );
  } catch (err) {
    require('../config/logger').warn('could not record AI usage', { error: err.message });
  }
}

/** Tokens and estimated cost per model and day, newest first. */
async function usageReport(days = 30) {
  const { rows } = await require('../config/db').query(
    `SELECT day, model, calls, input_tokens, output_tokens, cache_read_tokens FROM ai_usage WHERE day > CURRENT_DATE - $1::int ORDER BY day DESC, model`, [days]);
  return rows.map(r => {
    const t = { input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens), cache_read_tokens: Number(r.cache_read_tokens) };
    const usd = estimateUsd(r.model, t);
    return { day: r.day, model: r.model, calls: r.calls, ...t, estimated_usd: usd === null ? null : Math.round(usd * 10000) / 10000, per_call_usd: usd === null || !r.calls ? null : Math.round((usd / r.calls) * 10000) / 10000 };
  });
}

/** One request; returns the response's text. */
async function write({ system, prompt, maxTokens = 4000 }) {
  const response = await getClient().beta.messages.create({
    model: env.reportModel,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: env.reportEffort },
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  await recordUsage(response.model, response.usage); // billed even when refused
  require('../payments/aiAllowance').add(costOf(response.model, response.usage)); // the run's AI cost (Safety Pro's allowance)
  if (response.stop_reason === 'refusal') {
    throw Object.assign(new Error('The report could not be written for this token'), { status: 502 });
  }
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!text) throw Object.assign(new Error('The report came back empty'), { status: 502 });
  return { text, model: response.model, usage: response.usage };
}

module.exports = { write, available, usageReport, estimateUsd, recordUsage, costOf, PRICES };
