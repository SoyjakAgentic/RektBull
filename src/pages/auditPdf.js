/**
 * The Contract Audit's downloadable report, as a PDF (pdfkit, pure
 * JavaScript: no browser on the server). Built from the stored result only:
 * the summary as written, Slither's findings, the checklist patterns, the
 * owner powers, the compiler's known bugs, what couldn't be checked, and the
 * sources. Every page carries the disclaimer.
 *
 * pdfkit's built-in fonts cover Latin text; anything else in a contract's
 * text (arrows, emoji, other scripts) is replaced, never dropped silently.
 */
const PDFDocument = require('pdfkit');

const INK = '#0d1424', MUTED = '#586379', LINE = '#e2e7f0';
const SEV = { High: '#c42f3a', high: '#c42f3a', critical: '#c42f3a', Medium: '#9a5b00', medium: '#9a5b00', Low: '#586379', low: '#586379', info: '#586379' };
const DISCLAIMER = 'A first-pass automated review, not a full audit. Findings are flags for a person to confirm, and some are false positives; it does not find business-logic flaws or economic attacks. A clean result is never proof that a contract is safe. Nothing in this report is financial, investment, legal or tax advice.';

/** Text pdfkit's standard fonts can draw: common symbols mapped, anything else marked. */
const plain = s => String(s ?? '')
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
  .replace(/←/g, '<-').replace(/→/g, '->').replace(/•/g, '-')
  .replace(/\t/g, '  ').replace(/\r/g, '')
  .replace(/[^\x0a\x20-\x7e\xa0-\xff]/g, '?');

const where = l => `${l.file || '?'}${l.lines?.length ? `:${l.lines[0]}${l.lines[1] !== l.lines[0] ? `-${l.lines[1]}` : ''}` : ''}`;

function render(report, { runId, paidWith } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 64, left: 56, right: 56 }, bufferPages: true, info: { Title: `RektBull contract audit: ${plain(report.contract?.name || report.address)}`, Author: 'RektBull', Subject: 'First-pass contract security review' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const width = doc.page.width - 112;

    const h1 = t => doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(plain(t), { width });
    const h2 = t => { doc.moveDown(0.8); doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(plain(t), { width }); doc.moveDown(0.3); };
    const p = (t, o = {}) => doc.font(o.bold ? 'Helvetica-Bold' : o.mono ? 'Courier' : 'Helvetica').fontSize(o.size || 10).fillColor(o.color || INK).text(plain(t), { width, ...o });
    const rule = () => { doc.moveDown(0.4); doc.strokeColor(LINE).lineWidth(0.5).moveTo(56, doc.y).lineTo(56 + width, doc.y).stroke(); doc.moveDown(0.4); };
    const item = (label, color, title, lines) => {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(color).text(plain(label).toUpperCase(), { width, continued: true }).fillColor(INK).fontSize(10).text(`  ${plain(title)}`);
      for (const l of lines.filter(Boolean)) p(l.text ?? l, { size: l.size || 9, color: l.color || INK, mono: l.mono });
      doc.moveDown(0.5);
    };

    h1('Contract audit (first pass)');
    p(`${report.contract?.name || 'Contract'}  ${report.address}  on ${report.chain}`, { color: MUTED });
    p(`Checked ${new Date(report.checked_at).toUTCString()}${runId ? `  ·  Report ${runId}` : ''}${paidWith ? `  ·  Paid with ${paidWith}` : ''}`, { size: 8, color: MUTED });
    rule();
    for (const u of report.units || []) {
      p(`${u.role === 'implementation' ? 'Implementation' : report.contract?.proxy ? 'Proxy' : 'Contract'} ${u.contract_name || ''} (${u.address}): ${u.verified ? `verified; ${u.own_files} of its own files, ${u.files} with libraries; ${u.compiler}${u.optimizer ? `, optimizer on (${u.runs} runs)` : ''}` : 'not verified'}`, { size: 9 });
    }

    // The summary, as written (Markdown headings and bullets drawn plainly).
    if (report.summary?.markdown) {
      h2('Summary');
      for (const line of String(report.summary.markdown).split('\n')) {
        const t = line.trim();
        if (!t) { doc.moveDown(0.3); continue; }
        if (/^#{1,6}\s/.test(t)) { doc.moveDown(0.2); p(t.replace(/^#+\s*/, ''), { bold: true, size: 11 }); continue; }
        p(t.replace(/^[-*]\s+/, '- ').replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'), { size: 10 });
      }
      p(`Written by ${report.summary.written_by} from the findings below only; it doesn't add or confirm any.`, { size: 8, color: MUTED });
    } else if (report.summary?.not_written) {
      h2('Summary'); p(report.summary.not_written, { color: MUTED });
    }

    for (const s of report.slither || []) {
      h2(`Slither${(report.slither || []).length > 1 ? ` (${s.role})` : ''}`);
      if (s.not_run) { p(`Not run: ${s.not_run}`, { color: SEV.High }); continue; }
      p(`${s.detectors} detectors, Slither ${s.slither}, solc ${s.solc}, ${s.seconds}s. Informational notes not listed: ${Object.values(s.informational_counts || {}).reduce((a, b) => a + b, 0)}. Findings in libraries not listed: ${s.library_findings_hidden || 0}.`, { size: 8, color: MUTED });
      doc.moveDown(0.3);
      if (!s.findings.length) p('Slither listed no high, medium or low findings in the contract\'s own code.');
      for (const f of s.findings) item(`${f.impact} · ${f.confidence} confidence`, SEV[f.impact] || MUTED, f.check, [{ text: f.description }, { text: `Where: ${f.locations.slice(0, 4).map(where).join(', ') || 'not given'}  ·  Source: Slither`, size: 8, color: MUTED }]);
    }

    const leads = (report.leads || []).filter(l => l.severity !== 'info');
    const powers = (report.leads || []).filter(l => l.severity === 'info');
    if (leads.length) {
      h2('Checklist patterns');
      for (const l of leads) item(l.severity, SEV[l.severity] || MUTED, l.title, [{ text: l.snippet, mono: true, size: 8 }, { text: `Where: ${l.file}:${l.line}  ·  Source: pattern check (${l.rule})`, size: 8, color: MUTED }]);
    }
    if (powers.length) {
      h2('Who holds power over it');
      for (const l of powers) p(`- ${l.title} (${l.file}:${l.line})`, { size: 9 });
    }
    const bugs = (report.compiler || []).flatMap(c => (c.known_bugs || []).filter(b => b.applies !== false));
    if (bugs.length) {
      h2('Known compiler bugs that may apply');
      for (const b of bugs.slice(0, 12)) p(`- ${b.name} (${b.severity}${b.applies === 'unknown' ? `; ${b.why}` : ''}): ${b.summary}`, { size: 9 });
      p('Source: the Solidity team\'s bug list. A bug matters only where the code uses what it breaks.', { size: 8, color: MUTED });
    }
    if (report.not_checked?.length) {
      h2('What couldn\'t be checked');
      for (const n of report.not_checked) p(`- ${n.check}: ${n.reason}`, { size: 9 });
    }
    h2('Sources');
    for (const s of report.sources || []) p(`- ${s}`, { size: 9 });
    h2('Read this before relying on it');
    p(report.note || DISCLAIMER, { size: 9 });

    // Every page: the disclaimer and the page number.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottom = doc.page.height - 50;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(`RektBull · rektbull.com · ${DISCLAIMER}`, 56, bottom - 14, { width: width - 40, lineBreak: true });
      doc.text(`${i + 1} / ${range.count}`, 56 + width - 36, bottom - 14, { width: 36, align: 'right' });
    }
    doc.end();
  });
}

module.exports = { render, plain, DISCLAIMER };
