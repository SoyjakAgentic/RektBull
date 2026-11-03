/* RektBull Governance: the votes a wallet can cast, summaries of each
 * proposal's own text, and votes the wallet signs (EIP-712, Snapshot's
 * format). RektBull never recommends a choice. */
(function () {
  'use strict';
  const { el, say, api, state, request, short, markdown, switchChain } = window.RB;
  const CHAIN_NAMES = { ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon', bsc: 'BNB Chain' };
  const $ = id => document.getElementById(id);
  const num = v => Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const SUPPORTED = ['single-choice', 'basic', 'approval', 'ranked-choice', 'weighted', 'quadratic'];

  const wallet = () => $('g-wallet').value.trim();
  const fromLink = new URLSearchParams(location.search).get('wallet');
  if (fromLink && /^0x[0-9a-fA-F]{40}$/.test(fromLink)) $('g-wallet').value = fromLink;
  const fill = () => { if (!wallet() && state.address) $('g-wallet').value = state.address; };
  window.RB.onSignedIn(() => { fill(); loadSpaces(); });
  setTimeout(fill, 500);

  $('g-check').addEventListener('click', check);
  async function check() {
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet())) return say('g-msg', 'Enter a wallet address, or connect your wallet below.', 'bad');
    say('g-msg', 'Reading Snapshot…');
    try {
      const r = await api('POST', '/v1/governance/check', { wallet: wallet() });
      show(r);
      say('g-msg', '');
    } catch (err) { say('g-msg', err.message, 'bad'); }
  }

  function show(r) {
    const s = r.summary;
    const spaces = [...new Set([...r.spaces.followed, ...r.spaces.voted_in, ...r.spaces.added])];
    $('g-result').replaceChildren(...[
      el('div', { class: 'facts' },
        el('div', {}, 'Open votes', el('strong', {}, String(s.active))),
        el('div', {}, 'You can still vote on', el('strong', {}, String(s.to_vote))),
        el('div', {}, 'Closing within a day', el('strong', {}, String(s.closing_within_24h))),
      ),
      ...(r.onchain?.governors || []).filter(g => g.needs_delegation).map(delegationBanner),
      el('h3', {}, 'Snapshot (off-chain, no gas)'),
      spaces.length ? null : el('p', {}, 'This wallet doesn\'t follow or vote in any Snapshot space yet. Add one below.'),
      ...r.proposals.map(proposalCard),
      el('h3', {}, 'On-chain governors (a transaction each)'),
      (r.onchain?.governors || []).length
        ? el('p', { class: 'small' }, r.onchain.governors.map(g => `${g.name} (${CHAIN_NAMES[g.chain] || g.chain}): ${Number(g.your_votes || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${g.symbol || ''} votes, delegated ${g.delegated}`).join(' · '))
        : el('p', { class: 'small muted' }, 'No votes or tokens in the on-chain governors RektBull reads (Uniswap, Compound, ENS, Gitcoin, Hop, Arbitrum) or ones you added.'),
      ...(r.onchain?.proposals || []).map(onchainCard),
      r.not_checked.length ? el('p', { class: 'small risk' }, 'Not checked: ', r.not_checked.map(n => `${n.check} (${n.reason})`).join('; ')) : null,
      el('p', { class: 'source' }, `Spaces: ${spaces.join(', ') || 'none'}. Source: ${r.source}. ${r.note}`),
    ].filter(Boolean));
    $('g-result').hidden = false;
  }

  function proposalCard(p) {
    const box = el('div', { class: 'plan', id: `p-${p.id}` });
    const out = el('div', {});
    const scores = p.scores.map(x => `${x.choice}: ${x.score === null ? '–' : num(x.score)}`).join(' · ');
    box.append(
      el('h3', {}, p.title),
      el('div', { class: 'small' }, `${p.space.name || p.space.id} · ${p.type} · closes ${p.end.slice(0, 16).replace('T', ' ')} UTC (in ${p.hours_left} h)`),
      el('div', { class: 'small' }, p.your_voting_power === null ? `Your voting power couldn't be read (${p.voting_power_not_read})` : `Your voting power: ${num(p.your_voting_power)}`,
        p.voted ? el('strong', {}, ` · You voted: ${p.voted.choice}`) : null),
      el('div', { class: 'source' }, `Results so far${p.scores_final ? '' : ' (not final)'}: ${scores}${p.quorum ? ` · quorum ${num(p.quorum.required)} ${p.quorum.reached ? 'reached' : 'not reached'}` : ''}`),
      el('div', { class: 'row' },
        el('button', { onclick: () => summarize(p, out) }, `What it would change${window.RB.priceLabel(window.RB.catalog.products.governance_summary)}`),
        el('a', { href: p.link, rel: 'noopener', class: 'small' }, 'Read it on Snapshot'),
        p.discussion ? el('a', { href: p.discussion, rel: 'noopener', class: 'small' }, 'Discussion') : null),
      p.can_vote_here ? voteForm(p) : (p.why_not_here && !p.voted ? el('p', { class: 'small muted' }, `Can't vote here: ${p.why_not_here}.`) : null),
      out,
    );
    return box;
  }

  async function summarize(p, out) {
    out.replaceChildren(el('p', { class: 'small muted' }, 'Reading the proposal…'));
    try {
      const r = await api('POST', '/v1/governance/summary', { proposal_id: p.id });
      out.replaceChildren(el('div', { class: 'report' }, markdown(r.summary_markdown)),
        r.cut ? el('p', { class: 'small risk' }, r.cut) : null,
        el('p', { class: 'source' }, `${r.source}. Written by ${r.written_by}.${window.RB.paidLabel(r.run)} ${r.note}`));
    } catch (err) {
      out.replaceChildren(el('p', { class: 'msg bad' }, err.status === 402 ? window.RB.paymentMessage(window.RB.catalog.products.governance_summary, err) : err.message));
    }
  }

  /* ── on-chain governors ── */
  function delegationBanner(g) {
    const msg = el('p', { class: 'msg' });
    return el('div', { class: 'worst' }, el('strong', {}, `${g.name}: `), g.needs_delegation, ' ',
      el('button', { onclick: () => send(() => api('POST', '/v1/governance/onchain/delegate/prepare', { wallet: wallet(), chain: g.chain, governor: g.address }), msg, 'Delegated to yourself. Your votes count from the next proposal\'s snapshot.') }, 'Delegate to myself'), msg);
  }

  function onchainCard(p) {
    const box = el('div', { class: 'plan', id: `p-${p.governor.chain}-${p.id}` });
    const out = el('div', {});
    const msg = el('p', { class: 'msg' });
    const t = p.votes ? `For: ${num(p.votes.for)} · Against: ${num(p.votes.against)} · Abstain: ${num(p.votes.abstain)}` : 'not readable';
    const support = el('select', {}, el('option', { value: '1' }, 'For'), el('option', { value: '0' }, 'Against'), el('option', { value: '2' }, 'Abstain'));
    const reason = el('input', { placeholder: 'Reason (optional, public, onchain)', maxlength: '1000' });
    box.append(
      el('h3', {}, p.title),
      el('div', { class: 'small' }, `${p.governor.name} on ${CHAIN_NAMES[p.governor.chain] || p.governor.chain} · ${p.state}${p.deadline ? ` · ends ${p.deadline.at.slice(0, 16).replace('T', ' ')} UTC${p.deadline.estimated ? ' (estimated from block times)' : ''}` : ''}`),
      p.flags ? el('div', { class: 'small risk' }, `If it passes, it ${p.flags.join(', ')}.`) : null,
      el('div', { class: 'small' }, p.your_voting_power === null ? 'Your voting power at its snapshot couldn\'t be read yet' : `Your voting power: ${num(p.your_voting_power)} ${p.governor.symbol || ''}`, p.voted ? el('strong', {}, ` · You voted${p.voted.support ? `: ${p.voted.support}` : ''}`) : null),
      el('div', { class: 'source' }, `Results so far: ${t}${p.quorum ? ` · quorum ${num(p.quorum.required)} (${p.quorum.counts}) ${p.quorum.reached ? 'reached' : 'not reached'}` : ''} · Source: ${p.source}`),
      el('details', { class: 'small' }, el('summary', {}, `What it does onchain (${p.actions.length} action${p.actions.length === 1 ? '' : 's'})`),
        el('ul', {}, p.actions.map(a => el('li', {}, `${a.function} on ${a.target}${a.value_wei !== '0' ? `, sending ${a.value_wei} wei` : ''}${a.args ? ` (${[].concat(a.args).join(', ')})` : ''}`, a.flags ? el('strong', { class: 'risk' }, ` ${a.flags.join(', ')}`) : null)))),
      el('div', { class: 'row' }, el('button', { onclick: () => summarizeOnchain(p, out) }, `What it would change${window.RB.priceLabel(window.RB.catalog.products.governance_summary)}`)),
      p.can_vote_here ? el('div', { class: 'vote' }, el('h4', {}, 'Your vote'), el('label', { class: 'small' }, 'Choice', support), el('label', { class: 'small' }, 'Reason', reason),
        el('div', { class: 'row' }, el('button', { class: 'primary', onclick: () => send(() => api('POST', '/v1/governance/onchain/votes/prepare', { wallet: wallet(), chain: p.governor.chain, governor: p.governor.address, proposal_id: p.id, support: Number(support.value), reason: reason.value }), msg, 'Voted. It shows in the governor\'s results once the transaction confirms.') }, 'Vote (sends a transaction)')), msg)
        : (p.why_not_here && !p.voted ? el('p', { class: 'small muted' }, `Can't vote here: ${p.why_not_here}.`) : null),
      out,
    );
    return box;
  }

  async function summarizeOnchain(p, out) {
    out.replaceChildren(el('p', { class: 'small muted' }, 'Reading the proposal and its actions…'));
    try {
      const r = await api('POST', '/v1/governance/summary', { chain: p.governor.chain, governor: p.governor.address, proposal_id: p.id });
      out.replaceChildren(el('div', { class: 'report' }, markdown(r.summary_markdown)), el('p', { class: 'source' }, `${r.source}. Written by ${r.written_by}.${window.RB.paidLabel(r.run)} ${r.note}`));
    } catch (err) {
      out.replaceChildren(el('p', { class: 'msg bad' }, err.status === 402 ? window.RB.paymentMessage(window.RB.catalog.products.governance_summary, err) : err.message));
    }
  }

  /** Prepares (server-side, simulated) and sends a transaction from the connected wallet. */
  async function send(prepare, msg, done) {
    const set = (t, k) => { msg.textContent = t; msg.className = 'msg' + (k ? ' ' + k : ''); };
    if (!state.provider || !state.address) return set('Connect your wallet below first.', 'bad');
    if (state.address.toLowerCase() !== wallet().toLowerCase()) return set(`Connect the wallet ${short(wallet())}: only it can vote or delegate its own tokens.`, 'bad');
    try {
      set('Preparing and simulating it from your wallet…');
      const prep = await prepare();
      await switchChain(prep.chain_id);
      set(`Check your wallet: ${prep.calls.map(c => c.label).join('; ')}. ${prep.note}`);
      await window.RB.sendCalls(prep, t => set(t));
      set(done, 'ok');
    } catch (err) { set(err.code === 4001 ? 'You cancelled in your wallet. Nothing was sent.' : err.message, 'bad'); }
  }

  /* ── voting ── */
  function voteForm(p) {
    const form = el('div', { class: 'vote' });
    const msg = el('p', { class: 'msg' });
    const multi = p.type === 'approval';
    const ranked = p.type === 'ranked-choice';
    const weighted = p.type === 'weighted' || p.type === 'quadratic';
    const inputs = p.choices.map((c, i) => {
      const n = i + 1;
      if (weighted) return el('label', { class: 'small' }, `${c} (weight)`, el('input', { type: 'number', min: '0', step: '1', value: '0', 'data-n': n }));
      if (ranked) return el('label', { class: 'small' }, `${c} (rank 1 is first)`, el('input', { type: 'number', min: '1', max: String(p.choices.length), value: String(n), 'data-n': n }));
      return el('label', { class: 'small', style: 'display:flex;gap:8px;align-items:center' }, el('input', { type: multi ? 'checkbox' : 'radio', name: `c-${p.id}`, value: String(n) }), c);
    });
    const reason = el('input', { placeholder: 'Reason (optional, public)', maxlength: '1000' });
    const choice = () => {
      if (weighted) return Object.fromEntries(inputs.map(l => l.querySelector('input')).filter(x => Number(x.value) > 0).map(x => [x.dataset.n, Number(x.value)]));
      if (ranked) return inputs.map(l => l.querySelector('input')).sort((a, b) => Number(a.value) - Number(b.value)).map(x => Number(x.dataset.n));
      const picked = inputs.map(l => l.querySelector('input')).filter(x => x.checked).map(x => Number(x.value));
      return multi ? picked : picked[0];
    };
    form.append(el('h4', {}, 'Your vote'), ...inputs, el('label', { class: 'small' }, 'Reason', reason),
      el('div', { class: 'row' }, el('button', { class: 'primary', onclick: () => vote(p, choice(), reason.value, msg) }, 'Sign my vote')), msg);
    return SUPPORTED.includes(p.type) ? form : null;
  }

  async function vote(p, choice, reason, msg) {
    const set = (t, k) => { msg.textContent = t; msg.className = 'msg' + (k ? ' ' + k : ''); };
    if (choice === undefined || (Array.isArray(choice) && !choice.length) || (choice && typeof choice === 'object' && !Array.isArray(choice) && !Object.keys(choice).length)) return set('Pick a choice first.', 'bad');
    if (!state.provider || !state.address) return set('Connect your wallet below first.', 'bad');
    if (state.address.toLowerCase() !== wallet().toLowerCase()) return set(`Connect the wallet ${short(wallet())}: only it can cast its vote.`, 'bad');
    try {
      const prep = await api('POST', '/v1/governance/votes/prepare', { wallet: wallet(), proposal_id: p.id, choice, reason });
      set(`Check your wallet: it asks you to sign a vote for "${prep.vote.choice}" in ${p.space.name || p.space.id}. ${prep.note}`);
      const sig = await request('eth_signTypedData_v4', [state.address, JSON.stringify(prep.typed_data)]);
      const r = await api('POST', '/v1/governance/votes', { message: prep.typed_data.message, sig });
      set(`Voted: ${prep.vote.choice}. ${r.note}`, 'ok');
    } catch (err) { set(err.code === 4001 ? 'You cancelled in your wallet. Nothing was sent.' : err.message, 'bad'); }
  }

  /* ── spaces added by hand ── */
  async function loadSpaces() {
    if (!window.RB.signedIn()) return;
    try {
      const r = await api('GET', '/v1/governance/spaces');
      $('s-list').replaceChildren(...r.spaces.map(id => el('div', {}, id, ' ', el('button', { class: 'link', onclick: () => removeSpace(id) }, 'Remove'))));
    } catch { /* signed out */ }
  }
  $('s-add').addEventListener('click', async () => {
    if (!window.RB.signedIn()) return say('s-msg', 'Sign in first.', 'bad');
    try {
      const r = await api('POST', '/v1/governance/spaces', { space: $('s-id').value.trim() });
      say('s-msg', `Added ${r.added.name || r.added.id}.`, 'ok');
      $('s-id').value = '';
      loadSpaces();
    } catch (err) { say('s-msg', err.message, 'bad'); }
  });
  async function loadGovernors() {
    if (!window.RB.signedIn()) return;
    try {
      const r = await api('GET', '/v1/governance/governors');
      $('gv-list').replaceChildren(...r.governors.map(g => el('div', {}, `${g.name || g.address} (${CHAIN_NAMES[g.chain] || g.chain}) `, el('button', { class: 'link', onclick: () => removeGovernor(g) }, 'Remove'))));
    } catch { /* signed out */ }
  }
  window.RB.onSignedIn(loadGovernors);
  $('gv-add').addEventListener('click', async () => {
    if (!window.RB.signedIn()) return say('s-msg', 'Sign in first.', 'bad');
    try {
      const r = await api('POST', '/v1/governance/governors', { chain: $('gv-chain').value, address: $('gv-address').value.trim() });
      say('s-msg', `Added ${r.added.name || r.added.address} (${r.added.kind}).`, 'ok');
      $('gv-address').value = '';
      loadGovernors();
    } catch (err) { say('s-msg', err.message, 'bad'); }
  });
  async function removeGovernor(g) {
    try { await api('DELETE', `/v1/governance/governors/${g.chain}/${g.address}`); loadGovernors(); } catch (err) { say('s-msg', err.message, 'bad'); }
  }
  async function removeSpace(id) {
    try { await api('DELETE', '/v1/governance/spaces/' + encodeURIComponent(id)); loadSpaces(); } catch (err) { say('s-msg', err.message, 'bad'); }
  }
})();
