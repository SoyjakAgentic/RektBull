/* Home: one box. A wallet gets the free checkup from every desk; a token,
 * governor or contract is sent to the desk that checks it. */
(function () {
  'use strict';
  const { el, say, api, state, catalog } = window.RB;
  const $ = id => document.getElementById(id);
  const CHAIN_NAMES = { ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon', bsc: 'BNB Chain', solana: 'Solana' };
  const nameOf = c => CHAIN_NAMES[c] || c;

  /* ── prices, from the catalog and the trade desk's settings ── */
  const pts = n => `${n} point${n === 1 ? '' : 's'}`;
  const pct = bps => `${bps / 100}%`;
  const set = (id, text) => { const e = $(id); if (e && text) e.textContent = text; };
  catalog.ready.then(() => {
    const p = catalog.products;
    if (p.token_quick_check) set('p-safety', `Quick check: ${pts(p.token_quick_check.points)} or ${p.token_quick_check.price_usd}`);
    if (p.airdrop_claim) set('p-find', `Free to check; ${pct(p.airdrop_claim.fee_bps)} of what you claim (${pct(p.airdrop_claim.pro_fee_bps)} with Safety Pro)`);
    if (p.governance_summary) set('p-gov', `Free to check and vote; a summary ${pts(p.governance_summary.points)} or ${p.governance_summary.price_usd}`);
    if (p.presign_check) set('p-presign', `${pts(p.presign_check.points)} or ${p.presign_check.price_usd} a check; in Safety Pro`);
    if (p.pro_30d) set('p-monitor', `In Safety Pro, from ${p.pro_30d.price_usd} for 30 days`);
    if (catalog.free_points) set('pr-points', `${catalog.free_points.per_month} free points a month when you sign in with your wallet (free, moves nothing)`);
    if (p.token_quick_check && p.approval_cleanup) set('pr-points-use', `A token quick check is ${pts(p.token_quick_check.points)}, an approval cleanup ${pts(p.approval_cleanup.points)}`);
    if (p.pro_30d && p.pro_365d) {
      const amount = $('pr-pro');
      amount.replaceChildren(p.pro_30d.price_usd.replace(/\.00$/, ''), ' ', el('small', {}, `for 30 days · ${p.pro_365d.price_usd.replace(/\.00$/, '')} a year`));
      set('pr-reports', `${p.pro_30d.included_per_month?.token_report || 0} AI token reports a month`);
    }
    if (p.airdrop_claim) {
      $('pr-claim').replaceChildren(pct(p.airdrop_claim.fee_bps), ' ', el('small', {}, `of a claim · ${pct(p.airdrop_claim.pro_fee_bps)} with Safety Pro`));
      set('pr-pro-claim', `A ${pct(p.airdrop_claim.pro_fee_bps)} claim fee instead of ${pct(p.airdrop_claim.fee_bps)}`);
    }
    if (p.yield_move) set('pr-yield', `${pct(p.yield_move.fee_bps)} of each yield move RektBull prepares; withdrawals are free`);
  });
  api('GET', '/v1/trading/config').then(c => {
    set('p-trade', `${c.fee_pct}% per trade, capped onchain at 1%`);
    set('pr-trade', `${c.fee_pct}% of each trade, set in the Trade Router, which can't charge more than 1%`);
    $('b-trade').hidden = !!c.enabled;
  }).catch(() => {});

  /* ── the box ── */
  const mine = $('ask-mine');
  const showMine = () => { mine.hidden = !state.address; };
  window.RB.onSignedIn(showMine);
  setTimeout(showMine, 500);
  mine.addEventListener('click', () => { $('ask').value = state.address; ask(); });
  $('ask-form').addEventListener('submit', e => { e.preventDefault(); ask(); });

  let busy = false;
  async function ask() {
    const query = $('ask').value.trim();
    if (busy) return;
    if (!query) return say('ask-msg', 'Paste an address first.', 'bad');
    busy = true; $('ask-go').disabled = true;
    $('ask-result').hidden = true; $('checkup-card').hidden = true; $('results').hidden = true;
    say('ask-msg', 'Looking it up on every chain…');
    try {
      const r = await api('POST', '/v1/lookup', { query });
      say('ask-msg', '');
      renderLookup(r);
      if (r.kind === 'wallet') await checkup(r.address);
    } catch (err) {
      say('ask-msg', err.message, 'bad');
    } finally { busy = false; $('ask-go').disabled = false; }
  }

  function chainLine(c) {
    const what = {
      token: () => `a token${c.symbol ? `: ${c.name ? `${c.name} (${c.symbol})` : c.symbol}` : ''}`,
      nft: () => `an NFT collection (${c.standard})${c.name ? `: ${c.name}` : ''}`,
      governor: () => `a DAO governor${c.name ? `: ${c.name}` : ''}`,
      safe: () => c.note,
      wallet: () => c.note || 'a wallet',
      contract: () => (c.name ? `a contract, verified as ${c.name}` : `a contract (${c.name_not_read || 'name unknown'})`),
      account: () => 'an account, not a token mint',
      none: () => 'nothing at this address yet',
    }[c.kind];
    return el('li', {}, el('strong', {}, nameOf(c.chain) + ': '), what ? what() : c.kind);
  }

  function renderLookup(r) {
    const box = $('ask-result');
    const nodes = [el('p', { class: 'lookup-summary' }, el('strong', {}, r.summary))];
    if (r.chains?.length) nodes.push(el('ul', { class: 'plain small' }, r.chains.map(chainLine)));
    if (r.note && !r.not_read?.length) nodes.push(el('p', { class: 'small muted' }, r.note));
    const links = (r.next || []).filter(n => n.href);
    if (links.length) nodes.push(el('div', { class: 'next' }, links.map(n => el('a', { class: 'go', href: n.href }, el('span', { class: 'tag-desk' }, n.desk), n.label))));
    if (r.not_read?.length) nodes.push(el('p', { class: 'small muted' }, 'Not read: ', r.not_read.map(n => `${nameOf(n.chain)} (${n.reason})`).join('; ')));
    nodes.push(el('p', { class: 'source' }, 'Source: ', r.source));
    box.replaceChildren(...nodes);
    box.hidden = false;
    $('results').hidden = false;
    $('results').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  /* ── the checkup ── */
  async function checkup(wallet) {
    const card = $('checkup-card');
    $('c-wallet').textContent = window.RB.short(wallet);
    $('c-parts').replaceChildren(el('p', { class: 'muted' }, 'Running the free checks of every desk (this can take half a minute)…'));
    $('c-note').textContent = '';
    card.hidden = false;
    try {
      const r = await api('POST', '/v1/checkup', { wallet });
      $('c-parts').replaceChildren(...r.parts.map(part));
      $('c-note').textContent = r.note;
    } catch (err) {
      $('c-parts').replaceChildren(el('p', { class: 'msg bad' }, err.message));
    }
  }

  function part(p) {
    const kids = [
      el('div', { class: 'part-head' }, el('span', { class: 'tag-desk' }, p.desk), el('span', { class: 'part-title' }, p.title)),
      el('p', { class: 'headline' }, p.headline),
    ];
    if (p.ok) {
      kids.push(el('div', { class: 'facts' }, p.facts.map(f => el('div', {}, f.label, el('strong', {}, f.value)))));
      if (p.not_checked?.length) {
        kids.push(el('details', { class: 'small' }, el('summary', {}, `Couldn't check ${p.not_checked.length} thing${p.not_checked.length === 1 ? '' : 's'}`),
          el('ul', {}, p.not_checked.map(n => el('li', {}, `${n.check}: ${n.reason}`)))));
      }
      kids.push(el('p', { class: 'source' }, 'Source: ', p.source));
    } else {
      kids.push(el('p', { class: 'small muted' }, p.reason));
    }
    kids.push(el('a', { class: 'go', href: p.href }, p.action + ' →'));
    return el('div', { class: `part ${p.status}`, id: `part-${p.id}` }, kids);
  }

  /* A link to …/?q=0x… (or ?wallet=) runs the box. */
  const q = new URLSearchParams(location.search);
  const fromLink = q.get('q') || q.get('wallet');
  if (fromLink) { $('ask').value = fromLink; ask(); }
})();
