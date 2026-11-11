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

  async function loadFeed() {
    const chain = $('l-chain').value;
    say('l-msg', 'Reading the newest pools…');
    try {
      const f = await api('GET', `/v1/launches?chain=${chain}`);
      say('l-msg', f.tokens.length ? '' : 'No new pools on this network just now.');
      $('l-table').querySelector('tbody').replaceChildren(...f.tokens.map(t => {
        const signs = [...(t.signals || []), ...((t.flags && t.flags.flags) || []).filter(x => x.level !== 'ok')];
        return el('tr', {},
          el('td', {}, el('strong', {}, t.symbol || '?'), ' ', el('span', { class: 'small muted' }, t.name || ''), el('div', { class: 'sub' }, `${t.exchange || ''}${t.quote ? ` · against ${t.quote}` : ''} · `, el('code', {}, `${t.token.slice(0, 6)}…${t.token.slice(-4)}`))),
          el('td', {}, t.launchpad ? el('a', { href: t.launchpad.link, rel: 'noopener', target: '_blank' }, t.launchpad.name) : el('span', { class: 'small muted' }, chain === 'base' ? 'none found' : '–')),
          el('td', { class: 'num' }, age(t.created_at)),
          el('td', { class: 'num' }, money(t.liquidity_usd)),
          el('td', { class: 'num' }, money(t.volume_24h_usd)),
          el('td', {}, signs.length ? el('ul', { class: 'signals' }, signs.slice(0, 4).map(sign)) : el('span', { class: 'small muted' }, t.flags ? 'None of GoPlus\'s red flags; market data shows no warning sign' : 'No warning sign in its market data')),
          el('td', {}, el('button', { class: 'btn', type: 'button', onclick: () => show(chain, t.token) }, 'Look closer')));
      }));
      $('l-src').textContent = `Sources: ${f.sources.join('; ')}. ${f.note}`;
    } catch (err) { say('l-msg', err.message, 'bad'); }
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
        el('p', {}, el('strong', {}, m.token_symbol || c.launchpad?.ticker || 'This token'), m.token_name ? ` (${m.token_name})` : '', ` on ${chain}`, c.age_hours !== null ? `, first pool opened ${c.age_hours < 48 ? `${Math.round(c.age_hours)} hours` : `${Math.round(c.age_hours / 24)} days`} ago` : ''),
        m.not_checked ? el('p', { class: 'msg bad' }, m.not_checked) : el('div', { class: 'tiles' },
          el('div', { class: 'tile' }, el('span', { class: 'small muted' }, 'Price'), el('h3', {}, m.price_usd ? `$${Number(m.price_usd).toPrecision(4)}` : '–')),
          el('div', { class: 'tile' }, el('span', { class: 'small muted' }, 'Liquidity'), el('h3', {}, money(m.liquidity_usd_total))),
          el('div', { class: 'tile' }, el('span', { class: 'small muted' }, 'Volume, 24 h'), el('h3', {}, money(m.volume_24h_usd))),
          el('div', { class: 'tile' }, el('span', { class: 'small muted' }, 'Market cap'), el('h3', {}, money(m.market_cap_usd ?? m.fdv_usd)))),
        c.launchpad ? el('p', {}, el('strong', {}, `Launchpad: ${c.launchpad.name}. `),
          c.launchpad.curve ? `Still on its bonding curve, ${c.launchpad.curve.progress_pct}% of the way to graduating; bought and sold on Virtuals' contract with its ${c.launchpad.curve.buy_tax_pct}% buy and ${c.launchpad.curve.sell_tax_pct}% sell tax. ` : '',
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
          el('a', { class: 'btn', href: c.launch_check }, 'Full launch check')),
        el('p', { class: 'source' }, `Sources: ${m.source || 'DexScreener'}; ${c.flags?.source || 'GoPlus'}. ${c.note}`));
    } catch (err) { $('t-card').replaceChildren(); say('t-msg', err.message, 'bad'); }
  }

  async function loadCurves() {
    say('c-msg', 'Reading Virtuals\' contract…');
    try {
      const c = await api('GET', '/v1/launches/curves');
      say('c-msg', c.tokens.length ? '' : 'No tokens on the curve just now.');
      $('c-table').querySelector('tbody').replaceChildren(...c.tokens.map(t => el('tr', {},
        el('td', {}, el('strong', {}, t.ticker), el('div', { class: 'sub' }, el('a', { href: t.link, rel: 'noopener', target: '_blank' }, 'Virtuals'), ' · ', el('code', {}, `${t.token.slice(0, 6)}…${t.token.slice(-4)}`))),
        el('td', { class: 'num' }, `${t.curve.progress_pct}%`),
        el('td', { class: 'num' }, Math.round(t.curve.virtual_in_curve).toLocaleString()),
        el('td', {}, `${t.curve.buy_tax_pct}% buy, ${t.curve.sell_tax_pct}% sell`),
        el('td', {}, el('button', { class: 'btn', type: 'button', onclick: () => show('base', t.token) }, 'Look closer')))));
      $('c-src').textContent = `Source: ${c.source}. ${c.note}`;
    } catch (err) { say('c-msg', err.message, 'bad'); }
  }
  $('c-reload').addEventListener('click', loadCurves);
  loadCurves();

  $('l-chain').addEventListener('change', loadFeed);
  $('l-reload').addEventListener('click', loadFeed);
  $('t-form').addEventListener('submit', e => { e.preventDefault(); show($('t-chain').value, $('t-token').value.trim()); });
  const q = new URLSearchParams(location.search);
  if (['base', 'ethereum', 'arbitrum'].includes(q.get('chain'))) $('l-chain').value = q.get('chain');
  loadFeed();
  if (/^0x[0-9a-fA-F]{40}$/.test(q.get('token') || '')) show($('l-chain').value, q.get('token'));
})();
