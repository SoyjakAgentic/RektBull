/* Research: the weekly digest (with the facts it was written from), the owner's review of each draft, the newsletter sign-up, and the hack tracker. */
(function () {
  'use strict';
  const { el, say, api, markdown, toast } = window.RB;
  const $ = id => document.getElementById(id);
  const usd = v => {
    if (v === null || v === undefined) return 'not recorded';
    const a = Math.abs(v);
    const [d, s] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, ''];
    return `$${(v / d).toLocaleString(undefined, { maximumFractionDigits: d === 1 ? 0 : 1 })}${s}`;
  };
  const day = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

  /* ── the digest ── */
  async function loadDigests() {
    try {
      const { digests } = await api('GET', '/v1/research/digests');
      if (!digests.length) { say('d-msg', 'No digest yet: the first is published the Monday after launch.'); $('d-pick').closest('label').hidden = true; return; }
      $('d-pick').replaceChildren(...digests.map(d => el('option', { value: d.week_start }, `${day(d.week_start)} to ${day(d.week_end)}`)));
      const wanted = new URLSearchParams(location.search).get('week');
      if (wanted && digests.some(d => d.week_start === wanted)) $('d-pick').value = wanted;
      await showDigest($('d-pick').value);
    } catch (err) { say('d-msg', err.message, 'bad'); }
  }
  $('d-pick').addEventListener('change', () => showDigest($('d-pick').value));

  async function showDigest(week) {
    say('d-msg', 'Loading…');
    try {
      const d = await api('GET', '/v1/research/digests/' + week);
      say('d-msg', '');
      $('d-week').textContent = `${day(d.week_start)} to ${day(d.week_end)}`;
      $('d-byline').textContent = `${d.byline}${d.published_at ? ` · published ${new Date(d.published_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}`;
      $('d-byline').hidden = false;
      $('d-text').replaceChildren(...(d.text ? markdown(d.text) : []));
      $('d-text').hidden = !d.text;
      $('d-facts').replaceChildren(...factList(d));
      $('d-facts-box').hidden = false;
      $('d-facts-box').open = !d.text; // with no write-up, the facts are the digest
      $('d-note').textContent = d.note;
    } catch (err) { say('d-msg', err.message, 'bad'); }
  }

  function factList(d) {
    const sections = [...new Set(d.facts.map(f => f.section))];
    return [...sections.map(s => el('div', { class: 'fact-group' }, el('h4', {}, s),
      el('ul', {}, d.facts.filter(f => f.section === s).map(f => el('li', {}, f.text, ' ', el('span', { class: 'source' }, `[${f.source}]`)))))),
    ...(d.not_checked.length ? [el('p', { class: 'small muted' }, `Not checked that week: ${d.not_checked.map(n => `${n.check} (${n.reason})`).join('; ')}`)] : [])];
  }

  /* ── the owner's review (shown only to an admin) ── */
  let drafts = [];
  async function loadReview() {
    if (!window.RB.signedIn()) return;
    let r;
    try { r = await api('GET', '/v1/admin/research/drafts'); } catch { $('review').hidden = true; return; } // not the owner
    $('review').hidden = false;
    drafts = r.drafts;
    const c = r.newsletter;
    $('r-mail').textContent = r.newsletter_ready
      ? `Publishing emails it to ${c.confirmed} confirmed subscriber${c.confirmed === 1 ? '' : 's'} (${c.pending} not yet confirmed), a batch every 5 minutes.`
      : 'The newsletter is off on this server (RESEND_API_KEY and OPERATOR_POSTAL_ADDRESS are both needed); publishing puts it on the site only.';
    if (!drafts.length) { $('r-body').hidden = true; say('r-msg', 'No draft waiting. The next is drafted on Monday from 06:00 UTC.'); $('r-msg').append(' ', el('button', { type: 'button', class: 'link', onclick: remake }, 'Draft last week now')); return; }
    say('r-msg', '');
    $('r-body').hidden = false;
    $('r-pick').replaceChildren(...drafts.map(d => el('option', { value: d.week_start }, `${day(d.week_start)} to ${day(d.week_end)}`)));
    showDraft();
  }
  const current = () => drafts.find(d => d.week_start === $('r-pick').value);
  function showDraft() {
    const d = current();
    $('r-text').value = d.checked ?? d.draft ?? '';
    preview();
    const removed = d.check_notes.filter(n => n.removed), failed = d.check_notes.filter(n => !n.removed);
    $('r-notes').replaceChildren(
      ...(removed.length ? [el('div', { class: 'notes' }, el('strong', {}, `The fact-check removed ${removed.length} sentence${removed.length === 1 ? '' : 's'}:`), el('ul', {}, removed.map(n => el('li', {}, n.removed))))] : []),
      ...(failed.length ? [el('div', { class: 'notes' }, el('ul', {}, failed.map(n => el('li', {}, n.reason || JSON.stringify(n)))))] : []),
    );
    $('r-facts').replaceChildren(...factList(d));
  }
  function preview() { $('r-preview').replaceChildren(...markdown($('r-text').value || 'No write-up: the facts alone will be published.')); }
  $('r-pick').addEventListener('change', showDraft);
  $('r-text').addEventListener('input', preview);

  async function act(path, body, done) {
    const buttons = [$('r-publish'), $('r-skip'), $('r-remake')];
    buttons.forEach(b => { b.disabled = true; });
    try { await api('POST', path, body); toast(done); await loadReview(); await loadDigests(); } catch (err) { say('r-msg', err.message, 'bad'); } finally { buttons.forEach(b => { b.disabled = false; }); }
  }
  $('r-publish').addEventListener('click', () => {
    const text = $('r-text').value.trim();
    if (!confirm(`Publish the digest for the week of ${day(current().week_start)}${text ? '' : ' (the facts alone)'}? It goes on the site and out by email.`)) return;
    act(`/v1/admin/research/digests/${current().week_start}/publish`, { text: text || null }, 'Published');
  });
  $('r-skip').addEventListener('click', () => { if (confirm('Skip this week? Nothing is published or emailed for it.')) act(`/v1/admin/research/digests/${current().week_start}/skip`, {}, 'Skipped'); });
  function remake() {
    say('r-msg', 'Drafting: gathering the facts, writing and fact-checking (about a minute)…');
    act('/v1/admin/research/digest', drafts.length ? { week_start: current().week_start } : {}, 'Drafted');
  }
  $('r-remake').addEventListener('click', () => { if (confirm('Draft this week again? Your edits here are lost.')) remake(); });
  window.RB.onSignedIn(loadReview);

  /* ── the newsletter ── */
  const OUTCOME = {
    confirmed: ['You\'re subscribed: the digest arrives each week it\'s published.', 'ok'],
    unsubscribed: ['Unsubscribed, and your address is deleted.', 'ok'],
    'bad-link': ['That link isn\'t valid (it may be from an old email). Subscribe again below if you like.', 'bad'],
  };
  const outcome = OUTCOME[new URLSearchParams(location.search).get('newsletter')];
  if (outcome) say('n-msg', ...outcome);
  $('n-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('n-form').querySelector('button');
    btn.disabled = true;
    try { const r = await api('POST', '/v1/newsletter', { email: $('n-email').value }); say('n-msg', r.message, 'ok'); $('n-email').value = ''; } catch (err) { say('n-msg', err.message, 'bad'); } finally { btn.disabled = false; }
  });

  /* ── the hack tracker ── */
  let technique = null;
  async function loadHacks() {
    const days = $('h-days').value;
    say('h-msg', 'Loading…');
    try {
      const r = await api('GET', `/v1/research/hacks?days=${days}${technique ? '&technique=' + encodeURIComponent(technique) : ''}`);
      say('h-msg', technique ? `Showing: ${technique}. ` : '');
      if (technique) $('h-msg').append(el('button', { type: 'button', class: 'link', onclick: () => { technique = null; loadHacks(); } }, 'Show all'));
      $('h-stats').replaceChildren(...r.stats.map(s => el('div', { class: 'tile-stat' },
        el('span', {}, `Last ${s.days === 365 ? 'year' : `${s.days} days`}`), el('strong', {}, usd(s.lost_usd)),
        el('em', {}, `${s.count} hacks${s.unrecorded ? `, ${s.unrecorded} with no amount recorded` : ''}${s.returned_usd ? ` · ${usd(s.returned_usd)} returned` : ''}`))));
      const max = Math.max(...r.techniques.map(t => t.lost_usd), 1);
      $('h-techs').replaceChildren(...r.techniques.map(t => el('button', { type: 'button', class: `bar-row bar-btn${t.technique === technique ? ' on' : ''}`, onclick: () => { technique = t.technique === technique ? null : t.technique; loadHacks(); } },
        el('span', { class: 'bar-label' }, t.technique),
        el('span', { class: 'bar-track' }, el('span', { class: 'bar-fill', style: `width:${Math.max(1, t.lost_usd / max * 100)}%` })),
        el('span', { class: 'bar-value' }, `${usd(t.lost_usd)} · ${t.count}`))));
      $('hacks').tBodies[0].replaceChildren(...(r.hacks.length ? r.hacks.map(h => el('tr', {},
        el('td', { class: 'mono small' }, h.date || '–'),
        el('td', {}, h.source ? el('a', { href: h.source, target: '_blank', rel: 'noopener', class: 'name' }, h.name) : el('span', { class: 'name' }, h.name), el('div', { class: 'sub' }, [h.target, h.bridge ? 'bridge' : null].filter(Boolean).join(' · '))),
        el('td', { class: 'num' }, usd(h.amount_usd)),
        el('td', { class: 'num' }, h.returned_usd ? usd(h.returned_usd) : '–'),
        el('td', { class: 'small' }, h.technique || h.classification || 'Not recorded'),
        el('td', { class: 'small muted' }, h.chains.slice(0, 3).join(', ') + (h.chains.length > 3 ? ` +${h.chains.length - 3}` : ''))))
        : [el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'No hacks recorded in this period.'))]));
      $('h-src').textContent = `Source: ${r.source}. ${r.note}`;
    } catch (err) { say('h-msg', err.message, 'bad'); }
  }
  $('h-days').addEventListener('change', loadHacks);

  loadDigests();
  loadHacks();
  loadReview();
})();
