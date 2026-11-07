const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const { rawToCents, centsToRaw, stablecoin } = require('../src/payments/stablecoins');
const catalog = require('../src/payments/catalog');
const x402 = require('../src/payments/x402');
const siwe = require('../src/auth/siwe');
const { parseXpub, addressAt } = require('../src/payments/depositAddress');
const watcher = require('../src/payments/watcher');
const usage = require('../src/providers/usage');
const { refusedForPlan, blockscoutSourceRow } = require('../src/providers/explorer');
const { evmFlags, disagreements } = require('../src/services/tokenRisk');
const { parseTarget } = require('../src/services/dueDiligence');
const cache = require('../src/lib/cache');

test('stablecoin amounts convert to whole cents, rounding down', () => {
  assert.equal(rawToCents('25000000', 6), 2500);           // 25 USDC
  assert.equal(rawToCents('1999999', 6), 199);             // $1.999999 -> 199 cents, never 200
  assert.equal(rawToCents('5000000000000000000', 18), 500); // 5 BSC USDT
  assert.equal(centsToRaw(25, 6).toString(), '250000');
  assert.throws(() => stablecoin('base', 'USDT'), /not accepted/);
});

test('catalog: runs try Safety Pro, points, credits, then x402; reports take no points; passes are credits only', () => {
  assert.deepEqual(catalog.rails(catalog.product('token_quick_check')), ['pass', 'points', 'credits', 'x402']);
  assert.deepEqual(catalog.rails(catalog.product('approval_cleanup')), ['pass', 'points', 'credits', 'x402']);
  assert.deepEqual(catalog.rails(catalog.product('token_report')), ['pass', 'credits', 'x402'], 'each report costs real AI money: no points');
  assert.deepEqual(catalog.rails(catalog.product('pro_30d')), ['credits']);
  for (const id of ['token_quick_check', 'approval_cleanup']) assert.ok(catalog.product(id).price_cents <= catalog.X402_DEFAULT_CLIENT_CAP_CENTS, `${id} must work with default x402 clients`);
  const pro = catalog.product('pro_30d');
  assert.deepEqual([...pro.covers].sort(), ['airdrop_claim', 'approval_cleanup', 'governance_summary', 'presign_check', 'risk_monitor', 'token_quick_check', 'token_report', 'yield_proposals'], 'airdrop_claim: the 3% claim fee; yield_proposals; governance_summary');
  assert.deepEqual(catalog.rails(catalog.product('presign_check')), ['pass', 'points', 'credits', 'x402']);
  assert.deepEqual(pro.monitor, { wallets: 3, every_hours: 24 });
  assert.deepEqual(pro.ai_allowance, { cents_per_30_days: 200, uses: ['token_report', 'governance_summary'] }, '$2 of AI every 30 days, at real cost');
  assert.equal(pro.fair_use_per_day.governance_summary, undefined, 'summaries come out of the AI allowance, not a daily count');
  assert.equal(catalog.publicCatalog().find(p => p.id === 'token_report').in_pro_ai_allowance, true);
  assert.equal(catalog.product('token_quick_check').points, 1);
  assert.equal(catalog.product('approval_cleanup').points, 5);
  assert.equal(catalog.FREE_POINTS.per_month, 30);
  const report = catalog.publicCatalog().find(p => p.id === 'token_report');
  assert.match(report.x402_note, /\$1 default/);
});

test('x402 requirements ask for the exact USDC amount on Base', () => {
  const r = x402.requirements(catalog.product('token_quick_check'), 'https://rektbull.com/v1/tokens/quick-check');
  assert.equal(r.maxAmountRequired, '250000');
  assert.equal(r.scheme, 'exact');
  assert.equal(r.asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  assert.deepEqual(r.extra, { name: 'USD Coin', version: '2' });
});

test('x402 header decoding rejects garbage with a payment error', () => {
  assert.throws(() => x402.decodeHeader('not-base64-json'), e => e.isPaymentInvalid && e.status === 402);
  const good = Buffer.from(JSON.stringify({ x402Version: 1, payload: { authorization: { from: '0xABC' } } })).toString('base64');
  assert.equal(x402.payerOf(x402.decodeHeader(good)), '0xabc');
});

test('sign-in: only the wallet that signed the exact message passes', async () => {
  const wallet = ethers.Wallet.createRandom();
  const other = ethers.Wallet.createRandom();
  const now = new Date('2026-11-01T00:00:00Z');
  const message = siwe.buildMessage({ address: wallet.address, chainId: 8453, nonce: 'abc123', issuedAt: now, expiresAt: new Date(now.getTime() + 600000), domain: 'rektbull.com', uri: 'https://rektbull.com' });
  assert.match(message, /^rektbull\.com wants you to sign in with your Ethereum account:\n0x/);
  assert.match(message, /does not move funds/);
  const sig = await wallet.signMessage(message);
  assert.equal(siwe.signedBy(message, sig, wallet.address), true);
  assert.equal(siwe.signedBy(message, sig, other.address), false);
  assert.equal(siwe.signedBy(message.replace('8453', '1'), sig, wallet.address), false, 'a changed message must fail');
  assert.equal(siwe.signedBy(message, '0xdeadbeef', wallet.address), false);
});

test('token checks list every check that could not run, with its reason', () => {
  const { notChecked } = require('../src/services/dueDiligence');
  const out = notChecked({
    source: { verified: true },
    trading: { not_checked: 'no 0x API key (ZEROEX_API_KEY)' },
    goplus: { not_checked: 'GoPlus does not cover this chain' },
    holders: { source: 'RPC', roles: { not_checked: 'Role holders: timeout' } },
  }, { not_checked: 'DexScreener: 429' });
  assert.deepEqual(out, [
    { check: 'trading', reason: 'no 0x API key (ZEROEX_API_KEY)' },
    { check: 'goplus', reason: 'GoPlus does not cover this chain' },
    { check: 'holders.roles', reason: 'Role holders: timeout' },
    { check: 'market', reason: 'DexScreener: 429' },
  ]);
  assert.deepEqual(notChecked({ source: { verified: true } }, { source: 'DexScreener', pairs: 2 }), []);
});

test('sign-in: smart wallets are checked with EIP-1271 if deployed, EIP-6492 if not, read-only', async () => {
  const erc6492 = require('../src/auth/erc6492');
  const rpc = require('../src/providers/rpc');
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const wallet = '0x' + 'cb'.repeat(20);
  const factory = '0x' + 'fa'.repeat(20);
  const message = siwe.buildMessage({ address: wallet, chainId: 84532, nonce: 'n', issuedAt: new Date(), expiresAt: new Date(Date.now() + 600000) });
  const inner = '0x' + '11'.repeat(65);
  const wrapped = coder.encode(['address', 'bytes', 'bytes'], [factory, '0xabcd', inner]) + erc6492.SUFFIX;

  assert.equal(erc6492.isWrapped(inner), false);
  assert.equal(erc6492.isWrapped(wrapped), true);
  assert.deepEqual({ ...erc6492.unwrap(wrapped) }, { factory: ethers.getAddress(factory), factoryCalldata: '0xabcd', signature: inner });
  assert.equal(erc6492.unwrap('0x' + '00'.repeat(4) + erc6492.SUFFIX), null, 'a broken wrapper is refused');

  const calls = [];
  const fake = ({ code, answer }) => async (chain, method, params) => {
    calls.push({ chain, method, params });
    if (method === 'eth_getCode') return code;
    if (method === 'eth_call') return answer(params[0]);
    throw new Error(method);
  };
  const real = rpc.evmRpc;
  try {
    // Not deployed: one deployless eth_call (no `to`) to the check, with the wrapper's parts.
    rpc.evmRpc = fake({ code: '0x', answer: tx => (tx.to ? '0x' : '0x01') });
    assert.equal(await siwe.signedByContract(message, wrapped, wallet), true);
    const call = calls.find(c => c.method === 'eth_call');
    assert.equal(call.chain, 'base-sepolia');
    assert.equal(call.params[0].to, undefined, 'a deployless call, never a transaction');
    assert.equal(call.params[0].data, erc6492.checkCallData(wallet, ethers.hashMessage(message), { factory, factoryCalldata: '0xabcd', signature: inner }));
    rpc.evmRpc = fake({ code: '0x', answer: () => '0x00' });
    assert.equal(await siwe.signedByContract(message, wrapped, wallet), false, 'the check said no');
    rpc.evmRpc = fake({ code: '0x', answer: () => '0x01' });
    assert.equal(await siwe.signedByContract(message, inner, wallet), false, 'not deployed and not wrapped: nothing to check');

    // Deployed: EIP-1271 on the wallet, with the signature inside any wrapper.
    calls.length = 0;
    rpc.evmRpc = fake({ code: '0x6000', answer: tx => (tx.to === wallet ? '0x1626ba7e' + '0'.repeat(56) : '0x') });
    assert.equal(await siwe.signedByContract(message, wrapped, wallet), true);
    const sent = new ethers.Interface(['function isValidSignature(bytes32,bytes)']).decodeFunctionData('isValidSignature', calls.find(c => c.method === 'eth_call').params[0].data);
    assert.equal(sent[1], inner, 'the wrapper is removed for a deployed wallet');
    assert.equal(await siwe.signedByContract(message, inner, wallet), true);

    rpc.evmRpc = async () => { throw new Error('rpc down'); };
    assert.equal(await siwe.signedByContract(message, wrapped, wallet), false, 'an RPC failure never signs anyone in');
    assert.equal(await siwe.signedByContract(message.replace('Chain ID: 84532', 'Chain ID: 999'), wrapped, wallet), false, 'unknown chain');
  } finally {
    rpc.evmRpc = real;
  }
});

test('explorer logs: paged by block range, without duplicates, and incomplete when pages run out', async () => {
  const explorer = require('../src/providers/explorer');
  const real = explorer.explorerGet;
  const log = (block, i) => ({ blockNumber: '0x' + block.toString(16), logIndex: '0x' + i.toString(16), transactionHash: '0x' + String(block).padStart(64, '0'), topics: [] });
  const seen = [];
  try {
    // 1,000 logs ending in block 50, then the rest of block 50 again plus two more.
    explorer.explorerGet = async (chain, params) => {
      seen.push(params.fromBlock);
      if (params.fromBlock === 0) return { status: '1', result: Array.from({ length: 1000 }, (_, i) => log(i < 999 ? 1 + Math.floor(i / 25) : 50, i)) };
      return { status: '1', result: [log(50, 999), log(50, 1000), log(51, 0)] };
    };
    const out = await explorer.explorerLogs('base', { topic0: '0xaa', topic1: '0xbb' });
    assert.deepEqual(seen, [0, 50]);
    assert.equal(out.logs.length, 1002, 'the repeated log is counted once');
    assert.equal(out.complete, true);

    explorer.explorerGet = async () => ({ status: '1', result: Array.from({ length: 1000 }, (_, i) => log(7, i)) });
    const capped = await explorer.explorerLogs('base', { topic0: '0xaa' }, { maxPages: 2 });
    assert.equal(capped.complete, false, 'still more when the pages ran out');

    explorer.explorerGet = async () => ({ status: '0', message: 'No records found', result: [] });
    assert.deepEqual(await explorer.explorerLogs('base', { topic0: '0xaa' }), { logs: [], complete: true });
    explorer.explorerGet = async () => ({ status: '0', message: 'NOTOK', result: 'Max rate limit reached' });
    await assert.rejects(explorer.explorerLogs('base', { topic0: '0xaa' }), /Max rate limit reached/);
  } finally {
    explorer.explorerGet = real;
  }
});

test('approval cleanup: input checks, and known contracts rate low even when unlimited', () => {
  const approvals = require('../src/services/approvals');
  assert.match(approvals.parseOwner({ wallet: '0x123' }).error, /wallet address/);
  assert.equal(approvals.parseOwner({ wallet: '0x' + 'AB'.repeat(20) }).owner, '0x' + 'ab'.repeat(20));
  const p2 = approvals.PERMIT2;
  const r = approvals.rate({ kind: 'erc20', unlimited: true }, { address: p2, wallet: false, risk: { source: 'GoPlus', known: true, open_source: true, trusted: true } });
  assert.equal(r.severity, 'low');
  assert.ok(r.reasons.some(x => x.source === 'RektBull\'s list of known contracts'));
  const unknown = approvals.rate({ kind: 'erc20', unlimited: true }, { address: '0x' + '12'.repeat(20), wallet: false, risk: { not_checked: 'GoPlus: timeout' } });
  assert.equal(unknown.severity, 'medium', 'when we couldn\'t check who it is, it is never rated low');
  assert.ok(unknown.reasons.some(x => /Couldn't check who it is: GoPlus: timeout/.test(x.text)));
});

test('free points: a wallet with no transactions anywhere checked is new; a failed check never punishes the user', async () => {
  const points = require('../src/payments/points');
  const rpc = require('../src/providers/rpc');
  const real = rpc.evmRpc;
  const prev = process.env.NEW_WALLET_CHECK_CHAINS;
  process.env.NEW_WALLET_CHECK_CHAINS = 'ethereum,base';
  const w = '0x' + '12'.repeat(20);
  try {
    rpc.evmRpc = async (chain, method) => (method === 'eth_getTransactionCount' ? '0x0' : '0x');
    assert.equal(await points.isNewWallet(w), true);
    rpc.evmRpc = async (chain, method) => (method === 'eth_getTransactionCount' ? (chain === 'base' ? '0x3' : '0x0') : '0x');
    assert.equal(await points.isNewWallet(w), false, 'transactions on any chain checked');
    rpc.evmRpc = async (chain, method) => (method === 'eth_getCode' ? '0x6000' : '0x0');
    assert.equal(await points.isNewWallet(w), false, 'a deployed smart wallet is not new');
    rpc.evmRpc = async () => { throw new Error('rpc down'); };
    assert.equal(await points.isNewWallet(w), null, 'could not tell: the caller gives the full allowance');
  } finally {
    rpc.evmRpc = real;
    if (prev === undefined) delete process.env.NEW_WALLET_CHECK_CHAINS; else process.env.NEW_WALLET_CHECK_CHAINS = prev;
  }
});

test('AI cost estimate: list prices per million tokens; unknown models are recorded without a guess', () => {
  const claude = require('../src/ai/claude');
  assert.equal(claude.estimateUsd('claude-opus-5-5', { input_tokens: 5000, output_tokens: 2500 }), 0.07, '5K in + 2.5K out on Opus 5.5 is 7 cents');
  assert.equal(claude.estimateUsd('some-future-model', { input_tokens: 1, output_tokens: 1 }), null);
});

test('risk monitor: what changed since the last check becomes an alert, and nothing twice', () => {
  const { compare } = require('../src/services/monitor');
  const appr = (chain, id, severity, extra = {}) => ({ chain, id, kind: 'erc20', severity, token: { address: '0xt', symbol: 'USDC' }, spender: { address: extra.spender || '0xs', label: null, is_wallet: extra.wallet ?? false }, allowance: {}, value_at_risk_usd: 10, reasons: [{ text: 'r', source: 'GoPlus' }] });
  const open = list => Object.fromEntries(list.map(a => [`${a.chain}:${a.id}`, a]));

  // First check: one summary, no per-approval alerts.
  const first = compare(null, { read: ['base', 'ethereum'], unread: [], open: open([appr('base', 'a', 'high', { spender: '0xa' })]), impls: { 'base:0xa': '0xi1' }, stables: [] });
  assert.deepEqual(first.alerts.map(a => [a.kind, a.severity]), [['watching_started', 'high']]);
  assert.match(first.alerts[0].title, /1 risky approval is open now/);

  // Next check: a new risky approval, a rating that rose, an upgraded spender, a depeg; a low one alerts nothing.
  const now = {
    read: ['base', 'ethereum'], unread: [],
    open: open([appr('base', 'a', 'critical', { spender: '0xa' }), appr('base', 'b', 'medium', { spender: '0xb' }), appr('ethereum', 'c', 'low', { spender: '0xc' })]),
    impls: { 'base:0xa': '0xi2' },
    stables: [{ chain: 'base', symbol: 'USDC', address: '0xusdc', amount: 500, price: 0.95 }, { chain: 'ethereum', symbol: 'USDT', address: '0xusdt', amount: 9, price: 0.999 }],
  };
  const second = compare(first.snapshot, now, '2026-11-02');
  const kinds = second.alerts.map(a => `${a.kind}:${a.severity}`).sort();
  assert.deepEqual(kinds, ['depeg:high', 'new_approval:medium', 'spender_flagged:critical', 'spender_upgraded:high']);
  const up = second.alerts.find(a => a.kind === 'spender_upgraded');
  assert.equal(up.detail.implementation_was, '0xi1');
  assert.ok(up.detail.reasons[0].source.includes('EIP-1967'));
  assert.equal(second.alerts.find(a => a.kind === 'depeg').dedupe, 'depeg:base:0xusdc:2026-11-02', 'a depeg alerts once a day');
  assert.deepEqual(second.snapshot.summary, { open: 3, risky: 2, value_at_risk_usd: 20, chains_not_read: [] });

  // A chain that couldn't be read keeps what it had, so its approvals don't look new when it's back.
  const blind = compare(second.snapshot, { read: ['ethereum'], unread: [{ chain: 'base', reason: 'down' }], open: open([appr('ethereum', 'c', 'low', { spender: '0xc' })]), impls: {}, stables: [] });
  assert.deepEqual(blind.alerts, []);
  const back = compare(blind.snapshot, now, '2026-11-02');
  assert.deepEqual(back.alerts.map(a => a.kind).filter(k => k !== 'depeg'), [], 'nothing new on Base after it comes back');
});

test('alert transports: a blocked bot or a missing chat switches the channel off; our own bad message does not', async () => {
  const axios = require('axios');
  const { telegram } = require('../src/alerts/transports');
  const real = axios.post;
  const fail = (status, description) => { axios.post = async () => { throw Object.assign(new Error('x'), { response: { status, data: { description } } }); }; };
  try {
    fail(403, 'Forbidden: bot was blocked by the user');
    await assert.rejects(telegram.send('1', { text: 'hi' }), e => e.permanent === true);
    fail(400, 'Bad Request: chat not found');
    await assert.rejects(telegram.send('1', { text: 'hi' }), e => e.permanent === true);
    fail(400, 'Bad Request: message is too long');
    await assert.rejects(telegram.send('1', { text: 'hi' }), e => !e.permanent, 'retried, not switched off');
    fail(429, 'Too Many Requests');
    await assert.rejects(telegram.send('1', { text: 'hi' }), e => !e.permanent);
    let body;
    axios.post = async (url, b) => { body = b; return { data: { ok: true } }; };
    await telegram.send('1', { text: 'hi', url: 'http://localhost/x', action: 'Open' });
    assert.equal(body.reply_markup, undefined, 'Telegram buttons need https links');
    await telegram.send('1', { text: 'hi', url: 'https://rektbull.com/safety', action: 'Open' });
    assert.deepEqual(body.reply_markup.inline_keyboard[0][0], { text: 'Open', url: 'https://rektbull.com/safety' });
  } finally {
    axios.post = real;
  }
});

test('deposit xpub: public key only, at the right path, same addresses as the mnemonic', () => {
  const mnemonic = ethers.Mnemonic.fromPhrase('test test test test test test test test test test test junk');
  const account = ethers.HDNodeWallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0");
  const xpub = account.neuter().extendedKey;
  const node = parseXpub(xpub);
  assert.equal(addressAt(0, node), ethers.HDNodeWallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0/0").address.toLowerCase());
  assert.equal(addressAt(7, node), ethers.HDNodeWallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0/7").address.toLowerCase());
  assert.throws(() => parseXpub(account.extendedKey), /private key/);
  assert.throws(() => parseXpub(ethers.HDNodeWallet.fromMnemonic(mnemonic, "m/44'/60'/0'").neuter().extendedKey), /not the key at/);
});

test('watcher reads Transfer logs and checks receipts exactly', () => {
  const to = '0x1111111111111111111111111111111111111111';
  const token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const log = {
    address: token,
    topics: [watcher.TRANSFER, watcher.padTopic('0x2222222222222222222222222222222222222222'), watcher.padTopic(to)],
    data: ethers.toBeHex(25000000n, 32),
    transactionHash: '0xAB',
    logIndex: '0x3',
    blockNumber: '0x10',
  };
  const t = watcher.parseTransferLog(log);
  assert.deepEqual(t, { token, from: '0x2222222222222222222222222222222222222222', to, raw: '25000000', txHash: '0xab', logIndex: 3, blockNumber: 16 });
  assert.equal(watcher.parseTransferLog({ ...log, topics: [ethers.id('Approval(address,address,uint256)'), ...log.topics.slice(1)] }), null);

  const coin = { address: token };
  const d = { log_index: 3, to_address: to, amount_raw: '25000000' };
  assert.equal(watcher.receiptHasTransfer({ status: '0x1', logs: [log] }, d, coin), true);
  assert.equal(watcher.receiptHasTransfer({ status: '0x0', logs: [log] }, d, coin), false, 'a reverted transaction pays nothing');
  assert.equal(watcher.receiptHasTransfer({ status: '0x1', logs: [] }, d, coin), false, 'a reorged-out transfer pays nothing');
  assert.equal(watcher.receiptHasTransfer({ status: '0x1', logs: [{ ...log, address: '0x0000000000000000000000000000000000000bad' }] }, d, coin), false, 'a fake token pays nothing');
});

test('provider limits: warn at 80%, block at 100%', () => {
  assert.equal(usage.level(10, undefined), 'ok');
  assert.equal(usage.level(79, 100), 'ok');
  assert.equal(usage.level(80, 100), 'warn');
  assert.equal(usage.level(100, 100), 'blocked');
});

test('explorer fallback: plan refusals move on, empty results do not', () => {
  assert.equal(refusedForPlan({ status: '0', message: 'NOTOK', result: 'Free API access is not supported for this chain. Please upgrade your api plan' }), true);
  assert.equal(refusedForPlan({ status: '0', message: 'NOTOK', result: 'Max rate limit reached' }), true);
  assert.equal(refusedForPlan({ status: '0', message: 'No records found', result: [] }), false);
  assert.equal(refusedForPlan({ status: '1', message: 'OK', result: [] }), false);
  const row = blockscoutSourceRow({ ABI: '[]', SourceCode: 'x', IsProxy: 'true', ImplementationAddress: '0xabc' });
  assert.equal(row.Proxy, '1');
  assert.equal(row.Implementation, '0xabc');
});

test('token risk flags: honeypot is critical; a renounced owner-only power is info', () => {
  const base = { source: { verified: true, powers: { mint: [], pause: [], blacklist: [], fees: [], limits: [], trading: [] } }, ownership: { renounced: false }, trading: {}, gp: {} };
  const honeypot = evmFlags({ ...base, gp: { honeypot: true } });
  assert.equal(honeypot.find(f => f.id === 'honeypot').severity, 'critical');

  const minted = { ...base.source, powers: { ...base.source.powers, mint: ['mint'] } };
  assert.equal(evmFlags({ ...base, source: minted }).find(f => f.id === 'power_mint').severity, 'high');
  assert.equal(evmFlags({ ...base, source: minted, ownership: { renounced: true, owner: '0x000000000000000000000000000000000000dead' } }).find(f => f.id === 'power_mint').severity, 'info');

  assert.equal(evmFlags({ ...base, source: { verified: false } }).find(f => f.id === 'unverified').severity, 'high');
  assert.match(disagreements({ sellable: true }, { honeypot: true })[0], /GoPlus calls it a honeypot/);
});

test('due diligence input: chain and address are checked before anyone pays', () => {
  assert.deepEqual(parseTarget({ chain: 'BASE', token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }), { chain: 'base', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' });
  assert.match(parseTarget({ chain: 'base', token_address: 'nope' }).error, /contract address/);
  assert.match(parseTarget({ chain: 'tron', token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }).error, /chain must be one of/);
  assert.equal(parseTarget({ chain: 'solana', token_address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }).token, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
});

test('memory cache expires entries', () => {
  cache._memSet('k', 1, 10, 1000);
  assert.equal(cache._memGet('k', 5000), 1);
  assert.equal(cache._memGet('k', 11001), undefined);
});

test('AI allowance: 30-day periods from the pass start; a run is metered at its real AI cost; unknown models never count as free', async () => {
  const ai = require('../src/payments/aiAllowance');
  const day = 86400000, start = Date.UTC(2026, 0, 1);
  const pass = { id: 7, starts_at: new Date(start).toISOString(), ends_at: new Date(start + 365 * day).toISOString() };
  assert.deepEqual(ai.period(pass, start + 5 * day), { key: 'pass:7:0', resets_at: new Date(start + 30 * day).toISOString() });
  assert.equal(ai.period(pass, start + 31 * day).key, 'pass:7:1', 'a year\'s pass gets a fresh allowance every 30 days');
  assert.equal(ai.period(pass, start + 361 * day).resets_at, pass.ends_at, 'the last period ends with the pass');
  const { result, usd, calls } = await ai.meter(async () => { ai.add(0.08); await new Promise(r => setTimeout(r, 1)); ai.add(0.02); return 'ok'; });
  assert.deepEqual([result, Math.round(usd * 100) / 100, calls], ['ok', 0.1, 2]);
  ai.add(5); // outside a metered run: counted nowhere
  const claude = require('../src/ai/claude');
  assert.equal(claude.costOf('claude-opus-5-5', { input_tokens: 10000, output_tokens: 4000 }), 0.12);
  assert.equal(claude.costOf('some-new-model', { input_tokens: 10000, output_tokens: 4000 }), 0.12, 'priced at the dearest listed model');
});
