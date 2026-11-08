/**
 * Launch Safety: was a token's early supply bundled by insiders, and are they
 * selling? Ported from soyjak-agentic's Launch Bundle Detector and Insider
 * Wallet Tracer, which were AI prompts with tools. Here every step is a
 * deterministic check with a named source; nothing is decided by AI.
 *
 * The method (the same as Soyjak's, a standard onchain forensic technique):
 *   1. Find the launch: who deployed the token, and when trading started.
 *   2. List the wallets that received it in the first hour (contracts such as
 *      the pool, routers and lockers are set aside).
 *   3. Find where each early buyer's first ETH, BNB, POL or SOL came from.
 *      Bundled wallets almost always share a funding source shortly before
 *      the launch: funding dozens of independent wallets is extra work most
 *      bundlers skip.
 *   4. Group the buyers by funder, and walk each funding chain back up to 3
 *      steps to see whether it reaches the deployer (the insider trace).
 *   5. Read what each group still holds now: a bundle already selling is the
 *      urgent case.
 *
 * What it is not: proof of intent. An exchange paying out withdrawals funds
 * many wallets too, so a funder that has sent thousands of transactions is
 * named as busy and not counted. Every finding says what the data shows and
 * no more.
 *
 * EVM chains are read through the block explorer (Etherscan V2, then
 * Blockscout) and RPC; Solana through RPC. Results are cached 30 minutes.
 */
const { cached } = require('../lib/cache');
const { EVM } = require('../providers/chains');

const WINDOW_MINUTES = 60;
const MAX_BUYERS = 30;          // the largest early buyers traced
const MAX_CANDIDATES = 60;      // early receivers checked for being a contract
const GROUP_MIN = 3;            // wallets sharing a funder before it counts as a group
const BUSY_TXS = 2000;          // a funder with more sends than this is likely an exchange or a service
const HOPS = 3;                 // how far back a funding chain is walked toward the deployer
const SOLANA_SIG_PAGES = 10;    // up to 10,000 transactions back to find a Solana launch
const CACHE_SECONDS = 1800;
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';
const CHAINS = [...Object.keys(EVM), 'solana'];

class LaunchRefused extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const isEvmAddr = a => /^0x[0-9a-fA-F]{40}$/.test(a);
const isSolAddr = a => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

function parse(body = {}) {
  const chain = String(body.chain || '').toLowerCase();
  const token = String(body.token_address || body.token || '').trim();
  if (!CHAINS.includes(chain)) return { error: `chain must be one of: ${CHAINS.join(', ')}.` };
  if (chain === 'solana' ? !isSolAddr(token) : !isEvmAddr(token)) return { error: chain === 'solana' ? 'token must be a Solana mint address.' : 'token must be a token contract address (0x and 40 hex characters).' };
  return { chain, token: chain === 'solana' ? token : token.toLowerCase() };
}

/** Runs fn over items, a few at a time (explorer and RPC free plans limit calls per second). */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const pct = (part, whole) => (whole > 0n ? Number((part * 1000000n) / whole) / 10000 : null);
const short = a => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/* ── EVM ─────────────────────────────────────────────────────────────── */

const explorer = () => require('../providers/explorer');
const rpc = () => require('../providers/rpc');
const rows = data => (Array.isArray(data?.result) ? data.result : []);

/** The first incoming transfer of native coin to addr (its funder), or null. */
async function evmFunding(chain, addr) {
  for (const action of ['txlist', 'txlistinternal']) {
    const r = rows(await explorer().explorerGet(chain, { module: 'account', action, address: addr, sort: 'asc', page: 1, offset: 25 }));
    const first = r.find(t => t.to?.toLowerCase() === addr && BigInt(t.value || '0') > 0n && String(t.isError || '0') === '0');
    if (first) return { funder: first.from.toLowerCase(), at: Number(first.timeStamp) * 1000, tx: first.hash, via: action === 'txlist' ? 'a transfer' : 'a contract call' };
  }
  return null;
}

async function evmData(chain, token) {
  const ex = explorer();
  const [creation, transfers] = await Promise.all([
    ex.explorerGet(chain, { module: 'contract', action: 'getcontractcreation', contractaddresses: token }).catch(() => null),
    ex.explorerGet(chain, { module: 'account', action: 'tokentx', contractaddress: token, sort: 'asc', page: 1, offset: 1000 })
      .catch(err => { require('../config/logger').warn('launch check: explorer failed', { chain, error: err.message }); throw new LaunchRefused('The block explorer didn\'t answer, so the launch couldn\'t be read. Try again shortly; you weren\'t charged.', 503); }),
  ]);
  const tx = rows(transfers);
  if (!tx.length) throw new LaunchRefused('No transfers of this token were found on this chain. Check the chain and the address.', 404);
  const deployer = rows(creation)[0]?.contractCreator?.toLowerCase() || null;
  const from = t => t.from.toLowerCase();
  const to = t => t.to.toLowerCase();
  // Trading (or handing out) starts with the first transfer that isn't a mint and isn't from the deployer.
  const start = tx.find(t => from(t) !== ZERO && from(t) !== deployer && from(t) !== token) || tx.find(t => from(t) !== ZERO) || tx[0];
  const launchAt = Number(start.timeStamp) * 1000;
  const end = launchAt + WINDOW_MINUTES * 60000;
  const windowRows = tx.filter(t => Number(t.timeStamp) * 1000 >= launchAt && Number(t.timeStamp) * 1000 <= end);
  const received = new Map();
  const fromDeployer = new Set();
  for (const t of windowRows) {
    const r = to(t);
    if ([ZERO, DEAD, token, deployer].includes(r)) continue;
    received.set(r, (received.get(r) || 0n) + BigInt(t.value));
    if (from(t) === deployer) fromDeployer.add(r);
  }
  const candidates = [...received.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)).slice(0, MAX_CANDIDATES);
  const codes = await pool(candidates, 4, async ([a]) => rpc().evmRpc(chain, 'eth_getCode', [a, 'latest']).catch(() => null));
  const contracts = candidates.filter((_, i) => codes[i] && codes[i] !== '0x').map(([a, v]) => ({ address: a, received: v }));
  const unread = candidates.filter((_, i) => codes[i] === null).length;
  const buyers = candidates.filter((_, i) => codes[i] === '0x').slice(0, MAX_BUYERS).map(([a, v]) => ({ address: a, bought: v, from_deployer: fromDeployer.has(a) }));

  const supplyHex = await rpc().evmRpc(chain, 'eth_call', [{ to: token, data: '0x18160ddd' }, 'latest']);
  const supply = BigInt(supplyHex);
  const balances = await pool(buyers, 4, async b => {
    const raw = await rpc().evmRpc(chain, 'eth_call', [{ to: token, data: `0x70a08231${b.address.slice(2).padStart(64, '0')}` }, 'latest']).catch(() => null);
    return raw === null ? null : BigInt(raw);
  });
  buyers.forEach((b, i) => { b.holds = balances[i]; });

  const fundingCache = new Map();
  const funding = addr => {
    if (!fundingCache.has(addr)) fundingCache.set(addr, evmFunding(chain, addr).catch(err => ({ error: err.message })));
    return fundingCache.get(addr);
  };
  const funded = await pool(buyers, 3, b => funding(b.address));
  buyers.forEach((b, i) => { b.funding = funded[i]; });

  return {
    chain, token, deployer, launch: { at: launchAt, tx: start.hash, block: Number(start.blockNumber) },
    supply, buyers, contracts, funding,
    coverage: { read: candidates.length - unread, of: candidates.length, what: 'early receivers (wallet or contract)' },
    busy: async addr => {
      const [code, nonce] = await Promise.all([
        rpc().evmRpc(chain, 'eth_getCode', [addr, 'latest']).catch(() => null),
        rpc().evmRpc(chain, 'eth_getTransactionCount', [addr, 'latest']).catch(() => null),
      ]);
      return { contract: !!code && code !== '0x', sends: nonce === null ? null : Number(nonce) };
    },
    complete: tx.length < 1000 || Number(tx[tx.length - 1].timeStamp) * 1000 > end,
    sources: ['Block explorer (Etherscan V2, or Blockscout): token transfers, contract creation and each wallet\'s first funding', `${chain} RPC: balances, total supply, contract code and transaction counts`],
  };
}

/* ── Solana ──────────────────────────────────────────────────────────── */

/** A Solana RPC call, retried after a rate limit or a network error (public endpoints limit hard). */
async function sol(method, params) {
  for (let attempt = 0; ; attempt++) {
    try { return await rpc().solanaRpc(method, params); } catch (err) {
      if (!err.transient || attempt >= module.exports.RETRIES.length) throw err;
      await new Promise(r => setTimeout(r, module.exports.RETRIES[attempt]));
    }
  }
}
const solTx = sig => sol('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
const keyOf = k => (typeof k === 'string' ? k : k?.pubkey);
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** The wallet that sent addr its first SOL, from its oldest transaction; null when it's too old or busy to read. */
async function solFunding(addr) {
  const sigs = await sol('getSignaturesForAddress', [addr, { limit: 1000 }]);
  if (!sigs?.length) return null;
  if (sigs.length >= 1000) return { old: true };
  const oldest = sigs[sigs.length - 1];
  const t = await solTx(oldest.signature);
  if (!t) return null;
  const keys = t.transaction.message.accountKeys.map(keyOf);
  const pre = t.meta.preBalances, post = t.meta.postBalances;
  const me = keys.indexOf(addr);
  if (me < 0 || post[me] <= pre[me]) return null;
  let best = -1, drop = 0;
  keys.forEach((k, i) => { if (i !== me && pre[i] - post[i] > drop) { drop = pre[i] - post[i]; best = i; } });
  return best < 0 ? null : { funder: keys[best], at: (t.blockTime || oldest.blockTime) * 1000, tx: oldest.signature, via: 'a transfer' };
}

async function solanaData(token) {
  let before;
  let all = [];
  for (let page = 0; page < SOLANA_SIG_PAGES; page++) {
    const sigs = await sol('getSignaturesForAddress', [token, { limit: 1000, ...(before ? { before } : {}) }]);
    all = all.concat(sigs || []);
    if (!sigs || sigs.length < 1000) break;
    before = sigs[sigs.length - 1].signature;
    if (page === SOLANA_SIG_PAGES - 1) throw new LaunchRefused(`This token has had over ${(SOLANA_SIG_PAGES * 1000).toLocaleString('en-US')} transactions, too many to find its launch on free data. Launch Safety is for new tokens.`, 422);
  }
  if (!all.length) throw new LaunchRefused('No transactions of this mint were found. Check the address.', 404);
  const ordered = all.filter(s => !s.err).reverse(); // oldest first
  const first = ordered[0];
  const launchAt = (first.blockTime || 0) * 1000;
  const end = launchAt + WINDOW_MINUTES * 60000;
  const early = ordered.filter(s => (s.blockTime || 0) * 1000 <= end).slice(0, 80);
  const txs = await pool(early, 2, s => solTx(s.signature).catch(() => null));
  const creatorTx = txs[0];
  const deployer = creatorTx ? keyOf(creatorTx.transaction.message.accountKeys[0]) : null;
  const received = new Map();
  let curve = null;
  for (const t of txs.filter(Boolean)) {
    const owners = new Map();
    for (const b of t.meta.preTokenBalances || []) if (b.mint === token) owners.set(b.owner, { pre: BigInt(b.uiTokenAmount.amount), post: 0n });
    for (const b of t.meta.postTokenBalances || []) if (b.mint === token) owners.set(b.owner, { pre: owners.get(b.owner)?.pre || 0n, post: BigInt(b.uiTokenAmount.amount) });
    for (const [owner, { pre, post }] of owners) {
      if (post < pre && !curve) curve = owner; // the first account that pays tokens out is the curve or pool
      if (post > pre && owner !== deployer) received.set(owner, (received.get(owner) || 0n) + (post - pre));
    }
  }
  if (curve) received.delete(curve);
  // Only plain wallets count as buyers: an account owned by a program (a pool's vault, a locker) is set aside.
  const candidates = [...received.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)).slice(0, MAX_CANDIDATES);
  const infos = candidates.length ? await sol('getMultipleAccounts', [candidates.map(([a]) => a), { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]).catch(() => null) : { value: [] };
  const isWallet = i => infos && infos.value[i] && infos.value[i].owner === SYSTEM_PROGRAM;
  const programs = infos ? candidates.filter((_, i) => !isWallet(i)).map(([a, v]) => ({ address: a, received: v, role: 'a program account (a pool, vault or locker)' })) : [];
  const buyers = (infos ? candidates.filter((_, i) => isWallet(i)) : []).slice(0, MAX_BUYERS).map(([a, v]) => ({ address: a, bought: v, from_deployer: false }));
  const supplyR = await sol('getTokenSupply', [token]);
  const supply = BigInt(supplyR?.value?.amount || '0');
  const balances = await pool(buyers, 2, async b => {
    const r = await sol('getTokenAccountsByOwner', [b.address, { mint: token }, { encoding: 'jsonParsed' }]).catch(() => null);
    if (!r) return null;
    return (r.value || []).reduce((t, acc) => t + BigInt(acc.account.data.parsed.info.tokenAmount.amount), 0n);
  });
  buyers.forEach((b, i) => { b.holds = balances[i]; });
  const fundingCache = new Map();
  const funding = addr => {
    if (!fundingCache.has(addr)) fundingCache.set(addr, solFunding(addr).catch(err => ({ error: err.message })));
    return fundingCache.get(addr);
  };
  const funded = await pool(buyers, 2, b => funding(b.address));
  buyers.forEach((b, i) => { b.funding = funded[i]; });
  return {
    chain: 'solana', token, deployer, launch: { at: launchAt, tx: first.signature },
    supply, buyers, contracts: [...(curve ? [{ address: curve, received: 0n, role: 'the bonding curve or pool' }] : []), ...programs], funding,
    coverage: infos ? { read: txs.filter(Boolean).length, of: txs.length, what: 'transactions in the first hour' } : { read: 0, of: candidates.length, what: 'early receivers (wallet or program account)' },
    busy: async addr => {
      const sigs = await sol('getSignaturesForAddress', [addr, { limit: BUSY_TXS > 1000 ? 1000 : BUSY_TXS }]).catch(() => null);
      return { contract: false, sends: sigs === null ? null : sigs.length >= 1000 ? BUSY_TXS + 1 : sigs.length };
    },
    complete: true,
    sources: ['Solana RPC: the mint\'s first transactions, token balances, supply, and each wallet\'s first funding'],
  };
}

/* ── the analysis (pure apart from the funding and busy lookups) ─────── */

/** Walks addr's funding chain back up to HOPS steps; the path to the deployer, or null. */
async function traceToDeployer(d, addr) {
  if (!d.deployer) return null;
  const path = [addr];
  let cur = addr;
  for (let hop = 1; hop <= HOPS; hop++) {
    const f = await d.funding(cur);
    if (!f || f.old || f.error || !f.funder) return null;
    path.push(f.funder);
    if (f.funder.toLowerCase() === d.deployer.toLowerCase()) return { hops: hop, path };
    cur = f.funder;
  }
  return null;
}

async function analyse(d) {
  const notChecked = [];
  const unread = d.coverage.of - d.coverage.read;
  if (unread) notChecked.push({ check: `${unread} of ${d.coverage.of} ${d.coverage.what}`, reason: 'the data provider didn\'t answer (rate-limited or down)' });
  if (!d.complete) notChecked.push({ check: 'transfers after the first 1,000', reason: 'the first hour had more transfers than one page; the earliest 1,000 were read' });
  if (!d.deployer) notChecked.push({ check: 'links to the deployer', reason: 'the deployer couldn\'t be found' });

  const buyers = d.buyers;
  for (const b of buyers) {
    if (b.funding?.error) notChecked.push({ check: `the funding of ${short(b.address)}`, reason: b.funding.error });
    if (b.funding?.old) notChecked.push({ check: `the funding of ${short(b.address)}`, reason: 'an older wallet with over 1,000 transactions' });
  }
  const bought = buyers.reduce((t, b) => t + b.bought, 0n);

  // Group by funder; a funder that is busy (an exchange or a service) is named, not counted.
  const byFunder = new Map();
  for (const b of buyers) {
    const f = b.funding?.funder;
    if (!f) continue;
    if (!byFunder.has(f)) byFunder.set(f, []);
    byFunder.get(f).push(b);
  }
  const groups = [];
  for (const [funder, ws] of byFunder) {
    if (ws.length < 2) continue;
    const kind = await d.busy(funder).catch(() => ({ contract: false, sends: null }));
    const g = {
      funder,
      funder_kind: kind.contract ? 'contract' : kind.sends !== null && kind.sends > BUSY_TXS ? 'busy' : 'wallet',
      funder_sends: kind.sends,
      wallets: ws.map(w => ({ address: w.address, bought_pct: pct(w.bought, d.supply), holds_pct: w.holds === null ? null : pct(w.holds, d.supply), funded_at: w.funding.at ? new Date(w.funding.at).toISOString() : null, from_deployer: w.from_deployer })),
      bought_pct: pct(ws.reduce((t, w) => t + w.bought, 0n), d.supply),
      holds_pct: ws.some(w => w.holds === null) ? null : pct(ws.reduce((t, w) => t + w.holds, 0n), d.supply),
    };
    g.sold_pct = g.holds_pct === null || !g.bought_pct ? null : Math.max(0, Math.round((1 - g.holds_pct / g.bought_pct) * 100));
    g.funded_within_hours = (() => {
      const ts = ws.map(w => w.funding.at).filter(Boolean);
      return ts.length ? Math.round((Math.max(...ts) - Math.min(...ts)) / 360000) / 10 : null;
    })();
    g.linked_to_deployer = d.deployer && funder.toLowerCase() === d.deployer.toLowerCase() ? { hops: 1, path: [ws[0].address, funder] } : await traceToDeployer(d, funder).then(t => (t ? { hops: t.hops + 1, path: [ws[0].address, ...t.path] } : null));
    groups.push(g);
  }
  groups.sort((a, b) => (b.bought_pct || 0) - (a.bought_pct || 0));

  // Early buyers linked to the deployer on their own (outside a group, or funded straight from it).
  const linked = [];
  for (const b of buyers) {
    if (b.from_deployer) { linked.push({ wallet: b.address, how: 'received the token straight from the deployer', hops: 0, bought_pct: pct(b.bought, d.supply) }); continue; }
    const t = await traceToDeployer(d, b.address);
    if (t) linked.push({ wallet: b.address, how: `funded from the deployer in ${t.hops} step${t.hops === 1 ? '' : 's'}`, hops: t.hops, path: t.path, bought_pct: pct(b.bought, d.supply) });
  }

  const flags = [];
  const add = (severity, title, evidence) => flags.push({ severity, title, evidence, source: d.chain === 'solana' ? 'Solana RPC' : 'Block explorer and RPC' });
  for (const g of groups.filter(x => x.funder_kind !== 'busy')) {
    const big = g.wallets.length >= GROUP_MIN;
    const who = `${g.wallets.length} early buyers funded from ${short(g.funder)}${g.funder_kind === 'contract' ? ' (a contract, such as a multi-send)' : ''}${g.funded_within_hours !== null ? `, within ${g.funded_within_hours} hours of each other` : ''}`;
    const evidence = `${who}, bought ${g.bought_pct}% of the supply in the first hour${g.holds_pct !== null ? ` and hold ${g.holds_pct}% now` : ''}.`;
    if (big && g.bought_pct >= 10 && g.sold_pct !== null && g.sold_pct >= 50) add('critical', `A bundle bought ${g.bought_pct}% at launch and has sold ${g.sold_pct}% of it`, evidence);
    else if (big && g.bought_pct >= 10) add('high', `A bundle bought ${g.bought_pct}% of the supply at launch`, evidence);
    else if ((big && g.bought_pct >= 3) || (!big && g.bought_pct >= 5)) add('medium', `Wallets with a shared funder bought ${g.bought_pct}% at launch`, evidence);
    if (g.linked_to_deployer) add(g.bought_pct >= 2 ? 'high' : 'medium', `That group traces back to the deployer in ${g.linked_to_deployer.hops} step${g.linked_to_deployer.hops === 1 ? '' : 's'}`, `Funding path: ${g.linked_to_deployer.path.map(short).join(' ← ')}.`);
  }
  const linkedPct = linked.reduce((t, l) => t + (l.bought_pct || 0), 0);
  if (linked.length) add(linkedPct >= 5 ? 'high' : 'medium', `${linked.length} early buyer${linked.length === 1 ? ' is' : 's are'} linked to the deployer`, `They bought ${Math.round(linkedPct * 100) / 100}% of the supply in the first hour: ${linked.slice(0, 4).map(l => `${short(l.wallet)} (${l.how})`).join('; ')}.`);
  for (const g of groups.filter(x => x.funder_kind === 'busy')) add('info', `${g.wallets.length} early buyers were funded from a busy wallet, not counted`, `${short(g.funder)} has sent over ${BUSY_TXS.toLocaleString('en-US')} transactions: likely an exchange or a service paying out withdrawals, which funds many unrelated wallets.`);

  const worst = ['critical', 'high', 'medium'].find(s => flags.some(f => f.severity === s));
  // Too little read to say "no bundle": refused, so the run isn't charged (a bundle found is still reported).
  const fundingFailed = buyers.filter(b => b.funding?.error).length;
  const tooLittle = (d.coverage.of && d.coverage.read / d.coverage.of < 0.75) || (buyers.length && fundingFailed / buyers.length > 1 / 3) || !buyers.length;
  if (!worst && tooLittle) {
    throw new LaunchRefused(!buyers.length
      ? 'No early buyers could be read for this token. Check the chain and the address, or try again in a minute.'
      : `Too little of the launch could be read to say whether it was bundled (${notChecked.map(n => `${n.check}: ${n.reason}`).slice(0, 2).join('; ')}). Try again in a minute; you weren't charged.`, 503);
  }
  const verdict = worst === 'critical' || worst === 'high' ? 'bundle_found' : worst === 'medium' ? 'possible_bundle' : 'no_bundle_found';
  const summary = verdict === 'no_bundle_found'
    ? `No bundle found among the ${buyers.length} largest buyers in the first hour: they don't share funders${d.deployer ? ' or trace back to the deployer' : ''} in a way that suggests coordination.`
    : flags.filter(f => f.severity !== 'info')[0].title + '.';
  return {
    chain: d.chain, token: d.token, checked_at: new Date().toISOString(), verdict, summary,
    launch: { at: new Date(d.launch.at).toISOString(), tx: d.launch.tx, deployer: d.deployer, window_minutes: WINDOW_MINUTES },
    early_buyers: { traced: buyers.length, bought_pct: pct(bought, d.supply), contracts_set_aside: d.contracts.length },
    groups, deployer_linked: linked, flags, not_checked: notChecked, sources: d.sources,
    note: 'Shared funding isn\'t proof of intent, and a clean result isn\'t proof of safety: it covers the largest early buyers and the patterns above. This is information, not financial advice.',
  };
}

/** The whole check for one token, cached 30 minutes. */
function check({ chain, token }) {
  return cached(`launch:${chain}:${token}`, CACHE_SECONDS, async () => analyse(chain === 'solana' ? await module.exports.solanaData(token) : await module.exports.evmData(chain, token)));
}

/** What a flagged group holds now (for the agent's later runs): { [funder]: holds_pct }. */
async function holdingsNow(chain, token, groups) {
  const out = {};
  if (chain === 'solana') {
    const supply = BigInt((await sol('getTokenSupply', [token]))?.value?.amount || '0');
    for (const g of groups) {
      let total = 0n;
      for (const w of g.wallets) {
        const r = await sol('getTokenAccountsByOwner', [w.address, { mint: token }, { encoding: 'jsonParsed' }]);
        total += (r.value || []).reduce((t, acc) => t + BigInt(acc.account.data.parsed.info.tokenAmount.amount), 0n);
      }
      out[g.funder] = pct(total, supply);
    }
    return out;
  }
  const supply = BigInt(await rpc().evmRpc(chain, 'eth_call', [{ to: token, data: '0x18160ddd' }, 'latest']));
  for (const g of groups) {
    let total = 0n;
    for (const w of g.wallets) total += BigInt(await rpc().evmRpc(chain, 'eth_call', [{ to: token, data: `0x70a08231${w.address.slice(2).padStart(64, '0')}` }, 'latest']));
    out[g.funder] = pct(total, supply);
  }
  return out;
}

module.exports = { RETRIES: [1000, 2500, 5000], parse, check, analyse, evmData, solanaData, evmFunding, solFunding, holdingsNow, LaunchRefused, CHAINS, WINDOW_MINUTES, BUSY_TXS, GROUP_MIN };
