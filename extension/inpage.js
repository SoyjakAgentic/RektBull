/*
 * RektBull, page side (runs in the page's own world, before any page script).
 *
 * It wraps every wallet the page can see (window.ethereum and wallets
 * announced through EIP-6963) so that signing requests are checked by
 * RektBull before the wallet shows them. Everything else passes through
 * untouched. If a check can't run in time, the request goes on to the wallet
 * as it would without RektBull.
 *
 * Messages to and from the extension are signed with a key handed over
 * before any page script runs and kept only in this closure, so a page can't
 * fake RektBull's answer to skip a warning.
 */
(() => {
  'use strict';
  const CHECKED = new Set(['eth_sendTransaction', 'wallet_sendCalls', 'eth_signTypedData_v4', 'eth_signTypedData_v3', 'eth_signTypedData', 'personal_sign', 'eth_sign']);
  const TIMEOUT_MS = 60 * 1000; // the user may be reading a warning
  const enc = new TextEncoder();
  let key = null;
  let keyReady;
  const keyPromise = new Promise(r => { keyReady = r; });
  const pending = new Map();
  const wrapped = new WeakSet();

  // Key handshake with the extension's isolated script (both run at document_start).
  const onKey = async e => {
    if (key || typeof e.detail !== 'string' || !/^[0-9a-f]{64}$/.test(e.detail)) return;
    key = await crypto.subtle.importKey('raw', hexBytes(e.detail), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    document.removeEventListener('rektbull:key', onKey);
    keyReady();
  };
  document.addEventListener('rektbull:key', onKey);
  document.addEventListener('rektbull:hello-isolated', () => document.dispatchEvent(new CustomEvent('rektbull:hello-main')), { once: true });
  document.dispatchEvent(new CustomEvent('rektbull:hello-main'));

  function hexBytes(h) { const b = new Uint8Array(h.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; }
  const toHex = buf => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
  const mac = async body => toHex(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  const verify = async (body, sig) => typeof sig === 'string' && /^[0-9a-f]{64}$/.test(sig) && crypto.subtle.verify('HMAC', key, hexBytes(sig), enc.encode(body));

  window.addEventListener('message', async e => {
    if (e.source !== window || !e.data || e.data.rektbull !== 'decision' || typeof e.data.body !== 'string') return;
    if (!key || !(await verify(e.data.body, e.data.mac))) return; // a page faking an answer is ignored
    let d; try { d = JSON.parse(e.data.body); } catch { return; }
    const p = pending.get(d.id);
    if (p) { pending.delete(d.id); p(d); }
  });

  async function ask(method, params, original) {
    await Promise.race([keyPromise, new Promise(r => setTimeout(r, 1500))]);
    if (!key) return { action: 'allow' };
    let chainId = null, from = null;
    try { chainId = await original({ method: 'eth_chainId' }); } catch { /* unknown */ }
    try { from = (await original({ method: 'eth_accounts' }))?.[0] || null; } catch { /* unknown */ }
    const id = crypto.randomUUID();
    const body = JSON.stringify({ type: 'check', id, method, params: JSON.parse(JSON.stringify(params ?? [])), chain_id: chainId ? Number(chainId) : null, from, origin: location.origin });
    const answer = new Promise(r => { pending.set(id, r); setTimeout(() => { if (pending.delete(id)) r({ action: 'allow' }); }, TIMEOUT_MS); });
    window.postMessage({ rektbull: 'check', body, mac: await mac(body) }, location.origin === 'null' ? '*' : location.origin);
    return answer;
  }

  function guard(original) {
    return async function request(args) {
      if (args && CHECKED.has(args.method)) {
        const d = await ask(args.method, args.params, original);
        if (d.action === 'block') {
          const err = new Error('User rejected the request (stopped by RektBull).');
          err.code = 4001;
          throw err;
        }
      }
      return original(args);
    };
  }

  function wrap(provider) {
    if (!provider || typeof provider !== 'object' || wrapped.has(provider) || typeof provider.request !== 'function') return provider;
    const original = provider.request.bind(provider);
    const request = guard(original);
    try {
      Object.defineProperty(provider, 'request', { value: request, configurable: true, writable: true });
      wrapped.add(provider);
      // Older calling styles, routed through the checked request.
      if (typeof provider.sendAsync === 'function') {
        const sendAsync = provider.sendAsync.bind(provider);
        Object.defineProperty(provider, 'sendAsync', { configurable: true, writable: true, value: (payload, cb) => {
          if (!payload || !CHECKED.has(payload.method)) return sendAsync(payload, cb);
          request({ method: payload.method, params: payload.params }).then(result => cb(null, { id: payload.id, jsonrpc: '2.0', result }), err => cb(err));
        } });
      }
      return provider;
    } catch {
      // A provider that can't be changed: hand out a wrapper instead.
      const proxy = new Proxy(provider, { get: (t, k) => (k === 'request' ? request : Reflect.get(t, k)) });
      wrapped.add(proxy);
      return proxy;
    }
  }

  // window.ethereum, now or whenever a wallet sets it.
  let current = window.ethereum;
  if (current) current = wrap(current);
  try {
    Object.defineProperty(window, 'ethereum', {
      configurable: true, enumerable: true,
      get: () => current,
      set: v => { current = wrap(v); },
    });
  } catch { /* a wallet defined it first and locked it: wrapped below */ }
  for (const ms of [0, 50, 250, 1000, 3000]) setTimeout(() => { if (window.ethereum && !wrapped.has(window.ethereum)) wrap(window.ethereum); }, ms);

  // Wallets announced through EIP-6963 (the provider object itself is wrapped in place).
  window.addEventListener('eip6963:announceProvider', e => { if (e.detail?.provider) wrap(e.detail.provider); }, true);
})();
