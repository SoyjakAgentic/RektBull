/* RektBull's Perps page (Hyperliquid). Two kinds of signature happen here, and no key ever leaves this page:
 *  - your wallet signs the approvals (a trading key, the builder fee);
 *  - the trading key, made and kept in this browser, signs orders. Only signatures are sent. */
(function () {
  'use strict';
  const { ethers, HLCore: H, RB } = window;
  const $ = id => document.getElementById(id);
  const { el, say, api, short } = RB;
  const hl = { config: null, markets: [], coin: null, account: null, approvals: null, wallet: null, lastNonce: 0 };
  RB.state.hl = hl;

  const fmtUsd = (v, d = 2) => (v === null || v === undefined ? '—' : (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const big = v => (v === null || v === undefined ? '—' : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v).toLocaleString('en-US')}`);
  const px = v => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US', { maximumSignificantDigits: 6 }));
  const pct = (v, d = 2) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`);
  const market = coin => hl.markets.find(m => m.coin === coin);
  const mainnet = () => hl.config.network === 'mainnet';
  const needWallet = () => { if (!RB.state.provider) throw new Error('Connect your wallet first (the button at the top right), so it can sign.'); };

  /* ── markets: open to everyone, signed in or not ── */

  async function loadMarkets() {
    try {
      const out = await api('GET', '/v1/hyperliquid/markets');
      hl.markets = out.markets;
      showMarkets();
      say('markets-msg', `Source: ${out.source} (${out.network}), read at ${new Date(out.as_of).toLocaleTimeString()}. Funding is paid every hour; a positive rate is paid by longs.`);
      if (!hl.coin) pick(new URLSearchParams(location.search).get('coin') || 'BTC');
      else showFacts();
    } catch (err) {
      say('markets-msg', `Hyperliquid's markets couldn't be read: ${err.message}`, 'bad');
      if (!hl.markets.length) $('markets').replaceChildren(el('tr', {}, el('td', { colspan: 7, class: 'muted' }, 'Nothing to show until Hyperliquid can be read.')));
    }
  }
  function showMarkets() {
    const q = $('m-filter').value.trim().toUpperCase();
    const autoOnly = $('m-auto-only').checked;
    const rows = hl.markets.filter(m => (!q || m.coin.toUpperCase().includes(q)) && (!autoOnly || m.auto))
      .sort((a, b) => (b.day_volume_usd || 0) - (a.day_volume_usd || 0));
    $('markets').replaceChildren(...(rows.length ? rows : [null]).map(m => (m ? el('tr', { class: m.coin === hl.coin ? 'sel' : '' },
      el('td', {}, el('button', { class: 'link', onclick: () => pick(m.coin) }, m.coin), m.only_isolated ? el('span', { class: 'tag', title: 'Hyperliquid allows only isolated margin here' }, 'isolated only') : null),
      el('td', { class: 'num' }, px(m.mark_px)),
      el('td', { class: 'num ' + (m.change_24h_pct > 0 ? 'up' : m.change_24h_pct < 0 ? 'down' : '') }, pct(m.change_24h_pct)),
      el('td', { class: 'num' }, m.funding_hourly_pct === null ? '—' : pct(m.funding_hourly_pct, 4)),
      el('td', { class: 'num' }, big(m.open_interest_usd)),
      el('td', { class: 'num' }, big(m.day_volume_usd)),
      el('td', { class: 'num' }, `${m.max_leverage}x`)) : el('tr', {}, el('td', { colspan: 7, class: 'muted' }, 'No market matches.')))));
    const sel = $('o-coin');
    if (sel.options.length !== hl.markets.length) {
      sel.replaceChildren(...hl.markets.map(m => el('option', { value: m.coin }, m.coin)));
      if (hl.coin) sel.value = hl.coin;
    }
  }
  function pick(coin) {
    if (!market(coin)) coin = hl.markets[0]?.coin;
    if (!coin) return;
    hl.coin = coin;
    $('o-coin').value = coin;
    $('o-coin-title').textContent = coin;
    $('l-coin').textContent = coin;
    const m = market(coin);
    $('l-lev').max = m.max_leverage;
    if (Number($('l-lev').value) > m.max_leverage) $('l-lev').value = m.max_leverage;
    const pos = hl.account?.positions?.find(p => p.coin === coin);
    if (pos?.leverage) { $('l-lev').value = pos.leverage; $('l-mode').value = pos.margin_mode === 'isolated' ? 'isolated' : 'cross'; }
    if (m.only_isolated) $('l-mode').value = 'isolated';
    showMarkets(); showFacts(); showPlan();
  }
  function showFacts() {
    const m = market(hl.coin);
    if (!m) return;
    $('o-market-facts').textContent = `${m.coin}: mark ${px(m.mark_px)}, oracle ${px(m.oracle_px)}, funding ${m.funding_hourly_pct === null ? '—' : pct(m.funding_hourly_pct, 4)} an hour, up to ${m.max_leverage}x. Source: Hyperliquid's info API.`;
  }

  /* ── the account: positions, margin, liquidation prices, open orders ── */

  async function loadAccount(fresh) {
    if (!RB.signedIn()) return;
    try {
      const a = await api('GET', '/v1/hyperliquid/account' + (fresh ? '?fresh=1' : ''));
      hl.account = a;
      const tile = (label, value) => el('div', {}, el('div', { class: 'small muted' }, label), el('strong', {}, value));
      $('acct-tiles').replaceChildren(...(a.positions_error ? [] : [
        tile('Account value', fmtUsd(a.account_value_usd)), tile('Margin in use', fmtUsd(a.margin_used_usd)),
        tile('Free to withdraw', fmtUsd(a.withdrawable_usd)), tile('Open positions', fmtUsd(a.position_value_usd)),
      ]));
      say('positions-msg', a.positions_error || '', a.positions_error ? 'bad' : '');
      $('positions').replaceChildren(...(a.positions?.length ? a.positions.map(p => el('tr', {},
        el('td', {}, el('button', { class: 'link', onclick: () => pick(p.coin) }, p.coin)),
        el('td', { class: p.side === 'long' ? 'up' : 'down' }, `${p.side} ${p.leverage ? p.leverage + 'x ' + (p.margin_mode || '') : ''}`),
        el('td', { class: 'num' }, p.size), el('td', { class: 'num' }, px(p.entry_px)), el('td', { class: 'num' }, fmtUsd(p.value_usd)),
        el('td', { class: 'num ' + (p.unrealized_pnl_usd > 0 ? 'up' : p.unrealized_pnl_usd < 0 ? 'down' : '') }, `${fmtUsd(p.unrealized_pnl_usd)} (${pct(p.return_on_equity_pct, 1)})`),
        el('td', { class: 'num' }, p.liquidation_px === null ? 'none while margin covers it' : px(p.liquidation_px)),
        el('td', { class: 'num' }, fmtUsd(p.margin_used_usd)),
        el('td', {}, el('button', { onclick: e => closePosition(p, e.target) }, 'Close')))) : [el('tr', {}, el('td', { colspan: 9, class: 'muted' }, a.positions_error ? '—' : 'No open positions.'))]));
      say('orders-msg', a.open_orders_error || '', a.open_orders_error ? 'bad' : '');
      $('orders').replaceChildren(...(a.open_orders?.length ? a.open_orders.map(o => el('tr', {},
        el('td', {}, o.coin),
        el('td', {}, `${o.side} · ${o.type}${o.reduce_only ? ' · reduce only' : ''}${o.trigger ? ` · ${o.trigger_condition}` : ''}`),
        el('td', { class: 'num' }, px(o.px)), el('td', { class: 'num' }, o.size),
        el('td', {}, el('button', { onclick: e => cancelOrder(o, e.target) }, 'Cancel')))) : [el('tr', {}, el('td', { colspan: 5, class: 'muted' }, a.open_orders_error ? '—' : 'No open orders.'))]));
      $('account-source').textContent = `Source: ${a.source} (${a.network})${a.as_of ? ', as of ' + new Date(a.as_of).toLocaleTimeString() : ''}.`;
    } catch (err) {
      say('positions-msg', `Your account couldn't be read: ${err.message}`, 'bad');
    }
  }

  /* ── the trading key: made here, kept here, approved by the wallet ── */

  const keyName = () => `rb_hl_agent:${hl.config.network}:${hl.wallet}`;
  function storedAgent() {
    try {
      const a = JSON.parse(localStorage.getItem(keyName()) || 'null');
      return a && a.key && a.address ? a : null;
    } catch { return null; }
  }
  /** The key's signer when it's here, approved on Hyperliquid and not expired; else null. */
  function agentSigner() {
    const a = storedAgent();
    if (!a) return null;
    const on = hl.approvals?.agents?.find(x => x.address === a.address.toLowerCase());
    if (hl.approvals?.agents && !on) return null;
    if ((on?.valid_until || a.validUntil) <= Date.now()) return null;
    return new ethers.Wallet(a.key);
  }
  async function loadApprovals() {
    if (!RB.signedIn() || !hl.wallet) return;
    try {
      hl.approvals = await api('GET', '/v1/hyperliquid/approvals?fresh=1');
    } catch (err) {
      hl.approvals = { agents_error: err.message };
    }
    showSetup();
  }
  function showSetup() {
    const a = storedAgent();
    const ap = hl.approvals || {};
    const on = a && ap.agents?.find(x => x.address === a.address.toLowerCase());
    let text; let kind = '';
    if (ap.agents_error) { text = `Whether a trading key is approved couldn't be read: ${ap.agents_error}`; kind = 'bad'; }
    else if (!a) text = ap.agents?.some(x => x.name === hl.config.agent.name) ? 'A RektBull trading key is approved for this account, but not in this browser. Making one here replaces it.' : 'No trading key yet.';
    else if (!on) text = `This browser holds a key (${short(a.address)}) that Hyperliquid doesn't list as approved any more: it expired or was replaced. Make a new one.`;
    else { text = `Trading key ${short(a.address)} is approved until ${new Date(on.valid_until || a.validUntil).toLocaleDateString()}. It can trade; it can't withdraw.`; kind = 'ok'; }
    say('agent-status', text, kind);
    $('agent-approve').textContent = on ? 'Replace it with a new key' : 'Make a trading key and approve it';
    $('agent-approve').className = on ? '' : 'primary';
    $('agent-revoke').hidden = !on;
    if (hl.showFee) hl.showFee();
    $('order-card').hidden = false;
  }

  /** The user's wallet signs a Hyperliquid approval as EIP-712 typed data on the chain it's on. */
  async function walletSign(build) {
    needWallet();
    const chainId = Number(BigInt(await RB.request('eth_chainId')));
    const action = build(chainId);
    const t = H.userTypedData(action);
    const typed = { domain: t.domain, primaryType: t.primaryType, message: t.message, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...t.types } };
    const raw = await RB.request('eth_signTypedData_v4', [RB.state.address, JSON.stringify(typed)]);
    return { action, nonce: action.nonce, signature: H.wireSignature(raw) };
  }
  hl.walletSign = walletSign;
  function nonce() {
    hl.lastNonce = Math.max(Date.now(), hl.lastNonce + 1);
    return hl.lastNonce;
  }

  async function approveAgent() {
    const btn = $('agent-approve');
    btn.disabled = true;
    try {
      const key = ethers.Wallet.createRandom();
      const validUntil = Date.now() + hl.config.agent.days * 86400000;
      say('setup-msg', 'Your wallet will show the approval: a trading key that can trade on Hyperliquid and can\'t withdraw.');
      const signed = await walletSign(chainId => H.approveAgentAction({ mainnet: mainnet(), signatureChainId: chainId, agentAddress: key.address, name: hl.config.agent.name, validUntilMs: validUntil, nonce: nonce() }));
      await api('POST', '/v1/hyperliquid/exchange', signed);
      // Kept only once Hyperliquid has accepted it, and only here.
      localStorage.setItem(keyName(), JSON.stringify({ key: key.privateKey, address: key.address, validUntil }));
      say('setup-msg', 'Approved. The key is stored in this browser only.', 'ok');
      await loadApprovals();
    } catch (err) {
      say('setup-msg', err.message, 'bad');
    } finally { btn.disabled = false; }
  }
  /**
   * Ends the key: Hyperliquid drops an agent when another is approved under the same name. The replacement
   * is an address made here whose key is thrown away at once, approved for a day, so nothing can sign as it.
   */
  async function revokeAgent() {
    const btn = $('agent-revoke');
    btn.disabled = true;
    try {
      say('setup-msg', 'Your wallet will show an approval that replaces the trading key with one nobody holds.');
      const dead = ethers.Wallet.createRandom().address;
      const signed = await walletSign(chainId => H.approveAgentAction({ mainnet: mainnet(), signatureChainId: chainId, agentAddress: dead, name: hl.config.agent.name, validUntilMs: Date.now() + 86400000, nonce: nonce() }));
      await api('POST', '/v1/hyperliquid/exchange', signed);
      localStorage.removeItem(keyName());
      say('setup-msg', 'The trading key is ended and removed from this browser.', 'ok');
      await loadApprovals();
    } catch (err) {
      say('setup-msg', err.message, 'bad');
    } finally { btn.disabled = false; }
  }

  /* ── the fee: a most-per-fill rate the wallet approves once for RektBull's builder address ── */

  hl.feeNeeded = () => !!hl.config.builder.address && !hl.approvals?.builder_fee?.approved;
  hl.showFee = () => {
    const b = hl.config.builder;
    $('fee-box').hidden = false;
    $('fee-note').textContent = b.note;
    const f = hl.approvals?.builder_fee;
    $('fee-approve').hidden = !b.address || !!f?.approved;
    $('fee-revoke').hidden = !b.address || !f?.approved_tenths_bps;
    if (!b.address) return say('fee-status', '');
    if (!f || f.error) return say('fee-status', f?.error || 'Whether the fee is approved couldn\'t be read.', 'bad');
    say('fee-status', f.approved ? `Approved: at most ${b.max_fee_rate} of each fill, to ${short(b.address)}.` : `Not approved yet. Hyperliquid refuses an order that carries a fee you haven't approved.`, f.approved ? 'ok' : '');
  };
  async function approveFee(tenthsBps) {
    try {
      const b = hl.config.builder;
      say('setup-msg', tenthsBps ? `Your wallet will show the approval: at most ${b.max_fee_rate} of each fill, paid to RektBull's builder address by Hyperliquid.` : 'Your wallet will show the approval set to 0%.');
      const signed = await walletSign(chainId => H.approveBuilderFeeAction({ mainnet: mainnet(), signatureChainId: chainId, builder: b.address, tenthsBps, nonce: nonce() }));
      await api('POST', '/v1/hyperliquid/exchange', signed);
      say('setup-msg', tenthsBps ? 'Fee approved.' : 'The fee approval is taken away. Orders that open a position are refused until it\'s approved again.', 'ok');
      await loadApprovals();
    } catch (err) {
      say('setup-msg', err.message, 'bad');
    }
  }
  $('fee-approve').addEventListener('click', () => approveFee(hl.config.builder.fee_tenths_bps));
  $('fee-revoke').addEventListener('click', () => approveFee(0));

  /* ── orders ── */

  /** Signs an L1 action with the trading key and sends the signature through RektBull's relay. */
  async function send(action) {
    const signer = agentSigner();
    if (!signer) throw new Error('Approve a trading key first (step 2).');
    const n = nonce();
    const expiresAfter = n + hl.config.order.expires_seconds * 1000;
    const signature = await H.signL1(signer, action, { nonce: n, mainnet: mainnet(), expiresAfter });
    return api('POST', '/v1/hyperliquid/exchange', { action, nonce: n, signature, expiresAfter });
  }
  const outcome = r => (r.results || []).map(x => (x.filled ? `Filled ${x.size} at ${px(x.avg_px)}.` : x.resting ? `Order ${x.oid} is resting on the book.` : x.error ? `Hyperliquid refused it: ${x.error}` : x.status || 'Done.')).join(' ') || 'Done.';
  const failed = r => (r.results || []).some(x => x.error);
  const builder = () => (hl.config.builder?.address ? { b: hl.config.builder.address, f: hl.config.builder.fee_tenths_bps } : null);

  /** The order the form describes, or a reason it can't be placed. */
  function plan() {
    const m = market(hl.coin);
    if (!m) return { error: 'Pick a market.' };
    const type = $('o-type').value;
    const ref = m.mid_px || m.mark_px;
    if (!(ref > 0)) return { error: `Hyperliquid shows no price for ${m.coin} right now.` };
    const slip = Math.min(Math.max(Number($('o-slip').value) || hl.config.order.slippage_pct, 0.1), hl.config.order.max_slippage_pct) / 100;
    const pos = hl.account?.positions?.find(p => p.coin === m.coin);
    let isBuy = $('o-side').value === 'buy';
    let reduceOnly = $('o-reduce').value === 'true';
    let price; let tif; let trigger; let size; let note;
    if (type === 'tp' || type === 'sl') {
      if (!pos) return { error: `A take-profit or stop-loss closes a position, and you have none in ${m.coin}.` };
      const t = Number($('o-trigger').value);
      if (!(t > 0)) return { error: 'Enter the trigger price.' };
      isBuy = pos.side === 'short';
      reduceOnly = true;
      const wrongSide = type === 'tp' ? (pos.side === 'long' ? t <= ref : t >= ref) : (pos.side === 'long' ? t >= ref : t <= ref);
      if (wrongSide) return { error: `For a ${pos.side}, a ${type === 'tp' ? 'take-profit' : 'stop-loss'} trigger must be ${(type === 'tp') === (pos.side === 'long') ? 'above' : 'below'} the current price (${px(ref)}).` };
      trigger = { triggerPx: H.formatPrice(t, m.sz_decimals), isMarket: true, tpsl: type };
      price = H.slippagePrice(t, isBuy, 0.1, m.sz_decimals); // the worst price a triggered market order may take
      size = H.formatSize(pos.size, m.sz_decimals);
      note = `When ${m.coin} ${isBuy ? 'rises' : 'falls'} to ${trigger.triggerPx}, close your ${pos.side} of ${size} ${m.coin} at the market. Reduce only: it can never open a position.`;
    } else {
      const usd = Number($('o-usd').value);
      if (!(usd > 0)) return { error: 'Enter a size in USD.' };
      if (type === 'limit') {
        const p = Number($('o-px').value);
        if (!(p > 0)) return { error: 'Enter the limit price.' };
        price = H.formatPrice(p, m.sz_decimals, isBuy ? 'down' : 'up');
        tif = 'Gtc';
        size = H.formatSize(usd / Number(price), m.sz_decimals);
        note = `${isBuy ? 'Buy' : 'Sell'} ${size} ${m.coin} at ${price} or better. It rests on the book until it fills or you cancel it.`;
      } else {
        price = H.slippagePrice(ref, isBuy, slip, m.sz_decimals);
        tif = 'Ioc';
        size = H.formatSize(usd / ref, m.sz_decimals);
        note = `${isBuy ? 'Buy' : 'Sell'} ${size} ${m.coin} now, at no worse than ${price} (${(slip * 100).toFixed(1)}% from ${px(ref)}). What doesn't fill at once is cancelled.`;
      }
      if (!(Number(size) > 0)) return { error: `That's less than the smallest ${m.coin} order (${10 ** -m.sz_decimals} ${m.coin}).` };
      if (!reduceOnly && Number(size) * Number(price) < hl.config.order.min_usd) return { error: `Hyperliquid's smallest order is $${hl.config.order.min_usd}.` };
    }
    const b = reduceOnly && hl.feeNeeded() ? null : builder();
    const notional = Number(size) * (trigger ? Number(trigger.triggerPx) : type === 'limit' ? Number(price) : ref);
    const fee = b ? `RektBull's fee: ${(b.f / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}% of what fills (about ${fmtUsd(notional * b.f / 100000, 4)}), taken by Hyperliquid on the fill only, on top of Hyperliquid's own fee.` : 'RektBull takes no fee on this order; Hyperliquid\'s own fee applies.';
    const order = H.orderWire({ asset: m.asset, isBuy, px: price, sz: size, reduceOnly, tif, trigger, cloid: H.cloid() });
    return { m, order, note, fee, action: H.orderAction([order], { builder: b }) };
  }
  function showPlan() {
    const type = $('o-type').value;
    $('o-px-wrap').hidden = type !== 'limit';
    $('o-trigger-wrap').hidden = type !== 'tp' && type !== 'sl';
    for (const id of ['o-usd-wrap', 'o-reduce-wrap']) $(id).hidden = type === 'tp' || type === 'sl';
    $('o-slip-wrap').hidden = type !== 'market';
    $('o-side').disabled = type === 'tp' || type === 'sl';
    if (!hl.config || !hl.markets.length) return;
    const p = plan();
    $('o-plan').hidden = false;
    $('o-plan').replaceChildren(...(p.error ? [el('p', { class: 'muted' }, p.error)] : [el('p', {}, p.note), el('p', { class: 'small muted' }, p.fee)]));
  }
  async function placeOrder() {
    const btn = $('o-go');
    btn.disabled = true;
    try {
      if (!hl.config.enabled) throw new Error('Perps trading is switched off on this server for now.');
      const p = plan();
      if (p.error) throw new Error(p.error);
      if (hl.feeNeeded() && !p.order.r) throw new Error('Approve RektBull\'s fee first (step 2): Hyperliquid refuses an order that carries a fee you haven\'t approved.');
      say('order-msg', 'Signing in this browser and sending…');
      const r = await send(p.action);
      say('order-msg', outcome(r), failed(r) ? 'bad' : 'ok');
      await loadAccount(true);
    } catch (err) {
      say('order-msg', err.message, 'bad');
    } finally { btn.disabled = false; }
  }
  async function closePosition(p, btn) {
    btn.disabled = true;
    try {
      const m = market(p.coin);
      const ref = m?.mid_px || m?.mark_px;
      if (!(ref > 0)) throw new Error(`Hyperliquid shows no price for ${p.coin} right now.`);
      const isBuy = p.side === 'short';
      const order = H.orderWire({ asset: m.asset, isBuy, px: H.slippagePrice(ref, isBuy, hl.config.order.slippage_pct / 100, m.sz_decimals), sz: H.formatSize(p.size, m.sz_decimals), reduceOnly: true, tif: 'Ioc', cloid: H.cloid() });
      const r = await send(H.orderAction([order], { builder: hl.feeNeeded() ? null : builder() })); // a close goes without the fee when the fee isn't approved
      say('positions-msg', `${p.coin}: ${outcome(r)}`, failed(r) ? 'bad' : 'ok');
      await loadAccount(true);
    } catch (err) {
      say('positions-msg', err.message, 'bad');
    } finally { btn.disabled = false; }
  }
  async function cancelOrder(o, btn) {
    btn.disabled = true;
    try {
      const m = market(o.coin);
      if (!m) throw new Error(`${o.coin} isn't in Hyperliquid's market list.`);
      await send(H.cancelAction([{ asset: m.asset, oid: o.oid }]));
      say('orders-msg', `Order ${o.oid} cancelled.`, 'ok');
      await loadAccount(true);
    } catch (err) {
      say('orders-msg', err.message, 'bad');
      btn.disabled = false;
    }
  }
  async function setLeverage() {
    const btn = $('l-set');
    btn.disabled = true;
    try {
      const m = market(hl.coin);
      const lev = Math.floor(Number($('l-lev').value));
      if (!(lev >= 1 && lev <= m.max_leverage)) throw new Error(`${m.coin} takes leverage from 1x to ${m.max_leverage}x.`);
      const isCross = $('l-mode').value === 'cross';
      if (isCross && m.only_isolated) throw new Error(`Hyperliquid allows only isolated margin on ${m.coin}.`);
      await send(H.updateLeverageAction({ asset: m.asset, isCross, leverage: lev }));
      say('lev-msg', `${m.coin} is set to ${lev}x, ${isCross ? 'cross' : 'isolated'} margin.`, 'ok');
      await loadAccount(true);
    } catch (err) {
      say('lev-msg', err.message, 'bad');
    } finally { btn.disabled = false; }
  }

  /* ── start ── */

  RB.onSignedIn(afterSignIn);
  async function afterSignIn() {
    if (!hl.config || !RB.signedIn()) return;
    const me = await api('GET', '/v1/me').catch(() => null);
    hl.wallet = me?.account?.wallet || null;
    $('account-card').hidden = false;
    if (!hl.wallet) return say('positions-msg', 'Hyperliquid accounts belong to EVM wallets. Link one to your account (the Account menu at the top right) to trade perps here.', 'bad');
    $('setup-card').hidden = false;
    await Promise.all([loadAccount(), loadApprovals()]);
    if (hl.afterSignIn) await hl.afterSignIn();
    if (RB.state.hlAuto) await RB.state.hlAuto.load();
    showPlan();
  }

  async function init() {
    try {
      hl.config = await api('GET', '/v1/hyperliquid/config');
    } catch (err) {
      return say('markets-msg', `The Perps page couldn't start: ${err.message}`, 'bad');
    }
    $('net-tag').hidden = mainnet();
    $('deposit-link').href = hl.config.deposit_url;
    $('agent-days').textContent = hl.config.agent.days;
    $('o-slip').value = hl.config.order.slippage_pct; $('o-slip').max = hl.config.order.max_slippage_pct;
    $('o-usd').min = hl.config.order.min_usd;
    if (!hl.config.enabled) say('order-msg', 'Perps trading is switched off on this server for now. Markets and your account can still be viewed.', 'bad');
    else if (hl.config.region?.blocked) say('order-msg', hl.config.region.message, 'bad');
    await loadMarkets();
    setInterval(() => { if (!document.hidden) loadMarkets().then(showPlan); }, 5000);
    setInterval(() => { if (!document.hidden) loadAccount(); }, 10000);
    if (hl.init) hl.init();
    await afterSignIn();
  }
  $('m-filter').addEventListener('input', showMarkets);
  $('m-auto-only').addEventListener('change', showMarkets);
  $('o-coin').addEventListener('change', () => pick($('o-coin').value));
  for (const id of ['o-side', 'o-type', 'o-usd', 'o-px', 'o-trigger', 'o-slip', 'o-reduce']) $(id).addEventListener('input', showPlan);
  $('agent-approve').addEventListener('click', approveAgent);
  $('agent-revoke').addEventListener('click', revokeAgent);
  $('o-go').addEventListener('click', placeOrder);
  $('l-set').addEventListener('click', setLeverage);
  Object.assign(hl, { loadAccount, loadApprovals, market, send, nonce, fmtUsd, px, showPlan });
  init();
})();
