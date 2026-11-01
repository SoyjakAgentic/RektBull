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
const ROUTER_SEPOLIA = '0x9307067d6a5fc22d1085a2fb16b1385dcc0e6b68';

test('trading', async t => {
  const port = await rpcReady;
  Object.assign(process.env, {
    TRADING_ENABLED: 'true', SWAP_FEE_WALLET_EVM: FEE_WALLET, ZEROEX_API_KEY: 'test',
    RPC_URLS_BASE: `http://127.0.0.1:${port}`, TRADE_ROUTERS: JSON.stringify({ 84532: ROUTER_SEPOLIA }),
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
    await db.getPool().end();
  });
});
