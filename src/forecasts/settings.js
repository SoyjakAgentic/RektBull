/**
 * The AI forecasts' switches and numbers (admin panel, `forecasts`; logged).
 * Everything starts off: running the forecasts costs AI usage RektBull pays
 * for, and proposals reach users only once an admin turns them on, ideally
 * after the public track record shows the AI beats the market.
 */
const settings = require('../admin/settings');

const DEFAULTS = {
  polymarket: false,            // run the Polymarket forecasts (logged and scored; nobody is offered anything)
  polymarket_proposals: false,  // offer proposals from them to users who opted in
  hyperliquid: false,
  hyperliquid_proposals: false,
  markets: 200,                 // Polymarket: how many of the busiest markets the screen reads
  refresh_hours: 6,             // how often the screen runs
  research_per_day: 30,         // at most this many researched forecasts a day (web search is the costly part)
  web_searches: 3,              // per researched forecast
  edge_pct: 8,                  // propose only when the AI's probability beats the price by this many points
  proposal_usd: 0.05,           // what one proposal costs a user in AI credits
};
const LIMITS = { markets: [10, 1000], refresh_hours: [1, 48], research_per_day: [0, 500], web_searches: [0, 10], edge_pct: [1, 50], proposal_usd: [0, 5] };

const get = () => ({ ...DEFAULTS, ...(settings.get('forecasts') || {}) });

function check(input) {
  const out = {};
  for (const k of ['polymarket', 'polymarket_proposals', 'hyperliquid', 'hyperliquid_proposals']) if (input[k] !== undefined) out[k] = !!input[k];
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    if (input[k] === undefined) continue;
    const v = Number(input[k]);
    if (!(v >= lo && v <= hi)) throw Object.assign(new Error(`${k} must be ${lo} to ${hi}.`), { status: 400 });
    out[k] = v;
  }
  return out;
}

module.exports = { DEFAULTS, LIMITS, get, check };
