/**
 * Portfolio: what a wallet holds on the six EVM chains, what it's worth, and
 * the facts about each holding that matter for its safety.
 *
 * Tokens are found from the explorer's record of the wallet's token
 * transfers (plus the major tokens on each chain, always checked), and their
 * balances read onchain now (Multicall3): a transfer record says what came in
 * once; the chain says what's there now. Prices are DefiLlama's; a token it
 * doesn't price is listed as not priced, never guessed. DeFi positions on
 * Aave, Compound and Spark come from the yield desk's onchain read.
 *
 * Facts on holdings: a token named like a major one (USDC, USDT, WETH) that
 * isn't its real contract, a name that carries a link, a stablecoin off its
 * peg, and a reminder that unpriced tokens are often scam airdrops. A chain or
 * part that couldn't be read is named.
 */
const { ethers } = require('ethers');
const { EVM } = require('../providers/chains');
const rpc = require('../providers/rpc');
const explorer = require('../providers/explorer');
const prices = require('../providers/prices');
const approvals = require('./approvals');
const { cached } = require('../lib/cache');

const CHAINS = Object.keys(EVM);
const CHAIN_NAMES = { ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon', bsc: 'BNB Chain' };
const NATIVE = {
  ethereum: { symbol: 'ETH', price: 'coingecko:ethereum' }, base: { symbol: 'ETH', price: 'coingecko:ethereum' },
  arbitrum: { symbol: 'ETH', price: 'coingecko:ethereum' }, optimism: { symbol: 'ETH', price: 'coingecko:ethereum' },
  polygon: { symbol: 'POL', price: 'coingecko:polygon-ecosystem-token' }, bsc: { symbol: 'BNB', price: 'coingecko:binancecoin' },
};
// The real contracts of the tokens scammers copy most, per chain (lowercase).
const MAJOR = {
  ethereum: { USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7', WETH: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', DAI: '0x6b175474e89094c44da98b954eedeac495271d0f' },
  base: { USDC: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', WETH: '0x4200000000000000000000000000000000000006' },
  arbitrum: { USDC: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', USDT: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', WETH: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1' },
  optimism: { USDC: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', USDT: '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', WETH: '0x4200000000000000000000000000000000000006' },
  polygon: { USDC: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', USDT: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', WETH: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619' },
  bsc: { USDT: '0x55d398326f99059ff775485246999027b3197955', USDC: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', WETH: '0x2170ed0880ac9a755fd29b2688956bd959f933f8' },
};
const STABLE = new Set(['USDC', 'USDT', 'DAI', 'USDS', 'USDE', 'PYUSD', 'FDUSD', 'TUSD', 'USD1', 'GHO', 'FRAX', 'LUSD', 'USDC.E', 'USDBC']);
const ERC20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
const MAX_TOKENS = 150;
const DUST_USD = 0.01;

const r2 = v => Math.round(v * 100) / 100;
const PART_MS = 25000;
const within = (p, what) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took too long; open its desk to see it`)), module.exports.PART_MS).unref())]);

/* ── per chain: the tokens it has seen, what's there now ── */

async function chainHoldings(chain, wallet) {
  const notRead = [];
  const seen = new Map(); // address -> { symbol, name, decimals }
  for (const [symbol, address] of Object.entries(MAJOR[chain] || {})) seen.set(address, { symbol, name: symbol, decimals: null, major: true });
  try {
    const data = await explorer.explorerGet(chain, { module: 'account', action: 'tokentx', address: wallet, page: 1, offset: 1000, sort: 'desc' });
    const rows = Array.isArray(data?.result) ? data.result : [];
    const sent = new Set();
    for (const t of rows) if (String(t.from || '').toLowerCase() === wallet) sent.add(String(t.contractAddress || '').toLowerCase());
    for (const t of rows) {
      const a = String(t.contractAddress || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a) || seen.has(a) && seen.get(a).decimals !== null) continue;
      seen.set(a, { symbol: t.tokenSymbol || '?', name: t.tokenName || '', decimals: Number(t.tokenDecimal), major: seen.get(a)?.major || false, only_received: !sent.has(a) && rows.length < 1000 });
      if (seen.size >= MAX_TOKENS) break;
    }
    if (rows.length >= 1000) notRead.push({ chain, what: 'older token transfers', reason: 'only the 1,000 newest transfers were read; a token last moved before them may be missing' });
  } catch (err) {
    notRead.push({ chain, what: 'tokens beyond the major ones', reason: `the explorer didn't answer (${err.message})` });
  }
  const list = [...seen.entries()];
  const reads = await approvals.multicall(chain, list.map(([a]) => ({ target: a, iface: ERC20, fn: 'balanceOf', args: [wallet] })));
  const tokens = [];
  list.forEach(([address, meta], i) => {
    if (!reads[i]?.ok) return;
    const raw = BigInt(reads[i].value[0]);
    if (raw === 0n) return;
    tokens.push({ chain, address, ...meta, raw: raw.toString() });
  });
  let native = null;
  try {
    const wei = BigInt(await rpc.evmRpc(chain, 'eth_getBalance', [wallet, 'latest']));
    if (wei > 0n) native = { chain, symbol: NATIVE[chain].symbol, raw: wei.toString(), decimals: 18 };
  } catch (err) { notRead.push({ chain, what: `${NATIVE[chain].symbol} balance`, reason: err.message }); }
  return { chain, tokens, native, notRead };
}

/* ── facts on a holding ── */

function tokenSignals(h) {
  const out = [];
  const real = MAJOR[h.chain]?.[String(h.symbol).toUpperCase()];
  if (real && real !== h.address) out.push({ level: 'bad', text: `Named ${h.symbol} but isn't the real ${h.symbol} contract on ${CHAIN_NAMES[h.chain]}: a common scam airdrop. Don't approve, swap or send it.`, source: 'RektBull\'s list of major token contracts' });
  if (/https?:|www\.|\.(com|io|org|xyz|net|app|site|claims?)\b|t\.me\//i.test(`${h.symbol} ${h.name}`)) out.push({ level: 'bad', text: 'Its name carries a link: a known scam-airdrop pattern. Don\'t visit it.', source: 'The token\'s own name' });
  if (h.only_received && !real) out.push({ level: 'warn', text: 'Only ever sent to this wallet, never sent from it: often an unsolicited airdrop. Its price may not hold if you try to sell.', source: 'The explorer\'s transfer record' });
  if (h.price !== null && STABLE.has(String(h.symbol).toUpperCase()) && !(real && real !== h.address)) {
    const off = Math.abs(h.price - 1) * 100;
    if (off >= 2) out.push({ level: 'bad', text: `Off its peg by ${off.toFixed(1)}% (price $${h.price.toFixed(4)})`, source: 'DefiLlama price' });
    else if (off >= 0.5) out.push({ level: 'warn', text: `Off its peg by ${off.toFixed(2)}% (price $${h.price.toFixed(4)})`, source: 'DefiLlama price' });
  }
  return out;
}

/* ── the whole portfolio ── */

async function portfolio(walletIn) {
  const wallet = String(walletIn).toLowerCase();
  return cached(`portfolio:${wallet}`, 300, async () => {
    const [chainsR, positionsR, approvalsR] = await Promise.all([
      Promise.allSettled(CHAINS.map(c => chainHoldings(c, wallet))),
      within(require('../yield/positions').read(wallet), 'Reading DeFi positions').then(v => ({ ok: true, v }), err => ({ ok: false, err })),
      within(approvals.preview(wallet), 'The approval check').then(v => ({ ok: true, v }), err => ({ ok: false, err })),
    ]);
    const notRead = [];
    const held = [];
    chainsR.forEach((r, i) => {
      if (r.status === 'rejected') { notRead.push({ chain: CHAINS[i], what: 'everything', reason: r.reason.message }); return; }
      notRead.push(...r.value.notRead);
      held.push(...r.value.tokens.map(t => ({ ...t, kind: 'token' })));
      if (r.value.native) held.push({ ...r.value.native, kind: 'native', address: null, name: r.value.native.symbol });
    });
    // decimals for major tokens the explorer didn't describe
    const needDecimals = held.filter(h => h.kind === 'token' && !Number.isInteger(h.decimals)); // (null >= 0 is true in JS)
    if (needDecimals.length) {
      const DEC = new ethers.Interface(['function decimals() view returns (uint8)']);
      for (const chain of new Set(needDecimals.map(h => h.chain))) {
        const these = needDecimals.filter(h => h.chain === chain);
        const r = await approvals.multicall(chain, these.map(h => ({ target: h.address, iface: DEC, fn: 'decimals', args: [] }))).catch(() => []);
        these.forEach((h, i) => { h.decimals = r[i]?.ok ? Number(r[i].value[0]) : null; });
      }
    }
    const priceId = h => (h.kind === 'native' ? NATIVE[h.chain].price : `${h.chain}:${h.address}`);
    let priceMap = {};
    try { priceMap = await prices.usdPrices([...new Set(held.map(priceId))]); } catch (err) { notRead.push({ chain: null, what: 'prices', reason: `DefiLlama didn't answer (${err.message})` }); }
    const items = held.filter(h => Number.isInteger(h.decimals)).map(h => {
      const amount = Number(ethers.formatUnits(BigInt(h.raw), h.decimals));
      const price = priceMap[priceId(h)] ?? null;
      const item = {
        kind: h.kind, chain: h.chain, chain_name: CHAIN_NAMES[h.chain], symbol: h.symbol, name: h.name, address: h.address,
        amount, price, usd: price === null ? null : r2(amount * price), only_received: !!h.only_received,
      };
      item.signals = h.kind === 'token' ? tokenSignals(item) : [];
      item.check = h.kind === 'token' ? `/safety?chain=${h.chain}&token=${h.address}` : null;
      return item;
    });
    const priced = items.filter(i => i.usd !== null && i.usd >= DUST_USD && !i.signals.some(s => s.level === 'bad' && /real .* contract/.test(s.text))).sort((a, b) => b.usd - a.usd);
    const unpriced = items.filter(i => !priced.includes(i) && !(i.usd !== null && i.usd < DUST_USD));
    const positions = positionsR.ok ? positionsR.v.positions.map(p => ({ kind: 'position', chain: p.chain, chain_name: CHAIN_NAMES[p.chain], protocol: p.name, symbol: p.asset, amount: Number(p.amount), usd: p.usd, signals: p.status === 'open' ? [] : [{ level: 'warn', text: `${p.name} is ${p.status} on RektBull's yield desk`, source: 'RektBull yield desk' }] })) : [];
    if (!positionsR.ok) notRead.push({ chain: null, what: 'DeFi positions (Aave, Compound, Spark)', reason: positionsR.err.message });
    else notRead.push(...positionsR.v.not_read.filter(n => n.what !== 'ETH for gas').map(n => ({ chain: n.chain, what: n.what, reason: n.reason })));
    const tokensUsd = priced.reduce((t, i) => t + i.usd, 0);
    const defiUsd = positions.reduce((t, p) => t + (p.usd || 0), 0);
    const total = tokensUsd + defiUsd;
    const stableUsd = priced.filter(i => STABLE.has(String(i.symbol).toUpperCase())).reduce((t, i) => t + i.usd, 0) + positions.filter(p => STABLE.has(String(p.symbol).toUpperCase())).reduce((t, p) => t + (p.usd || 0), 0);
    const byChain = CHAINS.map(c => ({ chain: c, chain_name: CHAIN_NAMES[c], usd: r2(priced.filter(i => i.chain === c).reduce((t, i) => t + i.usd, 0) + positions.filter(p => p.chain === c).reduce((t, p) => t + (p.usd || 0), 0)) })).filter(c => c.usd > 0).sort((a, b) => b.usd - a.usd);
    for (const i of priced) i.share_pct = total > 0 ? r2(i.usd / total * 100) : null;
    const risk = approvalsR.ok ? { to_revoke: approvalsR.v.summary.to_revoke, open: approvalsR.v.summary.open, value_at_risk_usd: approvalsR.v.summary.value_at_risk_usd, href: `/safety?wallet=${wallet}#approvals-card` } : null;
    if (!approvalsR.ok) notRead.push({ chain: null, what: 'approvals', reason: approvalsR.err.message });
    const flagged = [...priced, ...unpriced].filter(i => i.signals.some(s => s.level === 'bad')).length;
    return {
      wallet, read_at: new Date().toISOString(),
      total_usd: r2(total), tokens_usd: r2(tokensUsd), defi_usd: r2(defiUsd), stable_pct: total > 0 ? r2(stableUsd / total * 100) : null,
      by_chain: byChain, holdings: priced, positions, unpriced, risk, flagged,
      not_read: notRead,
      sources: ['Token transfers from the chain explorers (which tokens the wallet has had); balances read onchain now (Multicall3)', 'Prices from DefiLlama', 'DeFi positions read onchain (Aave v3, Compound v3, Spark)', 'Approvals: RektBull\'s approval check'],
      note: 'Values are at DefiLlama\'s current prices; a token it doesn\'t price is listed as not priced, never valued by guess. Tokens you didn\'t buy are often scam airdrops: don\'t approve, swap or visit links in their names.',
    };
  });
}

module.exports = { portfolio, chainHoldings, tokenSignals, MAJOR, CHAINS, PART_MS };
