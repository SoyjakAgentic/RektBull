/**
 * Orders on Virtuals curve coins on Base (src/trade/memeOrders.js, src/trade/memeRouterParams.js), on the real
 * database with the stand-in chain of test/helpers/memeChain.js: priced in VIRTUAL (what Virtuals' curve trades in);
 * a stop-loss and a limit buy filled on Virtuals' BondingV5 with FRouterV3 approved; refused while Virtuals'
 * anti-sniper tax runs, on Virtuals' old curve, after Virtuals upgrades its code, and on a router deployed without
 * Virtuals; exits with a buy in VIRTUAL. The router itself was run against Virtuals' real contracts on a copy of Base
 * (contracts/scripts/memeRouterVirtualsCheck.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, { DATABASE_URL: DB || '', JWT_SECRET: 'test-secret' });
const env = require('../src/config/env');
const tx = require('../src/trade/memeOrderTx');
const orders = require('../src/trade/memeOrders');
const params = require('../src/trade/memeRouterParams');
const { standIn, lp, E18, ROUTER_BASE, AH } = require('./helpers/memeChain');

const VC = '0x' + 'cc'.repeat(20); // a coin on Virtuals' curve
const VIRTUAL = lp.VIRTUAL;

test('the router\'s deployment on Base names Virtuals\' current curve, and VIRTUAL as a base asset', () => {
  const b = params.PARAMS.base;
  assert.deepEqual(b.venues, [AH, lp.ADDR.bondingV5, lp.ADDR.frouterV3]);
  assert.ok(b.bases.includes(VIRTUAL));
  assert.ok(!b.venues.includes(lp.ADDR.bonding), 'not Virtuals\' old curve');
  assert.deepEqual(Object.keys(b.implementations).sort(), [lp.ADDR.bondingV5, lp.ADDR.frouterV3].sort(), 'both proxies watched for upgrades');
  assert.deepEqual(params.constructorArgs('base', '0x' + 'fe'.repeat(20)), ['0x' + 'fe'.repeat(20), 100, b.wrapped, b.venues, b.bases]);
  assert.throws(() => params.constructorArgs('solana', '0x'), /no Meme Router parameters/);
});

test('orders on a Virtuals curve coin: in VIRTUAL, filled on BondingV5; refused when the router can\'t trade there', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  const cache = require('../src/lib/cache');
  const fresh = async () => { cache._memory.clear(); await db.query('DELETE FROM cache'); };
  await fresh();
  const user = ethers.Wallet.createRandom();
  const exec = ethers.Wallet.createRandom();
  const owner = user.address.toLowerCase();
  const saved = { ...env };
  Object.assign(env, { memeOrdersEnabled: true, memeRouters: { base: ROUTER_BASE }, memeOrdersExecutor: exec.address.toLowerCase() });
  const chain = standIn();
  orders._setProvider(name => chain.provider(orders.CHAINS[name].chainId));
  let nonce = 0;
  orders._setExecutor(async name => ({
    address: exec.address.toLowerCase(),
    signer: { populateTransaction: async c => ({ to: c.to, data: c.data, value: 0n, chainId: orders.CHAINS[name].chainId, nonce: nonce++, gasLimit: 300_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n, type: 2 }), signTransaction: t2 => exec.signTransaction(t2) },
  }));
  chain.native.set(exec.address.toLowerCase(), E18);

  const dd = require('../src/services/dueDiligence');
  const launches = require('../src/services/launches');
  const dexscreener = require('../src/providers/dexscreener');
  const prices = require('../src/providers/prices');
  const orig = { identify: lp.identify, buyQ: lp.curveBuyQuote, sellQ: lp.curveSellQuote, quick: dd.quickCheck, forTrade: launches.forTrade, pairs: dexscreener.pairs, usd: prices.usdPrice };
  t.after(async () => {
    Object.assign(lp, { identify: orig.identify, curveBuyQuote: orig.buyQ, curveSellQuote: orig.sellQ });
    dd.quickCheck = orig.quick; launches.forTrade = orig.forTrade; dexscreener.pairs = orig.pairs; prices.usdPrice = orig.usd;
    orders._setProvider(null); orders._setExecutor(null); Object.assign(env, saved);
    await db.getPool().end();
  });
  // Virtuals' curve, as identify() reads it: BondingV5 with FRouterV3, 1% taxes, no anti-sniper tax running.
  let pad = { launchpad: 'virtuals', version: 5, state: 'curve', bonding: lp.ADDR.bondingV5, frouter: lp.ADDR.frouterV3,
    curve: { buy_tax_pct: 1, sell_tax_pct: 1, anti_sniper: { ends_at: null, starts_at: null } } };
  lp.identify = async (c, token) => (c === 'base' && token === VC ? pad : { launchpad: null });
  // The curve's quotes: `rate` VIRTUAL a coin (after Virtuals' tax).
  let rate = 0.01;
  const calls = { buy: [], sell: [] };
  lp.curveSellQuote = async (token, amount, p) => { calls.sell.push({ token, amount, p }); return BigInt(Math.floor(Number(amount) * rate)); };
  lp.curveBuyQuote = async (token, spend, p) => { calls.buy.push({ token, spend, p }); return BigInt(Math.floor(Number(spend) / rate)); };
  let priceUsd = 0.02; // 1,000 coins = $20 = 10 VIRTUAL at $2
  dexscreener.pairs = async (c, tokens) => Object.fromEntries(tokens.map(tk => [tk, { price_usd: priceUsd, symbol: 'VC' }]));
  prices.usdPrice = async id => (id === 'coingecko:virtual-protocol' ? 2 : 3000);
  dd.quickCheck = async () => ({ verdict: 'low', flags: [] });
  launches.forTrade = async () => ({ young: false, risk: 'ok', detail: 'old enough' });

  const { rows: [{ id: acct }] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id', [owner]);
  const account = { id: acct, wallet: owner };
  chain.hold(VC, owner, 1000n * E18);
  chain.hold(VIRTUAL, owner, 10n * E18);
  const sign = async p => { const { EIP712Domain, ...types } = p.typed_data.types; return user.signTypedData(p.typed_data.domain, types, p.typed_data.message); };
  const lastFill = () => {
    const c = tx.ROUTER.parseTransaction({ data: ethers.Transaction.from(chain.sent[chain.sent.length - 1].raw).data });
    return { o: tx.order(c.args[0].toObject()), f: c.args[2].toObject() };
  };

  // 1. A stop-loss: priced in VIRTUAL (1,000 VC sell for 10 VIRTUAL now), its sale pays out VIRTUAL.
  const sl = await orders.prepare(account, { chain: 'base', kind: 'stop_loss', token: VC, stop_pct: 20, floor_pct: 40 });
  assert.equal(sl.order.native, 'VIRTUAL');
  assert.equal(sl.typed_data.message.tokenOut, ethers.getAddress(VIRTUAL));
  assert.equal(sl.order.trigger_native, '8');
  assert.equal(sl.order.floor_native, '5.94', 'down 40%, less the 1% fee');
  assert.match(sl.worst_case[0], /sold for 5\.94 VIRTUAL after the 1% fee \(your floor\)/);
  assert.match(sl.notes.join(' '), /Virtuals' bonding curve, which trades in VIRTUAL, so this order is in VIRTUAL/);
  assert.ok(sl.checks.some(c => c.check === 'route' && /FRouterV3/.test(c.source)));
  assert.match(sl.costs.fee, /1% of the VIRTUAL a fill brings/);
  const sls = await orders.sign(account, sl.order.id, { signature: await sign(sl) });
  assert.deepEqual(sls.calls.calls.map(c => c.to.toLowerCase()), [VC], 'the approval for the coins');
  chain.approve(VC, owner, ROUTER_BASE, 1000n * E18);

  // 2. The price falls (1,000 VC = 7 VIRTUAL at $2: under the 8 stop): it fires, and fills on BondingV5, FRouterV3 approved.
  priceUsd = 0.014; rate = 0.007; await fresh();
  await orders.tick();
  assert.equal(chain.sent.length, 1);
  const s1 = lastFill();
  assert.deepEqual([s1.f.venue.toLowerCase(), s1.f.spender.toLowerCase(), s1.f.unwrapIn], [lp.ADDR.bondingV5, lp.ADDR.frouterV3, false]);
  const sell = lp.BONDING_V5.decodeFunctionData('sell', s1.f.venueCalldata);
  assert.equal(sell[0], 1000n * E18, 'all of it: the fee is on the output (VIRTUAL is a base asset)');
  assert.equal(sell[1].toLowerCase(), VC);
  assert.equal(sell[2], (594n * 10n ** 16n * 10000n + 9899n) / 9900n, 'Virtuals\' own minimum: the floor grossed up for the fee');
  assert.ok(calls.sell.at(-1).p === pad, 'quoted on the curve read for this coin');

  // 3. A limit buy, in VIRTUAL: refused while the wallet holds too little (VIRTUAL can't be wrapped from ETH), then placed.
  await assert.rejects(orders.prepare(account, { chain: 'base', kind: 'limit_buy', token: VC, spend: 20, dip_pct: 20 }), /holds 10 VIRTUAL, and this buy spends 20/);
  chain.hold(VIRTUAL, owner, 50n * E18);
  rate = 0.01; priceUsd = 0.02; await fresh();
  const lb = await orders.prepare(account, { chain: 'base', kind: 'limit_buy', token: VC, spend: 20, dip_pct: 20, slippage_pct: 3 });
  assert.equal(lb.order.native, 'VIRTUAL');
  assert.equal(lb.typed_data.message.tokenIn, ethers.getAddress(VIRTUAL));
  assert.match(lb.worst_case[0], /your 20 VIRTUAL buys/);
  assert.match(lb.worst_case[2], /your VIRTUAL stays in your wallet/);
  assert.ok(lb.checks.find(c => c.check === 'per_trade_amount').detail.includes('$40'), '20 VIRTUAL at $2');
  const lbs = await orders.sign(account, lb.order.id, { signature: await sign(lb) });
  assert.deepEqual(lbs.calls.calls.map(c => [c.to.toLowerCase(), tx.ERC20.parseTransaction({ data: c.data }).name]), [[VIRTUAL, 'approve']], 'an approval, nothing wrapped');
  chain.approve(VIRTUAL, owner, ROUTER_BASE, 20n * E18);
  // The price falls 20%: it buys on the curve.
  priceUsd = 0.015; rate = 0.0075; await fresh();
  await orders.tick();
  assert.equal(chain.sent.length, 2);
  const b1 = lastFill();
  assert.deepEqual([b1.f.venue.toLowerCase(), b1.f.spender.toLowerCase(), b1.f.unwrapIn], [lp.ADDR.bondingV5, lp.ADDR.frouterV3, false]);
  const buyArgs = lp.BONDING_V5.decodeFunctionData('buy', b1.f.venueCalldata);
  assert.equal(buyArgs[0], 198n * 10n ** 17n, '99% of the 20 VIRTUAL: the router keeps 1% back for its fee');
  assert.equal(buyArgs[2], tx.minimumFor(b1.o.minAmountOut, b1.f.amountIn, b1.o.amountIn), 'the curve\'s own minimum is the user\'s limit');

  // 4. Refusals: Virtuals' anti-sniper tax running; Virtuals' old curve; Virtuals' code upgraded; a router deployed without Virtuals.
  pad = { ...pad, curve: { ...pad.curve, anti_sniper: { ends_at: '2026-11-25T20:00:00.000Z', starts_at: null } } };
  await assert.rejects(orders.prepare(account, { chain: 'base', kind: 'stop_loss', token: VC }), /anti-sniper tax is running on this coin until 2026-11-25T20:00/);
  pad = { ...pad, version: undefined, bonding: lp.ADDR.bonding, frouter: lp.ADDR.frouter, curve: { ...pad.curve, anti_sniper: { ends_at: null, starts_at: null } } };
  await assert.rejects(orders.prepare(account, { chain: 'base', kind: 'stop_loss', token: VC }), /Virtuals' old bonding curve/);
  pad = { ...pad, version: 5, bonding: lp.ADDR.bondingV5, frouter: lp.ADDR.frouterV3 };
  // An open stop-loss on the coin, placed before Virtuals upgrades its code.
  priceUsd = 0.02; rate = 0.01; await fresh();
  const sl2 = await orders.prepare(account, { chain: 'base', kind: 'stop_loss', token: VC, share_pct: 50, stop_pct: 20, floor_pct: 40 });
  await orders.sign(account, sl2.order.id, { signature: await sign(sl2) });
  chain.approve(VC, owner, ROUTER_BASE, 1500n * E18);
  chain.storage.set(`${lp.ADDR.frouterV3}:0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`, ethers.zeroPadValue('0x' + '9'.repeat(40), 32));
  await fresh();
  await assert.rejects(orders.prepare(account, { chain: 'base', kind: 'stop_loss', token: VC }), /Virtuals has upgraded FRouterV3 since RektBull checked them/);
  // The open stop-loss fires, but waits, saying why; nothing is sent.
  priceUsd = 0.014; rate = 0.007; await fresh();
  chain.storage.set(`${lp.ADDR.frouterV3}:0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`, ethers.zeroPadValue('0x' + '9'.repeat(40), 32));
  await orders.tick();
  const waiting = (await orders.list(account)).orders.find(o => o.id === sl2.order.id);
  assert.equal(waiting.state, 'triggered');
  assert.match(waiting.last_error, /Virtuals has upgraded FRouterV3/);
  assert.equal(chain.sent.length, 2, 'nothing sent');
  chain.storage.clear();
  chain.routers[ROUTER_BASE].venues = [AH];
  await fresh();
  await assert.rejects(orders.prepare(account, { chain: 'base', kind: 'stop_loss', token: VC }), /wasn't deployed with Virtuals' curve/);
  chain.routers[ROUTER_BASE].venues = params.PARAMS.base.venues;
  await fresh();

  // 5. Exits with a buy of a Virtuals curve coin: in VIRTUAL too.
  const settings = await require('../src/trade/rules').settingsFor(acct);
  const exits = await orders.exitsForBuy({ accountId: acct, owner, chain: 'base', token: VC, minOut: (990n * E18).toString(), buyAmount: (1000n * E18).toString(), valueUsd: 20, exits: { stop_loss: true }, settings });
  assert.equal(exits.summary.native, 'VIRTUAL');
  assert.match(exits.summary.note, /these exits pay out VIRTUAL/);
  assert.equal(exits.orders[0].order.tokenOut, ethers.getAddress(VIRTUAL));
  assert.equal(exits.orders[0].refOut, 99n * 10n ** 17n, '990 coins of a $20 buy of 1,000 = $19.80 = 9.9 VIRTUAL');
});
