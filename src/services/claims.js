/**
 * Find money: airdrops and rewards a wallet can claim, and the claims
 * prepared for its wallet to sign. RektBull sends nothing and holds nothing.
 *
 * Where it looks (every result names its source):
 *   merkl     Merkl rewards: incentive campaigns (Uniswap, Aave, Morpho,
 *             Euler and many more) on six chains. Merkl's API says what's
 *             owed, with a proof; RektBull checks the proof against the
 *             root, the root against Merkl's Distributor onchain, and reads
 *             what was already claimed onchain. Nothing is offered on
 *             Merkl's word alone.
 *   programs  Merkle airdrops an admin added (airdrop_programs). Each was
 *             checked when it was added (the tree's root is the
 *             distributor's onchain root, sample proofs verify, a claim
 *             simulates), and each lookup checks the proof, the root and
 *             whether it's already claimed, onchain.
 *
 * Checking is free. Claiming through RektBull costs a share of what arrives
 * (5%, 3% with Safety Pro), as a plain ERC-20 transfer to RektBull's fee
 * wallet that the user signs next to the claim: no approval, and the
 * wallet shows it. The share is of what the simulation shows arriving in
 * the wallet, not what the claim says. There's no fee when the token can't
 * be transferred yet, or when the fee is worth less than the gas to send it.
 */
const crypto = require('crypto');
const axios = require('axios');
const { ethers } = require('ethers');
const db = require('../config/db');
const env = require('../config/env');
const { EVM } = require('../providers/chains');
const rpc = require('../providers/rpc');
const prices = require('../providers/prices');
const { track } = require('../providers/usage');
const { cached } = require('../lib/cache');
const merkle = require('../lib/merkle');
const { multicall } = require('./approvals');
const presign = require('./presign');
const tokenRisk = require('./tokenRisk');
const { product } = require('../payments/catalog');
const passes = require('../payments/passes');

const CHAINS = Object.keys(EVM);
const CHAIN_NAMES = { ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon', bsc: 'BNB Chain' };
const nameOf = chain => CHAIN_NAMES[chain] || chain;
const chainById = Object.fromEntries(Object.entries(EVM).map(([k, v]) => [v.chainId, k]));
const NATIVE_PRICE = { ethereum: 'coingecko:ethereum', base: 'coingecko:ethereum', arbitrum: 'coingecko:ethereum', optimism: 'coingecko:ethereum', bsc: 'coingecko:binancecoin', polygon: 'coingecko:polygon-ecosystem-token' };

const MERKL = {
  api: 'https://api.merkl.xyz/v4',
  // The same address on every chain Merkl runs on.
  distributor: '0x3ef3d8ba38ebe18db133cec108f4d14ce00dd9ae',
  iface: new ethers.Interface([
    'function getMerkleRoot() view returns (bytes32)',
    'function claimed(address user, address token) view returns (uint208 amount, uint48 timestamp, bytes32 merkleRoot)',
    'function claim(address[] users, address[] tokens, uint256[] amounts, bytes32[][] proofs)',
  ]),
};
const ERC20 = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
const API_TTL = 10 * 60;
const ROOT_TTL = 5 * 60;
const MAX_TREE_BYTES = 200 * 1024 * 1024;

const lower = a => String(a || '').toLowerCase();
const isAddress = a => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
const big = v => { try { return BigInt(v ?? 0); } catch { return 0n; } };
const units = (raw, decimals) => (decimals === null || decimals === undefined ? null : ethers.formatUnits(raw, decimals));

class ClaimRefused extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}

/* ── the fee ── */

/** The fee rate for this account: 5%, or 3% with an active Safety Pro pass. */
async function feeFor(accountId) {
  const p = product('airdrop_claim');
  const pro = accountId ? await passes.covering(accountId, 'airdrop_claim') : null;
  return { bps: pro ? p.pro_fee_bps : p.fee_bps, pro: !!pro, standard_bps: p.fee_bps, pro_bps: p.pro_fee_bps };
}
const pct = bps => `${bps / 100}%`;

/* ── Merkl ── */

async function merklRewards(wallet) {
  return cached(`merkl:rewards:${wallet}`, API_TTL, async () => {
    const chainId = CHAINS.map(c => EVM[c].chainId).join(',');
    const data = await track('merkl', async () => (await axios.get(`${MERKL.api}/users/${wallet}/rewards`, { params: { chainId }, timeout: 20000 })).data);
    if (!Array.isArray(data)) throw new Error('Merkl answered without a list of rewards');
    const out = [];
    for (const c of data) {
      for (const r of c.rewards || []) {
        out.push({
          chain_id: Number(r.distributionChainId || c.chain?.id),
          dispute_ends: c.chain?.endOfDisputePeriod ? Number(c.chain.endOfDisputePeriod) : null,
          token: lower(r.token?.address), symbol: r.token?.symbol || null, decimals: r.token?.decimals ?? null, price: r.token?.price ?? null,
          amount: String(r.amount || '0'), pending: String(r.pending || '0'), root: r.root, proofs: r.proofs || [],
          campaigns: (r.breakdowns || []).length,
        });
      }
    }
    return out;
  });
}

async function merklFind(wallet) {
  const items = [];
  const notChecked = [];
  let rewards;
  try { rewards = await merklRewards(wallet); } catch (err) {
    return { items, notChecked: [{ check: 'Merkl rewards', reason: `Merkl's API couldn't be reached (${err.message})` }] };
  }
  const byChain = {};
  for (const r of rewards) {
    const chain = chainById[r.chain_id];
    if (!chain || !isAddress(r.token)) continue;
    if (big(r.amount) === 0n && big(r.pending) === 0n) continue;
    (byChain[chain] = byChain[chain] || []).push(r);
  }
  await Promise.all(Object.entries(byChain).map(async ([chain, rs]) => {
    let reads;
    try {
      reads = await multicall(chain, [
        { target: MERKL.distributor, iface: MERKL.iface, fn: 'getMerkleRoot', args: [] },
        ...rs.map(r => ({ target: MERKL.distributor, iface: MERKL.iface, fn: 'claimed', args: [wallet, r.token] })),
      ]);
    } catch (err) {
      notChecked.push({ check: `Merkl rewards on ${nameOf(chain)}`, reason: `the distributor couldn't be read onchain (${err.message})` });
      return;
    }
    const root = reads[0].ok ? reads[0].value[0] : null;
    rs.forEach((r, i) => {
      const read = reads[i + 1];
      if (!read.ok) { notChecked.push({ check: `Merkl ${r.symbol || r.token} on ${nameOf(chain)}`, reason: 'what was already claimed couldn\'t be read onchain' }); return; }
      const total = big(r.amount);
      const claimable = total - big(read.value.amount);
      const pending = big(r.pending);
      if (claimable <= 0n && pending === 0n) return;
      let status = 'claimable';
      let reason = null;
      if (claimable <= 0n) { status = 'pending'; reason = 'Earned, but not in Merkl\'s published rewards yet. It becomes claimable after Merkl\'s next update (usually within hours).'; }
      else if (!merkle.verify('merkl', { account: wallet, token: r.token, amount: total }, r.proofs, r.root)) { status = 'unverified'; reason = 'Merkl\'s proof doesn\'t lead to its own root, so RektBull doesn\'t offer it.'; }
      else if (!merkle.sameHash(root, r.root)) { status = 'updating'; reason = `Merkl is publishing an update, and the distributor still has the previous root. Try again${r.dispute_ends ? ` after ${new Date(r.dispute_ends * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ' in a few hours'}.`; }
      items.push({
        id: `merkl:${EVM[chain].chainId}:${r.token}`, source: 'merkl', source_label: 'Merkl rewards', chain, chain_id: EVM[chain].chainId,
        name: `${r.symbol || 'Token'} rewards${r.campaigns ? ` from ${r.campaigns} Merkl campaign${r.campaigns === 1 ? '' : 's'}` : ''}`,
        token: { address: r.token, symbol: r.symbol, decimals: r.decimals },
        claimable_raw: (claimable > 0n ? claimable : 0n).toString(), pending_raw: pending.toString(),
        status, reason, contract: MERKL.distributor, ends_at: null,
        details_url: `https://app.merkl.xyz/users/${wallet}`,
        checks: status === 'claimable'
          ? ['Merkl\'s proof verified against its root', 'the root is the one onchain in Merkl\'s Distributor', 'what was already claimed read onchain']
          : [],
        _merkl_price: r.price,
        _claim: { kind: 'merkl', token: r.token, amount: total.toString(), proof: r.proofs },
      });
    });
  }));
  return { items, notChecked };
}

/* ── airdrops an admin added ── */

/** "isClaimed(uint256 index)" → a callable fragment; `returns` is added when missing. */
function fragment(sig, returns) {
  const text = String(sig).replace(/^function\s+/, '').trim();
  return ethers.FunctionFragment.from(`function ${text}${returns && !/returns/.test(text) ? ` view returns (${returns})` : ''}`);
}
const ARGS = { index: e => e.idx, account: e => e.account, amount: e => e.amount, proof: e => e.proof };
function argsFor(frag, entry) {
  return frag.inputs.map(i => {
    if (!ARGS[i.name]) throw new ClaimRefused(`the function's parameter "${i.name}" must be named index, account, amount or proof`, 400);
    return ARGS[i.name](entry);
  });
}
const ifaceOf = frag => new ethers.Interface([frag]);

async function onchainRoot(program) {
  return cached(`airdrop:root:${program.id}`, ROOT_TTL, async () => {
    const f = fragment(program.root_signature, 'bytes32');
    const i = ifaceOf(f);
    return i.decodeFunctionResult(f, await rpc.evmRpc(program.chain, 'eth_call', [{ to: program.distributor, data: i.encodeFunctionData(f, []) }, 'latest']))[0];
  });
}

async function programsFind(wallet) {
  const items = [];
  const notChecked = [];
  if (!env.databaseUrl) return { items, notChecked: [{ check: 'Airdrops RektBull added', reason: 'no database is configured' }], count: 0 };
  const [{ rows }, { rows: [{ n }] }] = await Promise.all([
    db.query(
      `SELECT e.idx, e.amount::text AS amount, e.proof, p.id, p.slug, p.name, p.chain, p.distributor, p.token, p.format, p.claim_signature,
              p.claimed_signature, p.root_signature, p.merkle_root, p.official_url, p.source, p.ends_at
       FROM airdrop_entries e JOIN airdrop_programs p ON p.id = e.program_id
       WHERE e.account = $1 AND p.active AND (p.ends_at IS NULL OR p.ends_at > now())`, [wallet]),
    db.query('SELECT count(*)::int AS n FROM airdrop_programs WHERE active AND (ends_at IS NULL OR ends_at > now())'),
  ]);
  await Promise.all(rows.map(async row => {
    const entry = { idx: row.idx === null ? null : String(row.idx), account: wallet, amount: row.amount, proof: row.proof };
    const label = `${row.name} on ${nameOf(row.chain)}`;
    try {
      const claimedFrag = fragment(row.claimed_signature, 'bool');
      const ci = ifaceOf(claimedFrag);
      const [root, claimedRaw] = await Promise.all([
        onchainRoot(row),
        rpc.evmRpc(row.chain, 'eth_call', [{ to: row.distributor, data: ci.encodeFunctionData(claimedFrag, argsFor(claimedFrag, entry)) }, 'latest']),
      ]);
      const claimed = ci.decodeFunctionResult(claimedFrag, claimedRaw)[0];
      if (claimed === true) return; // already claimed: nothing to find
      let status = 'claimable';
      let reason = null;
      if (!merkle.verify(row.format, entry, row.proof, row.merkle_root)) { status = 'unverified'; reason = 'The proof RektBull imported doesn\'t lead to the tree\'s root, so it isn\'t offered.'; }
      else if (!merkle.sameHash(root, row.merkle_root)) { status = 'updating'; reason = 'The distributor\'s root changed since RektBull imported this airdrop, so the proof may be out of date. Claim on the project\'s own site.'; }
      const meta = await tokenMeta(row.chain, row.token);
      items.push({
        id: `program:${row.id}`, source: 'program', source_label: `${row.name} airdrop (${row.source})`, chain: row.chain, chain_id: EVM[row.chain]?.chainId,
        name: row.name, token: { address: lower(row.token), ...meta },
        claimable_raw: String(row.amount), pending_raw: '0',
        status, reason, contract: lower(row.distributor), ends_at: row.ends_at ? new Date(row.ends_at).toISOString() : null,
        details_url: row.official_url,
        checks: status === 'claimable' ? ['the proof verified against the published tree\'s root', 'the root is the one onchain in the distributor', 'not yet claimed, read onchain'] : [],
        _claim: { kind: 'program', signature: row.claim_signature, entry, distributor: lower(row.distributor) },
      });
    } catch (err) {
      notChecked.push({ check: label, reason: `couldn't be read onchain (${err.message})` });
    }
  }));
  return { items, notChecked, count: n };
}

const ERC20_META = new ethers.Interface(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
async function tokenMeta(chain, token) {
  return cached(`tokenmeta:${chain}:${lower(token)}`, 24 * 3600, async () => {
    const read = async fn => ERC20_META.decodeFunctionResult(fn, await rpc.evmRpc(chain, 'eth_call', [{ to: token, data: ERC20_META.encodeFunctionData(fn) }, 'latest']))[0];
    const [symbol, decimals] = await Promise.all([read('symbol').catch(() => null), read('decimals').catch(() => null)]);
    return { symbol, decimals: decimals === null ? null : Number(decimals) };
  });
}

/* ── the free check ── */

async function withPrices(items) {
  const ids = [...new Set(items.map(i => `${i.chain}:${i.token.address}`))];
  let llama = {};
  try { llama = await prices.usdPrices(ids); } catch { llama = {}; }
  for (const i of items) {
    const p = llama[`${i.chain}:${i.token.address}`];
    const price = p ?? (i._merkl_price > 0 ? i._merkl_price : null);
    i.price_usd = price ?? null;
    i.price_source = p ? 'DefiLlama' : price ? 'Merkl' : null;
    const amount = units(i.claimable_raw, i.token.decimals);
    i.claimable = amount;
    i.claimable_usd = price && amount !== null ? Math.round(Number(amount) * price * 100) / 100 : null;
    i.pending = big(i.pending_raw) > 0n ? units(i.pending_raw, i.token.decimals) : null;
  }
  return items;
}

const publicItem = i => Object.fromEntries(Object.entries(i).filter(([k]) => !k.startsWith('_')));

/** Everything the wallet can claim, with internal claim data (prepare uses it). */
async function find(wallet) {
  const [m, p] = await Promise.all([merklFind(wallet), programsFind(wallet)]);
  const items = await withPrices([...m.items, ...p.items]);
  const order = { claimable: 0, updating: 1, pending: 2, unverified: 3 };
  items.sort((a, b) => order[a.status] - order[b.status] || (b.claimable_usd || 0) - (a.claimable_usd || 0));
  return {
    items,
    notChecked: [...m.notChecked, ...p.notChecked],
    sources: [
      { id: 'merkl', name: 'Merkl rewards', covers: 'Incentive rewards from Merkl campaigns (Uniswap, Aave, Morpho, Euler and many more) on Ethereum, Base, Arbitrum, Optimism, Polygon and BNB Chain', read: !m.notChecked.some(n => n.check === 'Merkl rewards') },
      { id: 'programs', name: 'Airdrops RektBull added', covers: `${p.count || 0} Merkle airdrop${p.count === 1 ? '' : 's'} checked by RektBull (listed at GET /v1/claims/programs)`, read: env.databaseUrl ? true : false },
    ],
  };
}

async function check(wallet, { accountId } = {}) {
  const f = await find(wallet);
  const claimable = f.items.filter(i => i.status === 'claimable');
  const fee = await feeFor(accountId);
  return {
    wallet, checked_at: new Date().toISOString(),
    items: f.items.map(publicItem),
    summary: {
      claimable: claimable.length,
      claimable_usd: Math.round(claimable.reduce((t, i) => t + (i.claimable_usd || 0), 0) * 100) / 100,
      not_priced: claimable.filter(i => i.claimable_usd === null).length,
      chains: [...new Set(claimable.map(i => i.chain))],
    },
    sources: f.sources,
    not_checked: f.notChecked,
    fee: { bps: fee.bps, rate: pct(fee.bps), safety_pro: fee.pro, standard_rate: pct(fee.standard_bps), pro_rate: pct(fee.pro_bps) },
    note: `Checking is free. Claim through RektBull and ${pct(fee.bps)} of what arrives goes to RektBull, in a transfer you sign with the claim${fee.pro ? ' (Safety Pro rate)' : `; ${pct(fee.pro_bps)} with Safety Pro`}. Claiming on the project's own site is always free. Nothing found means nothing in these sources, not nothing anywhere.`,
  };
}

/* ── preparing a claim ── */

/** GoPlus's view of the token, cached a day: a honeypot isn't worth claiming through us. */
const tokenFlags = (chain, token) => cached(`claims:goplus:${chain}:${token}`, 24 * 3600, () => tokenRisk.goplus(chain, token));

function claimCalls(wallet, chosen) {
  const calls = [];
  const merkl = chosen.filter(i => i._claim.kind === 'merkl');
  if (merkl.length) {
    calls.push({
      to: MERKL.distributor, value: '0x0',
      data: MERKL.iface.encodeFunctionData('claim', [merkl.map(() => wallet), merkl.map(i => i._claim.token), merkl.map(i => i._claim.amount), merkl.map(i => i._claim.proof)]),
      label: `Claim ${merkl.map(i => i.token.symbol || i.token.address).join(', ')} from Merkl`,
    });
  }
  for (const i of chosen.filter(x => x._claim.kind === 'program')) {
    const f = fragment(i._claim.signature);
    calls.push({ to: i._claim.distributor, value: '0x0', data: ifaceOf(f).encodeFunctionData(f, argsFor(f, i._claim.entry)), label: `Claim ${i.name}` });
  }
  return calls;
}

const failure = results => results.find(r => r.status === '0x0' || r.error);

/** What the claim calls alone deliver to the wallet, from a simulation; refuses anything that isn't a plain claim. */
async function simulateClaims(chain, wallet, calls, chosen) {
  let results;
  try { results = await presign.simulate(chain, wallet, calls); } catch (err) {
    throw new ClaimRefused(`The claim couldn't be simulated on ${nameOf(chain)} (${err.message}), so RektBull won't prepare it. Try again later.`, 503);
  }
  const failed = failure(results);
  if (failed) throw new ClaimRefused(`The claim would fail onchain${failed.error?.message ? `: ${failed.error.message}` : ''}.`);
  const { moves, nfts, approvalsGiven, outgoing } = presign.readLogs(wallet, results);
  if (approvalsGiven.length) throw new ClaimRefused('The simulation shows the claim approving a spender for your tokens. A claim never needs that, so it isn\'t prepared.');
  if (outgoing.length || nfts.some(n => n.direction === 'out')) throw new ClaimRefused('The simulation shows something leaving your wallet. A claim never needs that, so it isn\'t prepared.');
  const received = {};
  for (const i of chosen) {
    const got = moves[i.token.address] || 0n;
    if (got <= 0n) throw new ClaimRefused(`The simulation shows no ${i.token.symbol || i.token.address} arriving in your wallet (it may be set to go to another address). Claim it on ${i.details_url}.`);
    received[i.token.address] = got;
  }
  return received;
}

/**
 * The claim for the chosen items on one chain, with the fee transfers, for
 * the wallet to sign. Recorded so the confirmation can be checked.
 */
async function prepare({ wallet, chain, ids }, { accountId = null } = {}) {
  if (!EVM[chain]) throw new ClaimRefused(`Claims are prepared on ${CHAINS.join(', ')} only.`, 400);
  const f = await find(wallet);
  const chosen = [];
  for (const id of ids) {
    const i = f.items.find(x => x.id === id);
    if (!i) throw new ClaimRefused(`${id} wasn't found for this wallet (already claimed, or no longer in its source).`);
    if (i.chain !== chain) throw new ClaimRefused(`${i.name} is on ${nameOf(i.chain)}; claim each chain on its own.`, 400);
    if (i.status !== 'claimable') throw new ClaimRefused(`${i.name} isn't claimable right now: ${i.reason}`);
    chosen.push(i);
  }
  const warnings = [];
  for (const i of chosen) {
    const gp = await tokenFlags(chain, i.token.address).catch(() => ({ not_checked: 'GoPlus couldn\'t be reached' }));
    if (gp?.honeypot === true || gp?.cannot_sell_all === true) {
      throw new ClaimRefused(`GoPlus flags ${i.token.symbol || i.token.address} as a token that can't be sold, so RektBull won't prepare this claim. You can still claim it on ${i.details_url}.`);
    }
    if (gp?.not_checked) warnings.push(`${i.token.symbol || i.token.address}: GoPlus's token check couldn't run (${gp.not_checked}).`);
    else if (gp?.sell_tax_pct > 10) warnings.push(`${i.token.symbol || i.token.address}: GoPlus reports a ${gp.sell_tax_pct}% tax when you sell it.`);
  }

  const calls = claimCalls(wallet, chosen);
  const received = await simulateClaims(chain, wallet, calls, chosen);

  // The fee: a share of what arrives, in a plain transfer per token.
  const fee = await feeFor(accountId);
  const feeWallet = env.claimFeeWalletEvm || null;
  const lines = chosen.map(i => ({ item: i, received: received[i.token.address], fee: 0n, fee_reason: null }));
  for (const l of lines) {
    if (!feeWallet) l.fee_reason = 'no fee wallet is set up on this server';
    else if (lower(feeWallet) === lower(wallet)) l.fee_reason = 'this is RektBull\'s own fee wallet';
    else l.fee = (l.received * BigInt(fee.bps)) / 10000n;
    if (!l.fee_reason && l.fee === 0n) l.fee_reason = 'the amount is too small for a fee';
  }
  const feeCall = l => ({ to: l.item.token.address, value: '0x0', data: ERC20.encodeFunctionData('transfer', [feeWallet, l.fee]), label: `Claim fee: ${units(l.fee, l.item.token.decimals) ?? l.fee.toString()} ${l.item.token.symbol || ''} (${pct(fee.bps)}) to RektBull` });
  // Each round either drops a fee that can't be sent or checks the whole bundle, so it ends.
  while (lines.some(l => l.fee > 0n)) {
    const charged = lines.filter(l => l.fee > 0n);
    let results;
    try { results = await presign.simulate(chain, wallet, [...calls, ...charged.map(feeCall)]); } catch (err) {
      throw new ClaimRefused(`The claim couldn't be simulated on ${nameOf(chain)} (${err.message}). Try again later.`, 503);
    }
    if (failure(results.slice(0, calls.length))) throw new ClaimRefused('The claim fails when simulated with the fee; try again later.');
    let changed = false;
    charged.forEach((l, k) => {
      const r = results[calls.length + k];
      if (r.status === '0x0' || r.error) { l.fee = 0n; l.fee_reason = 'the token can\'t be transferred yet, so this claim is free'; changed = true; }
      else l.gas = big(r.gasUsed);
    });
    if (changed) continue;
    // Nothing but the fees may leave, and no more than each fee.
    const { outgoing, approvalsGiven } = presign.readLogs(wallet, results);
    const out = {};
    for (const o of outgoing) out[o.token] = (out[o.token] || 0n) + o.amount;
    const bad = approvalsGiven.length || Object.entries(out).some(([t, v]) => v > (charged.find(l => l.item.token.address === t)?.fee || 0n));
    if (bad) throw new ClaimRefused('The simulation with the fee shows more leaving your wallet than the fee. Nothing is prepared.');
    break;
  }
  // No fee worth less than its own gas (when the token has a price).
  if (lines.some(l => l.fee > 0n)) {
    const gasPrice = await rpc.evmRpc(chain, 'eth_gasPrice', []).then(big).catch(() => null);
    const native = await prices.usdPrice(NATIVE_PRICE[chain]).catch(() => null);
    for (const l of lines.filter(x => x.fee > 0n && x.item.price_usd && gasPrice && native)) {
      const feeUsd = Number(units(l.fee, l.item.token.decimals)) * l.item.price_usd;
      const gasUsd = Number(ethers.formatEther((l.gas || 60000n) * gasPrice)) * native;
      if (feeUsd < gasUsd) { l.fee = 0n; l.fee_reason = `the fee (about $${feeUsd.toFixed(2)}) is worth less than the gas to send it (about $${gasUsd.toFixed(2)})`; }
    }
  }
  const charged = lines.filter(l => l.fee > 0n);
  const all = [...calls, ...charged.map(feeCall)];

  const id = crypto.randomUUID();
  const summary = lines.map(l => {
    const t = l.item.token;
    const usdOf = raw => (l.item.price_usd && t.decimals !== null ? Math.round(Number(units(raw, t.decimals)) * l.item.price_usd * 100) / 100 : null);
    return {
      id: l.item.id, name: l.item.name, token: t,
      receive: units(l.received, t.decimals), receive_raw: l.received.toString(), receive_usd: usdOf(l.received),
      fee: units(l.fee, t.decimals), fee_raw: l.fee.toString(), fee_usd: usdOf(l.fee), fee_reason: l.fee_reason,
      keep: units(l.received - l.fee, t.decimals), keep_raw: (l.received - l.fee).toString(),
      price_source: l.item.price_source,
    };
  });
  if (env.databaseUrl) {
    await db.query(
      'INSERT INTO claims (id, account_id, wallet, chain, chain_id, items, fee_bps, fee_wallet) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, accountId, wallet, chain, EVM[chain].chainId, JSON.stringify(summary.map(s => ({ id: s.id, token: s.token.address, symbol: s.token.symbol, decimals: s.token.decimals, receive_raw: s.receive_raw, fee_raw: s.fee_raw, contract: chosen.find(c => c.id === s.id).contract }))), charged.length ? fee.bps : 0, charged.length ? feeWallet : null],
    );
  }
  return {
    claim_id: id, wallet, chain, chain_id: ethers.toQuantity(EVM[chain].chainId),
    calls: all,
    atomic: charged.length > 0,
    summary,
    fee: { bps: charged.length ? fee.bps : 0, rate: pct(fee.bps), safety_pro: fee.pro, to: charged.length ? feeWallet : null },
    warnings,
    note: charged.length
      ? `Your wallet shows ${all.length} call${all.length === 1 ? '' : 's'}: the claim, then ${charged.length === 1 ? 'a transfer' : 'transfers'} of ${pct(fee.bps)} of what arrives to RektBull's fee wallet. Wallets that can bundle them send them together, so the fee is paid only if the claim works. No approval is asked for, and RektBull never holds your tokens.`
      : 'No fee on this claim. Your wallet only shows the claim.',
  };
}

/* ── after the wallet sent it ── */

const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const topicAddr = t => lower('0x' + String(t).slice(26));

/**
 * Reads the receipts of what the wallet sent and records what arrived and
 * what fee was paid. It only records; a receipt nobody can fake is the source.
 */
async function confirm(claimId, txHashes) {
  const { rows: [c] } = await db.query('SELECT * FROM claims WHERE id = $1', [claimId]);
  if (!c) throw new ClaimRefused('No such claim.', 404);
  const hashes = [...new Set((Array.isArray(txHashes) ? txHashes : [txHashes]).map(String).filter(h => /^0x[0-9a-fA-F]{64}$/.test(h)))].slice(0, 10);
  if (!hashes.length) throw new ClaimRefused('Give the transaction hash(es) the wallet sent.', 400);
  const receipts = await Promise.all(hashes.map(h => rpc.evmRpc(c.chain, 'eth_getTransactionReceipt', [h]).catch(() => null)));
  if (receipts.some(r => !r)) return { status: 'pending', message: 'Not confirmed onchain yet.' };
  const items = c.items;
  const tokens = new Set(items.map(i => i.token));
  // Tokens arrive from the distributor, or are minted to the wallet.
  const contracts = new Set([...items.map(i => i.contract), ethers.ZeroAddress]);
  const received = {}; const feePaid = {};
  for (const r of receipts.filter(x => x.status === '0x1')) {
    for (const l of r.logs || []) {
      if (l.topics?.[0] !== TRANSFER || l.topics.length !== 3 || !tokens.has(lower(l.address))) continue;
      const from = topicAddr(l.topics[1]); const to = topicAddr(l.topics[2]); const v = big(l.data);
      if (to === c.wallet && contracts.has(from)) received[lower(l.address)] = ((big(received[lower(l.address)])) + v).toString();
      if (from === c.wallet && c.fee_wallet && to === c.fee_wallet) feePaid[lower(l.address)] = ((big(feePaid[lower(l.address)])) + v).toString();
    }
  }
  const claimed = Object.keys(received).length > 0;
  await db.query(
    `UPDATE claims SET status = $2, tx_hashes = $3, received = $4, fee_paid = $5, confirmed_at = now(), error = $6 WHERE id = $1`,
    [claimId, claimed ? 'confirmed' : 'failed', JSON.stringify(hashes), JSON.stringify(received), JSON.stringify(feePaid), claimed ? null : 'no claimed tokens arrived in these transactions'],
  );
  return { status: claimed ? 'confirmed' : 'failed', received, fee_paid: feePaid, ...(claimed ? {} : { message: 'These transactions didn\'t deliver the claimed tokens.' }) };
}

/* ── adding an airdrop (admins) ── */

const DEFAULTS = {
  uniswap: { claim: 'claim(uint256 index, address account, uint256 amount, bytes32[] proof)', claimed: 'isClaimed(uint256 index)', root: 'merkleRoot()' },
  'oz-standard': { claim: null, claimed: null, root: 'merkleRoot()' },
};

/** Entries from a published tree: [{ idx, account, amount, proof }] and the tree's root. */
function parseTree(format, tree) {
  if (format === 'uniswap') {
    if (!tree?.merkleRoot || !tree.claims || typeof tree.claims !== 'object') throw new ClaimRefused('A Uniswap-format tree has merkleRoot and claims.', 400);
    return {
      root: tree.merkleRoot,
      entries: Object.entries(tree.claims).map(([account, e]) => ({ idx: String(e.index), account: lower(account), amount: big(e.amount).toString(), proof: e.proof })),
    };
  }
  if (format === 'oz-standard') {
    if (tree?.format !== 'standard-v1' || !Array.isArray(tree.tree) || !Array.isArray(tree.values)) throw new ClaimRefused('An OpenZeppelin tree is a StandardMerkleTree dump (format "standard-v1").', 400);
    if (JSON.stringify(tree.leafEncoding) !== JSON.stringify(['address', 'uint256'])) throw new ClaimRefused('Only [address, uint256] OpenZeppelin trees are supported.', 400);
    return {
      root: tree.tree[0],
      entries: tree.values.map(v => ({ idx: null, account: lower(v.value[0]), amount: big(v.value[1]).toString(), proof: merkle.ozProof(tree.tree, v.treeIndex) })),
    };
  }
  throw new ClaimRefused('format must be uniswap or oz-standard', 400);
}

function parseProgram(body = {}) {
  const b = body || {};
  const format = String(b.format || '');
  const d = DEFAULTS[format];
  if (!d) return { error: 'format must be uniswap or oz-standard' };
  const p = {
    slug: String(b.slug || '').toLowerCase(), name: String(b.name || '').trim().slice(0, 80), chain: String(b.chain || ''),
    distributor: lower(b.distributor), token: lower(b.token), format,
    claim_signature: String(b.claim_signature || d.claim || ''), claimed_signature: String(b.claimed_signature || d.claimed || ''), root_signature: String(b.root_signature || d.root),
    tree_url: String(b.tree_url || ''), official_url: String(b.official_url || ''), source: String(b.source || '').trim().slice(0, 200),
    ends_at: b.ends_at ? new Date(b.ends_at) : null,
  };
  if (!/^[a-z0-9-]{2,60}$/.test(p.slug)) return { error: 'slug: 2-60 lowercase letters, digits and dashes' };
  if (!p.name) return { error: 'name is needed' };
  if (!EVM[p.chain]) return { error: `chain must be one of ${CHAINS.join(', ')}` };
  if (!isAddress(p.distributor) || !isAddress(p.token)) return { error: 'distributor and token must be addresses' };
  if (!p.claim_signature || !p.claimed_signature) return { error: 'claim_signature and claimed_signature are needed for this format' };
  for (const u of ['tree_url', 'official_url']) { try { if (new URL(p[u]).protocol !== 'https:') return { error: `${u} must be https` }; } catch { return { error: `${u} must be a URL` }; } }
  if (!p.source) return { error: 'source: who published the tree (e.g. "the project\'s announcement, 1 Nov 2026")' };
  if (p.ends_at && Number.isNaN(p.ends_at.getTime())) return { error: 'ends_at must be a date' };
  try { fragment(p.claim_signature); fragment(p.claimed_signature, 'bool'); fragment(p.root_signature, 'bytes32'); } catch (err) { return { error: `a function signature doesn't parse (${err.message})` }; }
  return p;
}

/**
 * Adds a Merkle airdrop after checking it: the tree's root is the
 * distributor's onchain root, sample proofs verify, and a claim for an
 * unclaimed entry simulates, delivering the token to that account.
 */
async function addProgram(p, adminId, { fetchTree = url => track('airdrop-tree', async () => (await axios.get(url, { timeout: 120000, maxContentLength: MAX_TREE_BYTES, responseType: 'json' })).data) } = {}) {
  const tree = await fetchTree(p.tree_url).catch(err => { throw new ClaimRefused(`The tree couldn't be downloaded (${err.message}).`, 422); });
  const { root, entries } = parseTree(p.format, typeof tree === 'string' ? JSON.parse(tree) : tree);
  if (!entries.length) throw new ClaimRefused('The tree has no entries.');
  const onchain = await onchainRoot({ id: `new:${p.slug}:${Date.now()}`, ...p }).catch(err => { throw new ClaimRefused(`The distributor's root couldn't be read with ${p.root_signature} (${err.message}).`); });
  if (!merkle.sameHash(onchain, root)) throw new ClaimRefused(`The tree's root (${root}) isn't the distributor's onchain root (${onchain}). It may be the wrong file or an old one.`);
  const sample = entries.filter((_, i) => i % Math.max(1, Math.floor(entries.length / 20)) === 0).slice(0, 20);
  const bad = sample.filter(e => !merkle.verify(p.format, e, e.proof, root));
  if (bad.length) throw new ClaimRefused(`${bad.length} of ${sample.length} sample proofs don't verify with the ${p.format} leaf encoding. Check the format.`);

  // A real claim, simulated for the first sampled entry that isn't claimed yet.
  const claimedFrag = fragment(p.claimed_signature, 'bool');
  const ci = ifaceOf(claimedFrag);
  const claimFrag = fragment(p.claim_signature);
  let simulated = null;
  for (const e of sample.slice(0, 5)) {
    const raw = await rpc.evmRpc(p.chain, 'eth_call', [{ to: p.distributor, data: ci.encodeFunctionData(claimedFrag, argsFor(claimedFrag, e)) }, 'latest']);
    if (ci.decodeFunctionResult(claimedFrag, raw)[0] === true) continue;
    const call = { to: p.distributor, data: ifaceOf(claimFrag).encodeFunctionData(claimFrag, argsFor(claimFrag, e)) };
    const results = await presign.simulate(p.chain, e.account, [call]);
    if (failure(results)) throw new ClaimRefused(`A claim for ${e.account} fails when simulated${failure(results).error?.message ? `: ${failure(results).error.message}` : ''}. Check claim_signature.`);
    const { moves } = presign.readLogs(e.account, results);
    if (!(moves[p.token] > 0n)) throw new ClaimRefused(`A simulated claim for ${e.account} didn't deliver ${p.token}.`);
    simulated = { account: e.account, received: moves[p.token].toString() };
    break;
  }

  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: [prog] } = await client.query(
      `INSERT INTO airdrop_programs (slug, name, chain, distributor, token, format, claim_signature, claimed_signature, root_signature, merkle_root, tree_url, official_url, source, ends_at, entries, added_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id, slug, name, chain, entries`,
      [p.slug, p.name, p.chain, p.distributor, p.token, p.format, p.claim_signature, p.claimed_signature, p.root_signature, root, p.tree_url, p.official_url, p.source, p.ends_at, entries.length, adminId],
    );
    for (let i = 0; i < entries.length; i += 1000) {
      const part = entries.slice(i, i + 1000);
      await client.query(
        `INSERT INTO airdrop_entries (program_id, account, idx, amount, proof)
         SELECT $1, a, i, m::numeric, p FROM unnest($2::text[], $3::bigint[], $4::text[], $5::jsonb[]) AS t(a, i, m, p)`,
        [prog.id, part.map(e => e.account), part.map(e => e.idx), part.map(e => e.amount), part.map(e => JSON.stringify(e.proof))],
      );
    }
    await client.query('COMMIT');
    return { program: prog, root, checks: { root_matches_onchain: true, sample_proofs: sample.length, simulated_claim: simulated || 'every sampled entry was already claimed, so no claim was simulated' } };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') throw new ClaimRefused(`An airdrop with slug ${p.slug} exists already.`, 409);
    throw err;
  } finally { client.release(); }
}

async function programs({ all = false } = {}) {
  const { rows } = await db.query(
    `SELECT id, slug, name, chain, token, distributor, official_url, source, ends_at, entries, active, created_at FROM airdrop_programs
     ${all ? '' : 'WHERE active AND (ends_at IS NULL OR ends_at > now())'} ORDER BY created_at DESC`,
  );
  return rows;
}

async function setActive(id, active) {
  const { rowCount } = await db.query('UPDATE airdrop_programs SET active = $2 WHERE id = $1', [id, !!active]);
  if (!rowCount) throw new ClaimRefused('No such airdrop.', 404);
  return { id: Number(id), active: !!active };
}

/* ── request bodies ── */

function parseWallet(body = {}) {
  const w = String(body?.wallet || '').trim();
  if (!isAddress(w)) return { error: 'wallet must be a wallet address (0x and 40 hex characters)' };
  return { wallet: lower(w) };
}

function parsePrepare(body = {}) {
  const w = parseWallet(body);
  if (w.error) return w;
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(String))].slice(0, 20) : [];
  if (!ids.length) return { error: 'ids: the found items to claim' };
  if (!EVM[body.chain]) return { error: `chain must be one of ${CHAINS.join(', ')}` };
  return { ...w, chain: body.chain, ids };
}

module.exports = { check, find, prepare, confirm, addProgram, parseProgram, parseTree, programs, setActive, parseWallet, parsePrepare, feeFor, ClaimRefused, MERKL, CHAIN_NAMES };
