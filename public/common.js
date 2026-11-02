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

  window.RB = {
    state, el, say, api, short, usd, request, switchChain,
    onSignedIn: f => listeners.push(f),
    signedIn: () => !!state.token,
  };
})();
