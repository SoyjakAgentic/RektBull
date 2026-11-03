/**
 * On-chain governor votes, end to end, on a local chain: a real
 * OpenZeppelin Governor and ERC20Votes token (OpenZeppelin 5, the same code
 * DAOs deploy), the RektBull API, a delegation and a vote sent from the
 * wallet, a proposal's actions decoded and summarized, and the alert.
 *
 * The explorer is played by the node's own logs; Claude is a stand-in.
 * Simulations run on the node and are rolled back.
 *
 *   cd contracts && npm install && npx hardhat compile && cd ..
 *   TEST_DATABASE_URL=postgres://… node --test test/governors.e2e.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
const CONTRACTS = path.join(__dirname, '..', 'contracts');
const ART = n => JSON.parse(fs.readFileSync(path.join(CONTRACTS, 'artifacts', 'contracts', 'test', 'GovMocks.sol', `${n}.json`), 'utf8'));
const built = fs.existsSync(path.join(CONTRACTS, 'artifacts', 'contracts', 'test', 'GovMocks.sol', 'MockGovernor.json'));
const PORT = 8551;

function startNode() {
  return new Promise((resolve, reject) => {
    const node = spawn('npx', ['hardhat', '--network', 'default', 'node', '--port', String(PORT)], { cwd: CONTRACTS, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    node.stop = () => { try { process.kill(-node.pid, 'SIGTERM'); } catch { /* already gone */ } node.stdout.destroy(); node.stderr.destroy(); };
    const timer = setTimeout(() => reject(new Error('hardhat node did not start')), 120000);
    node.stdout.on('data', d => { if (/Started HTTP/.test(String(d))) { clearTimeout(timer); resolve(node); } });
    node.on('exit', code => { clearTimeout(timer); reject(new Error(`hardhat node exited ${code}`)); });
  });
}

test('on-chain governor votes, end to end', { skip: (!DB && 'set TEST_DATABASE_URL') || (!built && 'build the contracts first'), timeout: 600000 }, async t => {
  const node = await startNode();
  t.after(() => node.stop());
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, 84532, { staticNetwork: true, cacheTimeout: -1 });
  t.after(() => provider.destroy());
  const fund = a => provider.send('hardhat_setBalance', [a, '0x' + (10n ** 20n).toString(16)]);
  await provider.send('evm_mine', []);
  const forkBlock = await provider.getBlockNumber();

  const deployerKey = ethers.Wallet.createRandom();
  const deployer = new ethers.NonceManager(deployerKey.connect(provider));
  const voter = ethers.Wallet.createRandom().connect(provider);
  const whale = ethers.Wallet.createRandom().connect(provider);
  const late = ethers.Wallet.createRandom().connect(provider);
  for (const w of [deployerKey, voter, whale, late]) await fund(w.address);
  const deploy = async (name, args) => { const a = ART(name); const c = await new ethers.ContractFactory(a.abi, a.bytecode, deployer).deploy(...args); await c.waitForDeployment(); return c; };
  const send = async p => (await p).wait();
  const token = await deploy('MockVotesToken', []);
  const gov = await deploy('MockGovernor', [token.target]);
  const GOV = gov.target.toLowerCase(); const TOKEN = token.target.toLowerCase();
  await send(token.mint(voter.address, 1000n * 10n ** 18n));
  await send(token.mint(whale.address, 9000n * 10n ** 18n));
  await send(token.mint(late.address, 500n * 10n ** 18n));
  await send(token.connect(whale).delegate(whale.address));

  // The service, pointed at the local node as "ethereum".
  Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', ANTHROPIC_API_KEY: 'test', RPC_URLS_ETHEREUM: `http://127.0.0.1:${PORT}` });
  const governors = require('../src/services/governors');
  governors.REGISTRY.length = 0; // the real DAOs' governors aren't on this node
  const explorer = require('../src/providers/explorer');
  explorer.blockAt = async () => forkBlock;
  explorer.explorerLogs = async (chain, { address, topic0 }, { fromBlock = 0 } = {}) => ({
    logs: (await provider.send('eth_getLogs', [{ address, topics: [topic0], fromBlock: ethers.toQuantity(Math.max(fromBlock, forkBlock)), toBlock: 'latest' }])).map(l => ({ ...l, blockNumber: l.blockNumber })),
    complete: true,
  });
  require('../src/services/presign').simulate = async (_chain, from, calls) => {
    const snap = await provider.send('evm_snapshot', []);
    try {
      await provider.send('hardhat_impersonateAccount', [from]);
      const out = [];
      for (const c of calls) {
        try {
          const hash = await provider.send('eth_sendTransaction', [{ from, to: c.to, data: c.data, value: c.value || '0x0', gas: '0x2dc6c0' }]);
          const r = await provider.getTransactionReceipt(hash);
          out.push({ status: r.status === 1 ? '0x1' : '0x0', gasUsed: ethers.toQuantity(r.gasUsed), logs: r.logs });
        } catch (err) { out.push({ status: '0x0', logs: [], error: { message: err.shortMessage || err.message } }); }
      }
      return out;
    } finally { await provider.send('evm_revert', [snap]); }
  };
  require('../src/providers/snapshot').http.post = async () => ({ data: { data: { follows: [], votes: [], proposals: [] } } }); // no Snapshot spaces here
  let prompt = null;
  require('../src/ai/claude').write = async ({ prompt: p }) => { prompt = p; return { text: '## In one sentence\nIt sends 500 GOV from the governor to a builder.', model: 'test-model' }; };

  const db = require('../src/config/db');
  t.after(() => db.getPool().end().catch(() => {}));
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  const { createApp } = require('../src/app');
  const { issueToken } = require('../src/auth/siwe');
  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (tok, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const { rows: [acct] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [voter.address.toLowerCase()]);
  const tok = issueToken(acct);
  const sendCalls = async (wallet, prep) => { for (const c of prep.calls) await send(wallet.sendTransaction({ to: c.to, data: c.data })); };
  const check = async (who = voter) => (await call(tok, 'POST', '/v1/governance/check', { wallet: who.address })).body;

  await t.test('a governor added by hand is checked to be one', async () => {
    assert.equal((await call(tok, 'POST', '/v1/governance/governors', { chain: 'ethereum', address: TOKEN })).status, 404, 'a token isn\'t a governor');
    const a = await call(tok, 'POST', '/v1/governance/governors', { chain: 'ethereum', address: GOV });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual([a.body.added.kind, a.body.added.symbol], ['OpenZeppelin Governor', 'GOV']);
  });

  await t.test('tokens delegated to nobody count for nobody: a delegation to yourself, prepared and sent', async () => {
    const c = await check();
    const g = c.onchain.governors[0];
    assert.equal(g.your_votes, '0.0');
    assert.equal(g.balance, '1000.0');
    assert.equal(g.delegated, 'to nobody');
    assert.match(g.needs_delegation, /count for nobody/);
    assert.equal(c.summary.votes_counting_for_nobody, 1);
    const d = await call(null, 'POST', '/v1/governance/onchain/delegate/prepare', { wallet: voter.address, chain: 'ethereum', governor: GOV });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(d.body.calls[0].to, TOKEN);
    assert.equal(new ethers.Interface(['function delegate(address)']).decodeFunctionData('delegate', d.body.calls[0].data)[0], voter.address);
    await sendCalls(voter, d.body);
    const after = (await check()).onchain.governors[0];
    assert.deepEqual([after.your_votes, after.delegated, after.needs_delegation], ['1000.0', 'to yourself', undefined]);
  });

  let pid;
  await t.test('an open proposal: its action decoded and flagged, the wallet\'s power at the snapshot, a deadline estimated from blocks', async () => {
    const recipient = ethers.Wallet.createRandom().address;
    const data = token.interface.encodeFunctionData('transfer', [recipient, 500n * 10n ** 18n]);
    await send(gov.connect(whale).propose([token.target], [0], [data], '# Fund the builders\nSend 500 GOV from the treasury to the builders\' multisig.'));
    await provider.send('hardhat_mine', ['0x3']);
    await send(token.connect(late).delegate(late.address)); // after the snapshot: no power on this one
    require('../src/lib/cache')._memory.clear(); // open proposals are cached five minutes
    await db.query(`DELETE FROM cache WHERE key LIKE 'governor:open:%'`);
    const c = await check();
    const p = c.onchain.proposals[0];
    assert.ok(p, JSON.stringify(c.not_checked));
    pid = p.id;
    assert.equal(p.state, 'Active');
    assert.equal(p.title, 'Fund the builders');
    assert.deepEqual(p.flags, ['moves funds']);
    assert.equal(p.actions[0].function, 'transfer(address,uint256)');
    assert.equal(p.actions[0].args[0], `address ${recipient}`);
    assert.equal(p.your_voting_power, '1000.0');
    assert.equal(p.can_vote_here, true);
    assert.equal(p.deadline.estimated, true, 'a future block\'s time is an estimate, and says so');
    assert.equal(p.quorum.counts, 'For + Abstain');
    assert.equal(c.summary.to_vote, 1);
    const lateView = (await check(late)).onchain.proposals[0];
    assert.match(lateView.why_not_here, /no votes at its snapshot/);
  });

  await t.test('a summary of an on-chain proposal reads its decoded actions, as a paid run', async () => {
    const s = await call(tok, 'POST', '/v1/governance/summary', { chain: 'ethereum', governor: GOV, proposal_id: pid });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.match(prompt, /transfer\(address,uint256\) on 0x[0-9a-f]{40} \(address 0x[0-9a-fA-F]{40}, uint256 500000000000000000000\) \[moves funds\]/);
    assert.match(prompt, /trust these over the description/);
    assert.deepEqual([s.body.run.paid_with, s.body.run.points], ['points', 1]);
  });

  await t.test('Safety Pro: an alert for the on-chain vote, once', async () => {
    await db.query(`INSERT INTO passes (account_id, product, starts_at, ends_at) VALUES ($1, 'pro_30d', now(), now() + interval '30 days')`, [acct.id]);
    await db.query('INSERT INTO monitored_wallets (account_id, wallet) VALUES ($1, $2)', [acct.id, voter.address.toLowerCase()]);
    const governance = require('../src/services/governance');
    assert.equal(await governance.alertTick(), 1);
    const { rows: [a] } = await db.query(`SELECT title, detail FROM monitor_alerts WHERE kind = 'governance'`);
    assert.match(a.title, /Fund the builders/);
    assert.match(a.detail.reasons[0].text, /It moves funds/);
    assert.equal(await governance.alertTick(), 0);
  });

  await t.test('the vote: castVoteWithReason, simulated, sent by the wallet; then it can\'t be cast twice', async () => {
    const v = await call(null, 'POST', '/v1/governance/onchain/votes/prepare', { wallet: voter.address, chain: 'ethereum', governor: GOV, proposal_id: pid, support: 1, reason: 'builders ship' });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.equal(v.body.calls[0].to, GOV);
    const d = gov.interface.parseTransaction({ data: v.body.calls[0].data });
    assert.deepEqual([d.name, d.args[0].toString(), Number(d.args[1]), d.args[2]], ['castVoteWithReason', pid, 1, 'builders ship']);
    // The extension's pre-sign check names it for what it is.
    const pre = await require('../src/services/presign').check({ chainId: 1, from: voter.address.toLowerCase(), method: 'eth_sendTransaction', params: [{ from: voter.address, to: GOV, data: v.body.calls[0].data }] });
    assert.ok(pre.findings.some(f => /A governance vote onchain \(For\)/.test(f.title)), JSON.stringify(pre.findings));
    await sendCalls(voter, v.body);
    assert.equal(await gov.hasVoted(pid, voter.address), true);
    const c = await check();
    assert.deepEqual(c.onchain.proposals[0].voted, { support: null });
    const again = await call(null, 'POST', '/v1/governance/onchain/votes/prepare', { wallet: voter.address, chain: 'ethereum', governor: GOV, proposal_id: pid, support: 0 });
    assert.match(again.body.message, /already voted/);
    assert.equal((await call(null, 'POST', '/v1/governance/onchain/votes/prepare', { wallet: voter.address, chain: 'ethereum', governor: GOV, proposal_id: pid, support: 3 })).status, 400, 'support is 0, 1 or 2');
  });
});
