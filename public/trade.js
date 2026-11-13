/* RektBull trading page. The wallet signs everything; this page never sees a key. */
(function () {
  'use strict';
  const { ethers } = window;
  const $ = id => document.getElementById(id);
  const DEFAULT_LIMITS = { trade: 500, day: 10000 };
  const ROUTER_ABI = [
    'function setLimits(uint128 perTradeUsd, uint128 perPeriodUsd, uint32 periodSeconds, uint64 validUntil)',
    'function revoke()',
    'function limits(address) view returns (uint128 perTradeUsd, uint128 perPeriodUsd, uint32 periodSeconds, uint64 validUntil)',
  ];

  // The wallet connection and sign-in are the shared ones (common.js); this page adds its own state.
  const RB = window.RB;
  const state = Object.assign(RB.state, { config: null, proposal: null });
  const { el, say, api, short, switchChain } = RB;
  const req = RB.request;

  RB.onSignedIn(afterSignIn);
  async function afterSignIn() {
    if (!state.provider) return; // signed in on an earlier page: wait until the wallet is connected here
    state.config = await api('GET', '/v1/trading/config');
    for (const id of ['trade-card', 'protect-card', 'history-card', 'settings-card', 'limits-card']) $(id).hidden = false;
    if (!state.config.enabled) say('trade-msg', 'Trading is switched off on this server for now.', 'bad');
    showChains();
    prefill();
    showSide();
    showProtect();
    showAutoNetwork();
    await Promise.all([loadSettings(), loadHistory(), loadLimits()]);
  }

  /* The networks for trades the user signs, and each one's base assets (from the server's config). */
  const chainHex = name => '0x' + Number(state.config.chains[name].chain_id).toString(16);
  function showChains() {
    const chains = state.config?.chains || {};
    const keep = $('chain').value;
    $('chain').replaceChildren(...Object.entries(chains).map(([k, c]) => el('option', { value: k }, c.label || k)));
    if (chains[keep]) $('chain').value = keep;
    showBases();
  }
  function showBases() {
    const c = state.config?.chains?.[$('chain').value];
    if (!c) return;
    const keep = $('base').value;
    $('base').replaceChildren(...c.bases.map(b => el('option', {}, b)));
    $('base').value = c.bases.includes(keep) ? keep : c.default_base;
  }
  $('chain').addEventListener('change', () => { showBases(); showProtect(); });

  /* ── Protected sending: private networks that keep trades out of the public mempool, and what each speed pays ── */
  const gwei = hex => { const g = Number(BigInt(hex)) / 1e9; return `${g < 0.01 ? g.toFixed(4) : g < 1 ? g.toFixed(3) : g.toFixed(2)} gwei`; };
  async function showProtect() {
    const chain = $('chain').value;
    const p = state.config?.protected_networks?.[chain];
    if (!p) return;
    $('p-chain').textContent = state.config.chains[chain]?.label || chain;
    $('p-note').textContent = p.note || 'Trades you sign go to the public mempool unless your wallet uses a private network, where front-running and sandwich bots can\'t see them coming. Add one with a click; your wallet asks you to confirm.';
    say('p-msg', '');
    $('p-networks').replaceChildren(...p.networks.map(n => el('div', { class: 'protect-net' },
      el('p', {}, el('strong', {}, n.name), ' — ', n.what, ' ', el('a', { href: n.docs, rel: 'noopener', target: '_blank' }, 'Its documentation')),
      n.caveats.length ? el('ul', { class: 'small' }, n.caveats.map(c => el('li', {}, c))) : '',
      el('p', { class: 'small muted' }, 'RPC: ', el('code', {}, n.rpc), ` · chain ID ${parseInt(n.chain_id, 16)}`),
      el('button', { type: 'button', onclick: () => addNetwork(n) }, `Add ${n.name} to my wallet`),
      el('span', { class: 'small ok', id: `p-on-${n.id}`, hidden: true }, ' ✓ your wallet sends through it now'))));
    detectProtected(chain, p);
    try {
      const f = await api('GET', `/v1/trading/fees?chain=${chain}`);
      if ($('chain').value !== chain) return;
      const line = s => { const x = f.speeds[s]; return x.none ? `${s[0].toUpperCase() + s.slice(1)}: ${x.none}` : `${s[0].toUpperCase() + s.slice(1)}: ${gwei(x.max_priority_fee_per_gas)} priority fee (at most ${gwei(x.max_fee_per_gas)} in all)`; };
      $('p-fees').textContent = `Now: ${line('fast')} ${line('fastest')}`;
    } catch (err) { $('p-fees').textContent = `The fees couldn't be read: ${err.message}`; }
  }
  /** 48 Club's own check: an eth_call to 0x…0048 answers 0x30 only through its RPC (asked of the wallet, on that chain). */
  async function detectProtected(chain, p) {
    if (!p.detect) return;
    try {
      if (await req('eth_chainId') !== '0x' + Number(state.config.chains[chain].chain_id).toString(16)) return;
      const r = await req('eth_call', [p.detect.call, 'latest']);
      const on = $(`p-on-${p.detect.network}`);
      if (on) on.hidden = r !== p.detect.answer;
    } catch { /* any other RPC answers with an error: not 48 Club */ }
  }
  async function addNetwork(n) {
    try {
      await req('wallet_addEthereumChain', [{ chainId: n.chain_id, chainName: n.chain_name, rpcUrls: [n.rpc], nativeCurrency: n.currency, blockExplorerUrls: [n.explorer] }]);
      say('p-msg', `Added. Check that ${n.name} is the network your wallet uses for ${state.config.chains[$('chain').value].label}.`, 'ok');
      detectProtected($('chain').value, state.config.protected_networks[$('chain').value]);
    } catch (err) {
      say('p-msg', err.code === 4001 ? 'You declined it in your wallet.'
        : `Your wallet didn't add it (${err.message}). Add it by hand in your wallet's network settings: name ${n.name}, RPC ${n.rpc}, chain ID ${parseInt(n.chain_id, 16)}, currency ${n.currency.symbol}, explorer ${n.explorer}.`, err.code === 4001 ? null : 'bad');
    }
  }

  /** ?chain=&token=&side=&fraction= (a Meme Watch alert's ready-made sell, or a buy from the Launches desk). */
  function prefill() {
    const q = new URLSearchParams(location.search);
    if (q.get('chain') && state.config?.chains?.[q.get('chain')]) { $('chain').value = q.get('chain'); showBases(); }
    if (/^0x[0-9a-fA-F]{40}$/.test(q.get('token') || '')) $('token').value = q.get('token');
    if (['buy', 'sell'].includes(q.get('side'))) { $('side').value = q.get('side'); $('side').dispatchEvent(new Event('change')); }
    const f = Number(q.get('fraction'));
    if (f > 0 && f <= 100) $('fraction').value = String(f);
    const a = Number(q.get('amount')); // a buy button on the token page
    if (a > 0 && a <= 1000000) $('amount').value = String(a);
    if (q.get('token')) { $('trade-card').scrollIntoView({ block: 'start' }); changed(); }
  }

  /* ── 2. trade: checked before the click, one click to the wallet ── */
  // A preview (every check on a firm price) runs as soon as a token is picked, and again when the
  // trade changes. Clicking within 30 seconds of it sends the trade straight to the wallet; the server
  // checks everything again on a fresh price, and refuses if the price is now past the preview's worst case.
  const FRESH_MS = 28 * 1000; // a little under the server's 30 seconds, for the round trip
  const tradeState = { preview: null, previewing: null, seq: 0, ack: false, presets: { buy: [25, 50, 100], sell: [25, 50, 100] } };
  const isSell = () => $('side').value === 'sell';
  const tokenOk = () => /^0x[0-9a-fA-F]{40}$/.test($('token').value.trim());
  const input = () => ({
    chain: $('chain').value, side: $('side').value, base: $('base').value, token: $('token').value.trim(),
    ...(isSell() ? { sell_fraction: Number($('fraction').value) / 100 } : { amount_usd: Number($('amount').value) }),
    ...(tradeState.ack ? { acknowledge_risks: true } : {}),
  });
  const matches = (pv, i) => pv && pv.chain === i.chain && pv.side === i.side && pv.base === i.base && pv.token.toLowerCase() === i.token.toLowerCase();
  const fresh = pv => pv && Date.now() - Date.parse(pv.quoted_at) < FRESH_MS;

  function showSide() {
    const sell = isSell();
    $('amount-wrap').hidden = sell; $('fraction-wrap').hidden = !sell;
    showPresets(); labelGo();
  }
  function showPresets() {
    const sell = isSell();
    const list = sell ? tradeState.presets.sell : tradeState.presets.buy;
    $('presets').replaceChildren(...list.map(v => el('button', { class: 'preset', onclick: () => {
      $(sell ? 'fraction' : 'amount').value = String(v);
      labelGo();
      go();
    } }, sell ? `Sell ${v}%` : `Buy $${v}`)));
  }
  function labelGo() {
    $('go').textContent = isSell() ? `Sell ${Number($('fraction').value) || 0}%` : `Buy $${Number($('amount').value) || 0}`;
  }

  let debounce = null;
  function changed({ keepAck = false } = {}) {
    if (!keepAck) tradeState.ack = false;
    labelGo();
    clearTimeout(debounce);
    tradeState.preview = null;
    tradeState.seq++; // a preview still on its way is for the trade as it was
    $('go').disabled = !(isSell() && tokenOk());
    $('token-link').hidden = !tokenOk() || !['base', 'ethereum', 'arbitrum', 'bsc'].includes($('chain').value);
    $('token-link').href = `/token?chain=${$('chain').value}&token=${$('token').value.trim().toLowerCase()}`;
    if (!tokenOk()) { $('plan').hidden = true; say('trade-msg', ''); return; }
    debounce = setTimeout(previewNow, 500);
  }
  $('side').addEventListener('change', () => { showSide(); changed(); });
  for (const id of ['token', 'amount', 'fraction']) $(id).addEventListener('input', () => changed({ keepAck: id !== 'token' }));
  for (const id of ['chain', 'base']) $(id).addEventListener('change', () => changed({ keepAck: true }));

  /** Runs every check on a firm price and shows it. Resolves to the preview, or null if the trade can't go ahead. */
  async function previewNow() {
    if (!tokenOk() || !state.config?.enabled) return null;
    clearTimeout(debounce);
    const seq = ++tradeState.seq;
    const i = input();
    say('trade-msg', 'Checking…');
    const run = api('POST', '/v1/trading/preview', i).then(pv => {
      if (seq !== tradeState.seq) return null;
      tradeState.preview = pv;
      showPlan(pv);
      $('go').disabled = false;
      say('trade-msg', '');
      return pv;
    }, err => {
      if (seq !== tradeState.seq) return null;
      tradeState.preview = null;
      if (err.data?.needs_acknowledgement) showRisks(err.data);
      else { $('plan').hidden = true; say('trade-msg', err.message, 'bad'); }
      // A sale is how you get out: its button stays on even when the preview couldn't run.
      $('go').disabled = !isSell();
      return null;
    }).finally(() => { if (tradeState.previewing === run) tradeState.previewing = null; });
    tradeState.previewing = run;
    return run;
  }

  function showRisks(data) {
    $('plan').hidden = false;
    $('plan').replaceChildren(
      el('p', { class: 'risk' }, data.message),
      el('ul', {}, (data.risks || []).map(r => el('li', { class: 'risk' }, r.title, ' — ', r.evidence || ''))),
      el('label', {}, el('span', {}, 'I\'ve read these risks and want to go ahead'), el('input', { type: 'checkbox', id: 'ack', onchange: e => { if (e.target.checked) { tradeState.ack = true; previewNow(); } } })),
    );
    say('trade-msg', 'Tick the box to confirm you\'ve read the risks, then trade.', 'bad');
  }

  function showPlan(pv) {
    const s = pv.plan.summary;
    $('plan').hidden = false;
    $('plan').replaceChildren(
      el('p', {}, el('strong', {}, s.text)),
      el('ul', {}, pv.plan.checks.map(c => el('li', { class: 'check-ok' }, c.detail))),
      el('p', {}, s.fee ? `RektBull fee: ${s.fee.amount} ${s.fee.asset} (${s.fee.pct}%), ${s.fee.taken_by || 'taken inside the swap'}.` : 'No RektBull fee on this trade.'),
      el('p', { class: 'muted small', id: 'plan-age' }),
    );
    showAge();
  }
  function showAge() {
    const pv = tradeState.preview;
    if (!pv || !$('plan-age')) return;
    const secs = Math.max(0, Math.round((Date.now() - Date.parse(pv.quoted_at)) / 1000));
    $('plan-age').textContent = fresh(pv)
      ? `Checked ${secs} s ago. A click checks everything again on a fresh price, then your wallet shows the exact transactions to sign.`
      : `Checked ${secs} s ago, so the price is old: a click checks it again first, then asks you to click once more.`;
  }
  setInterval(showAge, 1000);

  $('go').addEventListener('click', () => go());

  /** One click: the checked trade straight to the wallet, on a preview under 30 seconds old. */
  async function go() {
    const clickAt = performance.now();
    if (!tokenOk()) return say('trade-msg', 'Paste the token\'s address first.', 'bad');
    if (tradeState.previewing) await tradeState.previewing;
    const i = input();
    let pv = tradeState.preview;
    if (!matches(pv, i) || !fresh(pv)) {
      // Not a preview of this trade, or an old one: check it now, and let the user look before trading.
      pv = await previewNow();
      if (pv) say('trade-msg', 'Checked again on the current price. Click again to trade.');
      if (pv || !isSell()) return;
    }
    $('go').disabled = true;
    let t = null, txHash = null;
    try {
      say('trade-msg', 'Checking again on a fresh price…');
      t = await api('POST', '/v1/trading/trades', { ...i, ...(pv ? { seen: pv.seen } : {}) });
      await switchChain(chainHex(t.chain || i.chain));
      say('trade-msg', 'Confirm in your wallet…');
      const toPrompt = Math.round(performance.now() - clickAt);
      txHash = await sendCalls(t.calls, t.fees);
      await api('POST', `/v1/trading/proposals/${t.id}/submitted`, { tx_hash: txHash, click_to_prompt_ms: toPrompt });
      say('trade-msg', `Sent: ${short(txHash)}. RektBull will confirm it onchain.`, 'ok');
      await loadHistory();
      pollUntilDone(t.id);
    } catch (err) {
      if (t && !txHash) await api('POST', `/v1/trading/proposals/${t.id}/cancel`).catch(() => {}); // not sent: nothing is left waiting
      if (['preview_stale', 'price_moved'].includes(err.data?.error)) { await previewNow(); say('trade-msg', err.message, 'bad'); }
      else if (err.data?.needs_acknowledgement) showRisks(err.data);
      else say('trade-msg', err.message, 'bad');
      loadHistory();
    } finally {
      $('go').disabled = !tradeState.preview && !isSell();
    }
  }

  /**
   * Sends the calls: as one batch where the wallet supports it (EIP-5792), else one by one. Returns the swap's hash.
   * With fees (Fast or Fastest), one by one, each with that fee: a batch leaves the fee to the wallet.
   */
  async function sendCalls(bundle, fees = null) {
    const calls = bundle.calls.map(c => ({ to: c.to, data: c.data, value: c.value }));
    const fee = fees?.max_fee_per_gas ? { maxFeePerGas: fees.max_fee_per_gas, maxPriorityFeePerGas: fees.max_priority_fee_per_gas } : null;
    if (!fee) try {
      const res = await req('wallet_sendCalls', [{ version: '2.0.0', chainId: bundle.chainId, from: state.address, atomicRequired: true, calls }]);
      const id = typeof res === 'string' ? res : res.id;
      for (let i = 0; i < 120; i++) {
        const st = await req('wallet_getCallsStatus', [id]);
        const receipts = st.receipts || [];
        if (receipts.length) return receipts[receipts.length - 1].transactionHash;
        if (st.status >= 400) throw new Error('your wallet reported the batch failed');
        await new Promise(r => setTimeout(r, 1500));
      }
      throw new Error('the wallet has not sent the trade yet');
    } catch (err) {
      if (!/method|support|4200|-32601|unsupported/i.test(String(err.code) + ' ' + err.message)) throw err;
    }
    // One at a time: each step waits for the one before it (a curve buy spends what the swap before it delivered).
    let last = null, confirm = null;
    for (const [i, c] of bundle.calls.entries()) {
      last = await req('eth_sendTransaction', [{ from: state.address, to: c.to, data: c.data, value: c.value, ...(c.gas ? { gas: c.gas } : {}), ...(fee || {}) }]);
      if (c.step === (bundle.confirm_step || 'swap')) confirm = last;
      if (i < bundle.calls.length - 1) await waitFor(last);
    }
    return confirm || last;
  }

  async function waitFor(hash) {
    for (let i = 0; i < 120; i++) {
      const r = await req('eth_getTransactionReceipt', [hash]);
      if (r) { if (r.status !== '0x1') throw new Error('a step of this trade failed onchain; nothing after it was sent'); return r; }
      await new Promise(res => setTimeout(res, 1500));
    }
    throw new Error('a step of this trade is taking too long; check your wallet');
  }

  async function pollUntilDone(id) {
    for (let i = 0; i < 60; i++) {
      const p = await api('GET', `/v1/trading/proposals/${id}`).catch(() => null);
      if (p && ['confirmed', 'failed'].includes(p.status)) {
        say('trade-msg', p.status === 'confirmed' ? 'Trade confirmed onchain.' : `Trade failed: ${p.error}`, p.status === 'confirmed' ? 'ok' : 'bad');
        return loadHistory();
      }
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  async function loadHistory() {
    const [{ proposals }, { positions }] = await Promise.all([api('GET', '/v1/trading/proposals'), api('GET', '/v1/trading/positions')]);
    $('history').replaceChildren(...proposals.map(p => el('tr', {},
      el('td', {}, new Date(p.created_at).toLocaleString()), el('td', {}, p.plan?.summary?.text || `${p.side} ${p.token}`), el('td', { class: p.error ? '' : 'status' }, p.status + (p.error ? `: ${p.error}` : '')))));
    $('positions').replaceChildren(...positions.map(p => el('tr', {}, el('td', {}, p.token), el('td', {}, p.amount_raw), el('td', {}, '$' + p.cost_usd.toFixed(2)))));
  }

  /* ── safety settings ── */
  async function loadSettings() {
    const s = await api('GET', '/v1/trading/settings');
    $('s-max').value = s.max_trade_usd; $('s-tax').value = s.max_tax_bps / 100; $('s-loss').value = s.max_round_trip_loss_pct; $('s-slip').value = s.slippage_bps / 100;
    $('s-stop').value = s.stop_loss_pct; $('s-tp').value = s.take_profit_pct; $('s-auto').value = String(s.auto_exit);
    $('s-buys').value = s.buy_presets_usd.join(', '); $('s-sells').value = s.sell_presets_pct.join(', ');
    $('s-speed').value = s.send_speed || 'standard';
    tradeState.presets = { buy: s.buy_presets_usd, sell: s.sell_presets_pct };
    showPresets();
  }
  const list = v => String(v).split(/[\s,]+/).filter(Boolean).map(Number);
  $('s-save').addEventListener('click', async () => {
    try {
      await api('PUT', '/v1/trading/settings', {
        max_trade_usd: Number($('s-max').value), max_tax_bps: Math.round(Number($('s-tax').value) * 100),
        max_round_trip_loss_pct: Number($('s-loss').value), slippage_bps: Math.round(Number($('s-slip').value) * 100),
        stop_loss_pct: Number($('s-stop').value), take_profit_pct: Number($('s-tp').value), auto_exit: $('s-auto').value === 'true',
        buy_presets_usd: list($('s-buys').value), sell_presets_pct: list($('s-sells').value), send_speed: $('s-speed').value,
      });
      say('settings-msg', 'Saved.', 'ok');
      await loadSettings();
      changed({ keepAck: true }); // the limits a preview checked against may have changed
    } catch (err) { say('settings-msg', err.message, 'bad'); }
  });

  /* ── automatic trading limits (written onchain by the user's wallet) ── */
  // Base once the audited router is deployed there (AUTO_TRADING_NETWORKS), else the test network.
  let AUTO_CHAIN = null;
  const net = () => state.config?.automatic_trading?.networks?.[AUTO_CHAIN];
  const autoHex = () => '0x' + Number(AUTO_CHAIN).toString(16);
  const testnet = () => /test/i.test(net()?.label || '');
  function showAutoNetwork() {
    const nets = state.config?.automatic_trading?.networks || {};
    const ids = Object.keys(nets);
    if (!AUTO_CHAIN || !ids.includes(AUTO_CHAIN)) AUTO_CHAIN = ids.includes('8453') ? '8453' : ids[0] || null;
    // One Trade Router per network: with more than one open, the user picks where to trade.
    $('auto-chain').hidden = ids.length < 2;
    $('auto-net').hidden = ids.length >= 2;
    if (ids.length >= 2) {
      $('auto-chain').replaceChildren(...ids.map(id => el('option', { value: id }, nets[id].label)));
      $('auto-chain').value = AUTO_CHAIN;
    }
    $('auto-net').textContent = net() ? net().label : 'not open yet';
    $('auto-gas').textContent = net()?.private_send
      ? `On ${net().label}, automatic trades are sent privately through Flashbots Protect, so nobody can trade ahead of them. RektBull pays the network fee, so an automatic buy has to be large enough for its 1% fee to cover it; you'll be told the minimum.`
      : '';
    $('auto-where').textContent = !net()
      ? 'Automatic trading opens when the audited Trade Router is deployed. Trades you sign yourself work now.'
      : testnet() ? 'Until the audited router is deployed on Base, this runs on the test network with test tokens.' : '';
    $('auto-steps').hidden = !net();
    for (const e of document.querySelectorAll('.only-testnet')) e.hidden = !testnet();
  }
  const router = () => net()?.router;
  const ERC20 = ['function approve(address spender, uint256 amount)', 'function mint(address to, uint256 amount)'];

  function updateWorst() {
    const trade = Number($('l-trade').value), day = Number($('l-day').value), days = Number($('l-days').value);
    const until = new Date(Date.now() + days * 86400000).toLocaleDateString();
    $('worst').textContent = `At most $${day.toLocaleString()} a day can be traded, at most $${trade.toLocaleString()} per trade, only through the RektBull Trade Router, only back into this wallet, until ${until}. RektBull's fee is 1% and the router can't charge more. You can stop it at any time.`;
    $('confirm-wrap').hidden = !(trade > DEFAULT_LIMITS.trade || day > DEFAULT_LIMITS.day);
  }
  for (const id of ['l-trade', 'l-day', 'l-days']) $(id).addEventListener('input', updateWorst);
  updateWorst();

  async function loadLimits() {
    if (!router()) { $('limits-now').textContent = 'Automatic trading isn\'t set up on this server yet.'; return; }
    try {
      const l = await api('GET', '/v1/trading/limits?chain_id=' + AUTO_CHAIN);
      $('smart-status').textContent = l.smart_account ? `✓ This wallet is a MetaMask smart account on ${net().label}.` : `Not yet: this wallet is a plain account on ${net().label}.`;
      $('limits-now').textContent = l.active
        ? `Now: $${l.per_trade_usd.toLocaleString()} per trade, $${l.per_day_usd.toLocaleString()} per day, until ${new Date(l.valid_until * 1000).toLocaleString()}.`
        : 'No limits set: automatic trading is off for this wallet.';
    } catch { $('limits-now').textContent = `Couldn't read your current limits from ${net().label}.`; }
    await loadAuto();
  }
  $('smart-refresh').addEventListener('click', () => loadLimits());
  $('auto-chain').addEventListener('change', () => { AUTO_CHAIN = $('auto-chain').value; showAutoNetwork(); loadLimits(); });

  async function sendTo(to, data, label) {
    await switchChain(autoHex());
    const hash = await req('eth_sendTransaction', [{ from: state.address, to, data }]);
    say('limits-msg', `${label}: sent ${short(hash)}…`);
    await waitFor(hash);
    return hash;
  }

  $('faucet').addEventListener('click', async () => {
    try {
      const t = net().tokens.tUSDC;
      await sendTo(t.address, new ethers.Interface(ERC20).encodeFunctionData('mint', [state.address, 1000n * 10n ** BigInt(t.decimals)]), 'Test tokens');
      say('limits-msg', 'You have 1,000 more test tUSDC.', 'ok');
    } catch (err) { say('limits-msg', err.message, 'bad'); }
  });

  $('allow').addEventListener('click', async () => {
    try {
      const a = await api('GET', '/v1/trading/auto/allowances?chain_id=' + AUTO_CHAIN);
      if (!(a.covers_usd > 0)) throw new Error('Save your limits first: the approvals are sized to them.');
      for (const t of a.tokens) {
        if (!t.amount) continue;
        await sendTo(t.address, new ethers.Interface(ERC20).encodeFunctionData('approve', [a.router, BigInt(t.amount)]), `Allow ${t.symbol}`);
      }
      $('allow-status').textContent = `The router may trade up to $${a.covers_usd.toLocaleString()} of each token: your daily limit times the days left. It still enforces your limits on every trade.`;
      say('limits-msg', 'Approvals done.', 'ok');
    } catch (err) { say('limits-msg', err.message, 'bad'); }
  });

  $('grant').addEventListener('click', async () => {
    try {
      const tpl = await api('GET', '/v1/trading/auto/delegation?chain_id=' + AUTO_CHAIN);
      await switchChain(autoHex());
      say('limits-msg', 'Check the permission in your wallet, then sign…');
      const signature = await req('eth_signTypedData_v4', [state.address, JSON.stringify(tpl.typed_data)]);
      const out = await api('POST', '/v1/trading/permissions', { chain_id: Number(AUTO_CHAIN), wallet_type: 'metamask', delegation: { ...tpl.delegation, signature } });
      say('limits-msg', `Permission granted until ${new Date(out.expires_at).toLocaleString()}.`, 'ok');
      await loadAuto();
    } catch (err) { say('limits-msg', err.message, 'bad'); }
  });

  $('a-buy').addEventListener('click', async () => {
    try {
      await api('POST', '/v1/trading/auto/intents', { chain_id: Number(AUTO_CHAIN), side: 'buy', token: $('a-token').value, amount_usd: Number($('a-amount').value) });
      say('limits-msg', 'Queued: RektBull will make this trade shortly, within your limits.', 'ok');
      await loadAuto();
    } catch (err) { say('limits-msg', err.message, 'bad'); }
  });

  // ── Wallet type: MetaMask, Safe or Coinbase Smart Wallet ──
  const walletType = () => $('w-type').value;
  function showWalletType() {
    for (const t of ['metamask', 'safe', 'coinbase']) {
      for (const e of document.querySelectorAll('.only-' + t)) e.hidden = walletType() !== t;
    }
  }
  $('w-type').addEventListener('change', showWalletType);
  showWalletType();
  const limitsQuery = () => `per_trade_usd=${Number($('l-trade').value)}&per_day_usd=${Number($('l-day').value)}&days=${Number($('l-days').value)}`;
  function checkTypedConfirmation() {
    const trade = Number($('l-trade').value), day = Number($('l-day').value);
    if ((trade > DEFAULT_LIMITS.trade || day > DEFAULT_LIMITS.day) && Number($('l-confirm').value) !== day) {
      throw new Error(`Type ${day} in the box to confirm you understand that much can be traded in a day.`);
    }
  }

  $('safe-setup').addEventListener('click', async () => {
    try {
      checkTypedConfirmation();
      const safe = $('safe-addr').value.trim();
      const r = await api('GET', `/v1/trading/auto/setup?chain_id=${AUTO_CHAIN}&wallet_type=safe&safe=${encodeURIComponent(safe)}&${limitsQuery()}`);
      $('safe-calls').replaceChildren(...r.calls.map(c => el('li', {}, el('strong', {}, c.step), el('br', {}), 'to ', el('code', {}, c.to), el('br', {}), 'data ', el('code', { class: 'data' }, c.data))));
      say('limits-msg', 'Submit these from your Safe, in this order, then press "Link my Safe".', 'ok');
    } catch (err) { say('limits-msg', err.message, 'bad'); }
  });

  $('safe-link').addEventListener('click', async () => {
    try {
      const out = await api('POST', '/v1/trading/permissions', { chain_id: Number(AUTO_CHAIN), wallet_type: 'safe', safe: $('safe-addr').value.trim() });
      say('limits-msg', `Safe linked: RektBull may trade for it until ${new Date(out.expires_at).toLocaleString()}.`, 'ok');
      await loadAuto();
    } catch (err) { say('limits-msg', err.message, 'bad'); }
  });

  let cbSetup = null;
  $('cb-setup').addEventListener('click', async () => {
    try {
      checkTypedConfirmation();
      cbSetup = await api('GET', `/v1/trading/auto/setup?chain_id=${AUTO_CHAIN}&wallet_type=coinbase&${limitsQuery()}`);
      await switchChain(autoHex());
      say('limits-msg', 'Confirm the setup in your wallet…');
      await sendCalls({ chainId: autoHex(), calls: cbSetup.calls });
      say('limits-msg', 'Setup sent. Now press "Link my wallet".', 'ok');
    } catch (err) { say('limits-msg', err.message, 'bad'); }
  });

  $('cb-link').addEventListener('click', async () => {
    try {
      if (!cbSetup) throw new Error('Run "Set up from my wallet" first.');
      const out = await api('POST', '/v1/trading/permissions', { chain_id: Number(AUTO_CHAIN), wallet_type: 'coinbase', spend_permissions: cbSetup.spend_permissions });
      say('limits-msg', `Linked: RektBull may trade for this wallet until ${new Date(out.expires_at).toLocaleString()}.`, 'ok');
      await loadAuto();
    } catch (err) { say('limits-msg', err.message, 'bad'); }
  });

  async function loadAuto() {
    if (!net()) return;
    const tokens = Object.keys(net().tokens).filter(k => k !== net().default_base);
    if (!$('a-token').options.length) $('a-token').replaceChildren(...tokens.map(k => el('option', { value: k }, k)));
    const [{ permissions }, { intents }] = await Promise.all([api('GET', '/v1/trading/permissions'), api('GET', '/v1/trading/auto/intents')]);
    const active = permissions.find(p => p.status === 'active' && String(p.chain_id) === AUTO_CHAIN);
    $('perm-status').textContent = active ? `✓ Granted (${active.wallet_type}), until ${new Date(active.expires_at).toLocaleString()}.` : 'Not granted.';
    const symbol = addr => Object.entries(net().tokens).find(([, t]) => t.address.toLowerCase() === String(addr).toLowerCase())?.[0] || short(addr);
    $('auto-history').replaceChildren(...intents.map(i => el('tr', {},
      el('td', {}, new Date(i.created_at).toLocaleString()),
      el('td', {}, i.side === 'buy' ? `Buy $${i.amount_usd} of ${symbol(i.token)}` : `Sell ${symbol(i.token)}${i.reason ? ' — ' + i.reason : ''}`),
      el('td', {}, i.status + (i.error ? `: ${i.error}` : ''), i.result?.explorer ? el('a', { href: i.result.explorer, target: '_blank', rel: 'noopener' }, ' ↗') : ''))));
  }

  async function routerTx(data) {
    await switchChain(autoHex());
    const hash = await req('eth_sendTransaction', [{ from: state.address, to: router(), data }]);
    say('limits-msg', `Sent ${short(hash)}…`);
    await waitFor(hash);
    await loadLimits();
    return hash;
  }

  $('l-save').addEventListener('click', async () => {
    try {
      const trade = Number($('l-trade').value), day = Number($('l-day').value), days = Number($('l-days').value);
      if (!(trade > 0 && day >= trade && days >= 1 && days <= 30)) throw new Error('Per trade must be above 0, per day at least per trade, and 1 to 30 days.');
      if ((trade > DEFAULT_LIMITS.trade || day > DEFAULT_LIMITS.day) && Number($('l-confirm').value) !== day) {
        throw new Error(`Type ${day} in the box to confirm you understand that much can be traded in a day.`);
      }
      const iface = new ethers.Interface(ROUTER_ABI);
      const data = iface.encodeFunctionData('setLimits', [BigInt(Math.round(trade * 1e8)), BigInt(Math.round(day * 1e8)), 86400, Math.floor(Date.now() / 1000) + days * 86400]);
      await routerTx(data);
      say('limits-msg', 'Limits saved onchain from your wallet.', 'ok');
    } catch (err) { say('limits-msg', err.message, 'bad'); }
  });

  $('l-revoke').addEventListener('click', async () => {
    try {
      const { permissions } = await api('GET', '/v1/trading/permissions');
      for (const p of permissions.filter(x => x.status === 'active')) await api('POST', `/v1/trading/permissions/${p.id}/revoke`);
      await routerTx(new ethers.Interface(ROUTER_ABI).encodeFunctionData('revoke', []));
      say('limits-msg', 'Automatic trading stopped for this wallet.', 'ok');
    } catch (err) { say('limits-msg', err.message, 'bad'); }
  });
})();
