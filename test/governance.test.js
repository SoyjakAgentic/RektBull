/**
 * The governance assistant: each voting type's choice; with a database,
 * through the API, with Snapshot and Claude as stand-ins: the votes a wallet
 * can cast, a vote built, signed by the wallet and sent (and refused when
 * tampered with, stale or shielded), summaries as a paid run, spaces added
 * by hand, and alerts for watched wallets.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, { JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', ANTHROPIC_API_KEY: 'test', ...(DB ? { DATABASE_URL: DB } : {}) });
const governance = require('../src/services/governance');
const snapshot = require('../src/providers/snapshot');

test('choices: each voting type, refused when out of range', () => {
  const p = t => ({ type: t, choices: ['A', 'B', 'C'], space: { id: 's' }, id: 'x' });
  assert.equal(governance.choiceFor(p('single-choice'), 2), 2);
  assert.throws(() => governance.choiceFor(p('basic'), 4), /1 to 3/);
  assert.deepEqual(governance.choiceFor(p('approval'), [1, 3]), [1, 3]);
  assert.throws(() => governance.choiceFor(p('approval'), [1, 1]), /each once/);
  assert.deepEqual(governance.choiceFor(p('ranked-choice'), [3, 1, 2]), [3, 1, 2]);
  assert.throws(() => governance.choiceFor(p('ranked-choice'), [1, 2]), /all 3/);
  assert.equal(governance.choiceFor(p('weighted'), { 1: 2, 3: 1, 2: 0 }), '{"1":2,"3":1}');
  assert.throws(() => governance.choiceFor(p('quadratic'), { 9: 1 }), /1 to 3/);
  assert.throws(() => governance.choiceFor(p('copeland'), 1), /can't build copeland/);
  assert.deepEqual(governance.voteTypes('uint32[]').Vote.map(f => f.type), ['string', 'string', 'uint64', 'string', 'uint32[]', 'string', 'string', 'string'], 'Snapshot\'s Vote type, field for field');
  assert.deepEqual(governance.DOMAIN, { name: 'snapshot', version: '0.1.4' });
});

test('the pre-sign check names a Snapshot vote for what it is', async () => {
  const presign = require('../src/services/presign');
  const td = { domain: { name: 'snapshot', version: '0.1.4' }, primaryType: 'Vote', types: governance.voteTypes('uint32'), message: { from: '0x' + '11'.repeat(20), space: 'aave.eth', proposal: '0x' + 'ab'.repeat(32), choice: 1 } };
  const r = await presign.check({ chain_id: 1, from: '0x' + '11'.repeat(20), origin: null, method: 'eth_signTypedData_v4', params: ['0x' + '11'.repeat(20), JSON.stringify(td)] });
  assert.equal(r.verdict, 'low');
  assert.ok(r.findings.some(f => /A Snapshot vote in aave\.eth/.test(f.title) && f.source === 'Snapshot vote (decoded)'));
});

test('votes, summaries, spaces and alerts, through the API', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());

  const voter = ethers.Wallet.createRandom();
  const now = Math.floor(Date.now() / 1000);
  const P = (id, extra = {}) => ({ id, title: `Proposal ${id.slice(2, 6)}`, body: 'Move 500,000 USDC from the treasury to the grants multisig 0xabc.', choices: ['For', 'Against', 'Abstain'], start: now - 3600, end: now + 3600 * 10, state: 'active', author: '0x1', type: 'basic', quorum: 100, snapshot: '1', network: '1', scores: [60, 30, 10], scores_total: 100, scores_state: 'pending', privacy: '', discussion: 'https://forum.example/t/1', space: { id: 'aave.eth', name: 'Aave', voting: { quorum: 0 } }, ...extra });
  const open = P('0x' + 'a1'.repeat(32));
  const done = P('0x' + 'b2'.repeat(32), { end: now + 3600 * 100 });
  const shielded = P('0x' + 'c3'.repeat(32), { privacy: 'shutter', end: now + 3600 * 50 });
  const proposals = { [open.id]: open, [done.id]: done, [shielded.id]: shielded };
  const relayed = [];
  snapshot.http.post = async (url, body) => {
    if (url === snapshot.SEQUENCER) { relayed.push(body); return { data: { id: '0xreceipt', ipfs: 'bafy' } }; }
    const q = body.query; const v = body.variables;
    if (q.includes('follows(')) return { data: { data: { follows: [{ space: { id: 'aave.eth' } }], votes: [{ space: { id: 'ens.eth' } }] } } };
    if (q.includes('state: "active"')) return { data: { data: { proposals: [open, done, shielded] } } };
    if (q.includes('voter_in') || q.includes('proposal_in')) return { data: { data: { votes: [{ proposal: { id: done.id }, choice: 2, vp: 42, created: now - 60 }] } } };
    if (q.includes('vp(')) return { data: { data: { vp: { vp: 42, vp_state: 'final' } } } };
    if (q.includes('proposal(id')) return { data: { data: { proposal: proposals[v.id] || null } } };
    if (q.includes('space(id')) return { data: { data: { space: v.id === 'uniswapgovernance.eth' ? { id: v.id, name: 'Uniswap' } : null } } };
    throw new Error('unexpected query: ' + q.slice(0, 60));
  };
  const claude = require('../src/ai/claude');
  let written = 0;
  claude.write = async ({ prompt }) => { written++; assert.match(prompt, /Move 500,000 USDC/); return { text: '## In one sentence\nIt moves 500,000 USDC to grants.', model: 'test-model' }; };

  const { createApp } = require('../src/app');
  const { issueToken } = require('../src/auth/siwe');
  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const { rows: [acct] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [voter.address.toLowerCase()]);
  const token = issueToken(acct);

  await t.test('the free check: open votes, voting power, already voted, and why one can\'t be voted here', async () => {
    const r = await call(null, 'POST', '/v1/governance/check', { wallet: voter.address });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.spaces, { followed: ['aave.eth'], voted_in: ['ens.eth'], added: [] });
    const by = Object.fromEntries(r.body.proposals.map(p => [p.id, p]));
    assert.equal(by[open.id].your_voting_power, 42);
    assert.equal(by[open.id].can_vote_here, true);
    assert.equal(by[done.id].voted.choice, 'Against');
    assert.match(by[shielded.id].why_not_here, /shielded/);
    assert.deepEqual(r.body.summary, { active: 3, to_vote: 2, closing_within_24h: 1 });
    assert.equal(r.body.proposals.at(-1).id, done.id, 'what you already voted on comes last');
    assert.match(r.body.note, /never recommends/);
  });

  let prep;
  await t.test('a vote: built, signed by the wallet, checked, sent to Snapshot', async () => {
    const p = await call(null, 'POST', '/v1/governance/votes/prepare', { wallet: voter.address, proposal_id: open.id, choice: 1, reason: 'grants work' });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    prep = p.body;
    assert.deepEqual(prep.typed_data.domain, { name: 'snapshot', version: '0.1.4' });
    assert.equal(prep.typed_data.message.from, voter.address);
    assert.equal(prep.vote.choice, 'For');
    assert.equal((await call(null, 'POST', '/v1/governance/votes/prepare', { wallet: voter.address, proposal_id: shielded.id, choice: 1 })).status, 422);
    const { EIP712Domain, ...types } = prep.typed_data.types;
    assert.ok(EIP712Domain, 'listed for wallets that need it');
    const sig = await voter.signTypedData(prep.typed_data.domain, types, prep.typed_data.message);

    // Tampered with (another choice than signed), not RektBull's, or another signer: refused, nothing sent.
    assert.equal((await call(null, 'POST', '/v1/governance/votes', { message: { ...prep.typed_data.message, choice: 2 }, sig })).status, 400);
    assert.equal((await call(null, 'POST', '/v1/governance/votes', { message: { ...prep.typed_data.message, app: 'other' }, sig })).status, 400);
    const other = await ethers.Wallet.createRandom().signTypedData(prep.typed_data.domain, types, prep.typed_data.message);
    require('../src/providers/rpc').evmRpc = async () => '0x'; // the voter is a plain wallet
    assert.equal((await call(null, 'POST', '/v1/governance/votes', { message: prep.typed_data.message, sig: other })).status, 400);
    assert.equal(relayed.length, 0);

    const r = await call(token, 'POST', '/v1/governance/votes', { message: prep.typed_data.message, sig });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.receipt_id, '0xreceipt');
    assert.equal(relayed.length, 1);
    const env = relayed[0];
    assert.equal(env.address, voter.address);
    assert.equal(env.data.types.EIP712Domain, undefined, 'Snapshot\'s envelope carries only the Vote type');
    assert.equal(ethers.verifyTypedData(env.data.domain, env.data.types, env.data.message, env.sig), voter.address);
    const { rows: [row] } = await db.query('SELECT * FROM governance_votes');
    assert.deepEqual([row.space_id, row.proposal_id, row.choice, row.receipt_id], ['aave.eth', open.id, 1, '0xreceipt']);
  });

  await t.test('a vote prepared too long ago is refused', async () => {
    const stale = { ...prep.typed_data.message, timestamp: now - 3600 };
    const { EIP712Domain, ...types } = prep.typed_data.types;
    const sig = await voter.signTypedData(prep.typed_data.domain, types, stale);
    assert.match((await call(null, 'POST', '/v1/governance/votes', { message: stale, sig })).body.message, /too long ago/);
  });

  await t.test('a summary is a paid run (1 point), written once from the proposal\'s own text', async () => {
    const s = await call(token, 'POST', '/v1/governance/summary', { proposal_id: open.id });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.match(s.body.summary_markdown, /500,000 USDC/);
    assert.deepEqual([s.body.run.paid_with, s.body.run.points], ['points', 1]);
    assert.match(s.body.note, /not a recommendation/);
    const again = await call(token, 'POST', '/v1/governance/summary', { proposal_id: open.id });
    assert.equal(again.status, 200);
    assert.equal(written, 1, 'the same proposal text is summarized once');
    assert.equal((await call(null, 'POST', '/v1/governance/summary', { proposal_id: open.id })).status, 402, 'signed out: pay');
    assert.equal((await call(token, 'POST', '/v1/governance/summary', { proposal_id: 'nope' })).status, 400);
  });

  await t.test('spaces added by hand, checked against Snapshot', async () => {
    assert.equal((await call(token, 'POST', '/v1/governance/spaces', { space: 'nosuch.eth' })).status, 404);
    const a = await call(token, 'POST', '/v1/governance/spaces', { space: 'uniswapgovernance.eth' });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual((await call(token, 'GET', '/v1/governance/spaces')).body.spaces, ['uniswapgovernance.eth']);
    const c = await call(token, 'POST', '/v1/governance/check', { wallet: voter.address });
    assert.deepEqual(c.body.spaces.added, ['uniswapgovernance.eth']);
    assert.deepEqual((await call(token, 'DELETE', '/v1/governance/spaces/uniswapgovernance.eth')).body.spaces, []);
  });

  await t.test('Safety Pro: alerts when a vote opens and when it closes within a day, once each', async () => {
    await db.query(`INSERT INTO passes (account_id, product, starts_at, ends_at) VALUES ($1, 'pro_30d', now(), now() + interval '30 days')`, [acct.id]);
    await db.query('INSERT INTO monitored_wallets (account_id, wallet) VALUES ($1, $2)', [acct.id, voter.address.toLowerCase()]);
    assert.equal(await governance.alertTick(), 2, 'one closing within a day, one new (shielded: voted on Snapshot itself); none for what the wallet already voted on');
    const { rows } = await db.query(`SELECT title, kind FROM monitor_alerts WHERE kind = 'governance' ORDER BY id`);
    const titles = rows.map(r => r.title).join(' | ');
    assert.match(titles, /Vote closes in 10 hours: Proposal a1a1/);
    assert.match(titles, /New vote in Aave: Proposal c3c3/);
    assert.doesNotMatch(titles, /b2b2/);
    assert.equal(await governance.alertTick(), 0, 'once each');
    const m = require('../src/alerts/format').message({ kind: 'governance', wallet: voter.address.toLowerCase(), severity: 'medium', title: rows[0].title, detail: {} });
    assert.match(m.url, /\/governance\?wallet=0x/);
    assert.equal(m.action, 'Review and vote');
  });
});
