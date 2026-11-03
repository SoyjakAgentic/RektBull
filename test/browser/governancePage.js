/**
 * Drives /governance in a real browser with a stand-in wallet that really
 * signs (EIP-712), against the real server with Snapshot and Claude as
 * stand-ins. Needs a database:
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/governancePage.js
 */
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('set TEST_DATABASE_URL'); process.exit(1); }
Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', ANTHROPIC_API_KEY: 'test' });

(async () => {
  const db = require('../../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../../src/config/migrate').migrate();
  const wallet = ethers.Wallet.createRandom();
  const now = Math.floor(Date.now() / 1000);
  const P = (id, extra) => ({ id, title: 'Fund the grants program', body: 'Send 500,000 USDC to the grants multisig.', choices: ['For', 'Against', 'Abstain'], start: now - 60, end: now + 7200, state: 'active', author: '0x1', type: 'basic', quorum: 0, scores: [10, 5, 1], scores_total: 16, scores_state: 'pending', privacy: '', discussion: '', space: { id: 'aave.eth', name: 'Aave', voting: { quorum: 0 } }, ...extra });
  const open = P('0x' + 'a1'.repeat(32));
  const approval = P('0x' + 'd4'.repeat(32), { title: 'Pick the new council', type: 'approval', choices: ['Ann', 'Bo', 'Cy'], end: now + 86400 * 3 });
  const snapshot = require('../../src/providers/snapshot');
  const relayed = [];
  snapshot.http.post = async (url, body) => {
    if (url === snapshot.SEQUENCER) { relayed.push(body); return { data: { id: '0xreceipt' } }; }
    const q = body.query;
    if (q.includes('follows(')) return { data: { data: { follows: [{ space: { id: 'aave.eth' } }], votes: [] } } };
    if (q.includes('state: "active"')) return { data: { data: { proposals: [open, approval] } } };
    if (q.includes('proposal_in')) return { data: { data: { votes: [] } } };
    if (q.includes('vp(')) return { data: { data: { vp: { vp: 1234.5, vp_state: 'final' } } } };
    if (q.includes('proposal(id')) return { data: { data: { proposal: [open, approval].find(p => p.id === body.variables.id) } } };
    throw new Error('unexpected ' + q.slice(0, 40));
  };
  // On-chain governors: stand-ins here (test/governors.e2e.js runs the real ones on a chain).
  const governorsSvc = require('../../src/services/governors');
  const GOVR = '0x' + '6f'.repeat(20);
  governorsSvc.forWallet = async () => ({
    governors: [{ name: 'Uniswap', chain: 'ethereum', chain_id: 1, address: GOVR, kind: 'Compound Governor Bravo', symbol: 'UNI', balance: '120.0', your_votes: '0.0', delegates_to: null, delegated: 'to nobody', needs_delegation: 'Your 120.0 UNI count for nobody until they\'re delegated. Delegating to yourself is one transaction and lets you vote.' },
      { name: 'Arbitrum (Treasury)', chain: 'arbitrum', chain_id: 42161, address: '0x' + '7a'.repeat(20), kind: 'OpenZeppelin Governor', symbol: 'ARB', balance: '50.0', your_votes: '50.0', delegated: 'to yourself' }],
    proposals: [{ id: '777', kind: 'onchain', title: 'Transfer 1,800 ETH from the Treasury', state: 'Active', governor: { name: 'Arbitrum (Treasury)', chain: 'arbitrum', chain_id: 42161, address: '0x' + '7a'.repeat(20), symbol: 'ARB' },
      flags: ['moves funds'], actions: [{ target: '0x' + '8b'.repeat(20), value_wei: '0', function: 'transfer(address,uint256)', args: ['address 0x' + '9c'.repeat(20), 'uint256 1800'], flags: ['moves funds'] }],
      votes: { for: '100.0', against: '5.0', abstain: '0.0' }, quorum: { required: '300.0', counted: '100.0', reached: false, counts: 'For + Abstain' },
      deadline: { at: new Date(Date.now() + 5 * 86400000).toISOString(), estimated: true }, hours_left: 120, your_voting_power: '50.0', voted: null, can_vote_here: true, source: 'the explorer\'s logs (proposals) and RPC (state, tally, quorum)' }],
    not_checked: [], source: 'onchain',
  });
  const prepared = [];
  governorsSvc.prepareDelegate = async input => { prepared.push(['delegate', input]); return { chain: 'ethereum', chain_id: '0x1', atomic: false, calls: [{ to: '0x' + '1f'.repeat(20), data: '0x5c19a95c', value: '0x0', label: 'Delegate your UNI to yourself' }], note: 'Delegating to yourself keeps your tokens.' }; };
  governorsSvc.prepareVote = async input => { prepared.push(['vote', input]); return { chain: 'arbitrum', chain_id: '0xa4b1', atomic: false, calls: [{ to: '0x' + '7a'.repeat(20), data: '0x56781388', value: '0x0', label: 'Vote Against on "Transfer 1,800 ETH from the Treasury"' }], note: 'A vote onchain is a transaction.' }; };
  require('../../src/ai/claude').write = async () => ({ text: '## In one sentence\nIt sends **500,000 USDC** to the grants multisig.\n## Money and control\n- 500,000 USDC leaves the treasury', model: 'test-model' });
  const server = require('../../src/app').createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const { rows: [acct] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [wallet.address.toLowerCase()]);
  const token = require('../../src/auth/siwe').issueToken(acct);

  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.exposeFunction('__signTyped', async json => {
    const td = JSON.parse(json);
    const { EIP712Domain, ...types } = td.types;
    return wallet.signTypedData(td.domain, types, td.message);
  });
  await page.addInitScript(([addr, t]) => {
    sessionStorage.setItem('rb_token', t); sessionStorage.setItem('rb_wallet', addr);
    const provider = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr];
        if (method === 'eth_chainId') return window.__chain || '0x1';
        if (method === 'eth_signTypedData_v4') return window.__signTyped(params[1]);
        if (method === 'wallet_switchEthereumChain') { window.__chain = params[0].chainId; return null; }
        if (method === 'wallet_sendCalls') throw Object.assign(new Error('Method not supported'), { code: 4200 });
        if (method === 'eth_sendTransaction') { (window.__txs = window.__txs || []).push({ ...params[0], chain: window.__chain || '0x1' }); return '0x' + String(window.__txs.length).padStart(64, '0'); }
        if (method === 'eth_getTransactionReceipt') return { status: '0x1' };
        throw new Error('stand-in wallet: ' + method);
      },
    };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'test', name: 'Test Wallet' }, provider } })));
  }, [wallet.address, token]);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(url + '/governance');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.card')).borderTopWidth), '1px', 'the stylesheet loaded');
    await page.getByRole('button', { name: 'Connect Test Wallet' }).click();
    await page.fill('#g-wallet', wallet.address);
    await page.getByRole('button', { name: 'Check for free' }).click();
    await page.locator('#g-result', { hasText: 'Fund the grants program' }).waitFor();
    const text = await page.textContent('#g-result');
    assert.match(text, /Open votes3/);
    assert.match(text, /Your voting power: 1,234\.5/);
    assert.match(text, /Results so far \(not final\): For: 10 · Against: 5 · Abstain: 1/);
    console.log('✔ the open votes, with voting power and results so far');

    const first = page.locator(`#p-${open.id}`);
    await first.getByRole('button', { name: /What it would change/ }).click();
    await first.locator('.report', { hasText: 'It sends 500,000 USDC to the grants multisig' }).waitFor();
    assert.equal(await first.locator('.report strong').textContent(), '500,000 USDC', 'Markdown shown as text, safely');
    assert.match(await first.textContent(), /Paid with 1 free point/);
    console.log('✔ a summary of the proposal\'s own text, paid with a point');

    await first.getByLabel('For').check();
    await first.getByRole('button', { name: 'Sign my vote' }).click();
    await first.locator('.msg', { hasText: 'Voted: For' }).waitFor();
    assert.equal(relayed.length, 1);
    assert.equal(ethers.verifyTypedData(relayed[0].data.domain, relayed[0].data.types, relayed[0].data.message, relayed[0].sig), wallet.address);
    console.log('✔ a single-choice vote, signed by the wallet and sent to Snapshot');

    const second = page.locator(`#p-${approval.id}`);
    await second.getByLabel('Ann').check();
    await second.getByLabel('Cy').check();
    await second.getByRole('button', { name: 'Sign my vote' }).click();
    await second.locator('.msg', { hasText: 'Voted: Ann, Cy' }).waitFor();
    assert.deepEqual(relayed[1].data.message.choice, [1, 3]);
    console.log('✔ an approval vote for two choices');

    // On-chain: votes counting for nobody, and a delegation to yourself.
    const all = await page.textContent('#g-result');
    assert.match(all, /Uniswap: Your 120\.0 UNI count for nobody/);
    assert.match(all, /Arbitrum \(Treasury\) \(Arbitrum\): 50 ARB votes, delegated to yourself/);
    await page.getByRole('button', { name: 'Delegate to myself' }).click();
    await page.locator('.worst .msg', { hasText: 'Delegated to yourself' }).waitFor();
    assert.equal(prepared[0][0], 'delegate');
    assert.deepEqual([prepared[0][1].chain, prepared[0][1].governor], ['ethereum', GOVR]);
    console.log('✔ on-chain: tokens counting for nobody, and a delegation to yourself sent from the wallet');

    const oc = page.locator('#p-arbitrum-777');
    assert.match(await oc.textContent(), /If it passes, it moves funds\./);
    assert.match(await oc.textContent(), /\(estimated from block times\)/);
    await oc.locator('select').selectOption('0');
    await oc.getByRole('button', { name: 'Vote (sends a transaction)' }).click();
    await oc.locator('.msg', { hasText: 'Voted.' }).waitFor();
    assert.deepEqual([prepared[1][0], prepared[1][1].support, prepared[1][1].proposal_id], ['vote', 0, '777']);
    const txs = await page.evaluate(() => window.__txs);
    assert.deepEqual(txs.map(x => x.chain), ['0x1', '0xa4b1'], 'each sent on its governor\'s chain');
    console.log('✔ on-chain: a proposal\'s flagged action, and a vote sent as a transaction on its chain');

    await page.setViewportSize({ width: 375, height: 800 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), 'no sideways scrolling at phone width');
    console.log('✔ fits a phone screen');
    assert.deepEqual(errors, []);
    console.log('all passed');
  } finally {
    await browser.close();
    server.close();
    await db.getPool().end();
  }
})().catch(err => { console.error(err); process.exit(1); });
