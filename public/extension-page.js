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
    await loadTokens();
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
