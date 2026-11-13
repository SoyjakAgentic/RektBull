/* Launches page: the wallets you follow (the Wallet Tracker) and their latest
 * trades. The worker reads the chains and sends the alerts; this card lists
 * what it saw, refreshed every 10 seconds while it's on screen. */
(function () {
  'use strict';
  const { el, say, api, short } = window.RB;
  const $ = id => document.getElementById(id);
  const ago = t => {
    const s = Math.round((Date.now() - new Date(t)) / 1000);
    return s < 60 ? `${Math.max(s, 0)} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString();
  };
  const num = n => (n === null || n === undefined ? '?' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? Math.round(n).toLocaleString('en-US') : String(Number(Number(n).toPrecision(4))));
  const money = n => (n === null || n === undefined ? '' : ` (about $${n >= 1000 ? Math.round(n).toLocaleString('en-US') : Number(n).toFixed(2)})`);
  const known = new Set();
  let first = true;
  let walletsSeen = null; // a wallet just followed brings its earlier trades: those aren't marked new

  function off(text) {
    $('f-on').hidden = true;
    $('f-off').hidden = false;
    $('f-status').textContent = '';
    $('f-off').replaceChildren(el('p', {}, text));
  }

  function tradeItem(t) {
    const key = `${t.tx}:${t.wallet}:${t.token}:${t.side}`;
    const fresh = !first && !known.has(key);
    known.add(key);
    const who = t.label || short(t.wallet);
    const paid = !t.other ? '' : t.other.amount === null || t.other.amount === undefined ? ` for ${t.other.symbol || 'ETH'}` : ` for ${num(t.other.amount)} ${t.other.symbol || short(t.other.token)}`;
    return el('li', { class: fresh ? 'live-item fresh' : 'live-item' },
      el('div', { class: 'live-top' },
        el('span', {}, el('strong', {}, who), ` ${t.side === 'buy' ? 'bought' : 'sold'} ${num(t.amount)} `, el('strong', {}, t.symbol || short(t.token)), `${paid}${money(t.usd)}`),
        el('span', { class: 'small muted' }, `${t.chain_name} · ${ago(t.at)}`)),
      el('div', { class: 'live-act' },
        el('a', { class: 'btn', href: t.page }, 'Token page'),
        t.side === 'buy' ? el('a', { class: 'btn primary', href: t.buy }, 'Check and buy') : null,
        t.tx_url ? el('a', { class: 'small', href: t.tx_url, rel: 'noopener', target: '_blank' }, 'Transaction') : null));
  }

  async function load() {
    if (!window.RB.signedIn()) return off('Sign in to follow wallets.');
    try {
      const r = await api('GET', '/v1/wallet-tracker');
      $('f-off').hidden = true;
      $('f-on').hidden = false;
      const key = r.wallets.map(w => w.address).sort().join(',');
      if (key !== walletsSeen) { first = true; walletsSeen = key; }
      $('f-status').textContent = `${r.wallets.length} of ${r.limit} wallets${r.alerts_on ? '' : ' · alerts are off on the AI agents page'}`;
      $('f-wallets').replaceChildren(...r.wallets.map(w => el('div', { class: 'watched' },
        el('div', {}, el('strong', { title: w.address }, w.label ? `${w.label} (${short(w.address)})` : short(w.address)),
          el('div', { class: 'small muted' }, `Following since ${new Date(w.created_at).toLocaleDateString()}`)),
        el('button', { class: 'link', type: 'button', onclick: () => unfollow(w) }, 'Stop following'))));
      $('f-trades').replaceChildren(...(r.trades.length ? r.trades.map(tradeItem)
        : [el('li', { class: 'small muted' }, r.wallets.length ? 'No trades since you followed them. New ones show here, and in your alerts, within seconds.' : 'Follow a wallet to see its trades here.')]));
      first = false;
      $('f-src').textContent = `Source: ${r.source}. ${r.note}`;
    } catch (err) { if (err.status !== 401) say('f-msg', err.message, 'bad'); }
  }

  async function unfollow(w) {
    if (!confirm(`Stop following ${w.label || w.address}?`)) return;
    try { await api('DELETE', `/v1/wallet-tracker/wallets/${w.id}`); say('f-msg', 'Stopped following it.', 'ok'); await load(); } catch (err) { say('f-msg', err.message, 'bad'); }
  }

  $('f-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('POST', '/v1/wallet-tracker/wallets', { address: $('f-address').value.trim(), label: $('f-label').value.trim() || undefined });
      $('f-address').value = '';
      $('f-label').value = '';
      say('f-msg', 'Following. Its next buy or sell shows here and in your alerts within seconds.', 'ok');
      await load();
    } catch (err) {
      say('f-msg', err.message, 'bad');
      if (err.status === 402) $('f-msg').append(' ', el('a', { href: '/safety#pro-card' }, 'See Safety Pro'));
    }
  });

  // Refreshed every 10 seconds while the card is on screen and the tab is visible.
  let inView = false;
  new IntersectionObserver(es => { inView = es.some(x => x.isIntersecting); }).observe($('follow-card'));
  setInterval(() => { if (inView && !document.hidden && window.RB.signedIn()) load(); }, 10000);

  window.RB.onSignedIn(load);
  document.addEventListener('rb:account-changed', load);
})();
