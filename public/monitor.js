/* RektBull Safety page: the risk monitor (Safety Pro). The server watches the
 * wallets and raises the alerts; this page shows them. */
(function () {
  'use strict';
  const { el, say, api, short } = window.RB;
  const $ = id => document.getElementById(id);
  const CHAIN_NAMES = { ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon', bsc: 'BNB Chain' };
  const ago = t => {
    const m = Math.round((Date.now() - new Date(t)) / 60000);
    return m < 60 ? `${Math.max(m, 0)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleDateString();
  };

  function renderOff(text) {
    $('m-on').hidden = true;
    $('m-off').hidden = false;
    $('m-off').replaceChildren(el('p', {}, text), el('a', { href: '#pro-card' }, 'See Safety Pro'));
  }
  renderOff('Sign in, then watch up to 3 wallets with Safety Pro.');

  async function load() {
    if (!window.RB.signedIn()) return renderOff('Sign in, then watch up to 3 wallets with Safety Pro.');
    try {
      const m = await api('GET', '/v1/monitor');
      $('m-unread').hidden = !m.unread_alerts;
      $('m-unread').textContent = `${m.unread_alerts} new`;
      if (!m.active && !m.wallets.length) return renderOff(`The risk monitor is part of Safety Pro: up to ${m.limit} wallets, checked every day.`);
      $('m-off').hidden = true;
      $('m-on').hidden = false;
      if (!$('m-wallet').value && window.RB.state.address) $('m-wallet').value = window.RB.state.address;
      $('m-wallets').replaceChildren(
        m.active ? el('p', { class: 'small muted' }, `Watching ${m.wallets.length} of ${m.limit} wallets, each checked every ${m.every_hours} hours.`)
          : el('p', { class: 'small risk' }, 'Paused: Safety Pro has ended. Renew it to start checking again.'),
        ...m.wallets.map(w => el('div', { class: 'watched' },
          el('div', {}, el('strong', { title: w.wallet }, w.label ? `${w.label} (${short(w.wallet)})` : short(w.wallet)),
            el('div', { class: 'small muted' },
              w.summary ? `${w.summary.open} open approvals, ${w.summary.risky} risky${w.summary.value_at_risk_usd ? `, $${w.summary.value_at_risk_usd.toLocaleString()} could be taken` : ''}` : 'Not checked yet',
              w.last_checked_at ? ` · checked ${ago(w.last_checked_at)}` : '',
              w.summary?.chains_not_read?.length ? ` · couldn't read ${w.summary.chains_not_read.map(c => CHAIN_NAMES[c.chain] || c.chain).join(', ')}` : ''),
            w.last_error ? el('div', { class: 'small risk' }, w.last_error) : null),
          el('div', { class: 'row' },
            el('button', { class: 'link', onclick: () => review(w.wallet) }, 'Review approvals'),
            el('button', { class: 'link', onclick: () => unwatch(w) }, 'Stop watching')))));
      await loadAlerts();
    } catch (err) { if (err.status !== 401) say('m-msg', err.message, 'bad'); }
  }

  async function loadAlerts() {
    const { alerts } = await api('GET', '/v1/monitor/alerts');
    if (!alerts.length) { $('m-alerts').replaceChildren('No alerts yet.'); return; }
    $('m-alerts').className = '';
    $('m-alerts').replaceChildren(...alerts.map(a => el('div', { class: `alert ${a.severity}${a.read_at ? '' : ' unread'}` },
      el('div', {}, el('span', { class: 'sev-badge ' + a.severity }, a.severity), el('span', { class: 'title' }, a.title)),
      el('div', { class: 'when' }, `${short(a.wallet)} · ${ago(a.created_at)}`),
      a.detail?.reasons?.length ? el('ul', { class: 'reasons' }, a.detail.reasons.map(r => el('li', {}, r.text, ' ', el('span', { class: 'source' }, `(${r.source})`)))) : null,
      a.kind !== 'depeg' && !(a.kind === 'watching_started' && !a.detail?.risky?.length) ? el('button', { class: 'link', onclick: () => review(a.wallet) }, 'Review and revoke') : null)));
  }

  // Opens the approval cleanup for that wallet (covered by Safety Pro).
  function review(wallet) {
    $('a-wallet').value = wallet;
    $('approvals-card').scrollIntoView({ behavior: 'smooth' });
  }

  $('m-add').addEventListener('click', async () => {
    say('m-msg', 'Checking it for the first time (up to a minute)…');
    try {
      const r = await api('POST', '/v1/monitor/wallets', { wallet: $('m-wallet').value.trim(), label: $('m-label').value.trim() || undefined });
      say('m-msg', r.wallet.last_error ? `Watching. The first check didn't finish (${r.wallet.last_error}); it will try again within the hour.` : 'Watching. You\'ll see an alert here when something changes.', r.wallet.last_error ? 'bad' : 'ok');
      $('m-label').value = '';
      await load();
    } catch (err) {
      say('m-msg', err.status === 402 ? 'The risk monitor is part of Safety Pro.' : err.message, 'bad');
    }
  });

  async function unwatch(w) {
    if (!confirm(`Stop watching ${w.label || w.wallet}?`)) return;
    try { await api('DELETE', `/v1/monitor/wallets/${w.id}`); await load(); } catch (err) { say('m-msg', err.message, 'bad'); }
  }

  $('m-read').addEventListener('click', async () => {
    try { await api('POST', '/v1/monitor/alerts/read', {}); await load(); } catch (err) { say('m-msg', err.message, 'bad'); }
  });

  window.RB.onSignedIn(load);
  document.addEventListener('rb:account-changed', load);
})();
