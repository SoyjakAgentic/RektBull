/**
 * The AUTO_TRADING_NETWORKS entry that contracts/scripts/verifyBase.js prints
 * after the Base deployment works as the server's network config: the router,
 * the Safe Module, the three tokens and USDC as the base token.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('the Base deployment entry reads back as the server network', async () => {
  const lib = await import(pathToFileURL(path.join(__dirname, '../contracts/scripts/lib/baseDeploy.js')).href);
  const params = lib.loadParams();
  const dep = { router: '0x389E1Fed634fEEd9cED69aF6eA40Ed877F3e2701', safeModule: '0xA03d8593E26EEEf0263f34F2D39A0884518A09dd' };
  const before = process.env.AUTO_TRADING_NETWORKS;
  process.env.AUTO_TRADING_NETWORKS = JSON.stringify(lib.autoTradingEntry(params, dep));
  try {
    const networks = require('../src/trade/networks');
    assert.deepEqual(networks.chainIds(), [8453]);
    const net = networks.network(8453);
    assert.equal(net.router, dep.router.toLowerCase());
    assert.equal(net.safeModule, dep.safeModule);
    assert.equal(net.venue.type, '0x');
    assert.deepEqual(Object.keys(net.tokens), ['USDC', 'WETH', 'cbBTC']);
    assert.equal(networks.routerToken(net, 'cbbtc'), null, 'symbols are exact');
    assert.equal(networks.routerToken(net, '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf').symbol, 'cbBTC');
    assert.equal(networks.routerToken(net, net.defaultBase).decimals, 6);
    assert.ok(net.delegationManager, "MetaMask's delegation contracts are on Base");
  } finally {
    if (before === undefined) delete process.env.AUTO_TRADING_NETWORKS; else process.env.AUTO_TRADING_NETWORKS = before;
  }
});
