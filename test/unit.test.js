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

test('catalog: runs try pass, free, credits, then x402; passes are credits only', () => {
  assert.deepEqual(catalog.rails(catalog.product('token_quick_check')), ['pass', 'free', 'credits', 'x402']);
  assert.deepEqual(catalog.rails(catalog.product('token_report')), ['pass', 'credits', 'x402']);
  assert.deepEqual(catalog.rails(catalog.product('pro_30d')), ['credits']);
  assert.ok(catalog.product('token_quick_check').price_cents <= catalog.X402_DEFAULT_CLIENT_CAP_CENTS, 'quick check must work with default x402 clients');
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
