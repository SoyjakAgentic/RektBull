#!/usr/bin/env node
/**
 * The order service's direct pump.fun curve fills (src/trade/pumpCurve.js and
 * solanaOrderTx.js), built and signed in Node for tests/pump_js.rs to run
 * against pump.fun's real program (copied by scripts/pump_fixtures.py into
 * fixtures/pump/, not committed). Test keys only: the user's is 32 bytes of 7,
 * the executor's 32 bytes of 9.
 *
 *   python3 -I scripts/pump_fixtures.py && node scripts/pump_js_fixture.js
 *   cargo test -p rektbull-orders --test pump_js -- --ignored
 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '../fixtures/pump');
const c = JSON.parse(fs.readFileSync(path.join(DIR, 'curves.json'), 'utf8')).v3;
const read = name => JSON.parse(fs.readFileSync(path.join(DIR, `v3_${name}.json`), 'utf8'));
const k = require('@solana/kit');
const op = require('../../src/trade/solanaOrderProgram');
const tx = require('../../src/trade/solanaOrderTx');
const pc = require('../../src/trade/pumpCurve');
const { fromSeed } = require('../../src/trade/solanaExecutor');
pc.buybackRecipient = async () => c.buyback_fee_recipient; // the one copied (the others aren't in the copies)

const PROGRAM = 'CYiK4necGUc4CZZmGM9CALRAurATaE1qR3dc6UJoUAsZ';
const FEE_WALLET = 'FeeWa11et1111111111111111111111111111111111';
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';
const SOL = 1_000_000_000n;

(async () => {
  const user = fromSeed(Buffer.alloc(32, 7));
  const exec = fromSeed(Buffer.alloc(32, 9));
  const keys = { user, exec };
  const mint = c.base_mint;
  const tokenProgram = c.base_token_program;
  const now = c.block_time;
  const transit = await op.transitOf(PROGRAM, user.address);
  const userCoin = await op.ataOf(user.address, tokenProgram, mint);
  const userWsol = await op.ataOf(user.address, op.P.token, op.WSOL);
  const signed = async (payer, instructions, who) => {
    const cmp = tx.compile({ payer, instructions, blockhash: BLOCKHASH, lastValidBlockHeight: 1000 });
    let t = cmp.tx;
    for (const s of who) t = { ...t, signatures: { ...t.signatures, [k.address(keys[s].address)]: Uint8Array.from(await keys[s].sign(cmp.messageBytes)) } };
    return { tx: k.getBase64EncodedWireTransaction(t), bytes: cmp.bytes };
  };
  // The curve now, for sizes: what 0.1 SOL buys, at most (the stop-loss sells well under it).
  const curve = pc.curveState(Buffer.from(read('bonding_curve').data, 'base64'));
  const spend = pc.buySpend(SOL / 10n);
  const grossTokens = curve.virtualToken * spend / (curve.virtualQuote + spend);
  const sellAmount = grossTokens / 2n;

  const steps = [];
  // 1. The user's one-time setup: pump.fun's volume account for their order address, paid by them.
  steps.push({ name: 'the one-time setup: pump.fun\'s volume account for the user\'s order address, paid by them', ...(await signed(user.address, [await op.initVolume({ venue: op.P.pumpFun, payer: user.address, user: transit })], ['user'])), expect: 'ok' });
  // 2. A limit buy: 0.1 SOL wrapped and approved, for at least 1 unit (the price check is the program's).
  const buyOrder = await tx.placeBuyInstructions({ program: PROGRAM, owner: user.address, executor: exec.address, nonce: 1n, token: mint, tokenProgram, amountIn: SOL / 10n, minOut: 1n, validUntil: now + 3600, wrapLamports: SOL / 10n, approveAmount: SOL / 10n, units: 200_000 });
  steps.push({ name: 'a limit buy: 0.1 SOL wrapped and approved', ...(await signed(user.address, buyOrder.instructions, ['user'])), expect: 'ok' });
  // 3. Filled straight on the curve (buy_exact_quote_in_v3), the SOL unwrapped for it, 1% in SOL.
  const buySwap = await pc.buySwap({ mint, tokenProgram, trader: transit, spend, minTokens: 1n });
  const buyFill = await tx.fillInstructions({ side: 'buy', unwrapIn: true, wrappedOut: false, program: PROGRAM, executor: exec.address, owner: user.address, order: buyOrder.order, token: mint, tokenProgram, source: userWsol, feeWallet: FEE_WALLET, swap: buySwap, amountIn: SOL / 10n, units: 400_000 });
  steps.push({ name: 'the executor fills the buy straight on pump.fun\'s curve', ...(await signed(exec.address, buyFill.instructions, ['exec'])), expect: 'ok', checks: { coins_to_user: true, fee_sol: true } });
  // 4. A stop-loss on half of what the buy could bring, and its sale straight on the curve (sell_v3).
  const sell = await tx.placeInstructions({ program: PROGRAM, owner: user.address, executor: exec.address, nonce: 2n, token: mint, tokenProgram, decimals: 6, source: userCoin, approveAmount: sellAmount, amountIn: sellAmount, minOut: 1n, validUntil: now + 3600, units: 100_000 });
  steps.push({ name: 'a stop-loss on half of those coins', ...(await signed(user.address, sell.instructions, ['user'])), expect: 'ok' });
  const sellSwap = await pc.sellSwap({ mint, tokenProgram, trader: transit, amount: sellAmount, minSol: (1n * 10000n + 9899n) / 9900n });
  const sellFill = await tx.fillInstructions({ side: 'sell', wrappedOut: false, program: PROGRAM, executor: exec.address, owner: user.address, order: sell.order, token: mint, tokenProgram, source: userCoin, feeWallet: FEE_WALLET, swap: sellSwap, amountIn: sellAmount, units: 400_000 });
  steps.push({ name: 'the executor fills the stop-loss straight on pump.fun\'s curve: SOL to the user, 1% to the fee wallet', ...(await signed(exec.address, sellFill.instructions, ['exec'])), expect: 'ok', checks: { sol_to_user: true, fee_sol: true } });
  // 5. A stop-loss (on a quarter of what the buy could bring: the user still holds that) whose floor the curve can't meet: refused.
  const high = await tx.placeInstructions({ program: PROGRAM, owner: user.address, executor: exec.address, nonce: 3n, token: mint, tokenProgram, decimals: 6, source: userCoin, approveAmount: sellAmount / 2n, amountIn: sellAmount / 2n, minOut: 50n * SOL, validUntil: now + 3600, units: 100_000 });
  steps.push({ name: 'a stop-loss with a floor of 50 SOL', ...(await signed(user.address, high.instructions, ['user'])), expect: 'ok' });
  const highSwap = await pc.sellSwap({ mint, tokenProgram, trader: transit, amount: sellAmount / 2n, minSol: (50n * SOL * 10000n + 9899n) / 9900n });
  const highFill = await tx.fillInstructions({ side: 'sell', wrappedOut: false, program: PROGRAM, executor: exec.address, owner: user.address, order: high.order, token: mint, tokenProgram, source: userCoin, feeWallet: FEE_WALLET, swap: highSwap, amountIn: sellAmount / 2n, units: 400_000 });
  steps.push({ name: 'its fill: pump.fun can\'t meet the floor, refused by its own slippage check', ...(await signed(exec.address, highFill.instructions, ['exec'])), expect: 'error', reason: 'TooLittleSolReceived' });

  const out = { about: 'Built by scripts/pump_js_fixture.js from the order service\'s own code; run by tests/pump_js.rs. Test keys only.', user: user.address, executor: exec.address, transit, user_coin: userCoin, steps };
  fs.writeFileSync(path.join(DIR, 'js_direct.json'), JSON.stringify(out, null, 1));
  console.log(steps.map(s => `${s.bytes} bytes: ${s.name}`).join('\n'));
})().catch(err => { console.error(err); process.exit(1); });
