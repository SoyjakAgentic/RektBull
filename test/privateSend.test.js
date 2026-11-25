/**
 * Private submission's own rules (src/trade/privateSend.js): which relays count, the Jito tip's bounds, Jito's spacing
 * and refusals. The order services' use of it is tested in memeOrders.test.js and solanaOrders.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const env = require('../src/config/env');
const cache = require('../src/lib/cache');
const ps = require('../src/trade/privateSend');

test('private submission: relays, the Jito tip, spacing and refusals', async t => {
  const saved = { ...env };
  t.after(() => { Object.assign(env, saved); ps._setTransport(async () => { throw new Error('no network in tests'); }, async () => { throw new Error('no network in tests'); }); });

  // Off unless set, outside production; only https relays count.
  assert.deepEqual(saved.memePrivateSend, {});
  assert.equal(saved.solanaJitoUrl, '');
  env.memePrivateSend = { bsc: ['https://rpc.48.club', 'http://insecure.example', 'https://bsc.blockrazor.xyz/fullprivacy'] };
  assert.deepEqual(ps.relays('bsc'), ['https://rpc.48.club', 'https://bsc.blockrazor.xyz/fullprivacy']);
  assert.deepEqual(ps.relays('base'), []);
  assert.deepEqual(['https://rpc.48.club', 'https://bsc.blockrazor.xyz/fullprivacy', 'https://other.example/x'].map(ps.relayName), ['48 Club', 'BlockRazor', 'other.example']);

  // An EVM relay that already has it accepted it; one that's down or refuses is reported, not thrown.
  ps._setTransport(async url => {
    if (url.includes('48')) return { error: { message: 'already known' } };
    throw Object.assign(new Error('down'), { response: { status: 503 } });
  });
  assert.deepEqual(await ps.sendEvm('bsc', '0x02'), { accepted: ['48 Club'], refused: [{ relay: 'BlockRazor', error: 'HTTP 503' }] });

  // The tip: Jito's tip floor in SOL, the 75th percentile when urgent, at least 1,000 lamports, at most the cap.
  env.solanaJitoTipMaxLamports = 200_000;
  let floor = { landed_tips_50th_percentile: 0.000004, landed_tips_75th_percentile: 0.0009 };
  ps._setTransport(async () => ({}), async () => [floor]);
  const fresh = () => cache._memory.clear();
  fresh();
  assert.equal(await ps.tipLamports(false), 4000);
  assert.equal(await ps.tipLamports(true), 200_000, 'never more than SOLANA_JITO_TIP_MAX_LAMPORTS');
  floor = { landed_tips_50th_percentile: 1e-7 }; fresh();
  assert.equal(await ps.tipLamports(false), ps.JITO_MIN_TIP, 'never under Jito\'s minimum');
  ps._setTransport(async () => ({}), async () => { throw new Error('down'); }); fresh();
  assert.equal(await ps.tipLamports(true), ps.JITO_MIN_TIP, 'unreadable: the minimum');

  // Jito: sends a second apart (its limit is one a second from an address); a refusal is reported, not thrown.
  env.solanaJitoUrl = 'https://mainnet.block-engine.jito.wtf/';
  assert.equal(ps.jitoOn(), true);
  const at = [];
  ps._setTransport(async (url, body) => { at.push({ url, t: Date.now(), body }); return at.length === 1 ? { result: 'sig' } : { error: { message: 'rate limited' } }; });
  assert.deepEqual(await ps.sendJito('AQ=='), { ok: true });
  assert.deepEqual(await ps.sendJito('AQ=='), { ok: false, error: 'rate limited' });
  assert.ok(at[1].t - at[0].t >= 1000, 'spaced a second apart');
  assert.equal(at[0].url, 'https://mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true');
  assert.deepEqual(at[0].body.params, ['AQ==', { encoding: 'base64' }]);

  // Tip accounts: only real-looking addresses; none is an error the order service turns into a plain send.
  ps._setTransport(async () => ({ result: ['not an address'] })); fresh();
  await assert.rejects(ps.tipAccounts(), /no tip accounts/);
});
