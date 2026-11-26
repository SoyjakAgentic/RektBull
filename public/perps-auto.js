/* The Perps page's automatic trading: the user's wallet approves RektBull's agent wallet with limits.
 * Hyperliquid enforces that the agent can't withdraw or transfer; the limits are enforced by RektBull's
 * trade service, not onchain, and this section says so. Loaded before perps.js, which calls load(). */
(function () {
  'use strict';
  const { ethers, HLCore: H, RB } = window;
  const $ = id => document.getElementById(id);
  const { el, say, api } = RB;
  const hl = () => RB.state.hl;
  let st = null;

  const usd = v => (v === null || v === undefined ? '—' : `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
  const describe = i => (i.side === 'close' ? `Close ${i.coin}` : `${i.side === 'long' ? 'Long' : 'Short'} ${i.coin} ${usd(i.size_usd)} at ${i.leverage}x${i.stop_loss_pct ? `, stop ${i.stop_loss_pct}%` : ''}${i.take_profit_pct ? `, take profit ${i.take_profit_pct}%` : ''}`);
  const outcome = i => (i.status === 'done' ? `Done${i.filled_usd ? `: ${usd(i.filled_usd)} filled` : ''}` : i.status === 'failed' ? `Not done: ${i.error}` : i.status === 'cancelled' ? `Cancelled${i.error ? `: ${i.error}` : ''}` : i.status);

  async function load() {
    try {
      st = await api('GET', '/v1/hyperliquid/auto');
    } catch (err) {
      $('auto-card').hidden = false;
      return say('auto-msg', `Automatic trading couldn't be read: ${err.message}`, 'bad');
    }
    $('auto-card').hidden = false;
    $('auto-hl').textContent = st.enforced_by_hyperliquid;
    $('auto-rb').textContent = st.enforced_by_rektbull;
    $('auto-lose').textContent = st.most_you_can_lose;
    $('auto-off').hidden = !st.why_off;
    $('auto-off').textContent = st.why_off || '';
    $('a-lev').max = st.max_leverage;
    const g = st.grant && st.grant.status === 'active' && new Date(st.grant.valid_until) > new Date() ? st.grant : null;
    $('auto-form').hidden = !!g || !st.enabled;
    $('auto-revoke').hidden = !g;
    say('auto-status', g
      ? `On until ${new Date(g.valid_until).toLocaleString()}: at most ${usd(g.max_trade_usd)} a trade and ${usd(g.max_day_usd)} opened in 24 hours (${usd(st.used_24h_usd)} used), up to ${g.max_leverage}x, ${g.markets ? g.markets.join(', ') : 'any deep market'}.`
      : st.grant ? `Off (${st.grant.status}).` : 'Off.', g ? 'ok' : '');
    $('auto-intents').querySelector('tbody').replaceChildren(...(st.intents.length ? st.intents.map(i => el('tr', {},
      el('td', {}, new Date(i.created_at).toLocaleString()),
      el('td', {}, describe(i), i.reason ? el('div', { class: 'sub' }, i.reason) : ''),
      el('td', {}, outcome(i)),
      el('td', {}, i.status === 'queued' ? el('button', { onclick: () => cancel(i.id) }, 'Cancel') : ''))) : [el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'No automatic orders yet.'))]));
  }

  async function grant() {
    const btn = $('auto-grant');
    btn.disabled = true;
    try {
      const markets = $('a-markets').value.split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
      const limits = { max_trade_usd: Number($('a-trade').value), max_day_usd: Number($('a-day').value), max_leverage: Number($('a-lev').value), markets: markets.length ? markets : null };
      const days = Math.min(Math.max(Math.floor(Number($('a-days').value)) || 30, 1), st.max_days);
      say('auto-msg', 'Your wallet will show the approval: RektBull\'s agent, which can trade on Hyperliquid and can\'t withdraw.');
      const approval = await hl().walletSign(chainId => H.approveAgentAction({ mainnet: hl().config.network === 'mainnet', signatureChainId: chainId, agentAddress: st.agent_address, name: st.agent_name, validUntilMs: Date.now() + days * 86400000 - 10 * 60000, nonce: Date.now() }));
      await api('POST', '/v1/hyperliquid/auto/grant', { approval, limits });
      say('auto-msg', 'Automatic trading is on.', 'ok');
      await load();
    } catch (err) { say('auto-msg', err.message, 'bad'); } finally { btn.disabled = false; }
  }

  async function revoke() {
    if (!window.confirm('Stop automatic trading now? Your wallet will then sign a replacement, so Hyperliquid drops RektBull\'s agent too. Open positions stay open.')) return;
    const btn = $('auto-revoke');
    btn.disabled = true;
    try {
      // The replacement is an address made here whose key is thrown away at once: nobody can sign as it.
      const dead = ethers.Wallet.createRandom().address;
      const approval = await hl().walletSign(chainId => H.approveAgentAction({ mainnet: hl().config.network === 'mainnet', signatureChainId: chainId, agentAddress: dead, name: st.agent_name, validUntilMs: Date.now() + 86400000, nonce: Date.now() })).catch(() => null);
      const out = await api('POST', '/v1/hyperliquid/auto/revoke', approval ? { approval } : {});
      say('auto-msg', `Stopped. ${out.on_hyperliquid}`, 'ok');
      await load();
    } catch (err) { say('auto-msg', err.message, 'bad'); } finally { btn.disabled = false; }
  }

  async function cancel(id) {
    try { await api('DELETE', `/v1/hyperliquid/auto/intents/${id}`); await load(); } catch (err) { say('auto-msg', err.message, 'bad'); }
  }

  $('auto-grant').addEventListener('click', grant);
  $('auto-revoke').addEventListener('click', revoke);
  RB.state.hlAuto = { load };
})();
