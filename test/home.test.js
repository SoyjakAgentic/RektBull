/**
 * Home: what a pasted address is (with stand-in chains that answer the way
 * real contracts do), the free checkup from every desk (with each desk's
 * check as a stand-in), and both through the API with their daily limits.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, { JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', ...(DB ? { DATABASE_URL: DB } : {}) });
const home = require('../src/services/home');
const rpc = require('../src/providers/rpc');
const explorer = require('../src/providers/explorer');
const cache = require('../src/lib/cache');

/* A stand-in chain: eth_getCode and Multicall3's aggregate3, answered from a table of contracts. */
const MC = new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
const PROBE = new ethers.Interface([
  'function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)', 'function supportsInterface(bytes4) view returns (bool)',
  'function votingDelay() view returns (uint256)', 'function votingPeriod() view returns (uint256)', 'function proposalThreshold() view returns (uint256)',
  'function getThreshold() view returns (uint256)', 'function getOwners() view returns (address[])',
]);
const A = n => '0x' + n.repeat(40);
const CONTRACTS = {
  [A('1')]: { code: '0x6080', fns: { name: ['Test Dollar'], symbol: ['TUSD'], decimals: [6], totalSupply: [1_000_000_000n] } },
  [A('2')]: { code: '0x6080', fns: { name: ['Test Governor'], votingDelay: [1n], votingPeriod: [50n], proposalThreshold: [0n] } },
  [A('3')]: { code: '0x6080', fns: { getThreshold: [2n], getOwners: [[A('a'), A('b'), A('c')]] } },
  [A('4')]: { code: '0x6080', fns: { name: ['Test Apes'], symbol: ['TAPE'], supportsInterface: [true], totalSupply: [100n] } },
  [A('5')]: { code: '0x6080', fns: {} },
  [A('6')]: { code: '0xef0100' + '7'.repeat(40), fns: {} },
};
let unreadable = new Set();
rpc.evmRpc = async (chain, method, params) => {
  if (unreadable.has(chain)) throw new Error('every endpoint failed');
  if (method === 'eth_getCode') return (chain === 'base' || params[0] === A('6') ? CONTRACTS[params[0]]?.code : null) || '0x';
  if (method === 'eth_call') {
    const [calls] = MC.decodeFunctionData('aggregate3', params[0].data);
    return MC.encodeFunctionResult('aggregate3', [calls.map(({ target, callData }) => {
      const k = CONTRACTS[target.toLowerCase()];
      const f = PROBE.parseTransaction({ data: callData });
      const out = k?.fns[f.name];
      if (f.name === 'supportsInterface' && out && f.args[0] !== '0x80ac58cd') return [true, PROBE.encodeFunctionResult(f.name, [false])];
      return out ? [true, PROBE.encodeFunctionResult(f.name, out)] : [false, '0x'];
    })]);
  }
  throw new Error('unexpected ' + method);
};
explorer.explorerGet = async () => ({ result: [{ ContractName: 'TestRouter', SourceCode: 'x', ABI: '[]' }] });
const forget = async () => {
  cache._memory.clear();
  if (DB) await require('../src/config/db').query("DELETE FROM cache WHERE key LIKE 'home:%'").catch(() => {});
};
const look = async q => { await forget(); return home.identify(home.parseQuery({ query: q })); };

test('parseQuery: addresses only, and why anything else is refused', () => {
  assert.deepEqual(home.parseQuery({ query: ' 0x' + 'AB'.repeat(20) + ' ' }), { kind: 'evm', address: '0x' + 'ab'.repeat(20) });
  assert.equal(home.parseQuery({ query: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }).kind, 'solana');
  assert.match(home.parseQuery({ query: '0x' + 'a'.repeat(64) }).error, /transaction hash/);
  assert.match(home.parseQuery({ query: 'vitalik.eth' }).error, /paste the address/);
  assert.match(home.parseQuery({ query: 'hello' }).error, /isn't an address/);
  assert.match(home.parseQuery({}).error, /Paste an address/);
});

test('identify: a token, a governor, a Safe, an NFT collection, a contract, a wallet', async () => {
  let r = await look(A('1'));
  assert.equal(r.kind, 'token');
  assert.equal(r.summary, 'A token on Base');
  assert.deepEqual(r.chains, [{ chain: 'base', kind: 'token', name: 'Test Dollar', symbol: 'TUSD', decimals: 6, total_supply: '1000.0' }]);
  assert.equal(r.next[0].href, `/safety?chain=base&token=${A('1')}`);
  assert.match(r.source, /RPC/);

  r = await look(A('2'));
  assert.equal(r.kind, 'governor');
  assert.equal(r.next[0].href, `/governance?chain=base&governor=${A('2')}#spaces-card`);

  r = await look(A('3'));
  assert.equal(r.kind, 'wallet', 'a Safe is checked like a wallet');
  assert.equal(r.summary, 'A Safe (a multi-signature wallet) on Base');
  assert.equal(r.chains[0].note, 'a Safe that needs 2 of 3 owners to sign');

  r = await look(A('4'));
  assert.deepEqual([r.kind, r.chains[0].standard, r.chains[0].name], ['nft', 'ERC-721', 'Test Apes']);

  r = await look(A('5'));
  assert.deepEqual([r.kind, r.chains[0].name], ['contract', 'TestRouter']);

  r = await look(A('6'));
  assert.equal(r.kind, 'wallet');
  assert.match(r.chains[0].note, /EIP-7702/);

  r = await look(A('9'));
  assert.equal(r.kind, 'wallet');
  assert.match(r.summary, /^A wallet: there's no contract at this address on Ethereum, Base/);
  assert.equal(r.next[1].href, `/safety?wallet=${A('9')}#approvals-card`);
});

test('identify: a chain that can\'t be read is named, never assumed empty', async () => {
  unreadable = new Set(['polygon']);
  const r = await look(A('9'));
  assert.deepEqual(r.not_read.map(n => n.chain), ['polygon']);
  assert.match(r.note, /Not read: Polygon/);
  assert.ok(!r.checked.includes('polygon'));
  unreadable = new Set(['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bsc']);
  await assert.rejects(look(A('9')), e => e instanceof home.HomeRefused && e.status === 503 && /No chain could be read/.test(e.message));
  unreadable = new Set();
});

/* The four desks' free checks, as stand-ins. */
const stub = () => {
  require('../src/services/approvals').preview = async () => ({ summary: { open: 9, to_revoke: 2, by_severity: { critical: 1, high: 0, medium: 1, low: 7 }, value_at_risk_usd: 1234.5, not_priced: 1, chains_read: ['base'], chains_not_read: [{ chain: 'bsc', reason: 'no explorer answered' }] } });
  require('../src/services/claims').check = async () => ({ summary: { claimable: 2, claimable_usd: 41.2, not_priced: 0, chains: ['base', 'arbitrum'] }, sources: [{ name: 'Merkl rewards' }, { name: 'Airdrops RektBull added' }], not_checked: [], fee: { standard_rate: '5%', pro_rate: '3%' } });
  require('../src/yield/proposals').summary = async () => ({ positions: [], idle: [{ chain: 'base', asset: 'USDC', usd: 900 }, { chain: 'base', asset: 'ETH', gas: true, usd: 50 }], total_in_positions_usd: 0, not_read: [], proposals_count: 1, extra_per_year_usd: 38.7 });
  require('../src/services/governance').check = async () => { throw new Error('Snapshot hub didn\'t answer'); };
};

test('checkup: every desk\'s free check at once, each with its source; one that fails says why', async () => {
  stub();
  const r = await home.checkup(A('9'));
  const by = Object.fromEntries(r.parts.map(p => [p.id, p]));
  assert.deepEqual(r.parts.map(p => p.id), ['approvals', 'claims', 'yield', 'governance']);
  assert.equal(by.approvals.status, 'bad');
  assert.equal(by.approvals.headline, '2 approvals worth revoking, of 9 open');
  assert.equal(by.approvals.facts[2].value, '$1,234.50 + 1 not priced');
  assert.deepEqual(by.approvals.not_checked, [{ check: 'approvals on BNB Chain', reason: 'no explorer answered' }]);
  assert.match(by.approvals.action, /5 points or \$1/);
  assert.equal(by.claims.headline, '2 unclaimed rewards worth $41.20');
  assert.equal(by.claims.source, 'Merkl rewards and Airdrops RektBull added, each claim verified onchain');
  assert.match(by.claims.action, /5% of what arrives, 3% with Safety Pro/);
  assert.equal(by.yield.headline, 'Could earn about $38.70 more a year');
  assert.equal(by.yield.facts[1].value, '$900', 'gas money isn\'t idle money');
  assert.match(by.yield.action, /0\.1% per move/);
  assert.deepEqual([by.governance.ok, by.governance.status, by.governance.reason], [false, 'unknown', 'Snapshot hub didn\'t answer']);
  for (const p of r.parts.filter(x => x.ok)) assert.ok(p.source, `${p.id} names its source`);
  assert.equal(by.governance.href, `/governance?wallet=${A('9')}`);
});

test('checkup: a check that takes too long is reported, not waited on forever', async () => {
  stub();
  require('../src/services/governance').check = () => new Promise(resolve => setTimeout(resolve, 300));
  const r = await home.checkup(A('9'), { timeoutMs: 50 });
  assert.match(r.parts[3].reason, /took too long; open the desk/);
});

test('API: lookup and checkup, free with a daily limit', { skip: !DB && 'set TEST_DATABASE_URL' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  const server = require('../src/app').createApp().listen(0);
  t.after(async () => { server.close(); await db.getPool().end(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Paste an address/);

  await forget();
  let r = await post('/v1/lookup', { query: A('1') });
  assert.equal(r.status, 200);
  assert.equal(r.body.kind, 'token');
  assert.equal((await post('/v1/lookup', { query: 'nope' })).status, 400);

  stub();
  r = await post('/v1/checkup', { wallet: A('9') });
  assert.equal(r.status, 200);
  assert.equal(r.body.parts.length, 4);
  assert.equal((await post('/v1/checkup', { wallet: 'nope' })).status, 400, 'bad input isn\'t counted');
  for (let i = 0; i < 2; i++) assert.equal((await post('/v1/checkup', { wallet: A('9') })).status, 200);
  r = await post('/v1/checkup', { wallet: A('9') });
  assert.equal(r.status, 429);
  assert.match(r.body.message, /3 a day without signing in/);
});
