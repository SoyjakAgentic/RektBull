/* RektBull Find money: yield. The free check shows what a wallet holds and
 * how much more it could earn; Safety Pro shows each proposal and prepares
 * the move. The wallet signs every step; withdrawals to it are free. */
(function () {
  'use strict';
  const { el, say, api, state, switchChain, short, sleep } = window.RB;
  const $ = id => document.getElementById(id);
  const CHAIN_NAMES = { ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum' };
  const name = c => CHAIN_NAMES[c] || c;
  const money = v => (v === null || v === undefined ? '–' : '$' + Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const amount = v => Number(v).toLocaleString(undefined, { maximumFractionDigits: 6 });
  const pct = v => (v === null || v === undefined ? '–' : `${v}%`);
  let prepared = null;

  const wallet = () => $('y-wallet').value.trim();
  const fill = () => { if (!wallet()) $('y-wallet').value = $('f-wallet').value || state.address || ''; };
  window.RB.onSignedIn(fill);
  setTimeout(fill, 600);
  if (new URLSearchParams(location.search).get('wallet')) setTimeout(() => { $('y-wallet').value = new URLSearchParams(location.search).get('wallet'); }, 0);

  /* ── today's rates, and the risk watcher's warnings ── */
  api('GET', '/v1/yield/rates').then(r => {
    const warn = Object.fromEntries((r.warnings || []).map(w => [`${w.protocol}:${w.chain}:${w.asset}`, w]));
    $('y-rates').replaceChildren(
      el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Venue'), el('th', {}, 'Chain'), el('th', {}, 'Asset'), el('th', {}, 'APY'), el('th', {}, 'Borrowed'))),
        el('tbody', {}, r.rates.map(x => el('tr', {},
          el('td', {}, x.name, warn[`${x.protocol}:${x.chain}:${x.asset}`] ? el('span', { class: 'tag' }, 'warning') : null),
          el('td', {}, name(x.chain)), el('td', {}, x.asset),
          el('td', {}, x.apy_pct === null ? `not read (${x.error || 'unavailable'})` : pct(x.apy_pct), x.defillama?.apy_reward_pct ? el('span', { class: 'source' }, ` +${x.defillama.apy_reward_pct}% rewards (DefiLlama, not counted)`) : null),
          el('td', {}, pct(x.utilization_pct)))))),
      ...(r.warnings || []).map(w => el('p', { class: 'small risk' }, `${w.severity.toUpperCase()}: ${w.reason} (${w.source})`)),
      el('p', { class: 'source' }, `Sources: ${r.sources.join('; ')}.`),
    );
  }).catch(() => { $('y-rates').textContent = 'Couldn\'t load the rates.'; });

  /* ── the free check ── */
  function holdings(r, { exits = false } = {}) {
    const rows = [
      ...r.positions.map(p => ({ ...p, where: p.name, exit: true })),
      ...r.idle.filter(i => !i.gas).map(i => ({ ...i, where: 'Idle in the wallet' })),
    ].filter(x => Number(x.amount) > 0);
    if (!rows.length) return el('p', {}, `No USDC, USDT or WETH on ${Object.values(CHAIN_NAMES).join(', ')} in this wallet.`);
    return el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Where'), el('th', {}, 'Chain'), el('th', {}, 'Amount'), el('th', {}, 'Value'), el('th', {}, ''))),
      el('tbody', {}, rows.map(x => el('tr', {},
        el('td', {}, x.where), el('td', {}, name(x.chain)), el('td', {}, `${amount(x.amount)} ${x.asset}`), el('td', {}, money(x.usd)),
        el('td', {}, exits && x.exit ? el('button', { class: 'link', onclick: () => prepare({ chain: x.chain, asset: x.asset, from: x.protocol, all: true }) }, 'Withdraw to wallet (free)') : '')))));
  }

  $('y-check').addEventListener('click', async () => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet())) return say('y-msg', 'Enter a wallet address.', 'bad');
    say('y-msg', 'Reading Ethereum, Base and Arbitrum…');
    try {
      const r = await api('POST', '/v1/yield/wallet', { wallet: wallet() });
      $('y-result').replaceChildren(
        el('div', { class: 'facts' },
          el('div', {}, 'In yield positions', el('strong', {}, money(r.total_in_positions_usd))),
          el('div', {}, 'Moves that pass the rules', el('strong', {}, String(r.proposals_count))),
          el('div', {}, 'Could earn more a year', el('strong', {}, money(r.extra_per_year_usd))),
        ),
        holdings(r, { exits: true }),
        r.not_read.length ? el('p', { class: 'small risk' }, 'Not read: ', r.not_read.map(n => `${n.what} on ${name(n.chain)} (${n.reason})`).join('; ')) : null,
        el('p', { class: 'small muted' }, r.proposals_count ? r.note : 'Nothing to propose today: no move passes the rules.'),
      );
      $('y-result').hidden = false;
      say('y-msg', '');
    } catch (err) { say('y-msg', err.message, 'bad'); }
  });

  /* ── Safety Pro: the proposals ── */
  $('y-proposals').addEventListener('click', async () => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet())) return say('y-msg', 'Enter a wallet address.', 'bad');
    if (!state.token) return say('y-msg', 'Sign in with your wallet below: yield proposals are part of Safety Pro.', 'bad');
    say('y-msg', 'Reading every venue and checking each move against the rules…');
    try {
      const r = await api('POST', '/v1/yield/proposals', { wallet: wallet() });
      $('y-result').replaceChildren(
        holdings(r, { exits: true }),
        el('h3', {}, r.proposals.length ? 'Proposed moves' : 'No move passes the rules today'),
        el('ul', { class: 'flags' }, r.proposals.map(p => el('li', { class: 'low' },
          el('div', {}, el('strong', {}, `${amount(p.amount)} ${p.asset} on ${p.chain_label}`), `: ${p.from.name} (${pct(p.from.apy_pct)}) → ${p.to.name} (${pct(p.to.apy_pct)})`),
          el('div', { class: 'small' }, `About ${money(p.extra_per_year_usd)} more a year at today's rates. Gas up to ${money(p.gas_usd_max)}, fee ${money(p.fee_usd)} (${r.fee.rate}). ${p.to.name} is ${pct(p.to.utilization_pct)} borrowed.`),
          el('div', { class: 'row' }, el('button', { onclick: () => prepare({ chain: p.chain, asset: p.asset, from: p.from.protocol, to: p.to.protocol, amount_usd: p.amount_usd }) }, 'Prepare this move')),
        ))),
        r.not_proposed.length ? el('details', { class: 'small' }, el('summary', {}, `Not proposed (${r.not_proposed.length})`), el('ul', {}, r.not_proposed.map(n => el('li', {}, `${n.asset} on ${name(n.chain)} → ${n.to}: ${n.reason}`)))) : null,
        el('p', { class: 'source' }, `Sources: ${r.sources.join('; ')}. ${r.note}`),
      );
      $('y-result').hidden = false;
      say('y-msg', '');
    } catch (err) {
      say('y-msg', err.status === 402 ? 'Yield proposals are part of Safety Pro ($9 for 30 days, on the Safety page). The free check above shows how much more you could earn.' : err.message, 'bad');
    }
  });

  /* ── preparing and sending a move ── */
  async function prepare(body) {
    say('y-msg', 'Preparing the move and simulating it from your wallet…');
    try {
      prepared = await api('POST', '/v1/yield/moves/prepare', { wallet: wallet(), ...body });
      const s = prepared.summary;
      $('y-move-summary').replaceChildren(
        el('ul', { class: 'flags' }, el('li', { class: 'low' },
          prepared.to
            ? el('div', {}, `${amount(s.moved)} ${prepared.asset} on ${name(prepared.chain)}: `, el('strong', {}, `${amount(s.deposited)} deposited`), Number(s.fee) > 0 ? `, ${amount(s.fee)} ${prepared.asset} fee to RektBull (0.1%, about ${money(s.fee_usd)}).` : `. No fee: ${s.fee_reason}.`)
            : el('div', {}, el('strong', {}, `${amount(s.moved)} ${prepared.asset}`), ` comes back to your wallet on ${name(prepared.chain)}. No fee.`),
          s.gain_pct !== undefined ? el('div', { class: 'small' }, `${pct(s.from_apy_pct)} → ${pct(s.to_apy_pct)}: about ${money(s.extra_per_year_usd)} more a year at today's rates. Gas up to ${money(s.gas_usd_max)}.`) : null,
        )),
        el('p', { class: 'source' }, `Your wallet will show ${prepared.calls.length} call${prepared.calls.length === 1 ? '' : 's'}: ${prepared.calls.map(c => c.label).join('; ')}.${s.fee_to ? ` Fee wallet: ${s.fee_to}.` : ''}`),
        el('p', { class: 'small muted' }, prepared.note),
      );
      $('y-move').hidden = false;
      say('y-move-msg', '');
      say('y-msg', '');
      $('y-move').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      say('y-msg', err.status === 402 ? 'Prepared moves are part of Safety Pro. Withdrawals to your wallet are free for everyone.' : err.message, 'bad');
    }
  }

  $('y-cancel').addEventListener('click', () => { $('y-move').hidden = true; prepared = null; });
  $('y-send').addEventListener('click', async () => {
    const p = prepared;
    if (!p) return;
    if (!state.provider || !state.address) return say('y-move-msg', 'Connect your wallet below first.', 'bad');
    if (state.address.toLowerCase() !== p.wallet) return say('y-move-msg', `Connect the wallet ${short(p.wallet)}: only it can move its own funds.`, 'bad');
    $('y-send').disabled = true;
    try {
      await switchChain(p.chain_id);
      say('y-move-msg', 'Check your wallet: it shows every step, and the fee, before you sign.');
      const hashes = await window.RB.sendCalls(p, text => say('y-move-msg', text));
      let done = null;
      for (let k = 0; k < 10; k++) {
        done = await api('POST', `/v1/yield/moves/${p.move_id}/confirm`, { tx_hashes: hashes });
        if (done.status !== 'pending') break;
        await sleep(3000);
      }
      if (done.status === 'confirmed') { say('y-move-msg', 'Done. Check again to see your positions.', 'ok'); prepared = null; } else say('y-move-msg', done.message || 'The move didn\'t go through.', 'bad');
    } catch (err) {
      say('y-move-msg', err.code === 4001 ? 'You cancelled in your wallet. Nothing was sent.' : err.message, 'bad');
    } finally { $('y-send').disabled = false; }
  });
})();
