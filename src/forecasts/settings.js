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
  // Hyperliquid entry proposals (hyperliquid/entries.js): stated rules, each a bracket, scored in R in public.
  hyperliquid: false,           // run the rules and score the signals (shadow: nobody is offered anything)
  hyperliquid_proposals: false, // offer them, sized for each account, to users who asked for Hyperliquid proposals
  markets: 200,                 // Polymarket: how many of the busiest markets the screen reads
  refresh_hours: 6,             // how often the screen runs
  research_per_day: 30,         // at most this many researched forecasts a day (web search is the costly part)
  web_searches: 3,              // per researched forecast
  edge_pct: 8,                  // propose only when the AI's probability beats the price by this many points
  proposal_usd: 0.25,           // what acting on one proposal costs a user in AI credits (offering it is free)
  // Automatic Polymarket trading (polymarket/auto.js), for users who authorized RektBull's Session Key:
  polymarket_auto: false,       // place automated entries from researched forecasts
  auto_edge_pct: 10,            // a stricter edge than proposals: the automation fee comes on top
  auto_fee_pct: 1,              // RektBull's fee on each automated entry that fills, from AI credits...
  auto_fee_min_usd: 0.25,       // ...at least this much
  auto_min_order_usd: 25,       // no automated entry smaller than this
  // Meme coin proposals (memes/signals.js): rules pick, the AI explains, a public scorecard.
  memes: false,                 // run the rules and score the picks (logged and scored; nobody is offered anything)
  meme_proposals: false,        // offer the picks to users who asked for them
  meme_refresh_minutes: 5,      // the owner's choice: meme momentum moves fast (GeckoTerminal's free plan allows it)
  meme_picks: 3,                // at most this many picks a run, across Base, BNB Chain and Solana
  meme_min_liquidity_usd: 50000,
  meme_min_volume_usd: 100000,  // in 24 hours
  meme_min_buys: 200,           // buy transactions in 24 hours
  meme_expiry_hours: 6,         // an unacted pick expires this long after it was picked: the facts behind it are stale
  meme_proposal_usd: 0,         // what acting on a meme pick costs in AI credits: free (the owner's choice; the trade's 1% fee pays)
};
const LIMITS = { meme_refresh_minutes: [5, 1440], meme_picks: [1, 10], meme_min_liquidity_usd: [5000, 10000000], meme_min_volume_usd: [5000, 100000000], meme_min_buys: [10, 1000000], meme_proposal_usd: [0, 5], meme_expiry_hours: [1, 48], auto_edge_pct: [1, 50], auto_fee_pct: [0, 10], auto_fee_min_usd: [0, 10], auto_min_order_usd: [1, 10000], markets: [10, 1000], refresh_hours: [1, 48], research_per_day: [0, 500], web_searches: [0, 10], edge_pct: [1, 50], proposal_usd: [0, 5] };

const get = () => ({ ...DEFAULTS, ...(settings.get('forecasts') || {}) });

function check(input) {
  const out = {};
  for (const k of ['polymarket', 'polymarket_proposals', 'polymarket_auto', 'hyperliquid', 'hyperliquid_proposals', 'memes', 'meme_proposals']) if (input[k] !== undefined) out[k] = !!input[k];
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    if (input[k] === undefined) continue;
    const v = Number(input[k]);
    if (!(v >= lo && v <= hi)) throw Object.assign(new Error(`${k} must be ${lo} to ${hi}.`), { status: 400 });
    out[k] = v;
  }
  return out;
}

module.exports = { DEFAULTS, LIMITS, get, check };
