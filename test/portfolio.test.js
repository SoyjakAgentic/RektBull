/**
 * Portfolio, with the explorer, the chains, DefiLlama and the other desks as
 * stand-ins: holdings found from transfers and read onchain, values and
 * totals, the facts on holdings (lookalikes, links in names, only received,
 * off peg), unpriced tokens kept out of the total, a chain or part that
 * couldn't be read named, and the API with its daily limit.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, { JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', ...(DB ? { DATABASE_URL: DB } : {}) });
const explorer = require('../src/providers/explorer');
const rpc = require('../src/providers/rpc');
const prices = require('../src/providers/prices');
const approvals = require('../src/services/approvals');
const positions = require('../src/yield/positions');
const pf = require('../src/services/portfolio');
const cache = require('../src/lib/cache');

const W = '0x' + 'aa'.repeat(20);
const USDC = pf.MAJOR.base.USDC;
const FAKE = '0x' + 'f0'.repeat(20);
const LINKY = '0x' + 'f1'.repeat(20);
const MEME = '0x' + 'f2'.repeat(20);
const TRADED = '0x' + 'f3'.repeat(20);
const DEPEG = '0x' + 'f4'.repeat(20);
const tx = (contract, symbol, name, decimals, from = '0x' + '99'.repeat(20)) => ({ contractAddress: contract, tokenSymbol: symbol, tokenName: name, tokenDecimal: String(decimals), from });
const BAL = { [USDC]: 1500e6, [FAKE]: 5000e6, [LINKY]: 1e18, [MEME]: 1e24, [TRADED]: 10e18, [DEPEG]: 100e18 };

const stub = ({ explorerDown = [], slowApprovals = false } = {}) => {
  cache._memory.clear();
  explorer.explorerGet = async (chain, params) => {
    if (explorerDown.includes(chain)) throw new Error('no explorer answered');
    if (chain !== 'base' || params.action !== 'tokentx') return { result: [] };
    return { result: [
      tx(USDC, 'USDC', 'USD Coin', 6), tx(FAKE, 'USDC', 'USD Coin', 6), tx(LINKY, 'GIFT', 'Claim at usdc-gift.com', 18), tx(MEME, 'MEME', 'Meme', 18),
      tx(TRADED, 'GOOD', 'Good Token', 18), tx(TRADED, 'GOOD', 'Good Token', 18, W), tx(DEPEG, 'USDE', 'Ethena USDe', 18),
    ] };
  };
  approvals.multicall = async (chain, calls) => calls.map(c => {
    if (c.fn === 'decimals') return { ok: true, value: [Object.values(pf.MAJOR[chain]).includes(c.target) && c.target !== pf.MAJOR[chain].WETH ? 6 : 18] };
    const raw = chain === 'base' ? BAL[c.target] || 0 : 0;
    return { ok: true, value: [BigInt(raw)] };
  });
  rpc.evmRpc = async (chain, method) => { if (method === 'eth_getBalance') return chain === 'base' ? '0x' + (2n * 10n ** 18n).toString(16) : '0x0'; throw new Error('unexpected'); };
  prices.usdPrices = async ids => {
    const p = { [`base:${USDC}`]: 1, [`base:${FAKE}`]: 1, [`base:${MEME}`]: 0.000001, [`base:${TRADED}`]: 3, [`base:${DEPEG}`]: 0.97, 'coingecko:ethereum': 2500 };
    return Object.fromEntries(ids.filter(id => p[id] !== undefined).map(id => [id, p[id]]));
  };
  positions.read = async () => ({ positions: [{ chain: 'base', asset: 'USDC', amount: '1000', usd: 1000, protocol: 'aave', name: 'Aave v3', status: 'open' }], not_read: [] });
  approvals.preview = slowApprovals ? () => new Promise(r => setTimeout(r, 500)) : async () => ({ summary: { open: 4, to_revoke: 1, value_at_risk_usd: 1500 } });
};

test('holdings: found from transfers, read onchain, valued; totals by kind and chain', async () => {
  stub();
  const r = await pf.portfolio(W);
  const sym = h => `${h.chain}:${h.symbol}`;
  assert.deepEqual(r.holdings.map(sym), ['base:ETH', 'base:USDC', 'base:USDE', 'base:GOOD', 'base:MEME'], 'by value; the lookalike USDC isn\'t counted');
  const usdc = r.holdings.find(h => h.symbol === 'USDC');
  assert.equal(usdc.usd, 1500);
  assert.deepEqual(usdc.signals, [], 'the real USDC carries no flag');
  assert.equal(r.tokens_usd, 5000 + 1500 + 97 + 30 + 1);
  assert.equal(r.defi_usd, 1000);
  assert.equal(r.total_usd, 7628);
  assert.deepEqual(r.by_chain.map(c => [c.chain, c.usd]), [['base', 7628]]);
  assert.equal(r.stable_pct, Math.round((1500 + 97 + 1000) / 7628 * 10000) / 100);
  assert.deepEqual(r.positions.map(p => [p.protocol, p.usd]), [['Aave v3', 1000]]);
  assert.deepEqual(r.risk, { to_revoke: 1, open: 4, value_at_risk_usd: 1500, href: `/safety?wallet=${W}#approvals-card` });
  for (const s of r.sources) assert.ok(s);
});

test('the facts on holdings: lookalikes, links in names, only received, off peg; unpriced kept out', async () => {
  stub();
  const r = await pf.portfolio(W);
  const all = [...r.holdings, ...r.unpriced];
  const by = a => all.find(h => h.address === a);
  assert.match(by(FAKE).signals[0].text, /Named USDC but isn't the real USDC contract on Base: a common scam airdrop/);
  assert.ok(r.unpriced.includes(by(FAKE)), 'a lookalike is listed apart, never counted');
  assert.match(by(LINKY).signals.map(s => s.text).join(' | '), /Its name carries a link/);
  assert.ok(r.unpriced.includes(by(LINKY)));
  assert.match(by(MEME).signals.map(s => s.text).join(' | '), /Only ever sent to this wallet, never sent from it/);
  assert.equal(by(TRADED).signals.length, 0, 'a token the wallet has sent isn\'t "only received"');
  assert.match(by(DEPEG).signals.map(s => s.text).join(' | '), /Off its peg by 3\.0% \(price \$0\.9700\)/);
  assert.equal(r.flagged, 3, 'the lookalike, the link, and the stablecoin 3% off its peg');
  for (const h of all) for (const s of h.signals) assert.ok(s.source, 'every fact names its source');
});

test('a chain or part that can\'t be read is named; the major tokens are still read', async () => {
  stub({ explorerDown: ['base'], slowApprovals: true });
  const before = pf.PART_MS;
  require('../src/services/portfolio').PART_MS = 50;
  try {
    const r = await pf.portfolio('0x' + 'ab'.repeat(20)); // another wallet: the earlier reads are cached
    assert.ok(r.not_read.some(n => n.chain === 'base' && /tokens beyond the major ones/.test(n.what)));
    assert.ok(r.not_read.some(n => n.what === 'approvals' && /took too long/.test(n.reason)));
    assert.equal(r.risk, null);
    assert.ok(r.holdings.some(h => h.symbol === 'USDC'), 'the real USDC is always checked');
    assert.ok(!r.holdings.some(h => h.symbol === 'GOOD'), 'tokens only the explorer knows about aren\'t');
  } finally { require('../src/services/portfolio').PART_MS = before; }
});

test('tokenSignals: a major token on its own contract is never flagged', () => {
  assert.deepEqual(pf.tokenSignals({ chain: 'ethereum', symbol: 'USDT', name: 'Tether USD', address: pf.MAJOR.ethereum.USDT, price: 0.999 }), []);
  assert.equal(pf.tokenSignals({ chain: 'ethereum', symbol: 'WETH', name: 'Wrapped Ether', address: '0x' + '12'.repeat(20), price: null })[0].level, 'bad');
  assert.ok(ethers.isAddress(pf.MAJOR.bsc.USDT));
});

test('API: free with a daily limit', { skip: !DB && 'set TEST_DATABASE_URL' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  stub();
  const server = require('../src/app').createApp().listen(0);
  t.after(async () => { server.close(); await db.getPool().end(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(base + '/v1/portfolio', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ wallet: 'nope' })).status, 400);
  const page = await (await fetch(base + '/portfolio')).text();
  assert.ok(page.includes('<a href="/portfolio" aria-current="page">'));
  for (let i = 0; i < 5; i++) assert.equal((await post({ wallet: W })).status, 200);
  const r = await post({ wallet: W });
  assert.equal(r.status, 429);
  assert.match((await r.json()).message, /5 a day without signing in/);
});
