/* Markets: the state of DeFi, stablecoin pegs, real-world assets, prediction markets, the largest tokens. */
(function () {
  'use strict';
  const { el, say, api } = window.RB;
  const $ = id => document.getElementById(id);
  const usd = v => {
    if (v === null || v === undefined) return '–';
    const a = Math.abs(v);
    const [d, s] = a >= 1e12 ? [1e12, 'T'] : a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, ''];
    return `$${(v / d).toLocaleString(undefined, { maximumFractionDigits: d === 1 ? (a < 1 ? 4 : 2) : (v / d >= 100 ? 0 : 1) })}${s}`;
  };
  const price = v => (v === null || v === undefined ? '–' : `$${v.toLocaleString(undefined, { maximumFractionDigits: v < 1 ? 4 : 2, minimumFractionDigits: v < 1 ? 4 : 2 })}`);
  const pct = v => (v === null || v === undefined ? '–' : `${v > 0 ? '+' : ''}${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`);
  const trend = v => el('span', { class: v > 0 ? 'up' : v < 0 ? 'down' : '' }, pct(v));
  const sig = s => el('span', { class: `sig ${s.level}`, title: `Source: ${s.source}` }, s.text);
  const day = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

  /* ── overview ── */
  function tile(id, value, sub) {
    $(id).querySelector('strong').textContent = value;
    $(id).querySelector('em').replaceChildren(...sub);
  }
  async function loadOverview() {
    try {
      const o = await api('GET', '/v1/markets/overview');
      if (o.tvl) tile('t-tvl', usd(o.tvl.usd), [trend(o.tvl.change_7d_pct), ' this week · ', trend(o.tvl.change_30d_pct), ' in 30 days']);
      if (o.dex_volume) tile('t-dex', usd(o.dex_volume.usd_24h), [trend(o.dex_volume.change_1d_pct), ' on the day before']);
      if (o.fees) tile('t-fees', usd(o.fees.usd_24h), [trend(o.fees.change_1d_pct), ' on the day before']);
      if (o.stablecoins) tile('t-stables', usd(o.stablecoins.usd), [trend(o.stablecoins.change_7d_pct), ` this week · ${o.stablecoins.count} coins`]);
      say('overview-msg', o.not_checked.length ? `Not checked: ${o.not_checked.map(n => `${n.check} (${n.reason})`).join('; ')}` : '', o.not_checked.length ? 'bad' : null);
      $('overview-src').textContent = `Sources: ${Object.values(o.sources).join('; ')}.`;
      if (o.tvl) chart(o.tvl.history); else $('tvl-chart').hidden = true;
    } catch (err) { say('overview-msg', err.message, 'bad'); $('tvl-chart').hidden = true; }
  }

  /* One series: a 2px line, its last point marked, a crosshair and readout on hover or arrow keys. */
  function chart(points) {
    const plot = $('tvl-plot');
    const W = 1000; const H = 240; const PAD = 8;
    const vals = points.map(p => p.tvl);
    const lo = Math.min(...vals); const hi = Math.max(...vals); const span = hi - lo || 1;
    const x = i => PAD + (i / (points.length - 1)) * (W - 2 * PAD);
    const y = v => PAD + (1 - (v - lo) / span) * (H - 2 * PAD);
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
    const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); svg.append(e); return e; };
    for (const f of [0, 0.5, 1]) mk('line', { x1: 0, x2: W, y1: PAD + f * (H - 2 * PAD), y2: PAD + f * (H - 2 * PAD), class: 'grid' });
    mk('path', { d: points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.tvl).toFixed(1)}`).join(''), class: 'line' });
    const cross = mk('line', { y1: 0, y2: H, class: 'cross', visibility: 'hidden' });
    plot.replaceChildren(svg);
    // The scale runs from the period's low to its high, not from zero: label it, so the swing reads at its true size.
    for (const f of [0, 0.5, 1]) plot.append(el('span', { class: 'ylab', style: `top:${((PAD + f * (H - 2 * PAD)) / H) * 100}%` }, usd(hi - f * span)));
    const end = el('span', { class: 'dot end' }); plot.append(end);
    const dot = el('span', { class: 'dot', hidden: true }); plot.append(dot);
    const tip = el('div', { class: 'tip', hidden: true }); plot.append(tip);
    const place = (e, i) => { e.style.left = `${(x(i) / W) * 100}%`; e.style.top = `${(y(points[i].tvl) / H) * 100}%`; };
    place(end, points.length - 1);
    $('tvl-range').textContent = 'Scale: the 90-day low to high, not from zero';
    $('tvl-from').textContent = day(points[0].date);
    $('tvl-to').textContent = `${day(points[points.length - 1].date)}: ${usd(points[points.length - 1].tvl)}`;
    $('tvl-table').tBodies[0].replaceChildren(...points.slice().reverse().map(p => el('tr', {}, el('td', {}, p.date), el('td', { class: 'num' }, usd(p.tvl)))));
    let at = points.length - 1;
    const show = i => {
      at = Math.max(0, Math.min(points.length - 1, i));
      cross.setAttribute('x1', x(at)); cross.setAttribute('x2', x(at)); cross.setAttribute('visibility', 'visible');
      place(dot, at); dot.hidden = false;
      tip.textContent = `${day(points[at].date)}: ${usd(points[at].tvl)}`;
      tip.style.left = `${Math.min(80, Math.max(0, (x(at) / W) * 100 - 8))}%`; tip.hidden = false;
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); dot.hidden = true; tip.hidden = true; };
    plot.addEventListener('pointermove', e => { const r = plot.getBoundingClientRect(); show(Math.round(((e.clientX - r.left) / r.width * W - PAD) / (W - 2 * PAD) * (points.length - 1))); });
    plot.addEventListener('pointerleave', hide);
    plot.addEventListener('blur', hide);
    plot.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); show(at + (e.key === 'ArrowLeft' ? -1 : 1)); }
    });
    plot.addEventListener('focus', () => show(at));
  }

  /* ── stablecoins ── */
  async function loadStables() {
    try {
      const s = await api('GET', '/v1/markets/stablecoins');
      $('s-facts').replaceChildren(
        el('div', {}, 'All US dollar stablecoins', el('strong', {}, usd(s.total_usd))),
        ...s.by_mechanism.slice(0, 3).map(m => el('div', {}, `Backed by ${m.mechanism.replace('-backed', '')}${m.mechanism === 'algorithmic' ? ' (no reserves)' : ''}`, el('strong', {}, `${usd(m.usd)} · ${m.share_pct}%`))));
      $('stables').tBodies[0].replaceChildren(...s.stablecoins.map((c, i) => el('tr', {},
        el('td', { class: 'n' }, String(i + 1)),
        el('td', {}, el('span', { class: 'name' }, c.symbol), el('div', { class: 'sub' }, `${c.name} · ${c.chains} chain${c.chains === 1 ? '' : 's'}`)),
        el('td', { class: 'small' }, c.mechanism || '–'),
        el('td', { class: 'num' }, price(c.price)),
        el('td', { class: 'num' }, usd(c.supply_usd)),
        el('td', { class: 'num' }, trend(c.change_7d_pct)),
        el('td', {}, el('div', { class: 'sigs' }, c.signals.map(sig))))));
      $('stables-src').textContent = `Source: ${s.source}. ${s.note}`;
    } catch (err) { say('stables-msg', err.message, 'bad'); }
  }

  /* ── sectors: Discover's rankings for one category ── */
  async function loadSector(category, table, msg) {
    try {
      const r = await api('GET', `/v1/discover/dapps?category=${encodeURIComponent(category)}&limit=15`);
      if (!r.dapps.length) say(msg, 'Nothing listed right now.');
      $(table).tBodies[0].replaceChildren(...r.dapps.map((d, i) => el('tr', {},
        el('td', { class: 'n' }, String(i + 1)),
        el('td', {}, el('a', { href: d.links.defillama, target: '_blank', rel: 'noopener', class: 'name' }, d.name), el('div', { class: 'sub' }, d.chains.slice(0, 3).join(', ') || `${d.more_chains} other chains`)),
        el('td', { class: 'num' }, usd(d.tvl_usd)),
        el('td', { class: 'num' }, trend(d.change_7d_pct)),
        el('td', {}, el('div', { class: 'sigs' }, d.signals.map(sig))),
        el('td', {}, d.token ? el('a', { href: d.token.check, class: 'act' }, 'Check its token') : ''))));
    } catch (err) { say(msg, err.message, 'bad'); }
  }

  /* ── tokens ── */
  async function loadTokens() {
    try {
      const r = await api('GET', '/v1/markets/tokens');
      $('tokens').tBodies[0].replaceChildren(...r.tokens.map(t => el('tr', {},
        el('td', { class: 'n' }, String(t.rank ?? '–')),
        el('td', {}, el('a', { href: t.link, target: '_blank', rel: 'noopener', class: 'name' }, t.symbol), el('div', { class: 'sub' }, t.name)),
        el('td', { class: 'num' }, price(t.price_usd)),
        el('td', { class: 'num' }, trend(t.change_24h_pct)),
        el('td', { class: 'num' }, trend(t.change_7d_pct)),
        el('td', { class: 'num' }, usd(t.market_cap_usd)),
        el('td', { class: 'num' }, usd(t.volume_24h_usd)),
        el('td', {}, el('div', { class: 'sigs' }, t.signals.map(sig))))));
      $('tokens-src').replaceChildren(el('a', { href: 'https://www.coingecko.com/', target: '_blank', rel: 'noopener' }, 'Data from CoinGecko'), `. ${r.source.replace('Data from CoinGecko ', '')}. ${r.note}`);
    } catch (err) { say('tokens-msg', err.message, 'bad'); }
  }

  loadOverview();
  loadStables();
  loadSector('RWA', 'rwa', 'rwa-msg');
  loadSector('Prediction Market', 'pm', 'pm-msg');
  loadTokens();
})();
