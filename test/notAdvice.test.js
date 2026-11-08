/**
 * "Not financial advice", stated where people read: in every page's footer,
 * in its own section on the About page, as a notice on the pages that deal
 * with money (Find money, Governance, Trade, Opportunities), and in the
 * results of yield proposals and proposal summaries.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, { JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', DATABASE_URL: '', PUBLIC_URL: 'https://rektbull.test' });
require('../src/providers/llama').protocols = async () => [];
const seo = require('../src/pages/seo');

let server, base;
test.before(() => { server = require('../src/app').createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const get = async p => (await fetch(base + p, { headers: { accept: 'text/html' } })).text();
const FOOTER = 'Nothing on RektBull is financial, investment, legal or tax advice, or a recommendation to buy, sell, hold, deposit, claim or vote.';

test('every page says it in its footer, and links the full statement', async () => {
  for (const route of [...Object.keys(seo.PAGES), '/agents/wallet-guardian']) {
    const html = await get(route);
    assert.ok(html.includes(FOOTER), `${route}: the footer statement`);
    assert.ok(html.includes('<a href="/about#not-advice">Not financial advice</a>'), `${route}: linked`);
  }
});

test('the About page states it in full, covering every desk', async () => {
  const html = await get('/about');
  const section = html.slice(html.indexOf('id="not-advice"'), html.indexOf('</section>', html.indexOf('id="not-advice"')));
  for (const s of ['Nothing on RektBull is financial, investment, legal or tax advice', 'yield proposals', 'the governance tools', 'never how to vote', 'the trade desk', 'contract audits', 'the AI agents', 'qualified, licensed professional']) assert.ok(section.includes(s), s);
});

test('the money pages carry a notice; the results say it too', async () => {
  for (const [route, words] of [['/find', 'not recommendations'], ['/governance', 'never says how to vote'], ['/trade', 'never picks what to buy or sell'], ['/opportunities', 'never as a recommendation']]) {
    const html = await get(route);
    assert.match(html, /<p class="notice" role="note"><strong>Not financial advice\.<\/strong>/, route);
    assert.ok(html.includes(words), `${route}: ${words}`);
  }
  const src = f => require('fs').readFileSync(require('path').join(__dirname, '..', f), 'utf8');
  assert.match(src('src/yield/proposals.js'), /They are not financial advice or a recommendation/);
  assert.equal((src('src/services/governance.js').match(/It is not financial advice and not a recommendation on how to vote/g) || []).length, 2);
});
