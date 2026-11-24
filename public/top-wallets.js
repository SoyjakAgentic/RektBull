/* Launches page: wallets ranked by realised profit on pump.fun (services/walletRankings.js). "Follow" hands
 * the wallet to the Wallet Tracker card below, which follows it for the signed-in account. */
(function () {
  'use strict';
  const { el, api, short } = window.RB;
  const $ = id => document.getElementById(id);
  let windowName = '7d';
  const solTxt = n => `${n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 2 : 0 })} SOL`;

  function follow(w) {
    $('f-address').value = w.wallet;
    $('f-label').value = `Top #${w.rank} (${windowName})`;
    $('follow-card').scrollIntoView({ behavior: 'smooth' });
    if (window.RB.signedIn() && !$('f-on').hidden) $('f-form').requestSubmit();
  }

  function row(w) {
    return el('tr', {},
      el('td', {}, String(w.rank)),
      el('td', {}, el('a', { href: w.solscan, target: '_blank', rel: 'noopener' }, short(w.wallet))),
      el('td', { class: 'num' }, solTxt(w.realised_sol), w.realised_usd !== null ? el('div', { class: 'small muted' }, `about $${w.realised_usd.toLocaleString('en-US')}`) : null),
      el('td', { class: 'num' }, w.return_pct === null ? '?' : `${w.return_pct > 0 ? '+' : ''}${w.return_pct}%`),
      el('td', { class: 'num' }, `${w.coins} (${w.win_rate_pct}%)`),
      el('td', { class: 'num' }, solTxt(w.best_coin_sol), w.best_share_pct !== null ? el('div', { class: 'small muted' }, `${w.best_share_pct}% of the total`) : null),
      el('td', { class: 'small' }, w.last_active ? String(w.last_active).slice(0, 10) : ''),
      el('td', {}, el('button', { class: 'btn', onclick: () => follow(w) }, 'Follow')));
  }

  async function load() {
    for (const b of document.querySelectorAll('#top-card [data-window]')) b.setAttribute('aria-pressed', String(b.dataset.window === windowName));
    let r;
    try { r = await api('GET', `/v1/wallet-tracker/top?window=${windowName}`); } catch (err) {
      $('top-list').replaceChildren(el('tr', {}, el('td', { colspan: 8, class: 'muted' }, err.message)));
      return;
    }
    $('top-rules').replaceChildren(...r.rules.map(t => el('li', {}, t)));
    $('top-src').textContent = `Source: ${r.source}.${r.counted_since ? ` Counted since ${String(r.counted_since).slice(0, 10)}.` : ''}`;
    $('top-list').replaceChildren(...(r.wallets.length ? r.wallets.map(row)
      : [el('tr', {}, el('td', { colspan: 8, class: 'muted' }, r.stream
        ? `No wallet meets the rules for the last ${r.days} days yet. The ranking fills in as RektBull reads pump.fun's trades.`
        : 'The ranking starts once RektBull\'s Solana stream is switched on: it is counted from every trade on pump.fun as it happens.'))]));
  }

  document.addEventListener('DOMContentLoaded', () => {
    for (const b of document.querySelectorAll('#top-card [data-window]')) b.addEventListener('click', () => { windowName = b.dataset.window; load(); });
    load();
  });
})();
