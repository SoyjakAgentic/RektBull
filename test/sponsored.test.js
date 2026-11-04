/**
 * Sponsored posts in the weekly digest, with GoPlus as a stand-in: what the
 * owner may enter, the phishing check when saved (listed or uncheckable:
 * refused), changes only while the week is a draft, the label in the email
 * and on the API, the counted redirect that stops a site listed since, and
 * the owner's report.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
const ADMIN = '0x' + 'ad'.repeat(20);
Object.assign(process.env, { JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', ADMIN_WALLETS: ADMIN, PUBLIC_URL: 'https://rektbull.test', OPERATOR_POSTAL_ADDRESS: '1 Test Street', ...(DB ? { DATABASE_URL: DB } : {}) });
const sponsored = require('../src/services/sponsored');
const newsletter = require('../src/services/newsletter');
const goplus = require('../src/providers/goplus');

const POST = { placement: 'top', sponsor: 'Acme Wallet', headline: 'A hardware wallet that shows what you sign', body: 'Acme shows every transaction on its own screen.', url: 'https://acme.example/wallet?ref=rektbull', not_investment: true };

test('what the owner may enter: plain text within limits, an https link, the confirmation', () => {
  const ok = sponsored.parse({ ...POST, headline: '  A  headline\nwith\u0007 control  ' });
  assert.equal(ok.headline, 'A headline with control', 'plain, one line');
  assert.equal(ok.url, 'https://acme.example/wallet?ref=rektbull');
  assert.match(sponsored.parse({ ...POST, placement: 'middle' }).error, /top or bottom/);
  assert.match(sponsored.parse({ ...POST, url: 'http://acme.example' }).error, /https/);
  assert.match(sponsored.parse({ ...POST, url: 'javascript:alert(1)' }).error, /https/);
  assert.match(sponsored.parse({ ...POST, url: 'https://user:pw@acme.example' }).error, /username or password/);
  assert.match(sponsored.parse({ ...POST, body: 'x'.repeat(401) }).error, /body is over 400/);
  assert.match(sponsored.parse({ ...POST, sponsor: ' ' }).error, /sponsor is needed/);
  assert.match(sponsored.parse({ ...POST, not_investment: undefined }).error, /isn't a promotion to buy, sell or invest/);
});

test('in the email: labelled, with who paid, set apart above and below the digest, escaped', () => {
  const ad = (placement, headline) => ({ id: 1, placement, label: 'Sponsored', disclosure: sponsored.DISCLOSURE, sponsor: 'Acme <b>', headline, body: 'Body', site: 'acme.example', url: 'https://rektbull.test/v1/research/sponsored/1' });
  const m = newsletter.compose({ week_start: '2026-10-26', byline: 'Written by RektBull Research', text: '## Hacks\n3 exploits [DefiLlama hacks].', facts: [], sponsored: [ad('top', 'Top one'), ad('bottom', 'Bottom one')] }, 7);
  assert.match(m.text, /Written by RektBull Research\n\n--- Sponsored: Acme <b> ---\nTop one\nBody\nhttps:\/\/rektbull\.test\/v1\/research\/sponsored\/1 \(acme\.example\)\nA paid placement\. Not checked or endorsed by RektBull, and not advice\.\n---\n\n## Hacks[\s\S]*3 exploits[\s\S]*Sponsored: Acme <b> ---\nBottom one/);
  assert.ok(m.html.indexOf('Top one') < m.html.indexOf('Hacks') && m.html.indexOf('Hacks') < m.html.indexOf('Bottom one'));
  assert.match(m.html, /Sponsored · Acme &lt;b&gt;/);
  assert.ok(!m.html.includes('<b>'));
  assert.ok(!newsletter.compose({ week_start: '2026-10-26', byline: 'x', text: 'y', facts: [] }, 7).text.includes('Sponsored'), 'none, no box');
});

test('the owner adds them to a draft; readers see them labelled; clicks are counted and re-checked', { skip: !DB && 'set TEST_DATABASE_URL' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  const listed = new Set();
  let goplusDown = false;
  goplus.phishingSite = async origin => { if (goplusDown) throw new Error('GoPlus didn\'t answer'); return { source: 'GoPlus phishing site list', phishing: listed.has(origin) }; };
  const facts = JSON.stringify({ items: [{ section: 'Hacks', text: '3 exploits', source: 'DefiLlama hacks' }], not_checked: [] });
  await db.query(`INSERT INTO research_digests (week_start, week_end, facts, checked, status) VALUES ('2026-10-26', '2026-11-02', $1, '## Hacks\n3 exploits [DefiLlama hacks].', 'draft')`, [facts]);
  const { rows: [acct] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [ADMIN]);
  const { rows: [other] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', ['0x' + 'bb'.repeat(20)]);

  const server = require('../src/app').createApp().listen(0);
  t.after(async () => { server.close(); await db.getPool().end(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const siwe = require('../src/auth/siwe');
  const owner = siwe.issueToken(acct), stranger = siwe.issueToken(other);
  const call = async (method, p, token, body) => {
    const r = await fetch(base + p, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text(), location: r.headers.get('location') };
  };
  const W = '/v1/admin/research/digests/2026-10-26/sponsored';

  assert.equal((await call('POST', W, stranger, POST)).status, 403, 'only the owner');
  assert.equal((await call('POST', W, owner, { ...POST, not_investment: false })).status, 400);
  listed.add('https://drainer.example');
  const bad = await call('POST', W, owner, { ...POST, url: 'https://drainer.example/claim' });
  assert.deepEqual([bad.status, bad.body.message], [422, 'GoPlus\'s phishing list has drainer.example. It can\'t be used.']);
  goplusDown = true;
  const unchecked = await call('POST', W, owner, POST);
  assert.equal(unchecked.status, 503);
  assert.match(unchecked.body.message, /couldn't be checked against GoPlus's phishing list \(GoPlus didn't answer\)/);
  goplusDown = false;

  const top = await call('POST', W, owner, POST);
  assert.equal(top.status, 200);
  assert.deepEqual([top.body.target, top.body.link_check.phishing, top.body.link_check.source], [POST.url, false, 'GoPlus phishing site list']);
  await call('POST', W, owner, { ...POST, placement: 'bottom', sponsor: 'Dev Tools Co', url: 'https://devtools.example' });
  const replaced = await call('POST', W, owner, { ...POST, placement: 'bottom', sponsor: 'Dev Tools Co', headline: 'Changed', url: 'https://devtools.example' });
  assert.equal(replaced.body.headline, 'Changed', 'one post per place: saving again replaces it');
  const { body: { drafts: [draft] } } = await call('GET', '/v1/admin/research/drafts', owner);
  assert.deepEqual(draft.sponsored.map(s => [s.placement, s.sponsor]), [['top', 'Acme Wallet'], ['bottom', 'Dev Tools Co']]);

  const ids = draft.sponsored.map(s => s.id);
  assert.equal((await call('GET', `/v1/research/sponsored/${ids[0]}`)).status, 404, 'no link works before the week is published');
  assert.equal((await call('DELETE', `${W}/bottom`, owner)).status, 200);
  assert.equal((await call('DELETE', `${W}/bottom`, owner)).status, 404);

  // Published: fixed, shown labelled, sent in the email.
  await call('POST', '/v1/admin/research/digests/2026-10-26/publish', owner);
  const locked = await call('POST', W, owner, { ...POST, placement: 'bottom' });
  assert.deepEqual([locked.status, locked.body.message], [409, 'That week\'s digest is published: sponsored posts are fixed once it\'s reviewed.']);
  assert.equal((await call('DELETE', `${W}/top`, owner)).status, 409);
  const { body: pub } = await call('GET', '/v1/research/digests/latest');
  assert.deepEqual(pub.sponsored, [{ id: ids[0], placement: 'top', label: 'Sponsored', disclosure: 'A paid placement. Not checked or endorsed by RektBull, and not advice.', sponsor: 'Acme Wallet', headline: POST.headline, body: POST.body, site: 'acme.example', url: `https://rektbull.test/v1/research/sponsored/${ids[0]}` }], 'readers get the counted link, not the check or the clicks');
  assert.equal((await call('POST', '/v1/admin/research/digests/2026-10-26/publish', owner)).status, 409);

  const sent = [];
  require('../src/alerts/transports').email.enabled = () => true;
  require('../src/alerts/transports').email.send = async m => { sent.push(m); };
  await db.query(`INSERT INTO newsletter_subscribers (email, confirmed_at) VALUES ('reader@example.com', now()), ('two@example.com', now())`);
  await newsletter.tick();
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /--- Sponsored: Acme Wallet ---/);

  // Clicks: counted and followed; a site listed since isn't.
  const click = await call('GET', `/v1/research/sponsored/${ids[0]}`);
  assert.deepEqual([click.status, click.location], [302, POST.url]);
  goplusDown = true;
  assert.equal((await call('GET', `/v1/research/sponsored/${ids[0]}`)).status, 302, 'if the check can\'t run now, the one when it was saved stands');
  goplusDown = false;
  listed.add('https://acme.example');
  const stopped = await call('GET', `/v1/research/sponsored/${ids[0]}`);
  assert.equal(stopped.status, 410);
  assert.match(stopped.body, /acme\.example is now on a phishing list \(GoPlus phishing site list\)/);
  assert.equal((await call('GET', '/v1/research/sponsored/999')).status, 404);
  assert.equal((await call('GET', '/v1/research/sponsored/nope')).status, 404);

  assert.equal((await call('GET', '/v1/admin/research/sponsored', stranger)).status, 403);
  const { body: { sponsored: report } } = await call('GET', '/v1/admin/research/sponsored', owner);
  assert.deepEqual(report.map(r => [r.week_start, r.status, r.sponsor, r.emailed_to, r.clicks]), [['2026-10-26', 'published', 'Acme Wallet', 2, 2]]);
});
