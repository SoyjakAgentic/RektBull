/* Discover: rankings and tokens, each row with its safety facts and their sources. */
(function () {
  'use strict';
  const { el, say, api } = window.RB;
  const $ = id => document.getElementById(id);
  const usd = v => {
    if (v === null || v === undefined) return '–';
    const a = Math.abs(v);
    const [d, s] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, ''];
    return `$${(v / d).toLocaleString(undefined, { maximumFractionDigits: d === 1 ? (a < 1 ? 6 : 2) : 1 })}${s}`;
  };
  const pct = v => (v === null || v === undefined ? '–' : `${v > 0 ? '+' : ''}${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`);
  const trend = v => el('span', { class: v > 0 ? 'up' : v < 0 ? 'down' : '' }, pct(v));
  const sig = s => el('span', { class: `sig ${s.level}`, title: `Source: ${s.source}` }, s.text);
  /** "Ethereum, Base, Arbitrum +5", or "2 other chains" when none is one RektBull covers. */
  const chainsText = d => {
    const others = d.more_chains;
    if (!d.chains.length) return `${others} other chain${others === 1 ? '' : 's'}`;
    const more = d.chains.length - 3 + others;
    return d.chains.slice(0, 3).join(', ') + (more > 0 ? ` +${more}` : '');
  };
  const ago = iso => {
    const h = (Date.now() - Date.parse(iso)) / 3600000;
    return h < 1 ? 'under an hour' : h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`;
  };

  /* ── the mini ask box: Home's lookup ── */
  $('d-ask').addEventListener('submit', e => {
    e.preventDefault();
    const q = $('d-q').value.trim();
    if (q) location.href = '/?q=' + encodeURIComponent(q);
  });

  /* ── dapps, categories ── */
  async function loadDapps() {
    const chain = $('f-chain').value; const category = $('f-cat').value; const sort = $('f-sort').value;
    say('dapps-msg', 'Loading…');
    const qs = new URLSearchParams({ sort, limit: '50', ...(chain ? { chain } : {}), ...(category ? { category } : {}) });
    try {
      const r = await api('GET', '/v1/discover/dapps?' + qs);
      say('dapps-msg', r.not_checked.length ? `Not checked: ${r.not_checked.map(n => `${n.check} (${n.reason})`).join('; ')}` : '', r.not_checked.length ? 'bad' : null);
      const keep = $('f-cat').value;
      $('f-cat').replaceChildren(el('option', { value: '' }, 'All categories'), ...[...new Set([...(keep ? [keep] : []), ...r.categories])].map(c => el('option', { value: c }, c)));
      $('f-cat').value = keep;
      $('dapps').tBodies[0].replaceChildren(...r.dapps.map((d, i) => el('tr', {},
        el('td', { class: 'n' }, String(i + 1)),
        el('td', {}, (d.links.record ? el('a', { href: d.links.record, class: 'name' }, d.name) : el('a', { href: d.links.defillama, target: '_blank', rel: 'noopener', class: 'name' }, d.name)), el('div', { class: 'sub' }, `${d.category} · ${chainsText(d)}`)),
        el('td', { class: 'num' }, usd(d.tvl_usd)),
        el('td', { class: 'num' }, trend(d.change_7d_pct)),
        el('td', { class: 'num' }, usd(d.fees_24h_usd)),
        el('td', {}, el('div', { class: 'sigs' }, d.signals.map(sig))),
        el('td', {}, d.token ? el('a', { href: d.token.check, class: 'act' }, 'Check its token') : ''))));
      $('dapps-src').textContent = `Sources: ${r.sources.join('; ')}. ${r.note}`;
    } catch (err) { say('dapps-msg', err.message, 'bad'); }
    loadCategories(chain);
  }
  async function loadCategories(chain) {
    try {
      const r = await api('GET', '/v1/discover/categories' + (chain ? '?chain=' + chain : ''));
      $('cats').tBodies[0].replaceChildren(...r.categories.map(c => el('tr', {},
        el('td', {}, el('button', { type: 'button', class: 'link', onclick: () => { $('f-cat').append(el('option', { value: c.category }, c.category)); $('f-cat').value = c.category; loadDapps(); $('dapps-card').scrollIntoView({ block: 'start' }); } }, c.category)),
        el('td', { class: 'num' }, usd(c.tvl_usd)), el('td', { class: 'num' }, trend(c.change_7d_pct)), el('td', { class: 'num' }, String(c.dapps)), el('td', { class: 'small' }, c.top.join(', ')))));
      $('cats-src').textContent = `Source: ${r.source}. ${r.note}`;
    } catch (err) { $('cats-src').textContent = err.message; }
  }
  for (const id of ['f-chain', 'f-cat', 'f-sort']) $(id).addEventListener('change', loadDapps);

  /* ── chains ── */
  async function loadChains() {
    try {
      const r = await api('GET', '/v1/discover/chains');
      $('chains').tBodies[0].replaceChildren(...r.chains.map(c => el('tr', {},
        el('td', {}, el('span', { class: 'name' }, c.name), c.token ? el('span', { class: 'sub' }, ` ${c.token}`) : ''),
        el('td', { class: 'num' }, usd(c.tvl_usd)), el('td', { class: 'num' }, c.dapps === null ? '–' : String(c.dapps)),
        el('td', {}, c.rektbull ? el('button', { type: 'button', class: 'link', onclick: () => { $('f-chain').value = c.rektbull; loadDapps(); $('dapps-card').scrollIntoView({ block: 'start' }); } }, 'Its dapps') : ''))));
      $('chains-src').textContent = `Source: ${r.source}. ${r.note}`;
    } catch (err) { $('chains-src').textContent = err.message; }
  }

  /* ── tokens ── */
  const pick = { list: 'trending', chain: 'base' };
  for (const b of document.querySelectorAll('[data-list], [data-chain]')) {
    b.addEventListener('click', () => {
      const key = b.dataset.list ? 'list' : 'chain';
      pick[key] = b.dataset[key];
      for (const o of b.parentElement.children) o.classList.toggle('on', o === b);
      loadTokens();
    });
  }
  async function loadTokens() {
    say('tokens-msg', 'Loading…');
    $('tokens').replaceChildren();
    try {
      const r = await api('GET', `/v1/discover/tokens?list=${pick.list}&chain=${pick.chain}`);
      say('tokens-msg', r.tokens.length ? '' : 'Nothing listed right now.');
      $('tokens-note').textContent = r.note;
      $('tokens').replaceChildren(...r.tokens.map(token));
      $('tokens-src').textContent = `Source: ${r.source}. Hover a signal to see where it came from.`;
    } catch (err) { say('tokens-msg', err.message, 'bad'); }
  }
  function token(t) {
    const out = el('div', { class: 'flagbox', hidden: true });
    const btn = el('button', { type: 'button', class: 'small-btn', onclick: async () => {
      btn.disabled = true; out.hidden = false; out.textContent = 'Asking GoPlus…';
      try {
        const f = await api('GET', `/v1/discover/flags?chain=${t.chain}&token=${encodeURIComponent(t.token.address)}`);
        out.replaceChildren(...(f.not_checked ? [el('p', { class: 'small muted' }, `Not checked: ${f.not_checked}`)] : [
          el('div', { class: 'sigs' }, f.flags.map(sig)),
          el('p', { class: 'source' }, `Source: ${f.source}. ${f.note}`),
        ]));
      } catch (err) { out.textContent = err.message; btn.disabled = false; }
    } }, 'Free flags');
    return el('div', { class: 'tok' },
      el('div', { class: 'tok-head' },
        el('div', {}, el('strong', {}, t.token.symbol || '?'), el('span', { class: 'sub' }, ` ${t.token.name || ''} · ${t.name}${t.dex ? ` on ${t.dex}` : ''}`)),
        el('div', { class: 'tok-acts' }, btn, el('a', { href: t.check, class: 'btn primary small-btn' }, 'Quick check'))),
      el('div', { class: 'tok-facts' },
        el('span', {}, 'Price ', el('b', {}, usd(t.price_usd))),
        el('span', {}, '24h ', el('b', {}, trend(t.change_24h_pct))),
        el('span', {}, 'Volume ', el('b', {}, usd(t.volume_24h_usd))),
        el('span', {}, 'Liquidity ', el('b', {}, usd(t.liquidity_usd))),
        el('span', {}, 'Pool age ', el('b', {}, t.created_at ? ago(t.created_at) : '–')),
        el('span', {}, 'Buys/sells 24h ', el('b', {}, `${t.buys_24h ?? '–'}/${t.sells_24h ?? '–'}`))),
      t.signals.length ? el('div', { class: 'sigs' }, t.signals.map(sig)) : null,
      out);
  }

  loadDapps();
  loadTokens();
  loadChains();
})();
