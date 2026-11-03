/* RektBull pages: the wallet connection and sign-in every page shares.
 * The wallet signs everything; no page ever sees a key. Sign-in carries over
 * between pages in this tab (sessionStorage), and is never required to look. */
(function () {
  'use strict';
  const { ethers } = window;
  const $ = id => document.getElementById(id);

  const state = { wallets: [], wallet: null, provider: null, address: null, token: null };
  try { state.token = sessionStorage.getItem('rb_token'); state.address = sessionStorage.getItem('rb_wallet'); } catch { /* storage blocked */ }
  const listeners = [];

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }
  function say(id, text, kind) { const m = $(id); if (!m) return; m.textContent = text || ''; m.className = 'msg' + (kind ? ' ' + kind : ''); }
  const short = a => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
  const usd = cents => '$' + (cents / 100).toFixed(2);

  function forget() {
    state.token = null;
    try { sessionStorage.removeItem('rb_token'); } catch { /* fine */ }
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method, headers: { 'content-type': 'application/json', ...(state.token ? { authorization: 'Bearer ' + state.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && state.token && !path.startsWith('/v1/auth/')) { forget(); render(); }
    if (!res.ok) throw Object.assign(new Error(data.message || data.error || res.statusText), { status: res.status, data });
    return data;
  }
  const request = (method, params = []) => state.provider.request({ method, params });

  /* wallets: EIP-6963, with window.ethereum as a fallback */
  window.addEventListener('eip6963:announceProvider', e => {
    const { info, provider } = e.detail || {};
    if (!info || state.wallets.some(w => w.info.uuid === info.uuid)) return;
    state.wallets.push({ info, provider });
    render();
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  setTimeout(() => {
    if (!state.wallets.length && window.ethereum) { state.wallets.push({ info: { uuid: 'injected', name: 'Browser wallet' }, provider: window.ethereum }); render(); }
    if (!state.wallets.length) say('connect-msg', 'No wallet found. Install MetaMask, Coinbase Wallet or Phantom, or open this page in your wallet\'s browser.', 'bad');
  }, 400);

  function render() {
    const box = $('wallets');
    if (box) box.replaceChildren(...state.wallets.map(w => el('button', { onclick: () => connect(w) }, 'Connect ' + w.info.name)));
    const who = $('who');
    if (who) who.textContent = state.wallet ? `${state.wallet.info.name}: ${short(state.address)}` : (state.token && state.address ? `Signed in: ${short(state.address)}` : 'Not signed in');
    const btn = $('signin');
    if (btn) { btn.disabled = !state.provider; btn.hidden = !!state.token; }
  }

  async function connect(w) {
    try {
      state.wallet = w; state.provider = w.provider;
      const [addr] = await request('eth_requestAccounts');
      if (state.address && state.address.toLowerCase() !== addr.toLowerCase()) forget();
      state.address = addr;
      render();
      say('connect-msg', state.token ? 'Signed in.' : 'Connected. Now sign in: it only proves you own this wallet, and costs nothing.');
      if (state.token) notify();
    } catch (err) { say('connect-msg', err.message, 'bad'); }
  }

  async function signIn() {
    try {
      const chainId = Number(await request('eth_chainId'));
      const ch = await api('POST', '/v1/auth/nonce', { address: state.address, chain_id: chainId });
      const signature = await request('personal_sign', [ethers.hexlify(ethers.toUtf8Bytes(ch.message)), state.address]);
      const out = await api('POST', '/v1/auth/verify', { challenge_id: ch.challenge_id, signature });
      state.token = out.token;
      try { sessionStorage.setItem('rb_token', out.token); sessionStorage.setItem('rb_wallet', state.address); } catch { /* fine */ }
      render();
      say('connect-msg', 'Signed in.', 'ok');
      notify();
    } catch (err) { say('connect-msg', err.message, 'bad'); }
  }

  function notify() { for (const f of listeners) Promise.resolve(f()).catch(err => console.error(err)); }

  async function switchChain(chainId) {
    if ((await request('eth_chainId')).toLowerCase() === chainId) return;
    await request('wallet_switchEthereumChain', [{ chainId }]);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btn = $('signin');
    if (btn) btn.addEventListener('click', signIn);
    render();
    if (state.token) notify();
  });

  /* What things cost, and what to say when a run needs paying for. */
  const catalog = { products: {}, free_points: null, ready: null };
  catalog.ready = api('GET', '/v1/catalog').then(c => {
    for (const p of c.products) catalog.products[p.id] = p;
    catalog.free_points = c.free_points;
    return catalog;
  }).catch(() => catalog);

  /** " · 1 point or $0.25", " · $3.00 (5 a month with Safety Pro)" */
  function priceLabel(p) {
    if (!p) return '';
    const pro = catalog.products.pro_30d;
    const included = pro?.included_per_month?.[p.id];
    return ` · ${p.points ? `${p.points} point${p.points === 1 ? '' : 's'} or ` : ''}${p.price_usd}${included ? ` (${included} a month with Safety Pro)` : ''}`;
  }

  /** The message for a 402: how to pay, and the Safety Pro nudge. */
  function paymentMessage(p, err) {
    const per = catalog.free_points?.per_month || 30;
    const pro = catalog.products.pro_30d;
    const proText = pro ? ` Safety Pro covers it, and every other Safety desk check, for ${pro.price_usd} for 30 days.` : '';
    if (!state.token) {
      return p.points
        ? `Sign in with your wallet below (free): you get ${per} free points a month, and this costs ${p.points}.`
        : `${p.title} costs ${p.price_usd}. Sign in below, then top up credits or get Safety Pro.`;
    }
    const bal = err?.data?.credits_balance_cents;
    const credits = `${p.price_usd} from credits${bal !== undefined ? ` (you have ${usd(bal)})` : ''}`;
    if (p.points) return `You've used this month's free points.${proText} Or pay ${credits}. You weren't charged.`;
    return `${p.title} costs ${credits}.${pro?.included_per_month?.[p.id] ? ` Safety Pro includes ${pro.included_per_month[p.id]} a month.` : proText} You weren't charged.`;
  }

  /** "Paid with 5 free points", "Paid with your Safety Pro pass", ... */
  function paidLabel(run) {
    if (!run?.paid_with) return '';
    const how = {
      points: `${run.points} free point${run.points === 1 ? '' : 's'}`, pass: 'your Safety Pro pass',
      credits: `${usd(run.price_cents || 0)} from credits`, x402: `${usd(run.price_cents || 0)} by x402`, free: 'a free check',
    }[run.paid_with] || run.paid_with;
    return ` · Paid with ${how}, charged because it completed`;
  }

  /* Sending prepared calls from the wallet. */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function receipt(hash) {
    for (let k = 0; k < 90; k++) {
      const r = await request('eth_getTransactionReceipt', [hash]).catch(() => null);
      if (r) return r;
      await sleep(2000);
    }
    throw new Error('The transaction hasn\'t confirmed yet. It may still go through; check your wallet.');
  }
  const unsupported = err => err && err.code !== 4001 && (err.code === 4200 || err.code === -32601 || err.code === 5700 || err.code === 5710 || /not supported|does not exist|unsupported|method not found/i.test(err.message || ''));

  /**
   * Sends prepared calls ({ chain_id, atomic, calls }): as one bundle where
   * the wallet can (all or nothing when atomic), otherwise one at a time, in
   * order, stopping at the first that fails. Returns the transaction hashes.
   */
  async function sendCalls(p, progress = () => {}) {
    try {
      const sent = await request('wallet_sendCalls', [{ version: '2.0.0', chainId: p.chain_id, from: state.address, atomicRequired: !!p.atomic, calls: p.calls.map(c => ({ to: c.to, data: c.data, value: c.value })) }]);
      const id = typeof sent === 'string' ? sent : sent?.id;
      for (let k = 0; k < 90; k++) {
        const s = await request('wallet_getCallsStatus', [id]);
        const code = Number(s?.status);
        if (code === 200 || s?.status === 'CONFIRMED') return (s.receipts || []).map(r => r.transactionHash);
        if (code >= 400) throw new Error('The wallet says it failed onchain. Nothing was changed.');
        await sleep(2000);
      }
      throw new Error('It hasn\'t confirmed yet. Check your wallet.');
    } catch (err) {
      if (!unsupported(err)) throw err;
    }
    const hashes = [];
    for (const c of p.calls) {
      const hash = await request('eth_sendTransaction', [{ from: state.address, to: c.to, data: c.data, value: c.value }]);
      hashes.push(hash);
      progress(`Sent ${hashes.length} of ${p.calls.length}. Waiting for it to confirm…`);
      const r = await receipt(hash);
      if (Number(r.status) !== 1) throw new Error(hashes.length === 1 ? 'The first step failed onchain. Nothing else was sent.' : `Step ${hashes.length} (${c.label}) failed onchain; the steps before it went through, and nothing after it was sent.`);
    }
    return hashes;
  }

  window.RB = {
    sendCalls, sleep,
    state, el, say, api, short, usd, request, switchChain, catalog, priceLabel, paymentMessage, paidLabel,
    onSignedIn: f => listeners.push(f),
    signedIn: () => !!state.token,
  };
})();
