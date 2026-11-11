/**
 * Milestone 1: approve-each trading, the KMS signer, and the permissions registry.
 * Unit tests always run; the end-to-end part needs TEST_DATABASE_URL.
 */
const http = require('http');
const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

// A fake Base node (balances and receipts), started before the modules read env.
const chain = { balances: {}, receipts: {} };
const rpc = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const { method, params, id } = JSON.parse(body);
    let result = null;
    if (method === 'eth_call') result = ethers.toBeHex(chain.balances[params[0].to.toLowerCase()] || 0n, 32);
    if (method === 'eth_getBalance') result = ethers.toBeHex(chain.native || 0n);
    if (method === 'eth_getTransactionReceipt') result = chain.receipts[params[0]] || null;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
});
const rpcReady = new Promise(r => rpc.listen(0, '127.0.0.1', () => r(rpc.address().port)));

const FEE_WALLET = '0x' + 'fe'.repeat(20);
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TOKEN = '0x' + '7a'.repeat(20);
const AH = '0x0000000000001ff3684f28c67538d4d072c22734';
const ROUTER_SEPOLIA = require('../src/trade/networks').network(84532).router; // the deployed Base Sepolia router

test('trading', async t => {
  const port = await rpcReady;
  Object.assign(process.env, {
    TRADING_ENABLED: 'true', SWAP_FEE_WALLET_EVM: FEE_WALLET, ZEROEX_API_KEY: 'test',
    RPC_URLS_BASE: `http://127.0.0.1:${port}`, RPC_URLS_BSC: `http://127.0.0.1:${port}`, TRADE_ROUTERS: JSON.stringify({ 84532: ROUTER_SEPOLIA }),
    JWT_SECRET: 'test-secret', ...(process.env.TEST_DATABASE_URL ? { DATABASE_URL: process.env.TEST_DATABASE_URL } : {}),
  });
  t.after(() => rpc.close());

  const { KmsSigner, parseDer } = require('../src/trade/kmsSigner');
  const { walletCalls } = require('../src/trade/calls');
  const permissions = require('../src/trade/permissions');
  const positions = require('../src/trade/positions');
  const zeroex = require('../src/trade/zeroex');
  const dd = require('../src/services/dueDiligence');
  const core = require('@metamask/delegation-core');
  const { DELEGATOR_CONTRACTS } = require('@metamask/delegation-deployments');
  const MM = DELEGATOR_CONTRACTS['1.3.0'][84532];

  // ── KMS signer ────────────────────────────────────────────────────────────
  await t.test('KMS signer: turns KMS\'s DER signatures into Ethereum signatures, high-s or not', async () => {
    const key = new ethers.SigningKey(ethers.hexlify(crypto.randomBytes(32)));
    const der = (r, s) => {
      const int = v => { let h = v.toString(16); if (h.length % 2) h = '0' + h; let b = Buffer.from(h, 'hex'); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return Buffer.concat([Buffer.from([2, b.length]), b]); };
      const body = Buffer.concat([int(r), int(s)]);
      return Buffer.concat([Buffer.from([0x30, body.length]), body]);
    };
    const pem = '-----BEGIN PUBLIC KEY-----\n' + Buffer.concat([Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex'), Buffer.from(key.publicKey.slice(2), 'hex')]).toString('base64') + '\n-----END PUBLIC KEY-----\n';
    let flipHighS = false;
    const fakeKms = {
      getPublicKey: async () => [{ pem, algorithm: 'EC_SIGN_SECP256K1_SHA256' }],
      asymmetricSign: async ({ name, digest }) => {
        const sig = key.sign(digest.sha256);
        let s = BigInt(sig.s);
        if (flipHighS) s = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141') - s; // what KMS may return
        return [{ name, signature: der(BigInt(sig.r), s), verifiedDigestCrc32c: true }];
      },
    };
    const signer = new KmsSigner({ keyVersion: 'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1', client: fakeKms });
    const address = ethers.computeAddress(key.publicKey);
    assert.equal(await signer.getAddress(), address);

    for (const high of [false, true]) {
      flipHighS = high;
      const msgSig = await signer.signMessage('hello');
      assert.equal(ethers.verifyMessage('hello', msgSig), address, `message, high-s=${high}`);
      assert.ok(BigInt(ethers.Signature.from(msgSig).s) <= BigInt('0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0'), 'low-s');
      const raw = await signer.signTransaction({ to: FEE_WALLET, value: 1n, nonce: 0, gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, chainId: 8453n, type: 2 });
      assert.equal(ethers.Transaction.from(raw).from, address, `transaction, high-s=${high}`);
    }
    const domain = { name: 'DelegationManager', version: '1', chainId: 84532, verifyingContract: MM.DelegationManager };
    const sig = await signer.signTypedData(domain, { M: [{ name: 'x', type: 'uint256' }] }, { x: 1 });
    assert.equal(ethers.verifyTypedData(domain, { M: [{ name: 'x', type: 'uint256' }] }, { x: 1 }, sig), address);

    assert.throws(() => parseDer(Buffer.from('3006020101020101ff', 'hex')), /mismatch|trailing/);
    await assert.rejects(new KmsSigner({ keyVersion: 'k', client: { ...fakeKms, getPublicKey: async () => [{ pem, algorithm: 'EC_SIGN_P256_SHA256' }] } }).getAddress(), /not EC_SIGN_SECP256K1/);
  });

  // ── Wallet calls ──────────────────────────────────────────────────────────
  await t.test('wallet calls: only through 0x\'s AllowanceHolder, approvals only to it and only for the trade', () => {
    const plan = q => ({ chain: 'base', wallet: '0x' + '11'.repeat(20), side: 'buy', token: TOKEN, baseToken: { address: USDC }, quote: { sellAmount: 100n, ...q } });
    const ok = walletCalls(plan({ transaction: { to: AH, data: '0xabcd', value: '0' }, allowanceSpender: AH }));
    assert.deepEqual(ok.calls.map(c => c.step), ['approve', 'swap']);
    assert.equal(ok.calls[0].to, USDC);
    assert.match(ok.calls[0].data, /^0x095ea7b3/);
    assert.throws(() => walletCalls(plan({ transaction: { to: '0x' + '66'.repeat(20), data: '0x' } })), /not its AllowanceHolder/);
    assert.throws(() => walletCalls(plan({ transaction: { to: AH, data: '0x' }, allowanceSpender: '0x' + '66'.repeat(20) })), /approval to/);
    assert.throws(() => walletCalls(plan({ transaction: { to: AH, data: '0x', value: '5' } })), /send ETH/);
  });

  // ── Permissions registry ─────────────────────────────────────────────────
  const user = ethers.Wallet.createRandom();
  const session = ethers.Wallet.createRandom().address;
  const now = Math.floor(Date.now() / 1000);
  async function delegation({ caveats, signer = user, delegate = session, delegator = user.address, salt = 1n } = {}) {
    const cv = caveats || [
      { enforcer: MM.RedeemerEnforcer, terms: core.createRedeemerTerms({ redeemers: [session] }), args: '0x' },
      { enforcer: MM.TimestampEnforcer, terms: core.createTimestampTerms({ afterThreshold: 0, beforeThreshold: now + 7 * 86400 }), args: '0x' },
      { enforcer: MM.AllowedTargetsEnforcer, terms: core.createAllowedTargetsTerms({ targets: [ROUTER_SEPOLIA] }), args: '0x' },
      { enforcer: MM.AllowedMethodsEnforcer, terms: core.createAllowedMethodsTerms({ selectors: [permissions.SWAP_SELECTOR] }), args: '0x' },
    ];
    const domain = { name: 'DelegationManager', version: '1', chainId: 84532, verifyingContract: MM.DelegationManager };
    const signature = await signer.signTypedData(domain, permissions.TYPES, { delegate, delegator, authority: core.ROOT_AUTHORITY, caveats: cv.map(c => ({ enforcer: c.enforcer, terms: c.terms })), salt });
    return { delegate, delegator, authority: core.ROOT_AUTHORITY, caveats: cv, salt: salt.toString(), signature };
  }
  const check = d => permissions.checkDelegation({ delegation: d, chainId: 84532, wallet: user.address, sessionKey: session, now });

  await t.test('permissions: a correct RektBull delegation is accepted', async () => {
    const c = check(await delegation());
    assert.equal(c.router, ROUTER_SEPOLIA);
    assert.equal(c.expiresAt, now + 7 * 86400);
    assert.match(c.hash, /^0x[0-9a-f]{64}$/);
  });

  await t.test('permissions: anything broader or forged is refused before it is stored', async () => {
    const good = await delegation();
    const [redeemer, timestamp, targets, methods] = good.caveats;
    const variant = async caveats => check(await delegation({ caveats }));
    await assert.rejects(variant([redeemer, timestamp, targets]), /four caveats/, 'a missing caveat');
    await assert.rejects(variant([redeemer, timestamp, { ...targets, terms: core.createAllowedTargetsTerms({ targets: [ROUTER_SEPOLIA, USDC] }) }, methods]), /only allow calling the RektBull Trade Router/, 'an extra target');
    await assert.rejects(variant([redeemer, timestamp, { ...targets, terms: core.createAllowedTargetsTerms({ targets: [USDC] }) }, methods]), /Trade Router/, 'another target');
    await assert.rejects(variant([redeemer, timestamp, targets, { ...methods, terms: core.createAllowedMethodsTerms({ selectors: [permissions.SWAP_SELECTOR, '0x095ea7b3'] }) }]), /swap/, 'an extra method');
    await assert.rejects(variant([{ ...redeemer, terms: core.createRedeemerTerms({ redeemers: [session, user.address] }) }, timestamp, targets, methods]), /session key may be allowed/, 'an extra redeemer');
    await assert.rejects(variant([redeemer, { ...timestamp, terms: core.createTimestampTerms({ afterThreshold: 0, beforeThreshold: now + 60 * 86400 }) }, targets, methods]), /within 30 days/, 'too long');
    await assert.rejects(variant([redeemer, { ...timestamp, terms: core.createTimestampTerms({ afterThreshold: 0, beforeThreshold: now - 1 }) }, targets, methods]), /expired/, 'already expired');
    await assert.rejects(Promise.resolve().then(async () => check(await delegation({ signer: ethers.Wallet.createRandom() }))), /not signed by your wallet/, 'signed by someone else');
    await assert.rejects(Promise.resolve().then(async () => check(await delegation({ delegate: user.address }))), /session key/, 'to another delegate');
    await assert.rejects(Promise.resolve().then(async () => check({ ...good, delegator: '0x' + '22'.repeat(20) })), /signed-in wallet/, 'for another wallet');
    await assert.rejects(Promise.resolve().then(() => check({ ...good, salt: '2' })), /not signed by your wallet/, 'tampered after signing');
    await assert.rejects(Promise.resolve().then(() => permissions.checkDelegation({ delegation: good, chainId: 8453, wallet: user.address, sessionKey: session, now })), /isn't available on chain 8453/, 'mainnet before the audit');
  });

  // ── Positions ────────────────────────────────────────────────────────────
  await t.test('positions: a trade counts only if it moved the token for this wallet', () => {
    const wallet = '0x' + '11'.repeat(20);
    const log = (from, to, amount, token = TOKEN) => ({ address: token, topics: [ethers.id('Transfer(address,address,uint256)'), ethers.zeroPadValue(from, 32), ethers.zeroPadValue(to, 32)], data: ethers.toBeHex(amount, 32) });
    const receipt = { status: '0x1', logs: [log(AH, wallet, 500n), log(AH, '0x' + '33'.repeat(20), 9n), log(AH, wallet, 7n, USDC)] };
    assert.equal(positions.moved(receipt, TOKEN, wallet, 'in'), 500n);
    assert.equal(positions.moved(receipt, TOKEN, wallet, 'out'), 0n);
  });

  // ── End to end (database) ────────────────────────────────────────────────
  await t.test('approve-each, end to end: propose, re-check on approval, wallet calls, confirm, position', { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL' }, async () => {
    const db = require('../src/config/db');
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await require('../src/config/migrate').migrate();
    const proposals = require('../src/trade/proposals');
    const rules = require('../src/trade/rules');
    const wallet = '0x' + '11'.repeat(20);
    const { rows } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id', [wallet]);
    const account = { id: Number(rows[0].id), wallet };

    // 0x and the token check, faked: a clean token that sells back with ~3% loss.
    let risk = { verdict: 'low', flags: [], disagreements: [] };
    dd.quickCheck = async () => risk;
    // The bundle check for young tokens (services/launches.js): an established token unless a case says otherwise.
    const launches = require('../src/services/launches');
    let launch = { young: false, risk: 'ok', detail: 'its first pool opened 90 days ago (DexScreener)' };
    launches.forTrade = async () => launch;
    const seen = [];
    zeroex.setTransport(async (path, params) => {
      seen.push({ path, params });
      const selling = params.sellToken.toLowerCase();
      if (selling === USDC) {
        return { liquidityAvailable: true, sellAmount: params.sellAmount, buyAmount: '1000000', minBuyAmount: '990000', tokenMetadata: { buyToken: { buyTaxBps: '0', sellTaxBps: '0' } },
          issues: { allowance: { spender: AH } }, transaction: { to: AH, data: '0xdeadbeef', value: '0', gas: '200000' } };
      }
      return { liquidityAvailable: true, sellAmount: params.sellAmount, buyAmount: String(BigInt(params.sellAmount) === 1000000n ? 97_000_000n : 1n), minBuyAmount: '1', transaction: { to: AH, data: '0xfeed', value: '0' } };
    });

    // Over the per-trade amount is refused; raising it in settings allows it.
    await assert.rejects(proposals.propose(account, { chain: 'base', side: 'buy', token: TOKEN, amount_usd: 600 }), /over your per-trade amount of \$500/);
    await rules.saveSettings(account.id, { max_trade_usd: 1000 });

    const p = await proposals.propose(account, { chain: 'base', side: 'buy', token: TOKEN, amount_usd: 100 });
    assert.equal(p.status, 'proposed');
    assert.equal(p.plan.summary.fee.pct, 1);
    assert.deepEqual(p.plan.checks.map(c => c.check), ['per_trade_amount', 'token_risk', 'tax', 'sell_back']);
    const q = seen.find(s => s.path.endsWith('/quote'));
    assert.equal(q.params.swapFeeBps, 100);
    assert.equal(q.params.swapFeeRecipient, FEE_WALLET);
    assert.equal(q.params.swapFeeToken, USDC, 'the fee is taken in the base asset');
    assert.equal(q.params.taker, wallet);

    // If the token turns risky before approval, approval re-checks and refuses.
    risk = { verdict: 'critical', flags: [{ severity: 'critical', title: 'It could not be sold back after a buy' }] };
    await assert.rejects(proposals.approve(account, p.id), /critical risk/);
    assert.equal((await proposals.get(account, p.id)).status, 'failed');

    // A young token: a critical bundle finding stops the buy; a high one needs confirming; a check that couldn't run does too.
    risk = { verdict: 'low', flags: [], disagreements: [] };
    launch = { young: true, risk: 'block', detail: 'A bundle bought 40% at launch and has sold 80% of it.', flags: [{ severity: 'critical', title: 'A bundle bought 40% at launch and has sold 80% of it', evidence: '6 early buyers funded from 0xabc…', source: 'Block explorer and RPC' }] };
    await assert.rejects(proposals.propose(account, { chain: 'base', side: 'buy', token: TOKEN, amount_usd: 100 }), /bundle check found a critical risk: A bundle bought 40%/);
    launch = { young: true, risk: 'confirm', detail: 'A bundle bought 15% of the supply at launch.', flags: [{ severity: 'high', title: 'A bundle bought 15% of the supply at launch', evidence: '5 early buyers…', source: 'Block explorer and RPC' }] };
    await assert.rejects(proposals.propose(account, { chain: 'base', side: 'buy', token: TOKEN, amount_usd: 100 }), e => e.needsAcknowledgement && e.risks[0].title === 'A bundle bought 15% of the supply at launch');
    const young = await proposals.propose(account, { chain: 'base', side: 'buy', token: TOKEN, amount_usd: 100, acknowledge_risks: true });
    assert.deepEqual(young.plan.checks.map(c => c.check), ['per_trade_amount', 'token_risk', 'bundle', 'tax', 'sell_back']);
    assert.match(young.plan.checks.find(c => c.check === 'bundle').detail, /launch check: A bundle bought 15%/);
    launch = { young: true, risk: 'unknown', detail: 'the bundle check couldn\'t run: the explorer didn\'t answer', flags: [] };
    await assert.rejects(proposals.propose(account, { chain: 'base', side: 'buy', token: TOKEN, amount_usd: 100 }), e => e.needsAcknowledgement && /couldn't check it for a bundled launch/.test(e.message));
    launch = { young: false, risk: 'ok', detail: 'its first pool opened 90 days ago (DexScreener)' };

    // High risks need acknowledgement.
    risk = { verdict: 'high', flags: [{ id: 'upgradeable', severity: 'high', title: 'Its code can be replaced (a proxy)' }] };
    await assert.rejects(proposals.propose(account, { chain: 'base', side: 'buy', token: TOKEN, amount_usd: 100 }), e => e.needsAcknowledgement && /high risk/.test(e.message));
    const p2 = await proposals.propose(account, { chain: 'base', side: 'buy', token: TOKEN, amount_usd: 100, acknowledge_risks: true });

    const approved = await proposals.approve(account, p2.id);
    assert.equal(approved.status, 'approved');
    assert.deepEqual(approved.calls.calls.map(c => c.step), ['approve', 'swap']);
    assert.equal(approved.calls.chainId, '0x2105');

    // The wallet sends it; a hash for a transaction that didn't move the token for this wallet confirms nothing.
    const other = '0x' + 'aa'.repeat(32);
    await proposals.submitted(account, p2.id, other);
    chain.receipts[other] = { status: '0x1', logs: [] };
    await positions.tick();
    assert.equal((await proposals.get(account, p2.id)).status, 'failed');

    const p3 = await proposals.approve(account, (await proposals.propose(account, { chain: 'base', side: 'buy', token: TOKEN, amount_usd: 100, acknowledge_risks: true })).id);
    const real = '0x' + 'bb'.repeat(32);
    await proposals.submitted(account, p3.id, real);
    chain.receipts[real] = { status: '0x1', logs: [{ address: TOKEN, topics: [ethers.id('Transfer(address,address,uint256)'), ethers.zeroPadValue(AH, 32), ethers.zeroPadValue(wallet, 32)], data: ethers.toBeHex(1000000n, 32) }] };
    await positions.tick();
    assert.equal((await proposals.get(account, p3.id)).status, 'confirmed');
    const pos = await positions.list(account.id);
    assert.equal(pos[0].amount_raw, '1000000');
    assert.equal(pos[0].cost_usd, 100);

    // A sell skips the buy checks, even with a critical token: it's how you get out.
    risk = { verdict: 'critical', flags: [{ severity: 'critical', title: 'honeypot' }] };
    chain.balances[TOKEN] = 1000000n;
    const sell = await proposals.propose(account, { chain: 'base', side: 'sell', token: TOKEN, sell_fraction: 0.5 });
    assert.equal(sell.status, 'proposed');
    assert.equal(sell.plan.checks[0].check, 'sell');

    // ── A Virtuals token on its bonding curve: through 0x into VIRTUAL, then the curve (and back) ──
    const lp = require('../src/services/launchpads');
    const CURVE = '0x' + 'c0'.repeat(20);
    const VIRTUAL = lp.VIRTUAL;
    let pad = { launchpad: 'virtuals', name: 'Virtuals', state: 'curve', source: 'Virtuals\' Bonding contract onchain (tokenInfo)', curve: { buy_tax_pct: 1, sell_tax_pct: 1, progress_pct: 12.5 } };
    lp.identify = async (_c, t) => (t === CURVE ? pad : { launchpad: null });
    lp.curveBuyQuote = async (_t, v) => v * 1000n; // 1 VIRTUAL buys 1,000 tokens
    lp.curveSellQuote = async (_t, n) => n * 98n / 100n / 1000n; // and selling back loses the 2% taxes
    zeroex.setTransport(async (path, params) => {
      seen.push({ path, params });
      if (params.buyToken.toLowerCase() === VIRTUAL) {
        return { liquidityAvailable: true, sellAmount: params.sellAmount, buyAmount: String(50n * 10n ** 18n), minBuyAmount: String(49n * 10n ** 18n), issues: { allowance: { spender: AH } }, transaction: { to: AH, data: '0xc0ffee', value: '0' } };
      }
      // Selling VIRTUAL the curve sale delivers in the same batch: 0x sees no balance yet.
      return { liquidityAvailable: true, sellAmount: params.sellAmount, buyAmount: '9000000', minBuyAmount: '8900000', issues: { balance: { actual: '0', expected: params.sellAmount }, simulationIncomplete: true }, transaction: { to: AH, data: '0xbeef', value: '0' } };
    });
    const buy = await proposals.approve(account, (await proposals.propose(account, { chain: 'base', side: 'buy', token: CURVE, amount_usd: 100 })).id);
    assert.deepEqual(buy.plan.checks.map(c => c.check), ['launchpad', 'per_trade_amount', 'bundle', 'sell_back']);
    assert.match(buy.plan.checks[0].detail, /bonding curve \(12.5% of the way to graduating/);
    assert.equal(seen.at(-1).params.swapFeeBps, 100, 'the 1% fee is inside the 0x swap into VIRTUAL');
    assert.deepEqual(buy.calls.calls.map(c => c.step), ['approve', 'to_virtual', 'approve', 'swap']);
    assert.equal(buy.calls.confirm_step, 'swap');
    const ERC20 = new ethers.Interface(['function approve(address spender, uint256 amount)']);
    const [, , approveCurve, curveBuy] = buy.calls.calls;
    assert.equal(approveCurve.to, VIRTUAL);
    const [spender, allowance] = ERC20.decodeFunctionData('approve', approveCurve.data);
    assert.deepEqual([spender.toLowerCase(), allowance], [lp.ADDR.frouter, 49n * 10n ** 18n], 'VIRTUAL approved to Virtuals\' FRouter, for exactly what the curve buy spends');
    assert.equal(curveBuy.to, lp.ADDR.bonding);
    const b = lp.BONDING.decodeFunctionData('buy', curveBuy.data);
    assert.equal(b[0], 49n * 10n ** 18n, 'it spends the least the 0x swap delivers');
    assert.equal(b[1].toLowerCase(), CURVE);
    assert.equal(b[2], 49000n * 10n ** 18n * 99n / 100n, 'the curve\'s minimum, after your 1% slippage');

    chain.balances[CURVE] = 2000n * 10n ** 18n;
    const out = await proposals.approve(account, (await proposals.propose(account, { chain: 'base', side: 'sell', token: CURVE, sell_fraction: 1 })).id);
    assert.deepEqual(out.calls.calls.map(c => c.step), ['approve', 'swap', 'approve', 'from_virtual']);
    const [approveToken, curveSell, approveVirtual] = out.calls.calls;
    assert.equal(approveToken.to, CURVE);
    assert.equal(ERC20.decodeFunctionData('approve', approveToken.data)[0].toLowerCase(), lp.ADDR.frouter, 'the token is approved to Virtuals\' FRouter only');
    const sl = lp.BONDING.decodeFunctionData('sell', curveSell.data);
    assert.equal(sl[0], 2000n * 10n ** 18n);
    assert.equal(sl[2], 2000n * 10n ** 18n * 98n / 100n / 1000n * 99n / 100n, 'the VIRTUAL minimum, after your 1% slippage');
    assert.equal(approveVirtual.to, VIRTUAL);
    assert.deepEqual([ERC20.decodeFunctionData('approve', approveVirtual.data)[0].toLowerCase(), ERC20.decodeFunctionData('approve', approveVirtual.data)[1]], [AH, sl[2]], 'only the VIRTUAL minimum, to 0x\'s AllowanceHolder');
    assert.equal(seen.at(-1).params.swapFeeBps, 100, 'the 1% fee is inside the 0x swap out of VIRTUAL');

    // A graduated token is refused, naming the token that replaced it; a tampered route is never used.
    pad = { ...pad, state: 'graduated', agent_token: '0x' + 'a9'.repeat(20) };
    await assert.rejects(proposals.propose(account, { chain: 'base', side: 'buy', token: CURVE, amount_usd: 100 }), /graduated.*0xa9a9/);
    const { walletCalls: wc } = require('../src/trade/calls');
    assert.throws(() => wc({ chain: 'base', side: 'buy', token: CURVE, route: { kind: 'virtuals_curve', bonding: '0x' + 'ee'.repeat(20), frouter: lp.ADDR.frouter, virtual: VIRTUAL } }), /doesn't use/);

    // ── A four.meme token on its bonding curve (BNB Chain): USDT through 0x into BNB, then the curve ──
    const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const USDT = '0x55d398326f99059ff775485246999027b3197955';
    const FM = '0x' + 'f4'.repeat(20);
    const TM2 = lp.FOURMEME.tokenManager;
    const E18 = 10n ** 18n;
    await require('../src/lib/cache').set('price:coingecko:binancecoin', 600, 300); // BNB at $600, no network
    let fm = { launchpad: 'fourmeme', name: 'four.meme', version: 2, token_manager: TM2, quote: 'bnb', quote_symbol: 'BNB', state: 'curve', source: 'four.meme\'s TokenManagerHelper3 contract onchain (getTokenInfo)', curve: { progress_pct: 3.8, graduates_at: 14.6, buy_tax_pct: 1, sell_tax_pct: 1, min_fee_wei: '0' } };
    lp.identify = async (c, t) => (c === 'bsc' && t === FM ? fm : { launchpad: null });
    lp.fourMemeBuyQuote = async (_t, funds) => ({ amount: funds * 100_000_000n / E18, msgValue: funds, manager: TM2 }); // 1 BNB buys 100M tokens
    lp.fourMemeSellQuote = async (_t, n) => { const gross = n * E18 / 100_000_000n * 98n / 99n; return { funds: gross * 99n / 100n, fee: gross / 100n }; };
    zeroex.setTransport(async (path, params) => {
      seen.push({ path, params });
      if (params.buyToken === NATIVE) return { liquidityAvailable: true, sellAmount: params.sellAmount, buyAmount: String(17n * E18 / 100n), minBuyAmount: String(16n * E18 / 100n), issues: { allowance: { spender: AH } }, transaction: { to: AH, data: '0xc0ffee', value: '0' } };
      // Selling BNB the curve sale delivers in the same batch: 0x sees no balance yet.
      return { liquidityAvailable: true, sellAmount: params.sellAmount, buyAmount: '90000000000000000000', minBuyAmount: '89000000000000000000', issues: { balance: { actual: '0', expected: params.sellAmount } }, transaction: { to: AH, data: '0xbeef', value: params.sellAmount } };
    });
    const fmBuy = await proposals.approve(account, (await proposals.propose(account, { chain: 'bsc', side: 'buy', token: FM, base: 'USDT', amount_usd: 100 })).id);
    assert.deepEqual(fmBuy.plan.checks.map(c => c.check), ['launchpad', 'per_trade_amount', 'bundle', 'sell_back']);
    assert.match(fmBuy.plan.checks[0].detail, /four\.meme token on its bonding curve \(3\.8% sold; it graduates to PancakeSwap at 14\.6 BNB/);
    assert.deepEqual([seen.at(-1).params.sellToken, seen.at(-1).params.buyToken, seen.at(-1).params.swapFeeBps, seen.at(-1).params.swapFeeToken], [USDT, NATIVE, 100, USDT], 'the 1% fee is inside the 0x swap into BNB, in USDT');
    assert.deepEqual(fmBuy.calls.calls.map(c => c.step), ['approve', 'to_bnb', 'swap']);
    assert.equal(fmBuy.calls.confirm_step, 'swap');
    const fmCurveBuy = fmBuy.calls.calls[2];
    assert.deepEqual([fmCurveBuy.to, BigInt(fmCurveBuy.value)], [TM2, 16n * E18 / 100n], 'four.meme\'s TokenManager2, sent exactly the least BNB the swap delivers');
    const fb = lp.TOKEN_MANAGER.decodeFunctionData('buyTokenAMAP', fmCurveBuy.data);
    assert.deepEqual([fb[0].toLowerCase(), fb[1], fb[2]], [FM, 16n * E18 / 100n, 16_000_000n * 99n / 100n], 'its token, that BNB, and the curve\'s minimum after 1% slippage');

    // Paid in BNB: no swap to carry the fee, so 99% buys on the curve and 1% is its own transfer to the fee wallet, after the buy.
    await assert.rejects(proposals.propose(account, { chain: 'bsc', side: 'buy', token: FM, base: 'BNB', amount_usd: 60 }), /holds 0\.0 BNB of the 0\.1 BNB this buy needs/);
    chain.native = 2n * E18;
    const nb = seen.length;
    const bnbBuy = await proposals.approve(account, (await proposals.propose(account, { chain: 'bsc', side: 'buy', token: FM, base: 'BNB', amount_usd: 60 })).id); // $60 at $600 = 0.1 BNB
    assert.equal(seen.length, nb, 'no 0x swap for a buy paid in BNB');
    assert.deepEqual(bnbBuy.calls.calls.map(c => c.step), ['swap', 'fee']);
    const [bnbCurveBuy, bnbFee] = bnbBuy.calls.calls;
    assert.deepEqual([bnbCurveBuy.to, BigInt(bnbCurveBuy.value)], [TM2, E18 / 10n * 99n / 100n], '99% of the BNB to four.meme\'s TokenManager2');
    const bb = lp.TOKEN_MANAGER.decodeFunctionData('buyTokenAMAP', bnbCurveBuy.data);
    assert.deepEqual([bb[1], bb[2]], [E18 / 10n * 99n / 100n, 9_900_000n * 99n / 100n], 'that BNB, and the minimum after 1% slippage');
    assert.deepEqual([bnbFee.to, BigInt(bnbFee.value), bnbFee.data], [FEE_WALLET, E18 / 10n / 100n, '0x'], '1% of the BNB, a plain transfer to the fee wallet, after the buy');
    assert.deepEqual([bnbBuy.plan.summary.fee.asset, bnbBuy.plan.summary.fee.pct, bnbBuy.plan.summary.fee.usd], ['BNB', 1, 0.6]);
    assert.match(bnbBuy.plan.summary.fee.taken_by, /separate transfer/);
    await assert.rejects(proposals.propose(account, { chain: 'bsc', side: 'buy', token: FM, base: 'WBNB', amount_usd: 60 }), /pay with BNB, USDT or USDC/);
    const bnbPlan = { chain: 'bsc', side: 'buy', token: FM, wallet, quote: {}, route: { kind: 'fourmeme_curve', token_manager: TM2, pay: 'bnb', funds: '990', min_out: '1', fee_bps: 100, fee_amount: '10', fee_recipient: FEE_WALLET } };
    assert.equal(wc(bnbPlan).calls.length, 2);
    assert.throws(() => wc({ ...bnbPlan, route: { ...bnbPlan.route, fee_recipient: '0x' + 'ba'.repeat(20) } }), /fee RektBull doesn't charge/);
    assert.throws(() => wc({ ...bnbPlan, route: { ...bnbPlan.route, fee_amount: '11' } }), /fee RektBull doesn't charge/, 'more than 1% of the total');

    // Selling for BNB: four.meme's own contract pays RektBull's 1% from the sale, in the same call.
    chain.balances[FM] = 32_000_000n * E18 + 123n; // not a whole multiple of 10^9 units: the sale is rounded down to one (four.meme refuses others)
    let n = seen.length;
    const fmSell = await proposals.approve(account, (await proposals.propose(account, { chain: 'bsc', side: 'sell', token: FM, base: 'BNB', sell_fraction: 0.5 })).id);
    assert.equal(seen.length, n, 'no 0x swap for a sale into BNB');
    assert.deepEqual(fmSell.calls.calls.map(c => c.step), ['approve', 'swap']);
    const [fmApprove, fmCurveSell] = fmSell.calls.calls;
    assert.deepEqual([fmApprove.to, ERC20.decodeFunctionData('approve', fmApprove.data)[0].toLowerCase(), ERC20.decodeFunctionData('approve', fmApprove.data)[1]], [FM, TM2, 16_000_000n * E18], 'half the holding, approved to TokenManager2 only');
    const fs = lp.TOKEN_MANAGER.decodeFunctionData('sellToken(uint256,address,uint256,uint256,uint256,address)', fmCurveSell.data);
    const est = await lp.fourMemeSellQuote(FM, 16_000_000n * E18);
    assert.deepEqual([fs[0], fs[1].toLowerCase(), fs[2], fs[3], fs[4], fs[5].toLowerCase()], [0n, FM, 16_000_000n * E18, est.funds * 99n / 100n, 100n, FEE_WALLET], 'the BNB minimum after 1% slippage, and a 1% fee to RektBull\'s fee wallet');
    assert.deepEqual([fmSell.plan.summary.fee.asset, fmSell.plan.summary.fee.pct], ['BNB', 1]);
    const sure = BigInt(fmSell.plan.summary.min_buy_amount);
    assert.ok(sure < est.funds * 99n / 100n - est.funds * 99n / 100n / 100n, 'what the wallet is sure to get is the minimum less the most the fee can be');

    // Selling for USDT: the same sale, then the BNB swapped through 0x with no second fee.
    n = seen.length;
    const fmSellUsdt = await proposals.approve(account, (await proposals.propose(account, { chain: 'bsc', side: 'sell', token: FM, base: 'USDT', sell_fraction: 0.5 })).id);
    assert.deepEqual(fmSellUsdt.calls.calls.map(c => c.step), ['approve', 'swap', 'from_bnb']);
    const toUsdt = seen.at(-1).params;
    assert.deepEqual([toUsdt.sellToken, toUsdt.buyToken, toUsdt.swapFeeBps, BigInt(toUsdt.sellAmount)], [NATIVE, USDT, undefined, sure], 'no fee on the 0x leg; it sells only the BNB the sale is sure to deliver');
    assert.equal(seen.length - n, 2, 'one quote on proposing, one on approving');
    assert.equal(BigInt(fmSellUsdt.calls.calls[2].value), sure);

    // Not traded: priced in another token, an older four.meme contract, or a tampered route.
    fm = { ...fm, quote: '0x' + '20'.repeat(20), quote_symbol: 'QQQB' };
    await assert.rejects(proposals.propose(account, { chain: 'bsc', side: 'buy', token: FM, base: 'USDT', amount_usd: 100 }), /priced in QQQB, not BNB/);
    fm = { ...fm, quote: 'bnb', quote_symbol: 'BNB', version: 1, token_manager: '0xec4549cadce5da21df6e6422d448034b5233bfbc' };
    await assert.rejects(proposals.propose(account, { chain: 'bsc', side: 'sell', token: FM, base: 'BNB' }), /older four\.meme contract/);
    const fmPlan = { chain: 'bsc', side: 'sell', token: FM, wallet, quote: {}, route: { kind: 'fourmeme_curve', token_manager: TM2, amount: '1000000000', min_funds: '1', fee_bps: 100, fee_recipient: FEE_WALLET } };
    assert.equal(wc(fmPlan).calls.length, 2);
    assert.throws(() => wc({ ...fmPlan, route: { ...fmPlan.route, amount: '1000000001' } }), /whole multiples of 10\^9/, 'four.meme would refuse it (GW)');
    assert.throws(() => wc({ ...fmPlan, route: { ...fmPlan.route, token_manager: '0x' + 'ee'.repeat(20) } }), /doesn't use/);
    assert.throws(() => wc({ ...fmPlan, route: { ...fmPlan.route, fee_recipient: '0x' + 'ba'.repeat(20) } }), /fee RektBull doesn't charge/);
    assert.throws(() => wc({ ...fmPlan, route: { ...fmPlan.route, fee_bps: 500 } }), /fee RektBull doesn't charge/);

    // A four.meme token that graduated trades on PancakeSwap through 0x, with the full token check.
    risk = { verdict: 'low', flags: [], disagreements: [] };
    fm = { ...fm, version: 2, token_manager: TM2, state: 'graduated', curve: undefined };
    zeroex.setTransport(async (path, params) => { seen.push({ path, params }); const out = String(BigInt(params.sellAmount) * 99n / 100n); return { liquidityAvailable: true, sellAmount: params.sellAmount, buyAmount: out, minBuyAmount: out, transaction: { to: AH, data: '0xd00d', value: '0' } }; });
    const grad = await proposals.propose(account, { chain: 'bsc', side: 'buy', token: FM, base: 'USDT', amount_usd: 50 });
    assert.deepEqual(grad.plan.checks.map(c => c.check), ['launchpad', 'per_trade_amount', 'token_risk', 'tax', 'sell_back']);
    assert.match(grad.plan.checks[0].detail, /graduated .* PancakeSwap, through 0x/);
    await db.getPool().end();
  });
});
