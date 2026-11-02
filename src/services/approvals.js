/**
 * Approval cleanup: find the token permissions a wallet has given, say which
 * are risky and why, and prepare the transactions that revoke them. The
 * wallet's owner signs those; RektBull sends nothing and holds nothing.
 *
 * Per EVM chain:
 *   1. Find candidates from two sources: the explorer's logs (Approval,
 *      ApprovalForAll, and Permit2's Approval/Permit) and GoPlus's approval
 *      index. Either may be missing; each gap is reported.
 *   2. Read the current state onchain (RPC, batched through Multicall3):
 *      only approvals still open count. Logs say what was approved once;
 *      the chain says what is approved now.
 *   3. Rate each spender: a plain wallet, flagged by GoPlus, unverified,
 *      unlimited, new; or known and trusted. Every reason names its source.
 *   4. Value what's at risk: the lesser of the allowance and the balance, at
 *      DefiLlama's price (not priced is said so, never guessed).
 *   5. Prepare revokes: approve(spender, 0), setApprovalForAll(op, false),
 *      and one Permit2 lockdown per chain.
 *
 * Kinds: erc20 (token allowance), nft_all (approval for a whole NFT
 * collection), permit2 (an allowance inside Uniswap's Permit2). Approvals of
 * single NFTs are counted but not listed.
 */
const { ethers } = require('ethers');
const { EVM } = require('../providers/chains');
const rpc = require('../providers/rpc');
const explorer = require('../providers/explorer');
const goplus = require('../providers/goplus');
const prices = require('../providers/prices');
const { cached, set: cacheSet } = require('../lib/cache');
const env = require('../config/env');

const CHAINS = (env.approvalChains || Object.keys(EVM)).filter(c => EVM[c]);
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const TOPIC = {
  approval: ethers.id('Approval(address,address,uint256)'),
  approvalForAll: ethers.id('ApprovalForAll(address,address,bool)'),
  p2Approval: ethers.id('Approval(address,address,address,uint160,uint48)'),
  p2Permit: ethers.id('Permit(address,address,address,uint160,uint48,uint48)'),
};
/** Spenders RektBull knows by address on every chain it scans. */
const KNOWN = {
  [PERMIT2]: 'Uniswap Permit2',
  '0x0000000000001ff3684f28c67538d4d072c22734': '0x AllowanceHolder',
};
const UNLIMITED_ERC20 = 2n ** 255n;
const UNLIMITED_PERMIT2 = 2n ** 159n;
const MAX_SPENDERS = 40;
const SCAN_TTL = 120;
const DAY = 86400;

const ERC20 = new ethers.Interface([
  'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function approve(address,uint256) returns (bool)',
]);
const NFT = new ethers.Interface(['function isApprovedForAll(address,address) view returns (bool)', 'function setApprovalForAll(address,bool)', 'function name() view returns (string)']);
const P2 = new ethers.Interface(['function allowance(address,address,address) view returns (uint160 amount, uint48 expiration, uint48 nonce)', 'function lockdown((address token, address spender)[] approvals)']);
const MC = new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);

const addr = topic => (topic ? ethers.getAddress('0x' + String(topic).slice(-40)).toLowerCase() : null);
const isAddress = a => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));

/** Runs calls [{ target, iface, fn, args }] through Multicall3; each result is { ok, value }. */
async function multicall(chain, calls, { chunk = 150 } = {}) {
  const out = [];
  for (let i = 0; i < calls.length; i += chunk) {
    const part = calls.slice(i, i + chunk);
    const data = MC.encodeFunctionData('aggregate3', [part.map(c => ({ target: c.target, allowFailure: true, callData: c.iface.encodeFunctionData(c.fn, c.args) }))]);
    const raw = await rpc.evmRpc(chain, 'eth_call', [{ to: MULTICALL3, data }, 'latest']);
    const [results] = MC.decodeFunctionResult('aggregate3', raw);
    results.forEach((r, j) => {
      const c = part[j];
      if (!r.success || r.returnData === '0x') return out.push({ ok: false });
      try { out.push({ ok: true, value: c.iface.decodeFunctionResult(c.fn, r.returnData) }); } catch { out.push({ ok: false }); }
    });
  }
  return out;
}

/** 1. Candidates from the explorer's logs and from GoPlus. */
async function discover(chain, owner) {
  const notChecked = [];
  const found = new Map(); // key -> { kind, token, spender, found_by:Set, last_seen }
  let singleNft = 0;
  const add = (kind, token, spender, by, when) => {
    if (!token || !spender || spender === ethers.ZeroAddress) return;
    const key = `${kind}:${token}:${spender}`;
    const c = found.get(key) || { key, kind, token, spender, found_by: new Set(), last_seen: null };
    c.found_by.add(by);
    if (when && (!c.last_seen || when > c.last_seen)) c.last_seen = when;
    found.set(key, c);
  };
  const ownerTopic = ethers.zeroPadValue(owner, 32).toLowerCase();
  const when = l => (l.timeStamp ? new Date(Number(l.timeStamp) * 1000).toISOString() : null);

  const [erc, nft, p2, gp] = await Promise.allSettled([
    explorer.explorerLogs(chain, { topic0: TOPIC.approval, topic1: ownerTopic }),
    explorer.explorerLogs(chain, { topic0: TOPIC.approvalForAll, topic1: ownerTopic }),
    explorer.explorerLogs(chain, { address: PERMIT2, topic1: ownerTopic }),
    goplus.approvalsOf(chain, owner),
  ]);
  let logsRead = 0;
  if (erc.status === 'fulfilled') {
    logsRead++;
    for (const l of erc.value.logs) {
      if (l.topics.length > 3 && l.topics[3]) singleNft++;
      else add('erc20', String(l.address).toLowerCase(), addr(l.topics[2]), 'explorer logs', when(l));
    }
    if (!erc.value.complete) notChecked.push({ check: 'token approvals', reason: 'Too many approval logs: only the oldest were read; GoPlus is the second source.' });
  } else notChecked.push({ check: 'token approvals (explorer logs)', reason: erc.reason.message });
  if (nft.status === 'fulfilled') {
    logsRead++;
    for (const l of nft.value.logs) add('nft_all', String(l.address).toLowerCase(), addr(l.topics[2]), 'explorer logs', when(l));
    if (!nft.value.complete) notChecked.push({ check: 'NFT approvals', reason: 'Too many NFT approval logs: only the oldest were read.' });
  } else notChecked.push({ check: 'NFT approvals (explorer logs)', reason: nft.reason.message });
  if (p2.status === 'fulfilled') {
    logsRead++;
    for (const l of p2.value.logs) {
      if (l.topics[0] === TOPIC.p2Approval || l.topics[0] === TOPIC.p2Permit) add('permit2', addr(l.topics[2]), addr(l.topics[3]), 'explorer logs', when(l));
    }
  } else notChecked.push({ check: 'Permit2 approvals (explorer logs)', reason: p2.reason.message });
  let goplusRead = false;
  if (gp.status === 'fulfilled' && !gp.value.not_checked) {
    goplusRead = true;
    for (const a of gp.value.approvals) add(a.kind, a.token, a.spender, 'GoPlus', null);
    if (gp.value.partial) notChecked.push({ check: 'GoPlus approvals', reason: gp.value.partial });
  } else notChecked.push({ check: 'GoPlus approvals', reason: gp.status === 'fulfilled' ? gp.value.not_checked : gp.reason.message });
  if (!logsRead && !goplusRead) return { unreadable: 'Neither the explorer nor GoPlus answered, so no approvals could be found.', notChecked };
  if (singleNft) notChecked.push({ check: 'single-NFT approvals', reason: `${singleNft} approval${singleNft === 1 ? '' : 's'} of single NFTs found; these aren't listed here.` });
  return { candidates: [...found.values()].map(c => ({ ...c, found_by: [...c.found_by] })), notChecked };
}

/** 2. The current state onchain: only open approvals come back. */
async function verify(chain, owner, candidates) {
  const calls = [];
  const tokens = new Set(candidates.filter(c => c.kind !== 'nft_all').map(c => c.token));
  const nfts = new Set(candidates.filter(c => c.kind === 'nft_all').map(c => c.token));
  for (const c of candidates) {
    if (c.kind === 'erc20') calls.push({ target: c.token, iface: ERC20, fn: 'allowance', args: [owner, c.spender], c });
    if (c.kind === 'nft_all') calls.push({ target: c.token, iface: NFT, fn: 'isApprovedForAll', args: [owner, c.spender], c });
    if (c.kind === 'permit2') calls.push({ target: PERMIT2, iface: P2, fn: 'allowance', args: [owner, c.token, c.spender], c });
  }
  const info = {};
  for (const t of tokens) for (const fn of ['balanceOf', 'decimals', 'symbol']) calls.push({ target: t, iface: ERC20, fn, args: fn === 'balanceOf' ? [owner] : [], t });
  for (const t of nfts) calls.push({ target: t, iface: NFT, fn: 'name', args: [], t });
  const res = await multicall(chain, calls);
  const open = [];
  let unreadable = 0;
  const now = Math.floor(Date.now() / 1000);
  res.forEach((r, i) => {
    const call = calls[i];
    if (call.t) {
      const t = (info[call.t] = info[call.t] || {});
      if (r.ok) t[call.fn] = r.value[0];
      return;
    }
    if (!r.ok) { unreadable++; return; }
    const c = call.c;
    if (c.kind === 'erc20' && r.value[0] > 0n) open.push({ ...c, amount: r.value[0], unlimited: r.value[0] >= UNLIMITED_ERC20 });
    if (c.kind === 'nft_all' && r.value[0] === true) open.push({ ...c, amount: null, unlimited: true });
    if (c.kind === 'permit2' && r.value.amount > 0n && Number(r.value.expiration) > now) {
      open.push({ ...c, amount: r.value.amount, unlimited: r.value.amount >= UNLIMITED_PERMIT2, expires_at: new Date(Number(r.value.expiration) * 1000).toISOString() });
    }
  });
  return { open, info, unreadable };
}

/** 3. Who each spender is, with the source of every fact. */
async function spenderFacts(chain, spender) {
  const facts = { address: spender, label: KNOWN[spender] || null, reasons: [] };
  try {
    const code = await rpc.evmRpc(chain, 'eth_getCode', [spender, 'latest']);
    facts.wallet = code === '0x' || /^0xef0100/i.test(code);
  } catch (err) {
    facts.wallet = null;
    facts.code_error = err.message;
  }
  const risk = facts.wallet === true ? await goplus.addressRisk(chain, spender).catch(err => ({ not_checked: `GoPlus: ${err.message}` }))
    : await goplus.contractRisk(chain, spender).catch(err => ({ not_checked: `GoPlus: ${err.message}` }));
  facts.risk = risk;
  if (!facts.label && risk?.name) facts.label = risk.name;
  return facts;
}

const RANK = { critical: 4, high: 3, medium: 2, low: 1 };

/** The severity and reasons for one open approval. */
function rate(a, s) {
  const reasons = [];
  let sev = 'low';
  const raise = (to, text, source) => { reasons.push({ text, source }); if (RANK[to] > RANK[sev]) sev = to; };
  const note = (text, source) => reasons.push({ text, source });
  const r = s.risk || {};

  if (KNOWN[s.address]) note(`Known: ${KNOWN[s.address]}.`, 'RektBull\'s list of known contracts');
  if (r.flags?.length) raise('critical', `Flagged for ${r.flags.join(', ')}.`, r.source);
  if (r.malicious?.length) raise('critical', `Flagged as malicious (${r.malicious.join(', ')}).`, r.source);
  if (r.doubted) raise('high', 'Listed as doubtful.', r.source);
  if (r.approval_abuse || r.privilege_withdraw) raise('high', 'Its code can take approved tokens beyond normal use.', `${r.source} contract scan`);
  if (s.wallet === true) raise('high', 'It\'s a plain wallet, not a contract. Approving a wallet is how most approval scams work: whoever holds its key can take the approved tokens.', 'RPC (no contract code at the address)');
  if (s.wallet === null) raise('medium', `Couldn't read whether it's a contract (${s.code_error}).`, 'RPC');
  if (!s.wallet && r.open_source === false) raise(a.unlimited ? 'high' : 'medium', 'Its source code isn\'t published, so what it can do with your tokens can\'t be read.', r.source);
  if (!s.wallet && r.known === false && !KNOWN[s.address]) raise('medium', 'GoPlus has no record of this contract.', 'GoPlus');
  if (r.not_checked) raise('medium', `Couldn't check who it is: ${r.not_checked}`, 'GoPlus');
  if (r.deployed_at && Date.now() - new Date(r.deployed_at) < 30 * DAY * 1000) raise('medium', `Deployed ${Math.max(0, Math.floor((Date.now() - new Date(r.deployed_at)) / (DAY * 1000)))} days ago.`, r.source);
  const trusted = KNOWN[s.address] || r.trusted;
  if (r.trusted) note('On GoPlus\'s trust list.', r.source);
  if (a.kind === 'nft_all') {
    if (!trusted) raise('medium', 'It can move every NFT you hold in this collection, including ones you get later.', 'onchain approval');
  } else if (a.unlimited) {
    if (!trusted) raise('medium', 'Unlimited: it can take all of this token you hold, and any you receive later.', 'onchain allowance');
    else note('Unlimited, which is usual for this contract.', 'onchain allowance');
  }
  if (a.last_seen && Date.now() - new Date(a.last_seen) > 365 * DAY * 1000) note(`Given over a year ago (${a.last_seen.slice(0, 10)}).`, 'explorer logs');
  return { severity: sev, reasons };
}

/** Everything about one chain. */
async function scanChain(chain, owner) {
  const chainId = EVM[chain].chainId;
  const d = await discover(chain, owner);
  if (d.unreadable) return { chain, chain_id: chainId, read: false, reason: d.unreadable, approvals: [], revoke_calls: [], not_checked: d.notChecked };
  const notChecked = [...d.notChecked];
  if (!d.candidates.length) return { chain, chain_id: chainId, read: true, approvals: [], revoke_calls: [], not_checked: notChecked };

  let v;
  try {
    v = await verify(chain, owner, d.candidates);
  } catch (err) {
    return { chain, chain_id: chainId, read: false, reason: `Couldn't read the current approvals onchain: ${err.message}`, approvals: [], revoke_calls: [], not_checked: notChecked };
  }
  if (v.unreadable) notChecked.push({ check: 'current state', reason: `${v.unreadable} approval${v.unreadable === 1 ? '' : 's'} couldn't be read onchain (the token contract didn't answer).` });

  const spenders = [...new Set(v.open.map(a => a.spender))];
  if (spenders.length > MAX_SPENDERS) notChecked.push({ check: 'spenders', reason: `${spenders.length} different spenders; the first ${MAX_SPENDERS} were looked up, the rest are rated from the onchain approval only.` });
  const facts = {};
  for (let i = 0; i < Math.min(spenders.length, MAX_SPENDERS); i += 5) {
    const part = spenders.slice(i, i + 5);
    const got = await Promise.all(part.map(s => spenderFacts(chain, s)));
    got.forEach(f => { facts[f.address] = f; });
  }

  const priceIds = [...new Set(v.open.filter(a => a.kind !== 'nft_all').map(a => `${chain}:${a.token}`))];
  let usd = {};
  try { usd = priceIds.length ? await prices.usdPrices(priceIds) : {}; } catch (err) { notChecked.push({ check: 'prices', reason: `DefiLlama: ${err.message}` }); }

  const approvals = v.open.map(a => {
    const t = v.info[a.token] || {};
    const s = facts[a.spender] || { address: a.spender, label: KNOWN[a.spender] || null, wallet: null, code_error: 'not looked up', risk: {} };
    const { severity, reasons } = rate(a, s);
    const decimals = t.decimals !== undefined ? Number(t.decimals) : null;
    const balance = t.balanceOf !== undefined ? t.balanceOf : null;
    const exposure = a.kind === 'nft_all' || balance === null ? null : (a.amount < balance ? a.amount : balance);
    const price = usd[`${chain}:${a.token}`];
    const value = exposure !== null && decimals !== null && price ? Number(ethers.formatUnits(exposure, decimals)) * price : null;
    return {
      id: a.key, kind: a.kind,
      token: { address: a.token, symbol: t.symbol || t.name || null, decimals },
      spender: { address: a.spender, label: s.label, is_wallet: s.wallet },
      allowance: a.kind === 'nft_all' ? { all: true } : {
        raw: a.amount.toString(), unlimited: a.unlimited,
        amount: a.unlimited ? 'unlimited' : decimals === null ? null : ethers.formatUnits(a.amount, decimals),
      },
      ...(a.expires_at ? { expires_at: a.expires_at } : {}),
      balance: balance === null || decimals === null ? null : ethers.formatUnits(balance, decimals),
      value_at_risk_usd: value === null ? null : Math.round(value * 100) / 100,
      ...(a.kind !== 'nft_all' && value === null ? { value_note: price ? 'balance not read' : 'not priced by DefiLlama' } : {}),
      last_approved_at: a.last_seen, found_by: a.found_by,
      severity, reasons, recommended: RANK[severity] >= RANK.medium,
    };
  }).sort((x, y) => RANK[y.severity] - RANK[x.severity] || (y.value_at_risk_usd || 0) - (x.value_at_risk_usd || 0));

  return { chain, chain_id: chainId, read: true, approvals, revoke_calls: revokeCalls(chainId, approvals), not_checked: notChecked };
}

/** 5. The transactions that revoke: one per ERC-20 or NFT approval, one Permit2 lockdown for all Permit2 ones. */
function revokeCalls(chainId, approvals) {
  const calls = [];
  const p2 = [];
  for (const a of approvals) {
    if (a.kind === 'erc20') calls.push({ chain_id: chainId, to: a.token.address, data: ERC20.encodeFunctionData('approve', [a.spender.address, 0]), value: '0x0', revokes: [a.id], label: `Revoke ${a.token.symbol || a.token.address} for ${a.spender.label || a.spender.address}` });
    if (a.kind === 'nft_all') calls.push({ chain_id: chainId, to: a.token.address, data: NFT.encodeFunctionData('setApprovalForAll', [a.spender.address, false]), value: '0x0', revokes: [a.id], label: `Revoke ${a.token.symbol || 'NFT collection'} for ${a.spender.label || a.spender.address}` });
    if (a.kind === 'permit2') p2.push(a);
  }
  if (p2.length) calls.push({ chain_id: chainId, to: PERMIT2, data: P2.encodeFunctionData('lockdown', [p2.map(a => ({ token: a.token.address, spender: a.spender.address }))]), value: '0x0', revokes: p2.map(a => a.id), label: `Revoke ${p2.length} Permit2 allowance${p2.length === 1 ? '' : 's'}`, ...(p2.length > 1 ? { note: 'Permit2 revokes all listed at once; pick them all or none.' } : {}) });
  return calls;
}

/** Calls to revoke only the chosen approvals (Permit2 ones together, as Permit2 does). */
function callsFor(chainResult, ids) {
  const chosen = chainResult.approvals.filter(a => ids.includes(a.id));
  return revokeCalls(chainResult.chain_id, chosen);
}

/** The whole wallet, every chain at once, cached briefly so the preview and the paid run share one scan. */
async function scan(owner, { chains = CHAINS, refresh = false } = {}) {
  owner = String(owner).toLowerCase();
  const key = `approvals:${chains.join(',')}:${owner}`;
  const run = async () => {
    const results = await Promise.all(chains.map(c => scanChain(c, owner).catch(err => ({ chain: c, chain_id: EVM[c]?.chainId, read: false, reason: err.message, approvals: [], revoke_calls: [], not_checked: [] }))));
    return { owner, checked_at: new Date().toISOString(), chains: results };
  };
  if (refresh) { const out = await run(); await cacheSet(key, out, SCAN_TTL); return out; }
  return cached(key, SCAN_TTL, run);
}

function summary(s) {
  const all = s.chains.flatMap(c => c.approvals);
  const risky = all.filter(a => a.recommended);
  const value = risky.reduce((t, a) => t + (a.value_at_risk_usd || 0), 0);
  return {
    open: all.length,
    to_revoke: risky.length,
    by_severity: Object.fromEntries(['critical', 'high', 'medium', 'low'].map(k => [k, all.filter(a => a.severity === k).length])),
    value_at_risk_usd: Math.round(value * 100) / 100,
    not_priced: risky.filter(a => a.value_at_risk_usd === null).length,
    chains_read: s.chains.filter(c => c.read).map(c => c.chain),
    chains_not_read: s.chains.filter(c => !c.read).map(c => ({ chain: c.chain, reason: c.reason })),
  };
}

const NOTE = 'Revoking needs your wallet to sign each transaction and pay its gas. RektBull only prepares them. A clean result means no known risk pattern was found, not that every spender is safe.';

/** The free preview: how many, how risky, how much at risk; not which. */
async function preview(owner, opts) {
  const s = await scan(owner, opts);
  return { owner: s.owner, checked_at: s.checked_at, summary: summary(s), note: 'The full cleanup lists each approval, why it is risky, and prepares the revokes.' };
}

/** The paid cleanup: every open approval, rated, with the revoke transactions. Fails (and is refunded) if no chain could be read. */
async function cleanup(owner, opts) {
  const s = await scan(owner, opts);
  if (!s.chains.some(c => c.read)) throw Object.assign(new Error(`No chain could be read: ${s.chains.map(c => `${c.chain}: ${c.reason}`).join('; ')}`), { status: 503 });
  const sum = summary(s);
  if (!sum.open) throw Object.assign(new Error(`No open approvals found on ${sum.chains_read.join(', ')}: nothing to clean up, and you weren't charged.`), { status: 422 });
  return { ...s, summary: sum, note: NOTE };
}

/** The checked { owner } from a request body, or { error }. */
function parseOwner(body = {}) {
  const owner = String(body.wallet || body.address || '').trim();
  if (!isAddress(owner)) return { error: 'wallet must be a wallet address (0x and 40 hex characters)' };
  return { owner: owner.toLowerCase(), refresh: body.refresh === true };
}

module.exports = { scan, scanChain, preview, cleanup, summary, rate, revokeCalls, callsFor, parseOwner, discover, verify, CHAINS, PERMIT2, MULTICALL3, KNOWN, TOPIC };
