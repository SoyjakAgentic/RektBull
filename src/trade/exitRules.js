/**
 * Two exits shared by the order services on BNB Chain, Base and Solana:
 *
 *   - A trailing stop-loss: the trigger follows the coins' value up, trail_pct
 *     under the highest value seen, and never moves down. Only a value seen on
 *     two price checks in a row raises it (the lower of the two), so one stray
 *     price print can't drag it up and sell early. The floor the user signed
 *     never moves: it's still the least the coins can sell for, enforced by the
 *     Meme Router or the order program. The trailing itself is RektBull's
 *     trade service, as every trigger is.
 *   - Take-profits in steps: 2 or 3 take-profits placed together, each selling
 *     its part of the coins when their value rises by its own percentage.
 */

const { TradeBlocked } = require('./zeroex');

const MAX_STEPS = 3;
const StepsError = message => Object.assign(new TradeBlocked(message), { status: 400 });

/**
 * A trailing stop's new state from what the whole order's coins are worth now: { peak, trigger, last }, all BigInt.
 * `row` holds trail_bps, peak_out and last_value_out (the last check's value, or null).
 */
function trail(row, valueNow) {
  const peak = BigInt(row.peak_out);
  const last = row.last_value_out === null || row.last_value_out === undefined ? null : BigInt(row.last_value_out);
  const seenTwice = last === null ? null : (valueNow < last ? valueNow : last);
  const next = seenTwice !== null && seenTwice > peak ? seenTwice : peak;
  return { peak: next, trigger: next * BigInt(10000 - Number(row.trail_bps)) / 10000n, last: valueNow, raised: next > peak };
}

/**
 * The steps of a take-profit ladder, checked: [{ take_pct, part_pct }], 2 or 3 of them, each rising further than the
 * one before, their parts (of the share being sold) adding up to at most 100%.
 */
function parseSteps(raw) {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_STEPS) throw StepsError(`steps must be a list of 2 or ${MAX_STEPS} steps.`);
  const steps = raw.map((s, i) => {
    const take = Number(s?.take_pct);
    const part = Number(s?.part_pct);
    if (!(take >= 1 && take <= 10000)) throw StepsError(`Step ${i + 1}: take_pct must be from 1 to 10000.`);
    if (!(part >= 1 && part <= 100)) throw StepsError(`Step ${i + 1}: part_pct must be from 1 to 100.`);
    return { take_pct: take, part_pct: part };
  });
  for (let i = 1; i < steps.length; i++) {
    if (steps[i].take_pct <= steps[i - 1].take_pct) throw StepsError(`Step ${i + 1} must sell at a higher rise than step ${i} (${steps[i].take_pct}% isn't more than ${steps[i - 1].take_pct}%).`);
  }
  const total = steps.reduce((a, s) => a + s.part_pct, 0);
  if (total > 100.0001) throw StepsError(`The steps' parts add up to ${total}%: at most 100%.`);
  return steps;
}

/** The plain words for a trailing stop, shown before the user signs. */
function trailNote({ trailPct, start, floor, unit }) {
  return `This stop trails: it starts at ${start} ${unit} (${trailPct}% under their value now) and follows their value up, staying ${trailPct}% under the highest value RektBull's price checks see two checks in a row. It never moves down. Your floor (${floor} ${unit}) doesn't move with it: it's the least they can sell for, and the order is signed with it.`;
}

module.exports = { trail, parseSteps, trailNote, MAX_STEPS };
