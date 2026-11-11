/**
 * Automatic trading on Base, Ethereum and Arbitrum (one Trade Router each):
 * the AUTO_TRADING_NETWORKS entry contracts/scripts/verifyRouter.js prints
 * works as the server's network config for each chain; Ethereum's trades go
 * through Flashbots Protect; a buy must be large enough that its fee covers
 * the gas RektBull pays; and on a network that sends privately only one trade
 * is in flight at a time. Trades the user signs are offered on all three.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROUTER = '0x389E1Fed634fEEd9cED69aF6eA40Ed877F3e2701';
const MODULE = '0xA03d8593E26EEEf0263f34F2D39A0884518A09dd';
const lib = () => import(pathToFileURL(path.join(__dirname, '../contracts/scripts/lib/routerDeploy.js')).href);
async function withNetworks(entries, fn) {
  const before = process.env.AUTO_TRADING_NETWORKS;
  process.env.AUTO_TRADING_NETWORKS = JSON.stringify(entries);
  try { return await fn(require('../src/trade/networks')); } finally {
    if (before === undefined) delete process.env.AUTO_TRADING_NETWORKS; else process.env.AUTO_TRADING_NETWORKS = before;
  }
}

test('each chain\'s deployment entry reads back as a server network', async () => {
  const { loadParams, autoTradingEntry } = await lib();
  const entries = Object.assign({}, ...['base', 'ethereum', 'arbitrum'].map(c => autoTradingEntry(loadParams(c), { router: ROUTER, safeModule: MODULE })));
  await withNetworks(entries, networks => {
    assert.deepEqual(networks.chainIds().sort((a, b) => a - b), [1, 8453, 42161]);
    const base = networks.network(8453), eth = networks.network(1), arb = networks.network(42161);
    assert.deepEqual([base.label, eth.label, arb.label], ['Base', 'Ethereum', 'Arbitrum']);
    assert.equal(base.router, ROUTER.toLowerCase());
    assert.equal(eth.sendRpc, 'https://rpc.flashbots.net/fast', 'Ethereum trades are sent privately');
    assert.equal(base.sendRpc, undefined);
    assert.equal(arb.sendRpc, undefined);
    assert.equal(eth.explorerTx, 'https://etherscan.io/tx/');
    assert.equal(arb.explorerTx, 'https://arbiscan.io/tx/');
    assert.deepEqual(Object.keys(eth.tokens), ['USDC', 'USDT', 'DAI', 'WETH', 'cbBTC']);
    assert.deepEqual(Object.keys(arb.tokens), ['USDC', 'USDT', 'WETH', 'WBTC', 'ARB']);
    assert.equal(networks.routerToken(arb, 'USDT').address, '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', 'Arbitrum\'s USD₮0 is offered as USDT');
    assert.equal(networks.routerToken(base, '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf').symbol, 'cbBTC');
    for (const n of [base, eth, arb]) {
      assert.equal(networks.routerToken(n, n.defaultBase).decimals, 6, `${n.label}: USDC is the default base`);
      assert.ok(n.delegationManager, `${n.label}: MetaMask's delegation contracts are there`);
    }
  });
});

test('a buy must be large enough that its fee covers the gas RektBull pays', async () => {
  const { loadParams, autoTradingEntry } = await lib();
  const { ethers } = require('ethers');
  const venues = require('../src/trade/venues');
  const realView = venues.view;
  const realFee = ethers.JsonRpcProvider.prototype.getFeeData;
  // ETH at $2,000 from the router's feed; the fee 1%; gas at 20 gwei on Ethereum.
  venues.view = async (_net, fn, args) => (fn === 'FEE_BPS' ? 100n : fn === 'valueUsd' ? args[1] * 2000n * 10n ** 8n / 10n ** 18n : 0n);
  ethers.JsonRpcProvider.prototype.getFeeData = async () => ({ gasPrice: 20n * 10n ** 9n, maxFeePerGas: 60n * 10n ** 9n });
  try {
    await withNetworks(autoTradingEntry(loadParams('ethereum'), { router: ROUTER, safeModule: MODULE }), async networks => {
      const autonomous = require('../src/trade/autonomous');
      const eth = networks.network(1);
      // 450,000 gas x 20 gwei = 0.009 ETH = $18, priced at the current gas price, not the cap: so at least $1,800.
      assert.deepEqual(await autonomous.coversGas(eth, 1000), { ok: false, minUsd: 1800, gasUsd: 18 });
      assert.equal((await autonomous.coversGas(eth, 1800)).ok, true);
      assert.equal((await autonomous.coversGas(eth, 5000, 200000n)).ok, true, 'the real estimate is used before sending');
      const testnet = { ...eth, chainId: 84532 };
      assert.deepEqual(await autonomous.coversGas(testnet, 1), { ok: true, minUsd: 0, gasUsd: 0 }, 'test networks are free');
      assert.match(autonomous.sendProvider(eth)._getConnection().url, /rpc\.flashbots\.net/);
      assert.doesNotMatch(autonomous.sendProvider({ ...eth, sendRpc: undefined, chainId: 8453, name: 'base' })._getConnection().url, /flashbots/);
      autonomous.close();
    });
  } finally {
    venues.view = realView;
    ethers.JsonRpcProvider.prototype.getFeeData = realFee;
  }
});

test('trades the user signs are offered on Base, Ethereum and Arbitrum', () => {
  const { TRADE_CHAINS, tradeChain } = require('../src/trade/chains');
  assert.deepEqual(Object.fromEntries(Object.entries(TRADE_CHAINS).map(([k, c]) => [k, c.chainId])), { base: 8453, ethereum: 1, arbitrum: 42161 });
  for (const c of Object.values(TRADE_CHAINS)) {
    assert.equal(c.allowanceHolder, '0x0000000000001ff3684f28c67538d4d072c22734', `${c.label}: 0x's AllowanceHolder only`);
    assert.deepEqual(Object.keys(c.bases), ['USDC', 'ETH', 'WETH']);
  }
  assert.equal(tradeChain('Arbitrum').bases.USDC.address, '0xaf88d065e77c8cc2239327c5edb3a432268e5831');
  assert.throws(() => tradeChain('polygon'), /base, ethereum, arbitrum/);
});

const DB = process.env.TEST_DATABASE_URL;
test('on a network that sends privately, the next trade waits for the one in flight', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  Object.assign(process.env, { DATABASE_URL: DB, TRADING_ENABLED: 'true' });
  for (const k of Object.keys(require.cache)) if (k.includes('/src/')) delete require.cache[k];
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());
  const { loadParams, autoTradingEntry } = await lib();
  const entries = { ...autoTradingEntry(loadParams('ethereum'), { router: ROUTER, safeModule: MODULE }), ...autoTradingEntry(loadParams('arbitrum'), { router: ROUTER, safeModule: MODULE }) };
  await withNetworks(entries, async () => {
    const { rows: [a] } = await db.query(`INSERT INTO accounts (wallet) VALUES ('0x${'ab'.repeat(20)}') RETURNING id, wallet`);
    const intent = (chain, status) => db.query(
      `INSERT INTO trade_intents (id, account_id, wallet, chain_id, side, token, base, amount_usd, source, status, tx_hash, sent_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'buy', '0x${'cd'.repeat(20)}', '0x${'ef'.repeat(20)}', 5000, 'user', $4, $5, CASE WHEN $4 = 'sent' THEN now() END) RETURNING id`,
      [a.id, a.wallet, chain, status, status === 'sent' ? '0x' + '11'.repeat(32) : null]).then(r => r.rows[0].id);
    await intent(1, 'sent');
    const waiting = await intent(1, 'queued');
    const arbitrum = await intent(42161, 'queued');
    const autonomous = require('../src/trade/autonomous');
    autonomous.confirm = async () => {}; // the sent one stays in flight (its receipt isn't asked for)
    await autonomous.tick().catch(() => {});
    const status = async id => (await db.query('SELECT status, error FROM trade_intents WHERE id = $1', [id])).rows[0];
    assert.equal((await status(waiting)).status, 'queued', 'Ethereum: waits while another trade is in flight');
    assert.notEqual((await status(arbitrum)).status, 'queued', 'Arbitrum sends publicly: not held back (here it fails: it has no permission)');
    autonomous.close();
  });
});
