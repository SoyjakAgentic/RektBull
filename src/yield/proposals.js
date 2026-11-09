/**
 * Yield proposals: where a wallet's money could earn more, and the moves,
 * prepared for the wallet to sign. RektBull never signs or holds anything.
 *
 * Proposals come from the numbers, not from a model: for each position and
 * each idle balance, the best venue for that asset on the same chain (by its
 * onchain rate), offered only if the move passes every rule (rules.js) at
 * today's rates and gas. Moves across chains aren't proposed (bridging adds
 * its own risk).
 *
 * A prepared move is: withdraw from the source (to the wallet), the move fee
 * (0.1% of what's moved, a plain transfer to RektBull's fee wallet), an
 * approval of exactly the deposit to the destination when needed, and the
 * deposit (on the wallet's behalf). It's simulated from the wallet before
 * it's offered: every step must succeed, the destination position must
 * grow, and nothing may leave the wallet except into the two venues and the
 * fee. Wallets that can bundle send it all at once (atomicRequired), so the
 * fee is paid only if the move works. A withdrawal to the wallet (an exit)
 * is free and never refused by the rules.
 */
const crypto = require('crypto');
const { ethers } = require('ethers');
const db = require('../config/db');
const env = require('../config/env');
const rpc = require('../providers/rpc');
const presign = require('../services/presign');
const { product } = require('../payments/catalog');
const passes = require('../payments/passes');
const venues = require('./venues');
const rates = require('./rates');
const positions = require('./positions');
const rules = require('./rules');
const calls = require('./calls');

const MIN_USD = 10;
const isAddress = a => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
const lower = a => String(a || '').toLowerCase();
const r2 = x => Math.round(x * 100) / 100;
const { YieldRefused } = venues;

const feeBps = () => product('yield_move').fee_bps;
const feeWallet = () => lower(env.yieldFeeWalletEvm || env.claimFeeWalletEvm) || null;
const blockedNow = () => require('./risk').blocked().catch(() => ({}));

/** Safety Pro covers proposals and prepared moves. */
async function requirePro(accountId) {
  const pass = accountId ? await passes.covering(accountId, 'yield_proposals') : null;
  if (!pass) {
    throw new YieldRefused(accountId ? 'Yield proposals are part of Safety Pro.' : 'Sign in with your wallet: yield proposals are part of Safety Pro.', accountId ? 402 : 401, { offer: { product: 'pro_30d', price_usd: product('pro_30d').price_cents / 100 } });
  }
  return pass;
}

/** The best open venue for an asset on a chain, by onchain rate (other than `except`). */
async function ranked(chain, asset, except) {
  const list = venues.VENUES.filter(v => v.chain === chain && v.status === 'open' && v.assets.includes(asset) && v.protocol !== except);
  const withRates = await Promise.all(list.map(async v => ({ v, rate: await rates.venueRate(v, asset, { crossCheck: false }) })));
  return withRates.filter(x => x.rate.apy_pct !== null).sort((a, b) => b.rate.apy_pct - a.rate.apy_pct);
}

function proposalOf({ chain, asset, from, to, amountUsd, amount, checks }) {
  const kind = from ? 'move' : 'deposit';
  return {
    id: `${kind}:${chain}:${asset}:${from?.protocol || 'wallet'}:${to.protocol}`,
    kind, chain, chain_label: venues.CHAINS[chain].label, asset,
    from: from ? { protocol: from.protocol, name: from.name, apy_pct: checks.source_apy_pct ?? null } : { protocol: null, name: 'Idle in the wallet', apy_pct: 0 },
    to: { protocol: to.protocol, name: to.name, apy_pct: checks.target_apy_pct, utilization_pct: checks.target_utilization_pct },
    amount, amount_usd: r2(amountUsd),
    gain_pct: checks.gain_pct, extra_per_year_usd: checks.extra_per_year_usd, gas_usd_max: checks.gas_usd_max, fee_usd: checks.fee_usd,
    checks,
  };
}

/**
 * What the wallet holds and what it could earn more on. Each proposal names
 * its figures and where they come from; each candidate that didn't pass
 * says why.
 */
async function scan(wallet) {
  const pos = await positions.read(wallet);
  const blocked = await blockedNow();
  const proposals = []; const notProposed = [];
  // What's already proposed counts toward each protocol's share, so the proposals together keep the limit.
  const plan = { ...pos, positions: [...pos.positions], idle: [...pos.idle] };
  const consider = async ({ chain, asset, from, amountUsd, amount }) => {
    // The best venue that passes; each better one that didn't says why.
    for (const { v } of await ranked(chain, asset, from?.protocol)) {
      let usd = amountUsd; let amt = amount;
      let r = await rules.evaluate({ chain, source: from?.protocol || null, target: v.protocol, asset, amountUsd: usd, positions: plan, feeBps: feeBps(), blocked });
      // Too much in one protocol: propose what fits, if it's worth it.
      if (!r.allowed && r.checks.fits_usd >= MIN_USD) {
        const part = r.checks.fits_usd;
        const again = await rules.evaluate({ chain, source: from?.protocol || null, target: v.protocol, asset, amountUsd: part, positions: plan, feeBps: feeBps(), blocked });
        if (again.allowed) { r = again; amt = String(Number(amount) * part / amountUsd); usd = part; }
      }
      if (r.allowed) {
        proposals.push(proposalOf({ chain, asset, from, to: v, amountUsd: usd, amount: amt, checks: r.checks }));
        plan.positions.push({ protocol: v.protocol, usd });
        if (from) plan.positions.push({ protocol: from.protocol, usd: -usd }); else plan.idle.push({ usd: -usd });
        return;
      }
      notProposed.push({ chain, asset, from: from?.name || 'Idle in the wallet', to: v.name, amount_usd: r2(usd), reason: r.reason });
    }
  };
  for (const p of pos.positions) if (p.usd >= MIN_USD && p.status === 'open') await consider({ chain: p.chain, asset: p.asset, from: venues.venue(p.protocol, p.chain), amountUsd: p.usd, amount: p.amount });
  for (const i of pos.idle) if (!i.gas && i.usd >= MIN_USD) await consider({ chain: i.chain, asset: i.asset, from: null, amountUsd: i.usd, amount: i.amount });
  proposals.sort((a, b) => (b.extra_per_year_usd || 0) - (a.extra_per_year_usd || 0));
  return {
    wallet: pos.wallet, read_at: pos.read_at, positions: pos.positions, idle: pos.idle, total_in_positions_usd: pos.total_in_positions_usd,
    proposals, not_proposed: notProposed, not_read: pos.not_read, rules: rules.RULES,
    fee: { bps: feeBps(), rate: `${feeBps() / 100}%` },
    sources: ['Balances read onchain (Multicall3)', 'Rates from each venue\'s own contracts', 'Prices and gas from each chain\'s Aave oracle and RPC'],
    note: 'Proposals are the moves that pass RektBull\'s rules at today\'s rates and gas. They are not financial advice or a recommendation: rates change, and every venue carries smart-contract risk. You decide, and you sign each move yourself.',
  };
}

/** The free summary: positions, and how many proposals (and how much more a year) without which. */
async function summary(wallet) {
  const s = await scan(wallet);
  return {
    wallet: s.wallet, read_at: s.read_at, positions: s.positions, idle: s.idle, total_in_positions_usd: s.total_in_positions_usd, not_read: s.not_read,
    proposals_count: s.proposals.length, extra_per_year_usd: r2(s.proposals.reduce((t, p) => t + (p.extra_per_year_usd || 0), 0)),
    note: 'Safety Pro shows each proposal, with its figures, and prepares the move for your wallet to sign.',
  };
}

/* ── preparing a move ── */

function parseMove(body = {}) {
  const wallet = lower(body?.wallet);
  if (!isAddress(wallet)) return { error: 'wallet must be a wallet address' };
  if (!venues.CHAINS[body.chain]) return { error: `chain must be one of ${Object.keys(venues.CHAINS).join(', ')}` };
  const asset = String(body.asset || '').toUpperCase();
  if (!venues.TOKENS[body.chain][asset]) return { error: `asset must be one of ${Object.keys(venues.TOKENS[body.chain]).join(', ')} on ${body.chain}` };
  const from = body.from ? String(body.from) : null;
  const to = body.to ? String(body.to) : null;
  if (from && !venues.venue(from, body.chain)) return { error: `from: ${from} isn't a venue on ${body.chain}` };
  if (to && !venues.venue(to, body.chain)) return { error: `to: ${to} isn't a venue on ${body.chain}` };
  if (!from && !to) return { error: 'from or to is needed' };
  if (from === to) return { error: 'from and to are the same venue' };
  const all = body.all === true;
  const amountUsd = Number(body.amount_usd);
  if (!all && !(amountUsd > 0 && Number.isFinite(amountUsd))) return { error: 'amount_usd must be above zero (or all: true)' };
  return { wallet, chain: body.chain, asset, from, to, amount_usd: all ? null : amountUsd, all };
}

const step = (kind, label, to, data) => ({ step: kind, label, to: lower(to), data, value: '0x0' });

/** Simulates the steps from the wallet and refuses anything but the move itself. */
async function verify(chain, wallet, steps, { allowed, grows }) {
  let results;
  try { results = await presign.simulate(chain, wallet, steps); } catch (err) {
    throw new YieldRefused(`The move couldn't be simulated on ${venues.CHAINS[chain].label} (${err.message}), so it isn't prepared. Try again later.`, 503);
  }
  const failed = results.findIndex(r => r.status === '0x0' || r.error);
  if (failed >= 0) throw new YieldRefused(`Step ${failed + 1} (${steps[failed].label}) would fail onchain${results[failed].error?.message ? `: ${results[failed].error.message}` : ''}.`);
  const { moves, outgoing, approvalsGiven } = presign.readLogs(wallet, results);
  const bad = outgoing.filter(o => !allowed.has(o.to));
  if (bad.length) throw new YieldRefused(`The simulation shows tokens going to ${bad.map(o => o.to).join(', ')}, which isn't part of this move. Nothing is prepared.`);
  const badApproval = approvalsGiven.find(a => !allowed.has(a.spender));
  if (badApproval) throw new YieldRefused(`The simulation shows an approval to ${badApproval.spender}, which isn't the destination. Nothing is prepared.`);
  if (grows && !(moves[grows] > 0n)) throw new YieldRefused('The simulation doesn\'t show the destination position growing. Nothing is prepared.');
  return results;
}

/**
 * Builds a move (or a deposit from the wallet, or an exit to it) fresh from
 * today's chain: checks it against the rules, adds the fee, simulates it.
 */
async function prepare(input, { accountId = null } = {}) {
  const { wallet, chain, asset, from, to } = input;
  const token = venues.tokenOf(chain, asset);
  const sv = from ? venues.venue(from, chain) : null;
  const tv = to ? venues.venue(to, chain) : null;
  const fmt = u => ethers.formatUnits(u, token.decimals);
  const price = token.stable ? 1 : await rates.priceUsd(chain, asset);
  const exit = !tv;
  if (!exit) await requirePro(accountId);

  // How much: all of the source, or a dollar amount.
  let want = null;
  if (input.all) {
    if (!sv) {
      want = BigInt(await calls.read(chain, token.address, calls.ERC20, 'balanceOf', [wallet]));
      if (want === 0n) throw new YieldRefused(`The wallet holds no ${asset} on ${venues.CHAINS[chain].label}.`);
    }
  } else want = await calls.usdToUnits(chain, asset, input.amount_usd);
  if (sv && want !== null) {
    const h = await calls.held(sv, asset, wallet);
    if (want >= h.units * 999n / 1000n) want = null; // within 0.1% of everything: take it all, interest included
  }
  const amountUsd = want === null ? Number(fmt((await calls.held(sv, asset, wallet)).units)) * price : Number(fmt(want)) * price;

  // The rules (none for an exit).
  let checks = null;
  if (!exit) {
    const pos = await positions.read(wallet);
    const r = await rules.evaluate({ chain, source: from, target: to, asset, amountUsd, positions: pos, feeBps: feeBps(), blocked: await blockedNow() });
    if (!r.allowed) throw new YieldRefused(r.reason);
    checks = r.checks;
  }

  const steps = [];
  let received = want;
  if (sv) {
    const w = await calls.withdrawCall({ v: sv, asset, wallet, want });
    steps.push(step('withdraw', `Withdraw ${want === null ? 'all your' : fmt(want)} ${asset} from ${sv.name}`, w.to, w.data));
    received = w.amountOut; // the deposit takes exactly what arrives (Spark's preview rounds down)
  } else {
    const idle = BigInt(await calls.read(chain, token.address, calls.ERC20, 'balanceOf', [wallet]));
    if (idle < want) throw new YieldRefused(`The wallet holds ${fmt(idle)} ${asset} on ${venues.CHAINS[chain].label}, less than ${fmt(want)}.`);
  }
  if (exit) {
    const allowed = new Set([ethers.ZeroAddress, venues.venueAddress(sv), lower(venues.positionToken(sv, asset))]);
    await verify(chain, wallet, steps, { allowed, grows: token.address });
    return record({ wallet, chain, asset, from, to: null, steps, received, fee: 0n, feeReason: 'exits to your wallet are free', accountId, token, price, checks: null, exit: true });
  }

  // The fee: 0.1% of what's moved, in the asset, unless it's worth less than its gas.
  const fw = feeWallet();
  let fee = 0n; let feeReason = null;
  if (!fw) feeReason = 'no fee wallet is set up on this server';
  else if (fw === wallet) feeReason = 'this is RektBull\'s own fee wallet';
  else {
    fee = received * BigInt(feeBps()) / 10000n;
    const gasUsd = await rules.gasCostUsd(chain, calls.GAS.transfer).catch(() => 0);
    if (fee === 0n) feeReason = 'the amount is too small for a fee';
    else if (Number(fmt(fee)) * price < gasUsd) { fee = 0n; feeReason = `the fee would be worth less than the gas to send it (about $${gasUsd.toFixed(2)})`; }
  }
  const depositUnits = received - fee;
  if (fee > 0n) steps.push(step('fee', `Move fee: ${fmt(fee)} ${asset} (${feeBps() / 100}%) to RektBull`, token.address, calls.ERC20.encodeFunctionData('transfer', [fw, fee])));
  const d = await calls.depositCall({ v: tv, asset, wallet, amount: depositUnits });
  const allowance = BigInt(await calls.read(chain, token.address, calls.ERC20, 'allowance', [wallet, d.spender]));
  // Approve exactly the deposit, never more, and only when what's there isn't enough.
  if (allowance < depositUnits) {
    // USDT (and tokens like it) refuse to change an allowance that isn't zero: set it to zero first.
    if (allowance > 0n) steps.push(step('approve', `Reset ${tv.name}'s ${asset} allowance to zero`, token.address, calls.ERC20.encodeFunctionData('approve', [d.spender, 0])));
    steps.push(step('approve', `Let ${tv.name} take exactly ${fmt(depositUnits)} ${asset}`, token.address, calls.ERC20.encodeFunctionData('approve', [d.spender, depositUnits])));
  }
  steps.push(step('deposit', `Deposit ${fmt(depositUnits)} ${asset} into ${tv.name}`, d.to, d.data));

  const allowed = new Set([ethers.ZeroAddress, venues.venueAddress(tv), lower(venues.positionToken(tv, asset)), ...(fw ? [fw] : []), ...(sv ? [venues.venueAddress(sv), lower(venues.positionToken(sv, asset))] : [])]);
  await verify(chain, wallet, steps, { allowed, grows: lower(venues.positionToken(tv, asset)) });
  return record({ wallet, chain, asset, from, to, steps, received, fee, feeReason, accountId, token, price, checks, exit: false });
}

async function record({ wallet, chain, asset, from, to, steps, received, fee, feeReason, accountId, token, price, checks, exit }) {
  const id = crypto.randomUUID();
  const fmt = u => ethers.formatUnits(u, token.decimals);
  const usd = u => r2(Number(fmt(u)) * price);
  const fw = fee > 0n ? feeWallet() : null;
  if (env.databaseUrl) {
    await db.query(
      `INSERT INTO yield_moves (id, account_id, wallet, chain, asset, from_protocol, to_protocol, amount_raw, fee_raw, fee_bps, fee_wallet, checks)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, accountId, wallet, chain, asset, from, to, received.toString(), fee.toString(), fee > 0n ? feeBps() : 0, fw, JSON.stringify(checks)],
    );
  }
  return {
    move_id: id, wallet, chain, chain_id: ethers.toQuantity(venues.CHAINS[chain].chainId), asset, from, to,
    calls: steps, atomic: steps.length > 1,
    summary: {
      moved: fmt(received), moved_usd: usd(received),
      fee: fmt(fee), fee_usd: usd(fee), fee_reason: feeReason, fee_to: fw,
      deposited: exit ? null : fmt(received - fee),
      ...(checks ? { from_apy_pct: checks.source_apy_pct ?? 0, to_apy_pct: checks.target_apy_pct, gain_pct: checks.gain_pct, extra_per_year_usd: r2((Number(fmt(received - fee)) * price) * checks.gain_pct / 100), gas_usd_max: checks.gas_usd_max } : {}),
    },
    note: exit
      ? 'Your wallet shows one withdrawal, back to this wallet. There\'s no fee.'
      : `Your wallet shows ${steps.length} calls. ${fee > 0n ? `The fee is ${feeBps() / 100}% of what's moved, a plain transfer to RektBull's fee wallet. ` : ''}Wallets that can bundle send them together, so ${fee > 0n ? 'the fee is paid only if the move works' : 'it all happens or none of it does'}. Nothing is approved beyond this deposit, and RektBull never holds your funds.`,
  };
}

/* ── after the wallet sent it ── */

const TRANSFER = ethers.id('Transfer(address,address,uint256)');
async function confirm(moveId, txHashes) {
  const { rows: [m] } = await db.query('SELECT * FROM yield_moves WHERE id = $1', [moveId]);
  if (!m) throw new YieldRefused('No such move.', 404);
  const hashes = [...new Set((Array.isArray(txHashes) ? txHashes : [txHashes]).map(String).filter(h => /^0x[0-9a-fA-F]{64}$/.test(h)))].slice(0, 10);
  if (!hashes.length) throw new YieldRefused('Give the transaction hash(es) the wallet sent.', 400);
  const receipts = await Promise.all(hashes.map(h => rpc.evmRpc(m.chain, 'eth_getTransactionReceipt', [h]).catch(() => null)));
  if (receipts.some(r => !r)) return { status: 'pending', message: 'Not confirmed onchain yet.' };
  const okAll = receipts.every(r => r.status === '0x1');
  const token = venues.tokenOf(m.chain, m.asset).address;
  let feePaid = 0n;
  for (const r of receipts) for (const l of r.logs || []) {
    if (l.topics?.[0] === TRANSFER && lower(l.address) === token && l.topics.length === 3 && lower('0x' + l.topics[1].slice(26)) === m.wallet && m.fee_wallet && lower('0x' + l.topics[2].slice(26)) === m.fee_wallet) feePaid += BigInt(l.data);
  }
  const status = okAll ? 'confirmed' : 'failed';
  await db.query('UPDATE yield_moves SET status = $2, tx_hashes = $3, fee_paid_raw = $4, confirmed_at = now() WHERE id = $1', [moveId, status, JSON.stringify(hashes), feePaid.toString()]);
  return { status, fee_paid: feePaid.toString(), ...(okAll ? {} : { message: 'A step failed onchain.' }) };
}

module.exports = { scan, summary, prepare, parseMove, confirm, requirePro, MIN_USD, feeBps };
