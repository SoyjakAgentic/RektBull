/**
 * The rules a move must pass, checked in code against live rates and the
 * wallet's live positions (carried over from soyjak-agentic's
 * rebalanceRules.js). Proposals only offer moves that pass; a move the user
 * asks for is checked again when it's built.
 *
 *   1. The destination's rate is readable from its own contracts. A venue
 *      whose rate can't be read is never a destination.
 *   2. It takes deposits: not frozen, paused or at its supply cap, with room
 *      for this amount.
 *   3. Its utilization is below the ceiling: a market almost fully borrowed
 *      can't pay withdrawals until borrowers repay.
 *   4. A move pays: the destination's APY is at least the minimum gain above
 *      the source's (percentage points).
 *   5. It pays for itself: what it earns over the break-even period at the
 *      APY it gains covers its gas (an upper bound: each step's gas ceiling
 *      at twice the base fee plus the tip, priced by Aave's oracle) and the
 *      move fee.
 *   6. No protocol ends up beyond its share of the wallet's yield money
 *      across every chain (positions, plus idle stablecoins and WETH), once
 *      it's large enough to spread. Only the destination is checked: moving
 *      out lowers a protocol's share.
 *
 * Before all of them: nothing goes into a venue the risk watcher is warning
 * about (risk.js). Leaving a venue that isn't open skips 4 and 5. A
 * withdrawal to the wallet is checked by none of these: money coming home
 * is never refused.
 */
const { ethers } = require('ethers');
const rpc = require('../providers/rpc');
const venues = require('./venues');
const rates = require('./rates');
const { GAS } = require('./calls');

const RULES = {
  min_apy_gain_pct: 1,
  breakeven_days: 30,
  max_utilization_pct: 95,
  max_protocol_share_pct: 60,
  diversify_above_usd: 10000,
};
const r2 = x => Math.round(x * 100) / 100;

/** An upper bound on what gasUnits cost on chain, in dollars. */
async function gasCostUsd(chain, gasUnits) {
  const [block, tip] = await Promise.all([
    rpc.evmRpc(chain, 'eth_getBlockByNumber', ['latest', false]),
    rpc.evmRpc(chain, 'eth_maxPriorityFeePerGas', []).catch(() => '0x0'),
  ]);
  const perGas = BigInt(block?.baseFeePerGas || '0x0') * 2n + BigInt(tip);
  const eth = Number(ethers.formatEther(BigInt(gasUnits) * perGas));
  return eth * await rates.priceUsd(chain, 'WETH');
}

/**
 * Whether a deposit (no source) or move may go ahead. Returns { allowed,
 * reason?, checks }; checks holds every figure it was decided on.
 *   positions: the wallet's positions (positions.read), for rule 6
 *   feeBps: the move fee, counted in rule 5
 *   blocked: venue keys the risk watcher warns about ("protocol:chain:asset" → why)
 */
async function evaluate({ chain, source = null, target, asset, amountUsd, positions = null, feeBps = 0, blocked = {} }) {
  asset = String(asset || '').toUpperCase();
  const checks = { chain, source, target, asset, amount_usd: amountUsd, rules: RULES };
  const refuse = reason => ({ allowed: false, reason, checks });
  if (!(amountUsd > 0)) return refuse('The amount must be above zero.');
  const warned = blocked[`${target}:${chain}:${asset}`];
  if (warned) return refuse(`Nothing goes into ${target} on ${chain} while the risk watcher warns about it: ${warned}`);

  const tv = venues.venue(target, chain);
  if (!tv || tv.status !== 'open' || !tv.assets.includes(asset)) return refuse(`${target} on ${chain} doesn't take ${asset} deposits.`);
  const t = await rates.venueRate(tv, asset, { crossCheck: false });
  checks.target_apy_pct = t.apy_pct;
  checks.target_utilization_pct = t.utilization_pct ?? null;
  if (t.apy_pct === null) return refuse(`${tv.name}'s rate on ${chain} couldn't be read${t.error ? ` (${t.error})` : ''}, so nothing is moved into it.`);
  if (!t.supply_open) return refuse(`${tv.name} on ${chain} isn't taking deposits now${t.flags ? ` (${Object.entries(t.flags).filter(([, x]) => x === true).map(([k]) => k.replace(/_/g, ' ')).join(', ') || 'closed'})` : ''}.`);
  if (t.deposit_room !== null && t.deposit_room !== undefined) {
    const roomUsd = Number(t.deposit_room) * (venues.tokenOf(chain, asset).stable ? 1 : await rates.priceUsd(chain, asset));
    if (amountUsd > roomUsd) return refuse(`${tv.name} on ${chain} has room for ${t.deposit_room} ${asset} more under its supply cap, less than this.`);
  }
  if (t.utilization_pct !== null && t.utilization_pct !== undefined && t.utilization_pct >= RULES.max_utilization_pct) {
    return refuse(`${tv.name} on ${chain} is ${t.utilization_pct}% borrowed, at or above the ${RULES.max_utilization_pct}% ceiling: money there could be hard to withdraw.`);
  }

  const sv = source ? venues.venue(source, chain) : null;
  if (source && (!sv || !sv.assets.includes(asset))) return refuse(`${source} on ${chain} doesn't hold ${asset}.`);
  if (!sv || sv.status === 'open') {
    let gain = t.apy_pct;
    let gas = GAS[tv.kind].deposit + GAS.approve + (feeBps ? GAS.transfer : 0n);
    if (sv) {
      const s = await rates.venueRate(sv, asset, { crossCheck: false });
      checks.source_apy_pct = s.apy_pct;
      if (s.apy_pct === null) return refuse(`${sv.name}'s rate on ${chain} couldn't be read, so the gain from leaving it can't be known.`);
      gain = t.apy_pct - s.apy_pct;
      gas += GAS[sv.kind].withdraw;
      checks.gain_pct = r2(gain);
      if (gain < RULES.min_apy_gain_pct) return refuse(`${tv.name} pays ${t.apy_pct}% and ${sv.name} ${s.apy_pct}%: ${r2(gain)} points more, below the ${RULES.min_apy_gain_pct}-point minimum for a move.`);
    }
    checks.gain_pct = r2(gain);
    const gasUsd = await module.exports.gasCostUsd(chain, gas);
    const feeUsd = amountUsd * feeBps / 10000;
    const earns = amountUsd * gain / 100 * RULES.breakeven_days / 365;
    Object.assign(checks, { gas_usd_max: r2(gasUsd), fee_usd: r2(feeUsd), extra_earnings_usd: r2(earns), extra_per_year_usd: r2(amountUsd * gain / 100) });
    if (earns < gasUsd + feeUsd) {
      return refuse(`$${r2(amountUsd)} earning ${r2(gain)} points more makes about $${r2(earns)} in ${RULES.breakeven_days} days, less than the up to $${r2(gasUsd)} of gas${feeUsd ? ` and $${r2(feeUsd)} fee` : ''} it costs on ${venues.CHAINS[chain].label}.`);
    }
  }

  if (positions) {
    if (positions.not_read.length) return refuse(`The wallet's positions couldn't all be read (${positions.not_read.map(n => `${n.what} on ${n.chain}`).join(', ')}), so the per-protocol limit can't be checked. Not acting on partial data.`);
    const by = {};
    for (const p of positions.positions) by[p.protocol] = (by[p.protocol] || 0) + (p.usd || 0);
    // Deposits and moves both keep the total: idle money becomes a position, or a position moves.
    const total = positions.positions.reduce((t, p) => t + (p.usd || 0), 0) + positions.idle.filter(i => !i.gas).reduce((t, i) => t + (i.usd || 0), 0);
    const share = total > 0 ? ((by[target] || 0) + amountUsd) / total : 1;
    checks.yield_money_usd = r2(total);
    checks.target_share_after_pct = r2(share * 100);
    if (total >= RULES.diversify_above_usd && share * 100 > RULES.max_protocol_share_pct) {
      const room = Math.max(0, RULES.max_protocol_share_pct / 100 * total - (by[target] || 0));
      checks.fits_usd = Math.floor(room); // whole dollars, so what fits is never a rounding hair over the limit
      return refuse(`This would put ${r2(share * 100)}% of the wallet's $${r2(total)} of yield money into ${target}, above the ${RULES.max_protocol_share_pct}% limit per protocol. Up to about $${r2(room)} would fit.`);
    }
  }
  return { allowed: true, checks };
}

module.exports = { RULES, gasCostUsd, evaluate };
