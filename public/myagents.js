/* AI agents: your agents, each with its switch, schedule, alerts and last run.
 * The server runs them (src/services/myAgents.js); this page sets them. */
(function () {
  'use strict';
  const { el, say, api } = window.RB;
  const $ = id => document.getElementById(id);
  const CHAINS = { ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon', bsc: 'BNB Chain', solana: 'Solana' };
  const KINDS = { telegram: 'Telegram', email: 'email', push: 'browser notifications' };
  const ago = t => {
    const m = Math.round((Date.now() - new Date(t)) / 60000);
    return m < 60 ? `${Math.max(m, 0)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
  };
  const short = a => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
  let chains = Object.keys(CHAINS);

  function card(a, signedIn, data) {
    const live = signedIn && data;
    // Without Safety Pro (or a watched wallet) the agent can't run: its switch shows off, with the reason below.
    const blocked = live && ['needs_pro', 'needs_wallets'].includes(a.status.state);
    const toggle = el('input', { type: 'checkbox', role: 'switch', 'aria-label': `${a.name} on`, ...(a.enabled && live && !blocked ? { checked: '' } : {}), ...(!live || blocked ? { disabled: '' } : {}) });
    toggle.addEventListener('change', () => save(a, { enabled: toggle.checked }, toggle));
    const schedule = a.schedules.length > 1 && live
      ? el('select', { 'aria-label': `${a.name} schedule` }, ...a.schedules.map(s => el('option', { value: String(s.every_hours), ...(s.every_hours === a.every_hours ? { selected: '' } : {}) }, s.label)))
      : el('span', {}, live ? a.schedule : a.default_schedule);
    if (schedule.tagName === 'SELECT') schedule.addEventListener('change', () => save(a, { every_hours: Number(schedule.value) }, schedule));
    const state = !signedIn ? null
      : a.status.state === 'needs_pro' ? el('a', { href: '/safety#pro-card', class: 'small' }, 'Part of Safety Pro')
        : a.status.state === 'needs_wallets' ? el('a', { href: '/safety#monitor-card', class: 'small' }, a.status.text)
          : a.status.state === 'needs_setup' ? el('span', { class: 'small muted' }, a.status.text)
            : el('span', { class: `small ${a.enabled ? 'up' : 'muted'}` }, a.status.text);
    const last = live && (a.last_run_at || a.last_error) ? el('p', { class: 'small muted last' },
      a.last_error ? el('span', { class: 'risk' }, a.last_error) : `Last run ${ago(a.last_run_at)}: ${a.last_result?.text || ''}${a.last_result?.alerts ? ` · ${a.last_result.alerts} alert${a.last_result.alerts === 1 ? '' : 's'} sent` : ''}`,
      a.last_result?.not_checked?.length ? el('span', { class: 'block' }, `Not checked: ${a.last_result.not_checked.join('; ')}`) : null) : null;
    return el('article', { class: `agent${a.enabled && live && a.status.state === 'on' ? ' on' : ''}`, id: `agent-${a.id}` },
      el('div', { class: 'agent-head' },
        el('h3', {}, a.name),
        el('label', { class: 'switch', title: a.id === 'trading_agent' ? 'Alerts on or off; trading itself is switched on the Trade desk' : 'On or off' }, toggle, el('span', { 'aria-hidden': 'true' }))),
      el('p', {}, a.does),
      el('dl', { class: 'agent-facts' },
        el('dt', {}, 'Runs'), el('dd', {}, schedule),
        el('dt', {}, 'Alerts'), el('dd', {}, a.alerts),
        el('dt', {}, 'Price'), el('dd', {}, a.price)),
      a.id === 'token_watch' && live && a.status.state !== 'needs_pro' ? tokens(a) : null,
      el('div', { class: 'agent-foot' }, state, el('span', { class: 'small' }, el('a', { href: `/agents/${a.id.replace(/_/g, '-')}` }, 'How it works'), ' · ', el('a', { href: a.desk.href }, `Open ${a.desk.name}`))),
      last);
  }

  /* Token Watch's list: add and remove tokens. */
  function tokens(a) {
    const chain = el('select', { 'aria-label': 'Chain' }, ...chains.map(c => el('option', { value: c }, CHAINS[c] || c)));
    const addr = el('input', { placeholder: '0x… or a Solana mint', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Token address' });
    const add = el('button', { type: 'submit', ...(a.tokens.length >= a.max_tokens ? { disabled: '' } : {}) }, 'Watch');
    const form = el('form', { class: 'row tokens-add' }, chain, addr, add);
    form.addEventListener('submit', e => {
      e.preventDefault();
      save(a, { tokens: [...a.tokens, { chain: chain.value, token: addr.value.trim() }], enabled: true }, add);
    });
    return el('div', { class: 'tokens' },
      a.tokens.length ? el('ul', { class: 'plain' }, ...a.tokens.map((t, i) => el('li', {},
        el('a', { href: `/safety?chain=${t.chain}&token=${encodeURIComponent(t.token)}#check-card`, class: 'mono' }, `${t.label || short(t.token)}`),
        ` on ${CHAINS[t.chain] || t.chain} `,
        el('button', { class: 'link', type: 'button', onclick: e => save(a, { tokens: a.tokens.filter((_, j) => j !== i) }, e.target) }, 'Remove')))) : null,
      el('p', { class: 'small muted' }, `${a.tokens.length} of ${a.max_tokens} tokens.`),
      form);
  }

  async function save(a, body, control) {
    if (control) control.disabled = true;
    say('ma-msg', 'Saving…');
    try {
      await api('PATCH', `/v1/my-agents/${a.id}`, body);
      say('ma-msg', body.enabled === false ? `${a.name} is off.` : body.enabled ? `${a.name} is on. Its first run is within a few minutes.` : 'Saved.', 'ok');
    } catch (err) { say('ma-msg', err.message, 'bad'); }
    await load(true);
  }

  async function load(keepMsg) {
    const signedIn = window.RB.signedIn();
    try {
      chains = (await api('GET', '/v1/tokens/chains')).chains || chains;
    } catch { /* the defaults */ }
    try {
      if (!signedIn) {
        const c = await api('GET', '/v1/my-agents/catalog');
        $('ma-alerts').replaceChildren(el('button', { class: 'link', onclick: () => document.getElementById('hdr-connect')?.click() }, 'Sign in'), ' to switch agents on.');
        $('ma-list').replaceChildren(...c.agents.map(a => card(a, false)));
        if (!keepMsg) say('ma-msg', '');
        return;
      }
      const d = await api('GET', '/v1/my-agents');
      $('ma-alerts').replaceChildren(
        d.alert_channels.length ? `Alerts go to ${d.alert_channels.map(k => KINDS[k] || k).join(', ')}. ` : el('span', { class: 'risk' }, 'No alert channel yet: alerts only show on the Safety page. '),
        el('a', { href: '/safety#monitor-card' }, d.alert_channels.length ? 'Change' : 'Add Telegram, email or browser'),
        d.unread_alerts ? ` · ${d.unread_alerts} unread` : '');
      $('ma-list').replaceChildren(...d.agents.map(a => card(a, true, d)));
      if (!keepMsg) say('ma-msg', '');
    } catch (err) { if (err.status !== 401) say('ma-msg', err.message, 'bad'); }
  }

  load();
  window.RB.onSignedIn(() => load());
  document.addEventListener('rb:account-changed', () => load());
})();
