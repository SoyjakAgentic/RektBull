/* Launches: the newest tokens with their warning signs, one token's card, and a buy that goes through the Trade desk's checks. */
(function () {
  'use strict';
  const { el, say, api } = window.RB;
  const $ = id => document.getElementById(id);
  const money = v => (v === null || v === undefined ? '–' : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${Math.round(v)}`);
  const age = iso => {
    if (!iso) return '–';
    const h = (Date.now() - Date.parse(iso)) / 3600000;
    return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`;
  };
  const sign = s => el('li', { class: s.level === 'bad' ? 'bad' : s.level === 'warn' ? 'warn' : 'muted' }, s.text, ' ', el('span', { class: 'source' }, `(${s.source})`));
  const tradeLink = (chain, token, side) => `/trade?chain=${chain}&token=${token}&side=${side}#trade-card`;
  const tokenLink = (chain, token) => `/token?chain=${chain}&token=${token}`; // the token page: chart, live trades, holders
  const CHAINS = ['base', 'ethereum', 'arbitrum', 'bsc'];
  const PAD_CHAINS = ['base', 'bsc']; // chains whose launchpads RektBull reads
  const NAMES = { base: 'Base', ethereum: 'Ethereum', arbitrum: 'Arbitrum', bsc: 'BNB Chain' };
  const owns = name => (/s$/.test(name) ? `${name}'` : `${name}'s`); // Virtuals' contract, four.meme's contract
  // Only the latest request for a list draws it: switching network quickly never shows an older answer.
  const latest = {};
  const fresh = key => { const n = (latest[key] || 0) + 1; latest[key] = n; return () => latest[key] === n; };

  async function loadFeed() {
    const chain = $('l-chain').value;
    const current = fresh('feed');
    say('l-msg', 'Reading the newest pools…');
    try {
      const f = await api('GET', `/v1/launches?chain=${chain}`);
      if (!current()) return;
      say('l-msg', f.tokens.length ? '' : 'No new pools on this network just now.');
      $('l-table').querySelector('tbody').replaceChildren(...f.tokens.map(t => {
        const signs = [...(t.signals || []), ...((t.flags && t.flags.flags) || []).filter(x => x.level !== 'ok')];
        return el('tr', {},
          el('td', {}, el('strong', {}, t.symbol || '?'), ' ', el('span', { class: 'small muted' }, t.name || ''), el('div', { class: 'sub' }, `${t.exchange || ''}${t.quote ? ` · against ${t.quote}` : ''} · `, el('code', {}, `${t.token.slice(0, 6)}…${t.token.slice(-4)}`))),
          el('td', {}, t.launchpad ? el('a', { href: t.launchpad.link, rel: 'noopener', target: '_blank' }, t.launchpad.name) : el('span', { class: 'small muted' }, PAD_CHAINS.includes(chain) ? 'none found' : '–')),
          el('td', { class: 'num' }, age(t.created_at)),
          el('td', { class: 'num' }, money(t.liquidity_usd)),
          el('td', { class: 'num' }, money(t.volume_24h_usd)),
          el('td', {}, signs.length ? el('ul', { class: 'signals' }, signs.slice(0, 4).map(sign)) : el('span', { class: 'small muted' }, t.flags ? 'None of GoPlus\'s red flags; market data shows no warning sign' : 'No warning sign in its market data')),
          el('td', {}, el('a', { class: 'btn', href: tokenLink(chain, t.token) }, 'Look closer')));
      }));
      $('l-src').textContent = `Sources: ${f.sources.join('; ')}. ${f.note}`;
    } catch (err) { if (current()) say('l-msg', err.message, 'bad'); }
  }

  async function show(chain, token) {
    $('t-chain').value = chain; $('t-token').value = token;
    $('token-card').scrollIntoView({ block: 'start' });
    say('t-msg', 'Reading its market and flags…');
    try {
      const c = await api('GET', `/v1/launches/${chain}/${token}`);
      const m = c.market || {};
      const flags = (c.flags && c.flags.flags) || [];
      say('t-msg', '');
      $('t-card').replaceChildren(
        el('p', {}, el('strong', {}, m.token_symbol || c.launchpad?.ticker || 'This token'), m.token_name ? ` (${m.token_name})` : '', ` on ${NAMES[chain] || chain}`, c.age_hours !== null ? `, first pool opened ${c.age_hours < 48 ? `${Math.round(c.age_hours)} hours` : `${Math.round(c.age_hours / 24)} days`} ago` : ''),
        m.not_checked ? el('p', { class: 'msg bad' }, m.not_checked) : el('div', { class: 'tiles' },
          el('div', { class: 'tile' }, el('span', { class: 'small muted' }, 'Price'), el('h3', {}, m.price_usd ? `$${Number(m.price_usd).toPrecision(4)}` : '–')),
          el('div', { class: 'tile' }, el('span', { class: 'small muted' }, 'Liquidity'), el('h3', {}, money(m.liquidity_usd_total))),
          el('div', { class: 'tile' }, el('span', { class: 'small muted' }, 'Volume, 24 h'), el('h3', {}, money(m.volume_24h_usd))),
          el('div', { class: 'tile' }, el('span', { class: 'small muted' }, 'Market cap'), el('h3', {}, money(m.market_cap_usd ?? m.fdv_usd)))),
        c.launchpad ? el('p', {}, el('strong', {}, `Launchpad: ${c.launchpad.name}. `),
          c.launchpad.curve ? `Still on its bonding curve, ${c.launchpad.curve.progress_pct}% of the way to graduating; bought and sold on ${owns(c.launchpad.name)} contract with its ${c.launchpad.curve.buy_tax_pct}% buy and ${c.launchpad.curve.sell_tax_pct}% sell ${c.launchpad.launchpad === 'fourmeme' ? 'fee' : 'tax'}. ` : '',
          c.launchpad.curve && c.launchpad.quote && c.launchpad.quote !== 'bnb' ? `It's priced in ${c.launchpad.quote_symbol}, not BNB: RektBull doesn't trade it yet. ` : '',
          c.launchpad.state === 'graduated' && c.launchpad.agent_token ? `Graduated: it now trades as ${c.launchpad.agent_token}. ` : '',
          ...(c.launchpad.facts || []).map(f => `${f} `),
          el('a', { href: c.launchpad.link, rel: 'noopener', target: '_blank' }, `Its page on ${c.launchpad.name}`), el('span', { class: 'source' }, ` (${c.launchpad.source})`)) : '',
        el('h3', {}, 'GoPlus\'s flags'),
        c.flags?.not_checked ? el('p', { class: 'msg' }, `Not checked: ${c.flags.not_checked}`) : el('ul', { class: 'signals' }, flags.map(sign)),
        c.launchpad?.curve ? el('p', { class: 'small muted' }, 'On a bonding curve, most of the supply sits in the curve itself until it\'s bought, so holder counts that include it look concentrated. The bundle check looks at who bought from it.') : '',
        el('p', { class: 'small muted' }, c.young
          ? 'Under a week old: a buy also runs the bundle and insider check (Launch Safety) before your wallet is asked to sign, and stops on a critical finding.'
          : 'A buy runs RektBull\'s full token check before your wallet is asked to sign.'),
        el('div', { class: 'row' },
          el('a', { class: 'btn primary', href: tradeLink(chain, token, 'buy') }, 'Buy on the Trade desk'),
          el('a', { class: 'btn', href: tradeLink(chain, token, 'sell') }, 'Sell'),
          el('a', { class: 'btn', href: tokenLink(chain, token) }, 'Chart, trades and holders'),
          el('a', { class: 'btn', href: c.launch_check }, 'Full launch check')),
        el('p', { class: 'source' }, `Sources: ${m.source || 'DexScreener'}; ${c.flags?.source || 'GoPlus'}. ${c.note}`));
    } catch (err) { $('t-card').replaceChildren(); say('t-msg', err.message, 'bad'); }
  }

  const inCurve = v => (v >= 100 ? Math.round(v).toLocaleString() : Number(v).toPrecision(3));
  async function loadCurves() {
    const chain = $('c-chain').value;
    $('c-how').hidden = chain !== 'base';
    $('c-how-bsc').hidden = chain !== 'bsc';
    const current = fresh('curves');
    say('c-msg', `Reading ${chain === 'bsc' ? 'four.meme\'s' : 'Virtuals\''} contract…`);
    try {
      const c = await api('GET', `/v1/launches/curves?chain=${chain}`);
      if (!current()) return;
      say('c-msg', c.tokens.length ? '' : 'No tokens on the curve just now.');
      $('c-table').querySelector('tbody').replaceChildren(...c.tokens.map(t => el('tr', {},
        el('td', {}, el('strong', {}, t.ticker), el('div', { class: 'sub' }, el('a', { href: t.link, rel: 'noopener', target: '_blank' }, t.launchpad), ' · ', el('code', {}, `${t.token.slice(0, 6)}…${t.token.slice(-4)}`))),
        el('td', { class: 'num' }, `${t.curve.progress_pct}%`),
        el('td', { class: 'num' }, `${inCurve(t.curve.in_curve)} ${t.curve.in_curve_symbol}`),
        el('td', {}, `${t.curve.buy_tax_pct}% buy, ${t.curve.sell_tax_pct}% sell`),
        el('td', {}, el('a', { class: 'btn', href: tokenLink(chain, t.token) }, 'Look closer')))));
      $('c-src').textContent = `Source: ${c.source}. ${c.note}`;
    } catch (err) { if (current()) say('c-msg', err.message, 'bad'); }
  }
  $('c-reload').addEventListener('click', loadCurves);
  $('c-chain').addEventListener('change', loadCurves);
  loadCurves();

  $('l-chain').addEventListener('change', loadFeed);
  $('l-reload').addEventListener('click', loadFeed);
  $('t-form').addEventListener('submit', e => { e.preventDefault(); show($('t-chain').value, $('t-token').value.trim()); });
  const q = new URLSearchParams(location.search);
  if (CHAINS.includes(q.get('chain'))) $('l-chain').value = q.get('chain');
  loadFeed();

  /* ── Live: new, nearest to graduating, just graduated, from the launchpads' own events, every 10 seconds while in view ── */
  const LIVE_MS = 10000;
  const ago = iso => {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    return s < 60 ? `${Math.round(s)} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
  };
  const known = new Set(); // tokens already shown, so the ones that just arrived can be marked
  let liveChain = null;
  let liveTimer = null;
  const label = i => [el('strong', {}, i.symbol || '?'), i.name && i.name !== i.symbol ? el('span', { class: 'small muted' }, ` ${i.name}`) : ''];
  // A Virtuals token that graduated trades as its new agent token: that's the one to look at and buy.
  const actions = (chain, i, buy = true) => el('div', { class: 'live-act' },
    el('a', { class: 'btn small-btn', href: tokenLink(chain, i.agent_token || i.token) }, 'Look closer'),
    buy ? el('a', { class: 'btn small-btn primary', href: tradeLink(chain, i.agent_token || i.token, 'buy') }, i.agent_token ? 'Buy the new token' : 'Buy') : '');

  function liveItem(chain, i, kind, first) {
    const fresh = !first && !known.has(`${kind}:${i.token}`);
    known.add(`${kind}:${i.token}`);
    const signs = [
      ...(i.project_60_days ? [{ level: 'bad', text: 'Virtuals\' operators can drain this curve ("Project 60 days")', source: 'its Launched event' }] : []),
      ...((i.flags && i.flags.flags) || []).filter(x => x.level !== 'ok'),
    ].slice(0, 2);
    const body = [el('div', { class: 'live-top' }, el('span', {}, ...label(i)), el('span', { class: 'small muted' }, i.launchpad_name))];
    if (kind === 'new') {
      body.push(el('div', { class: 'small muted' }, `Launched ${ago(i.at)}`, i.creator ? ' by ' : '', i.creator ? el('code', {}, `${i.creator.slice(0, 6)}…${i.creator.slice(-4)}`) : ''));
      if (signs.length) body.push(el('ul', { class: 'signals' }, signs.map(sign)));
      else if (i.flags && !i.flags.not_checked) body.push(el('div', { class: 'small muted' }, 'None of GoPlus\'s red flags yet'));
    }
    if (kind === 'near') {
      body.push(el('div', { class: 'bar-row' }, el('span', { class: 'small' }, 'Sold'),
        el('span', { class: 'bar-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(i.progress_pct), 'aria-label': 'How far the curve is towards graduating' }, el('span', { class: 'bar-fill', style: `width:${Math.max(1, Math.min(100, i.progress_pct))}%` })),
        el('span', { class: 'bar-value' }, `${i.progress_pct}%`)));
      if (i.tradable === false) body.push(el('div', { class: 'small muted' }, 'Priced in another token, not BNB: RektBull doesn\'t trade it yet.'));
    }
    if (kind === 'grad') {
      body.push(el('div', { class: 'small muted' }, `Graduated ${ago(i.at)}`, i.agent_token ? '; it now trades as ' : '', i.agent_token ? el('a', { href: tokenLink(chain, i.agent_token) }, el('code', {}, `${i.agent_token.slice(0, 6)}…`)) : ''));
    }
    body.push(actions(chain, i, kind !== 'near' || i.tradable !== false));
    return el('li', { class: fresh ? 'live-item fresh' : 'live-item' }, ...body);
  }

  async function loadLive() {
    const chain = $('v-chain').value;
    const first = liveChain !== chain;
    if (first) { known.clear(); liveChain = chain; say('v-msg', 'Reading the launchpads\' events…'); }
    const current = fresh('live');
    try {
      const r = await api('GET', `/v1/launches/live?chain=${chain}`);
      if (!current()) return;
      const c = r.columns;
      const before = known.size;
      const fill = (id, items, kind, empty) => $(id).replaceChildren(...(items.length ? items.map(i => liveItem(chain, i, kind, first)) : [el('li', { class: 'small muted' }, empty)]));
      fill('v-new', c.new.items, 'new', 'No launches in the last hour.');
      fill('v-near', c.graduating.items, 'near', c.graduating.not_checked ? `Not checked: ${c.graduating.not_checked}` : 'No curve is being bought just now.');
      fill('v-grad', c.graduated.items, 'grad', `None in the last ${c.graduated.hours_covered} hours${c.graduated.hours_covered < 24 ? ' (still reading back to 24)' : ''}.`);
      const arrived = first ? 0 : known.size - before;
      say('v-msg', r.not_checked ? `Not updated: ${r.not_checked}` : '', r.not_checked ? 'bad' : null);
      $('v-status').textContent = `Updated ${new Date().toLocaleTimeString()}${arrived ? ` · ${arrived} new` : ''}`;
      $('v-src').textContent = `Sources: ${c.new.source}; nearest to graduating: ${c.graduating.source || '–'}; just graduated: ${c.graduated.source}. ${r.note}`;
    } catch (err) { if (current()) say('v-msg', err.message, 'bad'); }
  }
  function live() {
    clearInterval(liveTimer);
    if (document.visibilityState !== 'visible') return;
    loadLive();
    liveTimer = setInterval(loadLive, LIVE_MS);
  }
  $('v-chain').addEventListener('change', live);
  document.addEventListener('visibilitychange', live);
  if (['base', 'bsc'].includes(q.get('chain'))) $('v-chain').value = q.get('chain');
  live();
  if (/^0x[0-9a-fA-F]{40}$/.test(q.get('token') || '')) show($('l-chain').value, q.get('token'));
})();
