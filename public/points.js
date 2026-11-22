/* RektBull Points: the balance, where it came from, and subscriptions to spend it on. */
(function () {
  'use strict';
  const RB = window.RB;
  const { el, say, api } = RB;
  const $ = id => document.getElementById(id);
  const num = (v, d = 2) => Number(v).toLocaleString('en-US', { maximumFractionDigits: d });
  const usd = v => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  function subs(list, balance = null) {
    $('subs').replaceChildren(...list.map(s => el('tr', {},
      el('td', {}, el('strong', {}, s.title), el('div', { class: 'sub' }, `${s.days} days`)),
      el('td', { class: 'num' }, usd(s.price_usd)),
      el('td', { class: 'num' }, num(s.points, 0)),
      el('td', {}, RB.signedIn() ? el('button', { class: 'btn', disabled: balance !== null && balance < s.points, onclick: e => buy(s, e.target) }, 'Buy with points') : ''))));
  }

  async function buy(s, btn) {
    if (!window.confirm(`Spend ${num(s.points, 0)} RektBull Points on ${s.title}?`)) return;
    btn.disabled = true;
    try {
      const out = await api('POST', `/v1/points/passes/${s.id}`, {});
      say('spend-msg', `${s.title} is active until ${new Date(out.pass.ends_at).toLocaleDateString()}. ${num(out.balance)} points left.`, 'ok');
      await load();
    } catch (err) { say('spend-msg', err.message, 'bad'); btn.disabled = false; }
  }

  async function load() {
    const info = await api('GET', '/v1/points/info');
    $('token-note').textContent = info.token_note;
    $('how').textContent = `${info.rebate_pct}% of the trading fees you pay RektBull comes back to you as RektBull Points, at $${info.point_usd} a point: swaps you sign or automate, Hyperliquid perps, Polymarket trading fees and the Polymarket profit share. Spend them on subscriptions. At most ${num(info.cap, 0)} points will ever be issued.`;
    if (!RB.signedIn()) return subs(info.subscriptions);
    const p = await api('GET', '/v1/points');
    $('balance').replaceChildren(
      el('div', { class: 'tile' }, el('span', { class: 'small muted' }, 'Balance'), el('h3', {}, `${num(p.balance)} points`)),
      el('div', { class: 'tile' }, el('span', { class: 'small muted' }, 'Worth in subscriptions'), el('h3', {}, usd(p.value_usd))));
    $('supply').textContent = `${num(p.supply.issued, 0)} of ${num(p.supply.cap, 0)} RektBull Points issued so far; ${num(p.supply.remaining, 0)} remain. When they run out, rebates stop.`;
    subs(p.subscriptions, p.balance);
    $('history-card').hidden = false;
    $('history').replaceChildren(...(p.history.length ? p.history.map(h => el('tr', {},
      el('td', {}, new Date(h.at).toLocaleString()),
      el('td', {}, h.source, h.note ? el('div', { class: 'sub' }, h.note) : ''),
      el('td', { class: 'num' }, h.fee_usd === null ? '' : usd(h.fee_usd)),
      el('td', { class: `num ${h.points > 0 ? 'up' : 'down'}` }, `${h.points > 0 ? '+' : ''}${num(h.points, 4)}`))) : [el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'No points yet: trade through RektBull to earn them.'))]));
  }

  RB.onSignedIn(() => load().catch(err => say('spend-msg', err.message, 'bad')));
  load().catch(err => say('spend-msg', `Points couldn't be read: ${err.message}`, 'bad'));
})();
