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
  if (response.stop_reason === 'refusal') {
    throw Object.assign(new Error('The report could not be written for this token'), { status: 502 });
  }
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!text) throw Object.assign(new Error('The report came back empty'), { status: 502 });
  return { text, model: response.model, usage: response.usage };
}

module.exports = { write, available };
