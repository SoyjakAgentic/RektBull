/**
 * The contract audit's PDF report, against a real Postgres: an audit paid
 * from credits ($99) is kept by its run id, and its PDF downloads from the
 * link in the result; an audit refused (the analyzer down) is not charged and
 * has no report; an unknown or malformed id has none. With the explorer,
 * Claude and the analyzer as stand-ins. Runs only when TEST_DATABASE_URL is set.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;

test('contract audit: $99 from credits, the PDF report by its run id', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test-secret', PUBLIC_URL: 'https://rektbull.test', NEW_WALLET_CHECK_CHAINS: '', ANALYZER_URL: 'http://analyzer.test' });
  for (const k of Object.keys(require.cache)) if (k.includes('/src/')) delete require.cache[k];
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());

  const CONTRACT = '0x' + '6'.repeat(40);
  require('../src/providers/explorer').explorerGet = async () => ({ status: '1', result: [{ ContractName: 'Vault', ABI: '[]', SourceCode: 'pragma solidity ^0.8.20;\ncontract Vault { function f() external { require(tx.origin == msg.sender); } }', CompilerVersion: 'v0.8.24+commit.e11b9ed9', OptimizationUsed: '1', Runs: '200', Proxy: '0' }] });
  const audit = require('../src/services/contractAudit');
  audit.solcLists = async () => ({ bugs: [], byVersion: { '0.8.24': { bugs: [] } } });
  let analyzerUp = true;
  audit.slither = async () => (analyzerUp ? { solc: '0.8.24', slither: '0.11.3', detectors: 100, seconds: 0.4, findings: [{ check: 'tx-origin', impact: 'Medium', confidence: 'Medium', description: 'Vault.f uses tx.origin for authorization → unsafe “quoted” text', locations: [{ file: 'Vault.sol', lines: [2, 2] }] }] } : { unavailable: 'The analyzer couldn\'t be reached.' });
  const claude = require('../src/ai/claude');
  claude.available = () => true;
  claude.write = async () => ({ text: '## What this contract is\nA vault.\n\n## What to look at first\n- **tx-origin**: read Vault.sol line 2.', model: 'claude-opus-5-5' });

  const server = require('../src/app').createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { rows: [acct] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', ['0x' + 'ab'.repeat(20)]);
  const token = require('../src/auth/siwe').issueToken(acct);
  await require('../src/payments/credits').add(acct.id, 15000, 'adjustment', 'test:topup');
  const post = body => fetch(base + '/v1/contracts/audit', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

  /* ── the analyzer down: refused, not charged, no report ── */
  analyzerUp = false;
  let r = await post({ chain: 'base', address: CONTRACT });
  assert.equal(r.status, 503);
  assert.equal(await require('../src/payments/credits').balance(acct.id), 15000, 'not charged');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM audit_reports')).rows[0].n, 0);
  const { rows: [failed] } = await db.query(`SELECT id FROM runs WHERE product = 'contract_audit' AND status = 'failed'`);
  assert.equal((await fetch(`${base}/v1/contracts/audit/${failed.id}/report.pdf`)).status, 404);

  /* ── a paid audit: $99 from credits, its report by run id ── */
  analyzerUp = true;
  r = await post({ chain: 'base', address: CONTRACT });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.run.paid_with, 'credits');
  assert.equal(out.run.price_cents, 9900);
  assert.equal(await require('../src/payments/credits').balance(acct.id), 5100);
  assert.equal(out.report_pdf, `/v1/contracts/audit/${out.run.id}/report.pdf`);

  const pdf = await fetch(base + out.report_pdf);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition'), new RegExp(`^attachment; filename="rektbull-audit-base-${CONTRACT}-\\d{4}-\\d{2}-\\d{2}\\.pdf"$`));
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(bytes.length > 2000);
  const raw = bytes.toString('latin1');
  assert.match(raw, /\/Title /, 'titled');
  assert.ok((raw.match(/\/Type \/Page\b/g) || []).length >= 1, 'at least one page');

  /* ── the PDF's text: drawn from the stored result, with the disclaimer, non-Latin text replaced ── */
  const { plain, DISCLAIMER } = require('../src/pages/auditPdf');
  assert.equal(plain('a → b “c” — d ✅'), 'a -> b "c" - d ?');
  assert.equal(plain('Reentrancy:\n\tExternal calls:\r\n\t- x'), 'Reentrancy:\n  External calls:\n  - x', 'Slither\'s tabs drawn as spaces, not garbled');
  assert.match(DISCLAIMER, /not a full audit.*Nothing in this report is financial, investment, legal or tax advice\./s);

  /* ── unknown and malformed ids; the export lists the audit ── */
  assert.equal((await fetch(`${base}/v1/contracts/audit/00000000-0000-4000-8000-000000000000/report.pdf`)).status, 404);
  assert.equal((await fetch(`${base}/v1/contracts/audit/not-a-uuid/report.pdf`)).status, 404);
  const mine = await (await fetch(base + '/v1/me/export', { headers: { authorization: `Bearer ${token}` } })).json();
  assert.deepEqual(mine.contract_audits.map(a => a.address), [CONTRACT]);
});
