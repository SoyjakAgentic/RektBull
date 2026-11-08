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
      // A link from Home (…/safety?chain=base&token=0x…) fills the form; checking is still the user's click.
      const link = new URLSearchParams(location.search);
      if (chains.includes(link.get('chain'))) $('chain').value = link.get('chain');
      if (/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(link.get('token') || '')) $('token').value = link.get('token');
      Object.assign(catalog, window.RB.catalog.products);
      $('quick-price').textContent = window.RB.priceLabel(catalog.token_quick_check);
      $('report-price').textContent = window.RB.priceLabel(catalog.token_report);
      $('launch-price').textContent = window.RB.priceLabel(catalog.launch_check);
      $('audit-price').textContent = window.RB.priceLabel(catalog.contract_audit);
      $('audit-chain').replaceChildren(...chains.filter(c => c !== 'solana').map(c => el('option', { value: c }, CHAIN_NAMES[c] || c)));
      if (/^0x[0-9a-fA-F]{40}$/.test(link.get('audit') || '')) { $('audit-address').value = link.get('audit'); if (chains.includes(link.get('chain'))) $('audit-chain').value = link.get('chain'); }
      renderPasses();
    } catch (err) { say('check-msg', 'Could not load the page\'s settings: ' + err.message, 'bad'); }
  })();

  /* ── checks ── */
  $('quick').addEventListener('click', () => run('quick-check', 'token_quick_check'));
  $('report').addEventListener('click', () => run('report', 'token_report'));
  $('launch').addEventListener('click', () => run('launch', 'launch_check'));
  const BUTTONS = ['quick', 'report', 'launch'];

  async function run(path, productId) {
    const body = { chain: $('chain').value, token_address: $('token').value.trim() };
    if (!body.token_address) return say('check-msg', 'Paste the token\'s contract address first.', 'bad');
    for (const b of BUTTONS) $(b).disabled = true;
    say('check-msg', productId === 'token_report' ? 'Checking, then writing the report (up to a minute)…' : productId === 'launch_check' ? 'Reading the launch: its first buyers and where their funds came from (up to a minute)…' : 'Checking…');
    $('result').hidden = true;
    try {
      const out = await api('POST', path === 'launch' ? '/v1/launch/check' : '/v1/tokens/' + path, body);
      if (path === 'launch') showLaunch(out); else showResult(out);
      say('check-msg', '');
    } catch (err) {
      say('check-msg', explain(err, productId), 'bad');
      if (err.status === 402) $('account-card').scrollIntoView({ behavior: 'smooth' });
    } finally {
      for (const b of BUTTONS) $(b).disabled = false;
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

  /* The launch check: bundles, links to the deployer, and what they hold now. */
  const LAUNCH = { bundle_found: ['high', 'Bundle found'], possible_bundle: ['medium', 'Possible bundle'], no_bundle_found: ['low', 'No bundle found'] };
  const shortAddr = a => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
  const pc = v => (v === null || v === undefined ? '–' : `${v}%`);
  function showLaunch(r) {
    const [cls, label] = LAUNCH[r.verdict] || ['medium', r.verdict];
    const parts = [
      el('h3', {}, 'Launch check: ', el('span', { class: 'mono' }, shortAddr(r.token)), ' on ', CHAIN_NAMES[r.chain] || r.chain),
      el('p', {}, el('span', { class: 'verdict ' + cls }, label), ' ', r.summary),
      el('p', { class: 'small muted' }, `Launched ${new Date(r.launch.at).toLocaleString()}`, r.launch.deployer ? ` by ${shortAddr(r.launch.deployer)}` : '', ` · ${r.early_buyers.traced} largest buyers in the first ${r.launch.window_minutes} minutes traced; together they bought ${pc(r.early_buyers.bought_pct)} of the supply`, r.early_buyers.contracts_set_aside ? ` · ${r.early_buyers.contracts_set_aside} pool, router or program account${r.early_buyers.contracts_set_aside === 1 ? '' : 's'} set aside` : ''),
    ];
    if (r.groups.length) {
      parts.push(el('h3', {}, 'Early buyers sharing a funder'), el('div', { class: 'tablewrap' }, el('table', { class: 'rank' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Funded from'), el('th', { class: 'num' }, 'Wallets'), el('th', { class: 'num' }, 'Bought at launch'), el('th', { class: 'num' }, 'Hold now'), el('th', { class: 'num' }, 'Sold'), el('th', {}, 'Deployer link'))),
        el('tbody', {}, r.groups.map(g => el('tr', {},
          el('td', {}, el('span', { class: 'mono', title: g.funder }, shortAddr(g.funder)), g.funder_kind === 'busy' ? el('span', { class: 'small muted' }, ' (busy: likely an exchange, not counted)') : g.funder_kind === 'contract' ? el('span', { class: 'small muted' }, ' (a contract)') : null),
          el('td', { class: 'num' }, String(g.wallets.length)), el('td', { class: 'num' }, pc(g.bought_pct)), el('td', { class: 'num' }, pc(g.holds_pct)),
          el('td', { class: 'num' }, g.sold_pct === null ? '–' : `${g.sold_pct}%`),
          el('td', { class: 'small' }, g.linked_to_deployer ? `${g.linked_to_deployer.hops} step${g.linked_to_deployer.hops === 1 ? '' : 's'}` : 'none found')))))));
    }
    const flags = r.flags.filter(f => f.severity !== 'info');
    if (flags.length) {
      parts.push(el('h3', {}, 'What we found'), el('ul', { class: 'flags' }, flags.map(f => el('li', { class: f.severity },
        el('div', {}, el('span', { class: 'sev' }, f.severity), el('strong', {}, f.title)),
        el('div', { class: 'small' }, f.evidence), el('div', { class: 'source' }, 'Source: ', f.source)))));
    }
    for (const f of r.flags.filter(x => x.severity === 'info')) parts.push(el('p', { class: 'small muted' }, f.title, ': ', f.evidence));
    if (r.not_checked?.length) parts.push(el('h3', {}, 'What we couldn\'t check'), el('ul', { class: 'small' }, r.not_checked.map(n => el('li', {}, el('strong', {}, n.check), ': ', n.reason))));
    parts.push(el('p', { class: 'muted small' }, r.note, ' ', el('a', { href: '/agents#agent-launch_safety' }, 'Watch it with Launch Safety'), ' to be told if these wallets start selling.'));
    parts.push(el('p', { class: 'paid' }, `Checked ${new Date(r.checked_at).toLocaleString()}`, window.RB.paidLabel(r.run || {}), ` · Sources: ${r.sources.join('; ')}`));
    $('result').replaceChildren(...parts);
    $('result').hidden = false;
  }

  /* ── contract audit ── */
  $('audit').addEventListener('click', async () => {
    const body = { chain: $('audit-chain').value, address: $('audit-address').value.trim() };
    if (!body.address) return say('audit-msg', 'Paste the contract\'s address first.', 'bad');
    $('audit').disabled = true;
    $('audit-result').hidden = true;
    say('audit-msg', 'Reading the verified source, compiling it and running Slither, then writing the summary. This can take a few minutes…');
    try {
      showAudit(await api('POST', '/v1/contracts/audit', body));
      say('audit-msg', '');
    } catch (err) {
      say('audit-msg', explain(err, 'contract_audit'), 'bad');
      if (err.status === 402) $('account-card').scrollIntoView({ behavior: 'smooth' });
    } finally {
      $('audit').disabled = false;
      if (window.RB.signedIn()) loadAccount();
    }
  });

  const IMPACT = { High: 'high', Medium: 'medium', Low: 'low' };
  function showAudit(r) {
    const where = l => `${l.file || '?'}${l.lines?.length ? `:${l.lines[0]}${l.lines[1] !== l.lines[0] ? `-${l.lines[1]}` : ''}` : ''}`;
    const parts = [
      el('h3', {}, r.contract.name || 'Contract', ' ', el('span', { class: 'mono small' }, r.address), ' on ', CHAIN_NAMES[r.chain] || r.chain),
      el('p', { class: 'small muted' }, r.units.map(u => `${u.role === 'implementation' ? 'Implementation' : r.contract.proxy ? 'Proxy' : 'Contract'} ${u.contract_name || ''}: ${u.verified ? `verified, ${u.own_files} of its own file${u.own_files === 1 ? '' : 's'} (${u.files} with libraries), ${u.compiler}` : 'not verified'}`).join(' · ')),
    ];
    if (r.summary?.markdown) parts.push(el('div', { class: 'report' }, markdown(r.summary.markdown)), el('p', { class: 'small muted' }, `Written by ${r.summary.written_by} from the findings below only; it doesn't add or confirm any.`));
    else if (r.summary?.not_written) parts.push(el('p', { class: 'small muted' }, r.summary.not_written));
    for (const s of r.slither) {
      parts.push(el('h3', {}, `Slither${r.slither.length > 1 ? ` (${s.role})` : ''}`));
      if (s.not_run) { parts.push(el('p', { class: 'small risk' }, s.not_run)); continue; }
      parts.push(el('p', { class: 'small muted' }, `${s.detectors} detectors, Slither ${s.slither}, solc ${s.solc}, ${s.seconds}s. ${Object.values(s.informational_counts || {}).reduce((a, b) => a + b, 0)} informational notes not listed${s.library_findings_hidden ? `; ${s.library_findings_hidden} in libraries not listed` : ''}.`));
      parts.push(s.findings.length ? el('ul', { class: 'flags' }, s.findings.map(f => el('li', { class: IMPACT[f.impact] || 'low' },
        el('div', {}, el('span', { class: 'sev' }, `${f.impact} · ${f.confidence} confidence`), el('strong', {}, f.check)),
        el('div', { class: 'small' }, f.description),
        el('div', { class: 'source' }, 'Where: ', f.locations.slice(0, 3).map(where).join(', ') || 'not given', ' · Source: Slither')))) : el('p', {}, 'Slither listed no high, medium or low findings in the contract\'s own code.'));
    }
    const leads = r.leads.filter(l => l.severity !== 'info');
    const powers = r.leads.filter(l => l.severity === 'info');
    if (leads.length) {
      parts.push(el('h3', {}, 'Checklist patterns'), el('ul', { class: 'flags' }, leads.map(l => el('li', { class: l.severity },
        el('div', {}, el('span', { class: 'sev' }, l.severity), el('strong', {}, l.title)),
        el('div', { class: 'small mono' }, l.snippet), el('div', { class: 'source' }, `Where: ${l.file}:${l.line} · Source: pattern check (${l.rule})`)))));
    }
    if (powers.length) parts.push(el('h3', {}, 'Who holds power over it'), el('ul', { class: 'small' }, powers.map(l => el('li', {}, `${l.title} (${l.file}:${l.line})`))));
    const bugs = r.compiler.flatMap(c => (c.known_bugs || []).filter(b => b.applies !== false).map(b => ({ ...b, role: c.role })));
    if (bugs.length) parts.push(el('h3', {}, 'Known compiler bugs that may apply'), el('ul', { class: 'small' }, bugs.slice(0, 10).map(b => el('li', {}, el('strong', {}, b.name), ` (${b.severity}${b.applies === 'unknown' ? `, ${b.why}` : ''}): ${b.summary}`))), el('p', { class: 'source' }, 'Source: the Solidity team\'s bug list. A bug matters only where the code uses what it breaks.'));
    if (r.not_checked?.length) parts.push(el('h3', {}, 'What we couldn\'t check'), el('ul', { class: 'small' }, r.not_checked.map(n => el('li', {}, el('strong', {}, n.check), ': ', n.reason))));
    parts.push(el('p', { class: 'muted small' }, r.note));
    if (r.report_pdf) parts.push(el('p', {}, el('a', { class: 'btn primary', href: r.report_pdf, download: '' }, 'Download the PDF report'), el('span', { class: 'small muted' }, ' Keep the link: it is the key to your report.')));
    parts.push(el('p', { class: 'paid' }, `Checked ${new Date(r.checked_at).toLocaleString()}`, window.RB.paidLabel(r.run || {}), ` · Sources: ${r.sources.join('; ')}`));
    $('audit-result').replaceChildren(...parts);
    $('audit-result').hidden = false;
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

  const markdown = window.RB.markdown;

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
      $('pass').textContent = pass ? `Until ${new Date(pass.ends_at).toLocaleDateString()}` : 'none';
      // Safety Pro's AI allowance, as a percentage left (like an AI subscription's usage meter).
      const ai = me.ai_allowance;
      $('ai-meter').hidden = !ai;
      if (ai) {
        $('ai-left').textContent = `${ai.left_pct}% left`;
        $('ai-bar').style.width = `${ai.used_pct}%`;
        $('ai-bar').className = ai.left_pct <= 10 ? 'low' : '';
        $('ai-bar').parentElement.setAttribute('aria-valuenow', String(ai.used_pct));
        $('ai-note').textContent = `${ai.left_pct ? 'For full token reports and proposal summaries.' : 'Used up: reports and summaries are paid like any run until it resets.'} Resets ${new Date(ai.resets_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.`;
      }
    } catch (err) { if (err.status !== 401) say('topup-msg', err.message, 'bad'); }
  }

  let methods = [];
  let npEnabled = false;
  async function loadPaymentMethods() {
    const pm = await api('GET', '/v1/payment-methods');
    const top = pm.stablecoin_top_ups;
    npEnabled = !!pm.nowpayments?.enabled;
    $('t-np').hidden = $('t-np-note').hidden = !npEnabled;
    $('topup-form').hidden = !top.enabled && !npEnabled;
    $('t-create').hidden = !top.enabled;
    for (const id of ['t-chain', 't-coin']) $(id).closest('label').hidden = !top.enabled;
    $('topup-off').hidden = top.enabled || npEnabled;
    renderPasses();
    if (!top.enabled) { if (!npEnabled) $('topup-off').textContent = 'Top-ups aren\'t switched on on this server yet.'; return; }
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
    $('passes').replaceChildren(
      ...passes.map(p => el('button', { class: p.days === 30 ? 'primary' : '', onclick: () => buyPass(p) }, `${p.title}: ${p.price_usd}`)),
      ...(npEnabled ? passes.map(p => el('button', { class: 'link', onclick: () => payWithNowPayments({ product: p.id }, 'pass-msg') }, `or pay ${p.price_usd} with any coin (${p.days} days)`)) : []),
    );
  }

  /* NOWPayments: off to its payment page, back here with ?paid=<id>. */
  async function payWithNowPayments(body, msgId) {
    if (!window.RB.signedIn()) return say(msgId, 'Sign in first.', 'bad');
    try {
      say(msgId, 'Opening NOWPayments…');
      const c = await api('POST', '/v1/checkout/nowpayments', body);
      location.href = c.invoice_url;
    } catch (err) { say(msgId, err.message, 'bad'); }
  }
  $('t-np').addEventListener('click', () => payWithNowPayments({ amount_cents: Math.round(Number($('t-amount').value) * 100) }, 'topup-msg'));
  const paidId = new URLSearchParams(location.search).get('paid');
  if (paidId && /^[0-9a-f-]{36}$/.test(paidId)) {
    const NP_STATUS = {
      pending: 'Waiting for NOWPayments to see your payment…', confirming: 'NOWPayments has your payment and is confirming it. Credits appear when it\'s done.',
      paid: 'Paid: it\'s in your credits (and your pass, if you bought one, is active).', expired: 'That NOWPayments payment expired or was refunded. Nothing was charged here.',
    };
    const check = async (tries = 0) => {
      if (!window.RB.signedIn()) return;
      try {
        const c = await api('GET', '/v1/checkout/' + paidId);
        say('topup-msg', c.note || NP_STATUS[c.status] || c.status, c.status === 'paid' ? 'ok' : c.status === 'underpaid' || c.status === 'expired' ? 'bad' : '');
        if (c.status === 'paid') { loadAccount(); document.dispatchEvent(new Event('rb:account-changed')); return; }
        if (['pending', 'confirming'].includes(c.status) && tries < 40) setTimeout(() => check(tries + 1), 15000);
      } catch (err) { say('topup-msg', err.message, 'bad'); }
    };
    window.RB.onSignedIn(() => check());
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
