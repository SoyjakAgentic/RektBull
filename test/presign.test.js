/**
 * The pre-sign check, with the chain and GoPlus played by stand-ins: each
 * kind of request a wallet gets, and what the check says about it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const presign = require('../src/services/presign');
const rpc = require('../src/providers/rpc');
const goplus = require('../src/providers/goplus');
const prices = require('../src/providers/prices');
const signatures = require('../src/providers/signatures');

const ME = '0x' + '11'.repeat(20);
const DRAINER = '0x' + 'dd'.repeat(20);
const ROUTER = '0x' + 'aa'.repeat(20);
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const NFT = '0x' + 'cc'.repeat(20);
const pad = a => ethers.zeroPadValue(a, 32).toLowerCase();
const word = n => ethers.toBeHex(n, 32);
const I = new ethers.Interface(['function approve(address,uint256)', 'function setApprovalForAll(address,bool)', 'function transfer(address,uint256)', 'function swap(uint256)']);

let simulated = [];
function stubs() {
  rpc.evmRpc = async (chain, method, params) => {
    if (method === 'eth_getCode') return [DRAINER, ME].includes(params[0]) ? '0x' : '0x6080';
    if (method === 'eth_simulateV1') return [{ calls: simulated }];
    if (method === 'eth_call') {
      const sel = params[0].data.slice(0, 10);
      if (sel === new ethers.Interface(['function symbol()']).getFunction('symbol').selector) return new ethers.AbiCoder().encode(['string'], ['USDC']);
      return word(6);
    }
    throw new Error(`unexpected ${method}`);
  };
  goplus.phishingSite = async origin => ({ source: 'GoPlus phishing site list', phishing: origin.includes('evil') });
  goplus.addressRisk = async (chain, a) => ({ source: 'GoPlus (data from SlowMist)', flags: a === DRAINER ? ['phishing'] : [] });
  goplus.contractRisk = async (chain, a) => (a === ROUTER ? { source: 'GoPlus', known: true, open_source: true, trusted: true, name: 'Uniswap Router', malicious: [] } : { source: 'GoPlus', known: false, malicious: [] });
  prices.usdPrices = async ids => Object.fromEntries(ids.filter(i => i.endsWith(USDC)).map(i => [i, 1]));
  signatures.functionName = async () => 'swap(uint256)';
}
stubs();
const run = body => presign.check(presign.parse({ chain_id: 8453, from: ME, origin: 'https://app.example', ...body }));

test('input: only wallet methods, a real origin and an address', () => {
  assert.throws(() => presign.parse({ method: 'eth_getBalance', params: [] }), /method must be one of/);
  assert.throws(() => presign.parse({ method: 'personal_sign', params: 'x' }), /params must be/);
  assert.throws(() => presign.parse({ method: 'personal_sign', params: [], from: 'bob' }), /from must be an address/);
  assert.throws(() => presign.parse({ method: 'personal_sign', params: [], origin: 'not a url' }), /origin/);
});

test('an unlimited approval to a flagged wallet: critical, with the reasons and their sources', async () => {
  simulated = [{ status: '0x1', logs: [{ address: USDC, topics: [presign.TOPIC.approval, pad(ME), pad(DRAINER)], data: word(ethers.MaxUint256) }] }];
  const r = await run({ method: 'eth_sendTransaction', params: [{ from: ME, to: USDC, data: I.encodeFunctionData('approve', [DRAINER, ethers.MaxUint256]) }] });
  assert.equal(r.verdict, 'critical');
  assert.match(r.summary, /^Don't sign this unless you're sure/);
  const f = r.findings[0];
  assert.match(f.title, /^Token approval: 0xdddd…dddd could spend all of this token/);
  assert.match(f.detail, /Flagged for phishing/);
  assert.match(f.source, /SlowMist/);
  assert.equal(r.findings.filter(x => /approval/i.test(x.title)).length, 1, 'the approval seen in the simulation is not counted twice');
  assert.equal(r.decoded[0].function, 'approve(address,uint256)');
});

test('an approval to a known router: low; a swap that pays and receives: low, with the changes', async () => {
  simulated = [{ status: '0x1', logs: [] }];
  const a = await run({ method: 'eth_sendTransaction', params: [{ to: USDC, data: I.encodeFunctionData('approve', [ROUTER, 1000n]) }] });
  assert.equal(a.verdict, 'low');
  simulated = [{ status: '0x1', logs: [
    { address: USDC, topics: [presign.TOPIC.transfer, pad(ME), pad(ROUTER)], data: word(500_000000n) },
    { address: presign.ETH_PSEUDO, topics: [presign.TOPIC.transfer, pad(ROUTER), pad(ME)], data: word(10n ** 17n) },
  ] }];
  const s = await run({ method: 'eth_sendTransaction', params: [{ to: ROUTER, data: I.encodeFunctionData('swap', [1]) }] });
  assert.equal(s.verdict, 'low', JSON.stringify(s.findings));
  assert.equal(s.decoded[0].function, 'swap(uint256)', 'unknown functions are named from the signature database');
  assert.deepEqual(s.simulation.changes.map(c => [c.symbol, c.direction, c.amount, c.usd]), [['USDC', 'out', 500, 500], ['ETH', 'in', 0.1, null]]);
});

test('a router call that hides an approval and sends $900 away for nothing: both caught by the simulation', async () => {
  simulated = [{ status: '0x1', logs: [
    { address: USDC, topics: [presign.TOPIC.approval, pad(ME), pad(DRAINER)], data: word(ethers.MaxUint256) },
    { address: USDC, topics: [presign.TOPIC.transfer, pad(ME), pad(DRAINER)], data: word(900_000000n) },
  ] }];
  const r = await run({ method: 'eth_sendTransaction', params: [{ to: ROUTER, data: I.encodeFunctionData('swap', [1]) }] });
  const titles = r.findings.map(f => `${f.severity}: ${f.title}`);
  assert.ok(titles.some(t => /^critical: Approval inside this transaction: 0xdddd…dddd/.test(t)), titles.join('\n'));
  assert.ok(titles.some(t => /^critical: A token transfer goes to an address flagged for phishing/.test(t)));
  assert.ok(titles.some(t => /^high: You'd send about \$900 and receive nothing back/.test(t)));
});

test('a reverting transaction, and a chain we can\'t simulate on', async () => {
  simulated = [{ status: '0x0', error: { message: 'execution reverted: TRANSFER_FAILED' }, logs: [] }];
  const r = await run({ method: 'eth_sendTransaction', params: [{ to: ROUTER, data: '0x' }] });
  assert.ok(r.findings.some(f => /would fail onchain/.test(f.title) && /TRANSFER_FAILED/.test(f.detail)));
  const real = rpc.evmRpc;
  rpc.evmRpc = async (c, m, p) => { if (m === 'eth_simulateV1') throw new Error('method not found'); return real(c, m, p); };
  const n = await run({ method: 'eth_sendTransaction', params: [{ to: ROUTER, data: '0x' }] });
  assert.ok(n.not_checked.some(x => x.check === 'simulation' && /method not found/.test(x.reason)));
  stubs();
  const other = await presign.check(presign.parse({ chain_id: 999999, from: ME, method: 'eth_sendTransaction', params: [{ to: ROUTER }] }));
  assert.ok(other.not_checked.some(x => x.check === 'the chain'));
});

test('signatures that move tokens without a transaction: Permit, Permit2, a Seaport order for nothing', async () => {
  const permit = await run({ method: 'eth_signTypedData_v4', params: [ME, JSON.stringify({ primaryType: 'Permit', domain: { name: 'USD Coin', chainId: 8453, verifyingContract: USDC }, message: { owner: ME, spender: DRAINER, value: ethers.MaxUint256.toString(), deadline: 9999999999 } })] });
  assert.equal(permit.verdict, 'critical');
  assert.ok(permit.findings.some(f => /^Permit signature \(no transaction needed\): 0xdddd/.test(f.title)));
  assert.ok(permit.findings.some(f => /valid for over a year/.test(f.title)));
  const p2 = await run({ method: 'eth_signTypedData_v4', params: [ME, { primaryType: 'PermitSingle', domain: { name: 'Permit2', chainId: 8453 }, message: { details: { token: USDC, amount: '1000', expiration: 0 }, spender: ROUTER } }] });
  assert.equal(p2.verdict, 'low');
  const sea = await run({ method: 'eth_signTypedData_v4', params: [ME, JSON.stringify({ primaryType: 'OrderComponents', domain: { name: 'Seaport', chainId: 8453 }, message: { offerer: ME, offer: [{ token: NFT, identifierOrCriteria: '1' }], consideration: [{ recipient: DRAINER, startAmount: '1' }] } })] });
  assert.equal(sea.verdict, 'critical');
  assert.match(sea.findings[0].title, /lists your items for nothing/);
  const wrongChain = await run({ method: 'eth_signTypedData_v4', params: [ME, { primaryType: 'Mail', domain: { name: 'X', chainId: 1 }, message: {} }] });
  assert.ok(wrongChain.findings.some(f => /another chain/.test(f.title)));
});

test('messages: a sign-in for another site, a plain sign-in, eth_sign, and a phishing site', async () => {
  const msg = t => ethers.hexlify(ethers.toUtf8Bytes(t));
  const other = await run({ method: 'personal_sign', params: [msg('uniswap.org wants you to sign in with your Ethereum account:\n0x…'), ME] });
  assert.equal(other.verdict, 'high');
  assert.match(other.findings[0].title, /This sign-in is for uniswap\.org, but app\.example is asking/);
  const mine = await run({ method: 'personal_sign', params: [msg('app.example wants you to sign in with your Ethereum account:\n0x…'), ME] });
  assert.equal(mine.verdict, 'low');
  const blind = await run({ method: 'eth_sign', params: [ME, '0x' + 'ab'.repeat(32)] });
  assert.equal(blind.verdict, 'critical');
  const phish = await presign.check(presign.parse({ chain_id: 8453, from: ME, origin: 'https://evil.example', method: 'personal_sign', params: [msg('hello'), ME] }));
  assert.equal(phish.verdict, 'critical');
  assert.match(phish.findings[0].title, /listed as phishing/);
  const puny = await presign.check(presign.parse({ chain_id: 8453, from: ME, origin: 'https://xn--uniswp-bva.org', method: 'personal_sign', params: [msg('hello'), ME] }));
  assert.ok(puny.findings.some(f => /look-alike letters/.test(f.title)));
});
