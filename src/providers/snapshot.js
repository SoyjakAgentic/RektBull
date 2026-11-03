/**
 * Snapshot: off-chain DAO votes (carried over from soyjak-agentic's
 * snapshotHub.js). Read from the hub's free GraphQL API; votes the user's
 * wallet signs are sent to Snapshot's sequencer, which checks the signature
 * and the voting power itself. Every call is counted (usage.track), and the
 * reads that can be reused are cached.
 */
const axios = require('axios');
const { track } = require('./usage');
const { cached } = require('../lib/cache');

const HUB = 'https://hub.snapshot.org/graphql';
const SEQUENCER = 'https://seq.snapshot.org';
const PROPOSAL_FIELDS = `id title body choices start end state author type quorum snapshot network
  scores scores_total scores_state privacy discussion link
  space { id name avatar voting { quorum type } }`;

// The HTTP calls, on their own so tests can stand in for Snapshot.
const http = { post: (url, body, opts) => axios.post(url, body, opts) };

async function gql(query, variables) {
  const { data } = await track('snapshot', () => http.post(HUB, { query, variables }, { timeout: 12000 }));
  if (data?.errors?.length) throw new Error(`Snapshot: ${data.errors[0]?.message || 'unknown error'}`);
  return data?.data || {};
}

/** The spaces a wallet follows on Snapshot, and the ones it has voted in lately. */
async function spacesOf(wallet) {
  return cached(`snapshot:spaces:${wallet}`, 30 * 60, async () => {
    const d = await gql(`query ($w: String!) {
      follows(first: 100, where: { follower: $w }) { space { id } }
      votes(first: 200, where: { voter: $w }, orderBy: "created", orderDirection: desc) { space { id } }
    }`, { w: wallet });
    return {
      followed: [...new Set((d.follows || []).map(f => f.space?.id).filter(Boolean))],
      voted_in: [...new Set((d.votes || []).map(v => v.space?.id).filter(Boolean))],
    };
  });
}

/** Active proposals in these spaces, soonest to close first. */
async function activeProposals(spaces) {
  if (!spaces.length) return [];
  const key = `snapshot:active:${[...spaces].sort().join(',')}`;
  return cached(key, 5 * 60, async () => {
    const d = await gql(`query ($s: [String]) {
      proposals(first: 100, where: { space_in: $s, state: "active" }, orderBy: "end", orderDirection: asc) { ${PROPOSAL_FIELDS} }
    }`, { s: spaces });
    return d.proposals || [];
  });
}

/** One proposal, fresh (no cache: votes and scores move). */
async function proposal(id) {
  const d = await gql(`query ($id: String!) { proposal(id: $id) { ${PROPOSAL_FIELDS} } }`, { id });
  return d.proposal || null;
}

/** The wallet's votes on these proposals: { proposalId: { choice, vp, created } }. */
async function votesOn(wallet, proposalIds) {
  if (!proposalIds.length) return {};
  const d = await gql(`query ($w: String!, $p: [String]) {
    votes(first: 1000, where: { voter: $w, proposal_in: $p }) { proposal { id } choice vp created }
  }`, { w: wallet, p: proposalIds });
  return Object.fromEntries((d.votes || []).map(v => [v.proposal.id, { choice: v.choice, vp: v.vp, created: v.created }]));
}

/** The wallet's voting power on a proposal (at its snapshot block), by Snapshot's own count. */
async function votingPower(wallet, space, proposalId) {
  return cached(`snapshot:vp:${wallet}:${proposalId}`, 10 * 60, async () => {
    const d = await gql(`query ($w: String!, $s: String!, $p: String) { vp(voter: $w, space: $s, proposal: $p) { vp vp_state } }`, { w: wallet, s: space, p: proposalId });
    return { vp: Number(d.vp?.vp || 0), state: d.vp?.vp_state || null };
  });
}

/** Whether a space exists, and its name. */
async function space(id) {
  return cached(`snapshot:space:${id}`, 24 * 3600, async () => {
    const d = await gql('query ($id: String!) { space(id: $id) { id name } }', { id });
    return d.space || null;
  });
}

/** Sends a signed vote envelope ({ address, sig, data }) to Snapshot's sequencer. */
async function relay(envelope) {
  try {
    const { data } = await track('snapshot-sequencer', () => http.post(SEQUENCER, envelope, { timeout: 15000, headers: { accept: 'application/json' } }));
    return data;
  } catch (err) {
    const why = err.response?.data?.error_description || err.response?.data?.error || err.message;
    throw Object.assign(new Error(`Snapshot didn't accept the vote: ${why}`), { status: 422 });
  }
}

/** A choice as the labels it names, for any voting type. */
function choiceLabel(choice, choices = [], type = 'single-choice') {
  const label = n => choices[Number(n) - 1] ?? `choice ${n}`;
  if (typeof choice === 'string' && !/^\d+$/.test(choice)) return 'hidden until the vote closes (shielded)';
  if (Array.isArray(choice)) return type === 'ranked-choice' ? choice.map((n, i) => `${i + 1}. ${label(n)}`).join(', ') : choice.map(label).join(', ');
  if (choice && typeof choice === 'object') {
    const total = Object.values(choice).reduce((s, w) => s + Number(w || 0), 0) || 1;
    return Object.entries(choice).map(([n, w]) => `${label(n)} ${Math.round((Number(w) / total) * 1000) / 10}%`).join(', ');
  }
  return label(choice);
}

module.exports = { http, gql, spacesOf, activeProposals, proposal, votesOn, votingPower, space, relay, choiceLabel, HUB, SEQUENCER };
