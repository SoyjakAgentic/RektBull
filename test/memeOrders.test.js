/**
 * Orders on BNB Chain and Base (src/trade/memeOrders.js), on the real database
 * with a stand-in chain (an RPC that answers as the Meme Router and the tokens
 * would), 0x, four.meme and the price feeds: placed (the worst case, the
 * router's own hash), signed (the user's key checked; the approval and the
 * wrapping their wallet sends), fired by its price, filled by the executor
 * (checked as a call first, signed, recorded, sent), confirmed from the
 * router's Filled event; below the floor not sent; Meme Watch exits; the
 * emergency stop; cancelling one or all. The calls themselves run against the
 * router in contracts/test/memeOrdersService.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, { DATABASE_URL: DB || '', JWT_SECRET: 'test-secret' });
const env = require('../src/config/env');
const tx = require('../src/trade/memeOrderTx');
const orders = require('../src/trade/memeOrders');

const E18 = 10n ** 18n;
const ROUTER_BASE = '0x' + '1'.repeat(40);
const ROUTER_BSC = '0x' + '2'.repeat(40);
const AH = '0x0000000000001ff3684f28c67538d4d072c22734';
const TM2 = '0x5c952063c7fc8610ffdb798152d69f0b9550762b';
const WETH = '0x4200000000000000000000000000000000000006';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const BULL = '0x' + 'b0'.repeat(20); // a meme coin on Base
const FOUR = '0x' + 'f4'.repeat(20); // a coin on its four.meme curve
const FEE_WALLET = '0x' + 'fe'.repeat(20);
const net = x => x - x / 100n;

test('off until set up: a plain reason, and nothing runs', async () => {
  const saved = { ...env };
  try {
    Object.assign(env, { memeOrdersEnabled: false });
    assert.match(orders.config().off, /once RektBull's Meme Router has been audited and deployed/);
    await assert.rejects(orders.prepare({ id: 1, wallet: '0x' + 'ab'.repeat(20) }, { chain: 'base', kind: 'stop_loss', token: BULL }), e => e.status === 503);
    assert.deepEqual(await orders.tick(), { skipped: orders.config().off });
    Object.assign(env, { memeOrdersEnabled: true, memeRouters: {}, memeOrdersExecutor: '' });
    assert.match(orders.config().off, /MEME_ROUTERS/);
    Object.assign(env, { memeRouters: { base: ROUTER_BASE, solana: 'x' } });
    assert.match(orders.config().off, /MEME_ORDERS_EXECUTOR/);
    Object.assign(env, { memeOrdersExecutor: '0x' + 'e'.repeat(40) });
    assert.deepEqual(orders.config().routers, { base: ROUTER_BASE }, 'only BNB Chain and Base, only addresses');
    await assert.rejects(orders.prepare({ id: 1, wallet: '0x' + 'ab'.repeat(20) }, { chain: 'ethereum', kind: 'stop_loss', token: BULL }), /chain must be base or bsc/);
  } finally { Object.assign(env, saved); }
});

/** The stand-in chain: the routers, the tokens, balances, approvals, and what was sent. */
function standIn() {
  const s = {
    tokens: new Map(), // address -> Map(owner -> balance)
    allowances: new Map(), // `${token}:${owner}:${spender}` -> amount
    native: new Map(),
    epoch: new Map(), cancelled: new Set(), filled: new Map(),
    receipts: new Map(), sent: [],
    onFill: null, // (order, fill) => throws a revert, or returns
  };
  const routers = { [ROUTER_BASE]: { chainId: 8453, wrapped: WETH, venues: [AH] }, [ROUTER_BSC]: { chainId: 56, wrapped: WBNB, venues: [AH, TM2] } };
  const revert = (name, args) => Object.assign(new Error(`reverted: ${name}`), { data: tx.ROUTER.encodeErrorResult(name, args) });
  s.provider = chainId => ({
    getCode: async a => (routers[a.toLowerCase()] || s.tokens.has(a.toLowerCase()) ? '0x6080' : '0x'),
    getBalance: async a => s.native.get(a.toLowerCase()) ?? 0n,
    getFeeData: async () => ({ maxFeePerGas: 1_000_000_000n, gasPrice: 1_000_000_000n }),
    getTransactionReceipt: async h => s.receipts.get(h) || null,
    broadcastTransaction: async raw => { s.sent.push({ chainId, raw }); },
    async call({ to, data }) {
      to = to.toLowerCase();
      if (routers[to]) {
        const r = routers[to];
        const c = tx.ROUTER.parseTransaction({ data });
        const out = v => tx.ROUTER.encodeFunctionResult(c.name, [v]);
        switch (c.name) {
          case 'FEE_BPS': return out(100);
          case 'FEE_WALLET': return out(FEE_WALLET);
          case 'WRAPPED_NATIVE': return out(r.wrapped);
          case 'isVenue': return out(r.venues.includes(c.args[0].toLowerCase()));
          case 'epochOf': return out(s.epoch.get(c.args[0].toLowerCase()) ?? 0n);
          case 'hashOrder': return out(tx.hash(r.chainId, to, tx.order(c.args[0].toObject())));
          case 'cancelled': return out(s.cancelled.has(c.args[0].toLowerCase()));
          case 'filled': return out(s.filled.get(c.args[0].toLowerCase()) ?? 0n);
          case 'fill': {
            const o = tx.order(c.args[0].toObject());
            if (tx.signer(r.chainId, to, o, c.args[1]).toLowerCase() !== o.account.toLowerCase()) throw revert('BadSignature', []);
            if (s.onFill) s.onFill(o, c.args[2].toObject());
            return out(1n);
          }
          default: throw new Error(`unexpected router call ${c.name}`);
        }
      }
      if (s.tokens.has(to)) {
        const c = tx.ERC20.parseTransaction({ data });
        const out = v => tx.ERC20.encodeFunctionResult(c.name, [v]);
        switch (c.name) {
          case 'decimals': return out(18);
          case 'symbol': return out('TKN');
          case 'balanceOf': return out(s.tokens.get(to).get(c.args[0].toLowerCase()) ?? 0n);
          case 'allowance': return out(s.allowances.get(`${to}:${c.args[0].toLowerCase()}:${c.args[1].toLowerCase()}`) ?? 0n);
          default: throw new Error(`unexpected token call ${c.name}`);
        }
      }
      throw new Error(`unexpected call to ${to}`);
    },
  });
  s.hold = (token, owner, amount) => { if (!s.tokens.has(token)) s.tokens.set(token, new Map()); s.tokens.get(token).set(owner.toLowerCase(), amount); };
  s.approve = (token, owner, spender, amount) => s.allowances.set(`${token}:${owner.toLowerCase()}:${spender.toLowerCase()}`, amount);
  s.revert = revert;
  return s;
}

test('orders on BNB Chain and Base, end to end: placed, signed, fired, filled by the executor, confirmed; below the floor; Meme Watch exits; the stop; cancelling', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  const cache = require('../src/lib/cache');
  const fresh = async () => { cache._memory.clear(); await db.query('DELETE FROM cache'); }; // prices are cached 10 seconds
  const user = ethers.Wallet.createRandom();
  const exec = ethers.Wallet.createRandom();
  const owner = user.address.toLowerCase();
  const saved = { ...env };
  Object.assign(env, { memeOrdersEnabled: true, memeRouters: { base: ROUTER_BASE, bsc: ROUTER_BSC }, memeOrdersExecutor: exec.address.toLowerCase() });
  const chain = standIn();
  orders._setProvider(name => chain.provider(orders.CHAINS[name].chainId));
  let nonce = 0;
  orders._setExecutor(async (name, p) => ({
    address: exec.address.toLowerCase(),
    signer: {
      populateTransaction: async c => ({ to: c.to, data: c.data, value: 0n, chainId: orders.CHAINS[name].chainId, nonce: nonce++, gasLimit: 300_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n, type: 2 }),
      signTransaction: t2 => exec.signTransaction(t2),
    },
  }));
  chain.native.set(exec.address.toLowerCase(), E18);

  const zeroex = require('../src/trade/zeroex');
  const lp = require('../src/services/launchpads');
  const dd = require('../src/services/dueDiligence');
  const launches = require('../src/services/launches');
  const dexscreener = require('../src/providers/dexscreener');
  const prices = require('../src/providers/prices');
  const orig = { identify: lp.identify, fbq: lp.fourMemeBuyQuote, fsq: lp.fourMemeSellQuote, quick: dd.quickCheck, forTrade: launches.forTrade, pairs: dexscreener.pairs, usd: prices.usdPrice };
  t.after(async () => {
    Object.assign(lp, { identify: orig.identify, fourMemeBuyQuote: orig.fbq, fourMemeSellQuote: orig.fsq });
    dd.quickCheck = orig.quick; launches.forTrade = orig.forTrade; dexscreener.pairs = orig.pairs; prices.usdPrice = orig.usd;
    orders._setProvider(null); orders._setExecutor(null); Object.assign(env, saved);
    await db.getPool().end();
  });

  // 0x: a sale of BULL brings `sellRate` wei of ETH per whole coin; a quote's minimum is 3% under it.
  let sellRate = 5n * 10n ** 13n; // 0.00005 ETH a coin: 1,000 coins = 0.05 ETH = $150 at $3,000
  const zx = [];
  zeroex.setTransport(async (path, params) => {
    zx.push({ path, params });
    const buyAmount = String(BigInt(params.sellAmount) * sellRate / E18);
    const q = { liquidityAvailable: true, sellAmount: params.sellAmount, buyAmount, minBuyAmount: String(BigInt(buyAmount) * 97n / 100n) };
    if (path.endsWith('/quote')) q.transaction = { to: AH, data: '0xc0ffee', value: '0' };
    return q;
  });
  let price = { [BULL]: 0.15, [FOUR]: 0.03 };
  dexscreener.pairs = async (c, tokens) => Object.fromEntries(tokens.map(tk => [tk, { price_usd: price[tk], symbol: tk === BULL ? 'BULL' : 'FOUR' }]));
  prices.usdPrice = async id => (id.includes('binance') ? 600 : 3000);
  lp.identify = async (c, token) => (c === 'bsc' && token === FOUR
    ? { launchpad: 'fourmeme', state: 'curve', quote: 'bnb', token_manager: TM2 } : { launchpad: null });
  let fourRate = 20000n; // coins per BNB on the curve
  lp.fourMemeBuyQuote = async (token, funds) => ({ amount: funds * fourRate, msgValue: funds, manager: TM2 });
  lp.fourMemeSellQuote = async (token, amount) => ({ funds: amount / fourRate * 98n / 100n, fee: 0n });
  dd.quickCheck = async () => ({ verdict: 'low', flags: [] });
  launches.forTrade = async () => ({ young: false, risk: 'ok', detail: 'old enough' });

  const { rows: [{ id: acct }] } = await db.query(`INSERT INTO accounts (wallet) VALUES ($1) RETURNING id`, [owner]);
  const account = { id: acct, wallet: owner };
  chain.hold(BULL, owner, 1000n * E18);
  chain.hold(WETH, owner, 0n);
  chain.hold(WBNB, owner, 0n);
  chain.hold(FOUR, owner, 0n);
  const signFor = async p => {
    const { EIP712Domain, ...types } = p.typed_data.types;
    assert.equal(EIP712Domain.length, 4);
    return user.signTypedData(p.typed_data.domain, types, p.typed_data.message);
  };
  const lastFill = () => {
    const sent = ethers.Transaction.from(chain.sent[chain.sent.length - 1].raw);
    assert.equal(sent.from.toLowerCase(), exec.address.toLowerCase(), 'signed by the executor');
    const c = tx.ROUTER.parseTransaction({ data: sent.data });
    assert.equal(c.name, 'fill');
    return { sent, o: tx.order(c.args[0].toObject()), sig: c.args[1], f: c.args[2].toObject() };
  };

  // 1. A stop-loss on Base: the checks, the worst case, and the order for the user's wallet to sign.
  const p = await orders.prepare(account, { chain: 'base', kind: 'stop_loss', token: BULL, stop_pct: 20, floor_pct: 40, days: 7 });
  assert.equal(p.order.state, 'prepared');
  assert.equal(p.order.trigger_native, '0.04');
  assert.equal(p.order.floor_native, '0.0297', 'down 40%, less the 1% fee');
  assert.match(p.worst_case[0], /your 1,000 BULL are sold for 0\.0297 ETH after the 1% fee \(your floor\)/);
  assert.equal(p.chain_id, '0x2105');
  assert.deepEqual(p.typed_data.domain, { name: 'RektBull Meme Router', version: '1', chainId: 8453, verifyingContract: ethers.getAddress(ROUTER_BASE) });
  const m = p.typed_data.message;
  assert.deepEqual([m.account, m.executor, m.tokenIn, m.tokenOut, m.amountIn, m.minAmountOut], [user.address, ethers.getAddress(exec.address), ethers.getAddress(BULL), tx.NATIVE, (1000n * E18).toString(), (297n * 10n ** 14n).toString()]);
  assert.ok(p.checks.some(c => c.check === 'order' && /hashOrder/.test(c.source)), 'the router\'s own hash was checked');
  assert.ok(zx.every(q => q.path.endsWith('/price') && !q.params.swapFeeBps), 'prices only, with no 0x fee: the router takes the 1%');

  // Under $5, or with no EVM wallet: refused.
  price[BULL] = 0.15;
  await assert.rejects(orders.prepare(account, { chain: 'base', kind: 'stop_loss', token: BULL, share_pct: 2 }), /at least \$5/);
  await assert.rejects(orders.prepare({ id: acct, wallet: null }, { chain: 'base', kind: 'stop_loss', token: BULL }), e => e.status === 409);

  // 2. Signed: another key's signature is refused; the user's opens it, and their wallet is asked to approve exactly these coins.
  await assert.rejects(orders.sign(account, p.order.id, { signature: await ethers.Wallet.createRandom().signTypedData(p.typed_data.domain, { Order: tx.TYPES.Order }, p.typed_data.message) }), /isn't your wallet's/);
  const signed = await orders.sign(account, p.order.id, { signature: await signFor(p) });
  assert.equal(signed.order.state, 'open');
  assert.equal(signed.calls.chain_id, '0x2105');
  assert.equal(signed.calls.calls.length, 1);
  assert.deepEqual(tx.ERC20.decodeFunctionData('approve', signed.calls.calls[0].data).map(String), [ethers.getAddress(ROUTER_BASE), (1000n * E18).toString()]);
  assert.equal(signed.calls.calls[0].to.toLowerCase(), BULL);
  chain.approve(BULL, owner, ROUTER_BASE, 1000n * E18); // the user's wallet sent it

  // 3. The price holds: nothing fires. It falls past the stop: it fires, and the executor fills it through 0x's AllowanceHolder.
  await orders.tick();
  assert.equal(chain.sent.length, 0);
  price[BULL] = 0.11; // 1,000 coins = $110 = 0.0367 ETH, under the 0.04 stop
  sellRate = 35n * 10n ** 12n; // 0x: 0.035 ETH for them, 0.03465 after the fee: above the floor
  await fresh();
  await orders.tick();
  assert.equal(chain.sent.length, 1, 'one fill sent');
  const fill1 = lastFill();
  assert.equal(fill1.sent.to.toLowerCase(), ROUTER_BASE);
  assert.equal(fill1.o.amountIn, 1000n * E18);
  assert.equal(fill1.f.amountIn, 1000n * E18);
  assert.deepEqual([fill1.f.venue.toLowerCase(), fill1.f.spender.toLowerCase(), fill1.f.venueCalldata, fill1.f.unwrapIn], [AH, AH, '0xc0ffee', false]);
  assert.equal(fill1.f.minAmountOut, net(35n * 10n ** 15n * 97n / 100n), '0x\'s own minimum, after the fee, on top of the user\'s');
  const quoteCall = zx.find(q => q.path.endsWith('/quote'));
  assert.deepEqual([quoteCall.params.taker, quoteCall.params.sellToken, quoteCall.params.buyToken.toLowerCase()], [ROUTER_BASE, BULL, tx.NATIVE.toLowerCase()]);
  assert.equal(quoteCall.params.sellAmount, (1000n * E18).toString(), 'the fee is on the output: all of it is sold');
  const { rows: [sig] } = await db.query(`SELECT * FROM key_signatures WHERE purpose = $1`, [`meme_fill:${p.order.id}`]);
  assert.equal(sig.signer, exec.address.toLowerCase(), 'logged before signing');
  await orders.tick();
  assert.equal(chain.sent.length, 1, 'nothing more while a fill is in flight');

  // 4. Confirmed from the router's Filled event: the order is filled, and the user is told.
  const h1 = p.order.order_hash;
  const ev = tx.ROUTER.encodeEventLog('Filled', [h1, user.address, BULL, tx.NATIVE, 1000n * E18, 35n * 10n ** 13n, true, net(35n * 10n ** 15n)]);
  chain.receipts.set(ethers.keccak256(chain.sent[0].raw), { status: 1, logs: [{ address: ROUTER_BASE, ...ev }] });
  chain.filled.set(h1, 1000n * E18);
  await orders.tick();
  const l1 = await orders.list(account);
  const o1 = l1.orders.find(o => o.id === p.order.id);
  assert.equal(o1.state, 'filled');
  assert.equal(o1.delivered_native, '0.03465');
  assert.equal(o1.fills[0].state, 'confirmed');
  assert.match(o1.fills[0].tx_url, /^https:\/\/basescan\.org\/tx\/0x/);
  const { rows: alerts } = await db.query(`SELECT * FROM monitor_alerts WHERE account_id = $1 AND kind = 'meme_order'`, [acct]);
  assert.match(alerts.map(a => a.title).join(' | '), /Stop-loss on BULL \(Base\): sold/);
  assert.match(require('../src/alerts/format').message({ ...alerts[0], detail: alerts[0].detail }).url, /\/trade\?chain=base#evm-orders-card/);

  // 5. A take-profit that fires, but 0x quotes below the user's price: nothing is sent, and the user is told why.
  chain.approve(BULL, owner, ROUTER_BASE, 0n); // the fill used the approval up
  price[BULL] = 0.15; sellRate = 5n * 10n ** 13n; await fresh();
  const tp = await orders.prepare(account, { chain: 'base', kind: 'take_profit', token: BULL, share_pct: 50, take_pct: 50, slippage_pct: 3, days: 7 });
  const tps = await orders.sign(account, tp.order.id, { signature: await signFor(tp) });
  assert.deepEqual(tx.ERC20.decodeFunctionData('approve', tps.calls.calls[0].data)[1], 500n * E18, 'the filled stop-loss no longer counts');
  chain.approve(BULL, owner, ROUTER_BASE, 500n * E18);
  price[BULL] = 0.25; await fresh(); // worth 0.0417 ETH: over the 0.0375 target
  sellRate = 6n * 10n ** 13n; // but 0x pays only 0.03 ETH for the 500, under the 0.0360 floor
  await orders.tick();
  assert.equal(chain.sent.length, 1, 'not sent below the floor');
  let row = (await orders.list(account)).orders.find(o => o.id === tp.order.id);
  assert.equal(row.state, 'triggered');
  assert.match(row.last_error, /below the floor/);
  // 0x quotes enough, but the router itself would refuse (its BelowLimit, in the call first): still not sent.
  sellRate = 8n * 10n ** 13n;
  chain.onFill = () => { throw chain.revert('BelowLimit', [1n, 2n]); };
  await db.query(`UPDATE meme_orders SET next_attempt_at = now() WHERE id = $1`, [tp.order.id]);
  await orders.tick();
  assert.equal(chain.sent.length, 1);
  row = (await orders.list(account)).orders.find(o => o.id === tp.order.id);
  assert.match(row.last_error, /router's BelowLimit/);
  const { rows: below } = await db.query(`SELECT title FROM monitor_alerts WHERE account_id = $1 AND title LIKE '%can''t fill at your floor%'`, [acct]);
  assert.equal(below.length, 1, 'told once');
  chain.onFill = null;

  // 6. A Meme Watch exit needs Meme Watch on; a critical alert fires it. The emergency stop then holds every fill.
  await assert.rejects(orders.prepare(account, { chain: 'base', kind: 'meme_watch_exit', token: BULL, share_pct: 50 }), /Switch on Meme Watch/);
  await db.query(`INSERT INTO agent_settings (account_id, agent, enabled) VALUES ($1, 'meme_watch', true)`, [acct]);
  price[BULL] = 0.15; sellRate = 5n * 10n ** 13n; await fresh();
  const mw = await orders.prepare(account, { chain: 'base', kind: 'meme_watch_exit', token: BULL, share_pct: 50, floor_pct: 50 });
  assert.equal(mw.order.trigger_native, null);
  const mws = await orders.sign(account, mw.order.id, { signature: await signFor(mw) });
  assert.deepEqual(tx.ERC20.decodeFunctionData('approve', mws.calls.calls[0].data)[1], 1000n * E18, 'the approval covers every live order on the coin');
  assert.equal(await orders.memeWatchSignal('base', BULL.toUpperCase().replace('0X', '0x'), { source: 'test', alert: 'insiders selling' }), 1);
  assert.equal(await orders.memeWatchSignal('solana', BULL, {}), 0);
  await require('../src/admin/stops').set('auto_trading', true, { wallet: 'admin', reason: 'test' });
  assert.deepEqual(await orders.tick(), { stopped: true });
  assert.equal(chain.sent.length, 1, 'nothing filled while stopped');
  await require('../src/admin/stops').set('auto_trading', false, { wallet: 'admin', reason: 'test' });

  // 7. Cancelling: the router's cancel from the user's wallet (no revoke while another order needs the approval), read back.
  const c1 = await orders.cancel(account, mw.order.id);
  assert.equal(c1.calls.length, 1);
  assert.equal(c1.revokes_approval, false);
  assert.equal(tx.ROUTER.parseTransaction({ data: c1.calls[0].data }).name, 'cancel');
  chain.cancelled.add(mw.order.order_hash);
  assert.equal((await orders.refresh(account, mw.order.id)).state, 'cancelled');
  const c2 = await orders.cancel(account, tp.order.id);
  assert.equal(c2.revokes_approval, true, 'the last order on the coin: its approval revoked');
  assert.deepEqual(tx.ERC20.decodeFunctionData('approve', c2.calls[1].data).map(String), [ethers.getAddress(ROUTER_BASE), '0']);
  // Every order at once: a new epoch kills them all.
  const all = await orders.cancelAll(account, { chain: 'base' });
  assert.equal(tx.ROUTER.parseTransaction({ data: all.calls[0].data }).name, 'cancelAll');
  chain.epoch.set(owner, 1n);
  assert.equal((await orders.refresh(account, tp.order.id)).state, 'cancelled');
  // A prepared order never signed just goes.
  const never = await orders.prepare(account, { chain: 'base', kind: 'stop_loss', token: BULL });
  assert.deepEqual((await orders.cancel(account, never.order.id)).done, true);
  // An old signature is refused once the user has cancelled everything since.
  chain.epoch.set(owner, 0n);
  const stale = await orders.prepare(account, { chain: 'base', kind: 'stop_loss', token: BULL });
  chain.epoch.set(owner, 1n);
  await assert.rejects(orders.sign(account, stale.order.id, { signature: await signFor(stale) }), /cancelled all your orders/);

  // 8. A limit buy on BNB Chain, on a four.meme curve: the buy checks, the wrapping and approval, and a fill on the curve itself.
  chain.native.set(owner, E18);
  const lb = await orders.prepare(account, { chain: 'bsc', kind: 'limit_buy', token: FOUR, spend: 0.05, dip_pct: 20, slippage_pct: 3 });
  assert.equal(lb.order.spend_native, '0.05');
  assert.equal(lb.order.coins_when_placed, 990, '0.0495 BNB after the fee, at 20,000 a BNB');
  assert.equal(lb.order.trigger_coins, 1237.5);
  assert.match(lb.worst_case[0], /your 0\.05 WBNB buys 1,200\.38 FOUR/);
  assert.match(lb.notes.join(' '), /four\.meme curve/);
  assert.ok(lb.checks.some(c => c.check === 'sell_back' && /four\.meme/.test(c.source)));
  assert.equal(lb.typed_data.message.tokenIn, ethers.getAddress(WBNB));
  const lbs = await orders.sign(account, lb.order.id, { signature: await signFor(lb) });
  assert.deepEqual(lbs.calls.calls.map(c => c.to.toLowerCase()), [WBNB, WBNB], 'wrap, then approve');
  assert.equal(BigInt(lbs.calls.calls[0].value), 5n * 10n ** 16n);
  chain.hold(WBNB, owner, 5n * 10n ** 16n);
  chain.approve(WBNB, owner, ROUTER_BSC, 5n * 10n ** 16n);
  price[FOUR] = 0.023; fourRate = 26000n; await fresh(); // 0.0495 BNB buys 1,291 now: over the 1,237.5 limit
  await orders.tick();
  assert.equal(chain.sent.length, 2);
  const fill2 = lastFill();
  assert.equal(fill2.sent.to.toLowerCase(), ROUTER_BSC);
  assert.equal(fill2.sent.chainId, 56n);
  assert.deepEqual([fill2.f.venue.toLowerCase(), fill2.f.spender.toLowerCase(), fill2.f.unwrapIn], [TM2, TM2, true], 'on the curve, paid in BNB the router unwraps');
  const buyArgs = lp.TOKEN_MANAGER.decodeFunctionData('buyTokenAMAP', fill2.f.venueCalldata);
  assert.deepEqual([buyArgs[0].toLowerCase(), buyArgs[1], buyArgs[2]], [FOUR, 495n * 10n ** 14n, tx.minimumFor(fill2.o.minAmountOut, fill2.f.amountIn, fill2.o.amountIn)], 'the curve\'s own minimum is the user\'s limit');
});
