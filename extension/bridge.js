/*
 * RektBull, extension side of the page (isolated world).
 *
 * Hands the page-side script its signing key before any page script runs,
 * forwards signed check requests to the background (which asks RektBull),
 * shows the warning, and sends back a signed decision: 'allow' or 'block'.
 * The warning is drawn in a closed shadow root, so the page can't read or
 * restyle it. On rektbull.com it also receives the link token from the
 * /extension page.
 */
(() => {
  'use strict';
  const enc = new TextEncoder();
  const keyHex = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
  const sendKey = () => document.dispatchEvent(new CustomEvent('rektbull:key', { detail: keyHex }));
  document.addEventListener('rektbull:hello-main', sendKey, { once: true });
  document.dispatchEvent(new CustomEvent('rektbull:hello-isolated'));

  const keyPromise = crypto.subtle.importKey('raw', Uint8Array.from(keyHex.match(/../g), h => parseInt(h, 16)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const toHex = buf => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
  const sign = async body => toHex(await crypto.subtle.sign('HMAC', await keyPromise, enc.encode(body)));
  const verify = async (body, sig) => typeof sig === 'string' && /^[0-9a-f]{64}$/.test(sig)
    && crypto.subtle.verify('HMAC', await keyPromise, Uint8Array.from(sig.match(/../g), h => parseInt(h, 16)), enc.encode(body));

  const recent = [];
  const tooMany = () => { const now = Date.now(); while (recent.length && now - recent[0] > 60000) recent.shift(); recent.push(now); return recent.length > 30; };

  window.addEventListener('message', async e => {
    if (e.source !== window || !e.data) return;
    if (e.data.rektbull === 'check' && typeof e.data.body === 'string') {
      if (!(await verify(e.data.body, e.data.mac)) || tooMany()) return; // forged or flooding: ignored
      const req = JSON.parse(e.data.body);
      const decision = await decide(req);
      const body = JSON.stringify({ id: req.id, ...decision });
      window.postMessage({ rektbull: 'decision', body, mac: await sign(body) }, location.origin === 'null' ? '*' : location.origin);
    }
    if (e.data.rektbull === 'link-token' && typeof e.data.token === 'string') {
      const r = await chrome.runtime.sendMessage({ type: 'link', token: e.data.token, origin: location.origin });
      window.postMessage({ rektbull: 'linked', ok: !!r?.ok, message: r?.message || null }, location.origin);
    }
  });

  // On RektBull's own site, say the extension is here (and nowhere else, so other sites can't tell).
  chrome.runtime.sendMessage({ type: 'api-base' }).then(base => {
    if (base && new URL(base).origin === location.origin) document.documentElement.dataset.rektbullExtension = chrome.runtime.getManifest().version;
  }).catch(() => {});

  async function decide(req) {
    let r;
    try {
      r = await chrome.runtime.sendMessage({ type: 'check', request: { method: req.method, params: req.params, chain_id: req.chain_id, from: req.from, origin: req.origin } });
    } catch { r = { status: 'unchecked', reason: 'The RektBull extension restarted; this request wasn\'t checked.' }; }
    if (!r || r.status !== 'checked') {
      if (r?.reason) toast(`RektBull couldn't check this: ${r.reason}`, r.link);
      return { action: 'allow' };
    }
    const result = r.result;
    if (result.verdict === 'critical' || result.verdict === 'high' || (result.verdict === 'medium' && r.warnMedium !== false)) return warn(result);
    toast(result.verdict === 'low' ? 'RektBull: no known risk found.' : result.summary);
    return { action: 'allow' };
  }

  /* ── the warning ── */
  const COLORS = { critical: '#cf222e', high: '#cf222e', medium: '#9a6700', low: '#1a7f37', info: '#5d6673' };
  function el(tag, style, ...children) {
    const e = document.createElement(tag);
    if (style) e.setAttribute('style', style);
    for (const c of children) if (c !== null && c !== undefined) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }

  function host(tag) {
    const h = document.createElement(tag);
    const root = h.attachShadow({ mode: 'closed' });
    (document.body || document.documentElement).append(h);
    return { h, root };
  }

  function warn(result) {
    return new Promise(resolve => {
      const { h, root } = host('rektbull-warning');
      const severe = result.verdict === 'critical';
      const done = action => { h.remove(); resolve({ action }); };
      const cancel = el('button', 'font:inherit;padding:9px 16px;border-radius:8px;border:0;background:#1f6feb;color:#fff;cursor:pointer;font-weight:600', 'Cancel (recommended)');
      cancel.addEventListener('click', () => done('block'));
      const go = el('button', 'font:inherit;padding:9px 16px;border-radius:8px;border:1px solid #dde1e7;background:#fff;color:#15181d;cursor:pointer', 'Continue to my wallet');
      go.addEventListener('click', () => done('allow'));
      let ack = null;
      if (severe) {
        go.disabled = true;
        go.style.opacity = '0.5';
        const box = el('input', null);
        box.type = 'checkbox';
        box.addEventListener('change', () => { go.disabled = !box.checked; go.style.opacity = box.checked ? '1' : '0.5'; });
        ack = el('label', 'display:flex;gap:8px;align-items:center;font-size:13px;margin:10px 0', box, 'I understand I could lose funds, and I still want to see it in my wallet.');
      }
      const findings = result.findings.filter(f => f.severity !== 'info').slice(0, 5).map(f => el('li', 'margin:8px 0',
        el('div', `font-weight:600;color:${COLORS[f.severity] || '#15181d'}`, `${f.severity.toUpperCase()}: ${f.title}`),
        el('div', 'font-size:13px;color:#15181d', f.detail),
        el('div', 'font-size:12px;color:#5d6673', `Source: ${f.source}`)));
      const changes = (result.simulation?.changes || []).map(c => el('li', null, `${c.direction === 'out' ? 'Leaves' : 'Arrives in'} your wallet: ${c.amount ?? c.raw} ${c.symbol || c.token}${c.usd ? ` (about $${c.usd.toLocaleString()})` : ''}`));
      const notChecked = (result.not_checked || []).map(n => el('li', null, `${n.check}: ${n.reason}`));
      const card = el('div', 'max-width:520px;width:calc(100% - 32px);max-height:calc(100% - 32px);overflow:auto;background:#fff;color:#15181d;border-radius:12px;padding:18px 20px;box-shadow:0 10px 40px rgba(0,0,0,.35);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif',
        el('div', 'font-size:13px;color:#5d6673', `RektBull checked this request from ${result.origin || 'this site'}`),
        el('div', `font-size:19px;font-weight:700;margin:6px 0;color:${COLORS[result.verdict]}`, result.summary),
        el('ul', 'padding-left:18px;margin:8px 0', ...findings),
        changes.length ? el('div', 'margin-top:10px', el('div', 'font-weight:600', 'What the simulation shows'), el('ul', 'padding-left:18px;margin:4px 0;font-size:14px', ...changes)) : null,
        notChecked.length ? el('details', 'font-size:12px;color:#5d6673;margin-top:8px', el('summary', null, 'What couldn\'t be checked'), el('ul', 'padding-left:18px', ...notChecked)) : null,
        ack,
        el('div', 'display:flex;gap:10px;flex-wrap:wrap;margin-top:14px', cancel, go),
        el('div', 'font-size:12px;color:#5d6673;margin-top:10px', result.note));
      root.append(el('div', 'position:fixed;inset:0;z-index:2147483647;background:rgba(13,17,23,.55);display:flex;align-items:center;justify-content:center', card));
      cancel.focus();
    });
  }

  function toast(text, link) {
    const { h, root } = host('rektbull-toast');
    const t = el('div', 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;background:#15181d;color:#fff;border-radius:10px;padding:10px 14px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.3)', text);
    if (link) { const a = el('a', 'color:#58a6ff;margin-left:6px', 'Open'); a.href = link; a.target = '_blank'; a.rel = 'noopener'; t.append(a); }
    root.append(t);
    setTimeout(() => h.remove(), 5000);
  }
})();
