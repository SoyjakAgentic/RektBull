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
      await Promise.all([loadAlerts(), loadChannels()]);
    } catch (err) { if (err.status !== 401) say('m-msg', err.message, 'bad'); }
  }

  /* ── where alerts go ── */
  const KINDS = { telegram: 'Telegram', email: 'Email', push: 'Browser notifications' };
  const LEVELS = [['critical', 'Critical only'], ['high', 'High and critical'], ['medium', 'Medium and above'], ['info', 'Everything']];
  let pushKey = null;

  async function loadChannels() {
    const c = await api('GET', '/v1/alerts/channels');
    pushKey = c.push_public_key;
    $('ch-telegram').disabled = !c.available.telegram;
    $('ch-email-add').disabled = !c.available.email;
    $('ch-push').disabled = !c.available.push || !('serviceWorker' in navigator) || !('PushManager' in window);
    const off = Object.entries(c.available).filter(([, on]) => !on).map(([k]) => KINDS[k]);
    if (!c.channels.length) $('ch-list').replaceChildren(el('p', { class: 'small risk' }, 'No channel yet: alerts only show on this page.'), off.length ? el('p', { class: 'small muted' }, `Not available on this server yet: ${off.join(', ')}.`) : null);
    else {
      $('ch-list').replaceChildren(...c.channels.map(ch => {
        const sel = el('select', { 'aria-label': `Which alerts go to ${KINDS[ch.kind]}` }, LEVELS.map(([v, t]) => el('option', { value: v }, t)));
        sel.value = LEVELS.some(([v]) => v === ch.min_severity) ? ch.min_severity : 'medium';
        sel.addEventListener('change', () => api('PATCH', `/v1/alerts/channels/${ch.id}`, { min_severity: sel.value }).then(() => say('ch-msg', 'Saved.', 'ok')).catch(err => say('ch-msg', err.message, 'bad')));
        return el('div', { class: 'watched' },
          el('div', {}, el('strong', {}, KINDS[ch.kind]), ch.label ? ` · ${ch.label}` : '',
            el('div', { class: ch.active ? 'small muted' : 'small risk' }, ch.active ? 'On' : ch.verified ? `Off: ${ch.disabled_reason || 'switched off'}` : 'Waiting for confirmation')),
          el('div', { class: 'row' }, sel, el('button', { class: 'link', onclick: () => removeChannel(ch) }, 'Remove')));
      }));
    }
  }

  async function removeChannel(ch) {
    try { await api('DELETE', `/v1/alerts/channels/${ch.id}`); await loadChannels(); } catch (err) { say('ch-msg', err.message, 'bad'); }
  }

  $('ch-telegram').addEventListener('click', async () => {
    try {
      const r = await api('POST', '/v1/alerts/channels/telegram');
      window.open(r.link, '_blank', 'noopener');
      $('ch-msg').replaceChildren('Telegram should open: press ', el('strong', {}, 'Start'), '. If it didn\'t, ', el('a', { href: r.link, target: '_blank', rel: 'noopener' }, 'open the bot'), ` (the link works once, for ${r.expires_in_minutes} minutes).`);
      $('ch-msg').className = 'msg';
      // Watch for the link to complete.
      let tries = 0;
      const timer = setInterval(async () => {
        tries++;
        const c = await api('GET', '/v1/alerts/channels').catch(() => null);
        if (c?.channels.some(ch => ch.kind === 'telegram' && ch.active)) { clearInterval(timer); say('ch-msg', 'Telegram is linked.', 'ok'); loadChannels(); }
        if (tries > 36) clearInterval(timer);
      }, 5000);
    } catch (err) { say('ch-msg', err.message, 'bad'); }
  });

  $('ch-email-add').addEventListener('click', async () => {
    try {
      const r = await api('POST', '/v1/alerts/channels/email', { email: $('ch-email').value });
      say('ch-msg', `Check ${r.to} for the confirmation link (it works for 24 hours).`, 'ok');
    } catch (err) { say('ch-msg', err.message, 'bad'); }
  });

  const b64 = s => { const p = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, ch => ch.charCodeAt(0)); };
  $('ch-push').addEventListener('click', async () => {
    try {
      if ((await Notification.requestPermission()) !== 'granted') return say('ch-msg', 'Notifications are blocked for this site in your browser settings.', 'bad');
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(pushKey) });
      await api('POST', '/v1/alerts/channels/push', { subscription: sub.toJSON(), label: 'This browser' });
      say('ch-msg', 'Browser notifications are on.', 'ok');
      await loadChannels();
    } catch (err) { say('ch-msg', err.message, 'bad'); }
  });

  $('ch-test').addEventListener('click', async () => {
    try {
      const r = await api('POST', '/v1/alerts/test');
      say('ch-msg', r.sent.length ? `Test sent to: ${r.sent.map(k => KINDS[k]).join(', ')}.${r.failed.length ? ` Failed: ${r.failed.map(f => `${KINDS[f.kind]} (${f.error})`).join(', ')}.` : ''}` : (r.message || `Failed: ${r.failed.map(f => `${KINDS[f.kind]} (${f.error})`).join(', ')}`), r.failed.length ? 'bad' : 'ok');
      await loadChannels();
    } catch (err) { say('ch-msg', err.message, 'bad'); }
  });

  // Coming back from an email link.
  const outcome = new URLSearchParams(location.search).get('email');
  if (outcome) {
    const text = { confirmed: ['Email confirmed: alerts will be sent there.', 'ok'], expired: ['That confirmation link has expired or was already used.', 'bad'], unsubscribed: ['Unsubscribed: no more alert emails.', 'ok'], 'bad-link': ['That unsubscribe link isn\'t valid.', 'bad'] }[outcome];
    if (text) setTimeout(() => say('ch-msg', ...text), 0);
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
