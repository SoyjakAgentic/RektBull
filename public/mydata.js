/* RektBull Safety page: download or delete your data (see /privacy). */
(function () {
  'use strict';
  const { say, api, state } = window.RB;
  const $ = id => document.getElementById(id);
  window.RB.onSignedIn(() => { $('data-card').hidden = false; });

  $('d-export').addEventListener('click', async () => {
    try {
      const res = await fetch('/v1/me/export', { headers: { authorization: 'Bearer ' + state.token } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || res.statusText);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = 'rektbull-my-data.json';
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      say('d-msg', 'Downloaded.', 'ok');
    } catch (err) { say('d-msg', err.message, 'bad'); }
  });

  $('d-delete').addEventListener('click', async () => {
    try {
      const r = await api('POST', '/v1/me/delete', { confirm: $('d-confirm').value.trim() });
      const n = Object.values(r.removed).reduce((a, b) => a + b, 0);
      say('d-msg', `Deleted (${n} item${n === 1 ? '' : 's'}). ${r.kept}`, 'ok');
      $('d-confirm').value = '';
      document.dispatchEvent(new Event('rb:account-changed'));
    } catch (err) { say('d-msg', err.message, 'bad'); }
  });
})();
