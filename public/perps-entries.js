/* The Perps page's entry proposals (src/hyperliquid/entries.js): stated rules, each signal a bracket, scored in
 * public. While RektBull only scores them (shadow), this card shows the scorecard. Once they're offered, a user
 * who asked for them can review one, sized for their account, and sign it with the trading key in this browser.
 * Loaded before perps.js, which calls load() at start and after sign-in. */
(function () {
  'use strict';
  const { HLCore: H, RB } = window;
  const $ = id => document.getElementById(id);
  const { el, say, api } = RB;
  const hl = () => RB.state.hl;
  const MODE = { off: 'Off', shadow: 'In testing: scored, not offered', offered: 'Offered' };
  const RULE = { breakout: 'Breakout', funding_fade: 'Funding fade', flush_reversal: 'Flush reversal' };
  const R = v => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v}R`);
  const px = v => Number(v).toLocaleString('en-US', { maximumSignificantDigits: 6 });
  let last = null;

  async function load() {
    if (!$('entries-card')) return;
    try {
      last = await api('GET', '/v1/hyperliquid/entries');
    } catch (err) {
      return say('entries-msg', `The entry proposals couldn't be read: ${err.message}`, 'bad');
    }
    $('entries-mode').textContent = MODE[last.mode] || last.mode;
    const o = last.overall;
    $('entries-score').replaceChildren(
      el('p', {}, o.scored ? `${o.scored} of ${o.signals} signals scored: average ${R(o.avg_r)} net of fees and estimated funding, take-profit reached ${o.win_rate_pct}% of the time (it needs over 33% to break even at 2R, before costs).` : `${o.signals} signal${o.signals === 1 ? '' : 's'} so far; none scored yet.`),
      last.by_rule.length ? el('div', { class: 'tablewrap' }, el('table', { class: 'rank' },
        el('thead', {}, el('tr', {}, ...['Rule', 'Signals', 'Scored', 'Take-profit', 'Stopped', 'At 24 h', 'Average', 'At 1 h', 'At 4 h'].map(h => el('th', { class: h === 'Rule' ? '' : 'num' }, h)))),
        el('tbody', {}, ...last.by_rule.map(r => el('tr', {}, el('td', {}, RULE[r.rule] || r.rule), ...[r.signals, r.scored, r.take_profit, r.stopped, r.expired, R(r.avg_r), R(r.avg_r_1h), R(r.avg_r_4h)].map(v => el('td', { class: 'num' }, String(v)))))))) : '',
      el('p', { class: 'small muted' }, `Costs counted: Hyperliquid's taker fee (${last.costs.hyperliquid_taker_pct}%) and RektBull's proposal fee (${last.costs.proposal_fee_pct}%), both ways, and funding ${last.costs.funding}. ${last.about}`));
    $('entries-latest').replaceChildren(...(last.latest.length ? last.latest.map(s => el('tr', {},
      el('td', {}, new Date(s.created_at).toLocaleString()), el('td', {}, s.coin), el('td', { class: s.side === 'long' ? 'up' : 'down' }, s.side), el('td', {}, RULE[s.rule] || s.rule),
      el('td', { class: 'num' }, px(s.entry_px)), el('td', { class: 'num' }, px(s.stop_px)), el('td', { class: 'num' }, px(s.tp_px)),
      el('td', {}, s.status === 'open' ? 'open' : s.status === 'tp' ? 'take-profit' : s.status === 'stop' ? 'stopped' : s.status === 'expired' ? 'closed at 24 h' : s.status),
      el('td', { class: 'num' }, R(s.r_final ?? s.r_4h ?? s.r_1h)))) : [el('tr', {}, el('td', { colspan: 9, class: 'muted' }, 'No signals yet.'))]));
    await offered();
  }

  /** While offered: the user's switch, and the signals open to act on. */
  async function offered() {
    const on = last.mode === 'offered' && RB.signedIn() && hl().wallet;
    $('entries-optin-wrap').hidden = !on;
    $('entries-open').replaceChildren();
    if (!on) return;
    const mine = await api('GET', '/v1/ai/proposals').catch(() => null);
    $('entries-optin').checked = !!mine?.settings?.hyperliquid;
    if (!$('entries-optin').checked) return say('entries-msg', 'Switch on "Show me entry proposals" to see the open ones.');
    $('entries-open').replaceChildren(...(last.open.length ? last.open.map(s => el('div', { class: 'alert medium' },
      el('h3', {}, `${s.coin} ${s.side}: ${RULE[s.rule] || s.rule}`),
      el('ul', { class: 'small' }, ...s.facts.map(f => el('li', {}, f.text, el('span', { class: 'muted' }, ` (${f.source})`)))),
      el('p', { class: 'small' }, `Entry ${px(s.entry_px)}, stop-loss ${px(s.stop_px)}, take-profit ${px(s.tp_px)}. Good until ${new Date(new Date(s.created_at).getTime() + last.rules.act_minutes * 60000).toLocaleTimeString()}, while the price is within ${last.rules.act_band_pct}% of the entry.`),
      el('button', { class: 'primary', onclick: e => act(s, e.target) }, 'Review, sized for my account'))) : [el('p', { class: 'muted' }, 'No signal is open to act on right now.')]));
  }

  async function act(s, btn) {
    btn.disabled = true;
    try {
      if (!hl().config.enabled) throw new Error('Perps trading is switched off on this server for now.');
      const b = await api('POST', `/v1/hyperliquid/entries/${s.id}/bracket`);
      const fee = b.fee ? ` RektBull's fee: ${b.fee.rate} of what fills, entry and exit (your own orders carry ${hl().config.builder.max_fee_rate}).` : '';
      if (!window.confirm(`${b.says}${b.note ? ` ${b.note}` : ''}${fee}\n\nSign it with your trading key?`)) throw new Error('Not signed.');
      if (b.fee && !hl().approvals?.builder_fee?.proposal_approved) {
        say('entries-msg', `Your wallet will show the approval: at most ${b.fee.rate} of each fill, to RektBull's builder address. Your own orders still carry ${hl().config.builder.max_fee_rate}.`);
        const signed = await hl().walletSign(chainId => H.approveBuilderFeeAction({ mainnet: hl().config.network === 'mainnet', signatureChainId: chainId, builder: b.fee.builder, tenthsBps: b.fee.tenths_bps, nonce: hl().nonce() }));
        await api('POST', '/v1/hyperliquid/exchange', signed);
        await hl().loadApprovals();
      }
      say('entries-msg', `Setting ${b.coin} to ${b.leverage}x isolated, then sending the bracket…`);
      await hl().send(b.leverage_action);
      const action = H.orderAction(b.action.orders, { grouping: b.action.grouping, builder: b.fee ? { b: b.fee.builder, f: b.fee.tenths_bps } : null });
      const r = await hl().send(action, { proposal_id: b.id });
      const bad = (r.results || []).some(x => x.error);
      say('entries-msg', `${b.coin}: ${(r.results || []).map(x => (x.filled ? `filled ${x.size} at ${x.avg_px}` : x.resting ? `order ${x.oid} on the book` : x.error ? `refused: ${x.error}` : x.status || 'done')).join('; ')}.`, bad ? 'bad' : 'ok');
      await hl().loadAccount(true);
    } catch (err) {
      say('entries-msg', err.message, 'bad');
    } finally { btn.disabled = false; }
  }

  async function optin() {
    try {
      await api('PUT', '/v1/ai/proposals/settings', { hyperliquid: $('entries-optin').checked });
      say('entries-msg', $('entries-optin').checked ? 'You\'ll see entry proposals here.' : 'Entry proposals are off for you.', 'ok');
      await offered();
    } catch (err) { say('entries-msg', err.message, 'bad'); }
  }
  if ($('entries-optin')) $('entries-optin').addEventListener('change', optin);

  RB.state.hlEntries = { load };
})();
