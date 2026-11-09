/* The admin panel: dashboard and health, emergency stops, prices, AI agents, external services, accounts, tools and the banner.
 * Every change asks for a reason and is logged on the server. */
(function () {
  'use strict';
  const { el, say, api, toast } = window.RB;
  const $ = id => document.getElementById(id);
  const money = c => (c % 100 === 0 ? `$${(c / 100).toLocaleString('en-US')}` : `$${(c / 100).toFixed(2)}`);
  const pct = b => `${b / 100}%`;
  const show = (k, v) => (k === 'price_cents' ? money(v) : k.endsWith('fee_bps') ? pct(v) : `${v} point${v === 1 ? '' : 's'}`);
  // A fee is a share of what's claimed or moved: its $0 price means nothing, so it isn't shown.
  const describe = vals => Object.entries(vals || {}).filter(([k]) => !(k === 'price_cents' && 'fee_bps' in vals)).map(([k, v]) => (k === 'pro_fee_bps' ? `${pct(v)} with Safety Pro` : show(k, v))).join(' · ') || '–';
  const NAMES = { price_cents: 'Price ($)', points: 'Points', fee_bps: 'Fee (%)', pro_fee_bps: 'Safety Pro fee (%)' };
  const toInput = (k, v) => (k === 'price_cents' ? (v / 100).toFixed(2) : k.endsWith('fee_bps') ? String(v / 100) : String(v));
  const fromInput = (k, s) => (k === 'price_cents' ? Math.round(Number(s) * 100) : k.endsWith('fee_bps') ? Math.round(Number(s) * 100) : Number(s));

  /** Asks why, then sends the change; a stale sign-in asks for a fresh one. */
  async function change(msgId, what, method, path, body = {}, after = null) {
    const reason = window.prompt(`${what}\n\nWhy? (kept in the change log)`);
    if (reason === null) return;
    try {
      await api(method, path, { ...body, reason });
      toast('Saved');
      await load();
      if (after) await after();
    } catch (err) {
      say(msgId, err.status === 401 ? 'Your sign-in is older than 15 minutes, or ended. Sign in again (the button at the top), then repeat the change.' : err.message, 'bad');
      if (err.status === 401) { $('gate').hidden = false; }
    }
  }

  function stops(list) {
    $('stops').replaceChildren(...list.map(s => el('div', { class: 'row' },
      el('p', {}, el('strong', {}, s.name), ' ', el('span', { class: `tag${s.on ? ' bad' : ''}` }, s.on ? 'STOPPED' : 'running'), el('br'), el('span', { class: 'small muted' }, s.does)),
      el('button', {
        class: s.on ? 'btn' : 'btn danger', type: 'button',
        onclick: () => { if (s.on || window.confirm(`Stop ${s.name.toLowerCase()} now?`)) change('stops-msg', `${s.on ? 'Resume' : 'Stop'}: ${s.name}`, 'PUT', `/v1/admin/stops/${s.id}`, { on: !s.on }); },
      }, s.on ? 'Resume' : 'Stop now'))));
  }

  function prices(p) {
    $('prices').querySelector('tbody').replaceChildren(...p.products.map(x => {
      const inputs = x.editable.map(k => el('label', { class: 'inline' }, NAMES[k], ' ', el('input', { type: 'number', step: k === 'price_cents' ? '0.01' : k === 'points' ? '1' : '0.01', min: '0', value: toInput(k, x.current[k]), 'data-k': k, size: '7' })));
      const row = el('tr', {},
        el('td', {}, el('strong', {}, x.title), el('div', { class: 'sub' }, x.id, x.changed ? ' · changed' : '')),
        el('td', {}, describe(x.current)),
        el('td', { class: 'muted' }, describe(x.defaults)),
        el('td', {}, x.fixed ? el('span', { class: 'small muted' }, x.fixed) : inputs),
        el('td', {}, x.fixed ? '' : [
          el('button', { class: 'btn', type: 'button', onclick: () => {
            const body = {};
            for (const i of row.querySelectorAll('input[data-k]')) body[i.dataset.k] = fromInput(i.dataset.k, i.value);
            change('prices-msg', `${x.title}: ${describe(body)}`, 'PUT', `/v1/admin/prices/${x.id}`, body);
          } }, 'Save'),
          x.changed ? el('button', { class: 'btn ghost', type: 'button', onclick: () => change('prices-msg', `${x.title}: back to ${describe(x.defaults)}`, 'DELETE', `/v1/admin/prices/${x.id}`) }, 'Default') : '',
        ]));
      return row;
    }));
    const fp = p.free_points;
    const fpIn = k => el('label', { class: 'inline' }, { per_month: 'A month', new_wallet: 'New wallet', per_ip_per_day: 'Per IP a day (signed out)' }[k], ' ', el('input', { type: 'number', min: '0', step: '1', value: fp.current[k], 'data-k': k, size: '5' }));
    $('points').replaceChildren(...Object.keys(fp.current).map(fpIn), el('button', { class: 'btn', type: 'button', onclick: () => {
      const body = {};
      for (const i of $('points').querySelectorAll('input')) body[i.dataset.k] = Number(i.value);
      change('prices-msg', `Free points: ${JSON.stringify(body)}`, 'PUT', '/v1/admin/free-points', body);
    } }, 'Save'), el('span', { class: 'small muted' }, `Defaults: ${fp.defaults.per_month} a month, ${fp.defaults.new_wallet} for a new wallet, ${fp.defaults.per_ip_per_day} per IP a day.`));
    const ai = p.ai_allowance;
    $('ai').replaceChildren(
      el('label', { class: 'inline' }, 'Every 30 days ($) ', el('input', { id: 'ai-usd', type: 'number', min: '0', step: '0.01', value: (ai.cents_per_30_days / 100).toFixed(2), size: '6' })),
      el('button', { class: 'btn', type: 'button', onclick: () => change('prices-msg', `AI allowance: ${money(Math.round(Number($('ai-usd').value) * 100))} every 30 days`, 'PUT', '/v1/admin/ai-allowance', { cents_per_30_days: Math.round(Number($('ai-usd').value) * 100) }) }, 'Save'),
      el('span', { class: 'small muted' }, `Default ${money(ai.default_cents)}; at most the 30-day pass price (${money(ai.limits[1])}), so a pass never loses money on AI.`));
  }

  function agents(list) {
    $('agents').querySelector('tbody').replaceChildren(...list.map(a => {
      const pick = el('select', {}, ...['active', 'hidden', 'off'].map(s => el('option', { value: s, selected: s === a.state ? 'selected' : null }, s)));
      return el('tr', {},
        el('td', {}, el('strong', {}, a.name), el('div', { class: 'sub' }, a.id)),
        el('td', {}, pick),
        el('td', {}, el('button', { class: 'btn', type: 'button', onclick: () => {
          if (pick.value === a.state) return;
          if (pick.value === 'off' && !window.confirm(`Switch ${a.name} off? Its users get one alert.`)) return;
          change('agents-msg', `${a.name}: ${a.state} → ${pick.value}`, 'PUT', `/v1/admin/agents/${a.id}`, { state: pick.value });
        } }, 'Save')));
    }));
  }

  function log(rows) {
    const j = v => (v === null || v === undefined ? '–' : JSON.stringify(v));
    $('log').querySelector('tbody').replaceChildren(...(rows.length ? rows.map(r => el('tr', {},
      el('td', { class: 'small' }, new Date(r.at).toLocaleString()),
      el('td', { class: 'small' }, window.RB.short(r.wallet)),
      el('td', {}, r.action, el('div', { class: 'sub' }, r.key)),
      el('td', { class: 'small' }, j(r.before)),
      el('td', { class: 'small' }, j(r.after)),
      el('td', {}, r.reason))) : [el('tr', {}, el('td', { colspan: '6', class: 'muted' }, 'No changes yet.'))]));
  }

  /* ── part 2: dashboard and health, services, accounts, tools and banner ── */

  const when = iso => (iso ? new Date(iso).toLocaleString() : '–');
  const tile = (label, value, note) => el('div', { class: 'tile' }, el('span', { class: 'small muted' }, label), el('h3', {}, value), note ? el('span', { class: 'small muted' }, note) : '');
  const table = (head, rows) => el('div', { class: 'tablewrap' }, el('table', { class: 'rank' }, el('thead', {}, el('tr', {}, ...head.map(h => el('th', {}, h)))), el('tbody', {}, ...(rows.length ? rows : [el('tr', {}, el('td', { colspan: String(head.length), class: 'muted' }, 'Nothing yet.'))]))));

  async function loadHealth() {
    const h = await api('GET', '/v1/admin/health');
    $('health').replaceChildren(
      h.problems.length ? el('p', { class: 'msg bad' }, `Needs a look: ${h.problems.join('; ')}.`) : el('p', { class: 'msg ok' }, 'Every job ran on time, and no alert is overdue.'),
      el('h3', {}, 'Background jobs'),
      table(['Job', 'State', 'Last worked', 'Last failed'], h.jobs.map(j => el('tr', {},
        el('td', {}, el('strong', {}, j.name), el('div', { class: 'sub' }, j.what)),
        el('td', {}, el('span', { class: `tag ${j.state === 'late' || j.state === 'failing' ? 'bad' : j.state === 'ok' ? 'ok' : ''}` }, j.state)),
        el('td', { class: 'small' }, when(j.last_ok_at)),
        el('td', { class: 'small' }, j.last_error_at ? [when(j.last_error_at), el('div', { class: 'sub' }, j.last_error)] : '–')))),
      el('h3', {}, 'Alerts'),
      table(['Channel', 'Sent, 24 h', 'Failed, 24 h', 'Overdue'], h.alerts.by_channel.map(c => el('tr', {}, el('td', {}, c.kind), el('td', { class: 'num' }, c.sent_24h), el('td', { class: 'num' }, c.failed_24h), el('td', { class: 'num' }, c.overdue)))),
      ...(h.alerts.recent_errors.length ? [el('p', { class: 'small muted' }, 'Recent errors: ', h.alerts.recent_errors.map(e => `${e.kind}: ${e.last_error} (${e.n})`).join('; '))] : []),
      el('p', { class: 'source' }, `From ${h.source}.`));
  }

  async function loadDash() {
    const d = await api('GET', `/v1/admin/dashboard?days=${$('dash-days').value}`);
    const r = d.revenue;
    $('dash').replaceChildren(
      el('div', { class: 'tiles' },
        tile('Money in', money(r.total_cents), `deposits ${money(r.deposits_cents)} · checkout ${money(r.hosted_checkout_cents)} · x402 ${money(r.x402_cents)}`),
        tile('Fees paid in tokens', `${r.claim_fees_paid + r.yield_fees_paid}`, `${r.claim_fees_paid} claim · ${r.yield_fees_paid} yield move`),
        tile('Active Safety Pro', String(d.passes.active_accounts), `${d.passes.bought.reduce((s, p) => s + p.bought, 0)} bought in the period`),
        tile('AI spend', `$${d.ai.total_usd.toFixed(2)}`, 'estimated at list prices'),
        tile('Accounts', String(d.accounts.total), `${d.accounts.new} new`)),
      el('h3', {}, 'Paid runs that worked'),
      table(['Product', 'Paid with', 'Runs', 'Charged'], d.runs.map(x => el('tr', {}, el('td', {}, x.product), el('td', {}, x.payment_method), el('td', { class: 'num' }, x.runs), el('td', { class: 'num' }, money(x.cents))))),
      el('h3', {}, 'Runs that failed (never charged)'),
      table(['Product', 'Runs', 'Last error'], d.failed_runs.map(x => el('tr', {}, el('td', {}, x.product), el('td', { class: 'num' }, x.runs), el('td', { class: 'small' }, x.last_error || '–')))),
      el('p', { class: 'small muted' }, `Credits spent: ${money(d.spent_from_credits.runs_cents)} on runs, ${money(d.spent_from_credits.passes_cents)} on passes; ${money(d.spent_from_credits.refunded_cents)} refunded, ${money(d.spent_from_credits.adjustments_cents)} added by admins. AI by day: ${d.ai.by_day.map(x => `${x.day} $${x.usd.toFixed(2)}`).join(', ') || 'none'}.`),
      el('p', { class: 'source' }, `From ${r.source}; ${d.ai.source}.`));
  }

  async function loadServices() {
    const { providers } = await api('GET', '/v1/admin/providers');
    $('services').querySelector('tbody').replaceChildren(...providers.map(p => {
      const lim = el('input', { type: 'number', min: '1', step: '1', size: '8', value: p.daily_limit ?? '', placeholder: p.env_limit ? String(p.env_limit) : 'none' });
      const usd = p.budget ? el('input', { type: 'number', min: '1', step: '1', size: '6', value: p.daily_usd ?? '', placeholder: 'no cap' }) : null;
      return el('tr', {},
        el('td', {}, el('strong', {}, p.name), p.off ? el('span', { class: 'tag bad' }, 'OFF') : '', el('div', { class: 'sub' }, p.what), p.fallback ? el('div', { class: 'sub' }, `Fallback: ${p.fallback}`) : ''),
        el('td', { class: 'num' }, `${p.calls_today}`, p.errors_today ? el('div', { class: 'sub' }, `${p.errors_today} errors`) : '', p.budget ? el('div', { class: 'sub' }, `$${p.spent_today_usd.toFixed(2)} spent`) : ''),
        el('td', { class: 'num' }, `${p.calls_7d}`, p.errors_7d ? el('div', { class: 'sub' }, `${p.errors_7d} errors`) : ''),
        el('td', { class: 'small' }, p.last_error ? [when(p.last_error_at), el('div', { class: 'sub' }, p.last_error)] : '–'),
        el('td', { class: 'small' }, p.keys.length ? p.keys.map(k => el('div', {}, `${k.name}: `, el('strong', {}, k.set ? 'set' : 'not set'))) : 'no key'),
        el('td', {}, p.budget ? el('label', { class: 'inline' }, '$ ', usd) : lim),
        el('td', {},
          el('button', { class: 'btn', type: 'button', onclick: () => change('services-msg', `${p.name}: ${p.budget ? `daily AI budget ${usd.value ? '$' + usd.value : 'none'}` : `daily limit ${lim.value || 'from settings'}`}`, 'PUT', `/v1/admin/providers/${encodeURIComponent(p.name)}`, p.budget ? { daily_usd: usd.value ? Number(usd.value) : null } : { daily_limit: lim.value ? Number(lim.value) : null }, loadServices) }, 'Save'),
          el('button', { class: p.off ? 'btn' : 'btn danger', type: 'button', onclick: () => { if (p.off || window.confirm(`Switch ${p.name} off? RektBull will treat it as unavailable.`)) change('services-msg', `${p.name}: ${p.off ? 'on' : 'off'}`, 'PUT', `/v1/admin/providers/${encodeURIComponent(p.name)}`, { off: !p.off }, loadServices); } }, p.off ? 'Switch on' : 'Switch off'),
          p.can_test ? el('button', { class: 'btn', type: 'button', onclick: async e => {
            e.target.disabled = true;
            try { const t = await api('POST', `/v1/admin/providers/${encodeURIComponent(p.name)}/test`); say('services-msg', t.ok ? `${p.name} answered in ${t.ms} ms.` : `${p.name} failed after ${t.ms} ms: ${t.error}`, t.ok ? 'ok' : 'bad'); } catch (err) { say('services-msg', err.status === 401 ? 'Sign in again (the button at the top) to run a test.' : err.message, 'bad'); }
            e.target.disabled = false;
          } }, 'Test now') : ''));
    }));
  }

  async function loadAccount(q) {
    const a = await api('GET', `/v1/admin/accounts/${encodeURIComponent(q)}`);
    const acc = a.account;
    const act = (what, method, path, body) => change('acct-msg', `${acc.wallet}: ${what}`, method, `/v1/admin/accounts/${acc.id}${path}`, body, () => loadAccount(q));
    const cents = el('input', { type: 'number', min: '0.01', step: '0.01', size: '7', placeholder: '$' });
    const days = el('input', { type: 'number', min: '1', max: '365', step: '1', size: '5', placeholder: 'days' });
    $('acct').replaceChildren(
      el('p', {}, el('strong', {}, acc.wallet), ` · account ${acc.id} · since ${when(acc.created_at)} · credits ${money(acc.credits_cents)}`, acc.blocked ? el('span', { class: 'tag bad' }, 'BLOCKED') : ''),
      el('p', { class: 'small muted' }, `Watches ${a.watched_wallets} wallet(s); agents on: ${a.agents.filter(x => x.enabled).map(x => x.agent).join(', ') || 'none'}; alert channels: ${a.alert_channels.map(c => `${c.kind}${c.disabled ? ' (off)' : c.verified ? '' : ' (unverified)'}`).join(', ') || 'none'}.`),
      el('div', { class: 'row' },
        el('label', { class: 'inline' }, 'Add credits ', cents), el('button', { class: 'btn', type: 'button', onclick: () => act(`add ${money(Math.round(Number(cents.value) * 100))} credits`, 'POST', '/credits', { cents: Math.round(Number(cents.value) * 100) }) }, 'Add'),
        el('label', { class: 'inline' }, 'Safety Pro ', days), el('button', { class: 'btn', type: 'button', onclick: () => act(`add ${days.value} days of Safety Pro`, 'POST', '/pass', { days: Number(days.value) }) }, 'Extend'),
        el('button', { class: acc.blocked ? 'btn' : 'btn danger', type: 'button', onclick: () => { if (acc.blocked || window.confirm('Block this wallet? It is signed out and can\'t sign in again.')) act(acc.blocked ? 'unblock' : 'block', 'PUT', '/blocked', { blocked: !acc.blocked }); } }, acc.blocked ? 'Unblock' : 'Block')),
      el('h3', {}, 'Passes'),
      table(['Pass', 'From', 'Until', ''], a.passes.map(p => el('tr', {}, el('td', {}, p.product), el('td', { class: 'small' }, when(p.starts_at)), el('td', { class: 'small' }, when(p.ends_at)), el('td', {}, p.active ? el('span', { class: 'tag' }, 'active') : '')))),
      el('h3', {}, 'Latest runs'),
      table(['When', 'Product', 'Paid with', 'Price', 'Result', ''], a.runs.map(r => el('tr', {},
        el('td', { class: 'small' }, when(r.created_at)), el('td', {}, r.product), el('td', {}, r.payment_method), el('td', { class: 'num' }, money(r.price_cents)),
        el('td', {}, r.status, r.error ? el('div', { class: 'sub' }, r.error) : ''),
        el('td', {}, r.refunded ? el('span', { class: 'small muted' }, 'refunded') : r.payment_method === 'credits' && r.status === 'succeeded' ? el('button', { class: 'btn', type: 'button', onclick: () => act(`refund the ${r.product} run (${money(r.price_cents)})`, 'POST', '/refund', { run_id: r.id }) }, 'Refund') : '')))),
      el('h3', {}, 'Credits ledger'),
      table(['When', 'Change', 'Why', 'Ref'], a.ledger.map(l => el('tr', {}, el('td', { class: 'small' }, when(l.created_at)), el('td', { class: 'num' }, `${l.delta_cents > 0 ? '+' : '−'}${money(Math.abs(l.delta_cents))}`), el('td', {}, l.reason), el('td', { class: 'small' }, l.ref)))));
  }

  async function loadTools() {
    const [t, b] = await Promise.all([api('GET', '/v1/admin/tools'), api('GET', '/v1/admin/banner')]);
    $('banner-now').textContent = b.banner ? `Showing now: "${b.banner.text}"${b.banner.until ? ` until ${when(b.banner.until)}` : ''}.` : 'No banner is showing.';
    if (b.banner) { $('banner-text').value = b.banner.text; $('banner-level').value = b.banner.level; $('banner-link').value = b.banner.link || ''; }
    $('airdrops').querySelector('tbody').replaceChildren(...(t.airdrops.length ? t.airdrops.map(x => el('tr', {},
      el('td', {}, el('strong', {}, x.name), el('div', { class: 'sub' }, x.slug), x.official_url ? el('div', { class: 'sub' }, x.official_url) : ''),
      el('td', {}, x.chain), el('td', { class: 'num' }, x.entries ?? '–'), el('td', { class: 'small' }, when(x.ends_at)),
      el('td', {}, el('button', { class: 'btn', type: 'button', onclick: () => change('tools-msg', `${x.name}: ${x.active ? 'stop offering' : 'offer again'}`, 'PUT', `/v1/admin/tools/airdrops/${x.id}`, { active: !x.active }, loadTools) }, x.active ? 'Stop offering' : 'Offer again')))) : [el('tr', {}, el('td', { colspan: '5', class: 'muted' }, 'None added yet.'))]));
    $('invoices').querySelector('tbody').replaceChildren(...(t.hosted_invoices.length ? t.hosted_invoices.map(i => el('tr', {},
      el('td', { class: 'small' }, when(i.created_at)), el('td', { class: 'small' }, window.RB.short(i.wallet)), el('td', { class: 'num' }, money(i.amount_cents)), el('td', {}, i.product || 'credits'), el('td', {}, i.status))) : [el('tr', {}, el('td', { colspan: '5', class: 'muted' }, 'None yet.'))]));
  }

  /* ── tabs ── */
  const LOADERS = { dash: () => Promise.all([loadHealth(), loadDash()]), services: loadServices, tools: loadTools, accounts: async () => {}, controls: async () => {}, log: async () => {} };
  let tab = (location.hash || '#dash').slice(1);
  function showTab(name) {
    tab = LOADERS[name] ? name : 'dash';
    for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== tab;
    for (const a of document.querySelectorAll('[data-tab]')) a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false');
    LOADERS[tab]().catch(err => toast(err.message));
  }
  for (const a of document.querySelectorAll('[data-tab]')) a.addEventListener('click', e => { e.preventDefault(); history.replaceState(null, '', `#${a.dataset.tab}`); showTab(a.dataset.tab); });
  $('health-reload').addEventListener('click', () => loadHealth().catch(err => toast(err.message)));
  $('dash-days').addEventListener('change', () => loadDash().catch(err => toast(err.message)));
  $('acct-form').addEventListener('submit', e => { e.preventDefault(); say('acct-msg', ''); loadAccount($('acct-q').value.trim()).catch(err => { $('acct').replaceChildren(); say('acct-msg', err.message, 'bad'); }); });
  $('banner-form').addEventListener('submit', e => {
    e.preventDefault();
    const until = $('banner-until').value ? new Date($('banner-until').value).toISOString() : undefined;
    change('banner-msg', `Banner: "${$('banner-text').value}"`, 'PUT', '/v1/admin/banner', { text: $('banner-text').value, level: $('banner-level').value, link: $('banner-link').value || undefined, until }, loadTools);
  });
  $('banner-off').addEventListener('click', () => change('banner-msg', 'Remove the banner', 'PUT', '/v1/admin/banner', { text: '' }, loadTools));

  async function load() {
    try {
      const o = await api('GET', '/v1/admin/overview');
      $('panel').hidden = false;
      say('gate-msg', '');
      stops(o.stops); prices(o.prices); agents(o.agents); log(o.log);
      showTab(tab);
    } catch (err) {
      $('panel').hidden = true;
      say('gate-msg', err.status === 403 ? 'This wallet isn\'t an admin.' : err.status === 401 ? 'Sign in with an admin wallet.' : err.message, 'bad');
    }
  }

  window.RB.onSignedIn(load);
  if (window.RB.signedIn()) load(); else say('gate-msg', 'Sign in with an admin wallet.');
})();
