/* RektBull trading page. The wallet signs everything; this page never sees a key. */
(function () {
  'use strict';
  const { ethers } = window;
  const $ = id => document.getElementById(id);
  const BASE = '0x2105';
  const BASE_SEPOLIA = '0x14a34';
  const DEFAULT_LIMITS = { trade: 500, day: 10000 };
  const ROUTER_ABI = [
    'function setLimits(uint128 perTradeUsd, uint128 perPeriodUsd, uint32 periodSeconds, uint64 validUntil)',
    'function revoke()',
    'function limits(address) view returns (uint128 perTradeUsd, uint128 perPeriodUsd, uint32 periodSeconds, uint64 validUntil)',
  ];

  const state = { wallets: [], provider: null, address: null, token: null, config: null, proposal: null };
  try { state.token = sessionStorage.getItem('rb_token'); state.address = sessionStorage.getItem('rb_wallet'); } catch { /* storage blocked */ }

  /* ── helpers ── */
  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
    }
    for (const c of children.flat()) e.append(c instanceof Node ? c : document.createTextNode(String(c ?? '')));
    return e;
  }
  function say(id, text, kind) { const m = $(id); m.textContent = text || ''; m.className = 'msg' + (kind ? ' ' + kind : ''); }
  async function api(method, path, body) {
    const res = await fetch(path, {
      method, headers: { 'content-type': 'application/json', ...(state.token ? { authorization: 'Bearer ' + state.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || data.error || res.statusText), { status: res.status, data });
    return data;
  }
  const req = (method, params = []) => state.provider.request({ method, params });
  const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';

  /* ── 1. wallets (EIP-6963, with window.ethereum as a fallback) ── */
  window.addEventListener('eip6963:announceProvider', e => {
    const { info, provider } = e.detail || {};
    if (!info || state.wallets.some(w => w.info.uuid === info.uuid)) return;
    state.wallets.push({ info, provider });
    renderWallets();
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  setTimeout(() => {
    if (!state.wallets.length && window.ethereum) { state.wallets.push({ info: { uuid: 'injected', name: 'Browser wallet' }, provider: window.ethereum }); renderWallets(); }
    if (!state.wallets.length) say('connect-msg', 'No wallet found. Install MetaMask, Coinbase Wallet or Phantom, or open this page in your wallet\'s browser.', 'bad');
  }, 400);

  function renderWallets() {
    $('wallets').replaceChildren(...state.wallets.map(w => el('button', { onclick: () => connect(w) }, 'Connect ' + w.info.name)));
  }

  async function connect(w) {
    try {
      state.provider = w.provider;
      const [addr] = await req('eth_requestAccounts');
      if (state.address && state.address.toLowerCase() !== addr.toLowerCase()) { state.token = null; }
      state.address = addr;
      $('who').textContent = `${w.info.name}: ${short(addr)}`;
      $('signin').disabled = false;
      say('connect-msg', state.token ? 'Signed in.' : 'Connected. Now sign in: it only proves you own this wallet, and costs nothing.');
      if (state.token) await afterSignIn();
    } catch (err) { say('connect-msg', err.message, 'bad'); }
  }

  /* ── sign in (EIP-4361) ── */
  $('signin').addEventListener('click', async () => {
    try {
      const chainId = Number(await req('eth_chainId'));
      const ch = await api('POST', '/v1/auth/nonce', { address: state.address, chain_id: chainId });
      const signature = await req('personal_sign', [ethers.hexlify(ethers.toUtf8Bytes(ch.message)), state.address]);
      const out = await api('POST', '/v1/auth/verify', { challenge_id: ch.challenge_id, signature });
      state.token = out.token;
      try { sessionStorage.setItem('rb_token', out.token); sessionStorage.setItem('rb_wallet', state.address); } catch { /* fine */ }
      say('connect-msg', 'Signed in.', 'ok');
      await afterSignIn();
    } catch (err) { say('connect-msg', err.message, 'bad'); }
  });

  async function afterSignIn() {
    state.config = await api('GET', '/v1/trading/config');
    for (const id of ['trade-card', 'history-card', 'settings-card', 'limits-card']) $(id).hidden = false;
    if (!state.config.enabled) say('trade-msg', 'Trading is switched off on this server for now.', 'bad');
    await Promise.all([loadSettings(), loadHistory(), loadLimits()]);
  }

  async function switchChain(chainId) {
    if ((await req('eth_chainId')).toLowerCase() === chainId) return;
    await req('wallet_switchEthereumChain', [{ chainId }]);
  }

  /* ── 2. trade ── */
  $('side').addEventListener('change', () => {
    const sell = $('side').value === 'sell';
    $('amount-wrap').hidden = sell; $('fraction-wrap').hidden = !sell;
  });

  $('check').addEventListener('click', () => propose(false));

  async function propose(acknowledge) {
    say('trade-msg', 'Checking…');
    $('plan').hidden = true;
    const sell = $('side').value === 'sell';
    try {
      const p = await api('POST', '/v1/trading/proposals', {
        chain: 'base', side: $('side').value, base: $('base').value, token: $('token').value.trim(),
        ...(sell ? { sell_fraction: Number($('fraction').value) / 100 } : { amount_usd: Number($('amount').value) }),
        ...(acknowledge ? { acknowledge_risks: true } : {}),
      });
      state.proposal = p;
      showPlan(p);
      say('trade-msg', '');
    } catch (err) {
      if (err.data?.needs_acknowledgement) return showRisks(err.data);
      say('trade-msg', err.message, 'bad');
    }
  }

  function showRisks(data) {
    $('plan').hidden = false;
    $('plan').replaceChildren(
      el('p', { class: 'risk' }, data.message),
      el('ul', {}, (data.risks || []).map(r => el('li', { class: 'risk' }, r.title, ' — ', r.evidence || ''))),
      el('label', {}, el('span', {}, 'I\'ve read these risks and want to go ahead'), el('input', { type: 'checkbox', id: 'ack' })),
      el('button', { onclick: () => ($('ack').checked ? propose(true) : say('trade-msg', 'Tick the box to confirm you\'ve read the risks.', 'bad')) }, 'Continue'),
    );
    say('trade-msg', '');
  }

  function showPlan(p) {
    const s = p.plan.summary;
    $('plan').hidden = false;
    $('plan').replaceChildren(
      el('p', {}, el('strong', {}, s.text)),
      el('ul', {}, p.plan.checks.map(c => el('li', { class: 'check-ok' }, c.detail))),
      el('p', {}, s.fee ? `RektBull fee: ${s.fee.amount} ${s.fee.asset} (${s.fee.pct}%), taken inside the swap.` : 'No RektBull fee on this trade.'),
      el('p', { class: 'muted' }, 'Approving re-checks everything on a fresh price, then your wallet shows the exact transactions to sign.'),
      el('div', { class: 'row' },
        el('button', { class: 'primary', onclick: approveAndSign }, 'Approve and sign in my wallet'),
        el('button', { onclick: async () => { await api('POST', `/v1/trading/proposals/${p.id}/cancel`).catch(() => {}); $('plan').hidden = true; loadHistory(); } }, 'Cancel')),
    );
  }

  async function approveAndSign() {
    const p = state.proposal;
    try {
      say('trade-msg', 'Re-checking on a fresh price…');
      const approved = await api('POST', `/v1/trading/proposals/${p.id}/approve`);
      await switchChain(BASE);
      say('trade-msg', 'Confirm in your wallet…');
      const txHash = await sendCalls(approved.calls);
      await api('POST', `/v1/trading/proposals/${p.id}/submitted`, { tx_hash: txHash });
      say('trade-msg', `Sent: ${short(txHash)}. RektBull will confirm it onchain.`, 'ok');
      $('plan').hidden = true;
      await loadHistory();
      pollUntilDone(p.id);
    } catch (err) { say('trade-msg', err.message, 'bad'); loadHistory(); }
  }

  /** Sends the calls: as one batch where the wallet supports it (EIP-5792), else one by one. Returns the swap's hash. */
  async function sendCalls(bundle) {
    const calls = bundle.calls.map(c => ({ to: c.to, data: c.data, value: c.value }));
    try {
      const res = await req('wallet_sendCalls', [{ version: '2.0.0', chainId: bundle.chainId, from: state.address, atomicRequired: true, calls }]);
      const id = typeof res === 'string' ? res : res.id;
      for (let i = 0; i < 120; i++) {
        const st = await req('wallet_getCallsStatus', [id]);
        const receipts = st.receipts || [];
        if (receipts.length) return receipts[receipts.length - 1].transactionHash;
        if (st.status >= 400) throw new Error('your wallet reported the batch failed');
        await new Promise(r => setTimeout(r, 1500));
      }
      throw new Error('the wallet has not sent the trade yet');
    } catch (err) {
      if (!/method|support|4200|-32601|unsupported/i.test(String(err.code) + ' ' + err.message)) throw err;
    }
    let last = null;
    for (const c of bundle.calls) {
      last = await req('eth_sendTransaction', [{ from: state.address, to: c.to, data: c.data, value: c.value, ...(c.gas ? { gas: c.gas } : {}) }]);
      if (c.step === 'approve') await waitFor(last);
    }
    return last;
  }

  async function waitFor(hash) {
    for (let i = 0; i < 120; i++) {
      const r = await req('eth_getTransactionReceipt', [hash]);
      if (r) { if (r.status !== '0x1') throw new Error('the approval failed onchain'); return r; }
      await new Promise(res => setTimeout(res, 1500));
    }
    throw new Error('the approval is taking too long; check your wallet');
  }

  async function pollUntilDone(id) {
    for (let i = 0; i < 60; i++) {
      const p = await api('GET', `/v1/trading/proposals/${id}`).catch(() => null);
      if (p && ['confirmed', 'failed'].includes(p.status)) {
        say('trade-msg', p.status === 'confirmed' ? 'Trade confirmed onchain.' : `Trade failed: ${p.error}`, p.status === 'confirmed' ? 'ok' : 'bad');
        return loadHistory();
      }
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  async function loadHistory() {
    const [{ proposals }, { positions }] = await Promise.all([api('GET', '/v1/trading/proposals'), api('GET', '/v1/trading/positions')]);
    $('history').replaceChildren(...proposals.map(p => el('tr', {},
      el('td', {}, new Date(p.created_at).toLocaleString()), el('td', {}, p.plan?.summary?.text || `${p.side} ${p.token}`), el('td', { class: p.error ? '' : 'status' }, p.status + (p.error ? `: ${p.error}` : '')))));
    $('positions').replaceChildren(...positions.map(p => el('tr', {}, el('td', {}, p.token), el('td', {}, p.amount_raw), el('td', {}, '$' + p.cost_usd.toFixed(2)))));
  }

  /* ── safety settings ── */
  async function loadSettings() {
    const s = await api('GET', '/v1/trading/settings');
    $('s-max').value = s.max_trade_usd; $('s-tax').value = s.max_tax_bps / 100; $('s-loss').value = s.max_round_trip_loss_pct; $('s-slip').value = s.slippage_bps / 100;
  }
  $('s-save').addEventListener('click', async () => {
    try {
      await api('PUT', '/v1/trading/settings', {
        max_trade_usd: Number($('s-max').value), max_tax_bps: Math.round(Number($('s-tax').value) * 100),
        max_round_trip_loss_pct: Number($('s-loss').value), slippage_bps: Math.round(Number($('s-slip').value) * 100),
      });
      say('settings-msg', 'Saved.', 'ok');
    } catch (err) { say('settings-msg', err.message, 'bad'); }
  });

  /* ── automatic trading limits (written onchain by the user's wallet) ── */
  const router = () => state.config?.automatic_trading?.routers?.['84532'];

  function updateWorst() {
    const trade = Number($('l-trade').value), day = Number($('l-day').value), days = Number($('l-days').value);
    const until = new Date(Date.now() + days * 86400000).toLocaleDateString();
    $('worst').textContent = `At most $${day.toLocaleString()} a day can be traded, at most $${trade.toLocaleString()} per trade, only through the RektBull Trade Router, only back into this wallet, until ${until}. RektBull's fee is 1% and the router can't charge more. You can stop it at any time.`;
    $('confirm-wrap').hidden = !(trade > DEFAULT_LIMITS.trade || day > DEFAULT_LIMITS.day);
  }
  for (const id of ['l-trade', 'l-day', 'l-days']) $(id).addEventListener('input', updateWorst);
  updateWorst();

  async function loadLimits() {
    if (!router()) { $('limits-now').textContent = 'Automatic trading isn\'t set up on this server yet.'; return; }
    try {
      const l = await api('GET', '/v1/trading/limits?chain_id=84532');
      $('limits-now').textContent = l.active
        ? `Now: $${l.per_trade_usd.toLocaleString()} per trade, $${l.per_day_usd.toLocaleString()} per day, until ${new Date(l.valid_until * 1000).toLocaleString()}.`
        : 'No limits set: automatic trading is off for this wallet.';
    } catch { $('limits-now').textContent = 'Couldn\'t read your current limits from the test network.'; }
  }

  async function routerTx(data) {
    await switchChain(BASE_SEPOLIA);
    const hash = await req('eth_sendTransaction', [{ from: state.address, to: router(), data }]);
    say('limits-msg', `Sent ${short(hash)}…`);
    await waitFor(hash);
    await loadLimits();
    return hash;
  }

  $('l-save').addEventListener('click', async () => {
    try {
      const trade = Number($('l-trade').value), day = Number($('l-day').value), days = Number($('l-days').value);
      if (!(trade > 0 && day >= trade && days >= 1 && days <= 30)) throw new Error('Per trade must be above 0, per day at least per trade, and 1 to 30 days.');
      if ((trade > DEFAULT_LIMITS.trade || day > DEFAULT_LIMITS.day) && Number($('l-confirm').value) !== day) {
        throw new Error(`Type ${day} in the box to confirm you understand that much can be traded in a day.`);
      }
      const iface = new ethers.Interface(ROUTER_ABI);
      const data = iface.encodeFunctionData('setLimits', [BigInt(Math.round(trade * 1e8)), BigInt(Math.round(day * 1e8)), 86400, Math.floor(Date.now() / 1000) + days * 86400]);
      await routerTx(data);
      say('limits-msg', 'Limits saved onchain from your wallet.', 'ok');
    } catch (err) { say('limits-msg', err.message, 'bad'); }
  });

  $('l-revoke').addEventListener('click', async () => {
    try {
      await routerTx(new ethers.Interface(ROUTER_ABI).encodeFunctionData('revoke', []));
      say('limits-msg', 'Automatic trading stopped for this wallet.', 'ok');
    } catch (err) { say('limits-msg', err.message, 'bad'); }
  });
})();
