/* Orders on Solana (trade page): a stop-loss, a take-profit or a Meme Watch exit, placed by the user's own wallet.
   The worst case is shown before anything is signed; this page never sees a key. */
(function () {
  'use strict';
  const RB = window.RB;
  const { el, say, api, short } = RB;
  const $ = id => document.getElementById(id);
  const state = RB.state;
  let prepared = null;

  const EXPLAIN = {
    stop_loss: 'Fires when the coins\' value falls by your amount (DexScreener\'s price). It then sells at the market, but never below your floor: if the price falls straight past it, the order can\'t fill and you keep the coins.',
    take_profit: 'Fires when the coins\' value rises by your amount. It sells at your target less your slippage, or better.',
    meme_watch_exit: 'Fires when Meme Watch raises a critical alert for the coin: launch-bundle wallets selling, or liquidity pulled. Needs Meme Watch on (My agents). It sells at the market, but never below your floor.',
  };

  RB.onSignedIn(load);
  document.addEventListener('DOMContentLoaded', () => {
    $('so-kind').addEventListener('change', showKind);
    $('so-prepare').addEventListener('click', prepare);
    $('so-sign').addEventListener('click', place);
    for (const id of ['so-token', 'so-share', 'so-stop', 'so-take', 'so-floor', 'so-slip', 'so-days']) $(id).addEventListener('input', () => { prepared = null; $('so-plan').hidden = true; $('so-sign').hidden = true; });
    const chain = $('chain');
    if (chain) chain.addEventListener('change', () => { if (chain.value === 'solana' && $('token').value && !$('so-token').value) $('so-token').value = $('token').value; });
    showKind();
  });

  function showKind() {
    const kind = $('so-kind').value;
    $('so-stop-wrap').hidden = kind !== 'stop_loss';
    $('so-take-wrap').hidden = kind !== 'take_profit';
    $('so-floor-wrap').hidden = kind === 'take_profit';
    $('so-slip-wrap').hidden = kind !== 'take_profit';
    if (kind === 'meme_watch_exit' && $('so-floor').value === '35') $('so-floor').value = '50';
    if (kind === 'stop_loss' && $('so-floor').value === '50') $('so-floor').value = '35';
    $('so-explain').textContent = EXPLAIN[kind];
  }

  async function load() {
    const me = await api('GET', '/v1/me').catch(() => null);
    if (!me?.account?.solana_wallet && !state.sol) return; // Solana orders need a linked Solana wallet
    $('sol-orders-card').hidden = false;
    const q = new URLSearchParams(location.search);
    if (q.get('chain') === 'solana' && q.get('token')) $('so-token').value = q.get('token');
    await refresh();
  }

  async function refresh() {
    const r = await api('GET', '/v1/solana/orders').catch(err => ({ error: err.message }));
    if (r.error) return say('so-msg', r.error, 'bad');
    $('so-off').hidden = r.enabled;
    $('so-off').textContent = r.enabled ? '' : r.why;
    for (const b of [$('so-prepare'), $('so-sign')]) b.disabled = !r.enabled;
    $('so-list').replaceChildren(...(r.orders.length ? r.orders.map(row) : [el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'No orders yet.'))]));
  }

  const STATES = { open: 'Open', triggered: 'Fired: selling', filled: 'Filled', cancelled: 'Cancelled', expired: 'Ended: cancel it to get its deposit back' };
  function row(o) {
    const fired = o.kind === 'meme_watch_exit' ? 'a critical Meme Watch alert' : `${o.trigger_sol} SOL (worth ${o.value_when_placed_sol} when placed)`;
    const status = [STATES[o.state] || o.state];
    if (o.delivered_sol !== '0') status.push(`${o.delivered_sol} SOL to you`);
    if (o.last_error && ['triggered', 'open'].includes(o.state)) status.push(o.last_error);
    const live = ['open', 'triggered', 'expired'].includes(o.state);
    return el('tr', {},
      el('td', {}, el('a', { href: o.order_url, target: '_blank', rel: 'noopener' }, o.kind_name)),
      el('td', {}, `${o.amount_whole.toLocaleString('en-US')} ${o.symbol || short(o.token)}`),
      el('td', {}, fired),
      el('td', {}, `${o.floor_sol} SOL`),
      el('td', { class: 'small' }, status.join(' · ')),
      el('td', {}, live ? el('button', { class: 'link', onclick: () => cancel(o.id) }, 'Cancel') : ''));
  }

  function body() {
    const kind = $('so-kind').value;
    const b = { kind, token: $('so-token').value.trim(), share_pct: Number($('so-share').value), days: Number($('so-days').value) };
    if (kind === 'stop_loss') Object.assign(b, { stop_pct: Number($('so-stop').value), floor_pct: Number($('so-floor').value) });
    if (kind === 'take_profit') Object.assign(b, { take_pct: Number($('so-take').value), slippage_pct: Number($('so-slip').value) });
    if (kind === 'meme_watch_exit') Object.assign(b, { floor_pct: Number($('so-floor').value) });
    return b;
  }

  async function prepare() {
    say('so-msg', 'Checking your holding, the price and the order in a simulation…');
    $('so-sign').hidden = true;
    try {
      prepared = await api('POST', '/v1/solana/orders', body());
    } catch (err) { prepared = null; $('so-plan').hidden = true; return say('so-msg', err.message, 'bad'); }
    const p = prepared;
    const lines = [
      el('strong', {}, `${p.order.kind_name}: ${p.order.amount_whole.toLocaleString('en-US')} ${p.order.symbol || short(p.order.token)}`),
      ...p.worst_case.map(t => el('p', {}, t)),
      ...p.notes.map(t => el('p', { class: 'warn' }, t)),
      el('p', { class: 'small' }, `Deposit: ${p.costs.order_deposit_sol} SOL. ${p.costs.order_deposit_note}`),
      ...(p.costs.volume_accounts_sol ? [el('p', { class: 'small' }, `Once: ${p.costs.volume_accounts_sol} SOL. ${p.costs.volume_accounts_note}`)] : []),
      el('p', { class: 'small' }, p.costs.fee),
      el('ul', { class: 'small muted' }, ...p.checks.map(c => el('li', {}, `${c.detail} (${c.source})`))),
    ];
    $('so-plan').replaceChildren(...lines);
    $('so-plan').hidden = false;
    $('so-sign').hidden = false;
    say('so-msg', 'Read the worst case, then place it from your wallet.');
  }

  /** Signs and sends a prepared Solana transaction in the connected wallet (Wallet Standard). */
  async function send(solana) {
    if (!state.sol) throw new Error('Connect your Solana wallet first (above).');
    const feature = state.sol.wallet.features['solana:signAndSendTransaction'];
    if (!feature) throw new Error('This wallet can\'t send Solana transactions from a web page. Try Phantom, Solflare or MetaMask.');
    const transaction = Uint8Array.from(atob(solana.transaction), c => c.charCodeAt(0));
    const [out] = await feature.signAndSendTransaction({ account: state.sol.account, chain: RB.SOL_CHAIN, transaction, options: { preflightCommitment: 'confirmed' } });
    return RB.base58(out.signature);
  }

  async function place() {
    if (!prepared) return;
    try {
      say('so-msg', 'Waiting for your wallet…');
      await send(prepared.solana);
      say('so-msg', 'Sent. Waiting for the chain…');
      for (let i = 0; i < 20; i++) {
        const o = await api('POST', `/v1/solana/orders/${prepared.order.id}/confirm`);
        if (!o.waiting) { say('so-msg', 'Your order is placed. RektBull watches it from now on.', 'ok'); break; }
        await RB.sleep(3000);
      }
      prepared = null;
      $('so-plan').hidden = true; $('so-sign').hidden = true;
      await refresh();
    } catch (err) { say('so-msg', err.message, 'bad'); }
  }

  async function cancel(id) {
    try {
      const c = await api('POST', `/v1/solana/orders/${id}/cancel`);
      if (!c.done) {
        say('so-msg', `Waiting for your wallet: this closes the order${c.revokes_approval ? ' and revokes the approval' : ''}, and its deposit comes back to you.`);
        await send(c.solana);
        for (let i = 0; i < 20; i++) {
          const o = await api('POST', `/v1/solana/orders/${id}/refresh`);
          if (o.state !== 'open' && o.state !== 'triggered' && o.state !== 'expired') break;
          await RB.sleep(3000);
        }
      }
      say('so-msg', 'Cancelled.', 'ok');
      await refresh();
    } catch (err) { say('so-msg', err.message, 'bad'); }
  }
})();
