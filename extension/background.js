/*
 * RektBull extension, background. Holds the link token (from rektbull.com's
 * /extension page) and the settings, calls the RektBull API for checks, and
 * keeps the toolbar badge showing unread risk monitor alerts.
 */
const DEFAULTS = { apiBase: 'https://rektbull.com', token: null, warnMedium: true };
const CHECK_TIMEOUT_MS = 8000;

const settings = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(['apiBase', 'token', 'warnMedium', 'wallet'])) });

async function api(path, { method = 'GET', body, timeout = CHECK_TIMEOUT_MS } = {}) {
  const s = await settings();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(s.apiBase + path, {
      method, signal: ctrl.signal,
      headers: { 'content-type': 'application/json', ...(s.token ? { authorization: `Bearer ${s.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { clearTimeout(timer); }
}

async function check(request) {
  const s = await settings();
  if (!s.token) return { status: 'unchecked', reason: 'link the extension to your RektBull account first.', link: `${s.apiBase}/extension` };
  try {
    const r = await api('/v1/presign/check', { method: 'POST', body: request });
    if (r.status === 200) return { status: 'checked', result: r.body, warnMedium: s.warnMedium };
    if (r.status === 401) { await chrome.storage.local.remove(['token', 'wallet']); return { status: 'unchecked', reason: 'the link to your account ended; link it again.', link: `${s.apiBase}/extension` }; }
    if (r.status === 402) return { status: 'unchecked', reason: 'this month\'s free checks are used up. Safety Pro checks every request.', link: `${s.apiBase}/safety#pro-card` };
    return { status: 'unchecked', reason: r.body?.message || `RektBull answered ${r.status}.` };
  } catch (err) {
    return { status: 'unchecked', reason: err.name === 'AbortError' ? 'RektBull took too long to answer.' : 'RektBull couldn\'t be reached.' };
  }
}

async function link(token, origin) {
  const s = await settings();
  if (new URL(s.apiBase).origin !== origin) return { ok: false, message: 'Links are only accepted from RektBull\'s own site.' };
  await chrome.storage.local.set({ token });
  const me = await api('/v1/me').catch(() => null);
  if (me?.status !== 200) { await chrome.storage.local.remove('token'); return { ok: false, message: 'RektBull didn\'t accept the link.' }; }
  await chrome.storage.local.set({ wallet: me.body.account.wallet });
  await refreshBadge();
  return { ok: true };
}

async function refreshBadge() {
  const s = await settings();
  if (!s.token) { await chrome.action.setBadgeText({ text: '' }); return; }
  const m = await api('/v1/monitor').catch(() => null);
  const n = m?.status === 200 ? m.body.unread_alerts : 0;
  await chrome.action.setBadgeBackgroundColor({ color: '#cf222e' });
  await chrome.action.setBadgeText({ text: n ? String(Math.min(n, 99)) : '' });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Only this extension's own content scripts and popup talk to the background.
  if (sender.id !== chrome.runtime.id) return false;
  (async () => {
    if (msg.type === 'check') return check(msg.request);
    if (msg.type === 'link') return link(msg.token, msg.origin);
    if (msg.type === 'api-base') return (await settings()).apiBase;
    if (msg.type === 'status') {
      const s = await settings();
      if (!s.token) return { linked: false, apiBase: s.apiBase, warnMedium: s.warnMedium };
      const [me, alerts] = await Promise.all([api('/v1/me').catch(() => null), api('/v1/monitor/alerts?unread=1').catch(() => null)]);
      return { linked: me?.status === 200, apiBase: s.apiBase, warnMedium: s.warnMedium, me: me?.body || null, alerts: alerts?.body?.alerts || [] };
    }
    if (msg.type === 'settings') { await chrome.storage.local.set(msg.values); return settings(); }
    if (msg.type === 'unlink') { await chrome.storage.local.remove(['token', 'wallet']); await refreshBadge(); return { ok: true }; }
    return null;
  })().then(reply, err => reply({ status: 'unchecked', reason: err.message }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('alerts', { periodInMinutes: 30 }));
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'alerts') refreshBadge().catch(() => {}); });
