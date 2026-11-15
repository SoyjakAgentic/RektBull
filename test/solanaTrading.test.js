/**
 * Solana trades the user signs (trade/solana.js), on real Jupiter /build
 * responses recorded from mainnet (test/fixtures/jupiter, 15 November 2026:
 * a pump.fun curve buy and sale, and a four-hop shared-accounts route), with
 * the RPC, prices and RektBull's other checks played by stand-ins. The flow
 * through the API runs against Postgres when TEST_DATABASE_URL is set.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const DB = process.env.TEST_DATABASE_URL;
const FEE_WALLET = 'FeeWa11et1111111111111111111111111111111111';
Object.assign(process.env, {
  JWT_SECRET: 'test-secret', NEW_WALLET_CHECK_CHAINS: '', TRADING_ENABLED: 'true', SWAP_FEE_BPS: '100',
  SWAP_FEE_WALLET_SOLANA: FEE_WALLET, ...(DB ? { DATABASE_URL: DB } : {}),
});
const k = require('@solana/kit');
const solana = require('../src/trade/solana');
const jupiter = require('../src/providers/jupiter');
const rpc = require('../src/providers/rpc');

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'jupiter', `${name}.json`), 'utf8'));
const USER = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB'; // the taker the fixtures were built for (a test-only key)
const PUMP = '3QkTHofooopp7XkBDqjRDC2k1mbkG1d1QTdU8NDRpump';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const WSOL = solana.WSOL;
const OTHER = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TERMS = { 'buy-pump': [WSOL, PUMP, 9900000], 'sell-pump': [PUMP, WSOL, 353134691175], 'buy-shared': [WSOL, JUP, 99000000] };
const check = (b, name, over = {}) => { const [inputMint, outputMint, amount] = TERMS[name]; return solana.checkInstructions(b, { wallet: USER, inputMint, outputMint, amount, slippageBps: 100, ...over }); };
const refused = async (p, why) => assert.rejects(p, err => err.isTradeBlocked && err.message.includes(why), why);

/** Changes the swap's data in place: field at offset after the discriminator (and the shared route's id). */
function patchSwap(b, fn) {
  const d = Buffer.from(b.swapInstruction.data, 'base64');
  const o = d.subarray(0, 8).equals(solana.ROUTE_V2) ? 8 : 9;
  fn(d, o);
  b.swapInstruction.data = d.toString('base64');
}

test('Jupiter\'s instructions: both swap shapes read, and their terms', async () => {
  for (const name of Object.keys(TERMS)) {
    const b = fixture(name);
    const t = await check(b, name);
    assert.equal(t.quotedOut, BigInt(b.outAmount), name);
    assert.equal(t.minOut, BigInt(b.outAmount) * 9900n / 10000n, `${name}: 1% slippage`);
    assert.equal(t.slippageBps, 100);
    const dstMint = TERMS[name][1];
    assert.equal(t.destination, await solana.ata(USER, t.destinationProgram, dstMint), `${name}: the output goes to the user's own token account`);
  }
});

test('Jupiter\'s instructions: anything beyond the swap asked for is refused', async () => {
  const cases = [
    ['buy-pump', b => patchSwap(b, (d, o) => d.writeBigUInt64LE(1n, o)), 'a swap of 1'],
    ['buy-shared', b => patchSwap(b, (d, o) => d.writeBigUInt64LE(1n, o)), 'a swap of 1'],
    ['buy-pump', b => patchSwap(b, (d, o) => d.writeUInt16LE(5000, o + 16)), '50% slippage'],
    ['buy-pump', b => patchSwap(b, (d, o) => d.writeUInt16LE(100, o + 18)), 'a fee taken inside the swap'],
    ['buy-shared', b => patchSwap(b, (d, o) => d.writeUInt16LE(50, o + 20)), 'a fee taken inside the swap'],
    ['buy-pump', b => patchSwap(b, d => { d[0] ^= 1; }), 'a kind of Jupiter swap'],
    ['buy-pump', b => { b.swapInstruction.accounts[2].pubkey = OTHER; }, 'an account that isn\'t yours'],
    ['buy-shared', b => { b.swapInstruction.accounts[5].pubkey = OTHER; }, 'an account that isn\'t yours'],
    ['buy-pump', b => { b.swapInstruction.accounts[7].pubkey = OTHER; }, 'the output sent to another account'],
    ['buy-pump', b => { b.swapInstruction.accounts[4].pubkey = JUP; }, 'a swap of different tokens'],
    ['buy-pump', b => { b.swapInstruction.programId = 'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB'; }, 'a call to JUP4'],
    ['buy-pump', b => { b.otherInstructions.push({ programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', accounts: [], data: '' }); }, 'a call to Memo'],
    ['buy-pump', b => { b.setupInstructions.push({ programId: k.address('11111111111111111111111111111111'), accounts: [{ pubkey: USER, isSigner: true, isWritable: true }, { pubkey: OTHER, isSigner: false, isWritable: true }], data: Buffer.from('0200000040420f0000000000', 'hex').toString('base64') }); }, 'a SOL transfer other than wrapping'],
    ['buy-pump', b => { b.setupInstructions.push({ programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', accounts: [{ pubkey: OTHER, isSigner: false, isWritable: true }, { pubkey: OTHER, isSigner: false, isWritable: true }, { pubkey: USER, isSigner: true, isWritable: false }], data: Buffer.from('030100000000000000', 'hex').toString('base64') }); }, 'a token instruction'],
    ['buy-pump', b => { b.cleanupInstruction.accounts[1].pubkey = OTHER; }, 'a token instruction'],
    ['buy-pump', b => { b.setupInstructions[0].accounts[2].pubkey = OTHER; }, 'a token account for someone else'],
    ['buy-pump', b => { b.swapInstruction.accounts.push({ pubkey: OTHER, isSigner: true, isWritable: false }); }, 'a signer other than your wallet'],
    ['buy-pump', b => { b.tipInstruction = { programId: '11111111111111111111111111111111', accounts: [], data: '' }; }, 'a tip instruction'],
    ['buy-pump', b => { b.otherInstructions.push({ ...b.swapInstruction }); }, 'a second Jupiter instruction'],
    ['buy-pump', b => { b.outAmount = String(BigInt(b.outAmount) + 1n); }, 'doesn\'t match its quote'],
  ];
  for (const [name, change, why] of cases) {
    const b = fixture(name);
    change(b);
    await refused(check(b, name), why);
  }
  await refused(check(fixture('buy-pump'), 'buy-pump', { wallet: OTHER }), 'signer other than your wallet');
});

test('the lookup tables must hold, onchain, what Jupiter says they hold', async t => {
  stage(t);
  for (const name of Object.keys(TERMS)) await solana.checkLookupTables(fixture(name));
  const b = fixture('buy-shared');
  const [table] = Object.keys(b.addressesByLookupTableAddress);
  b.addressesByLookupTableAddress[table][3] = OTHER;
  await refused(solana.checkLookupTables(b), 'doesn\'t hold what Jupiter said');
  const c = fixture('buy-shared');
  c.addressesByLookupTableAddress['3JF3sEqM796hk5WFqA6EtmEwJQ9quALszsfJyvXNQKy3'] = [OTHER];
  await refused(solana.checkLookupTables(c), 'isn\'t one onchain');
});

test('the transaction: version 0, the user pays and signs, the fee transfer last, within 1,232 bytes', () => {
  for (const name of Object.keys(TERMS)) {
    const b = fixture(name);
    const out = solana.compose({ wallet: USER, b, fee: { wallet: FEE_WALLET, lamports: 99000n }, units: 300000, microLamports: 5000 });
    assert.ok(out.bytes <= 1232, `${name}: ${out.bytes} bytes`);
    const tx = k.getTransactionDecoder().decode(Buffer.from(out.transaction, 'base64'));
    const msg = k.getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    assert.equal(msg.version, 0);
    assert.equal(msg.header.numSignerAccounts, 1, `${name}: one signer`);
    assert.equal(msg.staticAccounts[0], USER, `${name}: the user pays`);
    const ixs = msg.instructions;
    const program = ix => msg.staticAccounts[ix.programAddressIndex];
    assert.equal(program(ixs[0]), 'ComputeBudget111111111111111111111111111111');
    assert.deepEqual([...ixs[0].data], [2, ...Buffer.from(Uint32Array.of(300000).buffer)], 'the compute limit');
    const last = ixs[ixs.length - 1];
    assert.equal(program(last), '11111111111111111111111111111111');
    assert.equal(Buffer.from(last.data).readUInt32LE(0), 2, 'a transfer');
    assert.equal(Buffer.from(last.data).readBigUInt64LE(4), 99000n);
    assert.equal(ixs.filter(ix => program(ix) === solana.P.jupiter).length, 1, `${name}: one Jupiter swap`);
    // Jupiter's own compute budget instructions are replaced by RektBull's: one limit, one price.
    assert.equal(ixs.filter(ix => program(ix) === 'ComputeBudget111111111111111111111111111111').length, 2);
  }
  const none = solana.compose({ wallet: USER, b: fixture('buy-pump'), fee: null, units: 300000, microLamports: 0 });
  const msg = k.getCompiledTransactionMessageDecoder().decode(k.getTransactionDecoder().decode(Buffer.from(none.transaction, 'base64')).messageBytes);
  assert.notEqual(msg.staticAccounts[msg.instructions[msg.instructions.length - 1].programAddressIndex], '11111111111111111111111111111111', 'no fee wallet: no transfer');
});

/* ── prepare(), with every outside call played by a stand-in ── */

/** The lookup tables in the recorded responses, as their accounts hold them onchain (a 56-byte header, then the addresses). */
const TABLES = {};
for (const name of Object.keys(TERMS)) {
  for (const [t, list] of Object.entries(fixture(name).addressesByLookupTableAddress)) {
    const enc = k.getAddressEncoder();
    TABLES[t] = { owner: 'AddressLookupTab1e1111111111111111111111111', data: [Buffer.concat([Buffer.alloc(56), ...list.map(a => Buffer.from(enc.encode(k.address(a))))]).toString('base64'), 'base64'] };
  }
}

/** A token account's raw data holding `amount` (the amount is at byte 64). */
const tokenData = amount => { const d = Buffer.alloc(165); d.writeBigUInt64LE(BigInt(amount), 64); return [d.toString('base64'), 'base64']; };

function stage(t, o = {}) {
  const state = { built: [], sims: 0, sent: [] };
  jupiter.setTransport(async (p, params) => {
    if (p === '/build') {
      state.built.push(params);
      const name = params.inputMint === WSOL ? 'buy-pump' : 'sell-pump';
      const b = fixture(name);
      assert.equal(params.amount, String(TERMS[name][2]), 'the amount the fixture was built for');
      return b;
    }
    if (p === '/order') return o.noRouteBack ? Promise.reject(Object.assign(new Error('no route'), { response: { status: 400, data: { error: 'no route' } } })) : { outAmount: String(o.back ?? 9600000) };
    throw new Error(`unexpected ${p}`);
  });
  const realRpc = rpc.solanaRpc;
  rpc.solanaRpc = async (method, params) => {
    if (method === 'getBalance') return { value: o.feeWalletLamports ?? 5_000_000 };
    if (method === 'getMultipleAccounts') {
      return { value: params[0].map(a => (TABLES[a] ? (o.tables?.[a] || TABLES[a]) : a === PUMP ? { owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', lamports: 1 }
        : a === USER ? { owner: '11111111111111111111111111111111', lamports: o.lamports ?? 1_000_000_000 }
          : o.held !== undefined ? { owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', lamports: 2039280, data: tokenData(o.held) } : null)) };
    }
    if (method === 'simulateTransaction') {
      state.sims++;
      state.sent.push(params[0]);
      if (o.simErr) return { value: { err: { InstructionError: [3, { Custom: 6001 }] }, logs: ['Program log: Error: slippage tolerance exceeded'] } };
      return { value: { err: null, unitsConsumed: 90000, accounts: [{ data: tokenData(o.delivered ?? 349604509500) }] } };
    }
    if (method === 'getRecentPrioritizationFees') return [{ prioritizationFee: 1000 }, { prioritizationFee: 50000 }, { prioritizationFee: 0 }];
    throw new Error(`unexpected ${method}`);
  };
  const prices = require('../src/providers/prices');
  const realPrice = prices.basePrice;
  prices.basePrice = async () => 100; // $100 a SOL: $1 is 0.01 SOL, 10,000,000 lamports
  const rules = require('../src/trade/rules');
  const realSettings = rules.settingsFor;
  rules.settingsFor = async () => ({ ...rules.DEFAULT_SETTINGS, ...(o.settings || {}) });
  const dd = require('../src/services/dueDiligence');
  const realQuick = dd.quickCheck;
  dd.quickCheck = async () => o.risk || { verdict: 'low', flags: [] };
  const launches = require('../src/services/launches');
  const realForTrade = launches.forTrade;
  launches.forTrade = async () => o.launch || { young: true, risk: 'ok', detail: 'no bundle found', flags: [] };
  t.after(() => { rpc.solanaRpc = realRpc; prices.basePrice = realPrice; rules.settingsFor = realSettings; dd.quickCheck = realQuick; launches.forTrade = realForTrade; });
  return state;
}
const buy = (extra = {}) => solana.prepare({ accountId: 1, wallet: USER, side: 'buy', token: PUMP, amountUsd: 1, ...extra });

test('a buy: 1% of the SOL to the fee wallet, 99% swapped, every check named, simulated', async t => {
  const st = stage(t);
  const p = await buy();
  assert.equal(p.chain, 'solana');
  assert.equal(p.base, 'SOL');
  assert.equal(p.summary.sell_amount, '10000000', 'all the SOL spent');
  assert.equal(st.built[0].amount, '9900000', '99% swapped');
  assert.equal(st.built[0].slippageBps, 100);
  assert.equal(st.built[0].taker, USER);
  assert.deepEqual([p.summary.fee.amount, p.summary.fee.pct, p.summary.fee.asset], ['0.0001', 1, 'SOL']);
  assert.equal(p.summary.buy_amount, '349604509500');
  assert.equal(p.summary.min_buy_amount, String(349604509500n * 9900n / 10000n));
  assert.deepEqual(p.checks.map(c => c.check), ['per_trade_amount', 'token_risk', 'bundle', 'route', 'sell_back', 'simulation']);
  assert.match(p.checks.find(c => c.check === 'sell_back').detail, /loses 4\.0%/);
  assert.equal(st.sims, 1);
  // What the wallet gets: the fee transfer of 100,000 lamports is the last instruction, to the fee wallet.
  const tx = k.getTransactionDecoder().decode(Buffer.from(p.solana.transaction, 'base64'));
  const msg = k.getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const last = msg.instructions[msg.instructions.length - 1];
  assert.equal(Buffer.from(last.data).readBigUInt64LE(4), 100000n);
  assert.equal(msg.staticAccounts[last.accountIndices[1]], FEE_WALLET);
  // The compute limit from the simulation (90,000 used, plus a fifth), and Fast's price: the 75th percentile, capped.
  assert.equal(p.solana.compute_units, 108000);
  assert.equal(p.summary.priority_fee.speed, 'standard');
});

test('a buy is refused on the checks, before anything reaches the wallet', async t => {
  await t.test('a critical finding', async t2 => { stage(t2, { risk: { verdict: 'critical', flags: [{ severity: 'critical', title: 'Its issuer can freeze any holder\'s tokens' }] } }); await refused(buy(), 'freeze'); });
  await t.test('sellability unknown', async t2 => { stage(t2, { risk: { verdict: 'incomplete', incomplete: 'Jupiter didn\'t answer.', flags: [] } }); await refused(buy(), 'couldn\'t check whether this token can be sold'); });
  await t.test('a bundled launch', async t2 => { stage(t2, { launch: { young: true, risk: 'block', flags: [{ severity: 'critical', title: 'Bundled and dumping' }] } }); await refused(buy(), 'Bundled and dumping'); });
  await t.test('a high risk needs the user\'s say-so', async t2 => {
    stage(t2, { risk: { verdict: 'high', flags: [{ id: 'mint_authority', severity: 'high', title: 'New tokens can still be minted' }] } });
    await assert.rejects(buy(), err => err.needsAcknowledgement && err.risks[0].id === 'mint_authority');
    const p = await buy({ acknowledgeRisks: true });
    assert.deepEqual(p.checks.find(c => c.check === 'token_risk').acknowledged, ['mint_authority']);
  });
  await t.test('a bundle check that couldn\'t run: a risk to confirm, and not shown as passed', async t2 => {
    stage(t2, { launch: { young: true, risk: 'unknown', detail: 'the data provider didn\'t answer', flags: [] } });
    await assert.rejects(buy(), err => err.needsAcknowledgement && err.risks[0].id === 'bundle_unchecked');
    const c = (await buy({ acknowledgeRisks: true })).checks.find(x => x.check === 'bundle');
    assert.equal(c.ok, false);
    assert.match(c.detail, /couldn't run .*you confirmed going ahead without it/);
  });
  await t.test('over the per-trade amount', async t2 => { stage(t2, { settings: { max_trade_usd: 0.5 } }); await refused(buy(), 'over your per-trade amount'); });
  await t.test('not enough SOL', async t2 => { stage(t2, { lamports: 15_000_000 }); await refused(buy(), 'plus about 0.01 SOL'); });
  await t.test('no route back: a honeypot', async t2 => { stage(t2, { noRouteBack: true }); await refused(buy(), 'no route to sell this token back'); });
  await t.test('selling straight back loses too much', async t2 => { stage(t2, { back: 5_000_000 }); await refused(buy(), 'would lose 50.0%'); });
  await t.test('the simulation fails', async t2 => { stage(t2, { simErr: true }); await refused(buy(), 'slippage tolerance exceeded'); });
  await t.test('the simulation delivers less than the minimum', async t2 => { stage(t2, { delivered: 1000 }); await refused(buy(), 'less than its minimum'); });
  await t.test('not a mint, or SOL itself', async t2 => { stage(t2); await refused(buy({ token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }), 'Solana mint address'); await refused(buy({ token: WSOL }), 'SOL itself'); await refused(buy({ base: 'USDC' }), 'base must be SOL'); });
});

test('a sale: Jupiter\'s minimum, less 1% of it to the fee wallet, from the sale itself', async t => {
  const st = stage(t, { held: 353134691175 });
  const p = await solana.prepare({ accountId: 1, wallet: USER, side: 'sell', token: PUMP, sellFraction: 1 });
  const minOut = 9746665n * 9900n / 10000n;
  const fee = minOut / 100n;
  assert.equal(st.built[0].amount, '353134691175', 'everything held');
  assert.equal(p.summary.min_buy_amount, String(minOut - fee), 'what the wallet is sure to get, after the fee');
  assert.equal(p.summary.fee.amount, String(Number(fee) / 1e9));
  assert.deepEqual(p.checks.map(c => c.check), ['sell', 'route', 'simulation'], 'a sale skips the buy checks');
  const msg = k.getCompiledTransactionMessageDecoder().decode(k.getTransactionDecoder().decode(Buffer.from(p.solana.transaction, 'base64')).messageBytes);
  const last = msg.instructions[msg.instructions.length - 1];
  assert.equal(Buffer.from(last.data).readBigUInt64LE(4), fee);
  await refused(solana.prepare({ accountId: 1, wallet: USER, side: 'sell', token: PUMP, sellFraction: 1.5 }), 'sell_fraction');
});

test('the fee wallet: none set, or not yet funded, means no fee, not a refused trade', async t => {
  stage(t, { feeWalletLamports: 1000 });
  const env = require('../src/config/env');
  const real = env.swapFeeWalletSolana;
  env.swapFeeWalletSolana = '3JF3sEqM796hk5WFqA6EtmEwJQ9quALszsfJyvXNQKy3'; // a new address: not cached
  t.after(() => { env.swapFeeWalletSolana = real; });
  // With no fee, everything spent is swapped: $0.99 is the 9,900,000 lamports the recorded route was built for.
  const unfunded = await buy({ amountUsd: 0.99 });
  assert.equal(unfunded.summary.fee, null);
  assert.equal(unfunded.summary.sell_amount, '9900000');
  env.swapFeeWalletSolana = '';
  assert.equal((await buy({ amountUsd: 0.99 })).summary.fee, null);
});

test('confirming a trade: the transaction\'s own token balances for the wallet and the mint', async t => {
  const realRpc = rpc.solanaRpc;
  t.after(() => { rpc.solanaRpc = realRpc; });
  const tb = (owner, mint, amount) => ({ owner, mint, uiTokenAmount: { amount: String(amount) } });
  rpc.solanaRpc = async (method, [sig]) => {
    assert.equal(method, 'getTransaction');
    if (sig === 'missing') return null;
    if (sig === 'failed') return { meta: { err: { InstructionError: [2, 'Custom'] } } };
    return { meta: { err: null, preTokenBalances: [tb(USER, PUMP, 5), tb(OTHER, PUMP, 100)], postTokenBalances: [tb(USER, PUMP, 1005), tb(OTHER, PUMP, 0)] } };
  };
  assert.equal(await solana.moved('missing', USER, PUMP), null);
  assert.deepEqual(await solana.moved('failed', USER, PUMP), { failed: true });
  assert.deepEqual(await solana.moved('ok', USER, PUMP), { amount: 1000n }, 'only this wallet\'s balance of this mint');
  assert.deepEqual(await solana.moved('ok', OTHER, PUMP), { amount: -100n });
  assert.ok(solana.isSignature('5'.repeat(88)));
  assert.ok(!solana.isSignature('0x' + 'ab'.repeat(32)));
});

test('through the API: Solana trades from the account\'s Solana wallet, previewed, sent, confirmed', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());
  stage(t);
  const { createApp } = require('../src/app');
  const { issueToken } = require('../src/auth/siwe');
  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const { rows: [sol] } = await db.query('INSERT INTO accounts (solana_wallet) VALUES ($1) RETURNING id, wallet, solana_wallet', [USER]);
  const { rows: [evm] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet, solana_wallet', ['0x' + 'ab'.repeat(20)]);
  const solToken = issueToken(sol);
  const trade = { chain: 'solana', side: 'buy', token: PUMP, amount_usd: 1 };

  assert.equal((await call(issueToken(evm), 'POST', '/v1/trading/preview', trade)).body.error, 'solana_wallet_required', 'an account with no Solana wallet');
  assert.equal((await call(solToken, 'POST', '/v1/trading/preview', { ...trade, chain: 'base', token: '0x' + 'cd'.repeat(20) })).body.error, 'evm_wallet_required', 'a Solana-only account on an EVM chain');
  const config = await call(null, 'GET', '/v1/trading/config');
  assert.deepEqual(config.body.chains.solana.bases, ['SOL']);

  const pv = await call(solToken, 'POST', '/v1/trading/preview', trade);
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.plan.summary.fee.amount, '0.0001');
  const made = await call(solToken, 'POST', '/v1/trading/trades', { ...trade, seen: pv.body.seen });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.calls.chain, 'solana');
  assert.ok(made.body.calls.transaction.length > 100);
  assert.equal(made.body.fees.speed, 'standard');
  const { rows: [row] } = await db.query('SELECT wallet, chain FROM trade_proposals WHERE id = $1', [made.body.id]);
  assert.deepEqual([row.wallet, row.chain], [USER, 'solana'], 'made from the Solana wallet, case kept');

  assert.equal((await call(solToken, 'POST', `/v1/trading/proposals/${made.body.id}/submitted`, { tx_hash: '0x' + 'ab'.repeat(32) })).status, 400, 'an EVM hash for a Solana trade');
  const sig = '3'.repeat(87);
  const sent = await call(solToken, 'POST', `/v1/trading/proposals/${made.body.id}/submitted`, { tx_hash: sig });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.tx_hash, sig, 'the signature as sent: base58 is case-sensitive');

  // The trade service confirms it from the transaction's token balances.
  rpc.solanaRpc = async method => {
    assert.equal(method, 'getTransaction');
    return { meta: { err: null, preTokenBalances: [], postTokenBalances: [{ owner: USER, mint: PUMP, uiTokenAmount: { amount: '349604509500' } }] } };
  };
  await require('../src/trade/positions').tick();
  const done = await call(solToken, 'GET', `/v1/trading/proposals/${made.body.id}`);
  assert.equal(done.body.status, 'confirmed');
  const pos = await call(solToken, 'GET', '/v1/trading/positions');
  assert.deepEqual(pos.body.positions.map(p => [p.chain, p.token, p.amount_raw, p.cost_usd]), [['solana', PUMP, '349604509500', 1]]);
});
