/* The Perps page's protection proposals and market alerts (src/hyperliquid/protect.js): stated rules, not
 * predictions. A fix (a stop-loss, or reducing by half) is reduce-only and is signed here, by the trading key
 * in this browser. Loaded before perps.js, which calls load() after sign-in and alerts() at start. */
(function () {
  'use strict';
  const { HLCore: H, RB } = window;
  const $ = id => document.getElementById(id);
  const { el, say, api } = RB;
  const hl = () => RB.state.hl;
  let last = null;
  const SEV = { critical: 'Critical', high: 'High', medium: 'Worth a look', low: 'Low' };

  const facts = list => el('ul', { class: 'small' }, ...list.map(f => el('li', { class: f.not_checked ? 'muted' : '' }, f.text, el('span', { class: 'muted' }, ` (${f.source})`))));

  /** The fee line for a fix: the proposal fee, beside what the user's own orders carry. */
  function feeLine(p) {
    const b = hl().config.builder;
    if (!p.fee) return 'RektBull takes no fee on this order; Hyperliquid\'s own fee applies.';
    return `RektBull's fee on this fix: ${p.fee.rate} of what fills, taken by Hyperliquid only if it fills (your own orders carry ${b.max_fee_rate}). Prefer that? Place the same order yourself in the order form below.`;
  }

  async function load() {
    const card = $('protect-card');
    if (!card || !RB.signedIn() || !hl().wallet) return;
    card.hidden = false;
    try {
      last = await api('GET', '/v1/hyperliquid/protect');
    } catch (err) {
      return say('protect-msg', `Your positions couldn't be checked: ${err.message}`, 'bad');
    }
    $('protect-rules').replaceChildren(
      el('li', {}, `A liquidation price within ${last.rules.liq_min_pct}% or within a typical day's range (the last 24 hours, high to low), whichever is wider: reduce by half. Critical within half of that.`),
      el('li', {}, `No stop-loss that would close the position before liquidation: add one ${last.rules.stop_hourly_moves} typical hourly moves from the price, never more than ${Math.round(last.rules.stop_liq_share * 100)}% of the way to the liquidation price.`),
      el('li', {}, `Funding of ${last.rules.funding_apr_pct}% a year or more against the position: what it costs a day (facts only).`),
      el('li', {}, `A fix is good for ${last.rules.expiry_minutes} minutes; then it's made again from the prices then.`),
    );
    const list = last.proposals || [];
    $('protect-list').replaceChildren(...(list.length ? list.map(p => el('div', { class: `alert ${p.severity}` },
      el('h3', {}, el('span', { class: `sev-badge ${p.severity}` }, SEV[p.severity] || p.severity), ' ', p.title),
      el('p', {}, p.why),
      facts(p.facts),
      p.action ? el('div', {},
        el('p', {}, el('strong', {}, p.action.label), el('br'), el('span', { class: 'small' }, p.action.does)),
        el('p', { class: 'small muted' }, feeLine(p)),
        el('button', { class: 'primary', onclick: e => act(p, e.target) }, 'Review and sign with the trading key'))
        : el('p', { class: 'small muted' }, p.no_action || ''))) : [el('p', { class: 'muted' }, last.positions ? `Your ${last.positions === 1 ? 'position passes' : `${last.positions} positions pass`} every rule right now.` : 'No open positions to check.')]));
    say('protect-msg', last.not_checked.length ? `Not checked: ${last.not_checked.join('; ')}` : `Checked ${new Date(last.checked_at).toLocaleTimeString()}. Sources: ${last.sources.join(', ')}.`, last.not_checked.length ? 'bad' : '');
  }

  /** Approves the proposal fee as the most per fill, when the wallet hasn't yet: one signature from the wallet. */
  async function approveProposalFee(p) {
    const f = hl().approvals?.builder_fee;
    if (!p.fee || f?.proposal_approved) return;
    const ok = window.confirm(`This fix carries RektBull's proposal fee of ${p.fee.rate} of what fills. Your wallet approves it once as the most RektBull may charge per fill; your own orders still carry ${hl().config.builder.max_fee_rate}, and you can lower the approval any time. Continue?`);
    if (!ok) throw new Error('Not signed. You can place the same order yourself in the order form below.');
    say('protect-msg', `Your wallet will show the approval: at most ${p.fee.rate} of each fill, to RektBull's builder address.`);
    const signed = await hl().walletSign(chainId => H.approveBuilderFeeAction({ mainnet: hl().config.network === 'mainnet', signatureChainId: chainId, builder: p.fee.builder, tenthsBps: p.fee.tenths_bps, nonce: hl().nonce() }));
    await api('POST', '/v1/hyperliquid/exchange', signed);
    await hl().loadApprovals();
  }

  async function act(p, btn) {
    btn.disabled = true;
    try {
      if (!hl().config.enabled) throw new Error('Perps trading is switched off on this server for now.');
      await approveProposalFee(p);
      say('protect-msg', 'Signing in this browser and sending…');
      const action = H.orderAction(p.action.orders, { builder: p.fee ? { b: p.fee.builder, f: p.fee.tenths_bps } : null });
      const r = await hl().send(action, { proposal_id: p.id });
      const bad = (r.results || []).some(x => x.error);
      say('protect-msg', `${p.coin}: ${(r.results || []).map(x => (x.filled ? `filled ${x.size} at ${x.avg_px}` : x.resting ? `the stop-loss is on the book (order ${x.oid})` : x.error ? `Hyperliquid refused it: ${x.error}` : x.status || 'done')).join('; ') || 'done'}.`, bad ? 'bad' : 'ok');
      await hl().loadAccount(true);
      await load();
    } catch (err) {
      say('protect-msg', err.message, 'bad');
      btn.disabled = false;
    }
  }

  /** The market alerts: open to everyone, signed in or not. */
  async function alerts() {
    if (!$('m-alerts')) return;
    try {
      const a = await api('GET', '/v1/hyperliquid/alerts');
      $('m-alerts').replaceChildren(...(a.alerts.length ? a.alerts.map(x => el('li', {},
        el('span', { class: `sev-badge ${x.severity}` }, SEV[x.severity] || x.severity), ' ', el('strong', {}, x.title), el('br'),
        el('span', { class: 'small' }, x.text), el('span', { class: 'small muted' }, ` (${x.source})`))) : [el('li', { class: 'muted' }, `Nothing unusual in the ${a.markets} deep markets right now.`)]));
      say('alerts-msg', `As of ${new Date(a.as_of).toLocaleTimeString()}.${a.oi_history ? '' : ' Open-interest alerts start once RektBull has an hour of its own snapshots.'} Facts, not advice: none of these says which way a market will go.`);
    } catch (err) {
      say('alerts-msg', `The market alerts couldn't be read: ${err.message}`, 'bad');
    }
  }

  RB.state.hlProtect = { load, alerts };
})();
