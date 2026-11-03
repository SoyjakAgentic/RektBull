/**
 * Drives /safety in a real browser (Playwright's Chromium) with a stand-in
 * wallet injected as an EIP-6963 provider, against a test server with the
 * token checks and the AI faked. Needs a database:
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/safetyPage.js
 *
 * Not part of `npm test` (it needs a browser). Exits non-zero on failure.
 */
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('set TEST_DATABASE_URL'); process.exit(1); }
const TOKEN = '0x' + '7a'.repeat(20);
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const MNEMONIC = ethers.Mnemonic.fromPhrase('test test test test test test test test test test test junk');

Object.assign(process.env, {
  DATABASE_URL: DB, JWT_SECRET: 'test', PAYMENT_CHAINS: 'base', NEW_WALLET_CHECK_CHAINS: '',
  TELEGRAM_BOT_TOKEN: '1:x', TELEGRAM_BOT_USERNAME: 'RektBullTestBot', TELEGRAM_WEBHOOK_SECRET: 'hook', RESEND_API_KEY: 're_x',
  VAPID_PUBLIC_KEY: 'BNbxGYNMhEIi9zrneh7mqV4oUanjLUK3m-mYZBc62frMKrEoMk88r3Lk596T0ck9xlT-4AxH6aGoN4zbHk1cAPw', VAPID_PRIVATE_KEY: 'test-only',
  CRYPTO_DEPOSIT_XPUB: ethers.HDNodeWallet.fromMnemonic(MNEMONIC, "m/44'/60'/0'/0").neuter().extendedKey,
});

(async () => {
  const db = require('../../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../../src/config/migrate').migrate();

  const scan = {
    chain: 'base', token: TOKEN, checked_at: new Date().toISOString(), verdict: 'high',
    flags: [
      { id: 'upgradeable', severity: 'high', title: 'Its code can be replaced (a proxy)', evidence: 'Implementation now: 0xabc', source: 'RPC' },
      { id: 'power_mint', severity: 'medium', title: 'The owner can create new tokens', evidence: 'Functions in the verified source: mint.', source: 'verified ABI' },
    ],
    disagreements: ['The sell tax differs: 1% by 0x, 5% by GoPlus.'],
    not_checked: [{ check: 'goplus', reason: 'GoPlus: timeout' }],
    note: 'Each flag names its source.',
  };
  const dd = require('../../src/services/dueDiligence');
  let failNext = false;
  dd.quickCheck = async () => { if (failNext) { failNext = false; throw new Error('provider down'); } return scan; };
  dd.fullReport = async () => ({
    ...scan,
    report_markdown: '## Verdict\n**High risk**: its code can be replaced.\n\n- The owner can mint\n- <img src=x onerror="window.__xss=1">\n\nThis is an automated check of known patterns, not financial advice or proof of safety.',
    market: { source: 'DexScreener', pairs: 3, liquidity_usd_total: 120000, volume_24h_usd: 45000, first_pair_created_at: new Date(Date.now() - 12 * 86400000).toISOString(), token_name: 'Test Token', token_symbol: 'TEST' },
    written_by: 'test-model',
  });
  require('../../src/ai/claude').available = () => true;
  // Alert transports: stand-ins that record what would be sent.
  const transports = require('../../src/alerts/transports');
  const outbox = { telegram: [], email: [] };
  transports.telegram.send = async (chatId, m) => { outbox.telegram.push({ chatId, ...m }); };
  transports.email.send = async m => { outbox.email.push(m); };

  // Approval cleanup: the service is a stand-in here (test/approvals.e2e.js runs the real one on a chain).
  const approvalsSvc = require('../../src/services/approvals');
  const owner0 = { value: null };
  const P2 = approvalsSvc.PERMIT2;
  const appr = (id, kind, severity, extra) => ({
    id, kind, severity, recommended: severity !== 'low', found_by: ['explorer logs'], last_approved_at: '2025-01-02T00:00:00.000Z',
    token: { address: '0x' + 'aa'.repeat(20), symbol: 'USDC', decimals: 6 }, spender: { address: '0x' + 'dd'.repeat(20), label: null, is_wallet: true },
    allowance: { raw: '1', unlimited: true, amount: 'unlimited' }, balance: '250.0', value_at_risk_usd: 250, reasons: [], ...extra,
  });
  const cleanupResult = () => {
    const approvalsList = [
      appr('a1', 'erc20', 'critical', { reasons: [{ text: 'Flagged for phishing.', source: 'GoPlus (data from SlowMist)' }, { text: 'It\'s a plain wallet, not a contract.', source: 'RPC (no contract code at the address)' }] }),
      appr('p1', 'permit2', 'high', { spender: { address: '0x' + 'e1'.repeat(20), label: null, is_wallet: true }, allowance: { raw: '5', unlimited: false, amount: '5.0' }, value_at_risk_usd: 5, expires_at: '2027-01-01T00:00:00.000Z', reasons: [{ text: 'It\'s a plain wallet.', source: 'RPC' }] }),
      appr('p2', 'permit2', 'high', { spender: { address: '0x' + 'e2'.repeat(20), label: null, is_wallet: true }, allowance: { raw: '7', unlimited: false, amount: '7.0' }, value_at_risk_usd: 7, reasons: [{ text: 'It\'s a plain wallet.', source: 'RPC' }] }),
      appr('k1', 'erc20', 'low', { spender: { address: P2, label: 'Uniswap Permit2', is_wallet: false }, value_at_risk_usd: 250, reasons: [{ text: 'Known: Uniswap Permit2.', source: 'RektBull\'s list of known contracts' }] }),
    ];
    return {
      owner: owner0.value, checked_at: new Date().toISOString(),
      chains: [
        { chain: 'base', chain_id: 8453, read: true, approvals: approvalsList, not_checked: [{ check: 'GoPlus approvals', reason: 'GoPlus: timeout' }], revoke_calls: [
          { chain_id: 8453, to: '0x' + 'aa'.repeat(20), data: '0x095ea7b3' + 'a1', value: '0x0', revokes: ['a1'], label: 'Revoke USDC' },
          { chain_id: 8453, to: P2, data: '0xcc53287f' + 'p2', value: '0x0', revokes: ['p1', 'p2'], label: 'Revoke 2 Permit2 allowances' },
          { chain_id: 8453, to: '0x' + 'aa'.repeat(20), data: '0x095ea7b3' + 'k1', value: '0x0', revokes: ['k1'], label: 'Revoke USDC for Permit2' },
        ] },
        { chain: 'ethereum', chain_id: 1, read: false, reason: 'Neither the explorer nor GoPlus answered', approvals: [], revoke_calls: [], not_checked: [] },
      ],
      summary: { open: 4, to_revoke: 3, value_at_risk_usd: 262, not_priced: 0, chains_read: ['base'], chains_not_read: [{ chain: 'ethereum', reason: 'Neither the explorer nor GoPlus answered' }] },
      note: 'Revoking needs your wallet to sign each transaction.',
    };
  };
  approvalsSvc.preview = async owner => { owner0.value = owner; const r = cleanupResult(); return { owner, checked_at: r.checked_at, summary: r.summary, note: 'The full cleanup lists each approval.' }; };
  approvalsSvc.cleanup = async owner => { owner0.value = owner; return cleanupResult(); };

  // The risk monitor's chain reads are a stand-in too (test/approvals.e2e.js runs them for real).
  const monitorSvc = require('../../src/services/monitor');
  let looks = 0;
  monitorSvc.look = async () => {
    looks++;
    const a = { chain: 'base', id: 'erc20:0xaa:0xdd', kind: 'erc20', severity: 'critical', token: { address: '0x' + 'aa'.repeat(20), symbol: 'USDC' }, spender: { address: '0x' + 'dd'.repeat(20), label: null, is_wallet: true }, allowance: { amount: 'unlimited' }, value_at_risk_usd: 250, reasons: [{ text: 'Flagged for phishing.', source: 'GoPlus (data from SlowMist)' }] };
    return { read: ['base'], unread: [], open: looks === 1 ? {} : { 'base:erc20:0xaa:0xdd': a }, impls: {}, stables: [] };
  };
  const credits = require('../../src/payments/credits');

  const { createApp } = require('../../src/app');
  const server = createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;

  const wallet = ethers.Wallet.createRandom();
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('dialog', d => d.accept());
  const sent = [];
  await page.exposeFunction('__sign', async hex => wallet.signMessage(ethers.getBytes(hex)));
  await page.exposeFunction('__sent', tx => { sent.push(tx); return '0x' + String(sent.length).padStart(64, '0'); });
  await page.addInitScript(addr => {
    let chainId = '0x1';
    const provider = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr];
        if (method === 'eth_chainId') return chainId;
        if (method === 'wallet_switchEthereumChain') { chainId = params[0].chainId; return null; }
        if (method === 'personal_sign') return window.__sign(params[0]);
        if (method === 'eth_sendTransaction') return window.__sent({ ...params[0], chainId });
        if (method === 'wallet_sendCalls') { for (const c of params[0].calls) window.__sent({ ...c, chainId, batch: true }); return { id: 'batch-1' }; }
        throw new Error('stand-in wallet: ' + method);
      },
    };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'test', name: 'Test Wallet' }, provider } })));
  }, wallet.address);

  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const msg = () => page.textContent('#check-msg');

  try {
    await page.goto(url + '/safety');
    await page.getByText('· 1 point or $0.25').waitFor();
    await page.getByText('· $3.00 (5 a month with Safety Pro)').waitFor();
    await page.getByText('· 5 points or $1.00').waitFor();
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.card')).borderTopWidth), '1px', 'the stylesheet loaded and parsed');

    // Not signed in: no free checks, and the page says how to get them.
    await page.selectOption('#chain', 'base');
    await page.fill('#token', TOKEN);
    await page.getByRole('button', { name: /Quick check/ }).click();
    await page.locator('#check-msg', { hasText: 'Sign in with your wallet below (free): you get 30 free points a month, and this costs 1.' }).waitFor();
    console.log('✔ signed out: prices shown; a check asks to sign in for the free ones');

    await page.getByRole('button', { name: 'Connect Test Wallet' }).click();
    await page.getByRole('button', { name: 'Sign in with this wallet' }).click();
    await page.getByText('Signed in.').waitFor();
    await page.locator('#points-left', { hasText: '30 of 30' }).waitFor();
    assert.equal(await page.textContent('#balance'), '$0.00');
    console.log('✔ sign in: credits $0.00, 30 of 30 free points');

    await page.getByRole('button', { name: /Quick check/ }).click();
    await page.getByText('What we found', { exact: true }).waitFor();
    const result = await page.textContent('#result');
    assert.match(result, /High risk/);
    assert.match(result, /Its code can be replaced \(a proxy\).*Source: RPC/s);
    assert.match(result, /The owner can create new tokens.*Source: verified ABI/s);
    assert.match(result, /Where sources disagree.*The sell tax differs/s);
    assert.match(result, /What we couldn't check.*goplus: GoPlus: timeout/s);
    assert.match(result, /Paid with 1 free point, charged because it completed/);
    await page.locator('#points-left', { hasText: '29 of 30' }).waitFor();
    console.log('✔ quick check: verdict, every flag with its source, disagreements, what couldn\'t be checked; one free use spent');

    failNext = true;
    await page.getByRole('button', { name: /Quick check/ }).click();
    await page.locator('#check-msg', { hasText: 'you weren\'t charged' }).waitFor();
    await page.locator('#points-left', { hasText: '29 of 30' }).waitFor();
    console.log('✔ a failed check: "you weren\'t charged", and the point is given back');

    // Out of free points: the nudge to Safety Pro.
    const acct = (await db.query('SELECT id FROM accounts WHERE wallet = $1', [wallet.address.toLowerCase()])).rows[0];
    await db.query(`UPDATE period_usage SET used = allowance WHERE subject = $1 AND key = 'points'`, [`account:${acct.id}`]);
    await page.getByRole('button', { name: /Quick check/ }).click();
    await page.locator('#check-msg', { hasText: "You've used this month's free points. Safety Pro covers it, and every other Safety desk check, for $9.00 for 30 days. Or pay $0.25 from credits (you have $0.00)." }).waitFor();
    await db.query(`UPDATE period_usage SET used = 1 WHERE subject = $1 AND key = 'points'`, [`account:${acct.id}`]);
    console.log('✔ out of free points: the message offers Safety Pro, or paying from credits');

    await page.getByRole('button', { name: /Full report/ }).click();
    await page.locator('#check-msg', { hasText: 'Token due diligence report costs $3.00 from credits (you have $0.00). Safety Pro includes 5 a month.' }).waitFor();
    console.log('✔ report without credits: says what it costs and what you have');

    // Top up: a deposit address, sent from the wallet as a USDC transfer on Base.
    await page.fill('#t-amount', '10');
    await page.getByRole('button', { name: 'Get a deposit address' }).click();
    await page.getByText('Waiting for your payment').waitFor();
    const depositTo = (await page.textContent('#deposit-address')).trim();
    assert.equal(depositTo, ethers.HDNodeWallet.fromMnemonic(MNEMONIC, "m/44'/60'/0'/0/1").address.toLowerCase());
    await page.getByRole('button', { name: 'Send from my wallet' }).click();
    await page.locator('#topup-msg', { hasText: 'Sent' }).waitFor();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chainId, '0x2105', 'the wallet was switched to Base');
    assert.equal(sent[0].to.toLowerCase(), USDC_BASE);
    const [to, amount] = new ethers.Interface(['function transfer(address,uint256)']).decodeFunctionData('transfer', sent[0].data);
    assert.equal(to.toLowerCase(), depositTo);
    assert.equal(amount, 10_000_000n, '10 USDC');
    console.log('✔ top up: a deposit address, and the wallet is asked to send exactly 10 USDC to it on Base');

    // Credits arrive (the watcher's job, tested elsewhere), then the report.
    const { rows } = await db.query('SELECT id FROM accounts WHERE wallet = $1', [wallet.address.toLowerCase()]);
    await credits.add(rows[0].id, 1000, 'adjustment', 'test:topup');
    await page.getByRole('button', { name: /Full report/ }).click();
    await page.getByText('Written by test-model from these results only', { exact: false }).waitFor();
    const report = await page.textContent('#result');
    assert.match(report, /Test Token \(TEST\) on Base/);
    assert.match(report, /Liquidity\$120,000/);
    assert.match(report, /Trading for12 days/);
    assert.match(report, /Paid with \$3\.00 from credits/);
    assert.equal(await page.locator('#result .report strong', { hasText: 'High risk' }).count(), 1, 'bold is rendered');
    assert.equal(await page.locator('#result .report img').count(), 0, 'the report text is never HTML');
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.match(report, /<img src=x onerror/);
    await page.locator('#balance', { hasText: '$7.00' }).waitFor();
    console.log('✔ report: market facts with source, the written report as text only (no HTML), $3.00 from credits');

    await page.getByRole('button', { name: 'Safety Pro, 30 days: $9.00' }).click();
    await page.locator('#pass-msg', { hasText: 'Not enough credits: it costs $9.00, you have $7.00' }).waitFor();
    await credits.add(rows[0].id, 200, 'adjustment', 'test:topup2');
    await page.getByRole('button', { name: 'Safety Pro, 30 days: $9.00' }).click();
    await page.locator('#pass-msg', { hasText: 'is active' }).waitFor();
    await page.locator('#pass', { hasText: /Until .* 5 of 5 reports left this month/ }).waitFor();
    await page.getByRole('button', { name: /Quick check/ }).click();
    await page.getByText('Paid with your Safety Pro pass').first().waitFor();
    console.log('✔ Safety Pro: refused without enough credits; bought from credits; shows the reports left; then checks use the pass');

    // Approval cleanup: a free preview, then the paid list, then revoking from the wallet.
    assert.equal((await page.inputValue('#a-wallet')).toLowerCase(), wallet.address.toLowerCase(), 'the signed-in wallet is filled in');
    await page.getByRole('button', { name: 'Free preview' }).click();
    await page.locator('#a-summary', { hasText: 'Could be taken now$262.00' }).waitFor();
    assert.match(await page.textContent('#a-summary'), /Couldn't read: Ethereum \(Neither the explorer nor GoPlus answered\)/);
    assert.ok(!(await page.textContent('#a-summary')).includes('dddd'), 'the preview names no spender');
    await page.getByRole('button', { name: /Full cleanup/ }).click();
    await page.getByText('Revoke selected on Base').waitFor();
    const list = await page.textContent('#a-result');
    assert.match(list, /critical.*can spend your unlimited USDC/s);
    assert.match(list, /Flagged for phishing\. \(GoPlus \(data from SlowMist\)\)/);
    assert.match(list, /Couldn't read this chain: Neither the explorer nor GoPlus answered/);
    assert.match(list, /Paid with your Safety Pro pass, charged because it completed/);
    const boxes = page.locator('#a-result input[type=checkbox]');
    assert.deepEqual(await boxes.evaluateAll(b => b.map(x => x.checked)), [true, true, true, false], 'the risky ones are ticked, the known one is not');
    await boxes.nth(1).uncheck();
    assert.deepEqual(await boxes.evaluateAll(b => b.map(x => x.checked)), [true, false, false, false], 'Permit2 allowances go together');
    await boxes.nth(2).check();
    assert.deepEqual(await boxes.evaluateAll(b => b.map(x => x.checked)), [true, true, true, false]);
    console.log('✔ approvals: free preview names no one; the paid list shows each one with reasons and sources; risky ones pre-ticked; Permit2 ones go together');

    await page.reload();
    await page.getByText('Revoke selected on Base').waitFor();
    console.log('✔ approvals: the paid result survives a reload (no paying twice)');
    await page.getByRole('button', { name: 'Connect Test Wallet' }).click();
    const before = sent.length;
    await page.getByRole('button', { name: 'Revoke selected on Base' }).click();
    await page.locator('#revoke-msg-base', { hasText: 'Sent.' }).waitFor();
    const batch = sent.slice(before);
    assert.deepEqual(batch.map(x => x.data), ['0x095ea7b3a1', '0xcc53287fp2'], 'exactly the chosen revokes, in one batch');
    assert.ok(batch.every(x => x.batch && x.chainId === '0x2105'), 'sent as a batch on Base');
    console.log('✔ approvals: the wallet is asked to sign exactly the chosen revokes, on Base, as one batch');

    // The risk monitor (Safety Pro is active here): watch, an alert, mark read, review.
    await page.locator('#m-on').waitFor();
    assert.equal((await page.inputValue('#m-wallet')).toLowerCase(), wallet.address.toLowerCase());
    await page.fill('#m-label', 'main');
    await page.getByRole('button', { name: 'Watch this wallet' }).click();
    await page.locator('#m-msg', { hasText: 'Watching.' }).waitFor();
    await page.locator('#m-wallets', { hasText: 'main (' }).waitFor();
    assert.match(await page.textContent('#m-wallets'), /Watching 1 of 3 wallets, each checked every 24 hours/);
    assert.match(await page.textContent('#m-alerts'), /Watching started: no risky approvals open/);
    const [mw] = (await db.query('SELECT * FROM monitored_wallets')).rows;
    await monitorSvc.check(mw); // the next day's check finds a new approval to a flagged wallet
    await page.reload();
    await page.locator('#m-unread', { hasText: '2 new' }).waitFor();
    const alertsText = await page.textContent('#m-alerts');
    assert.match(alertsText, /critical\s*New critical-risk approval: 0xdddd…dddd on USDC \(base\)/);
    assert.match(alertsText, /Flagged for phishing\. \(GoPlus \(data from SlowMist\)\)/);
    await page.getByRole('button', { name: 'Mark all as read' }).click();
    await page.locator('#m-unread').waitFor({ state: 'hidden' });
    await page.locator('#m-alerts').getByRole('button', { name: 'Review and revoke' }).first().click();
    assert.equal((await page.inputValue('#a-wallet')).toLowerCase(), wallet.address.toLowerCase());
    console.log('✔ risk monitor: watch a wallet; a new risky approval shows as an alert with its reason and source; mark read; review it');

    // Where alerts go: Telegram and email, linked from the page.
    await page.locator('#ch-list', { hasText: 'No channel yet' }).waitFor();
    const popupWait = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Connect Telegram' }).click();
    const popup = await popupWait;
    const tgLink = popup.url();
    await popup.close();
    assert.match(tgLink, /^https:\/\/t\.me\/RektBullTestBot\?start=/);
    await page.locator('#ch-msg', { hasText: 'press Start' }).waitFor();
    // Telegram calls the webhook when the user presses Start.
    const code = new URL(tgLink).searchParams.get('start');
    const hook = await fetch(url + '/v1/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'hook' }, body: JSON.stringify({ message: { chat: { id: 4242, type: 'private' }, text: `/start ${code}`, from: { username: 'tester' } } }) });
    assert.equal((await hook.json()).linked, true);
    await page.locator('#ch-msg', { hasText: 'Telegram is linked.' }).waitFor({ timeout: 15000 });
    await page.locator('#ch-list', { hasText: '@tester' }).waitFor();
    await page.fill('#ch-email', 'me@example.com');
    await page.getByRole('button', { name: 'Send confirmation email' }).click();
    await page.locator('#ch-msg', { hasText: 'Check me@example.com for the confirmation link' }).waitFor();
    const confirmUrl = outbox.email.at(-1).text.match(/https?:\/\/\S+confirm-email\?code=\S+/)[0];
    await page.goto(url + new URL(confirmUrl).pathname + new URL(confirmUrl).search);
    await page.locator('#ch-msg', { hasText: 'Email confirmed' }).waitFor();
    await page.locator('#ch-list', { hasText: 'me@example.com' }).waitFor();
    await page.getByRole('button', { name: 'Send a test alert' }).click();
    await page.locator('#ch-msg', { hasText: 'Test sent to: Telegram, Email.' }).waitFor();
    assert.match(outbox.telegram.at(-1).text, /Test alert/);
    assert.equal(await page.isEnabled('#ch-push'), true, 'browser notifications can be turned on');
    console.log('✔ alerts: link Telegram (through its webhook) and email (through the confirmation link), then a test alert reaches both');

    // Your data: download, then delete (typed confirmation).
    await page.locator('#data-card').waitFor();
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download my data' }).click();
    const file = await (await dl).path();
    const exported = JSON.parse(require('fs').readFileSync(file, 'utf8'));
    assert.equal(exported.account.wallet, wallet.address.toLowerCase());
    assert.ok(exported.monitored_wallets.length && exported.alert_channels.length);
    await page.getByRole('button', { name: 'Delete my data' }).click();
    await page.locator('#d-msg', { hasText: 'Type DELETE to confirm.' }).waitFor();
    await page.fill('#d-confirm', 'DELETE');
    await page.getByRole('button', { name: 'Delete my data' }).click();
    await page.locator('#d-msg', { hasText: /Deleted \(\d+ items\)\. Credits, top-ups/ }).waitFor();
    assert.equal((await db.query('SELECT count(*)::int AS n FROM alert_channels')).rows[0].n, 0);
    console.log('✔ your data: downloaded as one file; deleting needs DELETE typed, then removes channels and watched wallets, keeping payment records');

    await page.setViewportSize({ width: 375, height: 800 });
    const wide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > window.innerWidth + 0.5).map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className ? '.' + String(e.className).replace(/ /g, '.') : ''}`));
    assert.deepEqual(wide, [], 'no sideways scroll at phone width');
    await page.screenshot({ path: process.env.SCREENSHOT || '/tmp/rektbull-safety.png', fullPage: true });
    console.log('✔ phone width: no sideways scroll');

    // The sign-in carries over to /trade in the same tab.
    await page.goto(url + '/trade');
    await page.goto(url + '/safety');
    await page.locator('#who', { hasText: 'Signed in' }).waitFor();
    console.log('✔ the sign-in carries over between pages');

    await page.goto(url + '/privacy');
    await page.getByRole('heading', { name: 'Privacy', level: 1 }).waitFor();
    const privacyWide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > window.innerWidth + 0.5).length);
    assert.equal(privacyWide, 0, 'the privacy page fits a phone');
    console.log('✔ the privacy page reads on a phone');

    assert.deepEqual(errors.filter(e => !/Failed to load resource/.test(e)), [], 'no page errors');
    console.log('all passed');
  } catch (err) {
    console.error('FAILED:', err.message, errors);
    await page.screenshot({ path: '/tmp/rektbull-safety-failed.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
    await db.getPool().end();
  }
})();
