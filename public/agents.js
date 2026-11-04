/* Agents: x402 services ranked by real payers, with signals; onchain AI-agent protocols with their record. */
(function () {
  'use strict';
  const { el, say, api } = window.RB;
  const $ = id => document.getElementById(id);
  const usd = v => {
    if (v === null || v === undefined) return '–';
    const a = Math.abs(v);
    const [d, s] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, ''];
    return `$${(v / d).toLocaleString(undefined, { maximumFractionDigits: d === 1 ? (a < 1 ? 4 : 2) : 1 })}${s}`;
  };
  const count = v => v.toLocaleString();
  const pct = v => (v === null || v === undefined ? '–' : `${v > 0 ? '+' : ''}${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`);
  const trend = v => el('span', { class: v > 0 ? 'up' : v < 0 ? 'down' : '' }, pct(v));
  const sig = s => el('span', { class: `sig ${s.level}`, title: `Source: ${s.source}` }, s.text);
  const ago = iso => {
    const h = (Date.now() - Date.parse(iso)) / 3600000;
    return h < 1 ? 'under an hour ago' : h < 48 ? `${Math.round(h)} hours ago` : `${Math.round(h / 24)} days ago`;
  };
  const price = p => (!p ? 'Not in USD' : p.min === p.max ? usd(p.min) : `${usd(p.min)} to ${usd(p.max)}`);
  const short = a => `${a.slice(0, 6)}…${a.slice(-4)}`;

  /* ── x402 services ── */
  let networksShown = false;
  async function loadX402() {
    const network = $('x-net').value; const q = $('x-q').value.trim();
    say('x-msg', 'Loading…');
    const qs = new URLSearchParams({ limit: '40', ...(network ? { network } : {}), ...(q ? { q } : {}) });
    try {
      const r = await api('GET', '/v1/agents/x402?' + qs);
      say('x-msg', r.not_checked.length ? `Not checked: ${r.not_checked.map(n => `${n.check} (${n.reason})`).join('; ')}` : (r.services.length ? '' : 'No service matches.'), r.not_checked.length ? 'bad' : null);
      if (!networksShown) {
        $('x-net').append(...r.networks.filter(n => !n.includes(':')).map(n => el('option', { value: n }, n[0].toUpperCase() + n.slice(1))));
        networksShown = true;
      }
      const flagged = r.services.filter(s => s.signals.some(x => x.level === 'bad')).length;
      const generated = r.services.filter(s => s.signals.some(x => /generated to look busy/.test(x.text))).length;
      $('x-stats').replaceChildren(
        el('div', { class: 'tile-stat' }, el('span', {}, 'Services with real users'), el('strong', {}, count(r.total)), el('em', {}, `${r.services.length} shown, at least 5 payers in 30 days`)),
        el('div', { class: 'tile-stat' }, el('span', {}, 'Listed endpoints'), el('strong', {}, count(r.read.listed || 0)), el('em', {}, `the busiest ${count(r.read.endpoints)} read; most are never called`)),
        el('div', { class: 'tile-stat' }, el('span', {}, 'Signals in this list'), el('strong', {}, String(flagged + generated)), el('em', {}, `${flagged} flagged payment address${flagged === 1 ? '' : 'es'}, ${generated} with usage that looks generated`)));
      $('x-table').tBodies[0].replaceChildren(...r.services.map((s, i) => el('tr', {},
        el('td', { class: 'n' }, String(i + 1)),
        el('td', { class: 'svc' },
          el('span', { class: 'name' }, s.name), el('span', { class: 'sub' }, ` ${s.host}`),
          s.description ? el('div', { class: 'small' }, s.description) : null,
          el('div', { class: 'sub' }, [`${s.endpoints} endpoint${s.endpoints === 1 ? '' : 's'}`, s.tags.length ? s.tags.join(', ') : null, s.last_called_at ? `last called ${ago(s.last_called_at)}` : null].filter(Boolean).join(' · ')),
          s.signals.length ? el('div', { class: 'sigs' }, s.signals.map(sig)) : null,
          s.pay_to.some(p => p.address.startsWith('0x')) ? el('div', { class: 'small' }, 'Paid to: ', ...s.pay_to.filter(p => p.address.startsWith('0x')).slice(0, 2).flatMap((p, j) => [j ? ', ' : '', el('a', { href: `/?q=${p.address}`, class: 'mono' }, short(p.address)), ` (${p.network})`]), el('span', { class: 'muted' }, ' · check it')) : null),
        el('td', { class: 'num' }, price(s.price_usd)),
        el('td', { class: 'num' }, count(s.payers_30d)),
        el('td', { class: 'num' }, count(s.calls_30d)),
        el('td', { class: 'small' }, s.networks.filter(n => !n.includes(':')).join(', ') || s.networks.join(', ')))));
      $('x-src').textContent = `Source: ${r.source}, read ${ago(r.read.at)}. ${r.note}`;
    } catch (err) { say('x-msg', err.message, 'bad'); }
  }
  let typing;
  $('x-net').addEventListener('change', loadX402);
  $('x-q').addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(loadX402, 350); });
  $('x-form').addEventListener('submit', e => { e.preventDefault(); loadX402(); });

  /* ── the AI agent protocols ── */
  async function loadProtocols() {
    say('p-msg', 'Loading…');
    try {
      const r = await api('GET', '/v1/agents/protocols?sort=' + $('p-sort').value);
      say('p-msg', r.not_checked.length ? `Not checked: ${r.not_checked.map(n => `${n.check} (${n.reason})`).join('; ')}` : '', r.not_checked.length ? 'bad' : null);
      $('p-table').tBodies[0].replaceChildren(...r.protocols.map((d, i) => el('tr', {},
        el('td', { class: 'n' }, String(i + 1)),
        el('td', {}, el('a', { href: d.links.defillama, target: '_blank', rel: 'noopener', class: 'name' }, d.name), el('div', { class: 'sub' }, [d.chains.slice(0, 3).join(', '), d.listed_since ? `listed ${d.listed_since}` : null].filter(Boolean).join(' · '))),
        el('td', { class: 'num' }, usd(d.tvl_usd)),
        el('td', { class: 'num' }, trend(d.change_7d_pct)),
        el('td', { class: 'num' }, usd(d.fees_24h_usd)),
        el('td', {}, el('div', { class: 'sigs' }, d.signals.map(sig))),
        el('td', {}, d.token ? el('a', { href: d.token.check, class: 'act' }, 'Check its token') : ''))));
      $('p-src').textContent = `Sources: ${r.sources.join('; ')}. ${r.note}`;
    } catch (err) { say('p-msg', err.message, 'bad'); }
  }
  $('p-sort').addEventListener('change', loadProtocols);

  loadX402();
  loadProtocols();
})();
