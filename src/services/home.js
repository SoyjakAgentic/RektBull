/**
 * Home: one box, and one free checkup.
 *
 * identify(): what a pasted address is (a wallet, a token, an NFT collection,
 * a DAO governor, a Safe, another contract), read onchain on every chain
 * RektBull covers, and where to go with it. Nothing is guessed: a chain that
 * couldn't be read is listed with the reason.
 *
 * checkup(): a wallet's free checks from every desk at once (approvals,
 * unclaimed rewards, yield, DAO votes), each with its source and anything it
 * couldn't check. Each part is the same free check its desk runs, and is cached
 * the same way, so opening the desk afterwards is quick.
 */
const { ethers } = require('ethers');
const { EVM } = require('../providers/chains');
const rpc = require('../providers/rpc');
const explorer = require('../providers/explorer');
const { cached } = require('../lib/cache');
const approvals = require('./approvals');

const CHAIN_NAMES = { ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon', bsc: 'BNB Chain', solana: 'Solana' };
const nameOf = c => CHAIN_NAMES[c] || c;

class HomeRefused extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/* ── what an address is ── */

const PROBE = new ethers.Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function supportsInterface(bytes4) view returns (bool)',
  'function votingDelay() view returns (uint256)',
  'function votingPeriod() view returns (uint256)',
  'function proposalThreshold() view returns (uint256)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
]);
const ERC721 = '0x80ac58cd';
const ERC1155 = '0xd9b67a26';
const DELEGATION = /^0xef0100[0-9a-f]{40}$/i; // EIP-7702: a wallet that delegates to code

function parseQuery(body = {}) {
  const q = String(body?.query ?? body?.address ?? '').trim();
  if (!q) return { error: 'Paste an address: a wallet, a token or a contract.' };
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) return { kind: 'evm', address: q.toLowerCase() };
  if (/^0x[0-9a-fA-F]{64}$/.test(q)) return { error: 'That looks like a transaction hash. RektBull checks addresses: paste the wallet, token or contract instead.' };
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q)) return { kind: 'solana', address: q };
  if (/\.(eth|base\.eth)$/i.test(q)) return { error: 'Names like this aren\'t looked up yet: paste the address (0x…) instead.' };
  return { error: 'That isn\'t an address. Paste a wallet, token or contract address (0x and 40 hex characters, or a Solana address).' };
}

function decodeOk(r) { return r?.ok ? r.value[0] : undefined; }

async function readChain(chain, address) {
  const code = await rpc.evmRpc(chain, 'eth_getCode', [address, 'latest']);
  if (!code || code === '0x') return { chain, kind: 'none' };
  if (DELEGATION.test(code)) return { chain, kind: 'wallet', note: `a wallet that delegates to code at ${'0x' + code.slice(8)} (EIP-7702)` };
  const fns = [['name', []], ['symbol', []], ['decimals', []], ['totalSupply', []], ['supportsInterface', [ERC721]], ['supportsInterface', [ERC1155]], ['votingDelay', []], ['votingPeriod', []], ['proposalThreshold', []], ['getThreshold', []], ['getOwners', []]];
  const r = await approvals.multicall(chain, fns.map(([fn, args]) => ({ target: address, iface: PROBE, fn, args })));
  const [name, symbol, decimals, supply, is721, is1155, delay, period, threshold, safeThreshold, owners] = r.map(decodeOk);
  if (safeThreshold !== undefined && Array.isArray(owners)) {
    return { chain, kind: 'safe', note: `a Safe that needs ${safeThreshold} of ${owners.length} owners to sign` };
  }
  if (delay !== undefined && period !== undefined && threshold !== undefined) return { chain, kind: 'governor', name: name || null };
  if (is721 === true || is1155 === true) return { chain, kind: 'nft', name: name || null, symbol: symbol || null, standard: is721 ? 'ERC-721' : 'ERC-1155' };
  if (symbol !== undefined && decimals !== undefined && supply !== undefined) {
    return { chain, kind: 'token', name: name || null, symbol, decimals: Number(decimals), total_supply: ethers.formatUnits(supply, Number(decimals)) };
  }
  let verified = null; let notVerified = null;
  try {
    const data = await explorer.explorerGet(chain, { module: 'contract', action: 'getsourcecode', address });
    const row = Array.isArray(data?.result) ? data.result[0] : null;
    verified = row?.ContractName || null;
    if (!verified) notVerified = 'its source code isn\'t verified on the explorer';
  } catch (err) { notVerified = `the explorer couldn't be asked (${err.message})`; }
  return { chain, kind: 'contract', name: verified, ...(notVerified ? { name_not_read: notVerified } : {}) };
}

const SOL_TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];

async function identifySolana(address) {
  const info = await rpc.solanaRpc('getAccountInfo', [address, { encoding: 'jsonParsed' }]);
  const v = info?.value;
  const base = { address, checked: ['solana'], not_read: [], source: 'Solana RPC (getAccountInfo)' };
  if (v && SOL_TOKEN_PROGRAMS.includes(v.owner) && v.data?.parsed?.type === 'mint') {
    return {
      ...base, kind: 'token', summary: 'A token on Solana',
      chains: [{ chain: 'solana', kind: 'token', decimals: v.data.parsed.info?.decimals ?? null }],
      next: [{ desk: 'Safety', label: 'Check this token on Solana before you buy it', href: `/safety?chain=solana&token=${address}` }],
    };
  }
  return {
    ...base, kind: 'solana_account', summary: v ? 'A Solana account (not a token mint)' : 'Nothing on Solana at this address yet',
    chains: [{ chain: 'solana', kind: v ? 'account' : 'none' }], next: [],
    note: 'On Solana, RektBull checks tokens (paste a token\'s mint address). Wallet checks cover EVM chains for now.',
  };
}

const KIND_ORDER = ['safe', 'wallet', 'governor', 'token', 'nft', 'contract'];

function next(kind, address, chains) {
  const found = chains.filter(c => c.kind === kind);
  switch (kind) {
    case 'wallet': return [
      { desk: 'Home', label: 'The free checkup, below', href: null },
      { desk: 'Safety', label: 'Approvals: what apps can still take from this wallet', href: `/safety?wallet=${address}#approvals-card` },
      { desk: 'Find money', label: 'Unclaimed rewards and yield', href: `/find?wallet=${address}` },
      { desk: 'Governance', label: 'DAO votes this wallet can cast', href: `/governance?wallet=${address}` },
    ];
    case 'token': return found.map(c => ({ desk: 'Safety', label: `Check ${c.symbol || 'this token'} on ${nameOf(c.chain)} before you buy it`, href: `/safety?chain=${c.chain}&token=${address}` }));
    case 'governor': return found.map(c => ({ desk: 'Governance', label: `Follow ${c.name || 'this governor'} on ${nameOf(c.chain)}`, href: `/governance?chain=${c.chain}&governor=${address}#spaces-card` }));
    case 'nft': return [{ desk: 'Safety', label: 'NFT approvals are part of the approval cleanup: check what your wallet lets collections and marketplaces take', href: '/safety#approvals-card' }];
    case 'contract': return [{ desk: 'Extension', label: 'If a site asks you to approve or sign for a contract, the pre-sign check shows what it would do first', href: '/extension' }];
    default: return [];
  }
}

const SUMMARY = {
  safe: 'A Safe (a multi-signature wallet)',
  wallet: 'A wallet',
  governor: 'A DAO governor contract',
  token: 'A token',
  nft: 'An NFT collection',
  contract: 'A contract',
};

/** What an address is on each chain, and what to do with it. Cached 1 day (code rarely changes). */
async function identify(query) {
  if (query.kind === 'solana') return cached(`home:id:sol:${query.address}`, 86400, () => identifySolana(query.address));
  const address = query.address;
  return cached(`home:id:${address}`, 86400, async () => {
    const chains = Object.keys(EVM);
    const reads = await Promise.allSettled(chains.map(c => module.exports.readChain(c, address)));
    const found = []; const notRead = [];
    reads.forEach((r, i) => (r.status === 'fulfilled' ? found.push(r.value) : notRead.push({ chain: chains[i], reason: r.reason.message })));
    if (!found.length) throw new HomeRefused(`No chain could be read just now (${notRead.map(n => `${nameOf(n.chain)}: ${n.reason}`).join('; ')}). Try again in a minute.`, 503);
    const withCode = found.filter(c => c.kind !== 'none');
    let kind = withCode.length ? KIND_ORDER.find(k => withCode.some(c => c.kind === k)) : 'wallet';
    if (kind === 'safe') kind = 'wallet'; // a Safe is checked like any wallet
    const out = {
      address, kind,
      summary: withCode.length
        ? KIND_ORDER.filter(k => withCode.some(c => c.kind === k)).map((k, i) => {
          const text = `${SUMMARY[k]} on ${withCode.filter(c => c.kind === k).map(c => nameOf(c.chain)).join(', ')}`;
          return i ? text[0].toLowerCase() + text.slice(1) : text;
        }).join('; ')
        : `A wallet: there's no contract at this address on ${found.map(c => nameOf(c.chain)).join(', ')}`,
      chains: withCode,
      checked: found.map(c => c.chain),
      not_read: notRead,
      next: next(kind, address, withCode),
      source: 'Each chain\'s RPC (the code at the address, and the standard functions it answers); the explorer for a contract\'s verified name',
    };
    if (notRead.length) out.note = `Not read: ${notRead.map(n => nameOf(n.chain)).join(', ')}. What it is there isn't known.`;
    return out;
  });
}

/* ── the free checkup ── */

const TIMEOUT_MS = 45000;
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took too long; open the desk to run it on its own`)), ms).unref())]);
const money = v => `$${Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: Number(v) % 1 ? 2 : 0 })}`;
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

const PARTS = [
  {
    id: 'approvals', desk: 'Safety', title: 'What apps can still take',
    href: w => `/safety?wallet=${w}#approvals-card`,
    run: w => approvals.preview(w),
    shape: r => {
      const s = r.summary;
      return {
        status: s.to_revoke ? (s.by_severity.critical || s.by_severity.high ? 'bad' : 'warn') : 'ok',
        headline: s.to_revoke ? `${plural(s.to_revoke, 'approval')} worth revoking, of ${s.open} open` : s.open ? `${plural(s.open, 'open approval')}, none flagged` : 'No open approvals found',
        facts: [
          { label: 'Open approvals', value: String(s.open) },
          { label: 'Worth revoking', value: String(s.to_revoke) },
          { label: 'They could take', value: money(s.value_at_risk_usd) + (s.not_priced ? ` + ${s.not_priced} not priced` : '') },
        ],
        action: s.to_revoke ? 'See which, and revoke them from your wallet (approval cleanup: 5 points or $1)' : 'See every approval',
        not_checked: s.chains_not_read.map(c => ({ check: `approvals on ${nameOf(c.chain)}`, reason: c.reason })),
        source: 'Approval logs from the chain explorers (GoPlus when they can\'t give the whole history); each approval\'s current state read onchain; values at DefiLlama prices',
      };
    },
  },
  {
    id: 'claims', desk: 'Find money', title: 'Unclaimed airdrops and rewards',
    href: w => `/find?wallet=${w}`,
    run: (w, o) => require('./claims').check(w, o),
    shape: r => {
      const s = r.summary;
      return {
        status: s.claimable ? 'good' : 'ok',
        headline: s.claimable ? `${plural(s.claimable, 'unclaimed reward')}${s.claimable_usd ? ` worth ${money(s.claimable_usd)}` : ''}${s.not_priced ? ` (${s.not_priced} not priced yet)` : ''}` : 'Nothing unclaimed in the sources checked',
        facts: [
          { label: 'Unclaimed', value: String(s.claimable) },
          { label: 'Worth', value: money(s.claimable_usd) + (s.not_priced ? ` + ${s.not_priced} not priced` : '') },
          { label: 'On', value: s.chains.length ? s.chains.map(nameOf).join(', ') : '–' },
        ],
        action: s.claimable ? `Claim from your wallet (checking is free; ${r.fee.standard_rate} of what arrives, ${r.fee.pro_rate} with Safety Pro)` : 'See what was checked',
        not_checked: r.not_checked,
        source: `${r.sources.map(x => x.name).join(' and ')}, each claim verified onchain`,
      };
    },
  },
  {
    id: 'yield', desk: 'Find money', title: 'Stablecoins and ETH earning',
    href: w => `/find?wallet=${w}#yield`,
    run: w => require('../yield/proposals').summary(w),
    shape: r => {
      const idle = r.idle.filter(i => !i.gas).reduce((t, i) => t + (i.usd || 0), 0);
      return {
        status: r.proposals_count ? 'good' : 'ok',
        headline: r.proposals_count ? `Could earn about ${money(r.extra_per_year_usd)} more a year` : r.total_in_positions_usd ? `${money(r.total_in_positions_usd)} earning in the venues checked` : idle ? `${money(idle)} idle in the wallet` : 'No stablecoins or ETH in the venues checked',
        facts: [
          { label: 'Earning', value: money(r.total_in_positions_usd) },
          { label: 'Idle in the wallet', value: money(idle) },
          { label: 'Better places found', value: String(r.proposals_count) },
        ],
        action: r.proposals_count ? 'See the proposals and move it from your wallet (Safety Pro; 0.1% per move)' : 'See the positions and rates',
        not_checked: r.not_read.map(n => ({ check: `${n.what} on ${nameOf(n.chain)}`, reason: n.reason })),
        source: 'Balances read onchain (Multicall3) on Aave v3, Compound v3 and Spark; rates from each venue\'s own contracts; prices from each chain\'s Aave oracle',
      };
    },
  },
  {
    id: 'governance', desk: 'Governance', title: 'DAO votes',
    href: w => `/governance?wallet=${w}`,
    run: (w, o) => require('./governance').check(w, o),
    shape: r => {
      const s = r.summary;
      const nobody = s.votes_counting_for_nobody;
      return {
        status: s.closing_within_24h || nobody ? 'warn' : 'ok',
        headline: s.to_vote ? `${plural(s.to_vote, 'open vote')} you can cast${s.closing_within_24h ? `, ${s.closing_within_24h} closing within a day` : ''}` : s.active ? `${plural(s.active, 'open vote')} in your DAOs, none for you to cast` : 'No open votes in your DAOs',
        facts: [
          { label: 'Open votes', value: String(s.active) },
          { label: 'You can vote on', value: String(s.to_vote) },
          { label: 'Tokens counting for nobody', value: nobody ? `${plural(nobody, 'DAO')} (not delegated)` : 'none' },
        ],
        action: s.to_vote || nobody ? 'Vote, or delegate to yourself, from your wallet (free)' : 'See your DAOs',
        not_checked: r.not_checked,
        source: r.source,
      };
    },
  },
];

async function checkup(wallet, { accountId = null, timeoutMs = TIMEOUT_MS } = {}) {
  wallet = wallet.toLowerCase();
  const parts = await Promise.all(PARTS.map(async p => {
    const base = { id: p.id, desk: p.desk, title: p.title, href: p.href(wallet) };
    try {
      const r = await withTimeout(p.run(wallet, { accountId }), timeoutMs, p.title);
      return { ...base, ok: true, ...p.shape(r) };
    } catch (err) {
      return { ...base, ok: false, status: 'unknown', headline: 'Couldn\'t be checked just now', reason: err.message, action: 'Open the desk to try again' };
    }
  }));
  return {
    wallet, checked_at: new Date().toISOString(), parts,
    note: 'Each part is the free check its desk runs, with its source and anything it couldn\'t check. Nothing found means nothing in those sources, not nothing anywhere. RektBull prepares; your wallet signs.',
  };
}

module.exports = { identify, checkup, parseQuery, readChain, HomeRefused, PARTS };
