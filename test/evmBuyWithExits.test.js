/**
 * Exits with a buy on BNB Chain and Base (trade/proposals.js with trade/memeOrders.js exitsForBuy), on the real
 * database with a stand-in chain and 0x: the Trade desk's buy on Base with a stop-loss and a take-profit for the
 * coins it is sure to bring, valued at the buy's own price; the router's approval in the buy's own batch, after the
 * swap; the orders the wallet signs right after it sends the buy, waiting until the buy lands, then open; dropped
 * if the buy fails; and the buy never held up by exits that can't be added.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, { DATABASE_URL: DB || '', JWT_SECRET: 'test-secret', TRADING_ENABLED: 'true', SWAP_FEE_WALLET_EVM: '0x' + 'fe'.repeat(20), ZEROEX_API_KEY: 'test' });
const env = require('../src/config/env');
const tx = require('../src/trade/memeOrderTx');
const orders = require('../src/trade/memeOrders');
const { standIn, E18, ROUTER_BASE, ROUTER_BSC, AH, BULL } = require('./helpers/memeChain');


test('exits with a buy on Base: valued at the buy\'s price, approved in its batch, signed after it, opened when it lands', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  require('../src/lib/cache')._memory.clear();
  const user = ethers.Wallet.createRandom();
  const owner = user.address.toLowerCase();
  const exec = '0x' + 'e'.repeat(40);
  const saved = { ...env };
  Object.assign(env, { memeOrdersEnabled: true, memeRouters: { base: ROUTER_BASE, bsc: ROUTER_BSC }, memeOrdersExecutor: exec });
  const chain = standIn();
  orders._setProvider(name => chain.provider(orders.CHAINS[name].chainId));

  const zeroex = require('../src/trade/zeroex');
  const lp = require('../src/services/launchpads');
  const dd = require('../src/services/dueDiligence');
  const launches = require('../src/services/launches');
  const dexscreener = require('../src/providers/dexscreener');
  const prices = require('../src/providers/prices');
  const orig = { identify: lp.identify, quick: dd.quickCheck, forTrade: launches.forTrade, pairs: dexscreener.pairs, usd: prices.usdPrice };
  t.after(async () => {
    lp.identify = orig.identify; dd.quickCheck = orig.quick; launches.forTrade = orig.forTrade; dexscreener.pairs = orig.pairs; prices.usdPrice = orig.usd;
    orders._setProvider(null); Object.assign(env, saved);
    await db.getPool().end();
  });
  // 0x: $100 of USDC buys 1,000 BULL (at least 990); selling them straight back returns $97. tax: what 0x reports.
  let tax = '0';
  zeroex.setTransport(async (path, params) => {
    if (params.buyToken.toLowerCase() === BULL) { // a buy, paid in USDC
      const out = BigInt(params.sellAmount) * 10n ** 13n; // 1,000 BULL per $100 (USDC has 6 decimals, BULL 18)
      return { liquidityAvailable: true, sellAmount: params.sellAmount, buyAmount: String(out), minBuyAmount: String(out * 99n / 100n), tokenMetadata: { buyToken: { buyTaxBps: tax, sellTaxBps: tax } },
        issues: { allowance: { spender: AH } }, transaction: { to: AH, data: '0xbeef', value: '0' } };
    }
    return { liquidityAvailable: true, sellAmount: params.sellAmount, buyAmount: String(BigInt(params.sellAmount) * 97n / 10n ** 15n), minBuyAmount: '1', transaction: { to: AH, data: '0xfeed', value: '0' } };
  });
  lp.identify = async () => ({ launchpad: null });
  dd.quickCheck = async () => ({ verdict: 'low', flags: [], disagreements: [] });
  launches.forTrade = async () => ({ young: false, risk: 'ok', detail: 'its first pool opened 90 days ago (DexScreener)' });
  dexscreener.pairs = async (c, tokens) => Object.fromEntries(tokens.map(tk => [tk, { price_usd: 0.1, symbol: 'BULL' }]));
  prices.usdPrice = async () => 3000; // ETH

  const proposals = require('../src/trade/proposals');
  const { rows: [{ id: acct }] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id', [owner]);
  const account = { id: acct, wallet: owner };
  chain.hold(BULL, owner, 0n); // the token the stand-in chain answers for (balance, allowance, decimals)
  const EXITS = { stop_loss: true, take_profit: true, stop_pct: 20, take_pct: 50 };
  const buy = extra => ({ chain: 'base', side: 'buy', token: BULL, base: 'USDC', amount_usd: 100, exits: EXITS, ...extra });

  // 1. The preview shows the exits: for the 990 BULL the buy is sure to bring, $99 at its price = 0.033 ETH.
  const pv = await proposals.preview(account, buy());
  const x = pv.plan.summary.exits;
  assert.equal(x.native, 'ETH');
  assert.deepEqual(x.orders.map(o => [o.kind, o.trigger_native, o.floor_native]), [['stop_loss', '0.0264', '0.0212355'], ['take_profit', '0.0495', '0.04753485']],
    'stop at down 20%, floor at down 35%; take at up 50% less 3%; each floor after the 1% fee');
  assert.match(x.covers, /^the 990 BULL this buy is sure to bring/);
  assert.match(x.how, /signs them right after it sends the buy.*approval of RektBull's Meme Router for these coins is in the buy's own batch, after the swap/);
  assert.ok(pv.plan.checks.some(c => c.check === 'exits' && /hashOrder/.test(c.source)));

  // 2. One click: the buy's calls carry the router's approval after the swap, for both exits' coins; the orders come back to sign.
  const t1 = await proposals.trade(account, buy());
  assert.deepEqual(t1.calls.calls.map(c => c.step), ['approve', 'swap', 'exit_approve']);
  const ap = t1.calls.calls[2];
  assert.equal(ap.to.toLowerCase(), BULL);
  assert.deepEqual(tx.ERC20.decodeFunctionData('approve', ap.data).map(String), [ethers.getAddress(ROUTER_BASE), (1980n * E18).toString()]);
  assert.equal(t1.exit_orders.length, 2);
  for (const o of t1.exit_orders) {
    const m = o.typed_data.message;
    assert.deepEqual([m.account, m.tokenIn, m.tokenOut, m.amountIn, m.executor], [user.address, ethers.getAddress(BULL), tx.NATIVE, (990n * E18).toString(), ethers.getAddress(exec)]);
    assert.equal(o.typed_data.domain.verifyingContract, ethers.getAddress(ROUTER_BASE));
  }

  // 3. The wallet sent the buy, then signs the exits: they wait for it, shown as waiting; nothing to send.
  const sign = async o => { const { EIP712Domain, ...types } = o.typed_data.types; return user.signTypedData(o.typed_data.domain, types, o.typed_data.message); };
  await proposals.submitted(account, t1.id, '0x' + 'ab'.repeat(32));
  for (const o of t1.exit_orders) {
    const s = await orders.sign(account, o.id, { signature: await sign(o) });
    assert.equal(s.order.state, 'prepared');
    assert.equal(s.order.waiting_for_buy, true);
    assert.deepEqual(s.calls.calls, []);
  }
  assert.deepEqual((await orders.list(account)).orders.map(o => o.waiting_for_buy), [true, true]);
  await orders._reconcile({ force: true });
  assert.ok((await orders.list(account)).orders.every(o => o.state === 'prepared'), 'not open before the buy lands');

  // 4. The buy lands (the trade service confirms it): both exits open.
  await db.query(`UPDATE trade_proposals SET status = 'confirmed' WHERE id = $1`, [t1.id]);
  await orders._reconcile({ force: true });
  assert.deepEqual((await orders.list(account)).orders.map(o => o.state), ['open', 'open']);

  // 5. A second buy with exits whose buy fails: its exits are dropped. The approval counts the open exits too.
  const t2 = await proposals.trade(account, buy({ exits: { stop_loss: true } }));
  assert.deepEqual(tx.ERC20.decodeFunctionData('approve', t2.calls.calls[2].data)[1], 990n * E18 + 1980n * E18, 'an approval replaces the one before it');
  await orders.sign(account, t2.exit_orders[0].id, { signature: await sign(t2.exit_orders[0]) });
  await db.query(`UPDATE trade_proposals SET status = 'failed' WHERE id = $1`, [t2.id]);
  await orders._reconcile({ force: true });
  assert.equal((await orders.list(account)).orders.length, 2, 'the failed buy\'s exit is gone');
  // Signing after the buy failed: refused, and nothing placed.
  const t3 = await proposals.trade(account, buy({ exits: { take_profit: true } }));
  await proposals.cancel(account, t3.id);
  await assert.rejects(orders.sign(account, t3.exit_orders[0].id, { signature: await sign(t3.exit_orders[0]) }), /buy didn't go through/);

  // 6. A signed exit still waiting for its buy is cancelled on the router, not just forgotten (the signature exists).
  const t4 = await proposals.trade(account, buy({ exits: { stop_loss: true } }));
  await proposals.submitted(account, t4.id, '0x' + 'cd'.repeat(32));
  await orders.sign(account, t4.exit_orders[0].id, { signature: await sign(t4.exit_orders[0]) });
  const c = await orders.cancel(account, t4.exit_orders[0].id);
  assert.equal(tx.ROUTER.parseTransaction({ data: c.calls[0].data }).name, 'cancel');

  // 7. Exits never hold the buy up: when they can't be added, the buy goes ahead and the plan says why.
  const none = async extra => (await proposals.preview(account, buy(extra))).plan.summary.exits;
  assert.match((await none({ amount_usd: 5 })).none, /^No exits were added: an order needs at least \$5.*cost \$4\.95/);
  tax = '300';
  assert.match((await none({})).none, /taxes transfers \(3%, 0x\)/);
  tax = '0';
  env.memeOrdersEnabled = false;
  assert.match((await none({})).none, /audited and deployed/);
  env.memeOrdersEnabled = true;
  require('../src/lib/cache')._memory.clear();
  await db.query('DELETE FROM cache');
  orders._setProvider(() => ({ getCode: async () => { throw new Error('connection refused'); } }));
  const down = await proposals.preview(account, buy());
  assert.match(down.plan.summary.exits.none, /couldn't be prepared just now \(connection refused\)/);
  assert.equal(down.plan.summary.min_buy_amount, (990n * E18).toString(), 'the buy itself is unchanged');
  orders._setProvider(name => chain.provider(orders.CHAINS[name].chainId));
  // On Ethereum there's no Meme Router: exits aren't asked for at all.
  assert.equal((await proposals.preview(account, buy({ chain: 'ethereum', base: 'USDC', token: BULL }))).plan.summary.exits, undefined);
});
