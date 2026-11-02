/* RektBull Find money: the free check for airdrops and rewards, and claims
 * the user's own wallet signs. The server finds, verifies and prepares; the
 * wallet sends. The fee is a plain transfer shown before anything is signed. */
(function () {
  'use strict';
  const { el, say, api, state, request, switchChain, short } = window.RB;
  const $ = id => document.getElementById(id);
  const CHAIN_NAMES = { ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon', bsc: 'BNB Chain' };
  const name = c => CHAIN_NAMES[c] || c;
  const money = v => (v === null || v === undefined ? null : '$' + Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const amount = v => (v === null || v === undefined ? '?' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 6 }));
  const STATUS = { claimable: 'Claimable', updating: 'Not yet: being updated', pending: 'On the way', unverified: 'Not offered' };
  let result = null;
  let prepared = null;

  window.RB.catalog.ready.then(c => {
    const p = c.products.airdrop_claim;
    if (p) $('fee-what').textContent = `Checking is free. When you claim through RektBull, ${p.fee_bps / 100}% of what you receive (${p.pro_fee_bps / 100}% with Safety Pro) goes to RektBull.`;
  });

  const wallet = () => $('f-wallet').value.trim();
  const fill = () => { if (!wallet() && state.address) $('f-wallet').value = state.address; };
  window.RB.onSignedIn(fill);
  setTimeout(fill, 500);
  const fromLink = new URLSearchParams(location.search).get('wallet');
  if (fromLink && /^0x[0-9a-fA-F]{40}$/.test(fromLink)) $('f-wallet').value = fromLink;

  /* ── the airdrops covered ── */
  api('GET', '/v1/claims/programs').then(r => {
    $('programs').replaceChildren(r.programs.length
      ? el('ul', {}, r.programs.map(p => el('li', {}, el('a', { href: p.official_url, rel: 'noopener' }, p.name), ` on ${name(p.chain)}`, p.ends_at ? `, until ${p.ends_at.slice(0, 10)}` : '', el('span', { class: 'source' }, ` · ${p.entries.toLocaleString()} wallets · ${p.source}`))))
      : 'None yet. Merkl rewards are checked for every wallet.');
  }).catch(() => { $('programs').textContent = 'Couldn\'t load the list.'; });

  /* ── the free check ── */
  $('f-check').addEventListener('click', check);
  async function check() {
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet())) return say('f-msg', 'Enter a wallet address (0x and 40 characters), or connect your wallet below.', 'bad');
    say('f-msg', 'Looking on six chains and checking each result onchain…');
    $('f-check').disabled = true;
    $('claim-card').hidden = true;
    try {
      result = await api('POST', '/v1/claims/check', { wallet: wallet() });
      show(result);
      say('f-msg', '');
    } catch (err) { say('f-msg', err.message, 'bad'); } finally { $('f-check').disabled = false; }
  }

  function show(r) {
    const s = r.summary;
    const byChain = {};
    for (const i of r.items) (byChain[i.chain] = byChain[i.chain] || []).push(i);
    const groups = Object.entries(byChain).map(([chain, items]) => {
      const picks = new Set(items.filter(i => i.status === 'claimable').map(i => i.id));
      const btn = el('button', { class: 'primary', onclick: () => prepare(chain, [...picks]) }, `Prepare claim on ${name(chain)}`);
      btn.disabled = !picks.size;
      return el('div', { class: 'plan' },
        el('h3', {}, name(chain)),
        el('ul', { class: 'flags' }, items.map(i => el('li', { class: i.status === 'claimable' ? 'low' : 'medium' },
          i.status === 'claimable'
            ? el('label', { class: 'small', style: 'display:flex;gap:8px;align-items:flex-start;color:inherit' },
              el('input', { type: 'checkbox', checked: 'checked', onchange: e => { if (e.target.checked) picks.add(i.id); else picks.delete(i.id); btn.disabled = !picks.size; } }),
              el('span', {}, el('strong', {}, `${amount(i.claimable)} ${i.token.symbol || short(i.token.address)}`), i.claimable_usd !== null ? ` (about ${money(i.claimable_usd)}, price from ${i.price_source})` : ' (no market price yet)'))
            : el('div', {}, el('span', { class: 'sev' }, STATUS[i.status]), el('strong', {}, `${amount(i.pending || i.claimable)} ${i.token.symbol || short(i.token.address)}`)),
          el('div', { class: 'small' }, i.name, i.ends_at ? ` · claim by ${i.ends_at.slice(0, 10)}` : ''),
          i.reason ? el('div', { class: 'small risk' }, i.reason) : null,
          el('div', { class: 'source' }, `Source: ${i.source_label}`, i.checks.length ? ` · Checked: ${i.checks.join('; ')}` : '', ' · ', el('a', { href: i.details_url, rel: 'noopener' }, 'Claim on their site instead (free)')),
        ))),
        el('div', { class: 'row' }, btn),
      );
    });
    $('f-result').replaceChildren(...[
      el('div', { class: 'facts' },
        el('div', {}, 'Claimable now', el('strong', {}, String(s.claimable))),
        el('div', {}, 'Worth about', el('strong', {}, money(s.claimable_usd))),
        el('div', {}, 'Fee if you claim here', el('strong', {}, r.fee.rate + (r.fee.safety_pro ? ' (Safety Pro)' : ''))),
      ),
      s.not_priced ? el('p', { class: 'small muted' }, `${s.not_priced} of them have no market price yet, so they're not in the total.`) : null,
      r.items.length ? groups : el('p', {}, 'Nothing to claim in these sources.'),
      r.not_checked.length ? el('p', { class: 'small risk' }, 'Not checked: ', r.not_checked.map(n => `${n.check} (${n.reason})`).join('; ')) : null,
      el('p', { class: 'small muted' }, 'Looked in: ', r.sources.map(x => `${x.name}${x.read ? '' : ' (couldn\'t be read)'}`).join('; '), '. ', r.note),
    ].flat().filter(Boolean));
    $('f-result').hidden = false;
  }

  /* ── preparing and sending a claim ── */
  async function prepare(chain, ids) {
    say('f-msg', `Preparing the claim on ${name(chain)} and simulating it…`);
    try {
      prepared = await api('POST', '/v1/claims/prepare', { wallet: wallet(), chain, ids });
      const p = prepared;
      $('c-summary').replaceChildren(...[
        el('ul', { class: 'flags' }, p.summary.map(l => el('li', { class: 'low' },
          el('div', {}, `You claim ${amount(l.receive)} ${l.token.symbol || short(l.token.address)}${l.receive_usd !== null ? ` (about ${money(l.receive_usd)})` : ''}.`),
          l.fee_raw !== '0'
            ? el('div', {}, el('strong', {}, `${amount(l.keep)} stay in your wallet`), `, ${amount(l.fee)} ${l.token.symbol || ''} go to RektBull's fee wallet (${p.fee.rate}${l.fee_usd !== null ? `, about ${money(l.fee_usd)}` : ''}).`)
            : el('div', {}, el('strong', {}, 'No fee'), `: ${l.fee_reason}.`),
        ))),
        p.fee.to ? el('p', { class: 'source' }, `Fee wallet: ${p.fee.to}. Your wallet will show ${p.calls.length} calls: ${p.calls.map(c => c.label).join('; ')}.`) : null,
        p.warnings.length ? el('p', { class: 'small risk' }, p.warnings.join(' ')) : null,
        el('p', { class: 'small muted' }, p.note),
      ].filter(Boolean));
      $('claim-card').hidden = false;
      $('claim-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
      say('c-msg', '');
      say('f-msg', '');
    } catch (err) { say('f-msg', err.message, 'bad'); }
  }

  $('c-cancel').addEventListener('click', () => { $('claim-card').hidden = true; prepared = null; });

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function receipt(hash) {
    for (let k = 0; k < 90; k++) {
      const r = await request('eth_getTransactionReceipt', [hash]).catch(() => null);
      if (r) return r;
      await sleep(2000);
    }
    throw new Error('The transaction hasn\'t confirmed yet. It may still go through; check your wallet.');
  }
  const unsupported = err => err && err.code !== 4001 && (err.code === 4200 || err.code === -32601 || err.code === 5700 || err.code === 5710 || /not supported|does not exist|unsupported|method not found/i.test(err.message || ''));

  /** Sends the calls: as one bundle where the wallet can (all or nothing), otherwise one at a time, claim first. */
  async function send(p) {
    try {
      const sent = await request('wallet_sendCalls', [{ version: '2.0.0', chainId: p.chain_id, from: state.address, atomicRequired: p.atomic, calls: p.calls.map(c => ({ to: c.to, data: c.data, value: c.value })) }]);
      const id = typeof sent === 'string' ? sent : sent?.id;
      for (let k = 0; k < 90; k++) {
        const s = await request('wallet_getCallsStatus', [id]);
        const code = Number(s?.status);
        if (code === 200 || s?.status === 'CONFIRMED') return (s.receipts || []).map(r => r.transactionHash);
        if (code >= 400) throw new Error('The wallet says the claim failed.');
        await sleep(2000);
      }
      throw new Error('The claim hasn\'t confirmed yet. Check your wallet.');
    } catch (err) {
      if (!unsupported(err)) throw err;
    }
    const hashes = [];
    for (const c of p.calls) {
      const hash = await request('eth_sendTransaction', [{ from: state.address, to: c.to, data: c.data, value: c.value }]);
      hashes.push(hash);
      say('c-msg', `Sent ${hashes.length} of ${p.calls.length}. Waiting for it to confirm…`);
      const r = await receipt(hash);
      if (Number(r.status) !== 1) throw new Error(hashes.length === 1 ? 'The claim failed onchain. Nothing else was sent.' : 'A fee transfer failed onchain; your claim went through.');
    }
    return hashes;
  }

  $('c-send').addEventListener('click', async () => {
    const p = prepared;
    if (!p) return;
    if (!state.provider || !state.address) return say('c-msg', 'Connect your wallet below first.', 'bad');
    if (state.address.toLowerCase() !== p.wallet) return say('c-msg', `Connect the wallet ${short(p.wallet)}: only it can claim what's owed to it.`, 'bad');
    $('c-send').disabled = true;
    try {
      await switchChain(p.chain_id);
      say('c-msg', 'Check your wallet: it shows the claim and the fee before you sign.');
      const hashes = await send(p);
      say('c-msg', 'Confirming what arrived…');
      let done = null;
      for (let k = 0; k < 10; k++) {
        done = await api('POST', `/v1/claims/${p.claim_id}/confirm`, { tx_hashes: hashes });
        if (done.status !== 'pending') break;
        await sleep(3000);
      }
      if (done.status === 'confirmed') {
        say('c-msg', 'Claimed. The tokens are in your wallet.', 'ok');
        prepared = null;
        setTimeout(check, 1500);
      } else {
        say('c-msg', done.message || 'The claim didn\'t go through.', 'bad');
      }
    } catch (err) {
      say('c-msg', err.code === 4001 ? 'You cancelled in your wallet. Nothing was sent.' : err.message, 'bad');
    } finally { $('c-send').disabled = false; }
  });
})();
