/**
 * The RektBull extension in a real Chromium: linked from /extension, then a
 * test dapp (another origin, with a stand-in wallet) asks to sign things.
 * The RektBull server runs the real pre-sign check with the chain and GoPlus
 * played by stand-ins. Needs a database:
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/extension.js
 *
 * Not part of `npm test` (it needs a browser). Exits non-zero on failure.
 */
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('set TEST_DATABASE_URL'); process.exit(1); }
Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '' });

const EXT = path.join(__dirname, '..', '..', 'extension');
const ME = '0x' + '11'.repeat(20);
const DRAINER = '0x' + 'dd'.repeat(20);
const ROUTER = '0x' + 'aa'.repeat(20);
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

// The text on screen, including inside RektBull's closed shadow root (which page scripts can't read),
// through the DevTools protocol, as a screen reader would get it.
async function screenText(page) {
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const out = [];
  const walk = n => {
    if (n.nodeType === 3 && n.nodeValue.trim()) out.push(n.nodeValue.trim());
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
  };
  walk(root);
  await cdp.detach();
  return out.join(' ');
}

(async () => {
  const db = require('../../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../../src/config/migrate').migrate();

  // The chain and GoPlus, as stand-ins.
  const rpc = require('../../src/providers/rpc');
  const goplus = require('../../src/providers/goplus');
  rpc.evmRpc = async (chain, method, params) => {
    if (method === 'eth_getCode') return [DRAINER, ME].includes(params[0]) ? '0x' : '0x6080';
    if (method === 'eth_simulateV1') return [{ calls: [{ status: '0x1', logs: [] }] }];
    if (method === 'eth_call') return ethers.toBeHex(6, 32);
    throw new Error(`unexpected ${method}`);
  };
  goplus.phishingSite = async () => ({ source: 'GoPlus phishing site list', phishing: false });
  goplus.addressRisk = async (chain, a) => ({ source: 'GoPlus (data from SlowMist)', flags: a === DRAINER ? ['phishing'] : [] });
  goplus.contractRisk = async (chain, a) => (a === ROUTER ? { source: 'GoPlus', known: true, open_source: true, trusted: true, name: 'Uniswap Router', malicious: [] } : { source: 'GoPlus', known: false, malicious: [] });
  require('../../src/providers/prices').usdPrices = async () => ({});
  require('../../src/providers/signatures').functionName = async () => null;
  let checks = 0;
  const presign = require('../../src/services/presign');
  const realCheck = presign.check;
  presign.check = input => { checks++; return realCheck(input); };

  const { createApp } = require('../../src/app');
  const app = createApp().listen(0);
  const api = `http://127.0.0.1:${app.address().port}`;
  const { rows: [acct] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [ME]);
  const session = require('../../src/auth/siwe').issueToken(acct);

  // A dapp on another origin, with a stand-in wallet (window.ethereum, and a second one through EIP-6963).
  const dapp = http.createServer((q, r) => {
    r.setHeader('content-type', 'text/html');
    r.end(`<!doctype html><title>Test dapp</title><body><h1>Test dapp</h1><script>
      window.__walletGot = [];
      const wallet = name => ({ name, request: async ({ method, params }) => {
        if (method === 'eth_chainId') return '0x2105';
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return ['${ME}'];
        window.__walletGot.push({ name, method });
        return '0x' + 'ab'.repeat(32);
      } });
      window.ethereum = wallet('injected');
      const second = wallet('6963');
      window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'x', name: 'Second' }, provider: second }) })));
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'x', name: 'Second' }, provider: second }) }));
      window.__second = second;
      window.__try = async (p, args) => { try { return { ok: await p.request(args) }; } catch (e) { return { error: e.message, code: e.code }; } };
    </script></body>`);
  }).listen(0);
  const dappUrl = `http://localhost:${dapp.address().port}/`;

  const { chromium } = require('playwright');
  const ctx = await chromium.launchPersistentContext('', { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  await sw.evaluate(base => chrome.storage.local.set({ apiBase: base }), api);
  const errors = [];

  try {
    // ── Link from rektbull.com/extension ──
    const site = await ctx.newPage();
    site.on('pageerror', e => errors.push(e.message));
    await site.addInitScript(([t, w]) => { sessionStorage.setItem('rb_token', t); sessionStorage.setItem('rb_wallet', w); }, [session, ME]);
    await site.goto(api + '/extension');
    await site.locator('#ext-state', { hasText: 'The extension is installed (version 0.1.0)' }).waitFor();
    await site.getByRole('button', { name: "Link this browser's extension" }).click();
    await site.locator('#link-msg', { hasText: 'Linked. The extension now checks requests' }).waitFor();
    await site.locator('#tokens', { hasText: 'Chrome' }).waitFor();
    assert.ok((await sw.evaluate(() => chrome.storage.local.get('token'))).token, 'the extension holds a token');
    console.log('✔ linked from /extension: the page sees the extension, gets a token for it, and lists the browser');

    // ── A risky request: stopped with the reasons, cancelled ──
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(dappUrl);
    const approve = spender => new ethers.Interface(['function approve(address,uint256)']).encodeFunctionData('approve', [spender, ethers.MaxUint256]);
    const risky = page.evaluate(([data, usdc]) => window.__try(window.ethereum, { method: 'eth_sendTransaction', params: [{ to: usdc, data }] }), [approve(DRAINER), USDC]);
    await page.waitForFunction(() => document.querySelector('rektbull-warning'));
    const shown = await screenText(page);
    assert.match(shown, /Don't sign this unless you're sure/);
    assert.match(shown, /CRITICAL: Token approval: 0xdddd…dddd could spend all of this token/);
    assert.match(shown, /Source: .*SlowMist/);
    // A page faking RektBull's answer is ignored.
    await page.evaluate(() => window.postMessage({ rektbull: 'decision', body: JSON.stringify({ id: 'anything', action: 'allow' }), mac: '0'.repeat(64) }, '*'));
    await page.keyboard.press('Enter'); // Cancel has the focus
    assert.deepEqual(await risky, { error: 'User rejected the request (stopped by RektBull).', code: 4001 });
    assert.deepEqual(await page.evaluate(() => window.__walletGot), [], 'the wallet never saw it');
    console.log('✔ a risky approval stops with a warning (reasons and sources); Cancel rejects it like a wallet would (4001); a faked answer is ignored');

    // ── A safe request: straight to the wallet ──
    const safe = await page.evaluate(([data, usdc]) => window.__try(window.ethereum, { method: 'eth_sendTransaction', params: [{ to: usdc, data }] }), [approve(ROUTER), USDC]);
    assert.ok(safe.ok);
    assert.deepEqual(await page.evaluate(() => window.__walletGot.map(x => x.method)), ['eth_sendTransaction']);
    console.log('✔ a safe approval goes straight to the wallet');

    // ── Critical, and the user insists: only after ticking "I understand" ──
    const insist = page.evaluate(([data, usdc]) => window.__try(window.ethereum, { method: 'eth_sendTransaction', params: [{ to: usdc, data }] }), [approve(DRAINER), USDC]);
    await page.waitForFunction(() => document.querySelector('rektbull-warning'));
    await page.keyboard.press('Shift+Tab'); // to the checkbox
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab'); // Cancel
    await page.keyboard.press('Tab'); // Continue, now enabled
    await page.keyboard.press('Enter');
    assert.ok((await insist).ok, 'the user can still go on to the wallet');
    console.log('✔ on a critical warning, going on needs "I understand" first, then the wallet gets it');

    // ── EIP-6963 wallets too, and signatures: a sign-in for another site ──
    const siwe = ethers.hexlify(ethers.toUtf8Bytes('uniswap.org wants you to sign in with your Ethereum account:\n' + ME));
    const other = page.evaluate(([m, me]) => window.__try(window.__second, { method: 'personal_sign', params: [m, me] }), [siwe, ME]);
    await page.waitForFunction(() => document.querySelector('rektbull-warning'));
    assert.match(await screenText(page), /This sign-in is for uniswap\.org, but localhost:\d+ is asking/);
    await page.keyboard.press('Enter');
    assert.equal((await other).code, 4001);
    console.log('✔ an EIP-6963 wallet is covered too: a sign-in for another site is stopped');

    // ── Forged check requests from the page don't reach RektBull ──
    const before = checks;
    await page.evaluate(() => { for (let i = 0; i < 5; i++) window.postMessage({ rektbull: 'check', body: JSON.stringify({ id: String(i), method: 'eth_sign', params: [] }), mac: 'f'.repeat(64) }, '*'); });
    await page.waitForTimeout(500);
    assert.equal(checks, before, 'unsigned check requests are ignored (no checks spent)');
    console.log('✔ a page can\'t fake check requests to spend the user\'s checks');

    // ── The popup ──
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.locator('#status', { hasText: /Checking requests for 0x1111…1111\. \d+ of 30 free checks left this month/ }).waitFor();
    console.log('✔ the popup shows the linked wallet and the free checks left');

    // ── Unlinked: requests pass, with a note ──
    await sw.evaluate(() => chrome.storage.local.remove('token'));
    const unlinked = await page.evaluate(([data, usdc]) => window.__try(window.ethereum, { method: 'eth_sendTransaction', params: [{ to: usdc, data }] }), [approve(DRAINER), USDC]);
    assert.ok(unlinked.ok, 'without a link, nothing is blocked');
    await page.waitForFunction(() => document.querySelector('rektbull-toast'));
    assert.match(await screenText(page), /RektBull couldn't check this: link the extension/);
    console.log('✔ unlinked, requests go through with a note to link the extension');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('all passed');
  } catch (err) {
    console.error('FAILED:', err.message, errors);
    for (const p of ctx.pages()) await p.screenshot({ path: `/tmp/rektbull-ext-failed-${ctx.pages().indexOf(p)}.png` }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await ctx.close();
    app.close(); dapp.close();
    await db.getPool().end();
  }
})();
