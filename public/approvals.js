/* RektBull Safety page: approval cleanup. The server finds and rates the
 * approvals and prepares the revokes; the user's wallet signs them. */
(function () {
  'use strict';
  const { el, say, api, usd, state, request, switchChain } = window.RB;
  const $ = id => document.getElementById(id);
  const CHAIN_NAMES = { ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon', bsc: 'BNB Chain' };
  const KIND = { erc20: 'can spend your', nft_all: 'can move all your', permit2: 'can spend (through Permit2) your' };
  const STORE = 'rb_approval_cleanup';
  let product = null;
  let result = null;
  const selected = new Set();

  window.RB.catalog.ready.then(c => {
    product = c.products.approval_cleanup;
    $('a-price').textContent = window.RB.priceLabel(product);
  });

  const wallet = () => $('a-wallet').value.trim();
  const fill = () => { if (!wallet() && state.address) $('a-wallet').value = state.address; };
  window.RB.onSignedIn(fill);
  setTimeout(fill, 500);

  const money = v => (v === null || v === undefined ? null : '$' + Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

  /* ── the free preview ── */
  $('a-preview').addEventListener('click', () => preview(false));
  async function preview(refresh) {
    if (!wallet()) return say('a-msg', 'Enter a wallet address, or connect your wallet below.', 'bad');
    say('a-msg', 'Looking on six chains (up to a minute)…');
    try {
      const p = await api('POST', '/v1/approvals/preview', { wallet: wallet(), ...(refresh ? { refresh: true } : {}) });
      const s = p.summary;
      $('a-summary').replaceChildren(el('div', { class: 'facts' },
        el('div', {}, 'Open approvals', el('strong', {}, String(s.open))),
        el('div', {}, 'We\'d revoke', el('strong', {}, String(s.to_revoke))),
        el('div', {}, 'Could be taken now', el('strong', {}, money(s.value_at_risk_usd))),
      ),
      s.not_priced ? el('p', { class: 'small muted' }, `${s.not_priced} of the risky ones aren't priced (NFTs, or tokens without a market price), so the real amount may be higher.`) : null,
      s.chains_not_read.length ? el('p', { class: 'small risk' }, 'Couldn\'t read: ', s.chains_not_read.map(c => `${CHAIN_NAMES[c.chain] || c.chain} (${c.reason})`).join('; ')) : null,
      el('p', { class: 'small muted' }, s.open ? p.note : 'Nothing open was found, so there\'s nothing to clean up.'));
      $('a-summary').hidden = false;
      $('a-cleanup').disabled = !s.open;
      say('a-msg', '');
    } catch (err) { say('a-msg', err.message, 'bad'); }
  }

  /* ── the paid cleanup ── */
  $('a-cleanup').addEventListener('click', async () => {
    if (!wallet()) return say('a-msg', 'Enter a wallet address, or connect your wallet below.', 'bad');
    say('a-msg', 'Looking on six chains and checking every spender (up to a minute)…');
    $('a-cleanup').disabled = true;
    try {
      const r = await api('POST', '/v1/approvals/cleanup', { wallet: wallet() });
      try { sessionStorage.setItem(STORE, JSON.stringify(r)); } catch { /* fine */ }
      show(r);
      say('a-msg', '');
    } catch (err) {
      if (err.status === 402) {
        say('a-msg', window.RB.paymentMessage(product || { title: 'Approval cleanup', price_usd: '$1.00', points: 5 }, err), 'bad');
        $('account-card').scrollIntoView({ behavior: 'smooth' });
      } else say('a-msg', err.status >= 500 ? 'The cleanup failed on our side, and you weren\'t charged. Try again in a minute.' : err.message, 'bad');
    } finally {
      $('a-cleanup').disabled = false;
      document.dispatchEvent(new Event('rb:account-changed'));
    }
  });

  function show(r) {
    result = r;
    selected.clear();
    for (const c of r.chains) for (const a of c.approvals) if (a.recommended) selected.add(a.id);
    const s = r.summary;
    const parts = [
      el('div', { class: 'facts' },
        el('div', {}, 'Open approvals', el('strong', {}, String(s.open))),
        el('div', {}, 'We\'d revoke', el('strong', {}, String(s.to_revoke))),
        el('div', {}, 'Could be taken now', el('strong', {}, money(s.value_at_risk_usd)))),
    ];
    for (const c of r.chains) {
      if (!c.read) { parts.push(el('div', { class: 'chain-block' }, el('h3', {}, CHAIN_NAMES[c.chain] || c.chain), el('p', { class: 'risk small' }, 'Couldn\'t read this chain: ', c.reason))); continue; }
      if (!c.approvals.length && !c.not_checked.length) continue;
      const block = el('div', { class: 'chain-block' }, el('h3', {}, CHAIN_NAMES[c.chain] || c.chain));
      for (const a of c.approvals) block.append(row(c, a));
      if (c.approvals.length) {
        block.append(el('div', { class: 'row' }, el('button', { class: 'primary', onclick: () => revoke(c) }, `Revoke selected on ${CHAIN_NAMES[c.chain] || c.chain}`)));
        block.append(el('p', { class: 'msg', id: `revoke-msg-${c.chain}` }));
      } else block.append(el('p', { class: 'small muted' }, 'No open approvals found.'));
      if (c.not_checked.length) block.append(el('details', { class: 'small' }, el('summary', {}, 'What we couldn\'t check here'), el('ul', {}, c.not_checked.map(n => el('li', {}, el('strong', {}, n.check), ': ', n.reason)))));
      parts.push(block);
    }
    const run = r.run || {};
    parts.push(el('p', { class: 'small muted' }, r.note));
    parts.push(el('p', { class: 'paid' }, `Checked ${new Date(r.checked_at).toLocaleString()}`, window.RB.paidLabel(run)));
    if (run.paid_with && run.paid_with !== 'pass') {
      parts.push(el('p', { class: 'small' }, 'New approvals appear every time you use an app. ', el('a', { href: '#pro-card' }, 'Safety Pro'), ' lets you check as often as you like, and will watch this wallet for you when the risk monitor launches.'));
    }
    $('a-result').replaceChildren(...parts);
    $('a-result').hidden = false;
    $('a-summary').hidden = true;
  }

  function row(c, a) {
    const box = el('input', { type: 'checkbox', 'data-id': a.id, 'aria-label': `Revoke ${a.token.symbol || a.token.address} for ${a.spender.label || a.spender.address}` });
    box.checked = selected.has(a.id);
    box.addEventListener('change', () => {
      // Permit2 revokes every Permit2 allowance on the chain in one transaction, so they're ticked together.
      const group = a.kind === 'permit2' ? c.approvals.filter(x => x.kind === 'permit2') : [a];
      for (const x of group) {
        if (box.checked) selected.add(x.id); else selected.delete(x.id);
        const other = $('a-result').querySelector(`input[data-id="${CSS.escape(x.id)}"]`);
        if (other) other.checked = box.checked;
      }
    });
    const who = el('span', { title: a.spender.address }, a.spender.label ? `${a.spender.label} (${window.RB.short(a.spender.address)})` : window.RB.short(a.spender.address));
    const amount = a.kind === 'nft_all' ? (a.token.symbol || 'NFTs in ' + a.token.address)
      : `${a.allowance.amount === 'unlimited' ? 'unlimited' : a.allowance.amount || a.allowance.raw} ${a.token.symbol || a.token.address}`;
    return el('div', { class: 'approval' }, box,
      el('div', {},
        el('div', { class: 'what' }, el('span', { class: 'sev-badge ' + a.severity }, a.severity), who, ` ${KIND[a.kind]} ${amount}`),
        el('div', { class: 'small muted' },
          a.value_at_risk_usd !== null ? `Could take ${money(a.value_at_risk_usd)} now` : a.kind === 'nft_all' ? 'Not priced (NFTs)' : `Value: ${a.value_note || 'unknown'}`,
          a.expires_at ? ` · expires ${new Date(a.expires_at).toLocaleDateString()}` : '',
          a.last_approved_at ? ` · given ${a.last_approved_at.slice(0, 10)}` : '',
          ` · found by ${a.found_by.join(' and ')}`),
        el('ul', { class: 'reasons' }, a.reasons.map(x => el('li', {}, x.text, ' ', el('span', { class: 'source' }, `(${x.source})`))))));
  }

  async function revoke(c) {
    const msg = `revoke-msg-${c.chain}`;
    const calls = c.revoke_calls.filter(x => x.revokes.some(id => selected.has(id)));
    if (!calls.length) return say(msg, 'Tick the approvals to revoke first.', 'bad');
    if (!state.provider) return say(msg, 'Connect your wallet below first.', 'bad');
    if (state.address.toLowerCase() !== result.owner.toLowerCase()) return say(msg, `These approvals belong to ${result.owner}. Connect that wallet to revoke them.`, 'bad');
    try {
      const chainId = '0x' + c.chain_id.toString(16);
      await switchChain(chainId);
      say(msg, `Your wallet will ask you to sign ${calls.length} transaction${calls.length === 1 ? '' : 's'}…`);
      let sent = false;
      try {
        await request('wallet_sendCalls', [{ version: '2.0.0', chainId, from: state.address, atomicRequired: false, calls: calls.map(x => ({ to: x.to, data: x.data, value: x.value })) }]);
        sent = true;
      } catch (err) {
        if (!(err.code === 4200 || err.code === -32601 || /not supported|unsupported|does not exist/i.test(err.message || ''))) throw err;
      }
      if (!sent) for (const x of calls) await request('eth_sendTransaction', [{ from: state.address, to: x.to, data: x.data, value: x.value }]);
      say(msg, 'Sent. Once your wallet shows them confirmed, use "Free preview" to check again.', 'ok');
      try { sessionStorage.removeItem(STORE); } catch { /* fine */ }
    } catch (err) { say(msg, err.message, 'bad'); }
  }

  // A paid result stays on this page for this tab, so a reload doesn't mean paying again.
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(STORE) || 'null'); } catch { /* storage blocked or old data */ }
  if (saved?.owner && Array.isArray(saved.chains)) { $('a-wallet').value = saved.owner; show(saved); }
})();
