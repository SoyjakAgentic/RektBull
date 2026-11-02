/* RektBull extension popup: link status, unread alerts, settings. */
(async () => {
  const $ = id => document.getElementById(id);
  const el = (tag, attrs, ...kids) => { const e = document.createElement(tag); Object.assign(e, attrs || {}); e.append(...kids.filter(k => k !== null && k !== undefined)); return e; };
  const send = msg => chrome.runtime.sendMessage(msg);
  const s = await send({ type: 'status' });
  const open = path => chrome.tabs.create({ url: s.apiBase + path });
  $('privacy').addEventListener('click', e => { e.preventDefault(); open('/privacy'); });
  $('warn-medium').checked = s.warnMedium !== false;
  $('warn-medium').addEventListener('change', () => send({ type: 'settings', values: { warnMedium: $('warn-medium').checked } }));
  $('api-base').value = s.apiBase;
  $('api-base').addEventListener('change', () => { try { const u = new URL($('api-base').value); send({ type: 'settings', values: { apiBase: u.origin } }); } catch { /* ignore */ } });
  if (!s.linked) {
    $('status').textContent = 'Not linked yet. Link the extension to your RektBull account so it can check requests before your wallet signs them.';
    $('actions').append(el('button', { className: 'primary', textContent: 'Link my account', onclick: () => open('/extension') }));
    return;
  }
  const me = s.me;
  const pro = me.passes?.find(p => new Date(p.starts_at) <= new Date());
  $('status').textContent = `Checking requests for ${me.account.wallet.slice(0, 6)}…${me.account.wallet.slice(-4)}. ${pro ? `Safety Pro until ${new Date(pro.ends_at).toLocaleDateString()}.` : `${me.points?.left ?? 0} of ${me.points?.allowance ?? 0} free checks left this month.`}`;
  if (s.alerts.length) {
    $('alerts').append(el('div', { textContent: `${s.alerts.length} new alert${s.alerts.length === 1 ? '' : 's'}`, style: 'font-weight:600' }),
      ...s.alerts.slice(0, 4).map(a => el('div', { className: 'alert', textContent: a.title })));
  }
  $('actions').append(
    el('button', { className: 'primary', textContent: 'Open RektBull', onclick: () => open('/safety#monitor-card') }),
    el('button', { textContent: 'Unlink', onclick: async () => { await send({ type: 'unlink' }); window.close(); } }));
})();
