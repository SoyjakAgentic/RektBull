/**
 * Slither on RektBull's own contracts (not the test stand-ins), the way CI runs it:
 *
 *   node scripts/slither.mjs
 *
 * Needs slither-analyzer and solc 0.8.24 (solc-select) on the PATH, and `npm ci` here (for
 * OpenZeppelin). Prints every finding; fails on any Medium or High finding that isn't in
 * slither.triage.json with a reviewed reason. Low and informational findings are printed only.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = ['RektBullTradeRouter', 'RektBullSafeModule', 'RektBullYieldRouter', 'RektBullMemeRouter'];
const FAILS = new Set(['High', 'Medium']);
const triage = JSON.parse(readFileSync(join(ROOT, 'slither.triage.json'), 'utf8')).accepted;
const keyOf = (check, file, where) => `${check}|${file}|${where}`;
const accepted = new Map(triage.map(t => [keyOf(t.check, t.file, t.where), t]));

/** Where a finding is: its first element's function (Contract.function) or variable name. */
function where(r) {
  const el = r.elements?.[0] || {};
  if (el.type === 'function') return `${el.type_specific_fields?.parent?.name}.${el.name}`;
  return el.name || '';
}

const dir = mkdtempSync(join(tmpdir(), 'slither-'));
const seen = new Map();
try {
  for (const c of CONTRACTS) {
    const out = join(dir, `${c}.json`);
    try {
      execFileSync('slither', [`contracts/${c}.sol`, '--solc-remaps', '@openzeppelin=node_modules/@openzeppelin',
        '--solc-args', '--via-ir --optimize --evm-version cancun', '--filter-paths', 'node_modules', '--json', out],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      // Slither exits non-zero when it finds anything; only a missing report is a real failure.
      if (!existsSync(out)) throw new Error(`slither failed on ${c}: ${String(err.stderr || err.message).slice(-2000)}`);
    }
    const report = JSON.parse(readFileSync(out, 'utf8'));
    if (!report.success) throw new Error(`slither failed on ${c}: ${report.error}`);
    for (const r of report.results?.detectors || []) {
      const file = r.elements?.[0]?.source_mapping?.filename_relative || '';
      if (!file.startsWith('contracts/') || file.startsWith('contracts/test/')) continue;
      const k = keyOf(r.check, file, where(r));
      if (!seen.has(k)) seen.set(k, { impact: r.impact, confidence: r.confidence, check: r.check, file, where: where(r), text: r.description.split('\n')[0] });
    }
  }
} finally { rmSync(dir, { recursive: true, force: true }); }

const findings = [...seen.values()];
const order = ['High', 'Medium', 'Low', 'Informational', 'Optimization'];
findings.sort((a, b) => order.indexOf(a.impact) - order.indexOf(b.impact));
const open = findings.filter(f => FAILS.has(f.impact) && !accepted.has(keyOf(f.check, f.file, f.where)));
for (const f of findings) {
  const tag = !FAILS.has(f.impact) ? 'note' : accepted.has(keyOf(f.check, f.file, f.where)) ? 'reviewed' : 'OPEN';
  console.log(`${tag.padEnd(8)} ${f.impact.padEnd(13)} ${f.check.padEnd(24)} ${f.where}  (${f.file})`);
}
const stale = triage.filter(t => !seen.has(keyOf(t.check, t.file, t.where)));
for (const t of stale) console.log(`stale    the triage entry ${t.check} at ${t.where} no longer matches a finding: remove it`);
console.log(`\n${findings.length} findings: ${findings.filter(f => FAILS.has(f.impact)).length} Medium or High (${open.length} not reviewed), ${stale.length} stale triage entries.`);
if (open.length) {
  console.error('\nMedium or High findings nobody has reviewed. Fix them, or add each to slither.triage.json with a reason a reviewer can check against the code.');
  process.exit(1);
}
