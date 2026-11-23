/* Launches: AI picks. Coins RektBull's rules picked, after its safety checks, with the AI's short explanation of the facts;
 * a public scorecard against everything else the rules let through. Acting on a pick costs AI credits and opens the
 * Trade desk, whose checks run again before the wallet signs. */
(function () {
  'use strict';
  const RB = window.RB;
  const { el, say, api } = RB;
  const $ = id => document.getElementById(id);
  const NAMES = { base: 'Base', bsc: 'BNB Chain', solana: 'Solana' };
  const CHECKS = { goplus: 'GoPlus flags', bundle: 'bundle and insider check', mint: 'mint authorities' };
  const pct = v => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v}%`);
  const money = v => (v === null || v === undefined ? '–' : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${Math.round(v)}`);
  const price = v => (v >= 1 ? `$${v.toFixed(2)}` : `$${Number(v).toPrecision(3)}`);

  function rules(r, t, every) {
    $('p-rules').replaceChildren(...[
      `Every ${every} minutes, young coins on Base, BNB Chain and Solana, gathered from GeckoTerminal\'s newest and trending pools and the launchpads\' just-graduated coins, with their figures from DexScreener.`,
      `At least ${money(t.min_liquidity_usd)} of liquidity, ${money(t.min_volume_usd)} traded in 24 hours, and ${t.min_buys} buys.`,
      `Between ${r.min_age_hours} hour and ${r.max_age_days} days old (no first-hour sniping).`,
      `More buys than sells (at least ${r.min_buy_ratio} to 1), but not the one-way buying of a coin that can't be sold (over ${r.max_buy_ratio} to 1).`,
      `The last hour between ${r.min_change_1h_pct}% and +${r.max_change_1h_pct}%, and not up more than ${r.max_change_24h_pct}% in 24 hours: no spike to chase.`,
      'Then ranked by how much trades against the pool, times buying pressure. The top few must pass GoPlus\'s flags (or, on Solana, have no mint or freeze authority left) and, under a week old, the bundle and insider check. A check that can\'t run drops the coin.',
      'The AI only explains the facts the rules read. A reason with a number that isn\'t in those facts is replaced by a plain one.',
    ].map(t2 => el('li', {}, t2)));
  }

  async function score() {
    try {
      const t = await api('GET', '/v1/memes/track-record');
      $('p-how').textContent = t.how;
      const tile = (label, v) => el('div', { class: 'tile' }, el('span', { class: 'small muted' }, label), el('h3', {}, v));
      $('p-score').replaceChildren(...(t.picks.scored_24h ? [
        tile('Picks scored at 24 hours', String(t.picks.scored_24h)),
        tile('Picks: median after 24 hours', pct(t.picks.median_24h_pct)),
        tile('All the rest: median after 24 hours', pct(t.all_passed.median_24h_pct)),
        tile('Picks down half or more in 24 hours', `${t.picks.halved_24h_pct ?? '—'}%`),
      ] : [el('p', { class: 'muted' }, 'No pick has been scored at 24 hours yet: there is no record to show.')]));
      $('p-recent').replaceChildren(...t.recent.map(r => el('tr', {},
        el('td', {}, r.symbol || r.token.slice(0, 8), el('div', { class: 'sub' }, NAMES[r.chain] || r.chain)),
        el('td', {}, new Date(r.picked_at).toLocaleString()), el('td', { class: 'num' }, pct(r.change_1h_pct)), el('td', { class: 'num' }, pct(r.change_24h_pct)))));
    } catch (err) { $('p-how').textContent = `The scorecard couldn't be read: ${err.message}`; }
  }

  /** The price now against the price when picked, or why it couldn't be read; or that the pick has expired. */
  function nowLine(p, s, hours) {
    if (p.status === 'expired') return el('p', { class: 'small muted' }, `Expired: picked over ${hours} hours ago, so the facts behind it are stale. Wait for a fresh pick.`);
    if (!p.now) return '';
    if (p.now.not_checked) return el('p', { class: 'small warn' }, `Price now: couldn't be read (${p.now.not_checked}).`);
    const up = p.now.change_pct >= 0;
    return el('p', { class: 'small' }, el('strong', { class: up ? 'ok' : 'bad' }, `Now ${price(p.now.price_usd)} (${pct(p.now.change_pct)} since the pick)`),
      ' ', el('span', { class: 'muted' }, `· ${p.now.source}, read ${new Date(p.now.read_at).toLocaleTimeString()}. Picks expire after ${hours} hours.`));
  }

  async function load() {
    if (!RB.signedIn()) { $('p-about').textContent = 'Sign in to get AI picks, free. The scorecard below is public.'; return; }
    try {
      const out = await api('GET', '/v1/ai/proposals');
      const m = out.meme;
      rules(m.rules, m.thresholds, m.refresh_minutes);
      const cost = m.price_usd > 0 ? `Acting on a pick costs $${m.price_usd} of AI credits; the trade itself has RektBull's usual 1% fee.` : 'Picks are free; the trade itself has RektBull\'s usual 1% fee.';
      $('p-about').textContent = `${m.about} ${cost}${out.offered.meme ? '' : ' Picks aren\'t switched on yet: RektBull is building the scorecard first.'}`;
      $('p-settings').hidden = false;
      $('p-on').checked = !!out.settings.meme;
      const c = out.ai_credits;
      $('p-credits').textContent = m.price_usd > 0 ? (c ? `AI credits: ${c.left_pct}% of this month's allowance left, $${Number(c.topup_usd).toFixed(2)} top-up.` : 'Acting on a pick needs AI credits (Safety Pro).') : '';
      // Live picks first; expired and dismissed ones after, one line each.
      const live = p => ['offered', 'approved'].includes(p.status);
      const picks = out.proposals.filter(p => p.venue === 'meme' && p.signal).sort((a, b) => live(b) - live(a));
      $('p-list').replaceChildren(...(picks.length ? picks.map(p => {
        const s = p.signal; const f = s.facts || {};
        if (!live(p)) {
          return el('div', { class: 'row proposal muted small' }, el('div', {},
            el('strong', {}, `${s.symbol || s.token.slice(0, 8)} on ${NAMES[p.chain] || p.chain}`), ` · ${p.status} · picked ${new Date(s.picked_at).toLocaleString()} at ${price(s.price_usd)}`,
            p.status === 'expired' ? nowLine(p, s, m.expiry_hours) : ''));
        }
        return el('div', { class: 'row proposal' },
          el('div', {},
            el('strong', {}, `${s.symbol || s.token.slice(0, 8)} on ${NAMES[p.chain] || p.chain}`), ' ',
            el('span', { class: 'small muted' }, `· ${p.status} · picked ${new Date(s.picked_at).toLocaleString()} at ${price(s.price_usd)}${p.paid_from ? ` · $${p.price_usd} from your ${p.paid_from === 'topup' ? 'top-up' : 'allowance'}` : ''}`),
            nowLine(p, s, m.expiry_hours),
            el('p', { class: 'small' }, s.reason),
            el('div', { class: 'small' }, `Liquidity ${money(f.liquidity_usd)}, ${money(f.volume_24h_usd)} traded in 24 hours, ${f.buys_24h} buys to ${f.sells_24h} sells, ${pct(f.change_1h_pct)} in the last hour (${f.source}).`),
            s.risks?.length ? el('ul', { class: 'small' }, ...s.risks.map(r => el('li', { class: 'warn' }, r))) : '',
            el('div', { class: 'small muted' }, 'Checks passed: ', (s.checks || []).map(ch => `${CHECKS[ch.check] || ch.check} (${ch.source})`).join('; ') || 'none recorded', s.model ? ` · explained by ${s.model}` : '')),
          p.status === 'offered' ? el('div', {},
            el('button', { class: 'btn primary', type: 'button', onclick: () => act(p, 'approve') }, p.price_usd > 0 ? `Review the trade ($${p.price_usd})` : 'Review the trade'),
            el('button', { class: 'btn ghost', type: 'button', onclick: () => act(p, 'dismiss') }, 'Dismiss'))
            : p.status === 'approved' ? el('a', { class: 'btn', href: s.trade }, 'Open the trade') : '');
      }) : [el('p', { class: 'muted' }, 'No picks yet.')]));
    } catch (err) { say('p-msg', err.message, 'bad'); }
  }

  /** Approving charges the pick's price once, then opens the Trade desk; its checks run again and the wallet signs. */
  async function act(p, action) {
    try {
      await api('POST', `/v1/ai/proposals/${p.id}/${action}`, {});
      if (action === 'approve') { location.href = p.signal.trade; return; }
      await load();
    } catch (err) { say('p-msg', err.status === 402 ? `${err.message}` : err.message, 'bad'); }
  }

  $('p-on').addEventListener('change', async () => {
    try { await api('PUT', '/v1/ai/proposals/settings', { meme: $('p-on').checked }); say('p-msg', 'Saved.', 'ok'); } catch (err) { say('p-msg', err.message, 'bad'); }
  });
  RB.onSignedIn(load);
  score();
  load();
})();
