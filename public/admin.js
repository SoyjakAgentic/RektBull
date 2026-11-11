/* The admin panel: prices, AI agents' states and the emergency stops. Every change asks for a reason and is logged on the server. */
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
  async function change(msgId, what, method, path, body = {}) {
    const reason = window.prompt(`${what}\n\nWhy? (kept in the change log)`);
    if (reason === null) return;
    try {
      await api(method, path, { ...body, reason });
      toast('Saved');
      await load();
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

  async function load() {
    try {
      const o = await api('GET', '/v1/admin/overview');
      $('panel').hidden = false;
      say('gate-msg', '');
      stops(o.stops); prices(o.prices); agents(o.agents); log(o.log);
    } catch (err) {
      $('panel').hidden = true;
      say('gate-msg', err.status === 403 ? 'This wallet isn\'t an admin.' : err.status === 401 ? 'Sign in with an admin wallet.' : err.message, 'bad');
    }
  }

  window.RB.onSignedIn(load);
  if (window.RB.signedIn()) load(); else say('gate-msg', 'Sign in with an admin wallet.');
})();
