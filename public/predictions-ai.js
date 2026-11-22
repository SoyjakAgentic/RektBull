/* The Predictions page's AI proposals and the AI's public track record. A proposal is a suggestion from a shared AI
 * forecast, paid from Safety Pro AI credits; approving it fills in the order form, and the user checks and signs it. */
(function () {
  'use strict';
  const RB = window.RB;
  const { el, say, api } = RB;
  const $ = id => document.getElementById(id);
  const pct = v => (v === null || v === undefined ? '—' : `${Math.round(v * 1000) / 10}%`);
  const pm = () => RB.state.pm;

  async function track() {
    try {
      const t = await api('GET', '/v1/forecasts/track-record?venue=polymarket');
      $('track-how').textContent = `${t.how} ${t.open} forecasts are waiting for their markets to resolve.`;
      const r = t.stages.find(s => s.stage === 'research');
      $('track').replaceChildren(...(r ? [
        el('div', { class: 'tile' }, el('span', { class: 'small muted' }, 'Researched forecasts scored'), el('h3', {}, String(r.resolved))),
        el('div', { class: 'tile' }, el('span', { class: 'small muted' }, 'AI Brier score (lower is better)'), el('h3', {}, String(r.brier_ai))),
        el('div', { class: 'tile' }, el('span', { class: 'small muted' }, 'Market\'s Brier score'), el('h3', {}, String(r.brier_market))),
        el('div', { class: 'tile' }, el('span', { class: 'small muted' }, 'AI beat the market'), el('h3', {}, `${r.ai_beat_market} of ${r.resolved}`)),
      ] : [el('p', { class: 'muted' }, 'No researched forecast has resolved yet: there is no track record to show.')]));
      $('track-recent').replaceChildren(...t.recent.map(f => el('tr', {},
        el('td', {}, f.question, el('div', { class: 'sub' }, `${f.outcome}, ${f.confidence} confidence`)),
        el('td', { class: 'num' }, pct(f.ai_prob)), el('td', { class: 'num' }, pct(f.market_prob)), el('td', {}, f.happened ? 'Yes' : 'No'))));
    } catch (err) { $('track-how').textContent = `The track record couldn't be read: ${err.message}`; }
  }

  async function load() {
    if (!RB.signedIn()) { $('ai-about').textContent = 'Sign in to see AI proposals (part of Safety Pro).'; return; }
    try {
      const out = await api('GET', '/v1/ai/proposals');
      $('ai-about').textContent = `${out.about} A proposal is offered only when the AI's probability beats the price by ${out.edge_pct} points; acting on one costs $${out.price_usd} of AI credits. ${out.ai_fee ? out.ai_fee.how : ''}${out.offered.polymarket ? '' : ' Proposals aren\'t switched on yet: RektBull is building the track record first.'}`;
      $('ai-settings').hidden = false;
      $('ai-on').checked = !!out.settings.polymarket;
      $('ai-max').value = out.settings.max_per_day;
      const c = out.ai_credits;
      $('ai-credits').textContent = c ? `AI credits: ${c.left_pct}% of this month's allowance left, $${Number(c.topup_usd).toFixed(2)} top-up.` : 'AI proposals need Safety Pro.';
      $('ai-list').replaceChildren(...(out.proposals.filter(p => p.venue === 'polymarket').map(p => el('div', { class: 'row proposal' },
        el('div', {},
          el('strong', {}, `Buy "${p.side}" at up to ${pct(p.price_limit)}`), ' ', el('span', { class: 'small muted' }, `· ${p.status}${p.paid_from ? ` · $${p.price_usd} from your ${p.paid_from === 'topup' ? 'top-up' : 'allowance'}` : ''}`),
          el('div', {}, p.forecast.question),
          el('div', { class: 'small' }, `AI: ${pct(p.forecast.ai_prob)} for ${p.forecast.outcome}, market ${pct(p.forecast.market_prob)}, ${p.forecast.confidence} confidence (${p.forecast.model}).`),
          el('p', { class: 'small' }, p.forecast.reasoning),
          el('div', { class: 'small' }, 'Sources: ', ...p.forecast.sources.map((u, i) => [i ? ', ' : '', el('a', { href: u, target: '_blank', rel: 'noopener nofollow' }, new URL(u).hostname)]).flat())),
        p.status === 'offered' ? el('div', {},
          el('button', { class: 'btn primary', type: 'button', onclick: () => approve(p) }, `Review the order ($${p.price_usd})`),
          el('button', { class: 'btn ghost', type: 'button', onclick: () => act(p, 'dismiss') }, 'Dismiss')) : '')))
        .concat(out.proposals.length ? [] : [el('p', { class: 'muted' }, 'No proposals yet.')]));
    } catch (err) { say('ai-msg', err.message, 'bad'); }
  }

  async function act(p, action) {
    try { await api('POST', `/v1/ai/proposals/${p.id}/${action}`, {}); await load(); } catch (err) { say('ai-msg', err.message, 'bad'); }
  }

  /** Approving opens the market with a limit order at the proposal's price: the user checks it and signs it. */
  async function approve(p) {
    try {
      await api('POST', `/v1/ai/proposals/${p.id}/approve`, {});
      await pm().openMarket(p.market);
      pm().proposal = { id: p.id, asset_id: p.asset_id }; // the order carries RektBull's AI builder code and the proposal's limit
      const sel = $('o-outcome');
      if (p.asset_id && [...sel.options].some(o => o.value === p.asset_id)) sel.value = p.asset_id;
      $('o-side').value = 'BUY';
      $('o-type').value = 'GTC';
      pm().showForm();
      $('o-price').value = String(p.price_limit);
      say('order-msg', 'Filled in from the AI proposal: set the number of shares, check the order, then sign it yourself.', 'ok');
      await load();
    } catch (err) { say('ai-msg', err.message, 'bad'); }
  }

  async function saveSettings() {
    try { await api('PUT', '/v1/ai/proposals/settings', { polymarket: $('ai-on').checked, max_per_day: Number($('ai-max').value) }); say('ai-msg', 'Saved.', 'ok'); } catch (err) { say('ai-msg', err.message, 'bad'); }
  }

  $('ai-on').addEventListener('change', saveSettings);
  $('ai-max').addEventListener('change', saveSettings);
  RB.onSignedIn(load);
  track();
  load();
})();
