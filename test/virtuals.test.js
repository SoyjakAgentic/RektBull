/**
 * Virtuals' current launchpad, BondingV5 with FRouterV3: tokens recognised on
 * it first (the old Bonding still recognised, as legacy), the curve's progress,
 * and its taxes now, the anti-sniper tax worked out as the router does. No network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

require('../src/config/env').databaseUrl = '';
const rpc = require('../src/providers/rpc');
const cache = require('../src/lib/cache');
const lp = require('../src/services/launchpads');

const T = n => '0x' + n.toString(16).padStart(40, '0');
const e18 = n => BigInt(n) * 10n ** 18n;

test('Virtuals: the anti-sniper tax, as FRouterV3 works it out', () => {
  const base = { startTax: 99, duration: 98 * 60, applies: true, taxStart: 1000, normalTax: 1 };
  assert.equal(lp.antiSniperPct({ ...base, now: 900 }), 98, 'before trading starts: the start value, capped so the two taxes are at most 99%');
  assert.equal(lp.antiSniperPct({ ...base, now: 1000 }), 98, 'at the start (99, capped to 98 with the 1% tax)');
  assert.equal(lp.antiSniperPct({ ...base, now: 1000 + 49 * 60 }), 49, 'half way: half of 99, rounded down');
  assert.equal(lp.antiSniperPct({ ...base, now: 1000 + 98 * 60 - 1 }), 0, 'falls in a straight line, rounded down');
  assert.equal(lp.antiSniperPct({ ...base, now: 1000 + 98 * 60 }), 0, 'over once its time is up');
  assert.equal(lp.antiSniperPct({ ...base, applies: false, now: 1000 }), 0, 'not on a side its type doesn\'t cover');
  assert.equal(lp.antiSniperPct({ ...base, duration: 0, now: 1000 }), 0, 'none for ANTI_SNIPER_NONE');
});

test('Virtuals: a BondingV5 token, read from its contracts', async t => {
  const saved = rpc.evmRpc;
  t.after(() => { rpc.evmRpc = saved; });
  cache._memory.clear();
  const V5 = T(0xa5), OLD = T(0x01), GRAD = T(0xa6), PRE = T(0xa7), PAIR = T(0xbb), FAC = T(0xfa), CFG = T(0xcf);
  const now = 2_000_000_000;
  const I = {
    fac: new ethers.Interface(['function buyTax() view returns (uint256)', 'function sellTax() view returns (uint256)', 'function antiSniperBuyTaxStartValue() view returns (uint256)']),
    cfg: new ethers.Interface(['function getAntiSniperDuration(uint8) view returns (uint256)', 'function appliesAntiSniperOnBuy(uint8) view returns (bool)', 'function appliesAntiSniperOnSell(uint8) view returns (bool)']),
    pair: new ethers.Interface(['function getReserves() view returns (uint256, uint256)', 'function startTime() view returns (uint256)', 'function taxStartTime() view returns (uint256)']),
  };
  const info = (token, { trading = true, onUni = false, launched = true, agent = ethers.ZeroAddress } = {}) => lp.BONDING_V5.encodeFunctionResult('tokenInfo', [T(0xc0), token, PAIR, agent,
    [token, 'n', 'n', 'NEWV', e18(450_000_000), 0, 0, 0, 0, 0, 0, 0], '', '', 'https://x.com/newv', '', '', '', trading, onUni, 7, 0, 50_000_000_001, launched]);
  const call = (iface, fn, data, values) => { const f = iface.getFunction(fn); return data.startsWith(f.selector) ? iface.encodeFunctionResult(fn, values) : null; };
  rpc.evmRpc = async (_chain, method, params) => {
    if (method === 'eth_getBlockByNumber') return { number: '0x1', timestamp: '0x' + now.toString(16) };
    const [{ to, data }] = params;
    const t2 = to.toLowerCase();
    const arg = '0x' + data.slice(34, 74);
    if (t2 === lp.ADDR.bondingV5) {
      if (data.startsWith(lp.BONDING_V5.getFunction('tokenInfo').selector)) {
        if (arg === V5) return info(V5);
        if (arg === GRAD) return info(GRAD, { trading: false, onUni: true, agent: GRAD });
        if (arg === PRE) return info(PRE, { launched: false });
        return info(ethers.ZeroAddress, { trading: false });
      }
      return call(lp.BONDING_V5, 'tokenLaunchParams', data, [0, 0, false, 2, arg === V5])
        || call(lp.BONDING_V5, 'tokenGradThreshold', data, [e18(90_000_000)])
        || call(lp.BONDING_V5, 'factory', data, [FAC]) || call(lp.BONDING_V5, 'bondingConfig', data, [CFG]);
    }
    if (t2 === FAC) return call(I.fac, 'buyTax', data, [1]) || call(I.fac, 'sellTax', data, [1]) || call(I.fac, 'antiSniperBuyTaxStartValue', data, [99]);
    if (t2 === CFG) return call(I.cfg, 'getAntiSniperDuration', data, [98 * 60]) || call(I.cfg, 'appliesAntiSniperOnBuy', data, [true]) || call(I.cfg, 'appliesAntiSniperOnSell', data, [false]);
    if (t2 === PAIR) return call(I.pair, 'getReserves', data, [e18(270_000_000), e18(5000)]) || call(I.pair, 'startTime', data, [now - 3600]) || call(I.pair, 'taxStartTime', data, [now - 49 * 60]);
    if (t2 === lp.ADDR.frouter) return new ethers.Interface(['function factory() view returns (address)']).encodeFunctionResult('factory', [FAC]);
    if (t2 === lp.ADDR.bonding && data.startsWith(lp.BONDING.getFunction('gradThreshold').selector)) return lp.BONDING.encodeFunctionResult('gradThreshold', [e18(125_000_000)]);
    if (t2 === lp.ADDR.bonding) {
      return arg === OLD
        ? lp.BONDING.encodeFunctionResult('tokenInfo', [T(1), OLD, PAIR, ethers.ZeroAddress, [OLD, 'o', 'o', 'OLD', e18(1_000_000_000), 0, 0, 0, 0, 0, 0, 0], '', '', '', '', '', '', true, false])
        : lp.BONDING.encodeFunctionResult('tokenInfo', [ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, [ethers.ZeroAddress, '', '', '', 0, 0, 0, 0, 0, 0, 0, 0], '', '', '', '', '', '', false, false]);
    }
    throw new Error(`call reverted: ${t2}`); // Clanker, Zora: not theirs
  };

  const v = await lp.identify('base', V5);
  assert.deepEqual([v.launchpad, v.version, v.state, v.bonding, v.frouter, v.project_60_days, v.ticker], ['virtuals', 5, 'curve', lp.ADDR.bondingV5, lp.ADDR.frouterV3, true, 'NEWV']);
  // 450M on the curve at launch, 270M left, graduating at 90M: 180M of 360M sold.
  assert.equal(v.curve.progress_pct, 50);
  assert.equal(v.curve.graduates_at, 90_000_000);
  // A 98-minute buy-only anti-sniper tax, started 49 minutes ago (taxStartTime, not startTime): 49% to buy now.
  assert.deepEqual([v.curve.buy_tax_pct, v.curve.sell_tax_pct, v.curve.normal_buy_tax_pct, v.curve.anti_sniper.buy_pct, v.curve.anti_sniper.sell_pct], [50, 1, 1, 49, 0]);
  assert.equal(v.curve.anti_sniper.ends_at, new Date((now + 49 * 60) * 1000).toISOString());
  assert.deepEqual(v.links.map(l => l.url), ['https://x.com/newv']);
  assert.match(v.source, /BondingV5/);

  // The router's two taxes come off separately, each rounded down, as FRouterV3 takes them.
  let asked = null;
  const realRpc = rpc.evmRpc;
  rpc.evmRpc = async (c, m, p) => { if (p?.[0]?.to?.toLowerCase() === lp.ADDR.frouterV3) { asked = new ethers.Interface(['function getAmountsOut(address,address,uint256)']).decodeFunctionData('getAmountsOut', p[0].data); return ethers.toBeHex(e18(1000), 32); } return realRpc(c, m, p); };
  assert.equal(await lp.curveBuyQuote(V5, 1001n, v), e18(1000));
  assert.equal(asked[2], 1001n - 1001n * 1n / 100n - 1001n * 49n / 100n, 'what reaches the pool: 1001 less 1% (10) and 49% (490)');
  rpc.evmRpc = realRpc;

  assert.equal((await lp.identify('base', PRE)).state, 'prelaunch', 'made, but not open for trading yet');
  const g = await lp.identify('base', GRAD);
  assert.deepEqual([g.state, g.agent_token], ['graduated', GRAD], 'graduated as its own agent token');
  const o = await lp.identify('base', OLD);
  assert.deepEqual([o.launchpad, o.legacy, o.bonding, o.frouter, o.version], ['virtuals', true, lp.ADDR.bonding, lp.ADDR.frouter, undefined], 'the old curve is still recognised, as legacy');
  assert.match(o.source, /old Bonding/);
});
