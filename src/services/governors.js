/**
 * On-chain governors: OpenZeppelin Governor, Compound's Governor Bravo, and
 * their forks (carried over from soyjak-agentic's governorReader.js). Each
 * fact names its source:
 *   - the governor's kind, clock, token and settings (RPC);
 *   - proposals from its ProposalCreated logs (the explorer; the chain's own
 *     eth_getLogs when the explorer can't answer), each with its state,
 *     tally, quorum and deadline (RPC). A future deadline in blocks is an
 *     estimate from recent block times, and says so;
 *   - every action decoded: target, function and value, flagged when it
 *     moves funds, changes who controls something, or changes the voting
 *     rules;
 *   - for a wallet: its voting power now and at each proposal's snapshot,
 *     whether it has voted and how, and who its tokens delegate to (the
 *     voting token, RPC). Tokens delegated to nobody count for nobody.
 * Votes and delegations are transactions the user's wallet sends; RektBull
 * prepares them, simulates them, and never sends them.
 *
 * Arbitrum's block.number is Ethereum's block number, so a block-clock
 * governor there is timed on Ethereum's blocks.
 */
const { ethers } = require('ethers');
const rpc = require('../providers/rpc');
const explorer = require('../providers/explorer');
const { cached } = require('../lib/cache');
const { multicall } = require('./approvals');
const { EVM } = require('../providers/chains');

/**
 * Governors RektBull reads for every wallet. Each was checked onchain on
 * 3 November 2026: it answers as its kind, and names this voting token.
 */
const REGISTRY = [
  { chain: 'ethereum', address: '0x408ed6354d4973f66138c91495f2f2fcbd8724c3', name: 'Uniswap' },
  { chain: 'ethereum', address: '0x309a862bbc1a00e45506cb8a802d1ff10004c8c0', name: 'Compound' },
  { chain: 'ethereum', address: '0x323a76393544d5ecca80cd6ef2a560c6a395b7e3', name: 'ENS' },
  { chain: 'ethereum', address: '0x9d4c63565d5618310271bf3f3c01b2954c1d1639', name: 'Gitcoin' },
  { chain: 'ethereum', address: '0xed8bdb5895b8b7f9fdb3c087628fd8410e853d48', name: 'Hop' },
  { chain: 'arbitrum', address: '0xf07ded9dc292157749b6fd268e37df6ea38395b9', name: 'Arbitrum (Core)' },
  { chain: 'arbitrum', address: '0x789fc99093b09ad01c34dc7251d0c89ce743e5a4', name: 'Arbitrum (Treasury)' },
];

const GOV = new ethers.Interface([
  'function COUNTING_MODE() view returns (string)', 'function CLOCK_MODE() view returns (string)', 'function name() view returns (string)',
  'function state(uint256) view returns (uint8)',
  'function proposalVotes(uint256) view returns (uint256 againstVotes, uint256 forVotes, uint256 abstainVotes)',
  'function proposalSnapshot(uint256) view returns (uint256)', 'function proposalDeadline(uint256) view returns (uint256)',
  'function quorum(uint256) view returns (uint256)', 'function hasVoted(uint256, address) view returns (bool)',
  'function getVotes(address, uint256) view returns (uint256)',
  'function token() view returns (address)', 'function proposalCount() view returns (uint256)', 'function quorumVotes() view returns (uint256)',
  'function proposals(uint256) view returns (uint256 id, address proposer, uint256 eta, uint256 startBlock, uint256 endBlock, uint256 forVotes, uint256 againstVotes, uint256 abstainVotes, bool canceled, bool executed)',
  'function getReceipt(uint256, address) view returns (tuple(bool hasVoted, uint8 support, uint96 votes))',
  'function comp() view returns (address)', 'function uni() view returns (address)',
  'function castVote(uint256 proposalId, uint8 support)', 'function castVoteWithReason(uint256 proposalId, uint8 support, string reason)',
  'event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 voteStart, uint256 voteEnd, string description)',
]);
const TOKEN = new ethers.Interface([
  'function getVotes(address) view returns (uint256)', 'function getCurrentVotes(address) view returns (uint96)',
  'function getPriorVotes(address, uint256) view returns (uint96)', 'function delegates(address) view returns (address)',
  'function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)',
  'function delegate(address delegatee)',
]);
const STATES = ['Pending', 'Active', 'Canceled', 'Defeated', 'Succeeded', 'Queued', 'Expired', 'Executed'];
const SUPPORT = ['Against', 'For', 'Abstain'];
const PROPOSAL_CREATED = GOV.getEvent('ProposalCreated').topicHash;
const LOOKBACK_DAYS = 30;
const RPC_LOG_CHUNK = { arbitrum: 5000000, base: 100000, optimism: 100000, ethereum: 10000, polygon: 10000, bsc: 5000 };
const isAddr = a => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
const lower = a => String(a || '').toLowerCase();
const iso = s => new Date(Number(s) * 1000).toISOString();

class GovernorRefused extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}

/* ── what a proposal does ── */

const KNOWN_CALLS = {
  moves_funds: ['transfer(address,uint256)', 'transferFrom(address,address,uint256)', 'approve(address,uint256)', 'increaseAllowance(address,uint256)', 'safeTransferFrom(address,address,uint256)'],
  changes_control: [
    'upgradeTo(address)', 'upgradeToAndCall(address,bytes)', 'upgrade(address,address)', 'upgradeAndCall(address,address,bytes)',
    'transferOwnership(address)', 'grantRole(bytes32,address)', 'revokeRole(bytes32,address)', 'changeAdmin(address)',
    'setPendingAdmin(address)', '_setPendingAdmin(address)', 'acceptAdmin()', 'updateTimelock(address)', 'setGuardian(address)',
    'enableModule(address)', 'addOwnerWithThreshold(address,uint256)', 'changeThreshold(uint256)',
  ],
  changes_rules: [
    'setVotingPeriod(uint256)', 'setVotingDelay(uint256)', 'setProposalThreshold(uint256)', 'updateQuorumNumerator(uint256)',
    '_setVotingPeriod(uint256)', '_setVotingDelay(uint256)', '_setProposalThreshold(uint256)', 'setDelay(uint256)', 'setLateQuorumVoteExtension(uint64)',
  ],
};
const BY_SELECTOR = {};
for (const [kind, sigs] of Object.entries(KNOWN_CALLS)) for (const sig of sigs) BY_SELECTOR[ethers.id(sig).slice(0, 10)] = { kind, sig };
const FLAG_TEXT = { moves_funds: 'moves funds', changes_control: 'changes who controls something', changes_rules: 'changes the voting rules' };

/** One action of a proposal. Bravo-style actions carry the signature apart from the arguments. */
function decodeAction(target, value, signature, calldata) {
  const v = BigInt(value || 0);
  let selector; let args;
  if (signature) { selector = ethers.id(signature).slice(0, 10); args = calldata; } else { selector = String(calldata || '0x').slice(0, 10); args = '0x' + String(calldata || '0x').slice(10); }
  const known = BY_SELECTOR[selector];
  const out = { target: lower(target), value_wei: v.toString(), function: signature || known?.sig || (selector.length === 10 ? `unknown (${selector})` : '(no call)') };
  const kinds = [];
  if (v > 0n) kinds.push('moves_funds');
  if (known) {
    kinds.push(known.kind);
    try {
      const frag = ethers.FunctionFragment.from(known.sig);
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(frag.inputs, args);
      out.args = frag.inputs.map((p, i) => `${p.type} ${typeof decoded[i] === 'bigint' ? decoded[i].toString() : decoded[i]}`);
    } catch { out.args = 'couldn\'t be decoded'; }
  }
  if (kinds.length) out.flags = [...new Set(kinds)].map(k => FLAG_TEXT[k]);
  return out;
}

/* ── reading a governor ── */

const one = async (chain, target, iface, fn, args = []) => (await multicall(chain, [{ target, iface, fn, args }]))[0];
const val = r => (r?.ok ? r.value[0] : undefined);

/** Its kind, clock and voting token. Null when it's neither kind of governor. */
async function readGovernor(chain, address) {
  return cached(`governor:${chain}:${lower(address)}`, 24 * 3600, async () => {
    const r = await multicall(chain, ['COUNTING_MODE', 'CLOCK_MODE', 'name', 'token', 'proposalCount', 'quorumVotes', 'comp', 'uni'].map(fn => ({ target: address, iface: GOV, fn, args: [] })));
    const [counting, clock, name, token, count, qv, comp, uni] = r.map(val);
    if (counting === undefined && (count === undefined || qv === undefined)) return null;
    const tok = token || comp || uni || null;
    let decimals = 18; let symbol = null;
    if (tok) {
      const m = await multicall(chain, [{ target: tok, iface: TOKEN, fn: 'decimals', args: [] }, { target: tok, iface: TOKEN, fn: 'symbol', args: [] }]);
      decimals = Number(val(m[0]) ?? 18); symbol = val(m[1]) ?? null;
    }
    return {
      chain, address: lower(address), oz: counting !== undefined, kind: counting !== undefined ? 'OpenZeppelin Governor' : 'Compound Governor Bravo',
      name: name || null, counting: counting || 'support=bravo&quorum=for',
      clock: /mode=timestamp/.test(clock || '') ? 'timestamp' : 'blocknumber',
      token: tok ? lower(tok) : null, symbol, decimals,
      bravo_quorum: counting === undefined ? qv.toString() : null,
    };
  });
}

/** The chain a governor's block numbers are counted on (Arbitrum counts Ethereum's). */
const clockChain = chain => (chain === 'arbitrum' ? 'ethereum' : chain);

/** A timepoint as a date: timestamps as they are; past blocks read; future blocks estimated. */
async function dateOf(gov, point) {
  if (gov.clock === 'timestamp') return { at: iso(point), estimated: false };
  const chain = clockChain(gov.chain);
  const b = Number(point);
  const latest = Number(await rpc.evmRpc(chain, 'eth_blockNumber', []));
  if (b <= latest) {
    const blk = await rpc.evmRpc(chain, 'eth_getBlockByNumber', [ethers.toQuantity(b), false]);
    return blk ? { at: iso(Number(blk.timestamp)), estimated: false } : null;
  }
  const per = await blockTime(chain);
  const nowBlk = await rpc.evmRpc(chain, 'eth_getBlockByNumber', ['latest', false]);
  return { at: iso(Math.round(Number(nowBlk.timestamp) + (b - latest) * per)), estimated: true };
}

/** Seconds per block, from the last 10,000 blocks (cached an hour). */
const blockTime = chain => cached(`blocktime:${chain}`, 3600, async () => {
  const latest = Number(await rpc.evmRpc(chain, 'eth_blockNumber', []));
  const [a, b] = await Promise.all([latest, Math.max(1, latest - 10000)].map(n => rpc.evmRpc(chain, 'eth_getBlockByNumber', [ethers.toQuantity(n), false])));
  return (Number(a.timestamp) - Number(b.timestamp)) / (latest - Math.max(1, latest - 10000)) || 12;
});

/** The block LOOKBACK_DAYS ago on a chain: the explorer's answer, or an estimate from block times. */
async function startBlock(chain) {
  const t = Date.now() / 1000 - LOOKBACK_DAYS * 86400;
  try { return await explorer.blockAt(chain, t); } catch {
    const latest = Number(await rpc.evmRpc(chain, 'eth_blockNumber', []));
    return Math.max(0, Math.floor(latest - (LOOKBACK_DAYS * 86400 * 1.1) / await blockTime(chain)));
  }
}

/** ProposalCreated logs since a block: the explorer, then the chain's own eth_getLogs in chunks. */
async function createdLogs(chain, address, fromBlock) {
  try {
    const r = await explorer.explorerLogs(chain, { address, topic0: PROPOSAL_CREATED }, { fromBlock, maxPages: 3 });
    return { logs: r.logs, source: 'the explorer\'s logs' };
  } catch (explorerErr) {
    const latest = Number(await rpc.evmRpc(chain, 'eth_blockNumber', []));
    const step = RPC_LOG_CHUNK[chain] || 10000;
    if ((latest - fromBlock) / step > 20) throw new Error(`the explorer couldn't list proposals (${explorerErr.message}), and the chain's RPC would need too many log requests`);
    const logs = [];
    for (let a = fromBlock; a <= latest; a += step) {
      logs.push(...await rpc.evmRpc(chain, 'eth_getLogs', [{ address, topics: [PROPOSAL_CREATED], fromBlock: ethers.toQuantity(a), toBlock: ethers.toQuantity(Math.min(latest, a + step - 1)) }]));
    }
    return { logs, source: 'the chain\'s logs (RPC)' };
  }
}

function parseCreated(log) {
  const e = GOV.parseLog({ topics: log.topics, data: log.data });
  const description = String(e.args.description || '');
  return {
    id: e.args.proposalId.toString(),
    proposer: lower(e.args.proposer),
    title: (description.split('\n').map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean) || `Proposal ${e.args.proposalId}`).slice(0, 200),
    description,
    actions: e.args.targets.map((t, i) => decodeAction(t, e.args[3][i], e.args.signatures[i], e.args.calldatas[i])),
    created_block: Number(log.blockNumber),
  };
}

/** A proposal's state, tally, quorum, snapshot and deadline. */
async function readStatus(gov, p) {
  const id = BigInt(p.id);
  const c = (fn, args) => ({ target: gov.address, iface: GOV, fn, args });
  const r = await multicall(gov.chain, gov.oz ? [c('state', [id]), c('proposalVotes', [id]), c('proposalSnapshot', [id]), c('proposalDeadline', [id])] : [c('state', [id]), c('proposals', [id])]);
  const state = r[0].ok ? (STATES[Number(r[0].value[0])] || `state ${r[0].value[0]}`) : 'unreadable';
  let f; let a; let ab; let snap; let end; let quorum = null;
  if (gov.oz) {
    if (r[1].ok) [a, f, ab] = [r[1].value[0], r[1].value[1], r[1].value[2]];
    snap = val(r[2]); end = val(r[3]);
    if (snap !== undefined) quorum = val(await one(gov.chain, gov.address, GOV, 'quorum', [snap])) ?? null; // not readable while the snapshot is in the future
  } else if (r[1].ok) {
    const b = r[1].value;
    [f, a, ab, snap, end] = [b.forVotes, b.againstVotes, b.abstainVotes, b.startBlock, b.endBlock];
    quorum = BigInt(gov.bravo_quorum);
  }
  const fmt = x => (x === undefined || x === null ? null : ethers.formatUnits(x, gov.decimals));
  const forAbstain = /quorum=for,abstain/.test(gov.counting);
  const counted = f === undefined ? null : forAbstain ? f + (ab || 0n) : f;
  const deadline = end === undefined ? null : await dateOf(gov, end).catch(() => null);
  return {
    state,
    votes: f === undefined ? null : { for: fmt(f), against: fmt(a), abstain: fmt(ab || 0n) },
    quorum: quorum === null ? null : { required: fmt(quorum), counted: fmt(counted), reached: counted !== null && counted >= quorum, counts: forAbstain ? 'For + Abstain' : 'For' },
    snapshot_point: snap === undefined ? null : snap.toString(),
    deadline: deadline ? { ...deadline, [gov.clock === 'timestamp' ? 'timestamp' : 'block']: end.toString() } : null,
    hours_left: deadline ? Math.max(0, Math.round((Date.parse(deadline.at) - Date.now()) / 360000) / 10) : null,
  };
}

/** Proposals open for voting (or about to open) on a governor, cached five minutes. */
async function openProposals(gov) {
  return cached(`governor:open:${gov.chain}:${gov.address}`, 5 * 60, async () => {
    const from = await startBlock(gov.chain);
    const { logs, source } = await createdLogs(gov.chain, gov.address, from);
    const out = [];
    const parsed = [];
    for (const l of logs) { try { parsed.push(parseCreated(l)); } catch { /* a log that isn't this event's shape (a fork's variant): skipped */ } }
    for (const p of parsed.slice(-15)) {
      const s = await readStatus(gov, p);
      if (s.state === 'Active' || s.state === 'Pending') out.push({ ...p, ...s, source: `${source} (proposals) and RPC (state, tally, quorum)` });
    }
    return out;
  });
}

/* ── for a wallet ── */

/** The wallet's votes now, its token balance and who it delegates to, on one governor's token. */
async function holder(gov, wallet) {
  if (!gov.token) return null;
  const r = await multicall(gov.chain, [
    { target: gov.token, iface: TOKEN, fn: 'getVotes', args: [wallet] }, { target: gov.token, iface: TOKEN, fn: 'getCurrentVotes', args: [wallet] },
    { target: gov.token, iface: TOKEN, fn: 'balanceOf', args: [wallet] }, { target: gov.token, iface: TOKEN, fn: 'delegates', args: [wallet] },
  ]);
  const votes = val(r[0]) ?? val(r[1]);
  const balance = val(r[2]);
  const delegate = val(r[3]);
  return {
    votes: votes === undefined ? null : BigInt(votes), balance: balance === undefined ? null : BigInt(balance),
    delegates_to: delegate === undefined ? null : lower(delegate) === ethers.ZeroAddress ? null : lower(delegate),
  };
}

/** The wallet's voting power on a proposal (at its snapshot), and its vote if it cast one. */
async function onProposal(gov, p, wallet) {
  const id = BigInt(p.id);
  if (gov.oz) {
    const calls = [{ target: gov.address, iface: GOV, fn: 'hasVoted', args: [id, wallet] }];
    if (p.state === 'Active' && p.snapshot_point !== null) calls.push({ target: gov.address, iface: GOV, fn: 'getVotes', args: [wallet, BigInt(p.snapshot_point)] });
    const r = await multicall(gov.chain, calls);
    // OpenZeppelin's hasVoted says whether, not how; the vote itself is public in the governor's VoteCast logs.
    return { voted: val(r[0]) === true ? { support: null } : null, power: r[1] ? (val(r[1]) === undefined ? null : BigInt(val(r[1]))) : null };
  }
  const r = await multicall(gov.chain, [
    { target: gov.address, iface: GOV, fn: 'getReceipt', args: [id, wallet] },
    ...(p.state === 'Active' && p.snapshot_point !== null ? [{ target: gov.token, iface: TOKEN, fn: 'getPriorVotes', args: [wallet, BigInt(p.snapshot_point)] }] : []),
  ]);
  const receipt = val(r[0]);
  return { voted: receipt?.hasVoted ? { support: SUPPORT[Number(receipt.support)] } : null, power: r[1] ? (val(r[1]) === undefined ? null : BigInt(val(r[1]))) : null };
}

/**
 * Every governor (the registry, and ones the account added) where the
 * wallet has votes or holds the token, with its open proposals.
 */
async function forWallet(wallet, { extra = [] } = {}) {
  wallet = ethers.getAddress(wallet);
  const governors = []; const proposals = []; const notChecked = [];
  const list = [...REGISTRY, ...extra.filter(e => !REGISTRY.some(r => r.chain === e.chain && r.address === lower(e.address)))];
  await Promise.all(list.map(async g => {
    try {
      const gov = await readGovernor(g.chain, g.address);
      if (!gov) { notChecked.push({ check: `${g.name || g.address} on ${g.chain}`, reason: 'it doesn\'t answer as an OpenZeppelin Governor or a Governor Bravo' }); return; }
      const h = await holder(gov, wallet);
      if (!h || (!(h.votes > 0n) && !(h.balance > 0n))) return;
      const fmt = x => (x === null ? null : ethers.formatUnits(x, gov.decimals));
      const counted = h.votes === null ? null : h.votes;
      governors.push({
        name: g.name || gov.name, chain: gov.chain, chain_id: EVM[gov.chain]?.chainId, address: gov.address, kind: gov.kind, token: gov.token, symbol: gov.symbol,
        balance: fmt(h.balance), your_votes: fmt(counted), delegates_to: h.delegates_to,
        delegated: h.delegates_to ? (h.delegates_to === lower(wallet) ? 'to yourself' : `to ${h.delegates_to}`) : 'to nobody',
        ...(h.balance > 0n && !h.delegates_to ? { needs_delegation: `Your ${fmt(h.balance)} ${gov.symbol || 'tokens'} count for nobody until they're delegated. Delegating to yourself is one transaction and lets you vote.` } : {}),
      });
      let open;
      try { open = await openProposals(gov); } catch (err) { notChecked.push({ check: `${g.name || gov.name} proposals`, reason: err.message }); return; }
      for (const p of open) {
        const me = await onProposal(gov, p, wallet).catch(() => ({ voted: null, power: null }));
        const { description, ...rest } = p;
        const flags = [...new Set(p.actions.flatMap(a => a.flags || []))];
        const why = p.state !== 'Active' ? 'voting hasn\'t opened yet' : me.power === 0n ? 'you had no votes at its snapshot (delegate before the next one)' : null;
        proposals.push({
          ...rest, kind: 'onchain', governor: { name: g.name || gov.name, chain: gov.chain, chain_id: EVM[gov.chain]?.chainId, address: gov.address, symbol: gov.symbol },
          ...(flags.length ? { flags } : {}), your_voting_power: me.power === null ? null : fmt(me.power), voted: me.voted,
          can_vote_here: !me.voted && !why && me.power > 0n, ...(why && !me.voted ? { why_not_here: why } : {}),
        });
      }
    } catch (err) {
      notChecked.push({ check: `${g.name || g.address} on ${g.chain}`, reason: err.message });
    }
  }));
  proposals.sort((a, b) => (a.voted ? 1 : 0) - (b.voted ? 1 : 0) || (a.hours_left ?? 1e9) - (b.hours_left ?? 1e9));
  return { governors, proposals, not_checked: notChecked, source: 'Each governor and its voting token, read onchain (RPC); proposals from their ProposalCreated logs' };
}

/** One proposal, with its full description, for a summary. */
async function proposal(chain, address, id) {
  const gov = await readGovernor(chain, address);
  if (!gov) throw new GovernorRefused(`${address} on ${chain} isn't an OpenZeppelin Governor or a Governor Bravo`, 404);
  const p = (await openProposals(gov)).find(x => x.id === String(id));
  if (!p) throw new GovernorRefused(`No open proposal ${id} on this governor (RektBull reads proposals from the last ${LOOKBACK_DAYS} days).`, 404);
  return { gov, p };
}

/* ── transactions the wallet sends ── */

async function simulateOrRefuse(chain, from, call, what) {
  let results;
  try { results = await require('./presign').simulate(chain, from, [call]); } catch (err) { throw new GovernorRefused(`The ${what} couldn't be simulated on ${chain} (${err.message}). Try again later.`, 503); }
  const r = results[0];
  if (!r || r.status === '0x0' || r.error) throw new GovernorRefused(`The ${what} would fail onchain${r?.error?.message ? `: ${r.error.message}` : ''}.`);
}

/** A vote: castVote (or castVoteWithReason), checked and simulated from the wallet. */
async function prepareVote({ wallet, chain, governor, proposal_id, support, reason = '' }) {
  if (![0, 1, 2].includes(Number(support))) throw new GovernorRefused('support must be 0 (Against), 1 (For) or 2 (Abstain)', 400);
  const { gov, p } = await proposal(chain, governor, proposal_id);
  if (p.state !== 'Active') throw new GovernorRefused(`Voting on "${p.title}" isn't open (${p.state}).`);
  const me = await onProposal(gov, p, wallet);
  if (me.voted) throw new GovernorRefused('This wallet has already voted on it.');
  if (!(me.power > 0n)) throw new GovernorRefused(`This wallet had no ${gov.symbol || 'votes'} at the proposal's snapshot, so the vote would count for nothing.`);
  const data = reason ? GOV.encodeFunctionData('castVoteWithReason', [BigInt(p.id), Number(support), String(reason).slice(0, 1000)]) : GOV.encodeFunctionData('castVote', [BigInt(p.id), Number(support)]);
  const call = { to: gov.address, data, value: '0x0', label: `Vote ${SUPPORT[Number(support)]} on "${p.title}"` };
  await simulateOrRefuse(gov.chain, lower(wallet), call, 'vote');
  return {
    chain: gov.chain, chain_id: ethers.toQuantity(EVM[gov.chain].chainId), calls: [call], atomic: false,
    vote: { governor: gov.name, title: p.title, support: SUPPORT[Number(support)], voting_power: ethers.formatUnits(me.power, gov.decimals), symbol: gov.symbol },
    note: 'A vote onchain is a transaction: it costs gas and can\'t be changed. It moves no tokens and approves nothing.',
  };
}

/** Delegating the wallet's votes to itself (or another address it names), simulated from the wallet. */
async function prepareDelegate({ wallet, chain, governor, to = null }) {
  const gov = await readGovernor(chain, governor);
  if (!gov?.token) throw new GovernorRefused('That governor\'s voting token couldn\'t be read.', 404);
  const delegatee = to ? lower(to) : lower(wallet);
  if (!isAddr(delegatee)) throw new GovernorRefused('to must be an address', 400);
  const call = { to: gov.token, data: TOKEN.encodeFunctionData('delegate', [delegatee]), value: '0x0', label: `Delegate your ${gov.symbol || 'votes'} to ${delegatee === lower(wallet) ? 'yourself' : delegatee}` };
  await simulateOrRefuse(gov.chain, lower(wallet), call, 'delegation');
  return {
    chain: gov.chain, chain_id: ethers.toQuantity(EVM[gov.chain].chainId), calls: [call], atomic: false,
    note: delegatee === lower(wallet)
      ? 'Delegating to yourself keeps your tokens in your wallet and turns them into votes you cast. It doesn\'t move or approve anything; only votes from your next proposals count.'
      : `This gives your voting power to ${delegatee}. Your tokens stay in your wallet, and you can delegate back at any time.`,
  };
}

/** A governor an account adds by hand: checked to be one. */
async function check(chain, address) {
  if (!EVM[chain]) throw new GovernorRefused(`chain must be one of ${Object.keys(EVM).join(', ')}`, 400);
  if (!isAddr(address)) throw new GovernorRefused('governor must be an address', 400);
  const gov = await readGovernor(chain, address);
  if (!gov) throw new GovernorRefused('That address doesn\'t answer as an OpenZeppelin Governor or a Governor Bravo.', 404);
  return gov;
}

module.exports = { REGISTRY, GOV, TOKEN, SUPPORT, STATES, PROPOSAL_CREATED, decodeAction, readGovernor, openProposals, forWallet, proposal, prepareVote, prepareDelegate, check, GovernorRefused };
