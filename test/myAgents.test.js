/**
 * AI agents against a real Postgres, with the desks' checks as stand-ins:
 * the catalog, switches and schedules (and what's refused), the scheduled
 * agents run by the worker (wallet checkup, claim assistant, token watch),
 * each alert raised once and sent to the linked channel with its sources,
 * a failed run kept for retry, the jobs that already ran elsewhere obeying
 * their switch (wallet guardian, DAO votes, yield watch, trading exits).
 * Runs only when TEST_DATABASE_URL is set.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;

test('AI agents: switches, schedules, scheduled runs and their alerts', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test-secret', PUBLIC_URL: 'https://rektbull.test', NEW_WALLET_CHECK_CHAINS: '', TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_BOT_USERNAME: 'RektBullTestBot', TELEGRAM_WEBHOOK_SECRET: 'hook-secret' });
  for (const k of Object.keys(require.cache)) if (k.includes('/src/')) delete require.cache[k];

  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());

  const transports = require('../src/alerts/transports');
  const sent = [];
  transports.telegram.send = async (chatId, m) => { sent.push({ chatId, ...m }); };
  const dispatch = require('../src/alerts/dispatch');
  const myAgents = require('../src/services/myAgents');

  // The desks' checks, as stand-ins.
  const home = require('../src/services/home');
  let checkup = { approvals: ['bad', '2 approvals worth revoking, of 9 open'], claims: ['ok', 'Nothing unclaimed in the sources checked'] };
  home.checkup = async wallet => ({
    wallet, checked_at: new Date().toISOString(),
    parts: [
      ...Object.entries(checkup).map(([id, [status, headline]]) => ({ id, title: id === 'approvals' ? 'What apps can still take' : 'Unclaimed airdrops and rewards', ok: true, status, headline, source: `${id} source`, href: `/${id}` })),
      { id: 'governance', title: 'DAO votes', ok: false, status: 'unknown', headline: 'Couldn\'t be checked just now', reason: 'Snapshot didn\'t answer' },
    ],
  });
  const claims = require('../src/services/claims');
  let claimItems = [{ id: 'merkl:8453:0xabc', name: 'MORPHO rewards from 2 Merkl campaigns', chain: 'base', status: 'claimable', claimable_raw: '1000', claimable_usd: 12.5, source_label: 'Merkl rewards' }];
  claims.check = async () => ({ items: claimItems, not_checked: [] });
  const tokenRisk = require('../src/services/tokenRisk');
  let flags = [{ id: 'tax', severity: 'medium', title: 'It taxes trades: 6% to buy, 6% to sell', evidence: 'The higher of 0x\'s and GoPlus\'s figures.', source: '0x quote / GoPlus' }];
  tokenRisk.scanToken = async ({ chain, token_address }) => ({ chain, token: token_address, verdict: 'medium', flags });

  const { createApp } = require('../src/app');
  const { issueToken } = require('../src/auth/siwe');
  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { rows: [acct] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', ['0x' + 'ab'.repeat(20)]);
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${issueToken(acct)}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  await db.query(`INSERT INTO alert_channels (account_id, kind, target, label, verified_at, min_severity) VALUES ($1, 'telegram', '777', '@me', now(), 'low')`, [acct.id]);
  const due = () => db.query('UPDATE agent_settings SET next_run_at = now() - interval \'1 minute\'');

  /* ── the catalog, and an account's agents ── */
  const cat = (await (await fetch(base + '/v1/my-agents/catalog')).json()).agents;
  assert.deepEqual(cat.map(a => a.id), ['wallet_checkup', 'wallet_guardian', 'claim_assistant', 'token_watch', 'dao_votes', 'yield_watch', 'trading_agent']);
  assert.ok(cat.every(a => a.does && a.alerts && a.desk.href.startsWith('/')), 'each says what it does, what it alerts and where its desk is');
  assert.equal((await fetch(base + '/v1/my-agents')).status, 401, 'an account\'s agents need sign-in');

  let mine = (await call('GET', '/v1/my-agents')).body;
  const one = id => mine.agents.find(a => a.id === id);
  assert.equal(one('wallet_checkup').enabled, false, 'new agents start off');
  assert.equal(one('wallet_guardian').enabled, true, 'the risk monitor that ran before stays on');
  assert.equal(one('wallet_guardian').status.state, 'needs_pro');
  assert.equal(one('trading_agent').status.state, 'needs_setup');
  assert.deepEqual(mine.alert_channels, ['telegram']);

  /* ── settings, and what's refused ── */
  assert.equal((await call('PATCH', '/v1/my-agents/token_watch', { enabled: true })).status, 402, 'Token Watch is Safety Pro');
  assert.match((await call('PATCH', '/v1/my-agents/wallet_checkup', { every_hours: 12 })).body.message, /one of: 24, 168/);
  assert.match((await call('PATCH', '/v1/my-agents/dao_votes', { every_hours: 24 })).body.message, /fixed: every hour/);
  assert.match((await call('PATCH', '/v1/my-agents/wallet_checkup', { enabled: 'yes' })).body.message, /true or false/);
  assert.equal((await call('PATCH', '/v1/my-agents/nope', { enabled: true })).status, 404);
  assert.match((await call('PATCH', '/v1/my-agents/claim_assistant', { tokens: [] })).body.message, /Only Token Watch/);
  const on = await call('PATCH', '/v1/my-agents/wallet_checkup', { enabled: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.enabled, true);
  assert.equal(on.body.schedule, 'Every week');

  /* ── the wallet checkup: a weekly summary, with sources, sent to Telegram ── */
  assert.equal(await myAgents.tick(), 1);
  let alerts = (await db.query(`SELECT * FROM monitor_alerts WHERE kind = 'checkup'`)).rows;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'high', 'a part that\'s bad makes the summary high');
  assert.equal(alerts[0].title, 'Your wallet checkup: 2 approvals worth revoking, of 9 open');
  assert.ok(alerts[0].detail.reasons.some(r => r.source === 'approvals source'), 'each part with its source');
  assert.ok(alerts[0].detail.reasons.some(r => /DAO votes: couldn't be checked \(Snapshot didn't answer\)/.test(r.text)), 'a part that couldn\'t run says why');
  await dispatch.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, `https://rektbull.test/?wallet=${acct.wallet}#results`);
  assert.equal(sent[0].action, 'See your checkup');
  mine = (await call('GET', '/v1/my-agents')).body;
  assert.match(one('wallet_checkup').last_result.text, /What apps can still take: 2 approvals worth revoking/);
  assert.deepEqual(one('wallet_checkup').last_result.not_checked, ['DAO votes']);
  assert.equal(one('wallet_checkup').last_result.alerts, 1);
  const next = (await db.query(`SELECT next_run_at - last_run_at AS gap FROM agent_settings WHERE agent = 'wallet_checkup'`)).rows[0].gap;
  assert.equal(next.days, 7, 'next run a week later');

  // Daily: only when something changed.
  await call('PATCH', '/v1/my-agents/wallet_checkup', { every_hours: 24 });
  await db.query(`UPDATE agent_settings SET last_run_at = now() - interval '1 day'`); // a different hour for the dedupe key
  await due();
  await myAgents.tick();
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM monitor_alerts WHERE kind = 'checkup'`)).rows[0].n, 1, 'daily and unchanged: no alert');
  checkup = { approvals: ['ok', '9 open approvals, none flagged'], claims: ['good', '1 unclaimed reward worth $12.50'] };
  await db.query(`DELETE FROM monitor_alerts WHERE kind = 'checkup'`); // the hour-based dedupe key would match within this test
  await due();
  await myAgents.tick();
  alerts = (await db.query(`SELECT * FROM monitor_alerts WHERE kind = 'checkup'`)).rows;
  assert.equal(alerts.length, 1, 'changed: an alert');
  assert.equal(alerts[0].severity, 'medium');
  assert.equal(alerts[0].title, 'Your wallet checkup: 1 unclaimed reward worth $12.50');

  /* ── the claim assistant: each new claim once, again when its amount grows ── */
  await call('PATCH', '/v1/my-agents/claim_assistant', { enabled: true });
  await myAgents.tick();
  const claimAlerts = async () => (await db.query(`SELECT * FROM monitor_alerts WHERE kind = 'claimable' ORDER BY id`)).rows;
  assert.equal((await claimAlerts()).length, 1);
  assert.equal((await claimAlerts())[0].title, 'You can claim MORPHO rewards from 2 Merkl campaigns worth $12.50');
  assert.equal((await claimAlerts())[0].detail.reasons[0].source, 'Merkl rewards');
  await due(); await myAgents.tick();
  assert.equal((await claimAlerts()).length, 1, 'the same claim isn\'t alerted twice');
  claimItems = [{ ...claimItems[0], claimable_raw: '2500', claimable_usd: 31.25 }];
  await due(); await myAgents.tick();
  assert.equal((await claimAlerts()).length, 2, 'more to claim: alerted again');

  /* ── Safety Pro agents: token watch ── */
  await db.query(`INSERT INTO passes (account_id, product, starts_at, ends_at) VALUES ($1, 'pro_30d', now(), now() + interval '30 days')`, [acct.id]);
  assert.match((await call('PATCH', '/v1/my-agents/token_watch', { tokens: [{ chain: 'base', token: '0x123' }] })).body.message, /isn't a token contract address/);
  assert.match((await call('PATCH', '/v1/my-agents/token_watch', { tokens: Array.from({ length: 11 }, (_, i) => ({ chain: 'base', token: '0x' + String(i).padStart(40, '0') })) })).body.message, /up to 10 tokens/);
  const tok = '0x' + '5a'.repeat(20);
  const tw = await call('PATCH', '/v1/my-agents/token_watch', { enabled: true, tokens: [{ chain: 'base', token: tok.toUpperCase().replace('0X', '0x'), label: 'PEPE2' }, { chain: 'base', token: tok }] });
  assert.equal(tw.status, 200);
  assert.deepEqual(tw.body.tokens, [{ chain: 'base', token: tok, label: 'PEPE2' }], 'lowercased, and listed once');
  await myAgents.tick();
  const tokenAlerts = async () => (await db.query(`SELECT * FROM monitor_alerts WHERE kind = 'token_watch'`)).rows;
  assert.equal((await tokenAlerts()).length, 0, 'the first scan only records what\'s there');
  flags = [...flags, { id: 'honeypot', severity: 'critical', title: 'GoPlus reports a honeypot', evidence: 'is_honeypot = 1', source: 'GoPlus' }];
  await due(); await myAgents.tick();
  const ta = await tokenAlerts();
  assert.equal(ta.length, 1);
  assert.equal(ta[0].severity, 'critical');
  assert.equal(ta[0].title, 'PEPE2 on base: GoPlus reports a honeypot');
  assert.deepEqual(ta[0].detail.reasons, [{ text: 'GoPlus reports a honeypot. is_honeypot = 1', source: 'GoPlus' }]);
  await dispatch.tick();
  assert.equal(sent.at(-1).url, `https://rektbull.test/safety?chain=base&token=${tok}#check-card`);

  /* ── a run that fails is kept for retry, with the reason ── */
  tokenRisk.scanToken = async () => { throw new Error('GoPlus timed out'); };
  claims.check = async () => { throw new Error('Merkl is down'); };
  await due(); await myAgents.tick();
  mine = (await call('GET', '/v1/my-agents')).body;
  assert.match(one('token_watch').last_result.not_checked[0], /PEPE2: GoPlus timed out/, 'a token that couldn\'t be scanned says so');
  assert.match(one('claim_assistant').last_result.not_checked[0], /Merkl is down/);
  home.checkup = async () => { throw new Error('boom'); };
  await due(); await myAgents.tick();
  const failed = (await db.query(`SELECT last_error, next_run_at > now() + interval '50 minutes' AS later FROM agent_settings WHERE agent = 'wallet_checkup'`)).rows[0];
  assert.equal(failed.last_error, 'boom');
  assert.equal(failed.later, true, 'retried in an hour');

  /* ── the jobs that ran elsewhere obey their switch ── */
  const monitor = require('../src/services/monitor');
  monitor.look = async () => ({ scan: { chains: [] }, read: ['base'], open: {}, impls: {}, stables: [], unread: [] });
  const { rows: [w] } = await db.query(`INSERT INTO monitored_wallets (account_id, wallet) VALUES ($1, $2) RETURNING id`, [acct.id, acct.wallet]);
  await call('PATCH', '/v1/my-agents/wallet_guardian', { enabled: false });
  await monitor.tick();
  assert.match((await db.query('SELECT last_error FROM monitored_wallets WHERE id = $1', [w.id])).rows[0].last_error, /switched off on the AI agents page/);
  await call('PATCH', '/v1/my-agents/wallet_guardian', { enabled: true, every_hours: 12 });
  assert.equal((await db.query('SELECT next_check_at <= now() AS due FROM monitored_wallets WHERE id = $1', [w.id])).rows[0].due, true, 'switched back on: checked at once');
  await monitor.tick();
  const checked = (await db.query(`SELECT last_error, round(extract(epoch FROM next_check_at - last_checked_at) / 3600) AS hours FROM monitored_wallets WHERE id = $1`, [w.id])).rows[0];
  assert.equal(checked.last_error, null);
  assert.equal(Number(checked.hours), 12, 'on the schedule chosen here');
  assert.equal((await monitor.list(acct.id)).every_hours, 12);

  assert.equal(await myAgents.isOn(acct.id, 'dao_votes'), true);
  await call('PATCH', '/v1/my-agents/dao_votes', { enabled: false });
  assert.equal(await myAgents.isOn(acct.id, 'dao_votes'), false);

  const exits = require('../src/trade/exits');
  const p = { account_id: String(acct.id), wallet: acct.wallet, token: '0x' + '77'.repeat(20) };
  assert.equal(await exits.alertExit(p, { name: 'base' }, { id: 'intent-1' }, 'Stop-loss: down 21.0%, past your 20% limit.'), 1);
  const ex = (await db.query(`SELECT * FROM monitor_alerts WHERE kind = 'trade_exit'`)).rows[0];
  assert.equal(ex.title, 'Selling 0x7777…7777 on base: stop-loss');
  await call('PATCH', '/v1/my-agents/trading_agent', { enabled: false });
  assert.equal(await exits.alertExit(p, { name: 'base' }, { id: 'intent-2' }, 'Take-profit: up 60.0%, past your 50% target.'), 0, 'alerts off: none');

  /* ── Safety Pro ends: its agents pause and say why ── */
  await db.query('UPDATE passes SET ends_at = now() - interval \'1 minute\'');
  tokenRisk.scanToken = async ({ chain, token_address }) => ({ chain, token: token_address, flags: [] });
  await due(); await myAgents.tick();
  mine = (await call('GET', '/v1/my-agents')).body;
  assert.equal(one('token_watch').last_error, 'Paused: Safety Pro has ended');
  assert.equal(one('token_watch').status.state, 'needs_pro');
  const off = await call('PATCH', '/v1/my-agents/token_watch', { enabled: false });
  assert.equal(off.status, 200, 'it can still be switched off');
});
