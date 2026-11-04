/**
 * Markets: the state of DeFi in a few numbers, stablecoins with whether each
 * is holding its peg, and the largest tokens. Real-world assets and
 * prediction markets are Discover's rankings for those categories (the page
 * asks /v1/discover/dapps for them), so they carry the same safety facts.
 *
 * Every figure names its source; a part that couldn't be read is listed, not
 * left blank or guessed. Nothing here is a recommendation.
 */
const llama = require('../providers/llama');
const coingecko = require('../providers/coingecko');

class MarketsRefused extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}

const pctChange = (now, before) => (before > 0 && now !== null ? Math.round((now / before - 1) * 1000) / 10 : null);
const r2 = v => (v === null || v === undefined ? null : Math.round(v * 100) / 100);

/* ── the overview ── */

async function overview() {
  const [hist, dex, fees, stables] = await Promise.allSettled([llama.tvlHistory(), llama.dexVolume(), llama.fees(), llama.stablecoins()]);
  const notChecked = [];
  const part = (r, what) => { if (r.status === 'fulfilled') return r.value; notChecked.push({ check: what, reason: r.reason.message }); return null; };
  const h = part(hist, 'total value locked');
  const d = part(dex, 'DEX volume');
  const f = part(fees, 'fees');
  const s = part(stables, 'stablecoin supply');
  if (!h && !d && !f && !s) throw new MarketsRefused('DefiLlama didn\'t answer. Try again in a minute.');
  const at = daysAgo => (h && h.length > daysAgo ? h[h.length - 1 - daysAgo].tvl : null);
  const usd = s ? s.filter(x => x.peg === 'USD') : null;
  const supply = usd ? usd.reduce((t, x) => t + x.supply, 0) : null;
  const supplyWeek = usd ? usd.reduce((t, x) => t + (x.supply_prev_week || x.supply), 0) : null;
  return {
    tvl: h ? { usd: at(0), as_of: h[h.length - 1].date, change_7d_pct: pctChange(at(0), at(7)), change_30d_pct: pctChange(at(0), at(30)), history: h.slice(-90) } : null,
    dex_volume: d ? { usd_24h: d.total_24h, change_1d_pct: r2(d.change_1d) } : null,
    fees: f ? { usd_24h: f.total_24h, change_1d_pct: r2(f.change_1d) } : null,
    stablecoins: usd ? { usd: Math.round(supply), change_7d_pct: pctChange(supply, supplyWeek), count: usd.length } : null,
    not_checked: notChecked,
    sources: { tvl: 'DefiLlama (total value locked in DeFi, daily)', dex_volume: 'DefiLlama DEX volumes', fees: 'DefiLlama fees', stablecoins: 'DefiLlama stablecoins (US dollar stablecoins)' },
  };
}

/* ── stablecoins ── */

/** What the facts say about one US dollar stablecoin, each with its source. */
function stableSignals(c) {
  const out = [];
  const src = 'DefiLlama stablecoins';
  if (c.price === null) out.push({ level: 'warn', text: 'No price recorded, so its peg can\'t be checked', source: src });
  else {
    const off = Math.abs(c.price - 1) * 100;
    if (off >= 2) out.push({ level: 'bad', text: `Off its peg by ${off.toFixed(1)}% (price $${c.price.toFixed(4)})`, source: src });
    else if (off >= 0.5) out.push({ level: 'warn', text: `Off its peg by ${off.toFixed(2)}% (price $${c.price.toFixed(4)})`, source: src });
  }
  if (c.mechanism === 'algorithmic') out.push({ level: 'warn', text: 'Algorithmic: its peg rests on a mechanism, not on reserves', source: src });
  const week = pctChange(c.supply, c.supply_prev_week);
  if (week !== null && week <= -10) out.push({ level: 'warn', text: `Supply down ${Math.round(-week)}% in a week (holders redeeming or leaving)`, source: src });
  if (!out.length) out.push({ level: 'ok', text: `On its peg (price $${c.price.toFixed(4)})`, source: src });
  return out;
}

async function stablecoinList({ limit = 30 } = {}) {
  let all;
  try { all = await llama.stablecoins(); } catch (err) { throw new MarketsRefused(`DefiLlama didn't answer (${err.message}). Try again in a minute.`); }
  const usd = all.filter(c => c.peg === 'USD').sort((a, b) => b.supply - a.supply);
  const total = usd.reduce((t, c) => t + c.supply, 0);
  const byMechanism = {};
  for (const c of usd) byMechanism[c.mechanism || 'unknown'] = (byMechanism[c.mechanism || 'unknown'] || 0) + c.supply;
  return {
    total_usd: Math.round(total),
    by_mechanism: Object.entries(byMechanism).sort((a, b) => b[1] - a[1]).map(([mechanism, v]) => ({ mechanism, usd: Math.round(v), share_pct: r2(v / total * 100) })),
    stablecoins: usd.slice(0, limit).map(c => ({
      name: c.name, symbol: c.symbol, mechanism: c.mechanism, price: c.price,
      peg_off_pct: c.price === null ? null : r2((c.price - 1) * 100),
      supply_usd: Math.round(c.supply), share_pct: r2(c.supply / total * 100),
      change_7d_pct: pctChange(c.supply, c.supply_prev_week), change_30d_pct: pctChange(c.supply, c.supply_prev_month),
      chains: c.chains, signals: stableSignals(c),
    })),
    source: 'DefiLlama stablecoins (supply, peg mechanism, price)',
    note: 'Holding its peg today says nothing about the reserves behind it. The risk monitor (Safety Pro) alerts you if a stablecoin you hold loses its peg.',
  };
}

/* ── tokens ── */

async function tokens({ limit = 50 } = {}) {
  let rows;
  try { rows = await coingecko.topTokens(); } catch (err) {
    throw new MarketsRefused(`CoinGecko didn't answer (${err.response?.status === 429 ? 'its free plan is busy' : err.message}). Try again in a minute.`);
  }
  return {
    tokens: rows.slice(0, limit).map(t => ({
      ...t,
      signals: t.from_ath_pct !== null && t.from_ath_pct <= -80 ? [{ level: 'warn', text: `${Math.round(-t.from_ath_pct)}% below its high (${t.ath_date})`, source: 'CoinGecko' }] : [],
      link: `https://www.coingecko.com/en/coins/${encodeURIComponent(t.id)}`,
    })),
    source: 'Data from CoinGecko (market cap, price, volume; refreshed every 10 minutes)',
    note: 'Market cap is size, not safety. Check a token\'s contract before you buy it.',
  };
}

module.exports = { overview, stablecoinList, tokens, stableSignals, MarketsRefused };
