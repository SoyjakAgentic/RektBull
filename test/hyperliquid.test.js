/**
 * Hyperliquid's wire formats and signing (public/hl-core.js, shared by the
 * Perps page and the server) and the info reads (providers/hyperliquid.js,
 * hyperliquid/markets.js).
 *
 * Signing is checked against the vectors in Hyperliquid's own Python SDK
 * (hyperliquid-python-sdk, tests/signing_test.py, read 16 November 2026). The
 * SDK publishes each vector's signature and its test key; this file holds only
 * that key's public address, and checks that our digest recovers to it from
 * the SDK's signature, so no private key is in the repository. Keys used to
 * sign here are made at run time and thrown away.
 *
 * The info answers are real ones recorded from api.hyperliquid.xyz on
 * 16 November 2026 and trimmed (test/fixtures/hyperliquid).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

Object.assign(process.env, { HL_NETWORK: 'mainnet', HL_BUILDER_ADDRESS: '0x' + 'B1'.repeat(20), HL_BUILDER_FEE_TENTHS_BPS: '10' });
delete process.env.DATABASE_URL;
const H = require('../public/hl-core.js');
const hl = require('../src/providers/hyperliquid');
const markets = require('../src/hyperliquid/markets');
const usage = require('../src/providers/usage');

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hyperliquid', `${name}.json`), 'utf8'));
const SDK_SIGNER = '0x14791697260e4c9a71f18484c9f997b308e59325'; // the address of the SDK's published test key
const VAULT = '0x1719884eb866cb12b2287399b15f7db5e7d775ea';
const sdkOrder = (type, cloid) => H.orderAction([H.orderWire({ asset: 1, isBuy: true, px: '100', sz: '100', ...type, cloid })]);

test('msgpack: the encodings Hyperliquid\'s actions use', () => {
  const hex = v => Buffer.from(H.msgpack(v)).toString('hex');
  assert.equal(hex({ a: 1, b: true, c: 'x' }), '83a16101a162c3a163a178');
  assert.equal(hex([0, 127, 128, 255, 256, 65535, 65536, 4294967295, 4294967296]), '99007fcc80ccffcd0100cdffffce00010000ceffffffffcf0000000100000000');
  assert.equal(hex(['a'.repeat(31), 'a'.repeat(32)]).slice(0, 4), '92bf');
  assert.equal(hex('a'.repeat(32)).slice(0, 4), 'd920', 'a 32-byte string takes the str8 form');
  assert.equal(hex(-1), 'ff');
  assert.equal(hex({ a: 1, skipped: undefined }), '81a16101', 'a field that isn\'t set isn\'t signed');
  assert.throws(() => H.msgpack({ p: 1.5 }), /whole numbers/, 'prices and sizes go as strings, never floats');
});

test('L1 actions: the SDK\'s hash and signatures', () => {
  // test_phantom_agent_creation_matches_production
  const ioc = H.orderAction([H.orderWire({ asset: 4, isBuy: true, px: '1670.1', sz: '0.0147', tif: 'Ioc' })]);
  assert.equal(H.actionHash(ioc, { nonce: 1677777606040 }), '0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908');
  const dummy = { type: 'dummy', num: 100000000000 };
  const vectors = [
    // [action, options, the SDK's r, s, v]
    [dummy, { nonce: 0, mainnet: true }, '0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298', '0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8', 27],
    [dummy, { nonce: 0, mainnet: false }, '0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510', '0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613', 28],
    [sdkOrder({ tif: 'Gtc' }), { nonce: 0, mainnet: true }, '0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e', '0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e', 28],
    [sdkOrder({ tif: 'Gtc' }), { nonce: 0, mainnet: false }, '0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54', '0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5', 27],
    [sdkOrder({ tif: 'Gtc' }, '0x00000000000000000000000000000001'), { nonce: 0, mainnet: true }, '0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3', '0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da', 27],
    [dummy, { nonce: 0, mainnet: true, vaultAddress: VAULT }, '0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239', '0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c', 28],
    [dummy, { nonce: 0, mainnet: false, vaultAddress: VAULT }, '0xe281d2fb5c6e25ca01601f878e4d69c965bb598b88fac58e475dd1f5e56c362b', '0x7ddad27e9a238d045c035bc606349d075d5c5cd00a6cd1da23ab5c39d4ef0f60', 27],
    [sdkOrder({ trigger: { triggerPx: '103', isMarket: true, tpsl: 'sl' } }), { nonce: 0, mainnet: true }, '0x98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9', '0x6b5bb6bb0633b710aa22b721dd9dee6d083646a5f8e581a20b545be6c1feb405', 27],
    [{ type: 'scheduleCancel', time: 123456789 }, { nonce: 0, mainnet: true }, '0x609cb20c737945d070716dcc696ba030e9976fcf5edad87afa7d877493109d55', '0x16c685d63b5c7a04512d73f183b3d7a00da5406ff1f8aad33f8ae2163bab758b', 28],
  ];
  for (const [action, opts, r, s, v] of vectors) {
    const sig = { r: ethers.zeroPadValue(ethers.toBeHex(BigInt(r)), 32), s: ethers.zeroPadValue(ethers.toBeHex(BigInt(s)), 32), v };
    assert.equal(H.recoverL1(action, sig, opts), SDK_SIGNER, `${action.type} ${JSON.stringify(opts)}`);
  }
  // A different network, nonce or action is a different signature: none of them recovers to the signer.
  const [action, opts, r, s, v] = vectors[2];
  const sig = { r, s, v };
  assert.notEqual(H.recoverL1(action, sig, { ...opts, mainnet: false }), SDK_SIGNER);
  assert.notEqual(H.recoverL1(action, sig, { ...opts, nonce: 1 }), SDK_SIGNER);
  assert.notEqual(H.recoverL1(action, sig, { ...opts, expiresAfter: 5 }), SDK_SIGNER);
  assert.notEqual(H.recoverL1(H.orderAction(action.orders, { builder: { b: '0x' + '11'.repeat(20), f: 10 } }), sig, opts), SDK_SIGNER, 'the builder fee is part of what\'s signed');
});

test('signing with a throwaway key, and what an order looks like on the wire', async () => {
  const agent = ethers.Wallet.createRandom();
  const wire = H.orderWire({ asset: 0, isBuy: false, px: '65000.0', sz: '0.0100', reduceOnly: true, tif: 'Ioc', cloid: H.cloid() });
  assert.deepEqual(Object.keys(wire), ['a', 'b', 'p', 's', 'r', 't', 'c'], 'the key order Hyperliquid hashes');
  assert.equal(wire.p, '65000'); assert.equal(wire.s, '0.01', 'trailing zeros are removed before signing');
  const action = H.orderAction([wire], { builder: { b: '0x' + 'AB'.repeat(20), f: 10 } });
  assert.deepEqual(action.builder, { b: '0x' + 'ab'.repeat(20), f: 10 }, 'addresses are lowercased');
  assert.equal(H.orderAction([wire]).builder, undefined, 'no builder, no builder field');
  assert.equal(H.orderAction([wire], { builder: { b: '', f: 10 } }).builder, undefined);
  const opts = { nonce: Date.now(), mainnet: true, expiresAfter: Date.now() + 30000 };
  const sig = await H.signL1(agent, action, opts);
  assert.equal(H.recoverL1(action, sig, opts), agent.address.toLowerCase());
  assert.equal(ethers.recoverAddress(H.l1Digest(action, opts), sig).toLowerCase(), agent.address.toLowerCase(), 'the digest a KMS key would sign');
  assert.deepEqual(H.l1TypedData(action, opts).domain, { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: ethers.ZeroAddress });
  assert.equal(H.l1TypedData(action, { ...opts, mainnet: false }).message.source, 'b');
  assert.throws(() => H.l1TypedData(action, { nonce: 1 }), /which network/);
  assert.throws(() => H.orderWire({ asset: 0, isBuy: true, px: '1', sz: '1', tif: 'Fok' }), /tif/);
  assert.deepEqual(H.cancelAction([{ asset: 3, oid: 77 }]), { type: 'cancel', cancels: [{ a: 3, o: 77 }] });
  assert.deepEqual(H.updateLeverageAction({ asset: 3, isCross: false, leverage: 5 }), { type: 'updateLeverage', asset: 3, isCross: false, leverage: 5 });
});

test('user-signed actions: approveAgent and approveBuilderFee, signed by the user\'s own wallet', async () => {
  const user = ethers.Wallet.createRandom();
  const agent = ethers.Wallet.createRandom().address;
  const until = Date.UTC(2027, 0, 1);
  const a = H.approveAgentAction({ mainnet: true, signatureChainId: 42161, agentAddress: agent, name: 'rektbull-web', validUntilMs: until, nonce: 1716531066415 });
  assert.deepEqual(a, { type: 'approveAgent', hyperliquidChain: 'Mainnet', signatureChainId: '0xa4b1', agentAddress: agent.toLowerCase(), agentName: `rektbull-web valid_until ${until}`, nonce: 1716531066415 });
  const t = H.userTypedData(a);
  assert.deepEqual(t.domain, { name: 'HyperliquidSignTransaction', version: '1', chainId: 42161, verifyingContract: ethers.ZeroAddress });
  assert.equal(t.primaryType, 'HyperliquidTransaction:ApproveAgent');
  assert.deepEqual(t.types[t.primaryType].map(f => `${f.type} ${f.name}`), ['string hyperliquidChain', 'address agentAddress', 'string agentName', 'uint64 nonce']);
  const sig = await user.signTypedData(t.domain, t.types, t.message);
  assert.equal(H.recoverUser(a, sig), user.address.toLowerCase());
  assert.notEqual(H.recoverUser({ ...a, agentAddress: ethers.Wallet.createRandom().address.toLowerCase() }, sig), user.address.toLowerCase(), 'the agent\'s address is signed');
  assert.notEqual(H.recoverUser({ ...a, hyperliquidChain: 'Testnet' }, sig), user.address.toLowerCase());

  const b = H.approveBuilderFeeAction({ mainnet: false, signatureChainId: 8453, builder: '0x' + 'CD'.repeat(20), tenthsBps: 10, nonce: 5 });
  assert.deepEqual(b, { type: 'approveBuilderFee', hyperliquidChain: 'Testnet', signatureChainId: '0x2105', maxFeeRate: '0.01%', builder: '0x' + 'cd'.repeat(20), nonce: 5 });
  assert.deepEqual(H.userTypedData(b).types['HyperliquidTransaction:ApproveBuilderFee'].map(f => f.name), ['hyperliquidChain', 'maxFeeRate', 'builder', 'nonce']);
  assert.deepEqual([1, 10, 25, 100, 0].map(H.feeRate), ['0.001%', '0.01%', '0.025%', '0.1%', '0%']);
  assert.throws(() => H.userTypedData({ type: 'withdraw3' }), /isn't an action this page signs/, 'nothing here can build a withdrawal');
  assert.throws(() => H.agentName('a name with spaces'), /1 to 16/);
});

test('prices and sizes: Hyperliquid\'s tick and lot size rules', () => {
  // The documentation's own examples (for-developers/api/tick-and-lot-size).
  assert.equal(H.formatPrice(1234.5, 0), '1234.5');
  assert.equal(H.formatPrice(1234.56, 0), '1234.6', 'five significant figures');
  assert.equal(H.formatPrice(0.001234, 0), '0.001234');
  assert.equal(H.formatPrice(0.0012345, 0), '0.001235', 'at most six decimals');
  assert.equal(H.formatPrice(0.01234, 1), '0.01234');
  assert.equal(H.formatPrice(0.012345, 1), '0.01235', 'at most 6 - szDecimals decimals');
  assert.equal(H.formatPrice(123456, 0), '123456', 'a whole number is always allowed');
  assert.equal(H.formatPrice(123456.7, 0), '123457');
  assert.equal(H.formatSize(1.001, 3), '1.001');
  assert.equal(H.formatSize(1.0019, 3), '1.001', 'sizes round down');
  assert.equal(H.formatSize(0.3, 1), '0.3'); assert.equal(H.formatSize(0.1 + 0.2, 1), '0.3');
  // Rounding by side never goes past the price asked for.
  assert.equal(H.formatPrice(65432.19, 5, 'down'), '65432'); assert.equal(H.formatPrice(65432.19, 5, 'up'), '65433');
  assert.equal(H.formatPrice(1.33456, 2, 'down'), '1.3345'); assert.equal(H.formatPrice(1.33456, 2, 'up'), '1.3346');
  assert.equal(H.formatPrice(99999.6, 0, 'up'), '100000');
  assert.equal(H.slippagePrice(65365, true, 0.01, 5), '66018', 'a buy\'s cap, rounded down');
  assert.equal(H.slippagePrice(65365, false, 0.01, 5), '64712', 'a sale\'s floor, rounded up');
  assert.ok(Number(H.slippagePrice(1.3345, true, 0.005, 2)) <= 1.3345 * 1.005);
  assert.ok(Number(H.slippagePrice(1.3345, false, 0.005, 2)) >= 1.3345 * 0.995);
  assert.throws(() => H.formatPrice(0, 2), /above 0/);
});

test('info reads: markets, an account, approvals, and what happens when a part fails', async () => {
  const calls = [];
  const answers = { metaAndAssetCtxs: fixture('metaAndAssetCtxs'), clearinghouseState: fixture('clearinghouseState'), frontendOpenOrders: fixture('frontendOpenOrders'), extraAgents: [{ name: 'rektbull-web', address: '0x' + 'AA'.repeat(20), validUntil: 1797459741057 }], maxBuilderFee: 10 };
  hl.setTransport(async (p, body) => {
    calls.push([p, body]);
    if (answers[body.type] instanceof Error) throw answers[body.type];
    return answers[body.type];
  });
  hl._reset();
  const before = usage._counts.get(`hyperliquid|${new Date().toISOString().slice(0, 10)}`) || 0;

  const list = await markets.markets();
  assert.deepEqual(list.map(m => m.coin), ['BTC', 'ETH', 'ATOM', 'MATIC', 'DYDX', 'SOL', 'AVAX', 'BNB']);
  const btc = list[0];
  assert.equal(btc.asset, 0, 'a perp\'s asset id is its index in the universe');
  assert.equal(btc.sz_decimals, 5); assert.equal(btc.max_leverage, 40);
  assert.equal(btc.mark_px, 65365); assert.equal(btc.oracle_px, 65378.5);
  assert.equal(btc.open_interest_usd, Math.round(38244.43308 * 65365));
  assert.equal(btc.auto, true);
  const matic = list.find(m => m.coin === 'MATIC');
  assert.equal(matic.delisted, true); assert.equal(matic.auto, false); assert.equal(matic.auto_refusal, 'delisted');
  const atom = list.find(m => m.coin === 'ATOM');
  assert.equal(atom.auto, false, 'a thin market is closed to automatic trading');
  assert.match(atom.auto_refusal, /open interest under \$5,000,000/);
  await markets.markets();
  assert.equal(calls.length, 1, 'a second read within a few seconds reuses the first');
  assert.equal(usage._counts.get(`hyperliquid|${new Date().toISOString().slice(0, 10)}`), before + 1, 'counted through usage.track');
  await assert.rejects(markets.market('NOPE'), /no perp market called NOPE/);

  const user = '0x' + 'Ab'.repeat(20);
  const acct = await markets.account(user);
  assert.equal(acct.source, 'Hyperliquid\'s info API');
  assert.equal(acct.user, user.toLowerCase());
  assert.ok(acct.account_value_usd > 0);
  const pos = acct.positions.find(p => p.coin === 'BTC');
  assert.deepEqual([pos.side, pos.size, pos.entry_px, pos.leverage, pos.margin_mode], ['short', 0.10389, 65045.3, 20, 'cross']);
  assert.equal(pos.unrealized_pnl_usd, -34.035896); assert.equal(pos.return_on_equity_pct, -10.07);
  assert.ok(pos.liquidation_px > 0); assert.ok(pos.margin_used_usd > 0);
  assert.deepEqual([acct.open_orders[0].coin, acct.open_orders[0].side, acct.open_orders[0].tif], ['AVAX', 'sell', 'Alo']);
  assert.deepEqual(calls.slice(1).map(c => c[1].user), [user.toLowerCase(), user.toLowerCase()], 'addresses are lowercased before they\'re sent');
  await assert.rejects(markets.account('0x123'), /wallet address/);

  // One part down: the rest is still shown, and the missing part says why.
  answers.frontendOpenOrders = new Error('socket hang up');
  const partial = await markets.account('0x' + 'cd'.repeat(20));
  assert.ok(Array.isArray(partial.positions));
  assert.equal(partial.open_orders, undefined);
  assert.match(partial.open_orders_error, /Open orders couldn't be read: Hyperliquid's info API didn't answer \(socket hang up\)/);

  const ap = await markets.approvals(user);
  assert.deepEqual(ap.agents, [{ name: 'rektbull-web', address: '0x' + 'aa'.repeat(20), valid_until: 1797459741057 }]);
  assert.deepEqual(ap.builder_fee, { set: true, builder: '0x' + 'b1'.repeat(20), approved_tenths_bps: 10, needed_tenths_bps: 10, approved: true, proposal_tenths_bps: 50, proposal_approved: false, auto_tenths_bps: 50, auto_approved: false }, 'the 0.01% fee is approved; the 0.05% proposal and automatic-order fees aren\'t yet');
});

test('the weight budget: reads are refused before Hyperliquid would block the server', async () => {
  hl._reset();
  hl.setTransport(async () => ({}));
  assert.deepEqual(['clearinghouseState', 'allMids', 'metaAndAssetCtxs', 'frontendOpenOrders', 'userRole'].map(hl.weightOf), [2, 2, 20, 20, 60]);
  for (let i = 0; i < 50; i++) await hl.info({ type: 'metaAndAssetCtxs', n: i }); // 50 x 20 = the whole budget of 1,000
  assert.equal(hl.weightUsed(), 1000);
  await assert.rejects(hl.info({ type: 'clearinghouseState', user: 'x' }), err => err.status === 503 && /as fast as Hyperliquid allows/.test(err.message));
  await assert.rejects(hl.exchange({ action: { type: 'cancel', cancels: [] } }), /as fast as Hyperliquid allows/);
  hl._reset();
  const sent = [];
  hl.setTransport(async (p, body) => { sent.push([p, body]); return { status: 'ok' }; });
  const payload = { action: { type: 'cancel', cancels: [{ a: 0, o: 1 }] }, nonce: 1, signature: { r: '0x1', s: '0x2', v: 27 } };
  assert.deepEqual(await hl.exchange(payload), { status: 'ok' });
  assert.deepEqual(sent, [['/exchange', payload]], 'a signed action is passed on exactly as it came');
  hl.setTransport(async () => { throw Object.assign(new Error('Request failed'), { response: { status: 429, data: 'rate limited' } }); });
  await assert.rejects(hl.exchange(payload), /rate-limiting RektBull just now\. Nothing was sent/);
});
