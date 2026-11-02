/* RektBull /extension page: link the browser extension to the signed-in account. */
(function () {
  'use strict';
  const { el, say, api } = window.RB;
  const $ = id => document.getElementById(id);
  const installed = () => document.documentElement.dataset.rektbullExtension;

  setTimeout(() => {
    $('ext-state').textContent = installed() ? `The extension is installed (version ${installed()}).` : 'The extension isn\'t installed in this browser yet. Install it from the Chrome Web Store, then come back to link it.';
  }, 600);

  async function loadTokens() {
    const { tokens } = await api('GET', '/v1/extension/tokens');
    $('tokens').replaceChildren(...(tokens.length ? tokens.map(t => el('div', { class: 'watched' },
      el('div', {}, el('strong', {}, t.label || 'Browser'), el('div', { class: 'small muted' }, `Linked ${new Date(t.created_at).toLocaleDateString()}${t.last_used_at ? ` · last check ${new Date(t.last_used_at).toLocaleString()}` : ''}`)),
      el('button', { class: 'link', onclick: async () => { await api('DELETE', `/v1/extension/tokens/${t.jti}`); loadTokens(); } }, 'Unlink'))) : ['No browser is linked yet.']));
  }

  window.RB.onSignedIn(async () => {
    $('link').hidden = false;
    $('snap-link').hidden = false;
    say('snap-msg', '');
    await loadTokens();
  });

  // The MetaMask Snap: install it (MetaMask asks), then hand it a link token. ?snap=local:http://localhost:8081 for development.
  const SNAP_ID = new URLSearchParams(location.search).get('snap') || 'npm:@rektbull/presign-check';
  $('snap-link').addEventListener('click', async () => {
    const mm = (window.RB.state.wallets.find(w => /metamask/i.test(w.info.name)) || {}).provider || (window.ethereum?.isMetaMask ? window.ethereum : null);
    if (!mm) return say('snap-msg', 'MetaMask isn\'t installed in this browser.', 'bad');
    try {
      say('snap-msg', 'MetaMask will ask you to install the RektBull Snap and approve what it may do.');
      await mm.request({ method: 'wallet_requestSnaps', params: { [SNAP_ID]: {} } });
      const { token } = await api('POST', '/v1/extension/tokens', { label: 'MetaMask Snap' });
      const r = await mm.request({ method: 'wallet_invokeSnap', params: { snapId: SNAP_ID, request: { method: 'link', params: { token } } } });
      say('snap-msg', `Linked to ${r.wallet.slice(0, 6)}…${r.wallet.slice(-4)}. MetaMask now shows RektBull's check when you confirm.`, 'ok');
      loadTokens();
    } catch (err) { say('snap-msg', err.message, 'bad'); }
  });

  window.addEventListener('message', e => {
    if (e.source !== window || e.origin !== location.origin || e.data?.rektbull !== 'linked') return;
    say('link-msg', e.data.ok ? 'Linked. The extension now checks requests before your wallet signs them.' : `The extension didn't accept the link: ${e.data.message}`, e.data.ok ? 'ok' : 'bad');
    loadTokens();
  });

  $('link').addEventListener('click', async () => {
    if (!installed()) return say('link-msg', 'Install the extension in this browser first.', 'bad');
    try {
      const ua = navigator.userAgent;
      const label = /Edg\//.test(ua) ? 'Edge' : /Brave/.test(ua) ? 'Brave' : /Chrome\//.test(ua) ? 'Chrome' : 'Browser';
      const { token } = await api('POST', '/v1/extension/tokens', { label });
      window.postMessage({ rektbull: 'link-token', token }, location.origin);
      say('link-msg', 'Linking…');
    } catch (err) { say('link-msg', err.message, 'bad'); }
  });
})();
