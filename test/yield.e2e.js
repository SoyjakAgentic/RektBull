/**
 * Yield proposals, end to end, on a local copy of Base mainnet: the real
 * Aave v3, Compound v3 and Spark sUSDC contracts, the RektBull API, moves
 * sent from the wallet (deposit, move, exit), the 0.1% fee read back from
 * the receipts, the risk watcher's warnings and its alerts.
 *
 * Market conditions change, so the rules' thresholds are relaxed here and
 * the move goes from whichever venue pays least to whichever pays most at
 * the fork block. Simulations run on the node and are rolled back.
 *
 *   TEST_DATABASE_URL=postgres://… node --test test/yield.e2e.js
 *   (BASE_MAINNET_RPC_URL to fork from your own endpoint)
 *
 * Not part of `npm test`: it starts a Hardhat node forking Base mainnet.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { ethers } = require('ethers');

const fs = require('fs');
const core = require('@metamask/delegation-core');
const { DELEGATOR_CONTRACTS } = require('@metamask/delegation-deployments');

const DB = process.env.TEST_DATABASE_URL;
const ROUTER_ARTIFACT = path.join(__dirname, '..', 'contracts', 'artifacts', 'contracts', 'RektBullYieldRouter.sol', 'RektBullYieldRouter.json');
const CONTRACTS = path.join(__dirname, '..', 'contracts');
const PORT = 8550;
const FORK = process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org';

function startNode() {
  return new Promise((resolve, reject) => {
    const node = spawn('npx', ['hardhat', '--network', 'default', 'node', '--port', String(PORT), '--fork', FORK, '--chain-id', '8453'], { cwd: CONTRACTS, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    node.stop = () => { try { process.kill(-node.pid, 'SIGTERM'); } catch { /* already gone */ } node.stdout.destroy(); node.stderr.destroy(); };
    const timer = setTimeout(() => reject(new Error('hardhat node did not start')), 120000);
    node.stdout.on('data', d => { if (/Started HTTP/.test(String(d))) { clearTimeout(timer); resolve(node); } });
    node.on('exit', code => { clearTimeout(timer); reject(new Error(`hardhat node exited ${code}`)); });
  });
}

test('yield proposals, end to end on a Base fork', { skip: !DB && 'set TEST_DATABASE_URL', timeout: 900000 }, async t => {
  const node = await startNode();
  t.after(() => node.stop());
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, 8453, { staticNetwork: true, cacheTimeout: -1 });
  t.after(() => provider.destroy());
  const fund = a => provider.send('hardhat_setBalance', [a, '0x' + (10n ** 20n).toString(16)]);
  await provider.send('evm_mine', []);

  const wallet = ethers.Wallet.createRandom().connect(provider);
  const me = wallet.address.toLowerCase();
  const feeWallet = ethers.Wallet.createRandom().address.toLowerCase();
  await fund(wallet.address);

  Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test', RPC_URLS_BASE: `http://127.0.0.1:${PORT}`, NEW_WALLET_CHECK_CHAINS: '', YIELD_FEE_WALLET_EVM: feeWallet });
  const venues = require('../src/yield/venues');
  const USDC = venues.TOKENS.base.USDC.address;
  // 1,000 USDC for the wallet, from Aave's USDC reserve (the aToken holds the cash).
  const reserve = venues.venue('aave-v3', 'base').aTokens.USDC;
  await provider.send('hardhat_impersonateAccount', [reserve]);
  await fund(reserve);
  const usdc = new ethers.Contract(USDC, ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], provider);
  await (await usdc.connect(new ethers.JsonRpcSigner(provider, reserve)).transfer(me, 1000n * 10n ** 6n)).wait();

  // Stand-ins: other chains aren't on this node, and DefiLlama isn't needed.
  require('../src/yield/rates').llamaRows = async () => null;
  const positions = require('../src/yield/positions');
  const realRead = positions.read;
  positions.read = (w, opts = {}) => realRead(w, { chains: ['base'], ...opts });
  // eth_simulateV1, played by the node: each call sent from the wallet, then all rolled back.
  require('../src/services/presign').simulate = async (_chain, from, calls) => {
    const snap = await provider.send('evm_snapshot', []);
    try {
      await provider.send('hardhat_impersonateAccount', [from]);
      const out = [];
      for (const c of calls) {
        try {
          const hash = await provider.send('eth_sendTransaction', [{ from, to: c.to, data: c.data, value: c.value || '0x0', gas: '0x7a1200' }]);
          const r = await provider.getTransactionReceipt(hash);
          out.push({ status: r.status === 1 ? '0x1' : '0x0', gasUsed: ethers.toQuantity(r.gasUsed), logs: r.logs.map(l => ({ address: l.address, topics: l.topics, data: l.data })) });
        } catch (err) { out.push({ status: '0x0', gasUsed: '0x0', logs: [], error: { message: err.shortMessage || err.message } }); }
      }
      return out;
    } finally { await provider.send('evm_revert', [snap]); }
  };
  const rules = require('../src/yield/rules');
  Object.assign(rules.RULES, { min_apy_gain_pct: 0, max_utilization_pct: 100, breakeven_days: 365 });

  const db = require('../src/config/db');
  t.after(() => db.getPool().end().catch(() => {}));
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  const { createApp } = require('../src/app');
  const { issueToken } = require('../src/auth/siwe');
  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const account = async w => (await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [w])).rows[0];
  const pro = await account(me);
  await db.query(`INSERT INTO passes (account_id, product, starts_at, ends_at) VALUES ($1, 'pro_30d', now(), now() + interval '30 days')`, [pro.id]);
  const proToken = issueToken(pro);
  const plainToken = issueToken(await account('0x' + '12'.repeat(20)));
  const send = async p => {
    const hashes = [];
    for (const c of p.calls) { const tx = await wallet.sendTransaction({ to: c.to, data: c.data }); const r = await tx.wait(); assert.equal(r.status, 1, c.label); hashes.push(tx.hash); }
    return hashes;
  };

  // The venues at the fork block, worst and best paying for USDC.
  const baseUsdc = (await call(null, 'GET', '/v1/yield/rates')).body.rates.filter(r => r.chain === 'base' && r.asset === 'USDC');
  const rates = baseUsdc.filter(r => r.apy_pct !== null);
  const unread = baseUsdc.filter(r => r.apy_pct === null).map(r => `${r.name}: ${r.error || 'no reason given'}`);
  assert.equal(rates.length, 3, `Aave, Compound and Spark rates read from their contracts (listed: ${baseUsdc.map(r => r.protocol).join(', ') || 'none'}; not read: ${unread.join('; ') || 'none'})`);
  rates.sort((a, b) => a.apy_pct - b.apy_pct);
  const [low, , high] = rates;

  await t.test('free: the wallet\'s balances and how many proposals; Safety Pro: the proposals themselves', async () => {
    const s = await call(null, 'POST', '/v1/yield/wallet', { wallet: me });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.deepEqual(s.body.idle.find(i => i.asset === 'USDC').amount, '1000.0');
    assert.ok(s.body.proposals_count >= 1);
    assert.equal(s.body.proposals, undefined, 'which ones is Safety Pro');
    assert.equal((await call(null, 'POST', '/v1/yield/proposals', { wallet: me })).status, 401);
    const no = await call(plainToken, 'POST', '/v1/yield/proposals', { wallet: me });
    assert.equal(no.status, 402);
    assert.equal(no.body.error, 'safety_pro_required');
    const yes = await call(proToken, 'POST', '/v1/yield/proposals', { wallet: me });
    const usdcProposal = yes.body.proposals.find(p => p.asset === 'USDC');
    assert.equal(usdcProposal.to.protocol, high.protocol, 'the best-paying venue');
    assert.equal(usdcProposal.kind, 'deposit');
    assert.ok(usdcProposal.checks.gas_usd_max >= 0 && usdcProposal.fee_usd > 0, 'gas and the fee are counted');
  });

  let into;
  await t.test('a deposit the user chose: the 0.1% fee, an exact approval, and the deposit, sent from the wallet', async () => {
    const p = await call(proToken, 'POST', '/v1/yield/moves/prepare', { wallet: me, chain: 'base', asset: 'USDC', to: low.protocol, amount_usd: 500 });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual(p.body.calls.map(c => c.step), ['fee', 'approve', 'deposit']);
    assert.deepEqual([p.body.summary.moved, p.body.summary.fee, p.body.summary.deposited], ['500.0', '0.5', '499.5']);
    const approve = new ethers.Interface(['function approve(address,uint256)']).decodeFunctionData('approve', p.body.calls[1].data);
    assert.equal(approve[1], 4995n * 10n ** 5n, 'exactly the deposit, never unlimited');
    const done = await call(null, 'POST', `/v1/yield/moves/${p.body.move_id}/confirm`, { tx_hashes: await send(p.body) });
    assert.equal(done.body.status, 'confirmed', JSON.stringify(done.body));
    assert.equal(done.body.fee_paid, '500000');
    assert.equal(await usdc.balanceOf(feeWallet), 500000n);
    const s = await call(proToken, 'POST', '/v1/yield/proposals', { wallet: me });
    into = s.body.positions.find(x => x.protocol === low.protocol);
    assert.ok(Number(into.amount) >= 499.49, `the position is there (${into?.amount})`);
  });

  await t.test('a proposed move to the better venue: withdraw, fee, approve, deposit; the position moves', async () => {
    const s = await call(proToken, 'POST', '/v1/yield/proposals', { wallet: me });
    const move = s.body.proposals.find(x => x.kind === 'move' && x.from.protocol === low.protocol);
    assert.ok(move, JSON.stringify(s.body.not_proposed));
    assert.equal(move.to.protocol, high.protocol);
    const p = await call(proToken, 'POST', '/v1/yield/moves/prepare', { wallet: me, chain: 'base', asset: 'USDC', from: low.protocol, to: high.protocol, all: true });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual(p.body.calls.map(c => c.step), ['withdraw', 'fee', 'approve', 'deposit']);
    assert.equal(p.body.atomic, true);
    const done = await call(null, 'POST', `/v1/yield/moves/${p.body.move_id}/confirm`, { tx_hashes: await send(p.body) });
    assert.equal(done.body.status, 'confirmed');
    const after = await call(proToken, 'POST', '/v1/yield/proposals', { wallet: me });
    const at = after.body.positions.find(x => x.protocol === high.protocol);
    assert.ok(Number(at.amount) > 498, `moved (${at?.amount})`);
    assert.ok(!after.body.positions.some(x => x.protocol === low.protocol && Number(x.amount) > 0.01), 'nothing left behind');
  });

  await t.test('refused: more than the wallet holds; a destination the risk watcher warns about; a non-Pro move', async () => {
    const big = await call(proToken, 'POST', '/v1/yield/moves/prepare', { wallet: me, chain: 'base', asset: 'USDC', to: low.protocol, amount_usd: 5000 });
    assert.equal(big.status, 422);
    assert.match(big.body.message, /less than/);
    await db.query(`INSERT INTO yield_risk_state (key, value) VALUES ('warnings', $1)`, [JSON.stringify({ [`${low.protocol}:base:USDC`]: { severity: 'critical', reason: 'test: a market in trouble', name: low.name, asset: 'USDC' } })]);
    const warned = await call(proToken, 'POST', '/v1/yield/moves/prepare', { wallet: me, chain: 'base', asset: 'USDC', to: low.protocol, amount_usd: 100 });
    assert.equal(warned.status, 422);
    assert.match(warned.body.message, /risk watcher warns/);
    assert.equal((await call(plainToken, 'POST', '/v1/yield/moves/prepare', { wallet: me, chain: 'base', asset: 'USDC', to: low.protocol, amount_usd: 100 })).status, 402);
    const listed = await call(null, 'GET', '/v1/yield/rates');
    assert.equal(listed.body.warnings[0].reason, 'test: a market in trouble', 'warnings are shown with the rates');
  });

  await t.test('a warning on a venue a watched wallet is in raises a risk monitor alert, linking to the exit', async () => {
    const { rows: [w] } = await db.query('INSERT INTO monitored_wallets (account_id, wallet) VALUES ($1, $2) RETURNING id', [pro.id, me]);
    const risk = require('../src/yield/risk');
    const n = await risk.alertHolders({ [`${high.protocol}:base:USDC`]: { severity: 'critical', reason: `${high.name} USDC on Base is 99% borrowed: withdrawals may stop.`, source: `${high.name}'s contracts onchain` } });
    assert.equal(n, 1);
    const { rows: [a] } = await db.query('SELECT * FROM monitor_alerts WHERE wallet_id = $1', [w.id]);
    assert.equal(a.kind, 'yield_risk');
    assert.match(a.title, /^Withdraw now: /);
    const m = require('../src/alerts/format').message(a);
    assert.match(m.url, /\/find\?wallet=0x[0-9a-f]{40}#yield-card$/);
    assert.equal(m.action, 'Review and withdraw');
    assert.equal(await risk.alertHolders({ [`${high.protocol}:base:USDC`]: { severity: 'critical', reason: 'again', source: 'x' } }), 0, 'not twice the same day');

    const d = await risk.detect({ chains: ['base'] });
    assert.ok(d.notRead.every(x => !/on base/.test(x.check)), JSON.stringify(d.notRead));
  });

  await t.test('an exit to the wallet: free, for anyone, never refused by the rules', async () => {
    await db.query(`UPDATE yield_risk_state SET value = $1 WHERE key = 'warnings'`, [JSON.stringify({ [`${high.protocol}:base:USDC`]: { severity: 'critical', reason: 'warned', name: high.name, asset: 'USDC' } })]);
    const before = await usdc.balanceOf(me);
    const p = await call(null, 'POST', '/v1/yield/moves/prepare', { wallet: me, chain: 'base', asset: 'USDC', from: high.protocol, all: true });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual(p.body.calls.map(c => c.step), ['withdraw']);
    assert.equal(p.body.summary.fee, '0.0');
    assert.match(p.body.summary.fee_reason, /free/);
    await send(p.body);
    assert.ok(await usdc.balanceOf(me) - before > 498n * 10n ** 6n, 'the money is back in the wallet');
  });
  await t.test('automatic rebalancing (switched off by default): a delegation to the Yield Router only; the trade service deposits within the user\'s limits, and exits on a critical warning', { skip: !fs.existsSync(ROUTER_ARTIFACT) && 'build the contracts first' }, async () => {
    const env = require('../src/config/env');
    const auto = require('../src/yield/auto');
    const venuesList = venues.routerVenues('base');
    const art = JSON.parse(fs.readFileSync(ROUTER_ARTIFACT, 'utf8'));
    const deployer = new ethers.NonceManager(new ethers.JsonRpcSigner(provider, reserve));
    const yr = await new ethers.ContractFactory(art.abi, art.bytecode, deployer).deploy(feeWallet, 10, 1, 86400, venuesList.map(v => ({ kind: v.kind, target: v.target, asset: v.assetAddress, position: v.position, rateSource: v.rateSource })));
    await yr.waitForDeployment();
    const routerAddress = (await yr.getAddress()).toLowerCase();
    const session = ethers.Wallet.createRandom().connect(provider);
    await fund(session.address);
    Object.assign(env, { yieldRouters: { 8453: routerAddress }, sessionKeyAddress: session.address.toLowerCase() });
    require('../src/trade/signers').sessionSigner = async () => session;
    await db.query(`DELETE FROM yield_risk_state WHERE key = 'warnings'`);

    // The user's wallet becomes a MetaMask smart account, then signs the setup: approvals to the router, Comet's allow, a 600 USDC limit.
    const MM = DELEGATOR_CONTRACTS['1.3.0'][8453];
    const auth = await wallet.authorize({ address: MM.EIP7702StatelessDeleGatorImpl, nonce: await wallet.getNonce(), chainId: 8453 });
    await (await new ethers.JsonRpcSigner(provider, reserve).sendTransaction({ type: 4, to: me, data: '0x', authorizationList: [auth], gasLimit: 200000 })).wait();
    const setup = await call(null, 'GET', '/v1/yield/auto/setup?chain_id=8453&USDC=600');
    assert.equal(setup.status, 200, JSON.stringify(setup.body));
    // Every approval and Comet's allow name the router; the limits are set on the router; nothing else.
    const setupIface = new ethers.Interface(['function approve(address,uint256)', 'function allow(address,bool)', 'function setLimits(address[],uint256[],uint64)']);
    for (const c of setup.body.calls) {
      const d = setupIface.parseTransaction({ data: c.data });
      if (d.name === 'setLimits') assert.equal(c.to, routerAddress);
      else assert.equal(d.args[0].toLowerCase(), routerAddress, `${c.label}: only to the router`);
    }
    for (const c of setup.body.calls) await (await wallet.sendTransaction({ to: c.to, data: c.data })).wait();

    const expiry = (await provider.getBlock('latest')).timestamp + 7 * 86400;
    const caveats = [
      { enforcer: MM.RedeemerEnforcer, terms: core.createRedeemerTerms({ redeemers: [session.address] }), args: '0x' },
      { enforcer: MM.TimestampEnforcer, terms: core.createTimestampTerms({ afterThreshold: 0, beforeThreshold: expiry }), args: '0x' },
      { enforcer: MM.AllowedTargetsEnforcer, terms: core.createAllowedTargetsTerms({ targets: [routerAddress] }), args: '0x' },
      { enforcer: MM.AllowedMethodsEnforcer, terms: core.createAllowedMethodsTerms({ selectors: auto.SELECTORS }), args: '0x' },
    ];
    const types = { Delegation: [{ name: 'delegate', type: 'address' }, { name: 'delegator', type: 'address' }, { name: 'authority', type: 'bytes32' }, { name: 'caveats', type: 'Caveat[]' }, { name: 'salt', type: 'uint256' }], Caveat: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }] };
    const value = { delegate: session.address, delegator: wallet.address, authority: core.ROOT_AUTHORITY, caveats: caveats.map(c => ({ enforcer: c.enforcer, terms: c.terms })), salt: 7n };
    const signature = await wallet.signTypedData({ name: 'DelegationManager', version: '1', chainId: 8453, verifyingContract: MM.DelegationManager }, types, value);
    const delegation = { delegate: session.address, delegator: wallet.address, authority: core.ROOT_AUTHORITY, caveats, salt: '7', signature };

    // Switched off: refused, and the trade service does nothing.
    env.yieldAutoEnabled = false;
    const off = await call(proToken, 'POST', '/v1/yield/auto/permissions', { chain_id: 8453, delegation });
    assert.equal(off.status, 503);
    assert.match(off.body.message, /switched off/);
    assert.deepEqual(await auto.tick(), { off: true });

    env.yieldAutoEnabled = true;
    t.after(() => { env.yieldAutoEnabled = false; auto.close(); });
    const wide = { ...delegation, caveats: caveats.map((c, i) => (i === 3 ? { ...c, terms: core.createAllowedMethodsTerms({ selectors: [...auto.SELECTORS, auto.ROUTER.getFunction('setLimits').selector] }) } : c)) };
    assert.equal((await call(proToken, 'POST', '/v1/yield/auto/permissions', { chain_id: 8453, delegation: wide })).status, 422, 'a delegation allowing more than deposit, move and withdraw is refused');
    const reg = await call(proToken, 'POST', '/v1/yield/auto/permissions', { chain_id: 8453, delegation });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));

    // The trade service: the best deposit, capped at the user's 600 USDC limit, sent by the session key through the router.
    const fees = await usdc.balanceOf(feeWallet);
    const pass1 = await auto.tick();
    assert.equal(pass1.done[0]?.kind, 'deposit', JSON.stringify(pass1));
    assert.equal(pass1.done[0].status, 'sent');
    await auto.tick(); // reads the receipt
    const { rows: [a1] } = await db.query('SELECT * FROM yield_auto_actions ORDER BY created_at LIMIT 1');
    assert.equal(a1.status, 'confirmed');
    assert.equal(a1.amount_raw, String(600n * 10n ** 6n), 'capped at the user\'s limit');
    const target = venuesList[a1.to_venue];
    assert.equal(await usdc.balanceOf(feeWallet) - fees, 600000n, '0.1%, enforced by the router');
    const held = await yr.positionOf(a1.to_venue, me);
    assert.ok(held >= 599n * 10n ** 6n, `the position is the user's own (${held})`);

    // The router allows one deposit or move a day: nothing more now.
    const pass2 = await auto.tick();
    assert.deepEqual(pass2.done, []);

    // A critical warning on that venue: everything comes back to the wallet, at once, free.
    await db.query(`INSERT INTO yield_risk_state (key, value) VALUES ('warnings', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ [`${target.protocol}:base:USDC`]: { severity: 'critical', reason: 'test: 99% borrowed', protocol: target.protocol, chain: 'base', asset: 'USDC', name: target.protocol } })]);
    const before = await usdc.balanceOf(me);
    const pass3 = await auto.tick();
    assert.equal(pass3.done[0]?.kind, 'withdraw', JSON.stringify(pass3));
    await auto.tick();
    assert.ok(await usdc.balanceOf(me) - before >= 599n * 10n ** 6n, 'back in the wallet');
    assert.ok(await yr.positionOf(a1.to_venue, me) <= 1n);

    // Revoked in RektBull: the trade service stops using it.
    assert.equal((await call(proToken, 'DELETE', `/v1/yield/auto/permissions/${reg.body.id}`)).status, 200);
    await db.query(`DELETE FROM yield_risk_state WHERE key = 'warnings'`);
    assert.deepEqual((await auto.tick()).done, []);
  });
});
