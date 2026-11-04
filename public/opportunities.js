/* Opportunities: a wallet's own (claim, earn, vote), and the live reward campaigns, each with its facts. */
(function () {
  'use strict';
  const { el, say, api, state } = window.RB;
  const $ = id => document.getElementById(id);
  const usd = v => {
    if (v === null || v === undefined) return '–';
    const a = Math.abs(v);
    const [d, s] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, ''];
    return `$${(v / d).toLocaleString(undefined, { maximumFractionDigits: d === 1 ? 2 : 1 })}${s}`;
  };
  const sig = s => el('span', { class: `sig ${s.level}`, title: `Source: ${s.source}` }, s.text);
  const until = iso => {
    if (!iso) return 'no end date';
    const d = (Date.parse(iso) - Date.now()) / 86400000;
    return d < 1 ? 'today' : d < 60 ? `in ${Math.ceil(d)} day${Math.ceil(d) === 1 ? '' : 's'}` : new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };

  /* ── a wallet's own: Home's checkup, the parts that are opportunities ── */
  const fromLink = new URLSearchParams(location.search).get('wallet');
  if (fromLink && /^0x[0-9a-fA-F]{40}$/.test(fromLink)) $('o-wallet').value = fromLink;
  const fill = () => { if (!$('o-wallet').value && state.address) $('o-wallet').value = state.address; };
  window.RB.onSignedIn(fill);
  setTimeout(fill, 500);

  $('o-form').addEventListener('submit', async e => {
    e.preventDefault();
    const wallet = $('o-wallet').value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return say('o-msg', 'Paste a wallet address (0x and 40 hex characters).', 'bad');
    $('o-go').disabled = true; $('o-guard').hidden = true; $('o-parts').replaceChildren();
    say('o-msg', 'Checking every desk (this can take half a minute)…');
    try {
      const r = await api('POST', '/v1/checkup', { wallet });
      say('o-msg', '');
      const by = Object.fromEntries(r.parts.map(p => [p.id, p]));
      const guard = by.approvals;
      if (guard && guard.ok && guard.status === 'bad') {
        $('o-guard').replaceChildren(el('strong', {}, 'Before you claim anything: '), guard.headline + '. ', el('a', { href: guard.href }, 'See which, and revoke them →'));
        $('o-guard').hidden = false;
      }
      $('o-parts').replaceChildren(...['claims', 'yield', 'governance'].map(id => by[id]).filter(Boolean).map(part));
    } catch (err) { say('o-msg', err.message, 'bad'); } finally { $('o-go').disabled = false; }
  });

  function part(p) {
    const kids = [el('div', { class: 'part-head' }, el('span', { class: 'tag-desk' }, p.desk), el('span', { class: 'part-title' }, p.title)), el('p', { class: 'headline' }, p.headline)];
    if (p.ok) {
      kids.push(el('div', { class: 'facts' }, p.facts.map(f => el('div', {}, f.label, el('strong', {}, f.value)))));
      if (p.not_checked?.length) kids.push(el('details', { class: 'small' }, el('summary', {}, `Couldn't check ${p.not_checked.length} thing${p.not_checked.length === 1 ? '' : 's'}`), el('ul', {}, p.not_checked.map(n => el('li', {}, `${n.check}: ${n.reason}`)))));
      kids.push(el('p', { class: 'source' }, 'Source: ', p.source));
    } else kids.push(el('p', { class: 'small muted' }, p.reason));
    kids.push(el('a', { class: 'go', href: p.href }, p.action + ' →'));
    return el('div', { class: `part ${p.status}`, id: `part-${p.id}` }, kids);
  }

  /* ── live reward campaigns ── */
  async function loadCampaigns() {
    const qs = new URLSearchParams({ sort: $('c-sort').value, limit: '40' });
    if ($('c-chain').value) qs.set('chain', $('c-chain').value);
    if ($('c-action').value) qs.set('action', $('c-action').value);
    say('c-msg', 'Loading…');
    try {
      const r = await api('GET', '/v1/opportunities/campaigns?' + qs);
      say('c-msg', r.campaigns.length ? (r.not_checked.length ? `Not checked: ${r.not_checked.map(n => `${n.check} (${n.reason})`).join('; ')}` : '') : 'No campaigns match.', r.not_checked.length ? 'bad' : null);
      $('campaigns').replaceChildren(...r.campaigns.map(campaign));
      $('c-src').textContent = `Sources: ${r.sources.join('; ')}. ${r.note}`;
    } catch (err) { say('c-msg', err.message, 'bad'); $('campaigns').replaceChildren(); }
  }
  for (const id of ['c-chain', 'c-action', 'c-sort']) $(id).addEventListener('change', loadCampaigns);

  function campaign(c) {
    return el('div', { class: 'tok camp' },
      el('div', { class: 'tok-head' },
        el('div', { class: 'camp-name' }, el('strong', {}, c.name), el('div', { class: 'sub' }, `${c.chain_name} · ${c.action_label}${c.protocol ? ` · ${c.protocol.name}` : ''}`)),
        el('div', { class: 'camp-apr' }, el('strong', {}, `${c.apr_pct.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`), el('span', { class: 'sub' }, 'extra rewards a year'))),
      el('div', { class: 'tok-facts' },
        el('span', {}, 'Money in it ', el('b', {}, usd(c.tvl_usd))),
        el('span', {}, 'Rewards a day ', el('b', {}, usd(c.daily_rewards_usd))),
        el('span', {}, 'Paid in ', el('b', {}, c.rewards.map(r => r.symbol).join(', ') || '–')),
        el('span', {}, 'Ends ', el('b', {}, until(c.ends_at)))),
      c.how.length ? el('p', { class: 'small muted how' }, c.how.join(' ')) : null,
      el('div', { class: 'sigs' }, c.signals.map(sig)),
      el('div', { class: 'tok-acts' },
        c.go ? el('a', { href: c.go, target: '_blank', rel: 'noopener', class: 'btn small-btn' }, `Go to ${c.protocol?.name || 'the protocol'} ↗`) : null,
        ...c.checks.map(k => el('a', { href: k.href, class: 'btn small-btn' }, `Check ${k.symbol}`))));
  }

  loadCampaigns();
})();
