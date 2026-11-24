/* Orders on BNB Chain and Base (trade page): a limit buy, a stop-loss, a take-profit or a Meme Watch exit, signed by
   the user's own wallet (EIP-712) and filled through RektBull's Meme Router. The worst case is shown before anything is
   signed; this page never sees a key. */
(function () {
  'use strict';
  const RB = window.RB;
  const { el, say, api, short, switchChain } = RB;
  const $ = id => document.getElementById(id);
  const state = RB.state;
  let prepared = null;
  const NATIVE = { bsc: { coin: 'BNB', wrapped: 'WBNB' }, base: { coin: 'ETH', wrapped: 'WETH' } };

  const EXPLAIN = {
    stop_loss: 'Fires when the coins\' value falls by your amount (DexScreener\'s price). It then sells at the market, but never below your floor: if the price falls straight past it, the order can\'t fill and you keep the coins.',
    take_profit: 'Fires when the coins\' value rises by your amount. It sells at your target less your slippage, or better.',
    meme_watch_exit: 'Fires when Meme Watch raises a critical alert for the coin: launch-bundle wallets selling, or liquidity pulled. Needs Meme Watch on (My agents). It sells at the market, but never below your floor.',
    limit_buy: 'Fires when the coin\'s price falls by your amount (DexScreener\'s price). It then buys, but never fewer coins than your limit less your slippage. The Trade desk\'s buy checks run now, and the token check runs again before it buys. What it spends stays in your wallet, wrapped, until it fills.',
  };

  RB.onSignedIn(load);
  document.addEventListener('DOMContentLoaded', () => {
    $('eo-kind').addEventListener('change', showKind);
    $('eo-chain').addEventListener('change', showKind);
    $('eo-prepare').addEventListener('click', () => prepare());
    $('eo-sign').addEventListener('click', place);
    $('eo-cancel-all').addEventListener('click', cancelAll);
    for (const id of ['eo-chain', 'eo-token', 'eo-share', 'eo-spend', 'eo-dip', 'eo-stop', 'eo-take', 'eo-floor', 'eo-slip', 'eo-days', 'eo-kind']) {
      $(id).addEventListener('input', () => { prepared = null; $('eo-plan').hidden = true; $('eo-sign').hidden = true; });
    }
    showKind();
  });

  function showKind() {
    const kind = $('eo-kind').value;
    $('eo-stop-wrap').hidden = kind !== 'stop_loss';
    $('eo-take-wrap').hidden = kind !== 'take_profit';
    $('eo-floor-wrap').hidden = kind === 'take_profit' || kind === 'limit_buy';
    $('eo-slip-wrap').hidden = kind !== 'take_profit' && kind !== 'limit_buy';
    $('eo-share-wrap').hidden = kind === 'limit_buy';
    $('eo-spend-wrap').hidden = kind !== 'limit_buy';
    $('eo-dip-wrap').hidden = kind !== 'limit_buy';
    $('eo-spend-label').textContent = `${NATIVE[$('eo-chain').value].coin} to spend`;
    if (kind === 'meme_watch_exit' && $('eo-floor').value === '35') $('eo-floor').value = '50';
    if (kind === 'stop_loss' && $('eo-floor').value === '50') $('eo-floor').value = '35';
    $('eo-explain').textContent = EXPLAIN[kind];
  }

  async function load() {
    const me = await api('GET', '/v1/me').catch(() => null);
    if (!me?.account?.wallet) return; // these orders need a linked EVM wallet
    $('evm-orders-card').hidden = false;
    const q = new URLSearchParams(location.search);
    if (['bsc', 'base'].includes(q.get('chain'))) {
      $('eo-chain').value = q.get('chain');
      if (q.get('token')) $('eo-token').value = q.get('token');
      showKind();
    }
    await refresh();
  }

  async function refresh() {
    const r = await api('GET', '/v1/evm/orders').catch(err => ({ error: err.message }));
    if (r.error) return say('eo-msg', r.error, 'bad');
    const closed = (r.chains || []).filter(c => !c.open).map(c => c.label);
    $('eo-off').hidden = r.enabled && !closed.length;
    $('eo-off').textContent = !r.enabled ? r.why : closed.length ? `Not open yet on ${closed.join(' or ')}.` : '';
    for (const b of [$('eo-prepare'), $('eo-sign')]) b.disabled = !r.enabled;
    $('eo-list').replaceChildren(...(r.orders.length ? r.orders.map(row) : [el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'No orders yet.'))]));
  }

  const STATES = { open: 'Open', triggered: 'Fired: selling', filled: 'Filled', cancelled: 'Cancelled', expired: 'Ended' };
  const coins = n => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  function row(o) {
    const sym = o.symbol || short(o.token);
    const buy = o.side === 'buy';
    const fired = buy ? `${coins(o.trigger_coins)} ${sym} for it (${coins(o.coins_when_placed)} when placed)`
      : o.kind === 'meme_watch_exit' ? 'a critical Meme Watch alert' : `${o.trigger_native} ${o.native} (worth ${o.value_when_placed_native} when placed)`;
    const status = [buy && o.state === 'triggered' ? 'Fired: buying' : STATES[o.state] || o.state];
    if (buy && o.bought_coins) status.push(`${coins(o.bought_coins)} ${sym} to you`);
    if (!buy && o.delivered_native !== '0') status.push(`${o.delivered_native} ${o.native} to you`);
    if (o.last_error && ['triggered', 'open'].includes(o.state)) status.push(o.last_error);
    for (const f of o.fills || []) if (f.state !== 'failed') status.push(el('a', { href: f.tx_url, target: '_blank', rel: 'noopener' }, f.state === 'sent' ? 'fill sent' : 'fill'));
    const live = ['open', 'triggered', 'expired'].includes(o.state);
    const cells = status.flatMap((s, i) => (i ? [' · ', s] : [s]));
    return el('tr', {},
      el('td', {}, `${o.kind_name} (${o.chain_label})`),
      el('td', {}, buy ? `${o.spend_native} ${o.native} of ${sym}` : `${o.amount_whole.toLocaleString('en-US')} ${sym}`),
      el('td', {}, fired),
      el('td', {}, buy ? `at least ${coins(o.min_coins)} ${sym}` : `${o.floor_native} ${o.native}`),
      el('td', { class: 'small' }, ...cells),
      el('td', {}, live ? el('button', { class: 'link', onclick: () => cancel(o.id) }, o.state === 'expired' ? 'Revoke' : 'Cancel') : ''));
  }

  function body() {
    const kind = $('eo-kind').value;
    const b = { chain: $('eo-chain').value, kind, token: $('eo-token').value.trim(), share_pct: Number($('eo-share').value), days: Number($('eo-days').value) };
    if (kind === 'stop_loss') Object.assign(b, { stop_pct: Number($('eo-stop').value), floor_pct: Number($('eo-floor').value) });
    if (kind === 'take_profit') Object.assign(b, { take_pct: Number($('eo-take').value), slippage_pct: Number($('eo-slip').value) });
    if (kind === 'meme_watch_exit') Object.assign(b, { floor_pct: Number($('eo-floor').value) });
    if (kind === 'limit_buy') {
      delete b.share_pct;
      Object.assign(b, { spend: Number($('eo-spend').value), dip_pct: Number($('eo-dip').value), slippage_pct: Number($('eo-slip').value) });
    }
    return b;
  }

  async function prepare(acknowledged = false) {
    say('eo-msg', 'Checking the coin, the price and the order with the router…');
    $('eo-sign').hidden = true;
    try {
      prepared = await api('POST', '/v1/evm/orders', { ...body(), ...(acknowledged ? { acknowledge_risks: true } : {}) });
    } catch (err) {
      prepared = null;
      if (err.data?.needs_acknowledgement) {
        $('eo-plan').replaceChildren(el('strong', {}, 'Read these first'),
          el('ul', {}, ...err.data.risks.map(r => el('li', {}, `${r.title}${r.source ? ` (${r.source})` : ''}`))),
          el('button', { class: 'btn', onclick: () => prepare(true) }, 'I\'ve read them: show the worst case'));
        $('eo-plan').hidden = false;
        return say('eo-msg', err.message, 'bad');
      }
      $('eo-plan').hidden = true;
      return say('eo-msg', err.message, 'bad');
    }
    const p = prepared;
    const sym = p.order.symbol || short(p.order.token);
    const what = p.order.side === 'buy' ? `${p.order.spend_native} ${p.order.native} of ${sym}` : `${p.order.amount_whole.toLocaleString('en-US')} ${sym}`;
    $('eo-plan').replaceChildren(
      el('strong', {}, `${p.order.kind_name} on ${p.order.chain_label}: ${what}`),
      ...p.worst_case.map(t => el('p', {}, t)),
      ...p.notes.map(t => el('p', { class: 'warn' }, t)),
      el('p', { class: 'small' }, p.costs.deposit),
      el('p', { class: 'small' }, p.costs.fee),
      el('ul', { class: 'small muted' }, ...p.checks.map(c => el('li', {}, `${c.detail} (${c.source})`))));
    $('eo-plan').hidden = false;
    $('eo-sign').hidden = false;
    say('eo-msg', 'Read the worst case, then sign it in your wallet.');
  }

  /** The approval (and wrapping) an order needs, sent from the user's wallet; nothing when it already has them. */
  async function fund(calls) {
    if (!calls?.calls?.length) return;
    await switchChain(calls.chain_id);
    say('eo-msg', `Waiting for your wallet: ${calls.calls.map(c => c.label.toLowerCase()).join(', then ')}.`);
    await RB.sendCalls({ chain_id: calls.chain_id, atomic: false, calls: calls.calls }, m => say('eo-msg', m));
  }

  async function place() {
    if (!prepared) return;
    try {
      await switchChain(prepared.chain_id);
      say('eo-msg', 'Waiting for your wallet: sign the order (a signature only, nothing is sent).');
      const signature = await RB.request('eth_signTypedData_v4', [state.address, JSON.stringify(prepared.typed_data)]);
      const s = await api('POST', `/v1/evm/orders/${prepared.order.id}/sign`, { signature });
      await fund(s.calls);
      say('eo-msg', 'Your order is placed. RektBull watches it from now on.', 'ok');
      prepared = null;
      $('eo-plan').hidden = true; $('eo-sign').hidden = true;
      await refresh();
    } catch (err) { say('eo-msg', err.message, 'bad'); await refresh(); }
  }

  async function cancel(id) {
    try {
      const c = await api('POST', `/v1/evm/orders/${id}/cancel`);
      if (!c.done) {
        await switchChain(c.chain_id);
        say('eo-msg', `Waiting for your wallet: this cancels the order on the router${c.revokes_approval ? ' and revokes its approval' : ''}.`);
        await RB.sendCalls({ chain_id: c.chain_id, atomic: false, calls: c.calls }, m => say('eo-msg', m));
        await api('POST', `/v1/evm/orders/${id}/refresh`);
      }
      say('eo-msg', 'Cancelled.', 'ok');
      await refresh();
    } catch (err) { say('eo-msg', err.message, 'bad'); }
  }

  async function cancelAll() {
    const chain = $('eo-chain').value;
    try {
      const c = await api('POST', '/v1/evm/orders/cancel-all', { chain });
      await switchChain(c.chain_id);
      say('eo-msg', 'Waiting for your wallet: this cancels every order you signed on the router, and revokes its approvals.');
      await RB.sendCalls({ chain_id: c.chain_id, atomic: false, calls: c.calls }, m => say('eo-msg', m));
      const r = await api('GET', '/v1/evm/orders');
      for (const o of r.orders.filter(x => x.chain === chain && ['open', 'triggered', 'expired'].includes(x.state))) await api('POST', `/v1/evm/orders/${o.id}/refresh`).catch(() => null);
      say('eo-msg', 'Every order on this chain is cancelled.', 'ok');
      await refresh();
    } catch (err) { say('eo-msg', err.message, 'bad'); }
  }
})();
