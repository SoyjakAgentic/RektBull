/**
 * Sign in with a Solana wallet, and linking an EVM and a Solana wallet to one
 * account. The signature check runs without a database; the flows run
 * against a real Postgres when TEST_DATABASE_URL is set.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
// Before anything reads the settings (src/config/env.js reads them once, on first require).
Object.assign(process.env, { JWT_SECRET: 'test-secret', NEW_WALLET_CHECK_CHAINS: '', ...(DB ? { DATABASE_URL: DB } : {}) });
const base58 = require('../src/lib/base58');
const siws = require('../src/auth/siws');

/** A Solana keypair, as a wallet holds it: the base58 address and a signer of messages. */
function solanaWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const address = base58.encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  return { address, sign: text => crypto.sign(null, Buffer.from(text, 'utf8'), privateKey) };
}

test('base58: round trips, leading zeros, and only canonical 32-byte addresses', () => {
  for (const hex of ['', '00', '0000ff', 'ff00', '00'.repeat(32), crypto.randomBytes(32).toString('hex')]) {
    const b = Buffer.from(hex, 'hex');
    assert.deepEqual(base58.decode(base58.encode(b)), b, hex);
  }
  assert.equal(base58.encode(Buffer.alloc(32)), '11111111111111111111111111111111', 'the System Program');
  assert.ok(base58.isSolanaAddress('So11111111111111111111111111111111111111112'));
  assert.ok(base58.isSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'));
  assert.ok(!base58.isSolanaAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'), 'an EVM address');
  assert.ok(!base58.isSolanaAddress('So1111111111111111111111111111111111111111'), '31 bytes');
  assert.ok(!base58.isSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1O'), 'O is not in the alphabet');
  assert.ok(!base58.isSolanaAddress(null));
});

test('Sign In With Solana: the exact message, signed by that wallet only, in base64 or base58', () => {
  const w = solanaWallet();
  const other = solanaWallet();
  const message = siws.buildMessage({ address: w.address, nonce: 'abc', issuedAt: new Date('2026-11-15T00:00:00Z'), expiresAt: new Date('2026-11-15T00:10:00Z'), domain: 'rektbull.com', uri: 'https://rektbull.com' });
  assert.equal(message.split('\n')[0], 'rektbull.com wants you to sign in with your Solana account:');
  assert.equal(message.split('\n')[1], w.address);
  assert.match(message, /\nChain ID: mainnet\n/);
  assert.match(message, /does not move funds or approve anything/);
  const sig = w.sign(message);
  assert.ok(siws.signedBy(message, sig.toString('base64'), w.address), 'base64, as browsers send it');
  assert.ok(siws.signedBy(message, base58.encode(sig), w.address), 'base58, as Solana tools print it');
  assert.ok(!siws.signedBy(message + ' ', sig.toString('base64'), w.address), 'a changed message');
  assert.ok(!siws.signedBy(message, other.sign(message).toString('base64'), w.address), 'another wallet\'s signature');
  assert.ok(!siws.signedBy(message, sig.toString('base64'), other.address), 'checked against the wrong address');
  assert.ok(!siws.signedBy(message, sig.subarray(0, 63).toString('base64'), w.address), 'a short signature');
  assert.ok(!siws.signedBy(message, 'not a signature', w.address));
  assert.ok(!siws.signedBy(message, sig.toString('base64'), '0x' + 'ab'.repeat(20)), 'an EVM address');
});

test('accounts: sign in with Solana or EVM, link the other, unlink, and EVM-only features ask for an EVM wallet', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());
  // No network: a Solana wallet with one transaction (so not "new" for free points).
  const rpc = require('../src/providers/rpc');
  const realSolanaRpc = rpc.solanaRpc;
  rpc.solanaRpc = async method => (method === 'getSignaturesForAddress' ? [{ signature: 'x' }] : null);
  t.after(() => { rpc.solanaRpc = realSolanaRpc; });

  const { createApp } = require('../src/app');
  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const solSign = async (w, kind = 'sign-in', token = null) => {
    const ch = await call(token, 'POST', kind === 'link' ? '/v1/auth/link/nonce' : '/v1/auth/nonce', { kind: 'solana', address: w.address });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    return { ch: ch.body, signature: w.sign(ch.body.message).toString('base64') };
  };

  // ── Sign in with a Solana wallet ──
  const sol = solanaWallet();
  assert.equal((await call(null, 'POST', '/v1/auth/nonce', { kind: 'solana', address: '0x' + 'ab'.repeat(20) })).status, 400, 'not a Solana address');
  assert.equal((await call(null, 'POST', '/v1/auth/nonce', { kind: 'tron', address: sol.address })).status, 400, 'unknown kind');
  const first = await solSign(sol);
  assert.match(first.ch.message, /Sign in to RektBull\./);
  assert.equal((await call(null, 'POST', '/v1/auth/verify', { challenge_id: first.ch.challenge_id, signature: solanaWallet().sign(first.ch.message).toString('base64') })).status, 401, 'another wallet\'s signature');
  const signedIn = await call(null, 'POST', '/v1/auth/verify', { challenge_id: first.ch.challenge_id, signature: first.signature });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  assert.deepEqual([signedIn.body.account.wallet, signedIn.body.account.solana_wallet], [null, sol.address]);
  assert.equal((await call(null, 'POST', '/v1/auth/verify', { challenge_id: first.ch.challenge_id, signature: first.signature })).status, 401, 'a challenge works once');
  let token = signedIn.body.token;
  const accountId = signedIn.body.account.id;

  // The same wallet again: the same account.
  const again = await solSign(sol);
  assert.equal((await call(null, 'POST', '/v1/auth/verify', { challenge_id: again.ch.challenge_id, signature: again.signature })).body.account.id, accountId);

  // A Solana-only account: the account works, EVM-only features say what's missing.
  const me = await call(token, 'GET', '/v1/me');
  assert.equal(me.status, 200);
  assert.deepEqual([me.body.account.wallet, me.body.account.solana_wallet], [null, sol.address]);
  assert.equal(me.body.points.allowance, 30, 'a Solana wallet with history gets the full allowance');
  for (const [m, p] of [['POST', '/v1/trading/preview'], ['POST', '/v1/trading/trades'], ['GET', '/v1/trading/auto/setup?chain=base'], ['POST', '/v1/yield/auto/permissions']]) {
    const r = await call(token, m, p, m === 'GET' ? undefined : {});
    assert.equal(r.status, 409, `${m} ${p}`);
    assert.equal(r.body.error, 'evm_wallet_required');
  }
  assert.equal((await call(token, 'GET', '/v1/trading/positions')).status, 200, 'reading by account still works');
  assert.equal((await call(token, 'POST', '/v1/auth/unlink', { kind: 'solana' })).status, 409, 'the only wallet can\'t be unlinked');

  // ── Link an EVM wallet ──
  const evm = ethers.Wallet.createRandom();
  const evmLink = await call(token, 'POST', '/v1/auth/link/nonce', { kind: 'evm', address: evm.address, chain_id: 8453 });
  assert.equal(evmLink.status, 200);
  assert.match(evmLink.body.message, /Link this wallet to your RektBull account\./);
  // A link challenge can't be used to sign in, and a sign-in challenge can't link.
  assert.equal((await call(null, 'POST', '/v1/auth/verify', { challenge_id: evmLink.body.challenge_id, signature: await evm.signMessage(evmLink.body.message) })).status, 401, 'a link challenge is not a sign-in');
  const plain = await call(null, 'POST', '/v1/auth/nonce', { address: evm.address, chain_id: 8453 });
  assert.equal((await call(token, 'POST', '/v1/auth/link/verify', { challenge_id: plain.body.challenge_id, signature: await evm.signMessage(plain.body.message) })).status, 401, 'a sign-in challenge doesn\'t link');
  assert.equal((await call(null, 'POST', '/v1/auth/link/nonce', { kind: 'evm', address: evm.address })).status, 401, 'linking needs a sign-in');
  const evmLink2 = await call(token, 'POST', '/v1/auth/link/nonce', { kind: 'evm', address: evm.address, chain_id: 8453 });
  const linked = await call(token, 'POST', '/v1/auth/link/verify', { challenge_id: evmLink2.body.challenge_id, signature: await evm.signMessage(evmLink2.body.message) });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.deepEqual([linked.body.account.id, linked.body.account.wallet, linked.body.account.solana_wallet], [accountId, evm.address.toLowerCase(), sol.address]);
  // The old session reads the wallets as stored now: EVM features pass the wallet check.
  assert.notEqual((await call(token, 'POST', '/v1/trading/preview', {})).status, 409, 'the old token sees the linked wallet');
  token = linked.body.token;

  // Signing in with the linked EVM wallet reaches the same account.
  const evmIn = await call(null, 'POST', '/v1/auth/nonce', { address: evm.address, chain_id: 8453 });
  const evmSession = await call(null, 'POST', '/v1/auth/verify', { challenge_id: evmIn.body.challenge_id, signature: await evm.signMessage(evmIn.body.message) });
  assert.equal(evmSession.body.account.id, accountId);
  assert.equal(evmSession.body.account.solana_wallet, sol.address);

  // ── Accounts aren't merged, and an account has one wallet of each kind ──
  const someoneElse = solanaWallet();
  const theirs = await solSign(someoneElse);
  const theirSession = await call(null, 'POST', '/v1/auth/verify', { challenge_id: theirs.ch.challenge_id, signature: theirs.signature });
  assert.notEqual(theirSession.body.account.id, accountId);
  const steal = await solSign(sol, 'link', theirSession.body.token);
  const stolen = await call(theirSession.body.token, 'POST', '/v1/auth/link/verify', { challenge_id: steal.ch.challenge_id, signature: steal.signature });
  assert.equal(stolen.status, 409, 'another account\'s wallet can\'t be linked');
  const second = solanaWallet();
  const two = await solSign(second, 'link', token);
  const twice = await call(token, 'POST', '/v1/auth/link/verify', { challenge_id: two.ch.challenge_id, signature: two.signature });
  assert.equal(twice.status, 409, 'one Solana wallet per account');
  // A link challenge is only for the account that asked for it.
  const mine = await solSign(second, 'link', token);
  assert.equal((await call(theirSession.body.token, 'POST', '/v1/auth/link/verify', { challenge_id: mine.ch.challenge_id, signature: mine.signature })).status, 401);

  // ── Unlink, then link another ──
  const unlinked = await call(token, 'POST', '/v1/auth/unlink', { kind: 'solana' });
  assert.equal(unlinked.status, 200);
  assert.equal(unlinked.body.account.solana_wallet, null);
  token = unlinked.body.token;
  const relink = await solSign(second, 'link', token);
  const relinked = await call(token, 'POST', '/v1/auth/link/verify', { challenge_id: relink.ch.challenge_id, signature: relink.signature });
  assert.equal(relinked.status, 200);
  assert.equal(relinked.body.account.solana_wallet, second.address);
  // The unlinked wallet signs in to a new account of its own.
  const back = await solSign(sol);
  assert.notEqual((await call(null, 'POST', '/v1/auth/verify', { challenge_id: back.ch.challenge_id, signature: back.signature })).body.account.id, accountId);

  // ── Blocking either wallet blocks the account ──
  await require('../src/admin/settings').set(`blocked:${second.address.toLowerCase()}`, { at: new Date().toISOString(), reason: 'test' }, { wallet: '0xadmin', action: 'block', reason: 'test' });
  const blockedIn = await call(null, 'POST', '/v1/auth/nonce', { address: evm.address, chain_id: 8453 });
  const refused = await call(null, 'POST', '/v1/auth/verify', { challenge_id: blockedIn.body.challenge_id, signature: await evm.signMessage(blockedIn.body.message) });
  assert.equal(refused.status, 403, 'signing in with the EVM wallet of an account whose Solana wallet is blocked');
});
