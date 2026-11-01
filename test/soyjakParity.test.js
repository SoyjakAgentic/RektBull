/**
 * Soyjak's swap checks, run against RektBull (milestone 2's "done when").
 *
 * Each test names the soyjak-agentic test it mirrors
 * (backend/test/unit/swapTrading.test.js and swapGuards669.test.js).
 * Soyjak cases that don't apply here, and why:
 *   - Solana / Jupiter / Turnkey signing: Solana comes in milestone 5.
 *   - "no wallet on the chain": RektBull trades from the signed-in wallet.
 *   - the admin panel and the migration seeding: RektBull has env settings.
 *   - reservations in tradingCaps: limits are enforced onchain by the router
 *     (contracts/test/breakIt.test.js) and per trade off-chain (below).
 * Needs TEST_DATABASE_URL (the checks read the user's settings).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TOKEN = '0x' + '7a'.repeat(20);
const AH = '0x0000000000001ff3684f28c67538d4d072c22734';
const FEE_WALLET = '0x' + 'fe'.repeat(20);

test('Soyjak swap checks, on RektBull', { skip: !DB && 'set TEST_DATABASE_URL' }, async t => {
  // A fake Base node for balances and receipts.
  const chain = { balance: 0n, receipts: {} };
  const rpc = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => {
      const { method, params, id } = JSON.parse(b);
      const result = method === 'eth_call' ? ethers.toBeHex(chain.balance, 32) : method === 'eth_getTransactionReceipt' ? chain.receipts[params[0]] || null : null;
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  await new Promise(r => rpc.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { DATABASE_URL: DB, TRADING_ENABLED: 'true', SWAP_FEE_WALLET_EVM: FEE_WALLET, SWAP_FEE_BPS: '500', ZEROEX_API_KEY: 'test', RPC_URLS_BASE: `http://127.0.0.1:${rpc.address().port}` });

  const env = require('../src/config/env');
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(async () => { rpc.close(); await db.getPool().end(); });
  const rules = require('../src/trade/rules');
  const proposals = require('../src/trade/proposals');
  const positions = require('../src/trade/positions');
  const { walletCalls } = require('../src/trade/calls');
  const zeroex = require('../src/trade/zeroex');
  const dd = require('../src/services/dueDiligence');

  const wallet = '0x' + '11'.repeat(20);
  const { rows } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id', [wallet]);
  const account = { id: Number(rows[0].id), wallet };
  const buy = (extra = {}) => rules.prepare({ accountId: account.id, wallet, chain: 'base', side: 'buy', token: TOKEN, amountUsd: 100, ...extra });

  // 0x and the token check, scripted per test.
  let quoteOut; let backOut; let risk; let seen;
  const reset = () => {
    risk = { verdict: 'low', flags: [] };
    seen = [];
    quoteOut = p => ({ liquidityAvailable: true, sellAmount: p.sellAmount, buyAmount: '1000000', minBuyAmount: '990000', tokenMetadata: { buyToken: { buyTaxBps: '0', sellTaxBps: '0' } }, issues: { allowance: { spender: AH } }, transaction: { to: AH, data: '0xabcd', value: '0' } });
    backOut = p => ({ liquidityAvailable: true, sellAmount: p.sellAmount, buyAmount: String(BigInt(100e6) * 97n / 100n) });
  };
  dd.quickCheck = async () => risk;
  zeroex.setTransport(async (path, params) => {
    seen.push({ path, params });
    const sellingToken = params.sellToken.toLowerCase() === TOKEN;
    const out = sellingToken && path.endsWith('/price') ? backOut(params) : quoteOut(params);
    if (out instanceof Error) throw out;
    return out;
  });

  await t.test('swapGuards: trading switched on, a known chain, side, token and base', async () => {
    reset();
    env.tradingEnabled = false;
    await assert.rejects(buy(), /switched off/);
    env.tradingEnabled = true;
    await assert.rejects(buy({ chain: 'robinhood' }), /trading is available on: base/);
    await assert.rejects(buy({ side: 'hold' }), /side must be/);
    await assert.rejects(buy({ token: 'nope' }), /contract address/);
    await assert.rejects(buy({ base: 'DOGE' }), /base must be one of/);
    await assert.rejects(buy({ token: USDC }), /base asset itself/);
  });

  await t.test('swapGuards / swapTrading: a buy needs a passing token check, a route back, low taxes and a small round-trip loss', async () => {
    reset(); risk = { verdict: 'critical', flags: [{ severity: 'critical', title: 'honeypot' }] };
    await assert.rejects(buy(), /critical risk/);
    reset(); risk = { verdict: 'low', flags: [], incomplete: 'the sell test didn\'t run.' };
    await assert.rejects(buy(), /couldn't check whether this token can be sold/);
    reset(); quoteOut = p => ({ liquidityAvailable: true, sellAmount: p.sellAmount, buyAmount: '1', tokenMetadata: { buyToken: { sellTaxBps: '1500' } }, transaction: { to: AH, data: '0x' } });
    await assert.rejects(buy(), /15% tax, above your 10% limit/);
    reset(); backOut = () => ({ liquidityAvailable: false });
    await assert.rejects(buy(), /no route to sell this token back: it may be a honeypot/);
    reset(); backOut = p => ({ liquidityAvailable: true, sellAmount: p.sellAmount, buyAmount: String(BigInt(100e6) * 50n / 100n) });
    await assert.rejects(buy(), /would lose 50\.0%, above your 30% limit/);
    reset();
    const ok = await buy();
    assert.deepEqual(ok.checks.map(c => c.check), ['per_trade_amount', 'token_risk', 'tax', 'sell_back']);
  });

  await t.test('swapGuards: 0x has to find liquidity, simulate the trade, and see the funds', async () => {
    reset(); quoteOut = () => ({ liquidityAvailable: false });
    await assert.rejects(buy(), /no liquidity/);
    reset(); quoteOut = p => ({ liquidityAvailable: true, sellAmount: p.sellAmount, buyAmount: '1', issues: { simulationIncomplete: true }, transaction: { to: AH, data: '0x' } });
    await assert.rejects(buy(), /could not simulate/);
    reset(); quoteOut = p => ({ liquidityAvailable: true, sellAmount: p.sellAmount, buyAmount: '1', issues: { balance: { actual: '5', expected: '100000000' } }, transaction: { to: AH, data: '0x' } });
    await assert.rejects(buy(), /holds 5 of the 100000000/);
  });

  await t.test('swapTrading: a sell gets out: no due diligence, no per-trade amount, an approval for exactly the amount sold, then the swap', async () => {
    reset(); risk = { verdict: 'critical', flags: [{ severity: 'critical', title: 'honeypot' }] };
    chain.balance = 4000n;
    const plan = await rules.prepare({ accountId: account.id, wallet, chain: 'base', side: 'sell', token: TOKEN, sellFraction: 0.5 });
    assert.equal(plan.quote.sellAmount, 2000n);
    const calls = walletCalls(plan);
    assert.deepEqual(calls.calls.map(c => c.step), ['approve', 'swap']);
    assert.equal(calls.calls[0].to, TOKEN);
    const [, amount] = new ethers.Interface(['function approve(address,uint256)']).decodeFunctionData('approve', calls.calls[0].data);
    assert.equal(amount, 2000n, 'exactly the amount sold');
    chain.balance = 0n;
    await assert.rejects(rules.prepare({ accountId: account.id, wallet, chain: 'base', side: 'sell', token: TOKEN }), /holds none/);
  });

  await t.test('swapTrading: the fee is 1% of every trade in the base asset, inside the 0x swap, and never more than 1% even if set higher', async () => {
    reset();
    const plan = await buy();
    const q = seen.find(s => s.path.endsWith('/quote'));
    assert.equal(q.params.swapFeeBps, 100, 'SWAP_FEE_BPS=500 is capped at 1%');
    assert.equal(q.params.swapFeeRecipient, FEE_WALLET);
    assert.equal(q.params.swapFeeToken, USDC);
    assert.equal(plan.summary.fee.pct, 1, 'shown before the trade');
  });

  await t.test('swapTrading: the fee never blocks a trade: no fee wallet, no fee; 0x refusing it, the trade goes without it', async () => {
    reset();
    const saved = env.swapFeeWalletEvm;
    env.swapFeeWalletEvm = '';
    const noWallet = await buy();
    assert.equal(noWallet.summary.fee, null);
    assert.ok(!seen.some(s => s.params.swapFeeBps), 'no fee asked for');
    env.swapFeeWalletEvm = saved;
    reset();
    const refusing = quoteOut;
    quoteOut = p => (p.swapFeeBps ? Object.assign(new Error('bad fee'), { response: { status: 400, data: { reason: 'fee' } } }) : refusing(p));
    const withoutFee = await buy();
    assert.equal(withoutFee.summary.fee, null);
  });

  await t.test('swapTrading: approval is the default mode, and the slippage is bounded', async () => {
    const s = await rules.settingsFor(account.id);
    assert.equal(s.slippage_bps, 100);
    await assert.rejects(rules.saveSettings(account.id, { slippage_bps: 5000 }), /slippage_bps must be 10 to 1000/);
    // Automatic trading needs a permission the user signs; without one nothing can be queued.
    const autonomous = require('../src/trade/autonomous');
    await assert.rejects(autonomous.queue(account, { chain_id: 84532, side: 'buy', token: 'tWETH', amount_usd: 10 }), /no active automatic-trading permission/);
  });

  await t.test('§726: a trade sent but never seen onchain is marked failed, not resent', async () => {
    reset();
    const p = await proposals.propose(account, { chain: 'base', side: 'buy', token: TOKEN, amount_usd: 100 });
    await proposals.approve(account, p.id);
    await proposals.submitted(account, p.id, '0x' + 'cc'.repeat(32));
    await db.query(`UPDATE trade_proposals SET submitted_at = now() - interval '31 minutes' WHERE id = $1`, [p.id]);
    await positions.tick();
    const after = await proposals.get(account, p.id);
    assert.equal(after.status, 'failed');
    assert.match(after.error, /not seen onchain within 30 minutes/);
  });
});
