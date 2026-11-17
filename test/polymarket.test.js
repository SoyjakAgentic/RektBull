/**
 * Polymarket: market data, order building and signing, wallet set-up, the
 * builder fee, proposals and session keys. Polymarket's APIs are stand-ins
 * fed fixtures cut from its real responses (test/fixtures/polymarket) and
 * from the shapes in docs.polymarket.com. Keys are made at run time.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

Object.assign(process.env, { JWT_SECRET: 'test-secret', ...(process.env.TEST_DATABASE_URL ? { DATABASE_URL: process.env.TEST_DATABASE_URL } : {}) });
const fx = name => JSON.parse(require('fs').readFileSync(path.join(__dirname, 'fixtures', 'polymarket', name), 'utf8'));

const pm = require('../src/providers/polymarket');
const cache = require('../src/lib/cache');
const usage = require('../src/providers/usage');
const markets = require('../src/polymarket/markets');

/** Stand-in for Polymarket's HTTP APIs: records each call, answers from `routes`. */
async function standIn(routes) {
  const calls = [];
  const answer = async (method, url, body, opts) => {
    calls.push({ method, url, body, params: opts?.params, headers: opts?.headers });
    for (const [match, fn] of routes) if (url.includes(match)) return { data: await fn({ method, url, body, params: opts?.params || {}, headers: opts?.headers || {} }) };
    throw Object.assign(new Error('Request failed with status code 404'), { response: { status: 404, data: { error: 'not found' } } });
  };
  pm.http.get = (url, opts) => answer('GET', url, undefined, opts);
  pm.http.post = (url, body, opts) => answer('POST', url, body, opts);
  await clearCache();
  return calls;
}
/** Both cache levels: memory, and the database's when there is one (it may not be migrated yet). */
async function clearCache() {
  cache._memory.clear();
  if (process.env.TEST_DATABASE_URL) await require('../src/config/db').query("DELETE FROM cache WHERE key LIKE 'polymarket:%'").catch(() => {});
}

test('polymarket: market data', async t => {
  const events = fx('events.json');
  const book = fx('book.json');

  await t.test('events come from Gamma, counted and cached, with prices, volume, liquidity and end dates', async () => {
    const calls = await standIn([['/events', () => events]]);
    const before = [...usage._counts.entries()].filter(([k]) => k.startsWith('polymarket-gamma')).reduce((s, [, v]) => s + v, 0);
    const out = await markets.browse({});
    await markets.browse({});
    assert.equal(calls.length, 1, 'the second read came from the cache');
    assert.equal([...usage._counts.entries()].filter(([k]) => k.startsWith('polymarket-gamma')).reduce((s, [, v]) => s + v, 0), before + 1, 'counted once in provider usage');
    assert.deepEqual(calls[0].params, { active: true, closed: false, archived: false, limit: 20, offset: 0, order: 'volume24hr', ascending: false });
    assert.match(out.source, /Gamma API/);
    const e = out.events[0];
    assert.equal(e.slug, events[0].slug);
    assert.ok(e.volume_usd > 0 && e.liquidity_usd > 0 && e.end_date);
    const m = e.markets[0];
    assert.equal(m.outcomes.length, 2);
    assert.equal(m.position_system, 'ctf');
    assert.equal(m.outcomes[0].asset_id, JSON.parse(events[0].markets[0].clobTokenIds)[0], 'a CTF market trades its clobTokenIds');
    assert.ok(m.outcomes[0].price >= 0 && m.outcomes[0].price <= 1);
    assert.equal(m.accepting_orders, true);
  });

  await t.test('a V2 market trades its positionIds', () => {
    const m = markets.presentMarket({ ...events[0].markets[0], version: 'v2', positionIds: ['11', '12'] });
    assert.equal(m.position_system, 'v2');
    assert.deepEqual(m.outcomes.map(o => o.asset_id), ['11', '12']);
  });

  await t.test('resolution note: source, end date and UMA status, each from Polymarket or marked as not given', () => {
    const base = { ...events[0].markets[0], endDate: new Date(Date.now() + 86400000).toISOString() };
    const quiet = markets.resolutionNote({ ...base, resolutionSource: 'https://example.org/results', umaResolutionStatus: undefined, umaResolutionStatuses: '[]' });
    assert.equal(quiet.resolution_source, 'https://example.org/results');
    assert.equal(quiet.disputed, false);
    assert.deepEqual(quiet.flags, []);
    assert.match(quiet.uma_status_note, /no resolution request yet/);
    const none = markets.resolutionNote({ ...base, resolutionSource: '' });
    assert.equal(none.resolution_source, null);
    assert.match(none.resolution_source_note, /not given by Polymarket/);
    assert.ok(none.flags.some(f => /no resolution source/.test(f)));
    const disputed = markets.resolutionNote({ ...base, umaResolutionStatus: 'proposed', umaResolutionStatuses: '["proposed","disputed","proposed"]' });
    assert.equal(disputed.disputed, true);
    assert.ok(disputed.flags.some(f => /disputed/.test(f)));
    const proposed = markets.resolutionNote({ ...base, umaResolutionStatus: 'proposed', umaResolutionStatuses: '["proposed"]' });
    assert.ok(proposed.flags.some(f => /challenge period/.test(f)));
    // The Data API's row wins over Gamma's history when it was read.
    assert.equal(markets.resolutionNote(base, { status: 'disputed', was_disputed: true }).disputed, true);
    assert.match(markets.resolutionNote(base, { status: 'resolved', was_disputed: false }).source, /resolutions/);
    const late = markets.resolutionNote({ ...base, endDate: '2020-01-01T00:00:00Z', closed: false });
    assert.ok(late.flags.some(f => /end date has passed/.test(f)));
  });

  await t.test('one market reads its dispute state from the Data API, and says so when that fails', async () => {
    await standIn([['/markets', () => [events[0].markets[0]]], ['/v2/resolutions', () => ({ data: [{ condition_id: events[0].markets[0].conditionId, status: 'challenged', was_disputed: true }] })]]);
    const ok = await markets.marketBySlug(events[0].markets[0].slug);
    assert.equal(ok.market.resolution.disputed, true);
    assert.equal(ok.market.resolution.uma_status, 'challenged');
    await standIn([['/markets', () => [events[0].markets[0]]]]);
    const partial = await markets.marketBySlug(events[0].markets[0].slug);
    assert.match(partial.market.resolution.not_checked, /Data API v2.*couldn't be read/);
  });

  await t.test('the book: best prices first, with the tick size and minimum size orders must meet', async () => {
    await standIn([['/book', () => book]]);
    const b = markets.presentBook(await pm.book(book.asset_id));
    assert.equal(b.tick_size, book.tick_size);
    assert.equal(b.min_order_size, book.min_order_size);
    assert.ok(b.best_bid < b.best_ask);
    assert.equal(b.best_bid, Math.max(...book.bids.map(x => Number(x.price))));
    assert.equal(b.best_ask, Math.min(...book.asks.map(x => Number(x.price))));
    assert.match(b.source, /CLOB API/);
  });

  await t.test('positions and PnL are Polymarket\'s own figures', async () => {
    await standIn([['/v2/positions', () => fx('positions.json')]]);
    const out = await markets.positionsFor('0x' + '00'.repeat(19) + '01');
    assert.equal(out.positions.length, 2);
    assert.equal(out.complete, true);
    assert.equal(out.totals.redeemable, 2);
    assert.match(out.source, /Data API v2/);
    assert.match(out.pnl_note, /Polymarket's own figure/);
  });

  await t.test('a failed read says which API failed and why, over HTTP too', async () => {
    await standIn([]);
    await assert.rejects(markets.browse({}), err => err.isPolymarketUnavailable && /Gamma API.*couldn't be read: not found \(HTTP 404\)/.test(err.message));
    const server = require('../src/app').createApp().listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/polymarket/events`);
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.error, 'source_unavailable');
      assert.match(body.source, /Gamma/);
      assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/v1/polymarket/positions?wallet=nope`)).status, 400);
    } finally { server.close(); }
  });
});

const { ethers } = require('ethers');
const crypto = require('crypto');
const orders = require('../src/polymarket/orders');
const wallets = require('../src/polymarket/wallets');
const { C, APPROVALS } = require('../src/polymarket/contracts');
const BUILDER = '0x' + 'b1'.repeat(32);

test('polymarket: building and signing orders', async t => {
  const book = markets.presentBook(fx('book.json')); // tick 0.001, minimum 5, CTF, not neg-risk
  const docBook = { ...book, tick_size: '0.01', bids: [{ price: 0.5, size: 40 }], asks: [{ price: 0.52, size: 25 }, { price: 0.54, size: 30 }], best_bid: 0.5, best_ask: 0.52 };
  const owner = ethers.Wallet.createRandom();
  const ctx = (over = {}) => ({ book: docBook, platformFee: null, builder: BUILDER, takerBps: 1, makerBps: 1, walletType: 'eoa', wallet: owner.address, signer: owner.address, ...over });

  await t.test('amounts match the worked examples in Polymarket\'s docs', () => {
    const buy = orders.limitAmounts({ side: 'BUY', price: '0.52', size: '10', tick: '0.01', minSize: '5' });
    assert.deepEqual([buy.makerAmount, buy.takerAmount], ['5200000', '10000000']);
    const sell = orders.limitAmounts({ side: 'SELL', price: '0.52', size: '10', tick: '0.01', minSize: '5' });
    assert.deepEqual([sell.makerAmount, sell.takerAmount], ['10000000', '5200000']);
    const mkt = orders.marketAmounts({ side: 'BUY', usd: '10', limitPrice: '0.52', tick: '0.01', minSize: '5' });
    assert.deepEqual([mkt.makerAmount, mkt.takerAmount], ['10000000', '19230700']);
    const ms = orders.marketAmounts({ side: 'SELL', shares: '12.345', limitPrice: '0.5', tick: '0.01', minSize: '5' });
    assert.deepEqual([ms.makerAmount, ms.takerAmount], ['12340000', '6170000'], 'shares round down to 2 decimals');
  });

  await t.test('an order off the tick, under the minimum, or on an unknown tick size is refused with the reason', () => {
    assert.throws(() => orders.limitAmounts({ side: 'BUY', price: '0.525', size: '10', tick: '0.01', minSize: '5' }), /at most 2 decimal places/);
    assert.throws(() => orders.limitAmounts({ side: 'BUY', price: '0.5025', size: '10', tick: '0.005', minSize: '5' }), /at most 3 decimal|multiple of this market's tick size/);
    assert.throws(() => orders.limitAmounts({ side: 'BUY', price: '0.503', size: '10', tick: '0.005', minSize: '5' }), /multiple of this market's tick size/);
    assert.throws(() => orders.limitAmounts({ side: 'BUY', price: '1', size: '10', tick: '0.01', minSize: '5' }), /between 0.01 and 0.99/);
    assert.throws(() => orders.limitAmounts({ side: 'BUY', price: '0.5', size: '4.99', tick: '0.01', minSize: '5' }), /smallest order is 5 shares/);
    assert.throws(() => orders.limitAmounts({ side: 'BUY', price: '0.5', size: '10', tick: '0.02', minSize: '5' }), /doesn't know how to round/);
    assert.throws(() => orders.marketAmounts({ side: 'BUY', usd: '1', limitPrice: '0.5', tick: '0.01', minSize: '5' }), /smallest order is 5 shares/);
  });

  await t.test('a market order is priced from the book: worst level reached, slippage limit, Fill or Kill needs the whole size there', () => {
    assert.deepEqual(orders.marketPrice(docBook, 'BUY', { usd: 10 }), { price: 0.52, filled: true, best: 0.52 });
    assert.deepEqual(orders.marketPrice(docBook, 'BUY', { usd: 20 }), { price: 0.54, filled: true, best: 0.52 });
    assert.equal(orders.marketPrice(docBook, 'SELL', { shares: 100 }).filled, false);
    const b = orders.build({ side: 'BUY', order_type: 'FAK', amount_usd: 10 }, ctx());
    assert.equal(b.body.orderType, 'FAK');
    assert.equal(b.body.order.expiration, '0', 'market orders never carry an expiration');
    assert.equal(b.summary.worst_price, 0.52);
    // All-in: the notional leaves room for the 0.01% builder fee inside the $10.
    assert.ok(b.summary.notional_usd + b.summary.fees.as_taker.rektbull_usd <= 10);
    assert.equal(b.summary.notional_usd, 9.99);
    assert.throws(() => orders.build({ side: 'BUY', order_type: 'FAK', amount_usd: 20, max_slippage_pct: 1 }, ctx()), err => err.code === 'price_impact' && /3\.8% past the best ask/.test(err.message));
    assert.throws(() => orders.build({ side: 'SELL', order_type: 'FOK', size: 100 }, ctx()), err => err.code === 'not_enough_liquidity');
    assert.equal(orders.build({ side: 'SELL', order_type: 'FAK', size: 100, max_slippage_pct: 5 }, ctx()).summary.book_covers_it, false);
    assert.throws(() => orders.build({ side: 'BUY', order_type: 'FAK', amount_usd: 5 }, ctx({ book: { ...docBook, asks: [] } })), /no sellers/);
  });

  await t.test('limit orders: GTC, GTD with Polymarket\'s one-minute margin, post-only', () => {
    const now = 1_800_000_000_000;
    const gtc = orders.build({ side: 'BUY', order_type: 'GTC', price: '0.5', size: '10' }, ctx({ now }));
    assert.equal(gtc.body.order.expiration, '0');
    assert.equal(gtc.order.timestamp, String(now));
    const gtd = orders.build({ side: 'BUY', order_type: 'GTD', price: '0.5', size: '10', expires_in_seconds: 3600, post_only: true }, ctx({ now }));
    assert.equal(gtd.body.order.expiration, String(now / 1000 + 60 + 3600));
    assert.equal(gtd.body.postOnly, true);
    assert.throws(() => orders.build({ side: 'BUY', order_type: 'GTD', price: '0.5', size: '10', expires_in_seconds: 30 }, ctx()), /at least 2 minutes/);
    assert.throws(() => orders.build({ side: 'HOLD', price: '0.5', size: '10' }, ctx()), /BUY or SELL/);
  });

  await t.test('fees: the builder fee is a share of the notional; Polymarket\'s own follows its formula', () => {
    // docs/programs/builders/fees: 1,000 pUSD at 100 bps = 10. docs/trading/fees: 100 shares at $0.50, crypto (0.07) = $1.75.
    assert.equal(orders.fees({ notionalUsd: 1000, price: 0.5, platformFee: null, takerBps: 100, makerBps: 50 }).as_taker.rektbull_usd, 10);
    assert.equal(orders.fees({ notionalUsd: 1000, price: 0.5, platformFee: null, takerBps: 100, makerBps: 50 }).as_maker.rektbull_usd, 5);
    const f = orders.fees({ notionalUsd: 50, price: 0.5, platformFee: { rate: 0.07, exponent: 1, taker_only: true }, takerBps: 1, makerBps: 1 });
    assert.equal(f.as_taker.polymarket_usd, 1.75);
    assert.equal(f.as_taker.rektbull_usd, 0.005);
    assert.equal(f.as_maker.polymarket_usd, 0);
    assert.equal(orders.fees({ notionalUsd: 30, price: 0.3, platformFee: { rate: 0.05, exponent: 1, taker_only: true }, takerBps: 1, makerBps: 1 }).as_taker.polymarket_usd, 1.05);
  });

  await t.test('the signed struct, domain and request body are the documented ones, with the builder code signed in', () => {
    const b = orders.build({ side: 'BUY', order_type: 'GTC', price: '0.5', size: '10' }, ctx());
    assert.deepEqual(Object.keys(b.order), ['salt', 'maker', 'signer', 'tokenId', 'makerAmount', 'takerAmount', 'side', 'signatureType', 'timestamp', 'metadata', 'builder']);
    assert.equal(b.order.builder, BUILDER);
    assert.equal(b.order.signatureType, 0);
    assert.deepEqual(b.typed_data.domain, { name: 'Polymarket CTF Exchange', version: '2', verifyingContract: C.exchangeCtf, chainId: 137 });
    assert.equal(orders.typedData(b.order, { position_system: 'ctf', neg_risk: true }).domain.verifyingContract, C.exchangeNegRisk);
    assert.deepEqual([orders.typedData(b.order, { position_system: 'v2' }).domain.version, orders.typedData(b.order, { position_system: 'v2' }).domain.verifyingContract], ['3', C.exchangeV2]);
    assert.deepEqual(Object.keys(b.body), ['deferExec', 'order', 'orderType', 'owner']);
    assert.deepEqual(Object.keys(b.body.order).sort(), ['builder', 'expiration', 'maker', 'makerAmount', 'metadata', 'salt', 'side', 'signature', 'signatureType', 'signer', 'takerAmount', 'timestamp', 'tokenId']);
    assert.equal(typeof b.body.order.salt, 'number');
    assert.ok(Number.isSafeInteger(b.body.order.salt));
    assert.equal(b.body.order.side, 'BUY');
    assert.equal(b.body.order.tokenId, book.asset_id);
    // A Proxy or Safe wallet: the wallet is the maker, the account's key the signer.
    const proxy = '0x' + '5a'.repeat(20);
    const p = orders.build({ side: 'SELL', order_type: 'GTC', price: '0.5', size: '10' }, ctx({ walletType: 'proxy', wallet: proxy }));
    assert.deepEqual([p.order.maker.toLowerCase(), p.order.signer, p.order.signatureType], [proxy, owner.address, 1]);
    assert.equal(orders.build({ side: 'SELL', order_type: 'GTC', price: '0.5', size: '10' }, ctx({ walletType: 'safe', wallet: proxy })).order.signatureType, 2);
  });

  await t.test('an EOA, Proxy or Safe order is a plain EIP-712 signature by the account\'s key', async () => {
    const b = orders.build({ side: 'BUY', order_type: 'GTC', price: '0.5', size: '10' }, ctx());
    const { EIP712Domain, ...types } = b.typed_data.types;
    const sig = await owner.signTypedData(b.typed_data.domain, types, b.typed_data.message);
    assert.equal(ethers.verifyTypedData(b.typed_data.domain, types, b.typed_data.message, sig), owner.address);
    assert.equal(ethers.recoverAddress(orders.digest(b.typed_data), sig), owner.address);
    assert.equal(b.signature_suffix, '');
  });

  await t.test('a Deposit Wallet order is signed as ERC-7739 TypedDataSign and wrapped as the docs\' helper does', async () => {
    const dw = wallets.depositWalletAddress(owner.address);
    const b = orders.build({ side: 'BUY', order_type: 'GTC', price: '0.5', size: '10' }, ctx({ walletType: 'deposit', wallet: dw }));
    assert.deepEqual([b.order.maker, b.order.signer, b.order.signatureType], [dw, dw, 3]);
    const td = b.typed_data;
    assert.equal(td.primaryType, 'TypedDataSign');
    assert.deepEqual({ ...td.message, contents: null }, { contents: null, name: 'DepositWallet', version: '1', chainId: 137, verifyingContract: dw, salt: orders.ZERO32 });
    const { EIP712Domain, ...types } = td.types;
    const inner = await owner.signTypedData(td.domain, types, td.message);
    const wrapped = inner + b.signature_suffix;
    // Take the wrapper apart the way a verifier does, hashing by hand (not with the code under test).
    const bytes = ethers.getBytes(wrapped);
    const typeLen = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
    const typeStr = ethers.toUtf8String(bytes.slice(bytes.length - 2 - typeLen, bytes.length - 2));
    assert.equal(typeStr, orders.ORDER_TYPE);
    const contentsHash = ethers.hexlify(bytes.slice(bytes.length - 2 - typeLen - 32, bytes.length - 2 - typeLen));
    const appSep = ethers.hexlify(bytes.slice(65, 97));
    assert.equal(bytes.length, 65 + 32 + 32 + typeLen + 2);
    const coder = ethers.AbiCoder.defaultAbiCoder(); const k = s => ethers.keccak256(ethers.toUtf8Bytes(s)); const o = b.order;
    assert.equal(appSep, ethers.keccak256(coder.encode(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'], [k('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'), k('Polymarket CTF Exchange'), k('2'), 137, C.exchangeCtf])));
    assert.equal(contentsHash, ethers.keccak256(coder.encode(['bytes32', 'uint256', 'address', 'address', 'uint256', 'uint256', 'uint256', 'uint8', 'uint8', 'uint256', 'bytes32', 'bytes32'],
      [k(orders.ORDER_TYPE), o.salt, o.maker, o.signer, o.tokenId, o.makerAmount, o.takerAmount, o.side, o.signatureType, o.timestamp, o.metadata, o.builder])));
    const wrapperHash = ethers.keccak256(coder.encode(['bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'address', 'bytes32'],
      [k('TypedDataSign(Order contents,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)' + typeStr), contentsHash, k('DepositWallet'), k('1'), 137, dw, orders.ZERO32]));
    const finalHash = ethers.keccak256(ethers.concat(['0x1901', appSep, wrapperHash]));
    assert.equal(ethers.recoverAddress(finalHash, ethers.hexlify(bytes.slice(0, 65))), owner.address, 'the wallet\'s owner signed the nested hash');
    assert.equal(orders.wrapDepositWalletSignature(td, inner), wrapped);
  });

  await t.test('a Session Key\'s envelope: its address, a zero word, the wallet signature, then Polymarket\'s marker', () => {
    const key = ethers.Wallet.createRandom().address; const sig = '0x' + 'ab'.repeat(200);
    const env = orders.sessionEnvelope(key, sig);
    assert.ok(env.endsWith('6492'.repeat(16)));
    const [id, zero, inner] = ethers.AbiCoder.defaultAbiCoder().decode(['bytes32', 'bytes32', 'bytes'], '0x' + env.slice(2, -64));
    assert.deepEqual([id, zero, inner], [ethers.zeroPadValue(key, 32).toLowerCase(), orders.ZERO32, sig]);
  });

  await t.test('a Deposit Wallet\'s address is derived from its owner as Polymarket\'s factory does (three live wallets)', () => {
    for (const [o, w] of [['0x791fac0405b7473abf65decff7cb41aad6a59476', '0x1bf6128075331da34ac3603162b0f67dfa8394fc'], ['0x01cdf30d1daa779d8498a5da664f5ea01c3d1551', '0x244836466f6bac4aa868d1dc4eee9f672bfa998e'], ['0x3cb0ea4797353f2ab0de7fef4437d4b465b2ef22', '0x53f0416132ed3b8d578f29d0a7f87335aa876d92']]) {
      assert.equal(wallets.depositWalletAddress(o).toLowerCase(), w);
    }
  });

  await t.test('redemptions go to the contract for the position system, paid to the wallet', () => {
    const cond = '0x' + 'c0'.repeat(32);
    const ctf = wallets.redeemCalls({ positionSystem: 'ctf', negRisk: false, conditionId: cond, assetId: '5', shares: 10 });
    assert.deepEqual(ctf.map(c => c.target), [C.conditionalTokens, C.ctfCollateralAdapter]);
    assert.equal(wallets.redeemCalls({ positionSystem: 'ctf', negRisk: true, conditionId: cond, assetId: '5', shares: 10 })[1].target, C.negRiskCtfCollateralAdapter);
    const id = (BigInt('0x' + '00' + 'ab'.repeat(30)) << 8n) | 1n;
    const v2 = wallets.redeemCalls({ positionSystem: 'v2', conditionId: null, assetId: id.toString(), shares: 2.5 });
    assert.deepEqual(v2.map(c => c.target), [C.positionManager, C.router]);
    const args = new ethers.Interface(['function redeem(bytes31 conditionId, uint256 outcomeIndex, uint256 amount)']).decodeFunctionData('redeem', v2[1].data);
    assert.deepEqual([args[0], args[1], args[2]], ['0x00' + 'ab'.repeat(30), 1n, 2500000n]);
  });

  await t.test('relayer requests carry RektBull\'s Builder API key headers, signed over the exact body', () => {
    const env = require('../src/config/env');
    const secret = crypto.randomBytes(32);
    Object.assign(env, { polymarketBuilderApiKey: 'key-id', polymarketBuilderApiSecret: secret.toString('base64'), polymarketBuilderApiPassphrase: 'pass' });
    const body = JSON.stringify({ type: 'WALLET-CREATE', from: owner.address });
    const h = pm.builderHeaders('POST', '/submit', body, 1800000000);
    assert.equal(h.POLY_BUILDER_SIGNATURE, crypto.createHmac('sha256', secret).update('1800000000POST/submit' + body).digest('base64').replace(/\+/g, '-').replace(/\//g, '_'));
    assert.deepEqual([h.POLY_BUILDER_API_KEY, h.POLY_BUILDER_TIMESTAMP, h.POLY_BUILDER_PASSPHRASE], ['key-id', '1800000000', 'pass']);
  });
});

const DB = process.env.TEST_DATABASE_URL;
/** A fresh database, the app on a port, and a signed-in account for a new random wallet. */
async function harness(t) {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  const env = require('../src/config/env');
  Object.assign(env, { polymarketEnabled: true, polymarketBuilderCode: BUILDER, polymarketTakerFeeBps: 1, polymarketMakerFeeBps: 1,
    polymarketBuilderApiKey: 'key-id', polymarketBuilderApiSecret: crypto.randomBytes(32).toString('base64'), polymarketBuilderApiPassphrase: 'pass' });
  // These requests carry no country, so Polymarket's own region list would refuse them: clear it here.
  await require('../src/compliance/regions').set('polymarket', [], { wallet: '0xtest', reason: 'tests run from no country' });
  const server = require('../src/app').createApp().listen(0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const signIn = async () => {
    const wallet = ethers.Wallet.createRandom();
    const { rows: [acct] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [wallet.address.toLowerCase()]);
    const token = require('../src/auth/siwe').issueToken(acct);
    const api = async (method, p, body) => {
      const res = await fetch(url + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json() };
    };
    return { wallet, acct, api, dw: wallets.depositWalletAddress(wallet.address) };
  };
  // Polygon: which approvals a wallet has, and its pUSD.
  const chain = { approved: new Set(), pusd: 250_000000n };
  require('../src/providers/rpc').evmRpc = async (_c, _m, [{ to, data }]) => {
    const sel = data.slice(0, 10);
    if (sel === '0x70a08231') return ethers.toBeHex(chain.pusd, 32);
    const spender = '0x' + data.slice(-40);
    return ethers.toBeHex(chain.approved.has(`${to}|${spender}`.toLowerCase()) ? (sel === '0xdd62ed3e' ? ethers.MaxUint256 : 1n) : 0n, 32);
  };
  return { db, env, url, signIn, chain };
}
const sign = (wallet, td) => { const { EIP712Domain, ...types } = td.types; return wallet.signTypedData(td.domain, types, td.message); };

test('polymarket: wallet set-up and manual orders, end to end', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const { db, env, signIn, chain, url } = await harness(t);
  const events = fx('events.json'); const m = events[0].markets[0]; const assetId = JSON.parse(m.clobTokenIds)[0];
  const relayer = { deployed: false, submits: [], state: 'STATE_NEW' };
  const routes = () => [
    ['/deployed', () => ({ deployed: relayer.deployed })],
    ['/v1/account/transactions/params', () => ({ address: '0x' + 'ee'.repeat(20), nonce: '7' })],
    ['/v1/account/transactions/', () => ({ transaction_id: 'tx-1', transaction_hash: '0x' + 'aa'.repeat(32), state: relayer.state, error_msg: null })],
    ['/submit', r => { relayer.submits.push(r); return { transactionID: 'tx-1', state: 'STATE_NEW' }; }],
    ['/markets', () => [m]], ['/book', () => fx('book.json')], ['/v2/positions', () => fx('positions.json')],
  ];
  let calls = await standIn(routes());
  const u = await signIn();

  await t.test('config: public values only, the fee said plainly, each approval explained', async () => {
    const { body } = await u.api('GET', '/v1/polymarket/config');
    assert.equal(body.enabled, true);
    assert.equal(body.builder_code, BUILDER);
    assert.deepEqual([body.fee.taker_bps, body.fee.maker_bps], [1, 1]);
    assert.match(body.fee.how, /0\.01% of what fills.*only on fills.*costs nothing/);
    assert.equal(body.approvals.length, 8);
    assert.equal(body.geoblock_url, 'https://polymarket.com/api/geoblock');
    assert.ok(!JSON.stringify(body).includes(env.polymarketBuilderApiSecret), 'no secret in the config');
  });

  await t.test('a new user: the Deposit Wallet is derived, not deployed, nothing approved', async () => {
    const { body } = await u.api('GET', '/v1/polymarket/wallet');
    assert.equal(body.wallet, u.dw);
    assert.equal(body.deployed, false);
    assert.equal(body.ready, false);
    assert.ok(body.approvals.every(a => a.approved === false && a.what.length > 20));
    const refused = await u.api('POST', '/v1/polymarket/wallet/transactions', { kind: 'approvals' });
    assert.deepEqual([refused.status, refused.body.error], [409, 'not_deployed']);
  });

  await t.test('deploying asks Polymarket\'s relayer for a wallet for this key, with RektBull\'s builder headers', async () => {
    const { status, body } = await u.api('POST', '/v1/polymarket/wallet/deploy');
    assert.deepEqual([status, body.wallet, body.status], [201, u.dw, 'submitted']);
    const sent = relayer.submits.pop();
    assert.deepEqual(JSON.parse(sent.body), { type: 'WALLET-CREATE', from: u.wallet.address, to: C.depositWalletFactory, metadata: 'Deploy Deposit Wallet' });
    assert.equal(sent.headers.POLY_BUILDER_SIGNATURE, pm.builderHeaders('POST', '/submit', sent.body, Number(sent.headers.POLY_BUILDER_TIMESTAMP)).POLY_BUILDER_SIGNATURE);
    relayer.deployed = true;
  });

  let batch;
  await t.test('approvals: one batch of the eight missing approvals, each step explained, for the wallet to sign', async () => {
    calls = await standIn(routes());
    const { status, body } = await u.api('POST', '/v1/polymarket/wallet/transactions', { kind: 'approvals' });
    assert.equal(status, 201);
    batch = body;
    assert.equal(body.steps.length, 8);
    assert.match(body.steps[0].what, /Approve Polymarket V2 Exchange for your pUSD/);
    assert.deepEqual(body.typed_data.domain, { name: 'DepositWallet', version: '1', chainId: 137, verifyingContract: u.dw });
    assert.equal(body.typed_data.message.nonce, '7');
    const targets = new Set(body.typed_data.message.calls.map(c => c.target));
    assert.deepEqual([...targets].sort(), [C.pUSD, C.conditionalTokens, C.positionManager].sort(), 'only Polymarket\'s token contracts are called');
    const spenders = body.typed_data.message.calls.map(c => '0x' + c.data.slice(34, 74));
    assert.deepEqual(new Set(spenders), new Set(APPROVALS.map(a => a.spender.toLowerCase())), 'only Polymarket\'s exchanges and adapter are approved');
  });

  await t.test('the relay forwards exactly what was prepared, and only with the account wallet\'s own signature', async () => {
    const stranger = ethers.Wallet.createRandom();
    const bad = await u.api('POST', `/v1/polymarket/wallet/transactions/${batch.id}/submit`, { signature: await sign(stranger, batch.typed_data) });
    assert.deepEqual([bad.status, bad.body.error], [400, 'bad_signature']);
    assert.equal(relayer.submits.length, 0);
    const signature = await sign(u.wallet, batch.typed_data);
    const ok = await u.api('POST', `/v1/polymarket/wallet/transactions/${batch.id}/submit`, { signature });
    assert.deepEqual([ok.status, ok.body.status, ok.body.relayer_id], [200, 'submitted', 'tx-1']);
    const sent = JSON.parse(relayer.submits[0].body);
    assert.deepEqual({ ...sent, depositWalletParams: null }, { type: 'WALLET', from: u.wallet.address, to: C.depositWalletFactory, nonce: '7', signature, metadata: 'RektBull: approvals', depositWalletParams: null });
    assert.deepEqual(sent.depositWalletParams, { depositWallet: u.dw, deadline: batch.typed_data.message.deadline, calls: batch.typed_data.message.calls });
    assert.equal((await u.api('POST', `/v1/polymarket/wallet/transactions/${batch.id}/submit`, { signature })).status, 409, 'never sent twice');
    const { rows: [row] } = await db.query('SELECT * FROM polymarket_batches WHERE id = $1', [batch.id]);
    assert.ok(!JSON.stringify(row).includes(signature), 'the signature is not stored');
    assert.equal((await u.api('GET', `/v1/polymarket/wallet/transactions/${batch.id}`)).body.status, 'submitted');
    relayer.state = 'STATE_CONFIRMED';
    assert.equal((await u.api('GET', `/v1/polymarket/wallet/transactions/${batch.id}`)).body.status, 'confirmed');
    for (const a of APPROVALS) chain.approved.add(`${a.token}|${a.spender}`.toLowerCase());
    await clearCache();
    const { body } = await u.api('GET', '/v1/polymarket/wallet');
    assert.deepEqual([body.ready, body.pusd_balance], [true, 250]);
    assert.equal((await u.api('POST', '/v1/polymarket/wallet/transactions', { kind: 'approvals' })).body.error, 'nothing_to_do');
  });

  await t.test('another account can\'t submit or read someone else\'s transaction', async () => {
    const other = await signIn();
    assert.equal((await other.api('GET', `/v1/polymarket/wallet/transactions/${batch.id}`)).status, 404);
  });

  let order;
  await t.test('an order: checked against the live book, builder code signed in, fees and resolution note shown', async () => {
    const { status, body } = await u.api('POST', '/v1/polymarket/orders', { asset_id: assetId, market_slug: m.slug, side: 'BUY', order_type: 'GTC', price: '0.02', size: '100' });
    assert.equal(status, 201);
    order = body;
    assert.deepEqual([body.wallet, body.wallet_type], [u.dw, 'deposit']);
    assert.equal(body.typed_data.message.contents.builder, BUILDER);
    assert.deepEqual([body.summary.notional_usd, body.fee.as_taker.rektbull_usd, body.fee.as_maker.rektbull_bps], [2, 0.0002, 1]);
    assert.equal(body.send.url, 'https://clob.polymarket.com/order');
    assert.ok(body.resolution.end_date && Array.isArray(body.resolution.flags));
    assert.match(body.book.source, /CLOB API/);
    assert.deepEqual([body.body.order.signature, body.body.owner], ['', ''], 'the signature and the API key are filled in by the browser');
  });

  await t.test('the signature the wallet makes is the one Polymarket\'s Deposit Wallet check accepts', async () => {
    const inner = await sign(u.wallet, order.typed_data);
    const wrapped = inner + order.signature_suffix;
    assert.equal(ethers.recoverAddress(orders.digest(order.typed_data), inner), u.wallet.address);
    assert.equal(ethers.dataLength(wrapped), 65 + 64 + orders.ORDER_TYPE.length + 2);
  });

  await t.test('what the browser reports back is the order id and status, nothing secret', async () => {
    const id = '0x' + 'cd'.repeat(32);
    const { body } = await u.api('POST', `/v1/polymarket/orders/${order.id}/result`, { success: true, order_id: id, status: 'live' });
    assert.deepEqual([body.status, body.clob_order_id, body.clob_status], ['submitted', id, 'live']);
    const again = await u.api('POST', '/v1/polymarket/orders', { asset_id: assetId, market_slug: m.slug, side: 'SELL', order_type: 'FAK', size: '50' });
    const rej = await u.api('POST', `/v1/polymarket/orders/${again.body.id}/result`, { success: false, error: 'not enough balance / allowance' });
    assert.deepEqual([rej.body.status, rej.body.error], ['rejected', 'not enough balance / allowance']);
    const list = await u.api('GET', '/v1/polymarket/orders');
    assert.equal(list.body.orders.length, 2);
    assert.equal((await u.api('POST', `/v1/polymarket/orders/${order.id}/cancelled`)).body.status, 'cancelled');
    const stored = JSON.stringify((await db.query('SELECT * FROM polymarket_orders')).rows);
    assert.ok(!/secret|passphrase/i.test(stored));
  });

  await t.test('refusals say why: closed market, wrong outcome, off-tick price, legacy wallet without its address', async () => {
    const o = body => u.api('POST', '/v1/polymarket/orders', { asset_id: assetId, market_slug: m.slug, side: 'BUY', order_type: 'GTC', price: '0.02', size: '100', ...body });
    assert.match((await o({ price: '0.0205' })).body.message, /decimal places|tick size/);
    assert.match((await o({ asset_id: '123' })).body.message, /isn't part of that market/);
    assert.match((await o({ wallet_type: 'proxy' })).body.message, /Paste your Polymarket wallet address/);
    const proxy = await o({ wallet_type: 'safe', address: '0x' + '5a'.repeat(20) });
    assert.deepEqual([proxy.status, proxy.body.typed_data.primaryType, proxy.body.typed_data.message.signer, proxy.body.signature_suffix], [201, 'Order', u.wallet.address, '']);
    assert.equal((await u.api('POST', '/v1/polymarket/wallet/transactions', { kind: 'approvals', wallet_type: 'safe', address: '0x' + '5a'.repeat(20) })).body.error, 'not_supported');
    await standIn([...routes().filter(r => r[0] !== '/markets'), ['/markets', () => [{ ...m, closed: true, acceptingOrders: false }]]]);
    const closed = await o({});
    assert.deepEqual([closed.status, closed.body.error], [422, 'market_closed']);
    await standIn(routes());
  });

  await t.test('without a builder code, or switched off, no order is prepared: an unpaid desk isn\'t offered', async () => {
    env.polymarketBuilderCode = '';
    const r = await u.api('POST', '/v1/polymarket/orders', { asset_id: assetId, market_slug: m.slug, side: 'BUY', order_type: 'GTC', price: '0.02', size: '100' });
    assert.deepEqual([r.status, r.body.error], [503, 'not_available']);
    assert.match(r.body.message, /builder code is missing/);
    assert.equal((await u.api('GET', '/v1/polymarket/config')).body.enabled, false);
    env.polymarketBuilderCode = BUILDER;
  });

  await t.test('an EOA gets the same approvals as Polygon transactions to send itself; funding wraps exactly the amount to the wallet', async () => {
    chain.approved.clear(); await clearCache();
    const { body } = await u.api('POST', '/v1/polymarket/wallet/transactions', { kind: 'approvals', wallet_type: 'eoa' });
    assert.deepEqual([body.chain_id, body.calls.length], ['0x89', 8]);
    assert.ok(body.calls.every(c => c.label && c.value === '0x0'));
    const fund = await u.api('POST', '/v1/polymarket/wallet/fund', { amount_usd: 25 });
    assert.deepEqual(fund.body.calls.map(c => c.to), [C.USDCe, C.collateralOnramp]);
    const wrap = new ethers.Interface(['function wrap(address _asset, address _to, uint256 _amount)']).decodeFunctionData('wrap', fund.body.calls[1].data);
    assert.deepEqual([wrap[0], wrap[1], wrap[2]], [C.USDCe, u.dw, 25000000n]);
    assert.equal(new ethers.Interface(['function approve(address,uint256)']).decodeFunctionData('approve', fund.body.calls[0].data)[1], 25000000n, 'approved for exactly the amount');
  });

  await t.test('withdrawing can only pay the wallet\'s own owner; redeeming needs a resolved position', async () => {
    for (const a of APPROVALS) chain.approved.add(`${a.token}|${a.spender}`.toLowerCase());
    await clearCache();
    const { body } = await u.api('POST', '/v1/polymarket/wallet/transactions', { kind: 'withdraw', amount_usd: 100, to: '0x' + '66'.repeat(20) });
    const unwrap = new ethers.Interface(['function unwrap(address _asset, address _to, uint256 _amount)']).decodeFunctionData('unwrap', body.typed_data.message.calls[1].data);
    assert.deepEqual([unwrap[1], unwrap[2]], [u.wallet.address, 100000000n]);
    assert.match((await u.api('POST', '/v1/polymarket/wallet/transactions', { kind: 'withdraw', amount_usd: 1000 })).body.message, /holds 250 pUSD/);
    const pos = fx('positions.json').data[0];
    const redeem = await u.api('POST', '/v1/polymarket/wallet/transactions', { kind: 'redeem', asset_id: pos.token_id });
    assert.equal(redeem.status, 201);
    assert.deepEqual(redeem.body.typed_data.message.calls.map(c => c.target), [C.conditionalTokens, pos.negative_risk ? C.negRiskCtfCollateralAdapter : C.ctfCollateralAdapter]);
    assert.equal((await u.api('POST', '/v1/polymarket/wallet/transactions', { kind: 'redeem', asset_id: '999' })).status, 404);
    assert.match(redeem.body.detail.profit_share.note, /fee wallet isn't set/, 'no fee wallet: no profit share');

    // The profit share: 10% of the profit, a pUSD transfer after the redemption in the same signed batch.
    const feeWallet = '0x' + 'fe'.repeat(20);
    env.polymarketFeeWallet = feeWallet;
    try {
      await clearCache();
      const withFee = await u.api('POST', '/v1/polymarket/wallet/transactions', { kind: 'redeem', asset_id: pos.token_id });
      assert.equal(withFee.status, 201, JSON.stringify(withFee.body));
      const calls = withFee.body.typed_data.message.calls;
      assert.equal(calls.length, 3);
      assert.equal(calls[2].target, C.pUSD, 'the last call, after the redemption');
      const [to, amount] = new ethers.Interface(['function transfer(address to, uint256 amount)']).decodeFunctionData('transfer', calls[2].data);
      assert.equal(to.toLowerCase(), feeWallet);
      assert.equal(amount, 1000000n, `10% of a $10 profit (10 shares paid $10, bought at ${pos.avg_price})`);
      assert.match(withFee.body.steps[2].what, /10% of your 10 pUSD profit/);
      // On a loss, or a profit too small to share: nothing.
      assert.equal(wallets.profitShare([{ current_value: 5, avg_price: 0.8, current_size: 10 }]).fee_units, 0n, 'paid $8, got $5: no share');
      assert.equal(wallets.profitShare([{ current_value: 10, avg_price: 0.6, current_size: 10 }]).fee_units, 400000n, 'paid $6, got $10: 10% of $4');
      assert.equal(wallets.profitShare([{ current_value: 1, avg_price: 0.9995, current_size: 1 }]).fee_units, 0n, 'under a cent');
    } finally { env.polymarketFeeWallet = ''; }
  });

  await t.test('region blocks: buying and set-up are refused, selling and getting money out are not', async () => {
    const regions = require('../src/compliance/regions');
    await regions.set('polymarket', ['US'], { wallet: '0xadmin', reason: 'test' });
    try {
      // No country header is set up here, so a venue with blocks is blocked for everyone (fails closed).
      const buy = await u.api('POST', '/v1/polymarket/orders', { asset_id: assetId, market_slug: m.slug, side: 'BUY', order_type: 'GTC', price: '0.02', size: '100' });
      assert.equal(buy.status, 451); assert.equal(buy.body.error, 'region_blocked');
      assert.equal((await u.api('POST', '/v1/polymarket/wallet/transactions', { kind: 'approvals' })).status, 451);
      const sell = await u.api('POST', '/v1/polymarket/orders', { asset_id: assetId, market_slug: m.slug, side: 'SELL', order_type: 'FAK', size: '50' });
      assert.notEqual(sell.status, 451, 'selling is never blocked');
      const out = await u.api('POST', '/v1/polymarket/wallet/transactions', { kind: 'withdraw', amount: '1' });
      assert.notEqual(out.status, 451, 'withdrawing is never blocked');
    } finally {
      await regions.set('polymarket', [], { wallet: '0xadmin', reason: 'test' });
    }
  });

  await t.test('signed out: nothing is prepared', async () => {
    const res = await fetch(`${url}/v1/polymarket/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401);
  });
});
