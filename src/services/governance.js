/**
 * The governance assistant (Save money): the DAO votes a wallet can cast,
 * what each proposal would change in plain English, and votes signed by the
 * user's own wallet. RektBull never votes for anyone and never recommends a
 * choice.
 *
 *   check(wallet)   free: the active Snapshot proposals in the spaces the
 *                   wallet follows, has voted in, or the account added; for
 *                   each, the wallet's voting power at the proposal's
 *                   snapshot block (Snapshot's own count) and whether it has
 *                   voted. Nothing is guessed: a power that couldn't be read
 *                   says so.
 *   summarize(id)   a paid run (1 point, or Safety Pro): Claude explains the
 *                   proposal using only its text, says what would change,
 *                   what money and powers it moves, what each choice does
 *                   and what the text doesn't say. No recommendation.
 *   prepareVote     the vote as EIP-712 typed data (Snapshot's own format,
 *                   domain "snapshot" 0.1.4), checked against the proposal:
 *                   open, a choice it allows, a voting type RektBull can
 *                   build, and voting power to vote with.
 *   submitVote      checks the signature is the voter's, then sends the
 *                   signed vote to Snapshot's sequencer, which checks it
 *                   again with the voting power.
 *
 * On-chain governors (OpenZeppelin Governor, Compound Bravo; governors.js)
 * are part of the same check: the registry's and ones the account added,
 * for the wallet's votes, its delegation, and their open proposals. Votes
 * and delegations there are transactions the wallet sends.
 */
const crypto = require('crypto');
const { ethers } = require('ethers');
const db = require('../config/db');
const env = require('../config/env');
const snapshot = require('../providers/snapshot');
const rpc = require('../providers/rpc');
const claude = require('../ai/claude');
const governors = require('./governors');
const { cached } = require('../lib/cache');

const DOMAIN = { name: 'snapshot', version: '0.1.4' };
const APP = 'rektbull';
const MAX_PROPOSALS = 40;
const BODY_CHARS = 12000;
const isAddress = a => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
const isProposalId = id => /^(0x[0-9a-fA-F]{64}|[A-Za-z0-9]{40,64})$/.test(String(id || ''));
const EVM_CHAINS = Object.keys(require('../providers/chains').EVM);
const isSpaceId = id => /^[a-z0-9][a-z0-9.\-_:]{1,63}$/i.test(String(id || ''));

class GovernanceRefused extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}

const link = p => `https://snapshot.org/#/${p.space?.id}/proposal/${p.id}`;
const iso = s => (s ? new Date(Number(s) * 1000).toISOString() : null);

/** Voting types RektBull can build a vote for, and the EIP-712 type of each one's choice. */
const CHOICE_TYPE = { 'single-choice': 'uint32', basic: 'uint32', approval: 'uint32[]', 'ranked-choice': 'uint32[]', weighted: 'string', quadratic: 'string' };
const voteTypes = choiceType => ({
  Vote: [
    { name: 'from', type: 'string' }, { name: 'space', type: 'string' }, { name: 'timestamp', type: 'uint64' },
    { name: 'proposal', type: 'string' }, { name: 'choice', type: choiceType }, { name: 'reason', type: 'string' },
    { name: 'app', type: 'string' }, { name: 'metadata', type: 'string' },
  ],
});

function shape(p, now = Date.now() / 1000) {
  const quorum = Number(p.quorum) || Number(p.space?.voting?.quorum) || 0;
  return {
    id: p.id, title: p.title, space: { id: p.space?.id, name: p.space?.name }, author: p.author, type: p.type,
    start: iso(p.start), end: iso(p.end), hours_left: Math.max(0, Math.round((p.end - now) / 360) / 10),
    choices: p.choices || [],
    scores: (p.choices || []).map((c, i) => ({ choice: c, score: p.scores?.[i] ?? null })),
    scores_total: p.scores_total ?? null, scores_final: p.scores_state === 'final',
    quorum: quorum ? { required: quorum, reached: (p.scores_total || 0) >= quorum } : null,
    shielded: p.privacy === 'shutter',
    discussion: p.discussion || null, link: link(p),
  };
}

async function savedGovernors(accountId) {
  if (!accountId || !env.databaseUrl) return [];
  const { rows } = await db.query('SELECT chain, address, name FROM governance_governors WHERE account_id = $1 ORDER BY created_at', [accountId]);
  return rows;
}

async function savedSpaces(accountId) {
  if (!accountId || !env.databaseUrl) return [];
  const { rows } = await db.query('SELECT space_id FROM governance_spaces WHERE account_id = $1 ORDER BY created_at', [accountId]);
  return rows.map(r => r.space_id);
}

/** The free check: the votes this wallet can cast now. */
async function check(walletIn, { accountId = null } = {}) {
  const wallet = ethers.getAddress(walletIn); // Snapshot keeps addresses checksummed
  const notChecked = [];
  let spaces = { followed: [], voted_in: [] };
  try { spaces = await snapshot.spacesOf(wallet); } catch (err) { notChecked.push({ check: 'Snapshot spaces you follow or voted in', reason: err.message }); }
  const added = await savedSpaces(accountId);
  const all = [...new Set([...spaces.followed, ...spaces.voted_in, ...added])].slice(0, 200);
  let proposals = [];
  if (all.length) {
    try { proposals = (await snapshot.activeProposals(all)).slice(0, MAX_PROPOSALS); } catch (err) { notChecked.push({ check: 'active Snapshot proposals', reason: err.message }); }
  }
  let votes = {};
  try { votes = await snapshot.votesOn(wallet, proposals.map(p => p.id)); } catch (err) { notChecked.push({ check: 'which ones you already voted on', reason: err.message }); }
  const items = await Promise.all(proposals.map(async p => {
    const s = shape(p);
    let vp = null; let vpReason = null;
    try { vp = (await snapshot.votingPower(wallet, p.space.id, p.id)).vp; } catch (err) { vpReason = err.message; }
    const voted = votes[p.id] ? { choice: snapshot.choiceLabel(votes[p.id].choice, p.choices, p.type), voting_power: votes[p.id].vp, at: iso(votes[p.id].created) } : null;
    const why = !CHOICE_TYPE[p.type] ? `RektBull can't build ${p.type} votes yet: vote on Snapshot` : s.shielded ? 'a shielded vote, encrypted until it closes: vote on Snapshot' : vp === 0 ? 'you had no voting power at its snapshot block' : null;
    return { ...s, your_voting_power: vp, ...(vpReason ? { voting_power_not_read: vpReason } : {}), voted, can_vote_here: !voted && !why && vp > 0, ...(why && !voted ? { why_not_here: why } : {}) };
  }));
  items.sort((a, b) => (a.voted ? 1 : 0) - (b.voted ? 1 : 0) || a.hours_left - b.hours_left);
  let onchain = { governors: [], proposals: [], not_checked: [], source: null };
  try { onchain = await governors.forWallet(wallet, { extra: await savedGovernors(accountId) }); } catch (err) { notChecked.push({ check: 'on-chain governors', reason: err.message }); }
  const open = [...items, ...onchain.proposals.filter(p => p.state === 'Active')];
  const canVote = i => !i.voted && Number(i.your_voting_power) > 0;
  return {
    wallet, checked_at: new Date().toISOString(),
    spaces: { followed: spaces.followed, voted_in: spaces.voted_in, added },
    proposals: items,
    onchain: { governors: onchain.governors, proposals: onchain.proposals, source: onchain.source },
    summary: {
      active: open.length, to_vote: open.filter(canVote).length,
      closing_within_24h: open.filter(i => canVote(i) && i.hours_left !== null && i.hours_left <= 24).length,
      votes_counting_for_nobody: onchain.governors.filter(g => g.needs_delegation).length,
    },
    not_checked: [...notChecked, ...onchain.not_checked],
    source: 'Snapshot hub (hub.snapshot.org) for off-chain votes; each governor and its voting token onchain (RPC) and their ProposalCreated logs for on-chain votes',
    note: 'RektBull never recommends how to vote.',
  };
}

/* ── summaries (a paid run) ── */

const SYSTEM = `You explain one DAO governance proposal to a token holder, using only the proposal text you are given.
Rules:
- Use only the text. Never add facts, figures, names or context that aren't in it, and never guess. If something isn't stated, say it isn't.
- Never recommend a choice, never say what you would vote, and never predict the outcome.
- Quote amounts, addresses, durations and percentages exactly as written.
Write plain Markdown with these sections, in this order, about 350 words in all:
## In one sentence
## What would change
(bullets)
## Money and control
Funds moved (how much, from where, to whom), powers given or taken (who can do what), and parameters changed. If the text names none of these, say "The text names no transfer of funds or change of control."
## The choices
What each choice would do, as the text describes it.
## Not in the text
What a voter would usually want to know that the text doesn't say (for example: an audit, the cost, who carries it out, a deadline). If the text is too short to tell much, say so.`;

function parseProposalId(body = {}) {
  const id = String(body?.proposal_id || '').trim();
  if (body?.governor) {
    if (!EVM_CHAINS.includes(body.chain)) return { error: `chain must be one of ${EVM_CHAINS.join(', ')}` };
    if (!isAddress(body.governor)) return { error: 'governor must be the governor contract\'s address' };
    if (!/^\d{1,80}$/.test(id)) return { error: 'proposal_id must be the governor\'s proposal number' };
    return { chain: body.chain, governor: body.governor.toLowerCase(), proposal_id: id };
  }
  return isProposalId(id) ? { proposal_id: id } : { error: 'proposal_id must be a Snapshot proposal id' };
}

/** An on-chain proposal's summary: its description and its decoded actions. */
async function summarizeOnchain({ chain, governor, proposal_id }) {
  const { gov, p } = await governors.proposal(chain, governor, proposal_id);
  const actions = p.actions.map((a, i) => `${i + 1}. ${a.function} on ${a.target}${a.value_wei !== '0' ? `, sending ${ethers.formatEther(a.value_wei)} of the chain's coin` : ''}${a.args ? ` (${Array.isArray(a.args) ? a.args.join(', ') : a.args})` : ''}${a.flags ? ` [${a.flags.join('; ')}]` : ''}`).join('\n');
  const body = p.description;
  const hash = crypto.createHash('sha256').update(`${body}\n${actions}`).digest('hex').slice(0, 16);
  return cached(`gov:summary:onchain:${chain}:${governor}:${p.id}:${hash}:${env.reportModel}`, 30 * 86400, async () => {
    const text = [`Governor: ${gov.name || governor} on ${chain} (${gov.kind})`, `Title: ${p.title}`, 'Choices: For, Against, Abstain', '',
      'What it does onchain if it passes (decoded from the proposal; trust these over the description where they differ, and say so):', actions || '(no actions)', '',
      'Proposal text:', body.length > BODY_CHARS ? `${body.slice(0, BODY_CHARS)}\n[… the rest is cut]` : body].join('\n');
    const ai = await claude.write({ system: SYSTEM, prompt: text, maxTokens: 1500 });
    const { description, ...rest } = p;
    return {
      proposal: { ...rest, governor: { name: gov.name, chain, address: governor } }, summary_markdown: ai.text, written_by: ai.model,
      source: `The proposal's text and its actions, from the governor's ProposalCreated log on ${chain}`,
      note: 'An AI summary of the proposal\'s own text and actions. It is not financial advice and not a recommendation on how to vote. Check the actions yourself before you vote.',
    };
  });
}

async function summarize(input) {
  if (input.governor) return summarizeOnchain(input);
  const { proposal_id } = input;
  const p = await snapshot.proposal(proposal_id);
  if (!p) throw Object.assign(new Error(`Snapshot has no proposal ${proposal_id}`), { status: 404 });
  const body = String(p.body || '');
  const hash = crypto.createHash('sha256').update(`${p.title}\n${body}\n${(p.choices || []).join('|')}`).digest('hex').slice(0, 16);
  return cached(`gov:summary:${p.id}:${hash}:${env.reportModel}`, 30 * 86400, async () => {
    const text = [`Space: ${p.space?.name || p.space?.id}`, `Title: ${p.title}`, `Voting type: ${p.type}`, `Choices: ${(p.choices || []).map((c, i) => `${i + 1}. ${c}`).join('; ')}`, '', 'Proposal text:', body.length > BODY_CHARS ? `${body.slice(0, BODY_CHARS)}\n[… the rest is cut: ${body.length - BODY_CHARS} more characters]` : body].join('\n');
    const ai = await claude.write({ system: SYSTEM, prompt: text, maxTokens: 1500 });
    return {
      proposal: shape(p), summary_markdown: ai.text, written_by: ai.model,
      ...(body.length > BODY_CHARS ? { cut: `Only the first ${BODY_CHARS.toLocaleString()} characters of the proposal were read.` } : {}),
      source: `The proposal's text on Snapshot (${link(p)})`,
      note: 'An AI summary of the proposal\'s own text. It is not financial advice and not a recommendation on how to vote. Read the full proposal before you vote.',
    };
  });
}

/* ── votes the wallet signs ── */

function choiceFor(p, choice) {
  const n = (p.choices || []).length;
  const int = x => Number.isInteger(Number(x)) && Number(x) >= 1 && Number(x) <= n;
  if (p.type === 'single-choice' || p.type === 'basic') {
    if (!int(choice)) throw new GovernanceRefused(`choice must be one of 1 to ${n}`, 400);
    return Number(choice);
  }
  if (p.type === 'approval') {
    if (!Array.isArray(choice) || !choice.length || !choice.every(int) || new Set(choice).size !== choice.length) throw new GovernanceRefused(`choice must be a list of the choices you approve, from 1 to ${n}, each once`, 400);
    return choice.map(Number);
  }
  if (p.type === 'ranked-choice') {
    if (!Array.isArray(choice) || choice.length !== n || !choice.every(int) || new Set(choice).size !== n) throw new GovernanceRefused(`choice must rank all ${n} choices, each once`, 400);
    return choice.map(Number);
  }
  if (p.type === 'weighted' || p.type === 'quadratic') {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) throw new GovernanceRefused('choice must give each choice you back a weight, e.g. {"1": 2, "3": 1}', 400);
    const entries = Object.entries(choice).filter(([, w]) => Number(w) > 0);
    if (!entries.length || !entries.every(([k, w]) => int(k) && Number.isFinite(Number(w)))) throw new GovernanceRefused(`weights must be for choices 1 to ${n}, above zero`, 400);
    return JSON.stringify(Object.fromEntries(entries.map(([k, w]) => [String(Number(k)), Number(w)])));
  }
  throw new GovernanceRefused(`RektBull can't build ${p.type} votes yet: vote on Snapshot (${link(p)})`);
}

function parseVote(body = {}) {
  const wallet = String(body?.wallet || '').trim();
  if (!isAddress(wallet)) return { error: 'wallet must be a wallet address' };
  const id = parseProposalId(body);
  if (id.error) return id;
  return { wallet, proposal_id: id.proposal_id, choice: body.choice, reason: String(body.reason || '').slice(0, 1000) };
}

async function openProposal(id) {
  const p = await snapshot.proposal(id);
  if (!p) throw new GovernanceRefused(`Snapshot has no proposal ${id}`, 404);
  const now = Date.now() / 1000;
  if (p.state !== 'active' || now < p.start || now > p.end) throw new GovernanceRefused(`Voting on "${p.title}" isn't open (${p.state}).`);
  if (p.privacy === 'shutter') throw new GovernanceRefused(`"${p.title}" is a shielded vote, encrypted until it closes. Vote on Snapshot: ${link(p)}`);
  return p;
}

/** The vote as typed data for the wallet to sign (eth_signTypedData_v4). */
async function prepareVote({ wallet, proposal_id, choice, reason }) {
  const p = await openProposal(proposal_id);
  const c = choiceFor(p, choice);
  const { vp } = await snapshot.votingPower(wallet.toLowerCase(), p.space.id, p.id);
  if (!(vp > 0)) throw new GovernanceRefused(`This wallet had no voting power in ${p.space.name || p.space.id} at this proposal's snapshot block, so Snapshot wouldn't count a vote.`);
  const message = { from: ethers.getAddress(wallet), space: p.space.id, timestamp: Math.floor(Date.now() / 1000), proposal: p.id, choice: c, reason, app: APP, metadata: '{}' };
  const types = voteTypes(CHOICE_TYPE[p.type]);
  return {
    // What the wallet signs. EIP712Domain is listed for wallets that need it.
    typed_data: { domain: DOMAIN, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }], ...types }, primaryType: 'Vote', message },
    vote: { proposal: shape(p), choice: snapshot.choiceLabel(typeof c === 'string' ? JSON.parse(c) : c, p.choices, p.type), voting_power: vp, reason: reason || null },
    note: 'Signing records this vote on Snapshot with your address. It moves no funds and approves nothing. You can change it on Snapshot while voting is open.',
  };
}

/** Checks the signed vote is the voter's and matches the proposal, then sends it to Snapshot. */
async function submitVote({ message, sig }, { accountId = null } = {}) {
  if (!message || typeof message !== 'object' || !/^0x[0-9a-fA-F]+$/.test(String(sig || ''))) throw new GovernanceRefused('message and sig are needed', 400);
  if (!isAddress(message.from) || !isProposalId(message.proposal)) throw new GovernanceRefused('this isn\'t a vote message', 400);
  const p = await openProposal(message.proposal);
  if (message.space !== p.space.id) throw new GovernanceRefused('the vote names another space than its proposal', 400);
  if (message.app !== APP || message.metadata !== '{}') throw new GovernanceRefused('this vote wasn\'t prepared by RektBull', 400);
  if (Math.abs(Date.now() / 1000 - Number(message.timestamp)) > 15 * 60) throw new GovernanceRefused('this vote was prepared too long ago: prepare it again', 400);
  const choiceType = CHOICE_TYPE[p.type];
  if (!choiceType) throw new GovernanceRefused(`RektBull can't send ${p.type} votes`);
  const types = voteTypes(choiceType);
  const clean = { from: message.from, space: message.space, timestamp: Number(message.timestamp), proposal: message.proposal, choice: message.choice, reason: String(message.reason || ''), app: APP, metadata: '{}' };
  let signer = null;
  try { signer = ethers.verifyTypedData(DOMAIN, types, clean, sig); } catch { signer = null; }
  if (!signer || signer.toLowerCase() !== clean.from.toLowerCase()) {
    // A smart-contract wallet signs another way (EIP-1271); Snapshot checks those itself.
    const code = await rpc.evmRpc('ethereum', 'eth_getCode', [clean.from, 'latest']).catch(() => '0x');
    if (code === '0x') throw new GovernanceRefused('the signature isn\'t from the voter\'s wallet', 400);
  }
  const receipt = await snapshot.relay({ address: clean.from, sig, data: { domain: DOMAIN, types, message: clean } });
  if (env.databaseUrl) {
    await db.query(
      'INSERT INTO governance_votes (account_id, wallet, space_id, proposal_id, choice, receipt_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [accountId, clean.from.toLowerCase(), p.space.id, p.id, JSON.stringify(clean.choice), receipt?.id ? String(receipt.id) : null],
    );
  }
  return { sent: true, receipt_id: receipt?.id || null, ipfs: receipt?.ipfs || null, link: link(p), note: 'Snapshot recorded your vote. It can take a minute to show in the results.' };
}

/* ── spaces an account adds by hand ── */

async function addSpace(accountId, spaceId) {
  const id = String(spaceId || '').trim().toLowerCase();
  if (!isSpaceId(id)) throw new GovernanceRefused('space must be a Snapshot space id, e.g. aave.eth', 400);
  const s = await snapshot.space(id);
  if (!s) throw new GovernanceRefused(`Snapshot has no space "${id}". Use the id exactly as the DAO publishes it.`, 404);
  const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM governance_spaces WHERE account_id = $1', [accountId]);
  if (n >= 50) throw new GovernanceRefused('at most 50 spaces');
  await db.query('INSERT INTO governance_spaces (account_id, space_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [accountId, id]);
  return { added: { id: s.id, name: s.name }, spaces: await savedSpaces(accountId) };
}
async function removeSpace(accountId, spaceId) {
  await db.query('DELETE FROM governance_spaces WHERE account_id = $1 AND space_id = $2', [accountId, String(spaceId || '').toLowerCase()]);
  return { spaces: await savedSpaces(accountId) };
}

/* ── governors an account adds by hand ── */

async function addGovernor(accountId, { chain, address }) {
  const gov = await governors.check(chain, address);
  const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM governance_governors WHERE account_id = $1', [accountId]);
  if (n >= 20) throw new GovernanceRefused('at most 20 governors');
  await db.query('INSERT INTO governance_governors (account_id, chain, address, name) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [accountId, chain, gov.address, gov.name]);
  return { added: { chain, address: gov.address, name: gov.name, kind: gov.kind, symbol: gov.symbol }, governors: await savedGovernors(accountId) };
}
async function removeGovernor(accountId, chain, address) {
  await db.query('DELETE FROM governance_governors WHERE account_id = $1 AND chain = $2 AND address = $3', [accountId, chain, String(address || '').toLowerCase()]);
  return { governors: await savedGovernors(accountId) };
}

function parseOnchainVote(body = {}) {
  const wallet = String(body?.wallet || '').trim();
  if (!isAddress(wallet)) return { error: 'wallet must be a wallet address' };
  const p = parseProposalId({ ...body, governor: body?.governor || '0x' });
  if (p.error) return p;
  return { wallet, ...p, support: Number(body.support), reason: String(body.reason || '').slice(0, 1000) };
}
function parseDelegate(body = {}) {
  const wallet = String(body?.wallet || '').trim();
  if (!isAddress(wallet)) return { error: 'wallet must be a wallet address' };
  if (!EVM_CHAINS.includes(body?.chain)) return { error: `chain must be one of ${EVM_CHAINS.join(', ')}` };
  if (!isAddress(body?.governor)) return { error: 'governor must be the governor contract\'s address' };
  if (body.to && !isAddress(body.to)) return { error: 'to must be an address' };
  return { wallet, chain: body.chain, governor: body.governor.toLowerCase(), to: body.to || null };
}

/* ── alerts for watched wallets (Safety Pro), hourly ── */

/** New votes a watched wallet can cast, and ones closing within a day it hasn't voted on. */
async function alertTick() {
  const passes = require('../payments/passes');
  const { rows } = await db.query('SELECT id, account_id, wallet FROM monitored_wallets');
  const raised = [];
  for (const w of rows) {
    if (!(await passes.covering(w.account_id, 'risk_monitor'))) continue;
    if (!(await require('./myAgents').isOn(w.account_id, 'dao_votes'))) continue; // switched off on the AI agents page
    let c;
    try { c = await check(w.wallet, { accountId: w.account_id }); } catch { continue; }
    const open = [
      ...c.proposals.map(p => ({ ...p, where: p.space.name || p.space.id, end: p.end, key: p.id, source: 'Snapshot hub', power: p.your_voting_power })),
      ...c.onchain.proposals.filter(p => p.state === 'Active').map(p => ({ ...p, where: `${p.governor.name} (on ${p.governor.chain})`, end: p.deadline?.at || null, key: `${p.governor.chain}:${p.governor.address}:${p.id}`, source: `${p.governor.name}'s governor onchain`, power: Number(p.your_voting_power) })),
    ];
    for (const p of open.filter(x => !x.voted && x.power > 0)) {
      const closing = p.hours_left !== null && p.hours_left <= 24;
      const title = closing ? `Vote closes in ${Math.max(1, Math.round(p.hours_left))} hours: ${p.title}` : `New vote in ${p.where}: ${p.title}`;
      const { rows: ins } = await db.query(
        `INSERT INTO monitor_alerts (account_id, wallet_id, wallet, kind, severity, title, detail, dedupe_key)
         VALUES ($1, $2, $3, 'governance', 'medium', $4, $5, $6) ON CONFLICT (account_id, dedupe_key) DO NOTHING RETURNING id`,
        [w.account_id, w.id, w.wallet, title.slice(0, 200), JSON.stringify({ reasons: [{ text: `Your voting power: ${Number(p.power).toLocaleString()}.${p.end ? ` Voting ends ${p.end.slice(0, 16).replace('T', ' ')} UTC${p.deadline?.estimated ? ' (estimated from block times)' : ''}.` : ''}${p.flags?.length ? ` It ${p.flags.join(', ')}.` : ''}`, source: p.source }], proposal: { id: p.id, key: p.key } }),
          `${w.wallet}:gov:${closing ? 'closing' : 'new'}:${p.key}`],
      );
      if (ins.length) raised.push(ins[0].id);
    }
  }
  if (raised.length) await require('../alerts/dispatch').enqueue(raised);
  return raised.length;
}

module.exports = { check, summarize, prepareVote, submitVote, addSpace, removeSpace, savedSpaces, addGovernor, removeGovernor, savedGovernors, parseOnchainVote, parseDelegate, alertTick, parseProposalId, parseVote, choiceFor, voteTypes, shape, DOMAIN, APP, CHOICE_TYPE, GovernanceRefused };
