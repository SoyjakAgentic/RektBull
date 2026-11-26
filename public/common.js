/* RektBull pages: the wallet connection and sign-in every page shares.
 * The wallet signs everything; no page ever sees a key. Sign-in carries over
 * between pages in this tab (sessionStorage), and is never required to look. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);

  /* state.wallet/provider/address: the connected EVM wallet (what EVM pages send through).
   * state.sol: the connected Solana wallet { wallet, account, address }. state.signedAs: the
   * address the session signed in with, and state.kind its kind ('evm' or 'solana'). */
  const state = { wallets: [], wallet: null, provider: null, address: null, sol: null, token: null, signedAs: null, kind: null };
  try {
    state.token = sessionStorage.getItem('rb_token');
    state.signedAs = sessionStorage.getItem('rb_wallet');
    state.kind = sessionStorage.getItem('rb_kind') || (state.signedAs ? 'evm' : null);
    if (state.kind === 'evm') state.address = state.signedAs;
  } catch { /* storage blocked */ }
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
  /** The message as 0x-hex UTF-8, the form personal_sign takes (no library needed). */
  const hexUtf8 = text => '0x' + Array.from(new TextEncoder().encode(text), b => b.toString(16).padStart(2, '0')).join('');

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

  const connected = () => state.provider || state.sol;

  /* EVM wallets: EIP-6963, with window.ethereum as a fallback */
  window.addEventListener('eip6963:announceProvider', e => {
    const { info, provider } = e.detail || {};
    if (!info || state.wallets.some(w => w.info.uuid === info.uuid)) return;
    state.wallets.push({ kind: 'evm', info, provider });
    render();
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));

  /* Solana wallets: the Wallet Standard (Phantom, Solflare, MetaMask's Solana account, Backpack…).
   * Each wallet registers itself; RektBull uses only connect and signMessage here, and
   * signAndSendTransaction on the trade page. */
  const SOL_CHAIN = 'solana:mainnet';
  function addSolanaWallet(w) {
    const f = w && w.features;
    if (!f || !f['standard:connect'] || !f['solana:signMessage'] || !(w.chains || []).includes(SOL_CHAIN)) return;
    if (state.wallets.some(x => x.kind === 'solana' && (x.wallet === w || x.info.name === w.name + ' · Solana'))) return;
    state.wallets.push({ kind: 'solana', wallet: w, info: { uuid: 'solana:' + w.name, name: w.name + ' · Solana', icon: w.icon } });
    render();
  }
  const standardApi = Object.freeze({ register: (...ws) => { ws.forEach(addSolanaWallet); return () => {}; } });
  window.addEventListener('wallet-standard:register-wallet', e => { try { e.detail(standardApi); } catch { /* a broken wallet */ } });
  try { window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: standardApi })); } catch { /* fine */ }

  const NO_WALLET = 'No wallet found. Install MetaMask, Phantom, Solflare or Coinbase Wallet, or open this page in your wallet\'s browser.';
  setTimeout(() => {
    if (!state.wallets.some(w => w.kind === 'evm') && window.ethereum) { state.wallets.push({ kind: 'evm', info: { uuid: 'injected', name: 'Browser wallet' }, provider: window.ethereum }); render(); }
    if (!state.wallets.length) say('connect-msg', NO_WALLET, 'bad');
  }, 400);

  function render() {
    const box = $('wallets');
    if (box) box.replaceChildren(...state.wallets.map(w => el('button', { onclick: () => connect(w) }, 'Connect ' + w.info.name)));
    const who = $('who');
    if (who) {
      const live = state.kind === 'solana' ? state.sol : state.wallet;
      who.textContent = state.token && state.signedAs ? `Signed in: ${short(state.signedAs)}`
        : live ? `${live === state.sol ? state.wallets.find(w => w.wallet === state.sol.wallet)?.info.name || 'Solana wallet' : state.wallet.info.name}: ${short(live === state.sol ? state.sol.address : state.address)}`
          : 'Not signed in';
    }
    const btn = $('signin');
    if (btn) { btn.disabled = !connected(); btn.hidden = !!state.token; }
    const head = $('hdr-connect');
    if (head) head.textContent = state.token ? 'Account' : connected() ? 'Sign in' : 'Connect wallet';
  }

  /* A short message at the bottom of the screen, for pages without a message line of their own. */
  let toastTimer;
  function toast(text) {
    const t = $('toast');
    if (!t) return;
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
  }
  /** Sign-in messages go to the page's own line when it has one, otherwise to a toast. */
  function tell(text, kind) { if ($('connect-msg')) say('connect-msg', text, kind); else if (text) toast(text); }
  const cancelled = err => err && (err.code === 4001 || /reject|cancel|denied|declined/i.test(err.message || ''));

  /* The header's menu: the wallets to sign in with; once signed in, the account's wallets, linking and signing out. */
  function menu() {
    const acct = document.querySelector('.bar .acct');
    if (!acct) return null;
    let m = $('hdr-menu');
    if (!m) { m = el('div', { id: 'hdr-menu', class: 'more-menu acct-menu', hidden: true }); acct.append(m); }
    return m;
  }
  const closeMenu = () => { const m = $('hdr-menu'); if (m) m.hidden = true; };

  async function headerConnect() {
    const m = menu();
    if (!m) return;
    if (!m.hidden) return closeMenu();
    if (!state.token) {
      if (!state.wallets.length) return toast(NO_WALLET);
      m.replaceChildren(el('p', { class: 'acct-menu-note' }, 'Sign in with a wallet. It only proves you own it: nothing is moved or approved.'),
        ...state.wallets.map(w => el('button', { type: 'button', onclick: async () => { closeMenu(); await connect(w); if (connected() && !state.token) await signIn(w.kind); } }, w.info.name)));
      m.hidden = false;
      return;
    }
    m.replaceChildren(el('p', { class: 'acct-menu-note' }, 'Loading your wallets…'));
    m.hidden = false;
    try {
      const me = await api('GET', '/v1/me');
      const a = me.account;
      const rows = [];
      const line = (label, addr, kind) => {
        const other = kind === 'evm' ? a.solana_wallet : a.wallet;
        rows.push(el('p', { class: 'acct-menu-note' }, `${label}: `, addr ? el('code', {}, short(addr)) : 'none',
          addr && other ? [' · ', el('button', { type: 'button', class: 'link', onclick: () => unlink(kind) }, 'Unlink')] : null));
        if (!addr) {
          const choices = state.wallets.filter(w => w.kind === kind);
          rows.push(choices.length
            ? el('div', { class: 'acct-menu-row' }, ...choices.map(w => el('button', { type: 'button', onclick: () => link(w) }, `Link ${w.info.name}`)))
            : el('p', { class: 'acct-menu-note' }, kind === 'solana' ? 'To link one, open this page with Phantom, Solflare or MetaMask (with Solana) installed.' : 'To link one, open this page with MetaMask, Rabby or Coinbase Wallet installed.'));
        }
      };
      line('EVM wallet', a.wallet, 'evm');
      line('Solana wallet', a.solana_wallet, 'solana');
      rows.push(el('a', { href: '/points', class: 'acct-menu-link' }, 'RektBull Points'));
      rows.push(el('button', { type: 'button', onclick: signOut }, 'Sign out'));
      m.replaceChildren(...rows);
    } catch (err) { m.replaceChildren(el('p', { class: 'acct-menu-note' }, err.message)); }
  }

  async function connect(w) {
    try {
      if (w.kind === 'solana') {
        const res = await w.wallet.features['standard:connect'].connect();
        const accts = (res && res.accounts) || w.wallet.accounts || [];
        const account = accts.find(x => (x.chains || []).includes(SOL_CHAIN)) || accts[0];
        if (!account) throw new Error('The wallet didn\'t share a Solana account.');
        state.sol = { wallet: w.wallet, account, address: account.address };
        if (state.kind === 'solana' && state.signedAs && state.signedAs !== account.address) forget();
      } else {
        state.wallet = w; state.provider = w.provider;
        const [addr] = await request('eth_requestAccounts');
        if (state.kind === 'evm' && state.signedAs && state.signedAs.toLowerCase() !== addr.toLowerCase()) forget();
        state.address = addr;
      }
      render();
      if ($('connect-msg')) say('connect-msg', state.token ? 'Signed in.' : 'Connected. Now sign in: it only proves you own this wallet, and costs nothing.');
      if (state.token) notify();
    } catch (err) {
      if (w.kind === 'solana') state.sol = null; else { state.provider = null; state.wallet = null; }
      render(); tell(cancelled(err) ? 'You cancelled in your wallet.' : err.message, 'bad');
    }
  }

  const b64 = bytes => btoa(String.fromCharCode(...bytes));
  /** Base58 (Bitcoin's alphabet), how Solana writes signatures and addresses. */
  function base58(bytes) {
    const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    let out = '';
    while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; }
    for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
    return out;
  }
  /** The signature for a challenge, from the connected wallet of that kind. */
  async function signChallenge(ch) {
    if (ch.kind === 'solana') {
      const [out] = await state.sol.wallet.features['solana:signMessage'].signMessage({ account: state.sol.account, message: new TextEncoder().encode(ch.message) });
      return b64(out.signature);
    }
    return request('personal_sign', [hexUtf8(ch.message), state.address]);
  }
  const chainId = async () => Number(await request('eth_chainId'));

  function remember(out, kind, address) {
    state.token = out.token; state.kind = kind; state.signedAs = address;
    try { sessionStorage.setItem('rb_token', out.token); sessionStorage.setItem('rb_wallet', address); sessionStorage.setItem('rb_kind', kind); } catch { /* fine */ }
  }

  /** Signs in with the connected wallet of `kind` (by default the Solana one only when no EVM wallet is connected). */
  async function signIn(kind) {
    kind = kind === 'solana' || kind === 'evm' ? kind : (!state.provider && state.sol ? 'solana' : 'evm');
    try {
      const address = kind === 'solana' ? state.sol?.address : state.address;
      if (!address) throw new Error('Connect a wallet first.');
      const ch = await api('POST', '/v1/auth/nonce', kind === 'solana' ? { kind, address } : { address, chain_id: await chainId() });
      const out = await api('POST', '/v1/auth/verify', { challenge_id: ch.challenge_id, signature: await signChallenge(ch) });
      remember(out, kind, address);
      render();
      tell('Signed in.', 'ok');
      notify();
    } catch (err) { tell(cancelled(err) ? 'You cancelled in your wallet. Nothing was signed.' : err.message, 'bad'); }
  }

  /** Links a wallet of the other kind to the signed-in account: it signs a link message, like a sign-in. */
  async function link(w) {
    closeMenu();
    try {
      await connect(w);
      const address = w.kind === 'solana' ? state.sol?.address : state.address;
      if (!address) return;
      const ch = await api('POST', '/v1/auth/link/nonce', w.kind === 'solana' ? { kind: 'solana', address } : { kind: 'evm', address, chain_id: await chainId() });
      const out = await api('POST', '/v1/auth/link/verify', { challenge_id: ch.challenge_id, signature: await signChallenge(ch) });
      remember(out, state.kind, state.signedAs);
      toast(`Linked ${short(address)} to your account.`);
      notify();
    } catch (err) { toast(cancelled(err) ? 'You cancelled in your wallet. Nothing was linked.' : err.message); }
  }

  async function unlink(kind) {
    closeMenu();
    try {
      const out = await api('POST', '/v1/auth/unlink', { kind });
      remember(out, state.kind, state.signedAs);
      toast(kind === 'solana' ? 'Solana wallet unlinked.' : 'EVM wallet unlinked.');
      notify();
    } catch (err) { toast(err.message); }
  }

  function signOut() {
    closeMenu();
    forget();
    state.signedAs = null; state.kind = null;
    try { sessionStorage.removeItem('rb_wallet'); sessionStorage.removeItem('rb_kind'); } catch { /* fine */ }
    render();
    toast('Signed out.');
    notify();
  }

  function notify() { for (const f of listeners) Promise.resolve(f()).catch(err => console.error(err)); }

  // Chains a wallet may not have yet: offered to it to add (EIP-3085) when it can't switch to one.
  const ADDABLE = {
    '0x38': { chainId: '0x38', chainName: 'BNB Smart Chain', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, rpcUrls: ['https://bsc-dataseed.bnbchain.org'], blockExplorerUrls: ['https://bscscan.com'] },
  };
  async function switchChain(chainId) {
    chainId = String(chainId).toLowerCase();
    if ((await request('eth_chainId')).toLowerCase() === chainId) return;
    try {
      await request('wallet_switchEthereumChain', [{ chainId }]);
    } catch (err) {
      if (err.code !== 4902 || !ADDABLE[chainId]) throw err;
      await request('wallet_addEthereumChain', [ADDABLE[chainId]]);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btn = $('signin');
    if (btn) btn.addEventListener('click', () => signIn());
    const head = $('hdr-connect');
    if (head) head.addEventListener('click', headerConnect);
    // The phone tab bar: the page you're on, and Account opens the same menu as the header's button.
    const tabs = document.querySelector('.tabbar');
    if (tabs) {
      const here = location.pathname;
      for (const a of tabs.querySelectorAll('a[data-tab]')) if (here === a.dataset.tab || here.startsWith(a.dataset.tab + '/')) a.setAttribute('aria-current', 'page');
      const acct = $('tab-account');
      if (acct && head) acct.addEventListener('click', e => { e.stopPropagation(); window.scrollTo({ top: 0 }); headerConnect(); });
    }
    document.addEventListener('click', e => { const m = $('hdr-menu'); if (m && !m.hidden && !e.target.closest('.bar .acct')) closeMenu(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
    render();
    if (state.token) notify();
    // The header's More menu: kept on screen, closed by a click elsewhere or Escape.
    const more = document.querySelector('.bar .more');
    if (more) {
      more.addEventListener('toggle', () => {
        const menu = more.querySelector('.more-menu');
        menu.classList.remove('left');
        if (more.open && menu.getBoundingClientRect().left < 8) menu.classList.add('left');
      });
      document.addEventListener('click', e => { if (more.open && !more.contains(e.target)) more.open = false; });
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && more.open) { more.open = false; more.querySelector('summary').focus(); } });
    }
  });

  /* What things cost, and what to say when a run needs paying for. */
  const catalog = { products: {}, free_points: null, ready: null };
  catalog.ready = api('GET', '/v1/catalog').then(c => {
    for (const p of c.products) catalog.products[p.id] = p;
    catalog.free_points = c.free_points;
    return catalog;
  }).catch(() => catalog);

  /** " · 1 point or $0.25", " · $3.00 (in Safety Pro's AI allowance)" */
  function priceLabel(p) {
    if (!p) return '';
    if (p.paused) return ' · paused for now';
    if (p.price_cents === 0) return ' · free (signed in)';
    return ` · ${p.points ? `${p.points} point${p.points === 1 ? '' : 's'} or ` : ''}${p.price_usd}${p.in_pro_ai_allowance ? ' (in Safety Pro\'s AI allowance)' : ''}`;
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
    return `${p.title} costs ${credits}.${p.in_pro_ai_allowance ? ` Safety Pro's AI allowance covers it, and resets every 30 days.` : proText} You weren't charged.`;
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

  /* A small Markdown reader for AI-written text (reports, summaries): headings, lists, paragraphs, bold and code.
   * Builds text nodes only; the report's text is never parsed as HTML. */
  function markdown(text) {
    const out = [];
    let list = null;
    const inline = s => {
      const nodes = [];
      const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
      let last = 0, m;
      while ((m = re.exec(s))) {
        if (m.index > last) nodes.push(s.slice(last, m.index));
        nodes.push(m[0].startsWith('**') ? el('strong', {}, m[0].slice(2, -2)) : el('code', {}, m[0].slice(1, -1)));
        last = re.lastIndex;
      }
      if (last < s.length) nodes.push(s.slice(last));
      return nodes;
    };
    for (const raw of String(text).split('\n')) {
      const line = raw.trimEnd();
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
      if (li) {
        if (!list) { list = el(/^\s*\d/.test(line) ? 'ol' : 'ul', {}); out.push(list); }
        list.append(el('li', {}, inline(li[1])));
        continue;
      }
      list = null;
      if (h) out.push(el(h[1].length <= 2 ? 'h3' : 'h4', {}, inline(h[2])));
      else if (line.trim()) out.push(el('p', {}, inline(line)));
    }
    return out;
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
    sendCalls, sleep, markdown, toast,
    state, el, say, api, short, usd, request, switchChain, catalog, priceLabel, paymentMessage, paidLabel,
    onSignedIn: f => listeners.push(f),
    signedIn: () => !!state.token,
    connect, signIn, link, SOL_CHAIN, base58,
  };
})();
