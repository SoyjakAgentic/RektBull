/**
 * Region blocks (src/compliance/regions.js): the country comes only from the
 * header the load balancer sets, an empty list blocks nothing, an unknown
 * country is blocked when a venue has blocks, and the admin's list is checked.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const env = require('../src/config/env');
const settings = require('../src/admin/settings');
const regions = require('../src/compliance/regions');

const req = (headers = {}) => ({ headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) });
function withSettings(map, fn) {
  const get = settings.get;
  settings.get = k => map[k];
  try { return fn(); } finally { settings.get = get; }
}

test('the country comes only from the header named by GEO_COUNTRY_HEADER', () => {
  const before = env.geoCountryHeader;
  try {
    env.geoCountryHeader = '';
    assert.equal(regions.countryOf(req({ 'CF-IPCountry': 'US' })), null, 'no header is trusted unless it is named');
    env.geoCountryHeader = 'X-Client-Geo-Location';
    assert.equal(regions.countryOf(req({ 'X-Client-Geo-Location': 'us' })), 'US');
    assert.equal(regions.countryOf(req({ 'CF-IPCountry': 'US' })), null, 'another header is ignored');
    assert.equal(regions.countryOf(req({ 'X-Client-Geo-Location': 'XX' })), null, 'unknown');
    assert.equal(regions.countryOf(req({ 'X-Client-Geo-Location': 'USA' })), null);
  } finally { env.geoCountryHeader = before; }
});

test('blocks: each venue\'s own list to begin with; a listed country is blocked; an unknown country is blocked', () => {
  const before = env.geoCountryHeader;
  env.geoCountryHeader = 'X-Country';
  try {
    withSettings({}, () => {
      // Each venue starts with the places it bans itself.
      assert.equal(regions.blockedFor(req({ 'X-Country': 'US' }), 'hyperliquid').blocked, true, 'Hyperliquid: the United States');
      assert.equal(regions.blockedFor(req({ 'X-Country': 'IR' }), 'hyperliquid').blocked, true, 'sanctioned');
      assert.equal(regions.blockedFor(req({ 'X-Country': 'DE' }), 'hyperliquid').blocked, false);
      assert.equal(regions.blockedFor(req({ 'X-Country': 'DE' }), 'polymarket').blocked, true, 'Polymarket: Germany is close-only');
      assert.equal(regions.blockedFor(req({ 'X-Country': 'PT' }), 'polymarket').blocked, false);
      assert.equal(regions.blockedFor(req(), 'polymarket').blocked, true, 'no country known: blocked');
    });
    withSettings({ 'regions:hyperliquid': { countries: [] } }, () => {
      assert.equal(regions.blockedFor(req({ 'X-Country': 'US' }), 'hyperliquid').blocked, false, 'an admin can clear a list');
    });
    withSettings({ 'regions:hyperliquid': { countries: ['US', 'CU'] } }, () => {
      const us = regions.blockedFor(req({ 'X-Country': 'US' }), 'hyperliquid');
      assert.equal(us.blocked, true); assert.match(us.reason, /isn't offered in your country \(US\).*close positions/);
      assert.equal(regions.blockedFor(req({ 'X-Country': 'DE' }), 'hyperliquid').blocked, false);
      const unknown = regions.blockedFor(req(), 'hyperliquid');
      assert.equal(unknown.blocked, true, 'fails closed'); assert.match(unknown.reason, /couldn't tell which country/);
      assert.equal(regions.blockedFor(req({ 'X-Country': 'DE' }), 'polymarket').blocked, true, 'per venue: Polymarket keeps its own list');
      assert.throws(() => regions.refuseIfBlocked(req({ 'X-Country': 'CU' }), 'hyperliquid'), e => e instanceof regions.RegionBlocked && e.status === 451);
    });
    assert.throws(() => regions.blockedFor(req(), 'nowhere'), /unknown venue/);
  } finally { env.geoCountryHeader = before; }
});

test('regions within a country: Ontario is blocked on Hyperliquid, the rest of Canada isn\'t', () => {
  const before = [env.geoCountryHeader, env.geoSubdivisionHeader];
  env.geoCountryHeader = 'X-Country'; env.geoSubdivisionHeader = 'X-Sub';
  try {
    withSettings({}, () => {
      assert.equal(regions.blockedFor(req({ 'X-Country': 'CA', 'X-Sub': 'CAON' }), 'hyperliquid').blocked, true, 'Google\'s form, CAON');
      assert.equal(regions.blockedFor(req({ 'X-Country': 'CA', 'X-Sub': 'ON' }), 'hyperliquid').blocked, true, 'Cloudflare\'s form, ON');
      assert.equal(regions.blockedFor(req({ 'X-Country': 'CA', 'X-Sub': 'CA-ON' }), 'hyperliquid').region, 'CA-ON');
      assert.equal(regions.blockedFor(req({ 'X-Country': 'CA', 'X-Sub': 'NS' }), 'hyperliquid').blocked, false, 'Nova Scotia');
      const unknown = regions.blockedFor(req({ 'X-Country': 'CA' }), 'hyperliquid');
      assert.equal(unknown.blocked, true, 'region unknown: blocked'); assert.match(unknown.reason, /CA-ON/);
      assert.equal(regions.blockedFor(req({ 'X-Country': 'UA', 'X-Sub': 'UA43' }), 'hyperliquid').blocked, true, 'Crimea');
      assert.equal(regions.blockedFor(req({ 'X-Country': 'UA', 'X-Sub': 'UA30' }), 'hyperliquid').blocked, false, 'Kyiv');
    });
  } finally { [env.geoCountryHeader, env.geoSubdivisionHeader] = before; }
});

test('the admin\'s list: country and region codes, de-duplicated and sorted', () => {
  assert.deepEqual(regions.checkList(['us', ' CU', 'US', 'ca-on']), ['CA-ON', 'CU', 'US']);
  assert.deepEqual(regions.checkList([]), []);
  assert.throws(() => regions.checkList(['USA']), /Not country codes/);
  assert.throws(() => regions.checkList('US'), /must be a list/);
  const before = env.geoCountryHeader;
  env.geoCountryHeader = '';
  try {
    const list = withSettings({}, () => regions.adminList(req()));
    assert.match(list.note, /blocked for everyone/, 'the panel warns when no country header is set');
    assert.deepEqual(list.venues.map(v => v.id), ['hyperliquid', 'polymarket']);
  } finally { env.geoCountryHeader = before; }
});

test('the Hyperliquid relay: a block stops opening and approving, never getting out', () => {
  const { regionMatters } = require('../src/routes/hyperliquid');
  const now = Date.now();
  const c = (type, opens, action = {}) => ({ type, opens, payload: { action: { type, ...action } } });
  assert.equal(regionMatters(c('order', true)), true, 'an order that opens');
  assert.equal(regionMatters(c('order', false)), false, 'reduce-only orders close');
  assert.equal(regionMatters(c('cancel', false)), false);
  assert.equal(regionMatters(c('cancelByCloid', false)), false);
  assert.equal(regionMatters(c('updateLeverage', false)), true);
  assert.equal(regionMatters(c('updateIsolatedMargin', false)), true);
  assert.equal(regionMatters(c('approveBuilderFee', false, { maxFeeRate: '0.01%' })), true);
  assert.equal(regionMatters(c('approveBuilderFee', false, { maxFeeRate: '0%' })), false, 'taking the fee approval away');
  const agent = (days, addr = '0x1111111111111111111111111111111111111111') => c('approveAgent', false, { agentAddress: addr, agentName: `rektbull-web valid_until ${now + days * 86400000}` });
  assert.equal(regionMatters(agent(30), now), true, 'a new 30-day key');
  assert.equal(regionMatters(agent(1), now), false, 'the page\'s "end the key": a thrown-away key for a day');
  assert.equal(regionMatters(agent(30, '0x0000000000000000000000000000000000000000'), now), false);
});
