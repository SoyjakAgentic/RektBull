/**
 * The RektBull Snap in MetaMask's simulator (snaps-jest), against a small
 * stand-in RektBull API on localhost. Built with SNAP_ENV=test so it can be
 * pointed at that API; `npm test` rebuilds the production bundle after.
 */
const http = require('http');
const { installSnap } = require('@metamask/snaps-jest');

const SITE = 'https://rektbull.com';
const TOKEN = 'ext-token-for-tests-0123456789';
let api, apiBase;
const seen = [];
let answer = () => ({ status: 200, body: { verdict: 'low', summary: 'No known risk pattern found.', findings: [], not_checked: [], note: 'An automated check.' } });
let alerts = [];

beforeAll(async () => {
  api = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const auth = req.headers.authorization;
      const reply = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (auth !== `Bearer ${TOKEN}`) return reply(401, { error: 'sign_in_required' });
      seen.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : null });
      if (req.url === '/v1/me') return reply(200, { account: { wallet: '0x' + '11'.repeat(20) }, points: { left: 29, allowance: 30 }, passes: [] });
      if (req.url.startsWith('/v1/monitor/alerts')) return reply(200, { alerts });
      if (req.url === '/v1/presign/check') { const a = answer(JSON.parse(body)); return reply(a.status, a.body); }
      reply(404, {});
    });
  });
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  apiBase = `http://127.0.0.1:${api.address().port}`;
});
afterAll(() => new Promise(r => api.close(r)));

const text = node => JSON.stringify(node);

describe('RektBull Snap', () => {
  it('only rektbull.com can link it; unlinked, MetaMask shows a link prompt', async () => {
    const snap = await installSnap();
    const other = await snap.request({ origin: 'https://evil.example', method: 'link', params: { token: TOKEN, apiBase } });
    expect(other).toRespondWithError(expect.anything());
    const r = await snap.onTransaction({ to: '0x' + 'aa'.repeat(20), data: '0x', origin: 'https://app.example' });
    expect(text(r.getInterface().content)).toContain('this Snap isn');
    expect(text(r.getInterface().content)).toContain(`${SITE}/extension`);
  });

  it('linked from rektbull.com: a risky transaction shows the findings, sources and simulation, as a warning', async () => {
    const snap = await installSnap();
    expect((await snap.request({ origin: SITE, method: 'link', params: { token: 'short' } }))).toRespondWithError(expect.anything());
    const linked = await snap.request({ origin: SITE, method: 'link', params: { token: TOKEN, apiBase } });
    expect(linked).toRespondWith({ linked: true, wallet: '0x' + '11'.repeat(20) });
    answer = () => ({ status: 200, body: {
      verdict: 'critical', summary: 'Don\'t sign this unless you\'re sure: token approval: 0xdddd…dddd could spend all of this token, now and later.',
      findings: [{ severity: 'critical', title: 'Token approval: 0xdddd…dddd could spend all of this token, now and later', detail: 'Flagged for phishing.', source: 'GoPlus (data from SlowMist)' }],
      simulation: { changes: [{ direction: 'out', amount: 500, symbol: 'USDC', usd: 500 }] }, not_checked: [], note: 'An automated check.' } });
    const r = await snap.onTransaction({ from: '0x' + '11'.repeat(20), to: '0x' + 'aa'.repeat(20), data: '0x095ea7b3', chainId: 'eip155:8453', origin: 'https://app.example' });
    const ui = text(r.getInterface().content);
    expect(r.response.result.severity).toBe('critical');
    expect(ui).toContain('RektBull: critical risk');
    expect(ui).toContain('CRITICAL: Token approval');
    expect(ui).toContain('Source: GoPlus (data from SlowMist)');
    expect(ui).toContain('Leaves your wallet: 500 USDC (about $500)');
    const sent = seen.filter(s => s.path === '/v1/presign/check').at(-1).body;
    expect(sent).toMatchObject({ method: 'eth_sendTransaction', chain_id: 8453, from: '0x' + '11'.repeat(20), origin: 'https://app.example' });
  });

  it('a safe transaction: no warning; signatures are sent in the shape the check expects', async () => {
    const snap = await installSnap();
    await snap.request({ origin: SITE, method: 'link', params: { token: TOKEN, apiBase } });
    answer = () => ({ status: 200, body: { verdict: 'low', summary: 'No known risk pattern found.', findings: [], not_checked: [], note: 'An automated check.' } });
    const ok = await snap.onTransaction({ to: '0x' + 'aa'.repeat(20), data: '0x', origin: 'https://app.example' });
    expect(ok.response.result.severity).toBeUndefined();
    expect(text(ok.getInterface().content)).toContain('RektBull: no known risk');
    await snap.onSignature({ signatureMethod: 'personal_sign', from: '0x' + '11'.repeat(20), data: '0x68656c6c6f', origin: 'https://app.example' });
    expect(seen.filter(s => s.path === '/v1/presign/check').at(-1).body).toMatchObject({ method: 'personal_sign', params: ['0x68656c6c6f', '0x' + '11'.repeat(20)], origin: 'https://app.example' });
    const typed = { types: { EIP712Domain: [] }, primaryType: 'Permit', domain: { name: 'USD Coin', chainId: 8453 }, message: { spender: '0x' + 'dd'.repeat(20) } };
    await snap.onSignature({ signatureMethod: 'eth_signTypedData_v4', from: '0x' + '11'.repeat(20), data: typed, origin: 'https://app.example' });
    const s = seen.filter(x => x.path === '/v1/presign/check').at(-1).body;
    expect(s.method).toBe('eth_signTypedData_v4');
    expect(s.params[0]).toBe('0x' + '11'.repeat(20));
    expect(s.params[1].primaryType).toBe('Permit');
    expect(s.chain_id).toBe(8453);
  });

  it('out of free checks, or RektBull unreachable: says so, and blocks nothing', async () => {
    const snap = await installSnap();
    await snap.request({ origin: SITE, method: 'link', params: { token: TOKEN, apiBase } });
    answer = () => ({ status: 402, body: { error: 'payment_required' } });
    const r = await snap.onTransaction({ to: '0x' + 'aa'.repeat(20), data: '0x' });
    expect(r.response.result.severity).toBeUndefined();
    expect(text(r.getInterface().content)).toContain('free checks are used up');
  });

  it('new risk monitor alerts become MetaMask notifications, once each', async () => {
    const snap = await installSnap();
    await snap.request({ origin: SITE, method: 'link', params: { token: TOKEN, apiBase } });
    alerts = [{ id: 7, severity: 'critical', title: 'New critical-risk approval: 0xdddd…dddd on USDC (base)' }, { id: 6, severity: 'medium', title: 'A medium one' }];
    const first = await snap.onCronjob({ method: 'checkAlerts' });
    expect(first).toRespondWith({ notified: 2 });
    expect(first).toSendNotification('RektBull critical: New critical-risk approval: 0xdddd…dddd on USDC (base)', 'inApp');
    const again = await snap.onCronjob({ method: 'checkAlerts' });
    expect(again).toRespondWith({ notified: 0 });
  });

  it('the home page shows the link, free checks and new alerts', async () => {
    const snap = await installSnap();
    await snap.request({ origin: SITE, method: 'link', params: { token: TOKEN, apiBase } });
    alerts = [{ id: 9, severity: 'high', title: 'A contract you approved had its code replaced' }];
    const home = text((await snap.onHomePage()).getInterface().content);
    expect(home).toContain('Checking requests for 0x1111…1111.');
    expect(home).toContain('29 of 30 free checks left this month.');
    expect(home).toContain('A contract you approved had its code replaced');
    expect(await snap.request({ origin: SITE, method: 'unlink' })).toRespondWith({ linked: false });
  });
});
