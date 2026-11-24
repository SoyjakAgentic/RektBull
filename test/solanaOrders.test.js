/**
 * Orders on Solana (src/trade/solanaOrders.js): the order program's client
 * and transactions, the executor key, the order's terms and worst case, and
 * the whole path on the real database with a stand-in chain and Jupiter:
 * placed, confirmed from the chain, fired by its price, filled by the
 * executor (signed, checked, sent), confirmed from the program's event;
 * below the floor not sent; Meme Watch exits fired by its alerts; the
 * emergency stop; cancelling. The program itself runs the same transactions
 * in solana/programs/rektbull-orders/tests/js_client.rs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const k = require('@solana/kit');

const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, { DATABASE_URL: DB || '', JWT_SECRET: 'test-secret' });
const env = require('../src/config/env');
const op = require('../src/trade/solanaOrderProgram');
const otx = require('../src/trade/solanaOrderTx');
const ex = require('../src/trade/solanaExecutor');
const orders = require('../src/trade/solanaOrders');
const { encode: b58 } = require('../src/lib/base58');

const PROGRAM = 'CYiK4necGUc4CZZmGM9CALRAurATaE1qR3dc6UJoUAsZ';
const FEE_WALLET = 'FeeWa11et1111111111111111111111111111111111';
const SOL = 1_000_000_000n;
const sha8 = s => crypto.createHash('sha256').update(s).digest().subarray(0, 8);

test('the client speaks the program\'s layouts: instruction ids, the order account, the Filled event, the price and fee maths', async () => {
  assert.deepEqual(op.DISC.placeOrder, sha8('global:place_order'));
  assert.deepEqual(op.DISC.fill, sha8('global:fill'));
  assert.equal(op.ORDER_SPACE, 186, '8 + Order::INIT_SPACE');
  const user = ex.fromSeed(Buffer.alloc(32, 7)).address;
  assert.equal(user, 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB', 'the Rust tests\' user key');
  const { instruction, order } = await op.placeOrder({ program: PROGRAM, owner: user, nonce: 5n, executor: user, inputMint: op.WSOL, outputMint: FEE_WALLET, outputNative: false, amountIn: 7n, minAmountOut: 3n, validUntil: 99 });
  assert.equal(instruction.data.length, 8 + 8 + 32 * 3 + 1 + 8 * 4);
  assert.equal(order, await op.orderOf(PROGRAM, user, 5n));
  // An order account as the program writes it, read back.
  const acct = Buffer.concat([op.DISC.order, ...[user, user, op.WSOL, FEE_WALLET].map(a => Buffer.from(k.getAddressEncoder().encode(a))), Buffer.from([1]),
    ...[10n, 9n, 4n, 0n, 1234n, 5n].map(n => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; }), Buffer.from([254])]);
  assert.deepEqual(op.decodeOrder(acct), { owner: user, executor: user, inputMint: op.WSOL, outputMint: FEE_WALLET, outputNative: true, amountIn: 10n, minAmountOut: 9n, filledIn: 4n, validAfter: 0n, validUntil: 1234n, nonce: 5n, bump: 254 });
  assert.equal(op.decodeOrder(Buffer.alloc(186)), null, 'not an order');
  const ev = Buffer.concat([op.DISC.filled, Buffer.from(k.getAddressEncoder().encode(order)), Buffer.from(k.getAddressEncoder().encode(user)), ...[50n, 5n, 495n, 450n].map(n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; })]);
  assert.deepEqual(op.filledEvents(['Program log: x', `Program data: ${ev.toString('base64')}`]), [{ order, owner: user, amountIn: 50n, fee: 5n, delivered: 495n, minimum: 450n }]);
  // The user's price for part of an order rounds up, as the program's mul_div_ceil; the fee rounds down.
  assert.equal(op.minimumFor(1000n, 1n, 3n), 334n);
  assert.equal(op.minimumFor(1n, 1n, 1_000_000n), 1n);
  assert.equal(op.feeOf(99n), 0n);
  assert.equal(op.feeOf(SOL), SOL / 100n);
});

test('the transactions the program\'s own test runs are today\'s code (solana/programs/rektbull-orders/tests/js_client.json)', async () => {
  const fixture = require('../solana/scripts/js_client_fixture');
  assert.equal(fs.readFileSync(fixture.OUT, 'utf8'), await fixture.text(), 'rebuild it: node solana/scripts/js_client_fixture.js');
});

test('the executor key: KMS Ed25519 checked before use, a dev key only off mainnet and never in production', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const pem = publicKey.export({ format: 'pem', type: 'spki' });
  const calls = [];
  const client = (algorithm = 'EC_SIGN_ED25519', bad = false) => ({
    getPublicKey: async () => [{ pem, algorithm }],
    asymmetricSign: async ({ name, data }) => { calls.push(name); return [{ name, signature: bad ? Buffer.alloc(64, 1) : crypto.sign(null, data, privateKey) }]; },
  });
  const kms = await ex.fromKms('projects/p/locations/l/keyRings/r/cryptoKeys/executor/cryptoKeyVersions/1', client());
  assert.equal(kms.address, b58(raw));
  const msg = Buffer.from('a fill');
  assert.ok(crypto.verify(null, msg, publicKey, await kms.sign(msg)));
  await assert.rejects(ex.fromKms('v', client('EC_SIGN_SECP256K1_SHA256')), /not EC_SIGN_ED25519/);
  await assert.rejects((await ex.fromKms('v', client(undefined, true))).sign(msg), /doesn't verify/);

  const saved = { ...env };
  const user = () => ex.fromSeed(Buffer.alloc(32, 7)).address;
  try {
    Object.assign(env, { kmsSolanaExecutorKeyVersion: '', devSolanaExecutorKey: Buffer.alloc(32, 9).toString('hex'), solanaOrdersExecutor: '', databaseUrl: '' });
    ex._reset();
    await assert.rejects(ex.executor({ rpc: { solanaRpc: async () => ex.MAINNET_GENESIS } }), /only sign off mainnet/);
    ex._reset();
    Object.assign(env, { nodeEnv: 'production' });
    await assert.rejects(ex.executor({ rpc: { solanaRpc: async () => 'devnet' } }), /refused in production/);
    ex._reset();
    Object.assign(env, { nodeEnv: 'test', solanaOrdersExecutor: 'J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf' });
    assert.equal((await ex.executor({ rpc: { solanaRpc: async () => 'devnet' } })).address, 'J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf');
    ex._reset();
    Object.assign(env, { solanaOrdersExecutor: user() });
    await assert.rejects(ex.executor({ rpc: { solanaRpc: async () => 'devnet' } }), /users' orders name the latter/);
  } finally { Object.assign(env, saved); ex._reset(); }
});

test('an order\'s terms: the trigger, the floor after the 1% fee, and the worst case in plain words', () => {
  const s = { stop_loss_pct: 20, take_profit_pct: 50 };
  const stop = orders.terms('stop_loss', SOL, {}, s);
  assert.equal(stop.triggerOut, 8n * SOL / 10n, 'down 20%');
  assert.equal(stop.minOut, 65n * SOL / 100n - 65n * SOL / 10000n, 'the floor: down 35% by default, less the 1% fee');
  assert.throws(() => orders.terms('stop_loss', SOL, { stop_pct: 30, floor_pct: 25 }, s), /floor must be below your stop/);
  const take = orders.terms('take_profit', SOL, { take_pct: 100, slippage_pct: 5 }, s);
  assert.equal(take.triggerOut, 2n * SOL);
  assert.equal(take.minOut, 19n * SOL / 10n - 19n * SOL / 1000n);
  const exit = orders.terms('meme_watch_exit', SOL, {}, s);
  assert.equal(exit.triggerOut, null);
  assert.equal(exit.minOut, SOL / 2n - SOL / 200n, 'down 50% by default');
  const w = orders.worstCase({ kind: 'stop_loss', amountWhole: 1000, symbol: 'BULL', minOut: exit.minOut, validUntil: Date.UTC(2026, 11, 24) });
  assert.match(w[0], /Worst case, even if RektBull were hacked: your 1,000 BULL are sold for 0\.495 SOL after the 1% fee \(your floor\), at a moment RektBull picks before 2026-12-24, even if the market is higher then\./);
  assert.match(w[1], /only these coins/);
  assert.match(w[2], /can't fill below it: you keep the coins/);
});

test('off until set up: a plain reason, and nothing runs', async () => {
  const saved = { ...env };
  try {
    Object.assign(env, { solanaOrdersEnabled: false });
    assert.match(orders.config().off, /open once RektBull's order program has been audited and deployed/);
    assert.deepEqual(Object.keys(await orders.tick()), ['skipped']);
    Object.assign(env, { solanaOrdersEnabled: true, solanaOrdersProgramId: PROGRAM, solanaOrdersExecutor: '', solanaOrdersFeeWallet: FEE_WALLET });
    assert.match(orders.config().off, /SOLANA_ORDERS_EXECUTOR/);
  } finally { Object.assign(env, saved); }
});

/* ── The whole path, on the real database, with a stand-in chain and Jupiter ── */

const TOKEN = 'Ce9JBbxPQx2cAJjhFi9NEkmqGJGTVFBTHmYSGFTwpump';
const SEED_USER = Buffer.alloc(32, 7);
const SEED_EXEC = Buffer.alloc(32, 9);

/** A token account's 165 bytes. */
function tokenAccountData({ mint, owner, amount, delegate = null, delegated = 0n }) {
  const b = Buffer.alloc(165);
  const e = k.getAddressEncoder();
  b.set(e.encode(mint), 0); b.set(e.encode(owner), 32); b.writeBigUInt64LE(BigInt(amount), 64);
  if (delegate) { b.writeUInt32LE(1, 72); b.set(e.encode(delegate), 76); }
  b[108] = 1; b.writeBigUInt64LE(BigInt(delegated), 121);
  return b;
}
/** The instructions of a wire transaction: [{ program, accounts, data }]. */
function decodeTx(base64) {
  const t = k.getTransactionDecoder().decode(Buffer.from(base64, 'base64'));
  const m = k.getCompiledTransactionMessageDecoder().decode(t.messageBytes);
  return { t, m, ixs: m.instructions.map(i => ({ program: m.staticAccounts[i.programAddressIndex], accounts: (i.accountIndices || []).map(x => m.staticAccounts[x]), data: Buffer.from(i.data || []) })) };
}
/** The order account place_order would write, from its instruction. */
function orderFromPlace(ix) {
  const d = ix.data;
  const keyAt = at => d.subarray(at, at + 32);
  const owner = Buffer.from(k.getAddressEncoder().encode(ix.accounts[0]));
  return Buffer.concat([op.DISC.order, owner, keyAt(16), keyAt(48), keyAt(80), d.subarray(112, 113), d.subarray(113, 129), Buffer.alloc(8), d.subarray(129, 145), d.subarray(8, 16), Buffer.from([255])]);
}

test('orders on Solana, end to end: placed, confirmed, fired, filled by the executor, confirmed; below the floor; Meme Watch exits; the stop; cancelling', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  const user = ex.fromSeed(SEED_USER);
  const exec = ex.fromSeed(SEED_EXEC);
  const saved = { ...env };
  Object.assign(env, {
    solanaOrdersEnabled: true, solanaOrdersProgramId: PROGRAM, solanaOrdersExecutor: exec.address, solanaOrdersFeeWallet: FEE_WALLET,
    devSolanaExecutorKey: SEED_EXEC.toString('hex'), kmsSolanaExecutorKeyVersion: '', nodeEnv: 'test',
  });
  ex._reset();
  const rpc = require('../src/providers/rpc');
  const jupiter = require('../src/providers/jupiter');
  const dexscreener = require('../src/providers/dexscreener');
  const prices = require('../src/providers/prices');
  const orig = { rpc: rpc.solanaRpc, build: jupiter.build, quote: jupiter.quote, pairs: dexscreener.pairs, usd: prices.usdPrice };
  t.after(async () => {
    Object.assign(rpc, { solanaRpc: orig.rpc }); Object.assign(jupiter, { build: orig.build, quote: orig.quote });
    dexscreener.pairs = orig.pairs; prices.usdPrice = orig.usd; Object.assign(env, saved); ex._reset();
    await db.getPool().end();
  });

  const { rows: [{ id: acct }] } = await db.query(`INSERT INTO accounts (wallet, solana_wallet) VALUES ('0x${'ab'.repeat(20)}', $1) RETURNING id`, [user.address]);
  const account = { id: acct, wallet: `0x${'ab'.repeat(20)}`, solana_wallet: user.address };
  const source = await op.ataOf(user.address, op.P.token, TOKEN);
  const delegate = await op.delegateOf(PROGRAM);
  const transit = await op.transitOf(PROGRAM, user.address);

  // The stand-in chain: accounts by address, and what was sent.
  const chain = new Map();
  const put = (address, data, owner = op.P.token, lamports = 2_039_280) => chain.set(address, { data: [Buffer.from(data).toString('base64'), 'base64'], owner, lamports, executable: false });
  const mint = Buffer.alloc(82); mint[44] = 6; mint[45] = 1;
  put(TOKEN, mint);
  put(source, tokenAccountData({ mint: TOKEN, owner: user.address, amount: 1_000_000_000n })); // 1,000 coins
  const sent = [];
  let landed = null; // the Filled event the next confirmed fill shows
  let quoteNow = SOL; // what Jupiter would pay for all 1,000 coins
  rpc.solanaRpc = async (method, params) => {
    switch (method) {
      case 'getAccountInfo': return { value: params[0] === PROGRAM ? { executable: true, data: { parsed: { info: { programData: 'PD' } } } } : { data: { parsed: { info: { authority: null } } } } };
      case 'getGenesisHash': return 'devnet-genesis';
      case 'getMultipleAccounts': return { value: params[0].map(a => chain.get(a) || null) };
      case 'getLatestBlockhash': return { value: { blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', lastValidBlockHeight: 500 } };
      case 'getBlockHeight': return 400;
      case 'getRecentPrioritizationFees': return [{ prioritizationFee: 2000 }];
      case 'simulateTransaction': {
        const { ixs } = decodeTx(params[0]);
        const place = ixs.find(i => i.program === PROGRAM && i.data.subarray(0, 8).equals(op.DISC.placeOrder));
        return { value: { err: null, unitsConsumed: 60_000, logs: [], accounts: place ? [{ data: [orderFromPlace(place).toString('base64'), 'base64'] }] : [] } };
      }
      case 'sendTransaction': sent.push(params[0]); return 'ok';
      case 'getSignatureStatuses': return { value: params[0].map(() => ({ confirmationStatus: 'confirmed', err: null })) };
      case 'getTransaction': return { meta: { err: null, logMessages: landed ? [`Program data: ${landed.toString('base64')}`] : [] } };
      default: throw new Error(`unexpected RPC ${method}`);
    }
  };
  jupiter.quote = async ({ amount }) => quoteNow * BigInt(amount) / 1_000_000_000n;
  jupiter.build = async ({ inputMint, outputMint, amount, slippageBps, taker }) => {
    const out = quoteNow * BigInt(amount) / 1_000_000_000n;
    const data = Buffer.alloc(8 + 22); require('../src/trade/solana').ROUTE_V2.copy(data, 0);
    data.writeBigUInt64LE(BigInt(amount), 8); data.writeBigUInt64LE(out, 16); data.writeUInt16LE(slippageBps, 24);
    const acc = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
    return {
      outAmount: String(out), routePlan: [{ swapInfo: { label: 'PumpSwap' } }], addressesByLookupTableAddress: {},
      swapInstruction: { programId: op.P.jupiter, data: data.toString('base64'), accounts: [
        acc(taker, true, true), acc(await op.ataOf(taker, op.P.token, inputMint), false, true), acc(await op.ataOf(taker, op.P.token, outputMint), false, true),
        acc(inputMint), acc(outputMint), acc(op.P.token), acc(op.P.token), acc(op.P.jupiter), acc('D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf'), acc(op.P.jupiter),
      ] },
    };
  };
  let priceUsd = 0.15; // a coin's price: 1,000 coins = $150 = 1 SOL at $150
  dexscreener.pairs = async () => ({ [TOKEN]: { price_usd: priceUsd, symbol: 'BULL' } });
  prices.usdPrice = async () => 150;

  // 1. A stop-loss: the checks, the worst case, and a transaction for the user's wallet that places the order and approves only these coins.
  const p = await orders.prepare(account, { kind: 'stop_loss', token: TOKEN, stop_pct: 20, floor_pct: 40, days: 7 });
  assert.equal(p.order.state, 'prepared');
  assert.equal(p.order.trigger_sol, '0.8');
  assert.equal(p.order.floor_sol, '0.594', 'down 40%, less the 1% fee');
  assert.match(p.worst_case[0], /your 1,000 BULL are sold for 0\.594 SOL after the 1% fee \(your floor\)/);
  assert.equal(p.costs.order_deposit_sol, '0.00218544');
  const placed = decodeTx(p.solana.transaction);
  assert.deepEqual(Object.keys(placed.t.signatures), [user.address], 'only the user signs it');
  const approve = placed.ixs.find(i => i.program === op.P.token);
  assert.equal(approve.data[0], 13, 'ApproveChecked');
  assert.equal(approve.data.readBigUInt64LE(1), 1_000_000_000n, 'for exactly the coins this order sells');
  assert.equal(approve.accounts[2], delegate, 'to the program\'s delegate, nobody else');
  const placeIx = placed.ixs.find(i => i.program === PROGRAM);
  assert.equal(placeIx.accounts[1], p.order.order_address);
  assert.equal(Buffer.from(placeIx.data.subarray(16, 48)).equals(Buffer.from(k.getAddressEncoder().encode(exec.address))), true, 'it names RektBull\'s executor');

  // 2. The wallet sent it: confirmed from the chain.
  assert.equal((await orders.confirm(account, p.order.id)).waiting, true, 'not on the chain yet');
  put(p.order.order_address, orderFromPlace(placeIx), PROGRAM);
  put(source, tokenAccountData({ mint: TOKEN, owner: user.address, amount: 1_000_000_000n, delegate, delegated: 1_000_000_000n }));
  assert.equal((await orders.confirm(account, p.order.id)).state, 'open');

  // 3. The price falls past the trigger: it fires, and the executor fills it. The sale quotes below the floor first: nothing is sent.
  priceUsd = 0.11; // $110 of coins = 0.733 SOL: below the 0.8 SOL trigger
  quoteNow = 55n * SOL / 100n; // but Jupiter pays 0.55 SOL: below the 0.594 floor
  await orders.tick();
  let [row] = (await db.query('SELECT * FROM solana_orders WHERE id = $1', [p.order.id])).rows;
  assert.equal(row.state, 'triggered');
  assert.match(row.trigger_reason.source, /DexScreener/);
  assert.match(row.last_error, /below the floor/);
  assert.equal(sent.length, 0, 'nothing sent below the floor');
  const { rows: floorAlerts } = await db.query(`SELECT title FROM monitor_alerts WHERE kind = 'solana_order'`);
  assert.match(floorAlerts[0].title, /Stop-loss on BULL: it can't fill at your floor/);

  // The market comes back above the floor: the fill is built, checked, simulated, signed by the executor and sent.
  quoteNow = 70n * SOL / 100n;
  await db.query('UPDATE solana_orders SET next_attempt_at = now() WHERE id = $1', [p.order.id]);
  await orders.tick();
  assert.equal(sent.length, 1);
  const fill = decodeTx(sent[0]);
  assert.deepEqual(Object.keys(fill.t.signatures), [exec.address], 'the executor alone signs');
  assert.ok(crypto.verify(null, Buffer.from(fill.t.messageBytes), crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(k.getAddressEncoder().encode(exec.address))]), format: 'der', type: 'spki' }), Buffer.from(fill.t.signatures[exec.address])));
  const fillIx = fill.ixs.find(i => i.program === PROGRAM);
  assert.ok(fillIx.data.subarray(0, 8).equals(op.DISC.fill));
  assert.equal(fillIx.data.readBigUInt64LE(8), 1_000_000_000n, 'all of it: what\'s left, held and approved');
  assert.deepEqual(fillIx.accounts.slice(0, 6), [exec.address, p.order.order_address, user.address, delegate, transit, source]);
  assert.equal(fillIx.accounts[13], FEE_WALLET);
  assert.equal(fillIx.accounts[16], op.P.jupiter, 'the venue');
  const { rows: [f] } = await db.query('SELECT * FROM solana_order_fills');
  assert.equal(f.state, 'sent');
  const { rows: sigs } = await db.query(`SELECT signer, purpose FROM key_signatures`);
  assert.deepEqual(sigs, [{ signer: exec.address, purpose: `solana_fill:${p.order.id}` }], 'each signature logged first');

  // 4. It lands: the program's Filled event says what reached the user; the order is filled and the user told.
  const e = k.getAddressEncoder();
  landed = Buffer.concat([op.DISC.filled, Buffer.from(e.encode(p.order.order_address)), Buffer.from(e.encode(user.address)), ...[1_000_000_000n, 7_000_000n, 693_000_000n, 594_000_000n].map(n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; })]);
  chain.delete(p.order.order_address); // a filled order closes
  await orders.tick();
  [row] = (await db.query('SELECT * FROM solana_orders WHERE id = $1', [p.order.id])).rows;
  assert.equal(row.state, 'filled');
  assert.equal(row.delivered, '693000000');
  const mine = await orders.list(account);
  assert.equal(mine.orders[0].delivered_sol, '0.693');
  assert.equal(mine.orders[0].fills[0].state, 'confirmed');
  const { rows: soldAlerts } = await db.query(`SELECT title, detail FROM monitor_alerts WHERE kind = 'solana_order' ORDER BY id`);
  assert.equal(soldAlerts.at(-1).title, 'Stop-loss on BULL: sold');
  assert.match(soldAlerts.at(-1).detail.reasons[0].text, /^Sold 1,000 BULL for 0\.693 SOL, sent to your wallet \(RektBull's fee: 0\.007 SOL\)\.$/);

  // 5. A Meme Watch exit needs Meme Watch on; it fires on its critical alerts. With the emergency stop on, nothing is filled.
  await assert.rejects(orders.prepare(account, { kind: 'meme_watch_exit', token: TOKEN }), /Switch on Meme Watch/);
  await db.query(`INSERT INTO agent_settings (account_id, agent, enabled) VALUES ($1, 'meme_watch', true)`, [acct]);
  const mw = await orders.prepare(account, { kind: 'meme_watch_exit', token: TOKEN, floor_pct: 60 });
  const mwPlace = decodeTx(mw.solana.transaction).ixs.find(i => i.program === PROGRAM);
  put(mw.order.order_address, orderFromPlace(mwPlace), PROGRAM);
  await orders.confirm(account, mw.order.id);
  assert.equal(await orders.memeWatchSignal(TOKEN, { source: 'Meme Watch (the stream)', alert: 'BULL on solana: launch-bundle wallets are selling (40% of what they bought is gone)' }), 1);
  await require('../src/admin/stops').set('auto_trading', true, { wallet: 'admin', reason: 'test' });
  assert.deepEqual(await orders.tick(), { stopped: true });
  assert.equal(sent.length, 1, 'the stop holds every fill');
  await require('../src/admin/stops').set('auto_trading', false, { wallet: 'admin', reason: 'test' });

  // 6. Cancelling: the transaction closes the order and, being the last on that account, revokes the approval; then it's cancelled.
  const c = await orders.cancel(account, mw.order.id);
  assert.equal(c.revokes_approval, true);
  const cancelIxs = decodeTx(c.solana.transaction).ixs;
  assert.ok(cancelIxs[0].data.equals(op.DISC.cancelOrder));
  assert.deepEqual([cancelIxs[1].program, cancelIxs[1].data[0]], [op.P.token, 5], 'Revoke');
  chain.delete(mw.order.order_address);
  assert.equal((await orders.refresh(account, mw.order.id)).state, 'cancelled');

  // Download my data includes them.
  const data = await require('../src/privacy/myData').exportAll(account);
  assert.equal(data.solana_orders.length, 2);
});
