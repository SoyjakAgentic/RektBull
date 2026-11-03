/**
 * The pre-sign check: what a wallet request would do, before it's signed.
 *
 * Input is the request a site sent the wallet: { chain_id, from, origin,
 * method, params }. It answers a verdict (the worst finding), findings that
 * each name their source, the decoded request, and, for transactions, what
 * would leave and reach the wallet (a simulation). Anything that couldn't be
 * checked is listed as such.
 *
 *   eth_sendTransaction, wallet_sendCalls  decoded (approve, setApprovalForAll,
 *        transfer, Permit2 approve...), simulated with eth_simulateV1 (every
 *        token moved and every approval given, even inside a router call),
 *        and every spender and recipient rated like approval cleanup does.
 *   eth_signTypedData(_v3/_v4)  EIP-2612 Permit, Permit2 (single, batch,
 *        transfer) and Seaport orders, which are signatures that can move
 *        tokens without a transaction.
 *   personal_sign  sign-in messages for another site than the one asking.
 *   eth_sign  a blind signature of a raw hash: always critical.
 *   The site itself: GoPlus's phishing list and lookalike domains.
 */
const { ethers } = require('ethers');
const { EVM } = require('../providers/chains');
const rpc = require('../providers/rpc');
const goplus = require('../providers/goplus');
const prices = require('../providers/prices');
const signatures = require('../providers/signatures');
const approvals = require('./approvals');

const RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const METHODS = ['eth_sendTransaction', 'wallet_sendCalls', 'eth_signTypedData_v4', 'eth_signTypedData_v3', 'eth_signTypedData', 'personal_sign', 'eth_sign'];
const ETH_PSEUDO = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'; // eth_simulateV1 reports native transfers from here
const UNLIMITED = 2n ** 159n;
const TOPIC = {
  transfer: ethers.id('Transfer(address,address,uint256)'),
  approval: ethers.id('Approval(address,address,uint256)'),
  approvalForAll: ethers.id('ApprovalForAll(address,address,bool)'),
};
const CALLS = new ethers.Interface([
  'function approve(address spender, uint256 amount)',
  'function increaseAllowance(address spender, uint256 added)',
  'function setApprovalForAll(address operator, bool approved)',
  'function transfer(address to, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
  'function safeTransferFrom(address from, address to, uint256 id)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)', // Permit2
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
]);
const ERC20_META = new ethers.Interface(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);

const chainOf = id => Object.entries(EVM).find(([, c]) => c.chainId === Number(id))?.[0] || null;
const lower = a => (typeof a === 'string' ? a.toLowerCase() : a);
const isAddr = a => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
const short = a => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const big = v => { try { return BigInt(v ?? 0); } catch { return 0n; } };

class PresignRefused extends Error {
  constructor(message) { super(message); this.status = 400; }
}

/** The checked input, or throws PresignRefused. */
function parse(body = {}) {
  const method = String(body.method || '');
  if (!METHODS.includes(method)) throw new PresignRefused(`method must be one of: ${METHODS.join(', ')}`);
  if (!Array.isArray(body.params)) throw new PresignRefused('params must be the request\'s params array');
  const from = lower(body.from);
  if (from && !isAddr(from)) throw new PresignRefused('from must be an address');
  let origin = null;
  if (body.origin) {
    try { origin = new URL(String(body.origin)).origin; } catch { throw new PresignRefused('origin must be the site\'s URL'); }
  }
  if (JSON.stringify(body.params).length > 64 * 1024) throw new PresignRefused('params are too large');
  return { method, params: body.params, from, origin, chainId: Number(body.chain_id) || null };
}

/* ── the site ── */
async function checkSite(origin, add, notChecked) {
  if (!origin) return;
  const host = new URL(origin).hostname;
  if (/^xn--|\.xn--/.test(host)) add('medium', 'The site\'s address uses look-alike letters', `${host} is written with non-Latin characters (punycode), a common way to imitate a known site.`, 'the site address');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) add('medium', 'The site is a bare IP address', `${host} has no domain name, which real apps rarely use.`, 'the site address');
  try {
    const r = await goplus.phishingSite(origin);
    if (r.phishing) add('critical', 'This site is listed as phishing', `${origin} is on GoPlus's phishing list. Don't sign anything here.`, r.source);
  } catch (err) { notChecked.push({ check: 'phishing site list', reason: `GoPlus: ${err.message}` }); }
}

/* ── spenders and recipients, rated like approval cleanup ── */
async function rateApproval(chain, kind, token, spenderIn, amount, add, notChecked, via) {
  const spender = lower(spenderIn);
  const facts = await approvals.spenderFacts(chain, spender);
  const unlimited = kind === 'nft_all' || big(amount) >= UNLIMITED;
  const { severity, reasons } = approvals.rate({ kind, unlimited }, facts);
  const what = kind === 'nft_all' ? 'move every NFT in this collection' : unlimited ? 'spend all of this token, now and later' : `spend ${amount} (raw units) of this token`;
  const who = facts.label ? `${facts.label} (${short(spender)})` : short(spender);
  add(severity, `${via}: ${who} could ${what}`, reasons.map(r => r.text).join(' ') || 'Rated from the approval itself.', reasons.map(r => r.source).filter((v, i, a) => a.indexOf(v) === i).join('; ') || 'RektBull rating', { token: lower(token), spender: lower(spender), kind, unlimited });
  if (facts.risk?.not_checked) notChecked.push({ check: `who ${short(spender)} is`, reason: facts.risk.not_checked });
}

async function rateRecipient(chain, toIn, add, what) {
  const to = lower(toIn);
  const r = await goplus.addressRisk(chain, to).catch(() => null);
  if (r?.flags?.length) add('critical', `${what} goes to an address flagged for ${r.flags.join(', ')}`, `${short(to)} is flagged.`, r.source);
}

/* ── transactions: decode, simulate ── */
function decode(tx) {
  const data = String(tx.data || tx.input || '0x');
  if (data.length < 10) return { kind: 'plain', selector: null };
  try {
    const f = CALLS.parseTransaction({ data, value: tx.value || 0 });
    return f ? { kind: 'known', name: f.name, signature: f.signature, args: f.args, selector: data.slice(0, 10) } : { kind: 'unknown', selector: data.slice(0, 10) };
  } catch { return { kind: 'unknown', selector: data.slice(0, 10) }; }
}

async function simulate(chain, from, calls) {
  const res = await rpc.evmRpc(chain, 'eth_simulateV1', [{
    blockStateCalls: [{ calls: calls.map(c => ({ from, to: c.to, data: c.data || '0x', ...(big(c.value) ? { value: ethers.toQuantity(big(c.value)) } : {}) })) }],
    traceTransfers: true, validation: false,
  }, 'latest'], { timeout: 6000 });
  return res?.[0]?.calls || [];
}

async function tokenMeta(chain, tokens) {
  const out = {};
  await Promise.all(tokens.map(async t => {
    if (t === ETH_PSEUDO) { out[t] = { symbol: EVM[chain]?.chainId === 56 ? 'BNB' : EVM[chain]?.chainId === 137 ? 'POL' : 'ETH', decimals: 18 }; return; }
    const call = async fn => ERC20_META.decodeFunctionResult(fn, await rpc.evmRpc(chain, 'eth_call', [{ to: t, data: ERC20_META.encodeFunctionData(fn) }, 'latest'], { timeout: 4000 }))[0];
    const [symbol, decimals] = await Promise.all([call('symbol').catch(() => null), call('decimals').catch(() => null)]);
    out[t] = { symbol, decimals: decimals === null ? null : Number(decimals) };
  }));
  return out;
}

const llamaId = (chain, t) => (t === ETH_PSEUDO ? ({ ethereum: 'coingecko:ethereum', base: 'coingecko:ethereum', arbitrum: 'coingecko:ethereum', optimism: 'coingecko:ethereum', bsc: 'coingecko:binancecoin', polygon: 'coingecko:polygon-ecosystem-token' }[chain]) : `${chain}:${t}`);

/** Net token movements for `from` from simulated logs, plus approvals given inside the calls. */
function readLogs(from, results) {
  const moves = {}; const nfts = []; const approvalsGiven = [];
  for (const r of results) {
    for (const l of r.logs || []) {
      const t0 = l.topics?.[0];
      const token = lower(l.address);
      if (t0 === TOPIC.transfer && l.topics.length === 3) {
        const a = lower('0x' + l.topics[1].slice(26)), b = lower('0x' + l.topics[2].slice(26)), v = big(l.data);
        if (a === from) { moves[token] = (moves[token] || 0n) - v; }
        if (b === from) { moves[token] = (moves[token] || 0n) + v; }
        if (a === from && b !== from) (moves.__to = moves.__to || []).push({ token, to: b, amount: v });
      } else if (t0 === TOPIC.transfer && l.topics.length === 4) {
        const a = lower('0x' + l.topics[1].slice(26)), b = lower('0x' + l.topics[2].slice(26));
        if (a === from || b === from) nfts.push({ token, id: big(l.topics[3]).toString(), direction: a === from ? 'out' : 'in', counterparty: a === from ? b : a });
      } else if (t0 === TOPIC.approval && l.topics.length === 3 && lower('0x' + l.topics[1].slice(26)) === from) {
        approvalsGiven.push({ kind: 'erc20', token, spender: lower('0x' + l.topics[2].slice(26)), amount: big(l.data) });
      } else if (t0 === TOPIC.approvalForAll && lower('0x' + l.topics[1].slice(26)) === from && big(l.data) === 1n) {
        approvalsGiven.push({ kind: 'nft_all', token, spender: lower('0x' + l.topics[2].slice(26)), amount: 0n });
      }
    }
  }
  const outgoing = moves.__to || [];
  delete moves.__to;
  return { moves, nfts, approvalsGiven, outgoing };
}

async function checkTransactions(chain, from, calls, add, notChecked, decoded) {
  // What each call is, from its data.
  for (const c of calls) {
    const d = decode(c);
    const to = lower(c.to);
    if (!isAddr(to)) { add('high', 'It creates a contract or has no recipient', 'Wallet requests from apps almost always call an existing contract.', 'the request'); continue; }
    const entry = { to, value: big(c.value).toString(), function: d.signature || null };
    if (d.kind === 'unknown') entry.function = (await signatures.functionName(d.selector)) || `unknown (${d.selector})`;
    decoded.push(entry);
    if (d.kind === 'known') {
      if (d.name === 'setApprovalForAll' && d.args[1] === true) await rateApproval(chain, 'nft_all', to, d.args[0], 0n, add, notChecked, 'Approval for a whole NFT collection');
      else if (d.name === 'approve' && d.args.length === 2 && big(d.args[1]) > 0n) await rateApproval(chain, 'erc20', to, d.args[0], big(d.args[1]), add, notChecked, 'Token approval');
      else if (d.name === 'increaseAllowance') await rateApproval(chain, 'erc20', to, d.args[0], big(d.args[1]), add, notChecked, 'Token approval');
      else if (d.name === 'approve' && d.args.length === 4) await rateApproval(chain, 'permit2', d.args[0], d.args[1], big(d.args[2]), add, notChecked, 'Permit2 approval');
      else if (d.name === 'transfer') {
        if (lower(d.args[0]) === to) add('high', 'Tokens sent to the token\'s own contract', 'Tokens sent to a token contract are almost always lost for good.', 'the request');
        await rateRecipient(chain, d.args[0], add, 'The transfer');
      }
    }
    if (big(c.value) > 0n) await rateRecipient(chain, to, add, 'The payment');
    if (d.kind !== 'known') {
      const r = await goplus.contractRisk(chain, to).catch(() => null);
      if (r?.malicious?.length) add('critical', `It calls a contract flagged as malicious (${r.malicious.join(', ')})`, `${short(to)} is flagged.`, r.source);
      else if (r?.known && r.open_source === false) add('medium', 'It calls a contract whose source code isn\'t published', `What ${short(to)} does can't be read.`, r.source);
    }
  }

  // What would actually happen: simulate the calls.
  let results;
  try {
    results = await simulate(chain, from, calls);
  } catch (err) {
    notChecked.push({ check: 'simulation', reason: `couldn't simulate on this chain's RPC (${err.message})` });
    return null;
  }
  const failed = results.find(r => r.status === '0x0' || r.error);
  if (failed) add('medium', 'This would fail onchain', `The simulation reverted${failed.error?.message ? `: ${failed.error.message}` : ''}. You'd pay gas for nothing.`, 'simulation (eth_simulateV1)');
  const { moves, nfts, approvalsGiven, outgoing } = readLogs(from, results);
  // Approvals given inside the calls (e.g. by a router) are rated too, unless already rated from the calldata.
  for (const a of approvalsGiven) {
    if (calls.some(c => { const d = decode(c); return d.kind === 'known' && ['approve', 'increaseAllowance', 'setApprovalForAll'].includes(d.name) && lower(c.to) === a.token && lower(d.args[0]) === a.spender; })) continue;
    if (a.kind === 'erc20' && a.amount === 0n) continue;
    await rateApproval(chain, a.kind, a.token, a.spender, a.amount, add, notChecked, 'Approval inside this transaction');
  }
  for (const o of outgoing) await rateRecipient(chain, o.to, add, 'A token transfer');
  const tokens = Object.keys(moves);
  const meta = await tokenMeta(chain, tokens);
  let usd = {};
  try { usd = tokens.length ? await prices.usdPrices(tokens.map(t => llamaId(chain, t)).filter(Boolean)) : {}; } catch { /* unpriced */ }
  const changes = tokens.map(t => {
    const m = meta[t] || {};
    const amt = m.decimals === null || m.decimals === undefined ? null : Number(ethers.formatUnits(moves[t] < 0n ? -moves[t] : moves[t], m.decimals));
    const price = usd[llamaId(chain, t)];
    return { token: t === ETH_PSEUDO ? 'native' : t, symbol: m.symbol, direction: moves[t] < 0n ? 'out' : 'in', amount: amt, raw: (moves[t] < 0n ? -moves[t] : moves[t]).toString(), usd: amt !== null && price ? Math.round(amt * price * 100) / 100 : null };
  }).filter(c => c.raw !== '0');
  const outUsd = changes.filter(c => c.direction === 'out').reduce((s, c) => s + (c.usd || 0), 0);
  const inCount = changes.filter(c => c.direction === 'in').length + nfts.filter(n => n.direction === 'in').length;
  if (outUsd >= 50 && !inCount && !calls.every(c => decode(c).name === 'transfer')) {
    add('high', `You'd send about $${Math.round(outUsd).toLocaleString()} and receive nothing back`, 'The simulation shows tokens leaving your wallet and nothing arriving. Fine for a payment you meant to make; a classic drain otherwise.', 'simulation (eth_simulateV1)');
  }
  if (nfts.some(n => n.direction === 'out') && !inCount) add('high', 'NFTs would leave your wallet with nothing coming back', 'The simulation shows NFTs moving out.', 'simulation (eth_simulateV1)');
  return { changes, nfts };
}

/* ── signatures ── */
function parseTypedData(params) {
  const raw = params.find(p => typeof p === 'object' && p !== null) || params.find(p => typeof p === 'string' && p.trim().startsWith('{'));
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

async function checkTypedData(chain, from, td, add, notChecked, decoded) {
  const domain = td.domain || {}; const msg = td.message || {}; const type = td.primaryType;
  decoded.push({ typed_data: { primaryType: type, domain: { name: domain.name, chainId: domain.chainId, verifyingContract: domain.verifyingContract } } });
  if (domain.chainId && chain && Number(domain.chainId) !== EVM[chain].chainId) add('high', 'The signature is for another chain than your wallet is on', `It names chain ${domain.chainId}.`, 'the request');
  const deadline = Number(msg.deadline || msg.sigDeadline || msg.expiration || 0);
  const forever = deadline && deadline > Date.now() / 1000 + 365 * 86400;
  if (type === 'Permit' && msg.spender) {
    await rateApproval(chain, 'erc20', domain.verifyingContract, msg.spender, big(msg.value), add, notChecked, 'Permit signature (no transaction needed)');
    add('info', 'A permit is an approval made by signature', 'Once signed, the spender can use it at any time before its deadline, without asking again.', 'EIP-2612');
  } else if (domain.name === 'Permit2' && (type === 'PermitSingle' || type === 'PermitBatch')) {
    for (const d of [].concat(msg.details || [])) await rateApproval(chain, 'permit2', d.token, msg.spender, big(d.amount), add, notChecked, 'Permit2 signature');
  } else if (domain.name === 'Permit2' && /PermitTransferFrom|PermitBatchTransferFrom|PermitWitnessTransferFrom/.test(type)) {
    for (const p of [].concat(msg.permitted || [])) await rateApproval(chain, 'permit2', p.token, msg.spender, big(p.amount), add, notChecked, 'Permit2 transfer signature');
  } else if (domain.name === 'Seaport' && type === 'OrderComponents') {
    const offer = [].concat(msg.offer || []);
    const toMe = [].concat(msg.consideration || []).filter(c => lower(c.recipient) === lower(msg.offerer || from));
    if (offer.length && !toMe.length) add('critical', 'This lists your items for nothing', `The order gives away ${offer.length} item${offer.length === 1 ? '' : 's'} and pays you nothing. This is the classic NFT phishing signature.`, 'Seaport order (decoded)');
    else if (offer.length) add('low', `A Seaport order: ${offer.length} item(s) offered, ${toMe.length} payment(s) to you`, 'Check the price in your wallet before signing.', 'Seaport order (decoded)');
  } else if (domain.name === 'snapshot' && type === 'Vote' && msg.space && msg.proposal) {
    add('info', `A Snapshot vote in ${String(msg.space).slice(0, 60)}`, 'An off-chain vote: it moves no funds and approves nothing. Snapshot records it with your address.', 'Snapshot vote (decoded)');
  } else {
    add('low', `A signature for ${domain.name || 'an app'} (${type || 'typed data'})`, 'Not a known approval or order type.', 'the request');
  }
  if (forever) add('medium', 'It stays valid for over a year', 'A long-lived signature can be used long after you forgot it.', 'the request');
}

function checkPersonalSign(params, origin, add) {
  const raw = params.find(p => typeof p === 'string' && !isAddr(p)) || '';
  let text = raw;
  if (/^0x[0-9a-fA-F]*$/.test(raw)) { try { text = ethers.toUtf8String(raw); } catch { text = null; } }
  if (text === null) { add('high', 'You\'re asked to sign unreadable data', 'It isn\'t text, so you can\'t see what it says.', 'the request'); return; }
  const siwe = /^(\S+) wants you to sign in with your Ethereum account/.exec(text);
  if (siwe && origin) {
    const host = new URL(origin).host;
    if (siwe[1].toLowerCase() !== host.toLowerCase()) add('high', `This sign-in is for ${siwe[1]}, but ${host} is asking`, 'A site asking you to sign in to another site is a phishing pattern.', 'the message (EIP-4361)');
    else add('low', `Sign in to ${host}`, 'A sign-in message: it moves no funds.', 'the message (EIP-4361)');
  } else add('low', 'A text message to sign', 'Signing text moves no funds by itself.', 'the request');
}

/** The pre-sign check. */
async function check(input) {
  const { method, params, origin } = input;
  let from = input.from;
  const chain = chainOf(input.chainId);
  const findings = []; const notChecked = []; const decoded = [];
  const add = (severity, title, detail, source, extra) => findings.push({ severity, title, detail, source, ...(extra ? { extra } : {}) });
  if (!chain) notChecked.push({ check: 'the chain', reason: `chain ${input.chainId} isn't covered; only the site and the request's own content were checked` });

  const jobs = [checkSite(origin, add, notChecked)];
  let simulation = null;
  if (method === 'eth_sendTransaction' || method === 'wallet_sendCalls') {
    const calls = method === 'eth_sendTransaction' ? [params[0] || {}] : [].concat(params[0]?.calls || []);
    from = from || lower(params[0]?.from);
    if (!calls.length) throw new PresignRefused('no calls in the request');
    if (chain && isAddr(from)) jobs.push(checkTransactions(chain, from, calls, add, notChecked, decoded).then(s => { simulation = s; }));
    else if (chain) notChecked.push({ check: 'simulation', reason: 'no sender address' });
  } else if (method.startsWith('eth_signTypedData')) {
    const td = parseTypedData(params);
    if (!td) add('high', 'Unreadable signature request', 'The typed data couldn\'t be read.', 'the request');
    else jobs.push(checkTypedData(chain || chainOf(td.domain?.chainId), from, td, add, notChecked, decoded));
  } else if (method === 'personal_sign') {
    checkPersonalSign(params, origin, add);
  } else if (method === 'eth_sign') {
    add('critical', 'A blind signature of a raw hash', 'eth_sign can sign anything, including a transaction that empties your wallet, and you can\'t see what. Legitimate apps no longer ask for it.', 'the request (eth_sign)');
  }
  await Promise.all(jobs);

  findings.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const worst = findings.find(f => f.severity !== 'info');
  const verdict = worst ? worst.severity : 'low';
  const summary = worst && RANK[worst.severity] >= RANK.high ? `Don't sign this unless you're sure: ${worst.title.charAt(0).toLowerCase()}${worst.title.slice(1)}.`
    : worst && worst.severity === 'medium' ? `Check before signing: ${worst.title.charAt(0).toLowerCase()}${worst.title.slice(1)}.`
      : 'No known risk pattern found.';
  return {
    verdict, summary, findings, decoded, chain, origin,
    ...(simulation ? { simulation } : {}), not_checked: notChecked,
    note: 'An automated check of known patterns, not a guarantee. Your wallet still shows the full request.',
  };
}

module.exports = { parse, check, decode, simulate, readLogs, checkPersonalSign, PresignRefused, METHODS, TOPIC, ETH_PSEUDO };
