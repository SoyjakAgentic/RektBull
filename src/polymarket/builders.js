/**
 * RektBull's Polymarket builder codes (docs/POLYMARKET.md, "RektBull's fee").
 *
 * - main: signed into every order a user prepares themselves, at the main
 *   profile's rates (0.1% by default).
 * - ai: signed into orders that come from the AI, an approved proposal or an
 *   automatic entry, at the AI profile's rates (1% when an order fills at
 *   once, 0.5% when it waits in the book, Polymarket's highest). Unset: the
 *   AI's orders carry the main code and its rates.
 *
 * Polymarket sets a fee rate per builder profile, so each rate needs its own
 * profile and code; it charges the fee on fills only and pays it to the profile.
 */
const env = require('../config/env');

const main = () => ({ id: 'main', code: env.polymarketBuilderCode, takerBps: env.polymarketTakerFeeBps, makerBps: env.polymarketMakerFeeBps });
const ai = () => (env.polymarketAiBuilderCode
  ? { id: 'ai', code: env.polymarketAiBuilderCode, takerBps: env.polymarketAiTakerFeeBps, makerBps: env.polymarketAiMakerFeeBps }
  : main());
/** Every distinct code in use, for reading Polymarket's builder-trades feed. */
const all = () => [main(), ai()].filter((b, i, xs) => b.code && xs.findIndex(x => x.code === b.code) === i);

const pct = bps => `${Math.round(bps) / 100}%`;
const feeText = b => `${pct(b.takerBps)} of what fills when the order takes liquidity, ${pct(b.makerBps)} when it rests and is filled`;

module.exports = { main, ai, all, feeText, pct };
