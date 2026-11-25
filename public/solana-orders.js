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
    trailing: 'A trailing stop: it starts that far under the coins\' value now and follows their value up, staying that far under the highest value RektBull\'s price checks see twice in a row. It never moves down. When their value falls to it, it sells at the market, but never below your floor, which is fixed in what you sign.',
    steps: 'Take-profits in steps: each sells its part of the coins when their value is up by its own amount, at that target less your slippage, or better. One transaction places them all, with one approval and a deposit for each.',
    limit_buy: 'Fires when the coin\'s price falls by your amount (DexScreener\'s price). It then buys with your SOL, but never fewer coins than your limit less your slippage. The Trade desk\'s buy checks run now, and the token check runs again before it buys. Your SOL stays in your wallet, wrapped, until it fills or you cancel.',
  };

  RB.onSignedIn(load);
  document.addEventListener('DOMContentLoaded', () => {
    $('so-kind').addEventListener('change', showKind);
    for (const id of ['so-trail', 'so-steps']) $(id).addEventListener('change', showKind);
    $('so-prepare').addEventListener('click', prepare);
    $('so-setup-btn').addEventListener('click', setupNow);
    $('so-sign').addEventListener('click', place);
    for (const id of ['so-token', 'so-share', 'so-spend', 'so-dip', 'so-stop', 'so-take', 'so-floor', 'so-slip', 'so-days', 'so-trail', 'so-steps', 'so-s1-take', 'so-s1-part', 'so-s2-take', 'so-s2-part', 'so-s3-take', 'so-s3-part']) $(id).addEventListener('input', () => { prepared = null; $('so-plan').hidden = true; $('so-sign').hidden = true; });
    const chain = $('chain');
    if (chain) chain.addEventListener('change', () => { if (chain.value === 'solana' && $('token').value && !$('so-token').value) $('so-token').value = $('token').value; });
    showKind();
  });

  function showKind() {
    const kind = $('so-kind').value;
    $('so-stop-wrap').hidden = kind !== 'stop_loss';
    $('so-take-wrap').hidden = kind !== 'take_profit';
    $('so-floor-wrap').hidden = kind === 'take_profit' || kind === 'limit_buy';
    $('so-slip-wrap').hidden = kind !== 'take_profit' && kind !== 'limit_buy';
    $('so-share-wrap').hidden = kind === 'limit_buy';
    $('so-spend-wrap').hidden = kind !== 'limit_buy';
    $('so-dip-wrap').hidden = kind !== 'limit_buy';
    if (kind === 'meme_watch_exit' && $('so-floor').value === '35') $('so-floor').value = '50';
    if (kind === 'stop_loss' && $('so-floor').value === '50') $('so-floor').value = '35';
    const steps = kind === 'take_profit' ? Number($('so-steps').value) : 1;
    $('so-trail-wrap').hidden = kind !== 'stop_loss';
    $('so-steps-wrap').hidden = kind !== 'take_profit';
    $('so-take-wrap').hidden = kind !== 'take_profit' || steps > 1;
    $('so-steps-rows').hidden = steps < 2;
    $('so-s3').hidden = steps < 3;
    // The usual splits: halves for 2 steps, 40/30/30 for 3 (unless already changed).
    if (steps === 3 && $('so-s1-part').value === '50' && $('so-s2-part').value === '50') { $('so-s1-part').value = '40'; $('so-s2-part').value = '30'; $('so-s2-take').value = '200'; }
    if (steps === 2 && $('so-s1-part').value === '40' && $('so-s2-part').value === '30') { $('so-s1-part').value = '50'; $('so-s2-part').value = '50'; $('so-s2-take').value = '300'; }
    $('so-explain').textContent = kind === 'stop_loss' && $('so-trail').checked ? EXPLAIN.trailing : steps > 1 ? EXPLAIN.steps : EXPLAIN[kind];
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
    $('so-setup').hidden = !r.setup_needed;
    $('so-off').hidden = r.enabled;
    $('so-off').textContent = r.enabled ? '' : r.why;
    for (const b of [$('so-prepare'), $('so-sign')]) b.disabled = !r.enabled;
    $('so-list').replaceChildren(...(r.orders.length ? r.orders.map(row) : [el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'No orders yet.'))]));
  }

  const STATES = { open: 'Open', triggered: 'Fired: selling', filled: 'Filled', cancelled: 'Cancelled', expired: 'Ended: cancel it to get its deposit back' };
  const coins = n => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  function row(o) {
    const sym = o.symbol || short(o.token);
    const buy = o.side === 'buy';
    const fired = buy ? `${coins(o.trigger_coins)} ${sym} for the SOL (${coins(o.coins_when_placed)} when placed)`
      : o.kind === 'meme_watch_exit' ? 'a critical Meme Watch alert'
        : o.trail_pct ? `${o.trigger_sol} SOL now: ${o.trail_pct}% under their highest (${o.peak_sol})` : `${o.trigger_sol} SOL (worth ${o.value_when_placed_sol} when placed)`;
    const status = [buy && o.state === 'triggered' ? 'Fired: buying' : STATES[o.state] || o.state];
    if (buy && o.bought_coins) status.push(`${coins(o.bought_coins)} ${sym} to you`);
    if (!buy && o.delivered_sol !== '0') status.push(`${o.delivered_sol} SOL to you`);
    if (o.last_error && ['triggered', 'open'].includes(o.state)) status.push(o.last_error);
    const live = ['open', 'triggered', 'expired'].includes(o.state);
    return el('tr', {},
      el('td', {}, el('a', { href: o.order_url, target: '_blank', rel: 'noopener' }, `${o.trail_pct ? 'Trailing stop' : o.kind_name}${o.step ? ` (step ${o.step} of ${o.steps})` : ''}`)),
      el('td', {}, buy ? `${o.spend_sol} SOL of ${sym}` : `${o.amount_whole.toLocaleString('en-US')} ${sym}`),
      el('td', {}, fired),
      el('td', {}, buy ? `at least ${coins(o.min_coins)} ${sym}` : `${o.floor_sol} SOL`),
      el('td', { class: 'small' }, status.join(' · ')),
      el('td', {}, live ? el('button', { class: 'link', onclick: () => cancel(o.id) }, 'Cancel') : ''));
  }

  function body() {
    const kind = $('so-kind').value;
    const b = { kind, token: $('so-token').value.trim(), share_pct: Number($('so-share').value), days: Number($('so-days').value) };
    if (kind === 'stop_loss') Object.assign(b, { [$('so-trail').checked ? 'trail_pct' : 'stop_pct']: Number($('so-stop').value), floor_pct: Number($('so-floor').value) });
    const steps = Number($('so-steps').value);
    if (kind === 'take_profit') {
      Object.assign(b, steps > 1
        ? { steps: [1, 2, 3].slice(0, steps).map(i => ({ take_pct: Number($(`so-s${i}-take`).value), part_pct: Number($(`so-s${i}-part`).value) })), slippage_pct: Number($('so-slip').value) }
        : { take_pct: Number($('so-take').value), slippage_pct: Number($('so-slip').value) });
    }
    if (kind === 'meme_watch_exit') Object.assign(b, { floor_pct: Number($('so-floor').value) });
    if (kind === 'limit_buy') {
      delete b.share_pct;
      Object.assign(b, { spend_sol: Number($('so-spend').value), dip_pct: Number($('so-dip').value), slippage_pct: Number($('so-slip').value) });
    }
    return b;
  }

  async function prepare(acknowledged = false) {
    say('so-msg', 'Checking the coin, the price and the order in a simulation…');
    $('so-sign').hidden = true;
    try {
      prepared = await api('POST', '/v1/solana/orders', { ...body(), ...(acknowledged === true ? { acknowledge_risks: true } : {}) });
    } catch (err) {
      prepared = null;
      // High risks found by the buy checks: shown, and the user decides.
      if (err.data?.needs_acknowledgement) {
        $('so-plan').replaceChildren(el('strong', {}, 'Read these first'),
          el('ul', {}, ...err.data.risks.map(r => el('li', {}, `${r.title}${r.source ? ` (${r.source})` : ''}`))),
          el('button', { class: 'btn', onclick: () => prepare(true) }, 'I\'ve read them: show the worst case'));
        $('so-plan').hidden = false;
        return say('so-msg', err.message, 'bad');
      }
      $('so-plan').hidden = true;
      return say('so-msg', err.message, 'bad');
    }
    const p = prepared;
    const sym = p.order.symbol || short(p.order.token);
    const what = p.order.side === 'buy' ? `${p.order.spend_sol} SOL of ${sym}` : `${p.order.amount_whole.toLocaleString('en-US')} ${sym}`;
    const lines = [
      el('strong', {}, p.orders ? `${p.orders.length} take-profits: ${p.orders.map(o => o.amount_whole.toLocaleString('en-US')).join(' + ')} ${sym}` : `${p.order.kind_name}: ${what}`),
      ...p.worst_case.map(t => el('p', {}, t)),
      ...p.notes.map(t => el('p', { class: 'warn' }, t)),
      el('p', { class: 'small' }, `Deposit: ${p.costs.order_deposit_sol} SOL. ${p.costs.order_deposit_note}`),
      ...(p.costs.new_accounts_sol ? [el('p', { class: 'small' }, `${p.costs.new_accounts_sol} SOL. ${p.costs.new_accounts_note}`)] : []),
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
      // One transaction places every step: each is confirmed from the chain.
      const ids = (prepared.orders || [prepared.order]).map(o => o.id);
      for (let i = 0; i < 20 && ids.length; i++) {
        for (const id of [...ids]) {
          const o = await api('POST', `/v1/solana/orders/${id}/confirm`);
          if (!o.waiting) ids.splice(ids.indexOf(id), 1);
        }
        if (!ids.length) { say('so-msg', `${prepared.orders ? 'Your orders are' : 'Your order is'} placed. RektBull watches ${prepared.orders ? 'them' : 'it'} from now on.`, 'ok'); break; }
        await RB.sleep(3000);
      }
      prepared = null;
      $('so-plan').hidden = true; $('so-sign').hidden = true;
      await refresh();
    } catch (err) { say('so-msg', err.message, 'bad'); }
  }

  /** The one-time setup an order is waiting on, signed and paid by the user's wallet. */
  async function setupNow() {
    try {
      const s = await api('POST', '/v1/solana/orders/setup');
      if (s.needed.length) {
        say('so-msg', 'Waiting for your wallet: the one-time setup.');
        await send(s.solana);
      }
      say('so-msg', 'Set up. Your orders fill as soon as they can.', 'ok');
      $('so-setup').hidden = true;
    } catch (err) { say('so-msg', err.message, 'bad'); }
  }

  async function cancel(id) {
    try {
      const c = await api('POST', `/v1/solana/orders/${id}/cancel`);
      if (!c.done) {
        say('so-msg', `Waiting for your wallet: this closes the order${c.revokes_approval ? ' and revokes the approval' : ''}${c.unwraps_sol ? ', unwraps your SOL' : ''}, and its deposit comes back to you.`);
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
