/**
 * RektBull's two Polymarket builder codes (polymarket/builders.js): the main
 * one on orders users prepare themselves, the AI one on orders from an AI
 * proposal or an automatic entry, each at its own profile's rates.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

test('the AI code and its rates, or the main code when it isn\'t set', () => {
  const env = require('../src/config/env');
  const builders = require('../src/polymarket/builders');
  const saved = { ...env };
  try {
    Object.assign(env, { polymarketBuilderCode: '0x' + 'aa'.repeat(32), polymarketTakerFeeBps: 1, polymarketMakerFeeBps: 1, polymarketAiBuilderCode: '' });
    assert.equal(builders.ai().code, '0x' + 'aa'.repeat(32), 'no AI code: the main one');
    assert.deepEqual(builders.all().map(b => b.id), ['main']);
    Object.assign(env, { polymarketAiBuilderCode: '0x' + 'bb'.repeat(32), polymarketAiTakerFeeBps: 100, polymarketAiMakerFeeBps: 50 });
    assert.deepEqual(builders.ai(), { id: 'ai', code: '0x' + 'bb'.repeat(32), takerBps: 100, makerBps: 50 });
    assert.equal(builders.main().takerBps, 1, 'users\' own orders keep the main rate');
    assert.deepEqual(builders.all().map(b => b.id), ['main', 'ai']);
    assert.equal(builders.feeText(builders.ai()), '1% of what fills when the order takes liquidity, 0.5% when it rests and is filled');
    const fills = require('../src/polymarket/fills');
    assert.equal(fills.feeOf({ sizeUsdc: '100000000', tradeType: 'TAKER' }, builders.ai()), 1, '1% of a $100 taker fill');
    assert.equal(fills.feeOf({ sizeUsdc: '100000000', tradeType: 'MAKER' }, builders.ai()), 0.5);
    assert.equal(fills.feeOf({ sizeUsdc: '100000000', tradeType: 'TAKER' }), 0.01, 'the main code: 0.01%');
  } finally { Object.assign(env, saved); }
});

test('the env defaults for the AI profile are Polymarket\'s highest rates, and never above them', () => {
  const run = extra => JSON.parse(require('child_process').execFileSync(process.execPath, ['-e',
    "const e = require('./src/config/env'); console.log(JSON.stringify([e.polymarketAiTakerFeeBps, e.polymarketAiMakerFeeBps]))"],
  { cwd: require('path').join(__dirname, '..'), env: { ...process.env, ...extra } }).toString());
  assert.deepEqual(run({ POLYMARKET_AI_BUILDER_TAKER_FEE_BPS: '', POLYMARKET_AI_BUILDER_MAKER_FEE_BPS: '' }), [100, 50]);
  assert.deepEqual(run({ POLYMARKET_AI_BUILDER_TAKER_FEE_BPS: '500', POLYMARKET_AI_BUILDER_MAKER_FEE_BPS: '500' }), [100, 50]);
});
