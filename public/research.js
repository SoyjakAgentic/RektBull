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
      $('d-permalink').querySelector('a').href = `/research/${d.week_start}`;
      $('d-permalink').hidden = false;
      $('d-text').replaceChildren(...(d.text ? markdown(d.text) : []));
      for (const where of ['top', 'bottom']) $(`d-sp-${where}`).replaceChildren(...(d.sponsored || []).filter(s => s.placement === where).map(adBox));
      $('d-text').hidden = !d.text;
      $('d-facts').replaceChildren(...factList(d));
      $('d-facts-box').hidden = false;
      $('d-facts-box').open = !d.text; // with no write-up, the facts are the digest
      $('d-note').textContent = d.note;
    } catch (err) { say('d-msg', err.message, 'bad'); }
  }

  /** A sponsored post: set apart, labelled with who paid, the site named, the link marked sponsored. */
  function adBox(s) {
    const link = text => el('a', { href: s.url, target: '_blank', rel: 'sponsored noopener' }, text);
    return el('aside', { class: 'sponsored', 'aria-label': 'Sponsored' },
      el('p', { class: 'sp-label' }, `${s.label} · ${s.sponsor}`),
      el('p', { class: 'sp-head' }, link(s.headline)),
      el('p', {}, s.body),
      el('p', { class: 'sp-foot' }, link(s.site), ` · ${s.disclosure}`));
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
    loadSponsoredReport();
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
    showSponsored(d);
  }
  function preview() {
    $('r-preview').replaceChildren(...markdown($('r-text').value || 'No write-up: the facts alone will be published.'));
    const d = current();
    for (const where of ['top', 'bottom']) $(`r-preview-${where}`).replaceChildren(...(d?.sponsored || []).filter(s => s.placement === where).map(adBox));
  }

  /* sponsored posts in the draft: one form per place */
  const SP_FIELDS = [['sponsor', 'Sponsor (who paid; shown in the label)', 60], ['headline', 'Headline', 90], ['url', 'Link (https://)', 500]];
  function showSponsored(d) {
    $('r-sp-count').textContent = d.sponsored.length ? d.sponsored.map(s => `${s.placement}: ${s.sponsor}`).join(', ') : 'none';
    $('r-sp-forms').replaceChildren(...['top', 'bottom'].map(where => {
      const s = d.sponsored.find(x => x.placement === where);
      const id = k => `sp-${where}-${k}`;
      const msg = el('p', { class: 'msg', id: id('msg') });
      const form = el('form', { 'data-placement': where },
        el('h4', {}, where === 'top' ? 'Above the digest' : 'Below the digest'),
        ...SP_FIELDS.map(([k, label, max]) => el('label', {}, label, el('input', { id: id(k), name: k, maxlength: max, required: true, type: k === 'url' ? 'url' : 'text', value: k === 'url' ? s?.target : s?.[k] }))),
        el('label', {}, `Text (plain, up to 400 characters)`, el('textarea', { id: id('body'), name: 'body', rows: 3, maxlength: 400, required: true }, s?.body || '')),
        el('label', { class: 'check' }, el('input', { type: 'checkbox', id: id('ok'), required: true, checked: !!s }), 'It isn\'t a promotion to buy, sell or invest in a cryptoasset (token, presale, staking or yield product).'),
        s ? el('p', { class: 'source' }, `Link checked: ${s.link_check.phishing ? 'listed' : 'not listed'} on the ${s.link_check.source}, ${new Date(s.link_check.checked_at).toLocaleString()}.`) : null,
        el('div', { class: 'actions' },
          el('button', { type: 'submit' }, s ? 'Save changes' : 'Add'),
          s ? el('button', { type: 'button', onclick: () => removeSponsored(where) }, 'Remove') : null),
        msg);
      form.addEventListener('submit', e => { e.preventDefault(); saveSponsored(where, form); });
      return form;
    }));
  }
  async function saveSponsored(where, form) {
    const f = new FormData(form);
    const week = current().week_start;
    say(`sp-${where}-msg`, 'Checking the link and saving…');
    try {
      await api('POST', `/v1/admin/research/digests/${week}/sponsored`, { placement: where, sponsor: f.get('sponsor'), headline: f.get('headline'), body: f.get('body'), url: f.get('url'), not_investment: $(`sp-${where}-ok`).checked });
      await reloadDraft(week);
      toast('Sponsored post saved');
    } catch (err) { say(`sp-${where}-msg`, err.message, 'bad'); }
  }
  async function removeSponsored(where) {
    const week = current().week_start;
    if (!confirm('Remove this sponsored post?')) return;
    try { await api('DELETE', `/v1/admin/research/digests/${week}/sponsored/${where}`); await reloadDraft(week); toast('Removed'); } catch (err) { say(`sp-${where}-msg`, err.message, 'bad'); }
  }
  /** Refreshes one draft's sponsored posts without losing edits in the text box. */
  async function reloadDraft(week) {
    const { drafts: fresh } = await api('GET', '/v1/admin/research/drafts');
    const d = fresh.find(x => x.week_start === week);
    const i = drafts.findIndex(x => x.week_start === week);
    if (d && i >= 0) drafts[i] = { ...drafts[i], sponsored: d.sponsored };
    showSponsored(drafts[i]);
    preview();
    loadSponsoredReport();
  }
  async function loadSponsoredReport() {
    try {
      const { sponsored } = await api('GET', '/v1/admin/research/sponsored');
      $('r-sp-report').hidden = !sponsored.length;
      $('r-sp-report').querySelector('tbody').replaceChildren(...sponsored.map(s => el('tr', {},
        el('td', { class: 'mono small' }, s.week_start, s.status === 'published' ? '' : el('div', { class: 'sub' }, s.status)),
        el('td', {}, el('span', { class: 'name' }, s.sponsor), el('div', { class: 'sub' }, `${s.headline} · ${s.site}`)),
        el('td', { class: 'small' }, s.placement === 'top' ? 'Above' : 'Below'),
        el('td', { class: 'num' }, s.status === 'published' ? String(s.emailed_to) : '–'),
        el('td', { class: 'num' }, String(s.clicks)))));
    } catch { /* the report is extra; the review works without it */ }
  }
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
  $('r-skip').addEventListener('click', () => { if (confirm(`Skip this week? Nothing is published or emailed for it${current().sponsored.length ? ', including its sponsored posts' : ''}.`)) act(`/v1/admin/research/digests/${current().week_start}/skip`, {}, 'Skipped'); });
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
