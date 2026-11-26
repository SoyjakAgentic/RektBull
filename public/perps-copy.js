/* The Perps page's copy trading: follow a Hyperliquid trader, and RektBull's agent opens and closes copies of their
 * new positions within the user's automatic-trading limits (hyperliquid/copy.js). The limits are enforced by
 * RektBull's trade service, not onchain, and this section says so. Loaded before perps.js, which calls load(). */
(function () {
  'use strict';
  const { HLCore: H, RB } = window;
  const $ = id => document.getElementById(id);
  const { el, say, api } = RB;
  const hl = () => RB.state.hl;
  let st = null;

  const usd = v => (v === null || v === undefined || Number.isNaN(v) ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(Number(v)).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
  const short = a => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const isAddress = a => /^0x[0-9a-fA-F]{40}$/.test(a);
  const settings = f => `${usd(f.trade_usd)} a copy, up to ${f.max_leverage}x, stop ${f.stop_loss_pct}%${f.take_profit_pct ? `, take profit ${f.take_profit_pct}%` : ''}`;
  const copyOf = t => (t.status === 'skipped' ? `Not copied: ${t.reason}` : t.status === 'open' ? 'Copied: open' : `Closed${t.reason ? `: ${t.reason}` : ''}`);

  async function load() {
    try {
      st = await api('GET', '/v1/hyperliquid/copy');
    } catch (err) {
      $('copy-card').hidden = false;
      return say('copy-msg', `Copy trading couldn't be read: ${err.message}`, 'bad');
    }
    $('copy-card').hidden = false;
    $('copy-copies').textContent = st.copies;
    $('copy-not').textContent = `${st.doesnt_copy} The limit is ${st.max_drift_pct}%.`;
    $('copy-delay').textContent = st.delay;
    $('copy-fee').textContent = st.fee
      ? `Copies are trades RektBull decides: ${st.fee.decided.open_rate} of what fills to open, ${st.fee.decided.profit_close_rate} to close at a profit, nothing at a loss. Hyperliquid takes it from the fill. The trader you copy is paid nothing.`
      : 'No builder fee is set on this server.';
    $('copy-rb').textContent = st.enforced_by_rektbull;
    $('copy-lose').textContent = st.most_you_can_lose;
    $('copy-advice').textContent = st.not_advice;
    $('copy-off').hidden = !st.why_off;
    $('copy-off').textContent = st.why_off || '';
    const active = st.follows.filter(f => f.status === 'active');
    $('copy-form').hidden = !st.enabled || active.length >= st.max_follows;
    $('copy-follows').querySelector('tbody').replaceChildren(...(st.follows.length ? st.follows.map(f => el('tr', {},
      el('td', {}, el('code', { title: f.leader }, short(f.leader))),
      el('td', {}, settings(f)),
      el('td', {}, f.status === 'active' ? `Copying since ${new Date(f.created_at).toLocaleString()}` : `${f.stop_reason || 'Stopped'} (${new Date(f.stopped_at).toLocaleString()})`),
      el('td', {}, f.status === 'active' ? el('div', { class: 'row' },
        el('button', { onclick: () => stop(f, false) }, 'Stop'),
        el('button', { class: 'danger', onclick: () => stop(f, true) }, 'Stop and close copies')) : ''))) : [el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'You don\'t copy anyone yet.'))]));
    $('copy-trades').querySelector('tbody').replaceChildren(...(st.trades.length ? st.trades.map(t => el('tr', {},
      el('td', {}, new Date(t.created_at).toLocaleString()),
      el('td', {}, `${short(t.leader)} opened a ${t.side} in ${t.coin}${t.leader_entry_px ? ` at ${t.leader_entry_px}` : ''}`),
      el('td', {}, copyOf(t)))) : [el('tr', {}, el('td', { colspan: 3, class: 'muted' }, 'No copies yet. The orders themselves are listed under Automatic orders.'))]));
  }

  async function look() {
    const a = $('c-leader').value.trim();
    if (!isAddress(a)) return say('copy-msg', 'Enter a Hyperliquid account address: 0x and 40 hex characters.', 'bad');
    say('copy-msg', 'Reading the trader from Hyperliquid…');
    try {
      const p = await api('GET', `/v1/hyperliquid/copy/traders/${a}`);
      const r = p.results;
      const line = (name, w) => (w ? `${name}: ${usd(w.pnl_usd)} (volume ${usd(w.volume_usd)})` : `${name}: —`);
      $('c-profile').replaceChildren(
        el('p', {}, el('strong', {}, 'Account value: '), usd(p.account_value_usd), '. ', r ? `Perps profit and loss, ${[line('day', r.day), line('week', r.week), line('month', r.month), line('all time', r.all_time)].join('; ')}.` : p.results_error),
        el('p', {}, el('strong', {}, 'Holding now (not copied): '), p.positions ? (p.positions.length ? p.positions.map(x => `${x.side} ${x.coin} ${usd(x.value_usd)} at ${x.leverage}x`).join(', ') : 'nothing') : p.positions_error),
        el('p', { class: 'muted' }, `Source: ${p.source}. ${p.note}`));
      say('copy-msg', '');
    } catch (err) { say('copy-msg', err.message, 'bad'); }
  }

  async function approveFees(fee) {
    say('copy-msg', `Your wallet will show the fee approval: at most ${fee.rate} of each fill, to RektBull's builder address. Your own orders still carry ${st.fee.own_orders_rate}.`);
    const signed = await hl().walletSign(chainId => H.approveBuilderFeeAction({ mainnet: hl().config.network === 'mainnet', signatureChainId: chainId, builder: fee.builder, tenthsBps: fee.tenths_bps, nonce: hl().nonce() }));
    await api('POST', '/v1/hyperliquid/exchange', signed);
    await hl().loadApprovals();
  }

  async function start() {
    const btn = $('c-start');
    btn.disabled = true;
    const body = { leader: $('c-leader').value.trim(), trade_usd: Number($('c-trade').value), max_leverage: Number($('c-lev').value), stop_loss_pct: Number($('c-sl').value), take_profit_pct: $('c-tp').value ? Number($('c-tp').value) : null };
    try {
      // Copies carry RektBull's fees on the trades it decides: approved once, as the most it may take per fill.
      const ap = hl().approvals?.builder_fee;
      if (st.fee && ap && !ap.error && !ap.auto_approved) await approveFees({ builder: st.fee.builder, tenths_bps: st.fee.decided.tenths_bps, rate: st.fee.decided.profit_close_rate });
      let out;
      try {
        out = await api('POST', '/v1/hyperliquid/copy/follows', body);
      } catch (err) {
        if (err.data?.error !== 'fee_not_approved') throw err;
        await approveFees(err.data.fee); // the approval couldn't be read here: the server's refusal says what to approve
        out = await api('POST', '/v1/hyperliquid/copy/follows', body);
      }
      say('copy-msg', `Copying ${short(out.follow.leader)}.${out.note ? ` ${out.note}` : ''}`, 'ok');
      await load();
    } catch (err) { say('copy-msg', err.message, 'bad'); } finally { btn.disabled = false; }
  }

  async function stop(f, close) {
    if (!window.confirm(close
      ? `Stop copying ${short(f.leader)} and close the copies that are open now?`
      : `Stop copying ${short(f.leader)}? Copies that are open stay open, with their stop-loss.`)) return;
    try {
      const out = await api('POST', `/v1/hyperliquid/copy/follows/${f.id}/stop`, { close_positions: close });
      const failed = out.closes.filter(c => c.error);
      say('copy-msg', `Stopped.${out.closes.length ? ` ${out.closes.length - failed.length} close${out.closes.length - failed.length === 1 ? '' : 's'} queued.` : ''}${failed.map(c => ` ${c.coin}: ${c.error}`).join('')}`, failed.length ? 'bad' : 'ok');
      await load();
      if (RB.state.hlAuto) await RB.state.hlAuto.load();
    } catch (err) { say('copy-msg', err.message, 'bad'); }
  }

  $('c-look').addEventListener('click', look);
  $('c-start').addEventListener('click', start);
  RB.state.hlCopy = { load };
})();
