/* One token's page: price and candles, live trades, holders, the creator, its launchpad and warning signs, each with its source. */
(function () {
  'use strict';
  const { el, say, api } = window.RB;
  const $ = id => document.getElementById(id);
  const NAMES = { base: 'Base', ethereum: 'Ethereum', arbitrum: 'Arbitrum', bsc: 'BNB Chain' };
  const EXPLORERS = { base: 'https://basescan.org', ethereum: 'https://etherscan.io', arbitrum: 'https://arbiscan.io', bsc: 'https://bscscan.com' };
  const BUYS = [25, 50, 100];
  const short = a => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const money = v => (v === null || v === undefined ? '–' : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(2)}`);
  // Meme coins cost fractions of a cent: four significant figures, without exponent notation.
  const price = v => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v <= 0 ? '$0' : v >= 1 ? `$${v.toLocaleString(undefined, { maximumFractionDigits: 4 })}` : `$${v.toFixed(Math.min(18, Math.max(2, 3 - Math.floor(Math.log10(v)))))}`);
  const amount = v => (v === null || v === undefined ? '–' : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toPrecision(3));
  const ago = iso => {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    return s < 60 ? `${Math.round(s)} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
  };
  const tradeLink = (q) => `/trade?${new URLSearchParams(q)}#trade-card`;

  const q = new URLSearchParams(location.search);
  const chain = String(q.get('chain') || '').toLowerCase();
  const token = String(q.get('token') || '').toLowerCase();
  if (!NAMES[chain] || !/^0x[0-9a-f]{40}$/.test(token)) {
    $('find-card').hidden = false;
    if (NAMES[chain]) $('tp-chain').value = chain;
  }
  $('tp-form').addEventListener('submit', e => {
    e.preventDefault();
    const t = $('tp-token').value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(t)) return say('tp-msg', 'Paste the token\'s contract address (0x…).', 'bad');
    location.href = `/token?chain=${$('tp-chain').value}&token=${t.toLowerCase()}`;
  });
  if ($('find-card').hidden === false) return;

  const base = `/v1/tokens/${chain}/${token}`;

  async function load() {
    say('tp-msg', 'Reading its market, holders and flags…');
    try {
      const p = await api('GET', `${base}/page`);
      say('tp-msg', '');
      $('tp-body').hidden = false;
      const name = p.symbol || 'This token';
      document.title = `${name} on ${p.chain_name}: chart, trades, holders | RektBull`;
      $('tp-title').textContent = `${name} on ${p.chain_name}`;
      $('tp-sub').replaceChildren(
        p.name ? `${p.name} · ` : '',
        el('code', {}, token), ' ',
        el('a', { href: `${EXPLORERS[chain]}/token/${token}`, rel: 'noopener', target: '_blank' }, 'explorer'),
        p.pool ? ` · traded most on ${p.pool.dex}${p.pool.quote ? ` against ${p.pool.quote}` : ''}` : '');
      showMarket(p);
      showActions(p);
      showPad(p);
      showHolders(p);
      showSigns(p);
      $('tp-note').textContent = p.note;
    } catch (err) { say('tp-msg', err.message, 'bad'); }
  }

  function showMarket(p) {
    const m = p.market;
    if (m.not_checked) { $('tp-tiles').replaceChildren(el('p', { class: 'msg bad' }, `Market data not checked: ${m.not_checked}`)); return; }
    const tile = (label, value, sub) => el('div', { class: 'tile-stat' }, el('span', {}, label), el('strong', {}, value), sub ? el('em', {}, sub) : '');
    const ch = m.change_24h_pct;
    $('tp-tiles').replaceChildren(
      tile('Price', price(m.price_usd), ch === null ? '' : `${ch > 0 ? '+' : ''}${ch.toFixed(1)}% in 24 h`),
      tile('Liquidity', money(m.liquidity_usd), `${m.pairs} pool${m.pairs === 1 ? '' : 's'}`),
      tile('Volume, 24 h', money(m.volume_24h_usd)),
      tile('Market cap', money(m.market_cap_usd), m.age_hours === null ? '' : `first pool ${m.age_hours < 48 ? `${Math.round(m.age_hours)} h` : `${Math.round(m.age_hours / 24)} days`} ago`));
  }

  function showActions(p) {
    $('tp-buys').replaceChildren(...BUYS.map(usd => el('a', { class: 'btn primary', href: tradeLink({ chain, token, side: 'buy', amount: usd }) }, `Buy $${usd}`)));
    $('tp-more').replaceChildren(
      el('a', { class: 'btn', href: tradeLink({ chain, token, side: 'buy' }) }, 'Another amount'),
      el('a', { class: 'btn', href: tradeLink({ chain, token, side: 'sell' }) }, 'Sell'),
      el('a', { class: 'btn', href: `/safety?chain=${chain}&token=${token}#check-card` }, 'Full token check'));
    if (p.launchpad?.curve && p.launchpad.id === 'fourmeme' && p.launchpad.state === 'curve') {
      $('tp-more').append(el('span', { class: 'small muted' }, ' On four.meme\'s curve: pay with BNB, USDT or USDC.'));
    }
  }

  function showPad(p) {
    const pad = p.launchpad;
    if (!pad) return;
    $('pad-card').hidden = false;
    if (pad.not_checked) { $('tp-pad').replaceChildren(el('p', { class: 'msg' }, `Not checked: ${pad.not_checked}`)); return; }
    const out = [el('p', {}, el('strong', {}, pad.name), pad.state === 'curve' ? ': still on its bonding curve, bought and sold on the launchpad\'s own contract.' : pad.state === 'graduated' ? ': graduated from its bonding curve.' : '.')];
    if (pad.curve) {
      const c = pad.curve;
      out.push(el('div', { class: 'bar-row grad' },
        el('span', {}, 'To graduating'),
        el('span', { class: 'bar-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(c.progress_pct), 'aria-label': 'How far the curve is towards graduating' }, el('span', { class: 'bar-fill', style: `width:${Math.max(1, Math.min(100, c.progress_pct))}%` })),
        el('span', { class: 'bar-value' }, `${c.progress_pct}%`)));
      // Virtuals graduates when only so many tokens are left in the curve; four.meme when it has raised so much.
      const grad = !c.graduates_at ? '' : pad.id === 'virtuals' ? `; it graduates when ${amount(c.graduates_at)} tokens are left in it` : `; it graduates at ${amount(c.graduates_at)} ${c.symbol} raised`;
      out.push(el('p', { class: 'small muted' }, `${amount(c.in_curve)} ${c.symbol} in the curve${grad}. The launchpad charges ${c.buy_tax_pct}% to buy and ${c.sell_tax_pct}% to sell.`));
    }
    if (pad.agent_token) out.push(el('p', {}, `It now trades as `, el('a', { href: `/token?chain=${chain}&token=${pad.agent_token}` }, el('code', {}, short(pad.agent_token))), '.'));
    for (const f of pad.facts || []) out.push(el('p', { class: 'small' }, f));
    out.push(el('p', {}, el('a', { href: pad.link, rel: 'noopener', target: '_blank' }, `Its page on ${pad.name}`), el('span', { class: 'source' }, ` (${pad.source})`)));
    $('tp-pad').replaceChildren(...out);
  }

  const KIND = { pool: 'Its main pool', locked: 'Locked', burn: 'Burned (no one can sell it)', creator: 'The creator', contract: 'A contract', wallet: 'A wallet' };
  function showHolders(p) {
    const c = p.creator;
    $('tp-creator').replaceChildren(c.address
      ? el('span', {}, el('strong', {}, 'The creator '), el('a', { href: `${EXPLORERS[chain]}/address/${c.address}`, rel: 'noopener', target: '_blank' }, el('code', {}, short(c.address))),
        c.holds_pct === null ? ` — what it holds now couldn't be read: ${c.not_checked || 'no answer'}` : ` holds ${c.holds_pct}% of the supply now.`, ' ', el('span', { class: 'source' }, `(${c.source})`))
      : el('span', { class: 'muted' }, `The creator: not checked (${c.not_checked}).`));
    const h = p.holders;
    if (h.not_checked) {
      $('tp-holders-sum').textContent = `Holders not checked: ${h.not_checked}`;
      $('tp-holders').hidden = true;
      return;
    }
    $('tp-holders-sum').textContent = [h.count !== null ? `${h.count.toLocaleString()} holders.` : '', h.top10_people_pct !== null ? `The top 10 wallets that can sell (not pools, lockers or burn addresses) hold ${h.top10_people_pct}%.` : ''].join(' ');
    $('tp-holders').tBodies[0].replaceChildren(...h.top.map(x => el('tr', {},
      el('td', {}, el('a', { href: `${EXPLORERS[chain]}/address/${x.address}`, rel: 'noopener', target: '_blank' }, el('code', {}, short(x.address)))),
      el('td', { class: x.kind === 'creator' ? 'warn' : '' }, KIND[x.kind], x.tag ? el('span', { class: 'small muted' }, ` · ${x.tag}`) : ''),
      el('td', { class: 'num' }, x.pct === null ? '–' : `${x.pct}%`))));
    $('tp-holders-src').textContent = `Source: ${h.source}.${p.launchpad?.curve ? ' On a bonding curve, most of the supply sits in the curve itself until it\'s bought.' : ''}`;
  }

  function showSigns(p) {
    const f = p.flags;
    $('tp-flags').replaceChildren(...(f.not_checked
      ? [el('li', { class: 'muted' }, `GoPlus's flags not checked: ${f.not_checked}`)]
      : f.flags.map(s => el('li', { class: s.level === 'bad' ? 'bad' : s.level === 'warn' ? 'warn' : 'muted' }, s.text, ' ', el('span', { class: 'source' }, `(${s.source})`)))));
    const links = p.links.list;
    $('tp-links').replaceChildren(...(links.length ? links.map(l => el('li', {},
      l.phishing ? el('span', { class: 'bad' }, `${l.label}: ${l.host} — on GoPlus's phishing list, so not linked. Don't open it.`)
        : el('span', {}, `${l.label}: `, el('a', { href: l.url, rel: 'noopener nofollow ugc', target: '_blank' }, l.host),
          l.checked ? el('span', { class: 'small muted' }, ' · not on GoPlus\'s phishing list') : el('span', { class: 'small warn' }, ` · ${l.not_checked}`))))
      : [el('li', { class: 'muted' }, 'The project gave no links.')]));
    $('tp-links-src').textContent = links.length ? `Source: ${p.links.source}. ${p.links.note}` : '';
  }

  /* Candles: drawn here from GeckoTerminal's figures; no third-party frame or script. */
  let size = '1h';
  for (const b of document.querySelectorAll('[data-size]')) {
    b.addEventListener('click', () => {
      size = b.dataset.size;
      for (const x of document.querySelectorAll('[data-size]')) x.setAttribute('aria-pressed', String(x === b));
      loadCandles();
      live();
    });
  }
  // Short candles go stale fast: 1-minute ones are redrawn every 30 seconds and 5-minute ones every minute, while the page is in view.
  const REDRAW = { '1m': 30000, '5m': 60000 };
  async function loadCandles({ quiet = false } = {}) {
    if (!quiet) say('tp-chart-msg', 'Reading its price history…');
    try {
      const c = await api('GET', `${base}/candles?size=${size}`);
      $('tp-chart-src').textContent = `Source: ${c.source}.`;
      if (c.not_checked || c.candles.length < 2) {
        $('tp-plot').replaceChildren();
        $('tp-from').textContent = ''; $('tp-to').textContent = ''; $('tp-range').textContent = '';
        return say('tp-chart-msg', c.not_checked ? `No chart: ${c.not_checked}` : 'Not enough trading yet to draw a chart.');
      }
      say('tp-chart-msg', '');
      draw(c.candles);
    } catch (err) { say('tp-chart-msg', err.message, 'bad'); }
  }
  const when = s => new Date(s * 1000).toLocaleString(undefined, size === '1d' ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  function draw(rows) {
    const plot = $('tp-plot');
    const W = 1000; const H = 260; const PAD = 10;
    const lo = Math.min(...rows.map(r => r[3])); const hi = Math.max(...rows.map(r => r[2])); const span = hi - lo || hi || 1;
    const step = (W - 2 * PAD) / rows.length;
    const x = i => PAD + (i + 0.5) * step;
    const y = v => PAD + (1 - (v - lo) / span) * (H - 2 * PAD);
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
    const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); svg.append(e); return e; };
    for (const f of [0, 0.5, 1]) mk('line', { x1: 0, x2: W, y1: PAD + f * (H - 2 * PAD), y2: PAD + f * (H - 2 * PAD), class: 'grid' });
    const body = Math.max(1, step * 0.6);
    rows.forEach(([, o, h, l, c], i) => {
      const cls = c >= o ? 'up' : 'down';
      mk('line', { x1: x(i), x2: x(i), y1: y(h), y2: y(l), class: `wick ${cls}` });
      const top = y(Math.max(o, c)); const bottom = y(Math.min(o, c));
      mk('rect', { x: x(i) - body / 2, y: top, width: body, height: Math.max(1, bottom - top), class: `body ${cls}` });
    });
    const cross = mk('line', { y1: 0, y2: H, class: 'cross', visibility: 'hidden' });
    plot.replaceChildren(svg);
    for (const f of [0, 0.5, 1]) plot.append(el('span', { class: 'ylab', style: `top:${((PAD + f * (H - 2 * PAD)) / H) * 100}%` }, price(hi - f * span)));
    const tip = el('div', { class: 'tip', hidden: true }); plot.append(tip);
    $('tp-from').textContent = when(rows[0][0]);
    $('tp-to').textContent = `${when(rows[rows.length - 1][0])}: ${price(rows[rows.length - 1][4])}`;
    $('tp-range').textContent = 'Scale: the period\'s low to high, not from zero';
    let at = rows.length - 1;
    const show = i => {
      at = Math.max(0, Math.min(rows.length - 1, i));
      const [t, o, h, l, c, v] = rows[at];
      cross.setAttribute('x1', x(at)); cross.setAttribute('x2', x(at)); cross.setAttribute('visibility', 'visible');
      tip.textContent = `${when(t)} · open ${price(o)} · high ${price(h)} · low ${price(l)} · close ${price(c)} · ${money(v)} traded`;
      tip.style.left = `${Math.min(55, Math.max(0, (x(at) / W) * 100 - 20))}%`; tip.hidden = false;
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; };
    plot.onpointermove = e => { const r = plot.getBoundingClientRect(); show(Math.floor(((e.clientX - r.left) / r.width * W - PAD) / step)); };
    plot.onpointerleave = hide;
    plot.onblur = hide;
    plot.onkeydown = e => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); show(at + (e.key === 'ArrowLeft' ? -1 : 1)); }
    };
    plot.setAttribute('aria-label', `The token's price from ${when(rows[0][0])} to ${when(rows[rows.length - 1][0])}: from ${price(rows[0][1])} to ${price(rows[rows.length - 1][4])}, between ${price(lo)} and ${price(hi)}. Arrow keys step through the candles.`);
  }

  /* Live trades: every 15 seconds while the page is in view (and short candles, as above). */
  let timer = null;
  let chartTimer = null;
  async function loadTrades() {
    try {
      const t = await api('GET', `${base}/trades`);
      $('tp-trades-src').textContent = `Source: ${t.source}.`;
      if (t.not_checked) { say('tp-trades-msg', `Not checked: ${t.not_checked}`); return; }
      say('tp-trades-msg', t.trades.length ? '' : 'No trades in its main pool in the last day.');
      $('tp-trades').tBodies[0].replaceChildren(...t.trades.map(x => el('tr', {},
        el('td', {}, x.tx ? el('a', { href: `${EXPLORERS[chain]}/tx/${x.tx}`, rel: 'noopener', target: '_blank' }, ago(x.at)) : ago(x.at)),
        el('td', { class: x.side === 'buy' ? 'ok' : 'bad' }, x.side === 'buy' ? 'Buy' : 'Sell'),
        el('td', { class: 'num' }, amount(x.tokens)),
        el('td', { class: 'num' }, money(x.usd)),
        el('td', { class: 'num' }, price(x.price_usd)),
        el('td', {}, x.wallet ? el('a', { href: `${EXPLORERS[chain]}/address/${x.wallet}`, rel: 'noopener', target: '_blank' }, el('code', {}, short(x.wallet))) : '–'))));
      $('tp-trades-live').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (err) { say('tp-trades-msg', err.message, 'bad'); }
  }
  function live() {
    clearInterval(timer);
    clearInterval(chartTimer);
    if (document.visibilityState !== 'visible') return;
    loadTrades(); timer = setInterval(loadTrades, 15000);
    if (REDRAW[size]) chartTimer = setInterval(() => loadCandles({ quiet: true }), REDRAW[size]);
  }
  document.addEventListener('visibilitychange', live);

  load();
  loadCandles();
  live();
})();
