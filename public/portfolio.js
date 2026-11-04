/* Portfolio: a wallet's holdings on six chains, their value, and the facts on each. */
(function () {
  'use strict';
  const { el, say, api, state } = window.RB;
  const $ = id => document.getElementById(id);
  const usd = v => {
    if (v === null || v === undefined) return '–';
    const a = Math.abs(v);
    if (a < 1000) return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const [d, s] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : [1e3, 'K'];
    return `$${(v / d).toLocaleString(undefined, { maximumFractionDigits: 1 })}${s}`;
  };
  const amt = v => v.toLocaleString(undefined, { maximumFractionDigits: v >= 1000 ? 0 : v >= 1 ? 4 : 6 });
  const price = v => (v === null ? '–' : `$${v.toLocaleString(undefined, { maximumFractionDigits: v < 1 ? 6 : 2, minimumFractionDigits: v < 1 ? 2 : 2 })}`);
  const sig = s => el('span', { class: `sig ${s.level}`, title: `Source: ${s.source}` }, s.text);
  const short = a => a.slice(0, 6) + '…' + a.slice(-4);

  const fromLink = new URLSearchParams(location.search).get('wallet');
  if (fromLink && /^0x[0-9a-fA-F]{40}$/.test(fromLink)) $('p-wallet').value = fromLink;
  const fill = () => { if (!$('p-wallet').value && state.address) $('p-wallet').value = state.address; };
  window.RB.onSignedIn(fill);
  setTimeout(fill, 500);

  $('p-form').addEventListener('submit', async e => {
    e.preventDefault();
    const wallet = $('p-wallet').value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return say('p-msg', 'Paste a wallet address (0x and 40 hex characters).', 'bad');
    $('p-go').disabled = true;
    say('p-msg', 'Reading six chains (this can take half a minute)…');
    try {
      render(await api('POST', '/v1/portfolio', { wallet }));
      say('p-msg', '');
    } catch (err) { say('p-msg', err.message, 'bad'); } finally { $('p-go').disabled = false; }
  });
  if (fromLink) $('p-form').requestSubmit();

  function render(r) {
    $('p-who').textContent = short(r.wallet);
    $('s-total').textContent = usd(r.total_usd);
    $('s-total-sub').textContent = `${r.holdings.length + r.positions.length} holdings priced`;
    $('s-tokens').textContent = usd(r.tokens_usd);
    $('s-tokens-sub').textContent = r.unpriced.length ? `+ ${r.unpriced.length} not priced` : '';
    $('s-defi').textContent = usd(r.defi_usd);
    $('s-defi-sub').textContent = `${r.positions.length} position${r.positions.length === 1 ? '' : 's'}`;
    $('s-stable').textContent = r.stable_pct === null ? '–' : `${r.stable_pct}%`;

    const warn = [];
    if (r.risk && r.risk.to_revoke) warn.push(el('span', {}, el('strong', {}, `${r.risk.to_revoke} approval${r.risk.to_revoke === 1 ? '' : 's'} worth revoking`), ` (of ${r.risk.open} open; they could take ${usd(r.risk.value_at_risk_usd)}). `, el('a', { href: r.risk.href }, 'See which →')));
    if (r.flagged) warn.push(el('span', {}, ` ${r.flagged} holding${r.flagged === 1 ? ' is' : 's are'} flagged below.`));
    $('p-risk').replaceChildren(...warn);
    $('p-risk').hidden = !warn.length;
    $('n-approvals').href = `/safety?wallet=${r.wallet}#approvals-card`;
    $('n-opps').href = `/opportunities?wallet=${r.wallet}`;

    const max = Math.max(...r.by_chain.map(c => c.usd), 1);
    $('by-chain').replaceChildren(...(r.by_chain.length ? r.by_chain.map(c => el('div', { class: 'bar-row' },
      el('span', { class: 'bar-label' }, c.chain_name),
      el('span', { class: 'bar-track' }, el('span', { class: 'bar-fill', style: `width:${Math.max(1, c.usd / max * 100)}%` })),
      el('span', { class: 'bar-value' }, `${usd(c.usd)} · ${r.total_usd ? Math.round(c.usd / r.total_usd * 100) : 0}%`))) : [el('p', { class: 'small muted' }, 'Nothing priced found.')]));

    $('holdings').tBodies[0].replaceChildren(...(r.holdings.length ? r.holdings.map(h => el('tr', {},
      el('td', {}, el('span', { class: 'name' }, h.symbol), el('div', { class: 'sub' }, `${h.name && h.name !== h.symbol ? h.name + ' · ' : ''}${h.chain_name}`)),
      el('td', { class: 'num' }, amt(h.amount)), el('td', { class: 'num' }, price(h.price)), el('td', { class: 'num' }, usd(h.usd)), el('td', { class: 'num' }, h.share_pct === null ? '–' : `${h.share_pct}%`),
      el('td', {}, el('div', { class: 'sigs' }, h.signals.map(sig))),
      el('td', {}, h.check ? el('a', { href: h.check, class: 'act' }, 'Check') : ''))) : [el('tr', {}, el('td', { colspan: 7, class: 'muted' }, 'No priced tokens found.'))]));

    $('positions-card').hidden = !r.positions.length;
    $('positions').tBodies[0].replaceChildren(...r.positions.map(p => el('tr', {},
      el('td', {}, el('span', { class: 'name' }, `${p.symbol} on ${p.protocol}`), el('div', { class: 'sub' }, p.chain_name)),
      el('td', { class: 'num' }, amt(p.amount)), el('td', { class: 'num' }, usd(p.usd)),
      el('td', {}, el('div', { class: 'sigs' }, p.signals.map(sig))))));

    $('unpriced-card').hidden = !r.unpriced.length;
    $('unpriced-n').textContent = String(r.unpriced.length);
    $('unpriced').tBodies[0].replaceChildren(...r.unpriced.map(u => el('tr', {},
      el('td', {}, el('span', { class: 'name' }, u.symbol), el('div', { class: 'sub' }, `${u.name && u.name !== u.symbol ? u.name + ' · ' : ''}${u.chain_name}`)),
      el('td', { class: 'num' }, amt(u.amount)),
      el('td', {}, el('div', { class: 'sigs' }, u.signals.map(sig))),
      el('td', {}, u.check ? el('a', { href: u.check, class: 'act' }, 'Check') : ''))));

    $('notread-box').hidden = !r.not_read.length;
    $('notread-sum').textContent = `Couldn't read ${r.not_read.length} thing${r.not_read.length === 1 ? '' : 's'}`;
    $('notread').replaceChildren(...r.not_read.map(n => el('li', {}, `${n.chain ? n.chain + ': ' : ''}${n.what}: ${n.reason}`)));
    $('p-src').textContent = `Sources: ${r.sources.join('; ')}. ${r.note} Read ${new Date(r.read_at).toLocaleString()}.`;
    $('p-result').hidden = false;
  }
})();
