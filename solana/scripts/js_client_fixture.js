#!/usr/bin/env node
/**
 * Transactions built and signed by the order service's own code
 * (src/trade/solanaOrderTx.js), for tests/js_client.rs to run against the
 * compiled program on LiteSVM. Every key here is a throwaway test key made
 * from a fixed seed (the user's is 32 bytes of 7, as in tests/orders.rs); none
 * controls anything on mainnet.
 *
 *   node solana/scripts/js_client_fixture.js   writes programs/rektbull-orders/tests/js_client.json
 *
 * test/solanaOrders.test.js checks the committed file matches what this
 * builds now, so the Rust test always runs today's code.
 */
const path = require('path');
const k = require('@solana/kit');
const op = require('../../src/trade/solanaOrderProgram');
const tx = require('../../src/trade/solanaOrderTx');
const { fromSeed } = require('../../src/trade/solanaExecutor');

const PROGRAM = 'CYiK4necGUc4CZZmGM9CALRAurATaE1qR3dc6UJoUAsZ'; // declare_id! in the program (a placeholder until deployment)
const FEE_WALLET = 'FeeWa11et1111111111111111111111111111111111'; // the program's FEE_WALLET (a placeholder too)
const NOW = 1_800_000_000; // the tests' clock
const SOL = 1_000_000_000n;
const MEME = 1_000_000n; // one coin, 6 decimals
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi'; // any 32 bytes: the test chain doesn't check it
const ROUTE = Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]); // Jupiter's `route`: the stand-in exchange sits at Jupiter's address

async function build() {
  const user = fromSeed(Buffer.alloc(32, 7));
  const exec = fromSeed(Buffer.alloc(32, 9));
  const meme = fromSeed(Buffer.alloc(32, 11)).address; // a mint at a fixed address
  const [vault] = await k.getProgramDerivedAddress({ programAddress: k.address(op.P.jupiter), seeds: [Buffer.from('vault')] });
  const userMeme = await op.ataOf(user.address, op.P.token, meme);
  const vaultMeme = await op.ataOf(vault, op.P.token, meme);
  const vaultWsol = await op.ataOf(vault, op.P.token, op.WSOL);
  const transit = await op.transitOf(PROGRAM, user.address);
  const [transitMeme, transitWsol] = [await op.ataOf(transit, op.P.token, meme), await op.ataOf(transit, op.P.token, op.WSOL)];
  const signers = { user, exec };

  const signed = async (payer, instructions, who) => {
    const c = tx.compile({ payer, instructions, blockhash: BLOCKHASH, lastValidBlockHeight: 1000 });
    let wire = c.transaction;
    let t = c.tx;
    for (const s of who) {
      const sig = await signers[s].sign(c.messageBytes);
      wire = tx.withSignature(t, signers[s].address, sig);
      t = { ...t, signatures: { ...t.signatures, [k.address(signers[s].address)]: Uint8Array.from(sig) } };
    }
    return { tx: wire, bytes: c.bytes };
  };

  const place = async (nonce, amountIn, minOut, approveAmount) => {
    const p = await tx.placeInstructions({
      program: PROGRAM, owner: user.address, executor: exec.address, nonce, token: meme, tokenProgram: op.P.token, decimals: 6,
      source: userMeme, approveAmount, amountIn, minOut, validUntil: NOW + 86400, units: 100_000,
    });
    return { order: p.order, ...(await signed(user.address, p.instructions, ['user'])) };
  };
  // A sale through the stand-in exchange, paid in wrapped SOL to transit's wrapped-SOL account, as Jupiter pays.
  const sale = async (order, amountIn, wsolOut) => {
    const data = Buffer.concat([ROUTE, Buffer.from([0]), (() => { const b = Buffer.alloc(16); b.writeBigUInt64LE(amountIn, 0); b.writeBigUInt64LE(wsolOut, 8); return b; })()]);
    const swap = {
      programId: op.P.jupiter, data: data.toString('base64'),
      accounts: [
        { pubkey: transit, isSigner: true, isWritable: true }, { pubkey: transitMeme, isSigner: false, isWritable: true }, { pubkey: meme, isSigner: false, isWritable: false },
        { pubkey: vaultMeme, isSigner: false, isWritable: true }, { pubkey: vaultWsol, isSigner: false, isWritable: true }, { pubkey: op.WSOL, isSigner: false, isWritable: false },
        { pubkey: transitWsol, isSigner: false, isWritable: true }, { pubkey: vault, isSigner: false, isWritable: false },
        { pubkey: op.P.token, isSigner: false, isWritable: false }, { pubkey: op.P.token, isSigner: false, isWritable: false },
      ],
    };
    const f = await tx.fillInstructions({ program: PROGRAM, executor: exec.address, owner: user.address, order, token: meme, tokenProgram: op.P.token, source: userMeme, feeWallet: FEE_WALLET, swap, amountIn, units: 400_000, microLamports: 1000 });
    return signed(exec.address, f.instructions, ['exec']);
  };
  const net = out => out - op.feeOf(out);
  // A limit buy: the user's SOL wrapped and approved; the stand-in exchange takes wrapped SOL and pays the coin to transit.
  const userWsol = await op.ataOf(user.address, op.P.token, op.WSOL);
  const feeWsol = await op.ataOf(FEE_WALLET, op.P.token, op.WSOL);
  const placeBuy = async (nonce, amountIn, minOut) => {
    const p = await tx.placeBuyInstructions({ program: PROGRAM, owner: user.address, executor: exec.address, nonce, token: meme, tokenProgram: op.P.token, amountIn, minOut, validUntil: NOW + 86400, wrapLamports: amountIn, approveAmount: amountIn, units: 150_000 });
    return { order: p.order, ...(await signed(user.address, p.instructions, ['user'])) };
  };
  const buy = async (order, amountIn, memeOut) => {
    const swapIn = tx.buySwapAmount(amountIn);
    const data = Buffer.concat([ROUTE, Buffer.from([0]), (() => { const b = Buffer.alloc(16); b.writeBigUInt64LE(swapIn, 0); b.writeBigUInt64LE(memeOut, 8); return b; })()]);
    const swap = {
      programId: op.P.jupiter, data: data.toString('base64'),
      accounts: [
        { pubkey: transit, isSigner: true, isWritable: true }, { pubkey: transitWsol, isSigner: false, isWritable: true }, { pubkey: op.WSOL, isSigner: false, isWritable: false },
        { pubkey: vaultWsol, isSigner: false, isWritable: true }, { pubkey: vaultMeme, isSigner: false, isWritable: true }, { pubkey: meme, isSigner: false, isWritable: false },
        { pubkey: transitMeme, isSigner: false, isWritable: true }, { pubkey: vault, isSigner: false, isWritable: false },
        { pubkey: op.P.token, isSigner: false, isWritable: false }, { pubkey: op.P.token, isSigner: false, isWritable: false },
      ],
    };
    const f = await tx.fillInstructions({ side: 'buy', program: PROGRAM, executor: exec.address, owner: user.address, order, token: meme, tokenProgram: op.P.token, source: userWsol, feeWallet: FEE_WALLET, swap, amountIn, units: 400_000, microLamports: 1000 });
    return signed(exec.address, f.instructions, ['exec']);
  };
  const third = await placeBuy(3n, SOL, 900n * MEME);
  const usedForFee = tx.buySwapAmount(SOL);
  const buyFee = usedForFee * 100n / 9900n;

  const first = await place(1n, 100_000n * MEME, 9n * SOL / 10n, 100_000n * MEME);
  const second = await place(2n, 10_000n * MEME, SOL / 10n, 110_000n * MEME);
  const cancel = await signed(user.address, tx.cancelInstructions({ program: PROGRAM, owner: user.address, order: second.order }), ['user']);
  return {
    about: 'Built by solana/scripts/js_client_fixture.js from src/trade/solanaOrderTx.js; run by tests/js_client.rs. Test keys only.',
    program: PROGRAM, fee_wallet: FEE_WALLET, now: NOW, user: user.address, executor: exec.address, transit, meme, vault,
    setup: {
      mints: [{ address: meme, decimals: 6 }, { address: op.WSOL, decimals: 9 }],
      token_accounts: [
        { address: userMeme, mint: meme, owner: user.address, amount: String(1_000_000n * MEME) },
        { address: vaultMeme, mint: meme, owner: vault, amount: String(10_000n * MEME) },
        { address: vaultWsol, mint: op.WSOL, owner: vault, amount: String(100n * SOL) },
      ],
      lamports: [{ address: user.address, lamports: String(10n * SOL) }, { address: exec.address, lamports: String(10n * SOL) }, { address: FEE_WALLET, lamports: String(SOL) }],
    },
    steps: [
      { name: 'the user places a stop-loss: 100,000 coins for at least 0.9 SOL, and approves the delegate for them', ...first, expect: 'ok', checks: [{ order: first.order, exists: true }, { address: userMeme, delegated: String(100_000n * MEME) }] },
      { name: 'a fill of half below the user\'s price is refused onchain', ...(await sale(first.order, 50_000n * MEME, 4n * SOL / 10n)), expect: 'BelowLimit', checks: [{ address: userMeme, token_delta: '0' }] },
      {
        name: 'the executor fills half: 0.5 SOL, 1% to the fee wallet, the rest to the user as SOL', ...(await sale(first.order, 50_000n * MEME, 5n * SOL / 10n)), expect: 'ok',
        checks: [{ address: user.address, lamports_delta: String(net(5n * SOL / 10n)) }, { address: FEE_WALLET, lamports_delta: String(op.feeOf(5n * SOL / 10n)) }, { address: userMeme, token_delta: String(-50_000n * MEME) }, { address: transit, lamports: '0' }, { order: first.order, filled_in: String(50_000n * MEME) }],
      },
      {
        name: 'the executor fills the rest: the order closes and its rent goes back to the user', ...(await sale(first.order, 50_000n * MEME, 6n * SOL / 10n)), expect: 'ok',
        checks: [{ address: user.address, lamports_delta: String(net(6n * SOL / 10n)), plus_order_rent: true }, { address: userMeme, token_delta: String(-50_000n * MEME) }, { order: first.order, exists: false }, { address: transitMeme, exists: false }, { address: transitWsol, exists: false }],
      },
      { name: 'a second order (its approval covers what is left of every open order)', ...second, expect: 'ok', checks: [{ order: second.order, exists: true }, { address: userMeme, delegated: String(110_000n * MEME) }] },
      { name: 'the user cancels it: the order is gone and its rent is back (less the network fee)', ...cancel, expect: 'ok', checks: [{ order: second.order, exists: false }, { address: user.address, lamports_delta: '-5000', plus_order_rent: true }] },
      { name: 'a cancelled order can\'t be filled', ...(await sale(second.order, 10_000n * MEME, SOL)), expect: 'AccountNotInitialized', checks: [{ address: userMeme, token_delta: '0' }] },
      { name: 'a limit buy: 1 SOL wrapped and approved, for at least 900 coins', ...third, expect: 'ok', checks: [{ order: third.order, exists: true }, { address: userWsol, token_delta: String(SOL), delegated: String(SOL) }] },
      { name: 'a buy that brings fewer coins than the user\'s limit is refused onchain', ...(await buy(third.order, SOL, 800n * MEME)), expect: 'BelowLimit', checks: [{ address: userWsol, token_delta: '0' }, { address: userMeme, token_delta: '0' }] },
      {
        name: 'the executor fills the buy: the coins to the user, 1% of the SOL the exchange used to the fee wallet in wrapped SOL', ...(await buy(third.order, SOL, 1000n * MEME)), expect: 'ok',
        checks: [{ address: userMeme, token_delta: String(1000n * MEME) }, { address: userWsol, token_delta: String(-(usedForFee + buyFee)) }, { address: feeWsol, token_delta: String(buyFee) }, { address: transit, lamports: '0' }, { order: third.order, exists: false }, { address: transitMeme, exists: false }, { address: transitWsol, exists: false }],
      },
    ],
  };
}

const OUT = path.join(__dirname, '../programs/rektbull-orders/tests/js_client.json');
const text = async () => `${JSON.stringify(await build(), null, 2)}\n`;

if (require.main === module) {
  text().then(t => { require('fs').writeFileSync(OUT, t); console.log(`wrote ${OUT}`); }).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { build, text, OUT };
