/* The Predictions page's automatic AI trading: RektBull's Session Key on the user's Polymarket wallet.
 * Every limit and duration is shown before the user signs; turning it off is always one button. */
(function () {
  'use strict';
  const RB = window.RB;
  const { el, say, api } = RB;
  const $ = id => document.getElementById(id);
  const pm = () => RB.state.pm;
  const LABELS = {
    duration: 'How long it lasts', can_do: 'What the key can do', limits: 'Who keeps your limits', what_it_does: 'What it buys',
    fee: 'What it costs', revoking: 'Turning it off', servers: 'Where orders come from', most_you_can_lose: 'The most you can lose', not_advice: 'The AI can be wrong',
  };
  const when = t => new Date(t).toLocaleString();

  async function load() {
    if (!RB.signedIn()) { $('auto-about').textContent = 'Sign in with an EVM wallet to see automatic AI trading (part of Safety Pro).'; return; }
    try {
      const o = await api('GET', '/v1/polymarket/auto');
      const live = o.session && ['pending', 'active'].includes(o.session.status) ? o.session : null;
      $('auto-about').textContent = o.why_off
        ? `Not available yet: ${o.why_off}`
        : `RektBull's key buys for you from the AI's researched forecasts, within limits you set.${o.automation_on ? '' : ' Automated entries aren\'t switched on yet: RektBull is building the track record first. You can still set it up.'}`;
      $('auto-disclosures').replaceChildren(...Object.entries(o.disclosures).flatMap(([k, v]) => [el('dt', {}, LABELS[k] || k), el('dd', {}, v)]));
      $('auto-max-order').min = String(o.min_order_usd);
      $('auto-days').max = String(o.max_stop_days);
      $('auto-setup').hidden = live?.status === 'active' || !!o.why_off; // a pending one can be signed again
      $('auto-stop').hidden = !live;
      $('auto-session').replaceChildren(...(live ? [
        el('p', {}, el('strong', {}, live.status === 'active' ? 'On. ' : 'Waiting for your signature to be confirmed. '),
          `RektBull stops at ${when(live.stop_at)}; Polymarket ends the key at ${when(live.valid_until)} unless you end it first. `,
          `At most $${live.max_order_usd} an order and $${live.max_day_usd} in 24 hours, kept by RektBull's servers, not onchain.`),
      ] : o.session ? [el('p', { class: 'muted' }, `Your last key: ${o.session.status}${o.session.ended_at ? ` at ${when(o.session.ended_at)}` : ''}.`)] : []));
      $('auto-orders-wrap').hidden = !o.orders.length;
      $('auto-orders').replaceChildren(...o.orders.map(r => el('tr', {},
        el('td', {}, when(r.created_at)), el('td', {}, r.market), el('td', {}, `${r.outcome} at up to ${Math.round(r.price_limit * 1000) / 10}¢`),
        el('td', { class: 'num' }, `$${r.amount_usd}`), el('td', { class: 'num' }, r.filled_usd === null ? '—' : `$${r.filled_usd.toFixed(2)}`),
        el('td', { class: 'num' }, r.fee_usd === null ? '—' : `$${r.fee_usd.toFixed(2)}`), el('td', {}, r.status, r.error ? el('div', { class: 'sub' }, r.error) : ''))));
    } catch (err) { say('auto-msg', err.message, 'bad'); }
  }

  async function start() {
    try {
      if (!$('auto-accept').checked) throw new Error('Read the disclosures and tick the box first.');
      if (!RB.state.provider) throw new Error('Connect your wallet first (the button at the top right), so it can sign.');
      const t = await api('POST', '/v1/polymarket/auto/start', {
        accept: true, max_order_usd: Number($('auto-max-order').value), max_day_usd: Number($('auto-max-day').value), stop_days: Number($('auto-days').value),
      });
      await pm().sendPrepared(t, 'auto-msg');
      await load();
    } catch (err) { say('auto-msg', err.message, 'bad'); await load(); }
  }

  async function stop() {
    try {
      const out = await api('POST', '/v1/polymarket/auto/stop', {});
      say('auto-msg', 'Stopped: RektBull places nothing more. Now sign to end the key on Polymarket too.', 'ok');
      if (out.revoke && !out.revoke.error) await pm().sendPrepared(out.revoke, 'auto-msg');
      else if (out.revoke?.error) say('auto-msg', `Stopped on RektBull. Ending the key on Polymarket couldn't be prepared (${out.revoke.error}); you can also end it on polymarket.com.`, 'bad');
    } catch (err) { say('auto-msg', err.message, 'bad'); }
    await load();
  }

  $('auto-start').addEventListener('click', start);
  $('auto-stop').addEventListener('click', stop);
  RB.onSignedIn(load);
  load();
})();
