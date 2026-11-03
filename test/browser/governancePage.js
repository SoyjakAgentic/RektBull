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
        if (method === 'eth_chainId') return '0x1';
        if (method === 'eth_signTypedData_v4') return window.__signTyped(params[1]);
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
    assert.match(text, /Open votes2/);
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
