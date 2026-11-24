/**
 * Fills straight on pump.fun's curve (src/trade/pumpCurve.js, and the order
 * service's choice of route in solanaOrders.js): the accounts in pump.fun's
 * IDL order, derived as it says (checked against mainnet's own addresses), the
 * instructions' data, and the service's routing: direct while the coin is on a
 * SOL curve, a floor the curve can't meet told to the user with nothing sent,
 * and Jupiter when the direct fill fails for another reason or the curve has
 * completed. tests/pump_js.rs runs the same transactions against pump.fun's
 * real program (with mainnet copies, by hand).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const k = require('@solana/kit');

const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, { DATABASE_URL: DB || '', JWT_SECRET: 'test-secret' });
const env = require('../src/config/env');
const op = require('../src/trade/solanaOrderProgram');
const pc = require('../src/trade/pumpCurve');
const ex = require('../src/trade/solanaExecutor');
const { encode: b58 } = require('../src/lib/base58');

const MINT = '7eqEsqApWXXytb9UdUMGTJ5XFZDtoDCHmAodChwDpump'; // a pump.fun coin (Token-2022)
const TRANSIT = 'BzXqSX5xqFwSDzSVquo82jv25uytJP5s5N1BBA5kEpzf';
const enc = k.getAddressEncoder();
const sha8 = s => crypto.createHash('sha256').update(s).digest().subarray(0, 8);

test('pump.fun\'s fixed addresses are mainnet\'s, and the v3 accounts follow its IDL', async () => {
  const f = await pc.fixed();
  // As a live mainnet v3 trade named them (24 November 2026).
  assert.deepEqual(f, { global: '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf', eventAuthority: 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1', feeConfig: '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt' });
  assert.equal(await op.bondingCurveOf(MINT), 'FAS3zdxa4LExPJvN3LYuFH6AZtJVwFbnQQw9VpGV8jVo');
  const real = pc.buybackRecipient;
  pc.buybackRecipient = async () => 'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL';
  try {
    const accts = await pc.accounts({ mint: MINT, tokenProgram: op.P.token2022, trader: TRANSIT });
    assert.equal(accts.length, 17);
    assert.deepEqual(accts.map(a => a.pubkey).slice(0, 7), [f.global, MINT, op.WSOL, op.P.token2022, op.P.token, 'FAS3zdxa4LExPJvN3LYuFH6AZtJVwFbnQQw9VpGV8jVo', 'FCGoyJjEcLTwvND4M3os1zouL7MsqbbDGeB8h7CHwZFW']);
    assert.deepEqual([accts[8].pubkey, accts[8].isSigner], [TRANSIT, true], 'transit is the trader (the order program signs for it)');
    assert.equal(accts[11].pubkey, await op.volumeOf(op.P.pumpFun, TRANSIT));
    assert.deepEqual(accts.slice(12).map(a => a.pubkey), [f.feeConfig, 'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL', op.P.system, f.eventAuthority, op.P.pumpFun]);
    const sell = await pc.sellSwap({ mint: MINT, tokenProgram: op.P.token2022, trader: TRANSIT, amount: 5n, minSol: 7n });
    const d = Buffer.from(sell.data, 'base64');
    assert.ok(d.subarray(0, 8).equals(sha8('global:sell_v3')));
    assert.deepEqual([d.readBigUInt64LE(8), d.readBigUInt64LE(16), d.length], [5n, 7n, 24]);
    const buy = Buffer.from((await pc.buySwap({ mint: MINT, tokenProgram: op.P.token2022, trader: TRANSIT, spend: 9n, minTokens: 3n })).data, 'base64');
    assert.ok(buy.subarray(0, 8).equals(sha8('global:buy_exact_quote_in_v3')));
    assert.deepEqual([buy.readBigUInt64LE(8), buy.readBigUInt64LE(16), buy[24], buy.length], [9n, 3n, 0, 25], 'partial_fill: false');
  } finally { pc.buybackRecipient = real; }
});

test('Global\'s buyback recipients and a curve\'s state, read from their data', () => {
  const g = Buffer.alloc(1100);
  const a1 = 'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL';
  g.set(enc.encode(a1), pc.BUYBACK_AT);
  g.set(enc.encode(TRANSIT), pc.BUYBACK_AT + 32 * 3); // an empty one between is skipped
  assert.deepEqual(pc.buybackRecipients(g), [a1, TRANSIT]);
  const cv = Buffer.alloc(150);
  cv.writeBigUInt64LE(551653670140102n, 8); cv.writeBigUInt64LE(58351828248n, 16); cv[48] = 0;
  assert.deepEqual(pc.curveState(cv), { virtualToken: 551653670140102n, virtualQuote: 58351828248n, realToken: 0n, realQuote: 0n, complete: false, quoteMint: '11111111111111111111111111111111' });
  cv[48] = 1;
  assert.equal(pc.curveState(cv).complete, true);
  assert.equal(pc.buySpend(100_000_000n), 98_000_000n, '99%, less 0.001 SOL of headroom');
});

test('the order service fills straight on the curve while the coin is on it; below the floor nothing is sent; else Jupiter', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  const PROGRAM = 'CYiK4necGUc4CZZmGM9CALRAurATaE1qR3dc6UJoUAsZ';
  const FEE_WALLET = 'FeeWa11et1111111111111111111111111111111111';
  const user = ex.fromSeed(Buffer.alloc(32, 7));
  const exec = ex.fromSeed(Buffer.alloc(32, 9));
  const saved = { ...env };
  Object.assign(env, { solanaOrdersEnabled: true, solanaOrdersProgramId: PROGRAM, solanaOrdersExecutor: exec.address, solanaOrdersFeeWallet: FEE_WALLET, devSolanaExecutorKey: Buffer.alloc(32, 9).toString('hex'), kmsSolanaExecutorKeyVersion: '', nodeEnv: 'test' });
  ex._reset();
  const rpc = require('../src/providers/rpc');
  const jupiter = require('../src/providers/jupiter');
  const realRpc = rpc.solanaRpc; const realBuild = jupiter.build;
  t.after(async () => { rpc.solanaRpc = realRpc; jupiter.build = realBuild; Object.assign(env, saved); ex._reset(); await db.getPool().end(); });

  const orders = require('../src/trade/solanaOrders');
  const transit = await op.transitOf(PROGRAM, user.address);
  const source = await op.ataOf(user.address, op.P.token2022, MINT);
  const delegate = await op.delegateOf(PROGRAM);
  const { rows: [{ id: acct }] } = await db.query('INSERT INTO accounts (solana_wallet) VALUES ($1) RETURNING id', [user.address]);
  const place = await op.placeOrder({ program: PROGRAM, owner: user.address, nonce: 1n, executor: exec.address, inputMint: MINT, outputMint: op.WSOL, outputNative: true, amountIn: 1_000_000_000n, minAmountOut: 500_000_000n, validUntil: 9e9 });
  const { rows: [row] } = await db.query(
    `INSERT INTO solana_orders (account_id, owner, order_address, program, nonce, kind, token, symbol, token_program, decimals, source, amount_in, min_out, trigger_out, ref_out, executor, valid_until, state, triggered_at)
     VALUES ($1, $2, $3, $4, 1, 'stop_loss', $5, 'PUMPY', $6, 6, $7, 1000000000, 500000000, 800000000, 1000000000, $8, now() + interval '1 day', 'triggered', now()) RETURNING *`,
    [acct, user.address, place.order, PROGRAM, MINT, op.P.token2022, source, exec.address]);

  // The stand-in chain: the order, the user's approved coins, the live curve, Global, the volume account (set up).
  const b64 = b => [Buffer.from(b).toString('base64'), 'base64'];
  const d = Buffer.from(place.instruction.data);
  const orderData = Buffer.concat([op.DISC.order, Buffer.from(enc.encode(user.address)), d.subarray(16, 48), d.subarray(48, 80), d.subarray(80, 112), d.subarray(112, 113), d.subarray(113, 129), Buffer.alloc(8), d.subarray(129, 145), d.subarray(8, 16), Buffer.from([255])]);
  const tokenAcct = Buffer.alloc(165); tokenAcct.set(enc.encode(MINT), 0); tokenAcct.set(enc.encode(user.address), 32); tokenAcct.writeBigUInt64LE(2_000_000_000n, 64); tokenAcct.writeUInt32LE(1, 72); tokenAcct.set(enc.encode(delegate), 76); tokenAcct.writeBigUInt64LE(1_000_000_000n, 121);
  const curve = Buffer.alloc(150); curve.writeBigUInt64LE(551653670140102n, 8); curve.writeBigUInt64LE(58351828248n, 16);
  const global = Buffer.alloc(1100); global.set(enc.encode('GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL'), pc.BUYBACK_AT);
  const chain = new Map([
    [place.order, { owner: PROGRAM, data: b64(orderData) }], [source, { owner: op.P.token2022, data: b64(tokenAcct) }],
    [await op.bondingCurveOf(MINT), { owner: op.P.pumpFun, data: b64(curve) }], [(await pc.fixed()).global, { owner: op.P.pumpFun, data: b64(global) }],
    [await op.volumeOf(op.P.pumpFun, transit), { owner: op.P.pumpFun, data: b64(Buffer.alloc(137)) }],
  ]);
  const sent = [];
  let simErr = null;
  const sims = [];
  rpc.solanaRpc = async (method, params) => {
    if (method === 'getMultipleAccounts') return { value: params[0].map(a => chain.get(a) || null) };
    if (method === 'getLatestBlockhash') return { value: { blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', lastValidBlockHeight: 500 } };
    if (method === 'getGenesisHash') return 'devnet';
    if (method === 'getRecentPrioritizationFees') return [];
    if (method === 'simulateTransaction') { sims.push(params[0]); const e = simErr; simErr = null; return { value: e ? { err: { InstructionError: [2, { Custom: 1 }] }, logs: e, unitsConsumed: 0 } : { err: null, unitsConsumed: 90000, logs: [] } }; }
    if (method === 'sendTransaction') { sent.push(params[0]); return 'ok'; }
    throw new Error(`unexpected ${method}`);
  };
  const jupiterCalls = [];
  jupiter.build = async () => { jupiterCalls.push(1); throw Object.assign(new Error('no route (stand-in)'), { isJupiter: true }); };
  const decodeIxs = base64 => {
    const tx = k.getTransactionDecoder().decode(Buffer.from(base64, 'base64'));
    const m = k.getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    return m.instructions.map(i => ({ program: m.staticAccounts[i.programAddressIndex], accounts: (i.accountIndices || []).map(x => m.staticAccounts[x]), data: Buffer.from(i.data || []) }));
  };
  const cfg = orders.config();
  const execSigner = await ex.executor({ rpc });
  const fresh = async () => (await db.query('SELECT * FROM solana_orders WHERE id = $1', [row.id])).rows[0];

  // 1. On the curve: filled straight on it (sell_v3), without asking Jupiter.
  await orders._attempt(await fresh(), cfg, execSigner);
  assert.equal(sent.length, 1);
  assert.equal(jupiterCalls.length, 0, 'Jupiter not asked');
  const fill = decodeIxs(sent[0]).find(i => i.program === PROGRAM);
  assert.equal(fill.accounts[16], op.P.pumpFun, 'the venue: pump.fun');
  const venueData = fill.data.subarray(8 + 8 + 1 + 4);
  assert.ok(venueData.subarray(0, 8).equals(sha8('global:sell_v3')));
  assert.equal(venueData.readBigUInt64LE(8), 1_000_000_000n);
  assert.equal(venueData.readBigUInt64LE(16), (500_000_000n * 10000n + 9899n) / 9900n, 'pump.fun\'s own minimum leaves the user their floor after the 1%');
  assert.equal(fill.accounts[10], PROGRAM, 'no transit_out (left out, as Anchor\'s None): pump.fun pays SOL, not wrapped SOL');
  assert.equal(fill.accounts.length, 18 + 17, 'the order program\'s 18 accounts and pump.fun\'s 17');
  const { rows: [f1] } = await db.query('SELECT route FROM solana_order_fills');
  assert.equal(f1.route, 'pump.fun curve (direct)');

  // 2. The curve can't meet the floor (pump.fun's slippage check in the simulation): nothing sent, the user told.
  await db.query(`UPDATE solana_order_fills SET state = 'failed'`);
  simErr = ['Program log: AnchorError thrown in programs/pump/src/trade_v3.rs:1148. Error Code: TooLittleSolReceived. Error Number: 6003.'];
  await orders._attempt(await fresh(), cfg, execSigner);
  assert.equal(sent.length, 1, 'nothing sent below the floor');
  assert.match((await fresh()).last_error, /^below the floor \(pump\.fun curve \(direct\)/);
  const { rows: alerts } = await db.query(`SELECT title, detail FROM monitor_alerts`);
  assert.equal(alerts[0].title, 'Stop-loss on PUMPY: it can\'t fill at your floor');
  assert.match(alerts[0].detail.reasons[0].text, /would sell for about [\d.]+ SOL, below your floor of 0\.5 SOL after the fee/);

  // 3. A direct fill that fails for another reason: Jupiter is asked in the same attempt.
  simErr = ['Program log: Error: something else'];
  await orders._attempt(await fresh(), cfg, execSigner);
  assert.equal(jupiterCalls.length, 1, 'fell back to Jupiter');
  assert.match((await fresh()).last_error, /no route: no route \(stand-in\)/);

  // 4. The curve completed (the coin moved to PumpSwap): Jupiter only.
  curve[48] = 1;
  chain.set(await op.bondingCurveOf(MINT), { owner: op.P.pumpFun, data: b64(curve) });
  await orders._attempt(await fresh(), cfg, execSigner);
  assert.equal(jupiterCalls.length, 2);
  assert.equal(sent.length, 1);
  assert.ok(sims.length >= 3);
});
