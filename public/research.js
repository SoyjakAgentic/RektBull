/* Research: the weekly digest (with the facts it was written from) and the hack tracker. */
(function () {
  'use strict';
  const { el, say, api, markdown } = window.RB;
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
      if (!digests.length) { say('d-msg', 'No digest yet: the first is made on the Monday after launch.'); $('d-pick').closest('label').hidden = true; return; }
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
      $('d-text').replaceChildren(...(d.text ? markdown(d.text) : []));
      $('d-text').hidden = !d.text;
      const sections = [...new Set(d.facts.map(f => f.section))];
      $('d-facts').replaceChildren(...sections.map(s => el('div', { class: 'fact-group' }, el('h4', {}, s),
        el('ul', {}, d.facts.filter(f => f.section === s).map(f => el('li', {}, f.text, ' ', el('span', { class: 'source' }, `[${f.source}]`)))))),
      ...(d.not_checked.length ? [el('p', { class: 'small muted' }, `Not checked that week: ${d.not_checked.map(n => `${n.check} (${n.reason})`).join('; ')}`)] : []));
      $('d-facts-box').hidden = false;
      $('d-facts-box').open = !d.text; // with no write-up, the facts are the digest
      $('d-note').textContent = `${d.note}${d.model ? ` Written by ${d.model}.` : ''}`;
    } catch (err) { say('d-msg', err.message, 'bad'); }
  }

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
})();
