/**
 * The admin panel, part 2, against a real Postgres: external services (a
 * switch and a daily limit that callers obey, key status without the key, the
 * Claude budget), the dashboard's figures, the health view's jobs, account
 * actions (credits, a refund once, a pass, a block), the site banner, and the
 * logged airdrop switch. Runs only when TEST_DATABASE_URL is set.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
const ADMIN = '0x' + 'ad'.repeat(20);
const USER = '0x' + 'ab'.repeat(20);
const SECRET = 'etherscan-secret-value-123';

test('admin panel: services, dashboard, health, accounts, banner', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test-secret', PUBLIC_URL: 'https://rektbull.test', NEW_WALLET_CHECK_CHAINS: '', ADMIN_WALLETS: ADMIN, ETHERSCAN_API_KEY: SECRET, PROVIDER_DAILY_LIMITS: '{"coingecko":100}' });
  delete process.env.RESEND_API_KEY;
  for (const k of Object.keys(require.cache)) if (k.includes('/src/')) delete require.cache[k];
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());
  require('../src/admin/settings').reset();

  const { issueToken } = require('../src/auth/siwe');
  const server = require('../src/app').createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { rows: [admin] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [ADMIN]);
  const { rows: [user] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [USER]);
  const call = async (method, p, body, token = issueToken(admin)) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* a page */ }
    return { status: r.status, body: json, text };
  };

  /* ── external services ── */
  const usage = require('../src/providers/usage');
  await usage.track('coingecko', async () => 'ok');
  await assert.rejects(usage.track('coingecko', async () => { throw new Error('upstream 500 apikey=abc123'); }));
  await new Promise(r => setTimeout(r, 100));
  const list = await call('GET', '/v1/admin/providers');
  assert.equal(list.status, 200);
  assert.ok(!list.text.includes(SECRET), 'a key is never sent');
  const eth = list.body.providers.find(p => p.name === 'etherscan');
  assert.deepEqual(eth.keys, [{ name: 'ETHERSCAN_API_KEY', set: true }]);
  assert.deepEqual(list.body.providers.find(p => p.name === 'resend').keys, [{ name: 'RESEND_API_KEY', set: false }]);
  const cg = list.body.providers.find(p => p.name === 'coingecko');
  assert.equal(cg.calls_today, 2);
  assert.equal(cg.errors_today, 1);
  assert.equal(cg.last_error, 'upstream 500 apikey=…', 'a key in an error is cut out');
  assert.equal(cg.limit, 100);

  assert.equal((await call('PUT', '/v1/admin/providers/coingecko', { off: true, reason: 'abuse test' })).status, 200);
  await assert.rejects(usage.track('coingecko', async () => 'never called'), e => e.isProviderLimit && /switched off in the admin panel/.test(e.message), 'callers see a refusal, so their fallback runs');
  await call('PUT', '/v1/admin/providers/coingecko', { off: false, daily_limit: 2, reason: 'tighter' });
  await assert.rejects(usage.track('coingecko', async () => 'x'), e => e.isProviderLimit, 'the admin\'s daily limit replaces the setting\'s');
  assert.equal((await call('PUT', '/v1/admin/providers/coingecko', { daily_limit: 0, reason: 'zero' })).status, 400);
  assert.equal((await call('PUT', '/v1/admin/providers/nope', { off: true, reason: 'nothing' })).status, 404);
  assert.equal((await call('PUT', '/v1/admin/providers/coingecko', { daily_usd: 5, reason: 'wrong' })).status, 400, 'only Claude has a budget');
  assert.equal((await call('POST', '/v1/admin/providers/goplus/test')).status, 400, 'no test call for it');
  require('../src/admin/providers').KNOWN.telegram.test = async () => { throw new Error('Telegram getMe: Unauthorized token=zzz'); };
  const tg = await call('POST', '/v1/admin/providers/telegram/test');
  assert.equal(tg.body.ok, false);
  assert.match(tg.body.error, /Unauthorized token=…/);

  // Claude: a daily budget, and a switch
  const claude = require('../src/ai/claude');
  await db.query(`INSERT INTO ai_usage (day, model, calls, input_tokens, output_tokens, cache_read_tokens) VALUES (CURRENT_DATE, 'claude-opus-5-5', 3, 100000, 100000, 0)`); // $2.40
  await call('PUT', '/v1/admin/providers/claude', { daily_usd: 2, reason: 'cap' });
  await assert.rejects(claude.refuseIfOverBudget(), /AI budget is used up/);
  await call('PUT', '/v1/admin/providers/claude', { daily_usd: 50, reason: 'raise' });
  await claude.refuseIfOverBudget();
  await call('PUT', '/v1/admin/providers/claude', { off: true, reason: 'incident' });
  await assert.rejects(claude.refuseIfOverBudget(), /AI runs are paused/);
  assert.equal((await call('GET', '/v1/admin/providers')).body.providers.find(p => p.name === 'claude').spent_today_usd, 2.4);

  /* ── the dashboard ── */
  const credits = require('../src/payments/credits');
  await credits.add(user.id, 2000, 'deposit', 'deposit:base:0xtx:0');
  await credits.add(user.id, 900, 'deposit', 'nowpayments:7');
  await db.query(`INSERT INTO runs (id, account_id, product, payment_method, price_cents, status) VALUES (gen_random_uuid(), NULL, 'token_report', 'x402', 300, 'succeeded'), (gen_random_uuid(), $1, 'token_report', 'credits', 300, 'failed')`, [user.id]);
  const runId = (await db.query(`INSERT INTO runs (id, account_id, product, payment_method, price_cents, status) VALUES (gen_random_uuid(), $1, 'approval_cleanup', 'credits', 100, 'succeeded') RETURNING id`, [user.id])).rows[0].id;
  await credits.spend(user.id, 100, 'run', `run:${runId}`);
  const x402Run = (await db.query(`SELECT id FROM runs WHERE payment_method = 'x402'`)).rows[0].id;
  const dash = (await call('GET', '/v1/admin/dashboard?days=7')).body;
  assert.deepEqual([dash.revenue.deposits_cents, dash.revenue.hosted_checkout_cents, dash.revenue.x402_cents, dash.revenue.total_cents], [2000, 900, 300, 3200]);
  assert.equal(dash.spent_from_credits.runs_cents, 100);
  assert.deepEqual(dash.failed_runs.map(f => [f.product, f.runs]), [['token_report', 1]]);
  assert.equal(dash.ai.total_usd, 2.4);
  assert.equal(dash.accounts.total, 2);

  /* ── health ── */
  const jobs = require('../src/admin/jobs');
  await jobs.run('alerts', async () => {});
  await jobs.run('monitor', async () => { throw new Error('RPC down'); });
  await new Promise(r => setTimeout(r, 100));
  const health = (await call('GET', '/v1/admin/health')).body;
  assert.equal(health.jobs.find(j => j.name === 'alerts').state, 'ok');
  assert.equal(health.jobs.find(j => j.name === 'monitor').state, 'late', 'it never worked, so it is late');
  assert.equal(health.jobs.find(j => j.name === 'monitor').last_error, 'RPC down');
  assert.equal(health.jobs.find(j => j.name === 'research').state, 'never');
  assert.ok(health.problems.includes('monitor: hasn\'t run'));
  assert.ok(health.problems.includes('coingecko: switched off') === false && health.problems.includes('claude: switched off'));

  /* ── accounts ── */
  const look = (await call('GET', `/v1/admin/accounts/${USER}`)).body;
  assert.equal(look.account.credits_cents, 2800);
  assert.equal((await call('GET', '/v1/admin/accounts/0x' + '99'.repeat(20))).status, 404);
  assert.match((await call('POST', `/v1/admin/accounts/${USER}/credits`, { cents: 60000, reason: 'too much' })).body.message, /\$500 an action/);
  assert.equal((await call('POST', `/v1/admin/accounts/${USER}/credits`, { cents: 500, reason: 'goodwill' })).body.credits_cents, 3300);
  assert.equal((await call('POST', `/v1/admin/accounts/${USER}/refund`, { run_id: runId, reason: 'report was wrong' })).body.refunded_cents, 100);
  assert.equal((await call('POST', `/v1/admin/accounts/${USER}/refund`, { run_id: runId, reason: 'again' })).status, 409, 'once only');
  assert.match((await call('POST', `/v1/admin/accounts/${USER}/refund`, { run_id: x402Run, reason: 'x' + 'yz' })).body.message, /No such run on this account/);
  const pass = (await call('POST', `/v1/admin/accounts/${user.id}/pass`, { days: 30, reason: 'beta tester' })).body;
  assert.ok(new Date(pass.pass_until) > new Date(Date.now() + 29 * 86400000));
  assert.ok(await require('../src/payments/passes').covering(user.id, 'token_quick_check'), 'the extended pass covers runs');
  const { rows: acctLog } = await db.query(`SELECT action FROM admin_log WHERE key = $1 ORDER BY id`, [`account:${user.id}`]);
  assert.deepEqual(acctLog.map(r => r.action), ['add_credits', 'refund_run', 'extend_pass']);

  assert.equal((await call('GET', '/v1/my-agents', null, issueToken(user))).status, 200);
  assert.match((await call('PUT', `/v1/admin/accounts/${ADMIN}/blocked`, { blocked: true, reason: 'self' })).body.message, /admin wallet can't be blocked/);
  await call('PUT', `/v1/admin/accounts/${USER}/blocked`, { blocked: true, reason: 'phishing reports' });
  assert.equal((await call('GET', '/v1/my-agents', null, issueToken(user))).status, 401, 'a blocked wallet is signed out');
  assert.ok((await call('GET', `/v1/admin/accounts/${USER}`)).body.account.blocked);
  await call('PUT', `/v1/admin/accounts/${USER}/blocked`, { blocked: false, reason: 'cleared' });
  assert.equal((await call('GET', '/v1/my-agents', null, issueToken(user))).status, 200);

  /* ── the banner ── */
  assert.match((await call('PUT', '/v1/admin/banner', { text: 'Claim here', link: 'https://evil.example', reason: 'test' })).body.message, /page on RektBull/);
  assert.match((await call('PUT', '/v1/admin/banner', { text: 'x', until: '2001-01-01', reason: 'test' })).body.message, /next 31 days/);
  await call('PUT', '/v1/admin/banner', { text: 'Maintenance <b>tonight</b> 22:00 UTC', level: 'warn', link: '/about', reason: 'db upgrade' });
  const home = await (await fetch(base + '/privacy')).text();
  assert.match(home, /<div class="site-banner warn" role="status"><div class="wrap">Maintenance &lt;b&gt;tonight&lt;\/b&gt; 22:00 UTC <a href="\/about">More<\/a><\/div><\/div>/, 'plain text, escaped');
  await call('PUT', '/v1/admin/banner', { text: '', reason: 'done' });
  const after = await (await fetch(base + '/privacy')).text();
  assert.ok(!after.includes('site-banner') && !after.includes('<!--#banner-->'));

  /* ── tools: the airdrop list, switched with a log row ── */
  const tools = (await call('GET', '/v1/admin/tools')).body;
  assert.deepEqual(tools.airdrops, []);
  assert.deepEqual(tools.hosted_invoices, []);
  assert.equal((await call('PUT', '/v1/admin/tools/airdrops/999', { active: false, reason: 'gone' })).status, 404);
});
