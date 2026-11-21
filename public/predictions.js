/* RektBull's Predictions page (Polymarket). The user's wallet signs every order and set-up step.
 * Signed orders go from this browser straight to Polymarket's order book, with the user's own
 * Polymarket API credentials, which are derived here from a wallet signature and kept in this tab only
 * (sessionStorage). RektBull's server prepares orders and set-up for signing; it never signs, and never
 * sees the credentials or an order's signature. */
(function () {
  'use strict';
  const { ethers, RB } = window;
  const $ = id => document.getElementById(id);
  const { el, say, api, short } = RB;
  const pm = { config: null, events: [], market: null, book: null, wallet: null, prepared: null };

  const usd = (v, d = 2) => (v === null || v === undefined ? '—' : (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const big = v => (v === null || v === undefined ? '—' : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${Math.round(v)}`);
  const cents = p => (p === null || p === undefined ? '—' : `${Math.round(p * 1000) / 10}¢`);
  const needWallet = () => { if (!RB.state.provider) throw new Error('Connect your wallet first (the button at the top right), so it can sign.'); };
  const onPolygon = async () => { needWallet(); await RB.switchChain(pm.config.chain_id_hex); };

  /** Signs EIP-712 typed data ({ domain, types incl. EIP712Domain, primaryType, message }) with the connected wallet. */
  async function signTyped(td) {
    await onPolygon();
    return RB.request('eth_signTypedData_v4', [RB.state.address, JSON.stringify(td)]);
  }

  /* ── markets: open to everyone ── */

  async function loadEvents(q = '') {
    try {
      const out = await api('GET', `/v1/polymarket/events${q ? `?q=${encodeURIComponent(q)}` : ''}`);
      pm.events = out.events;
      $('events').replaceChildren(...(out.events.length ? out.events.map(e => el('div', { class: 'row event' },
        el('div', {}, el('strong', {}, e.title), el('div', { class: 'sub' }, `Volume ${big(e.volume_24h_usd)} in 24 hours · liquidity ${big(e.liquidity_usd)}${e.end_date ? ` · ends ${new Date(e.end_date).toLocaleDateString()}` : ''}`),
          el('div', { class: 'chips' }, ...e.markets.slice(0, 6).map(m => el('button', { class: 'chip', onclick: () => openMarket(m.slug) }, `${m.title || m.question}: ${m.outcomes.map(o => `${o.name} ${cents(o.price)}`).join(' / ')}`)))))) : [el('p', { class: 'muted' }, 'No open market matches.')]));
      say('events-msg', `Source: ${out.source}, read at ${new Date(out.read_at).toLocaleTimeString()}.`);
    } catch (err) {
      say('events-msg', `Polymarket's markets couldn't be read: ${err.message}`, 'bad');
    }
  }

  async function openMarket(slug) {
    try {
      const { market: m } = await api('GET', `/v1/polymarket/markets/${encodeURIComponent(slug)}`);
      pm.market = m;
      $('market-card').hidden = false;
      $('mk-title').textContent = m.question;
      $('mk-facts').textContent = `Volume ${big(m.volume_usd)} · liquidity ${big(m.liquidity_usd)} · ends ${m.end_date ? new Date(m.end_date).toLocaleString() : 'not set'} · ${m.platform_fee_note}${m.accepting_orders ? '' : ' · NOT accepting orders now'}`;
      const r = m.resolution || {};
      $('mk-resolution').replaceChildren(el('strong', {}, 'How it resolves: '), [r.source ? `Source: ${r.source}.` : 'Polymarket names no resolution source for this market.', r.note || '', r.dispute || '', r.not_checked || ''].filter(Boolean).join(' '));
      $('o-outcome').replaceChildren(...m.outcomes.filter(o => o.asset_id).map(o => el('option', { value: o.asset_id }, `${o.name} (${cents(o.price)})`)));
      pm.prepared = null; $('o-go').hidden = true; $('o-plan').hidden = true; say('order-msg', '');
      await loadBook();
      $('market-card').scrollIntoView({ behavior: 'smooth' });
    } catch (err) { say('events-msg', `That market couldn't be read: ${err.message}`, 'bad'); }
  }

  async function loadBook() {
    try {
      const b = pm.book = await api('GET', `/v1/polymarket/books/${$('o-outcome').value}`);
      const rows = (list, kind) => list.slice(0, 5).map(x => el('tr', {}, el('td', {}, kind === 'ask' ? 'Sell' : 'Buy'), el('td', { class: 'num' }, cents(x.price)), el('td', { class: 'num' }, x.size.toLocaleString('en-US'))));
      $('book').replaceChildren(el('table', { class: 'rank' }, el('thead', {}, el('tr', {}, el('th', {}, 'Book'), el('th', { class: 'num' }, 'Price'), el('th', { class: 'num' }, 'Shares'))),
        el('tbody', {}, ...rows([...b.asks].reverse(), 'ask'), ...rows(b.bids, 'bid'))),
      el('p', { class: 'muted' }, `Tick ${b.tick_size}, smallest order ${b.min_order_size} shares. Source: ${b.source}.`));
    } catch (err) { $('book').replaceChildren(el('p', { class: 'bad' }, `The order book couldn't be read: ${err.message}`)); }
  }

  function showForm() {
    const limit = $('o-type').value === 'GTC';
    const buyMarket = !limit && $('o-side').value === 'BUY';
    $('o-usd-wrap').hidden = !buyMarket;
    $('o-size-wrap').hidden = buyMarket;
    $('o-price-wrap').hidden = !limit;
    pm.prepared = null; $('o-go').hidden = true; $('o-plan').hidden = true;
  }

  /* ── orders: prepared by RektBull, signed by the wallet, sent from here ── */

  async function prepare() {
    try {
      if (!RB.signedIn()) throw new Error('Sign in with your wallet first (the button at the top right).');
      const body = { asset_id: $('o-outcome').value, market_slug: pm.market.slug, side: $('o-side').value, order_type: $('o-type').value };
      if (!$('o-usd-wrap').hidden) body.amount_usd = $('o-usd').value;
      if (!$('o-size-wrap').hidden) body.size = $('o-size').value;
      if (!$('o-price-wrap').hidden) body.price = $('o-price').value;
      const p = pm.prepared = await api('POST', '/v1/polymarket/orders', body);
      const s = p.summary;
      $('o-plan').hidden = false;
      $('o-plan').replaceChildren(
        el('p', {}, `${s.side === 'BUY' ? 'Buy' : 'Sell'} ${s.shares} shares of "${p.market.outcome}" at ${s.kind === 'market' ? 'up to ' : ''}${cents(Number(s.price))}: about ${usd(s.notional_usd)}.`),
        el('p', { class: 'small' }, `Fees: ${p.fee.how}`),
        el('p', { class: 'small muted' }, `${p.not_advice} Signed by your wallet; sent from this browser to Polymarket (${p.send.note}).`));
      $('o-go').hidden = false;
      say('order-msg', '');
    } catch (err) { say('order-msg', err.message, 'bad'); }
  }

  /** The wallet signs the prepared order; a Deposit Wallet's signature carries its ERC-7739 suffix. */
  async function signOrder(p) {
    const sig = await signTyped(p.typed_data);
    return p.signature_suffix ? sig + p.signature_suffix : sig;
  }

  async function go() {
    const btn = $('o-go');
    btn.disabled = true;
    try {
      const p = pm.prepared;
      if (!p) throw new Error('Check the order first.');
      const geo = await fetch(pm.config.geoblock_url).then(r => r.json()).catch(() => null);
      if (geo?.blocked) throw new Error(`Polymarket doesn't accept orders from where you're connecting (${geo.country || 'your country'}).`);
      const creds = await credentials();
      say('order-msg', 'Your wallet will show the order to sign…');
      const body = JSON.parse(JSON.stringify(p.body));
      body.order.signature = await signOrder(p);
      body.owner = creds.key;
      say('order-msg', 'Sending to Polymarket…');
      const answer = await clob('POST', '/order', body, creds);
      await api('POST', `/v1/polymarket/orders/${p.id}/result`, { success: !!answer.success, order_id: answer.orderID, status: answer.status, error: answer.errorMsg || answer.error || null });
      if (!answer.success) throw new Error(`Polymarket refused it: ${answer.errorMsg || answer.error || 'no reason given'}`);
      say('order-msg', `Sent: ${answer.status === 'matched' ? 'filled' : answer.status === 'live' ? 'resting on the book' : answer.status}.`, 'ok');
      pm.prepared = null; btn.hidden = true;
      await Promise.all([loadPositions(), loadBook()]);
    } catch (err) {
      say('order-msg', err.message, 'bad');
    } finally { btn.disabled = false; }
  }

  async function cancelOrder(o, btn) {
    btn.disabled = true;
    try {
      const creds = await credentials();
      await clob('DELETE', '/order', { orderID: o.clob_order_id }, creds);
      await api('POST', `/v1/polymarket/orders/${o.id}/cancelled`, {});
      await loadPositions();
    } catch (err) { say('positions-msg', err.message, 'bad'); btn.disabled = false; }
  }

  /* ── the Polymarket wallet: set-up the wallet signs ── */

  async function loadWallet() {
    try {
      const w = pm.wallet = await api('GET', '/v1/polymarket/wallet');
      $('wallet-card').hidden = false;
      const missing = (w.approvals || []).filter(a => a.approved !== true);
      $('w-status').replaceChildren(el('p', {},
        el('strong', {}, w.label), ': ', el('code', {}, w.wallet), el('br'),
        w.deployed === false ? 'Not created yet.' : w.deployed ? 'Created.' : `Whether it's created couldn't be read: ${w.deployed_not_checked || 'unknown'}.`, ' ',
        w.deployed ? `pUSD: ${usd(w.pusd_balance)}${w.balance_not_checked ? ` (${w.balance_not_checked})` : ''}. ` : '',
        w.ready ? 'Ready to trade.' : missing.length && w.deployed ? `${missing.length} approval${missing.length === 1 ? '' : 's'} missing.` : ''),
      w.setup_note ? el('p', { class: 'small muted' }, w.setup_note) : '');
      $('w-approvals').replaceChildren(...(w.approvals || []).map(a => el('li', {}, `${a.approved ? '✓' : '·'} ${a.token} to ${a.to}: ${a.what}`)));
      $('w-deploy').hidden = !(w.can_prepare_setup && w.wallet_type === 'deposit' && w.deployed === false);
      $('w-approve').hidden = !(w.can_prepare_setup && w.deployed && missing.length);
    } catch (err) { $('wallet-card').hidden = false; say('wallet-msg', `Your Polymarket wallet couldn't be read: ${err.message}`, 'bad'); }
  }

  async function deploy() {
    try {
      say('wallet-msg', 'Creating your Polymarket wallet through Polymarket\'s relayer (no gas from you)…');
      await api('POST', '/v1/polymarket/wallet/deploy', {});
      for (let i = 0; i < 30; i++) { await RB.sleep(2000); await loadWallet(); if (pm.wallet.deployed) break; }
      say('wallet-msg', pm.wallet.deployed ? 'Created.' : 'Sent; it isn\'t showing yet. Refresh in a minute.', pm.wallet.deployed ? 'ok' : '');
    } catch (err) { say('wallet-msg', err.message, 'bad'); }
  }

  /** A wallet transaction (approvals, redeem, withdraw): RektBull prepares it, the wallet signs, Polymarket's relayer sends it. */
  async function walletTransaction(kind, extra = {}, msgId = 'wallet-msg') {
    const t = await api('POST', '/v1/polymarket/wallet/transactions', { kind, ...extra });
    if (t.wallet_type === 'eoa') { await onPolygon(); await RB.sendCalls(t, m => say(msgId, m)); return; }
    return sendPrepared(t, msgId);
  }

  /** Signs a prepared Deposit Wallet batch and has Polymarket's relayer send it; resolves 'confirmed', or 'sent' if not confirmed yet. */
  async function sendPrepared(t, msgId) {
    say(msgId, `Your wallet will show one signature for: ${t.steps.map(s => s.what).join(' ')}`);
    const signature = await signTyped(t.typed_data);
    await api('POST', `/v1/polymarket/wallet/transactions/${t.id}/submit`, { signature });
    for (let i = 0; i < 45; i++) {
      await RB.sleep(2000);
      const s = await api('GET', `/v1/polymarket/wallet/transactions/${t.id}`);
      if (s.status === 'confirmed') { say(msgId, 'Done.', 'ok'); return 'confirmed'; }
      if (s.status === 'failed') throw new Error(`Polymarket's relayer says it failed: ${s.error || 'no reason given'}`);
    }
    say(msgId, 'Sent; not confirmed yet. Refresh in a minute.');
    return 'sent';
  }

  async function fund() {
    try {
      const f = await api('POST', '/v1/polymarket/wallet/fund', { amount_usd: $('w-fund-usd').value });
      await onPolygon();
      await RB.sendCalls(f, m => say('wallet-msg', m));
      say('wallet-msg', 'Added.', 'ok');
      await loadWallet();
    } catch (err) { say('wallet-msg', err.message, 'bad'); }
  }

  /* ── positions and orders ── */

  async function loadPositions() {
    if (!pm.wallet?.wallet) return;
    $('positions-card').hidden = false;
    try {
      const p = await api('GET', `/v1/polymarket/positions?wallet=${pm.wallet.wallet}`);
      $('positions').replaceChildren(...(p.positions.length ? p.positions.map(x => el('tr', {},
        el('td', {}, el('button', { class: 'link', onclick: () => openMarket(x.slug) }, x.title)), el('td', {}, x.outcome),
        el('td', { class: 'num' }, x.size), el('td', { class: 'num' }, cents(x.avg_price)), el('td', { class: 'num' }, cents(x.current_price)),
        el('td', { class: 'num' }, usd(x.value_usd)), el('td', { class: `num ${x.pnl_usd > 0 ? 'up' : x.pnl_usd < 0 ? 'down' : ''}` }, usd(x.pnl_usd)),
        el('td', {}, x.redeemable && pm.wallet.can_prepare_setup ? el('button', { onclick: e => redeem(x, e.target) }, 'Redeem') : ''))) : [el('tr', {}, el('td', { colspan: 8, class: 'muted' }, 'No positions.'))]));
      say('positions-msg', `Source: ${p.source}. ${p.pnl_note}${p.note ? ' ' + p.note : ''}`);
    } catch (err) { say('positions-msg', `Your positions couldn't be read: ${err.message}`, 'bad'); }
    try {
      const { orders } = await api('GET', '/v1/polymarket/orders');
      $('orders').replaceChildren(...(orders.length ? orders.map(o => el('tr', {},
        el('td', {}, new Date(o.created_at).toLocaleString()),
        el('td', {}, `${o.side === 'BUY' ? 'Buy' : 'Sell'} ${o.shares} "${o.outcome}" at ${cents(o.price)}`, el('div', { class: 'sub' }, o.title || '')),
        el('td', {}, o.error ? `${o.status}: ${o.error}` : o.clob_status ? `${o.status} (${o.clob_status})` : o.status),
        el('td', {}, o.status === 'submitted' && o.clob_status === 'live' ? el('button', { onclick: e => cancelOrder(o, e.target) }, 'Cancel') : ''))) : [el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'No orders yet.'))]));
    } catch { /* the positions message already says what failed */ }
  }

  async function redeem(x, btn) {
    btn.disabled = true;
    try { await walletTransaction('redeem', { asset_id: x.asset_id }, 'positions-msg'); await loadPositions(); } catch (err) { say('positions-msg', err.message, 'bad'); btn.disabled = false; }
  }

  /* ── Polymarket API credentials: derived from a wallet signature, kept in this tab only ── */

  const credKey = () => `rb_pm_creds:${RB.state.address?.toLowerCase()}`;
  const b64ToBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const bytesToUrlB64 = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_');

  /**
   * The CLOB credentials for the connected wallet (docs: getting-started/api, "Authentication"):
   * the wallet signs ClobAuth (EIP-712, ClobAuthDomain, chain 137) once; Polymarket answers with the
   * API key, secret and passphrase. Kept in sessionStorage: this tab only, gone when it closes.
   */
  async function credentials(fresh = false) {
    needWallet();
    if (!fresh) {
      try { const c = JSON.parse(sessionStorage.getItem(credKey()) || 'null'); if (c?.key) return c; } catch { /* make new ones */ }
    }
    const address = ethers.getAddress(RB.state.address);
    const timestamp = String(Math.floor(Date.now() / 1000));
    say('wallet-msg', 'Your wallet will ask you to sign a message proving you control it, for Polymarket\'s order book. It moves nothing.');
    const signature = await signTyped({
      domain: { name: 'ClobAuthDomain', version: '1', chainId: pm.config.chain_id },
      types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }], ClobAuth: [{ name: 'address', type: 'address' }, { name: 'timestamp', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'message', type: 'string' }] },
      primaryType: 'ClobAuth',
      message: { address, timestamp, nonce: 0, message: 'This message attests that I control the given wallet' },
    });
    const headers = { POLY_ADDRESS: address, POLY_SIGNATURE: signature, POLY_TIMESTAMP: timestamp, POLY_NONCE: '0' };
    let r = await fetch(`${pm.config.clob_url}/auth/derive-api-key`, { headers });
    if (!r.ok) r = await fetch(`${pm.config.clob_url}/auth/api-key`, { method: 'POST', headers });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.apiKey) throw new Error(`Polymarket didn't give API credentials: ${out.error || r.status}`);
    const c = { key: out.apiKey, secret: out.secret, passphrase: out.passphrase, address };
    sessionStorage.setItem(credKey(), JSON.stringify(c));
    return c;
  }

  /** A request to Polymarket's CLOB with L2 headers: HMAC-SHA256 of timestamp + method + path + body, URL-safe base64. */
  async function clob(method, path, body, c) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const text = body === undefined ? '' : JSON.stringify(body);
    const key = await crypto.subtle.importKey('raw', b64ToBytes(c.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = bytesToUrlB64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(timestamp + method + path + text)));
    const r = await fetch(pm.config.clob_url + path, {
      method, body: text || undefined,
      headers: { 'content-type': 'application/json', POLY_ADDRESS: c.address, POLY_SIGNATURE: sig, POLY_TIMESTAMP: timestamp, POLY_API_KEY: c.key, POLY_PASSPHRASE: c.passphrase },
    });
    const out = await r.json().catch(() => ({}));
    if (r.status === 401) sessionStorage.removeItem(credKey());
    if (!r.ok && !('success' in out)) throw new Error(`Polymarket refused it: ${out.error || out.errorMsg || r.status}`);
    return out;
  }

  RB.onSignedIn(afterSignIn);
  async function afterSignIn() {
    if (!pm.config || !RB.signedIn()) return;
    await loadWallet();
    await loadPositions();
  }

  async function init() {
    try { pm.config = await api('GET', '/v1/polymarket/config'); } catch (err) { return say('events-msg', `The page couldn't start: ${err.message}`, 'bad'); }
    $('fee-how').textContent = pm.config.fee.how;
    if (!pm.config.enabled) say('order-msg', `${pm.config.unavailable} Markets can still be viewed.`, 'bad');
    await loadEvents();
    const slug = new URLSearchParams(location.search).get('market');
    if (slug) await openMarket(slug);
    await afterSignIn();
  }

  let timer = null;
  $('q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => loadEvents($('q').value.trim()), 300); });
  $('o-outcome').addEventListener('change', () => { showForm(); loadBook(); });
  for (const id of ['o-side', 'o-type']) $(id).addEventListener('change', showForm);
  for (const id of ['o-usd', 'o-size', 'o-price']) $(id).addEventListener('input', () => { pm.prepared = null; $('o-go').hidden = true; });
  $('o-prepare').addEventListener('click', prepare);
  $('o-go').addEventListener('click', go);
  $('w-deploy').addEventListener('click', deploy);
  $('w-approve').addEventListener('click', () => walletTransaction('approvals').then(loadWallet).catch(err => say('wallet-msg', err.message, 'bad')));
  $('w-creds').addEventListener('click', () => credentials(true).then(() => say('wallet-msg', 'Connected to Polymarket\'s order book. The credentials are kept in this tab only.', 'ok')).catch(err => say('wallet-msg', err.message, 'bad')));
  $('w-fund').addEventListener('click', fund);
  Object.assign(pm, { signTyped, openMarket, showForm, prepare, sendPrepared });
  RB.state.pm = pm;
  init();
})();
