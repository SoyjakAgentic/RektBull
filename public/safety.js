/* RektBull Safety page: token quick check and report, credits, top-ups and passes.
 * Results come only from the server's checks; nothing here guesses. */
(function () {
  'use strict';
  const { ethers } = window;
  const { el, say, api, usd, state, request, switchChain } = window.RB;
  const $ = id => document.getElementById(id);
  const CHAIN_IDS = { ethereum: '0x1', bsc: '0x38', base: '0x2105' };
  const CHAIN_NAMES = { ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon', bsc: 'BNB Chain', solana: 'Solana' };
  const VERDICT = {
    low: 'Low risk found', medium: 'Medium risk', high: 'High risk', critical: 'Critical risk: likely a trap',
    incomplete: 'Incomplete: the checks that decide whether it can be sold didn\'t run',
  };
  const catalog = {};
  let pollTimer = null;

  /* ── start: chains, prices, payment options ── */
  (async () => {
    try {
      const [{ chains }] = await Promise.all([api('GET', '/v1/tokens/chains'), window.RB.catalog.ready]);
      $('chain').replaceChildren(...chains.map(c => el('option', { value: c }, CHAIN_NAMES[c] || c)));
      Object.assign(catalog, window.RB.catalog.products);
      $('quick-price').textContent = window.RB.priceLabel(catalog.token_quick_check);
      $('report-price').textContent = window.RB.priceLabel(catalog.token_report);
      renderPasses();
    } catch (err) { say('check-msg', 'Could not load the page\'s settings: ' + err.message, 'bad'); }
  })();

  /* ── checks ── */
  $('quick').addEventListener('click', () => run('quick-check', 'token_quick_check'));
  $('report').addEventListener('click', () => run('report', 'token_report'));

  async function run(path, productId) {
    const body = { chain: $('chain').value, token_address: $('token').value.trim() };
    if (!body.token_address) return say('check-msg', 'Paste the token\'s contract address first.', 'bad');
    for (const b of [$('quick'), $('report')]) b.disabled = true;
    say('check-msg', productId === 'token_report' ? 'Checking, then writing the report (up to a minute)…' : 'Checking…');
    $('result').hidden = true;
    try {
      const out = await api('POST', '/v1/tokens/' + path, body);
      showResult(out);
      say('check-msg', '');
    } catch (err) {
      say('check-msg', explain(err, productId), 'bad');
      if (err.status === 402) $('account-card').scrollIntoView({ behavior: 'smooth' });
    } finally {
      for (const b of [$('quick'), $('report')]) b.disabled = false;
      if (window.RB.signedIn()) loadAccount();
    }
  }

  function explain(err, productId) {
    const p = catalog[productId] || {};
    if (err.status === 402) return window.RB.paymentMessage(p, err);
    if (err.status >= 500) return 'The check failed on our side, and you weren\'t charged. Try again in a minute.';
    return err.message + ' You weren\'t charged.';
  }

  function showResult(r) {
    const box = $('result');
    const name = r.market?.token_symbol ? `${r.market.token_name || ''} (${r.market.token_symbol})`.trim() : r.token;
    const parts = [
      el('h3', {}, name, ' on ', CHAIN_NAMES[r.chain] || r.chain),
      el('p', {}, el('span', { class: 'verdict ' + r.verdict }, VERDICT[r.verdict] || r.verdict)),
    ];
    if (r.incomplete) parts.push(el('p', { class: 'risk' }, r.incomplete));
    if (r.report_markdown) parts.push(el('div', { class: 'report' }, markdown(r.report_markdown)));
    if (r.market && !r.market.not_checked && r.market.pairs) parts.push(marketFacts(r.market));

    const flags = (r.flags || []).filter(f => f.severity !== 'info');
    parts.push(el('h3', {}, flags.length ? 'What we found' : 'What we found: no known risk patterns'));
    if (flags.length) {
      parts.push(el('ul', { class: 'flags' }, flags.map(f => el('li', { class: f.severity },
        el('div', {}, el('span', { class: 'sev' }, f.severity), el('strong', {}, f.title)),
        f.evidence ? el('div', { class: 'small' }, f.evidence) : null,
        el('div', { class: 'source' }, 'Source: ', f.source || 'not named')))));
    }
    if (r.disagreements?.length) {
      parts.push(el('h3', {}, 'Where sources disagree'), el('ul', {}, r.disagreements.map(d => el('li', {}, d))));
    }
    if (r.not_checked?.length) {
      parts.push(el('h3', {}, 'What we couldn\'t check'), el('ul', { class: 'small' }, r.not_checked.map(n => el('li', {}, el('strong', {}, n.check), ': ', n.reason))));
    }
    if (r.note) parts.push(el('p', { class: 'muted small' }, r.note));
    const run = r.run || {};
    parts.push(el('p', { class: 'paid' }, `Checked ${r.checked_at ? new Date(r.checked_at).toLocaleString() : ''}`, window.RB.paidLabel(run), r.written_by ? ` · Written by ${r.written_by} from these results only` : ''));
    box.replaceChildren(...parts);
    box.hidden = false;
  }

  function marketFacts(m) {
    const n = v => (v === null || v === undefined ? '–' : '$' + Math.round(v).toLocaleString());
    const age = m.first_pair_created_at ? Math.max(0, Math.floor((Date.now() - new Date(m.first_pair_created_at)) / 86400000)) : null;
    return el('div', {},
      el('div', { class: 'facts' },
        el('div', {}, 'Liquidity', el('strong', {}, n(m.liquidity_usd_total))),
        el('div', {}, 'Volume, 24h', el('strong', {}, n(m.volume_24h_usd))),
        el('div', {}, 'Trading for', el('strong', {}, age === null ? '–' : `${age} day${age === 1 ? '' : 's'}`)),
        el('div', {}, 'Pairs', el('strong', {}, String(m.pairs)))),
      el('div', { class: 'source' }, 'Source: ', m.source || 'DexScreener'));
  }

  /* A small Markdown reader for the report: headings, lists, paragraphs, bold and code.
   * Builds text nodes only; the report's text is never parsed as HTML. */
  function markdown(text) {
    const out = [];
    let list = null;
    const inline = s => {
      const nodes = [];
      const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
      let last = 0, m;
      while ((m = re.exec(s))) {
        if (m.index > last) nodes.push(s.slice(last, m.index));
        nodes.push(m[0].startsWith('**') ? el('strong', {}, m[0].slice(2, -2)) : el('code', {}, m[0].slice(1, -1)));
        last = re.lastIndex;
      }
      if (last < s.length) nodes.push(s.slice(last));
      return nodes;
    };
    for (const raw of String(text).split('\n')) {
      const line = raw.trimEnd();
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
      if (li) {
        if (!list) { list = el(/^\s*\d/.test(line) ? 'ol' : 'ul', {}); out.push(list); }
        list.append(el('li', {}, inline(li[1])));
        continue;
      }
      list = null;
      if (h) out.push(el(h[1].length <= 2 ? 'h3' : 'h4', {}, inline(h[2])));
      else if (line.trim()) out.push(el('p', {}, inline(line)));
    }
    return out;
  }

  /* ── account: credits, free points, Safety Pro ── */
  document.addEventListener('rb:account-changed', () => { if (window.RB.signedIn()) loadAccount(); });
  window.RB.onSignedIn(async () => {
    $('account').hidden = false;
    await Promise.all([loadAccount(), loadPaymentMethods()]);
  });

  async function loadAccount() {
    try {
      const me = await api('GET', '/v1/me');
      $('balance').textContent = usd(me.credits_cents);
      const pt = me.points;
      $('points-left').textContent = pt ? `${pt.left} of ${pt.allowance}` : '–';
      $('points-note').textContent = pt ? `Back to ${pt.allowance} on ${new Date(pt.resets_at).toLocaleDateString()}.${pt.new_wallet ? ' New wallets start with fewer; a wallet with transactions gets more next month.' : ''}` : '';
      const pass = me.passes?.[0];
      const reports = me.pass_included?.token_report;
      $('pass').textContent = pass ? `Until ${new Date(pass.ends_at).toLocaleDateString()}${reports ? ` · ${reports.left} of ${reports.allowance} reports left this month` : ''}` : 'none';
    } catch (err) { if (err.status !== 401) say('topup-msg', err.message, 'bad'); }
  }

  let methods = [];
  async function loadPaymentMethods() {
    const pm = await api('GET', '/v1/payment-methods');
    const top = pm.stablecoin_top_ups;
    $('topup-form').hidden = $('t-create').hidden = !top.enabled;
    $('topup-off').hidden = top.enabled;
    if (!top.enabled) { $('topup-off').textContent = 'Top-ups aren\'t switched on on this server yet.'; return; }
    methods = top.chains;
    $('t-amount').min = Math.ceil(top.min_cents / 100);
    $('t-chain').replaceChildren(...methods.map(m => el('option', { value: m.chain }, CHAIN_NAMES[m.chain] || m.chain)));
    fillCoins();
  }
  function fillCoins() {
    const m = methods.find(x => x.chain === $('t-chain').value);
    $('t-coin').replaceChildren(...(m?.tokens || []).map(t => el('option', { value: t }, t)));
  }
  $('t-chain').addEventListener('change', fillCoins);

  $('t-create').addEventListener('click', async () => {
    try {
      const inv = await api('POST', '/v1/invoices', { chain: $('t-chain').value, token: $('t-coin').value, amount_cents: Math.round(Number($('t-amount').value) * 100) });
      showInvoice(inv);
      say('topup-msg', '');
    } catch (err) { say('topup-msg', err.message, 'bad'); }
  });

  function showInvoice(inv) {
    const box = $('invoice');
    const canSend = !!state.provider && CHAIN_IDS[inv.chain];
    box.replaceChildren(el('div', { class: 'send' },
      el('div', {}, 'Send ', el('strong', {}, `${inv.send.amount} ${inv.token}`), ' on ', CHAIN_NAMES[inv.chain] || inv.chain, ' to'),
      el('code', { id: 'deposit-address' }, inv.send.to),
      el('div', { class: 'small muted' }, `${inv.token} contract: `, el('code', {}, inv.send.token_contract)),
      el('div', { class: 'small muted' }, inv.note),
      el('div', { class: 'small', id: 'invoice-status' }, statusText(inv)),
      canSend ? el('button', { class: 'primary', onclick: () => sendFromWallet(inv) }, 'Send from my wallet') : el('div', { class: 'small muted' }, 'Connect your wallet above to send it from here, or send it from any wallet.')));
    box.hidden = false;
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const now = await api('GET', '/v1/invoices/' + inv.id);
        $('invoice-status').textContent = statusText(now);
        if (now.status !== 'pending') { clearInterval(pollTimer); loadAccount(); }
      } catch { /* try again next time */ }
    }, 15000);
  }
  const statusText = inv => ({
    pending: inv.paid_cents ? `Received ${usd(inv.paid_cents)} so far; waiting for the rest.` : 'Waiting for your payment. Credits appear after the chain confirms it (a few minutes).',
    paid: `Paid: ${usd(inv.paid_cents)} added to your credits.`,
    expired: 'This deposit request has expired. A payment sent to the address is still credited.',
  }[inv.status] || inv.status);

  async function sendFromWallet(inv) {
    try {
      await switchChain(CHAIN_IDS[inv.chain]);
      const data = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']).encodeFunctionData('transfer', [inv.send.to, inv.send.amount_raw]);
      const hash = await request('eth_sendTransaction', [{ from: state.address, to: inv.send.token_contract, data }]);
      say('topup-msg', `Sent (${hash.slice(0, 10)}…). Credits appear after the chain confirms it.`, 'ok');
    } catch (err) { say('topup-msg', err.message, 'bad'); }
  }

  function renderPasses() {
    const passes = Object.values(catalog).filter(p => p.kind === 'pass');
    if (passes[0]) $('pro-what').textContent = passes[0].description;
    $('passes').replaceChildren(...passes.map(p => el('button', { class: p.days === 30 ? 'primary' : '', onclick: () => buyPass(p) }, `${p.title}: ${p.price_usd}`)));
  }
  async function buyPass(p) {
    if (!window.RB.signedIn()) return say('pass-msg', 'Sign in first.', 'bad');
    if (!confirm(`Buy ${p.title} for ${p.price_usd} from your credits? ${p.description}`)) return;
    try {
      await api('POST', '/v1/passes/' + p.id);
      say('pass-msg', `${p.title} is active.`, 'ok');
      document.dispatchEvent(new Event('rb:account-changed'));
      loadAccount();
    } catch (err) {
      say('pass-msg', err.status === 402 ? `Not enough credits: it costs ${p.price_usd}, you have ${usd(err.data?.balance_cents || 0)}. Top up above.` : err.message, 'bad');
    }
  }
})();
