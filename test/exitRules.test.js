/** The rules shared by both order services (src/trade/exitRules.js): a trailing stop's trail, and take-profit steps. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { trail, parseSteps } = require('../src/trade/exitRules');

test('a trailing stop rises only on a value seen twice, never falls; steps are checked', () => {
  let row = { trail_bps: 2000, peak_out: '100', last_value_out: null };
  const seen = [];
  for (const v of [150n, 140n, 300n, 145n, 90n, 200n, 210n]) {
    const t = trail(row, v);
    seen.push([String(v), String(t.peak), String(t.trigger)]);
    row = { ...row, peak_out: String(t.peak), last_value_out: String(t.last) };
  }
  assert.deepEqual(seen, [
    ['150', '100', '80'], // the first check: nothing to compare with
    ['140', '140', '112'], // 150 then 140: 140 seen twice
    ['300', '140', '112'], // a spike: seen once
    ['145', '145', '116'], // 300 then 145: 145
    ['90', '145', '116'], // a fall: the stop doesn't come down
    ['200', '145', '116'],
    ['210', '200', '160'],
  ]);
  assert.equal(parseSteps([{ take_pct: 100, part_pct: 40 }, { take_pct: 200, part_pct: 30 }, { take_pct: 400, part_pct: 30 }]).length, 3);
  for (const [steps, why] of [
    [[{ take_pct: 100, part_pct: 50 }], /2 or 3 steps/],
    ['100,200', /2 or 3 steps/],
    [[{ take_pct: 100, part_pct: 50 }, { take_pct: 100, part_pct: 50 }], /Step 2 must sell at a higher rise/],
    [[{ take_pct: 100, part_pct: 70 }, { take_pct: 200, part_pct: 40 }], /add up to 110%/],
    [[{ take_pct: 0, part_pct: 50 }, { take_pct: 200, part_pct: 40 }], /Step 1: take_pct/],
    [[{ take_pct: 100, part_pct: 50 }, { take_pct: 200, part_pct: 0 }], /Step 2: part_pct/],
  ]) assert.throws(() => parseSteps(steps), e => why.test(e.message) && e.status === 400);
});
