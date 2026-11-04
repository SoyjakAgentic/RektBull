/**
 * Agents: the onchain AI-agent protocols (DefiLlama's "AI Agents" category,
 * with each one's hack and audit record), and the paid APIs agents can call
 * per request with x402 (Coinbase's x402 Bazaar), ranked by how many
 * different payers used them in 30 days, with what the numbers suggest.
 *
 * Nothing here is an endorsement: a listing is what its maker says, and
 * RektBull hasn't tested any of these services. What RektBull adds are the
 * signals: usage that looks self-generated, few users, no recent calls,
 * plain-http endpoints, and a payment address GoPlus flags.
 */
const bazaar = require('../providers/x402bazaar');
const goplus = require('../providers/goplus');
const discover = require('./discover');

class AgentsRefused extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const BAZAAR = 'Coinbase x402 Bazaar (30-day usage from Coinbase)';
const MIN_PAYERS = 5; // below this a listing is noise: most of the Bazaar is never called
const DAY = 86400000;
const EVM_GOPLUS = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bsc'];

/* ── input ── */

function parseX402(q = {}) {
  const network = q.network ? String(q.network).toLowerCase() : null;
  if (network && !/^[a-z0-9:_-]{2,64}$/.test(network)) return { error: 'network must be a network name, e.g. base or solana' };
  const query = q.q ? String(q.q).trim().toLowerCase().slice(0, 60) : null;
  const limit = q.limit === undefined ? 40 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { error: 'limit must be 1 to 100' };
  return { network, query, limit };
}

function parseProtocols(q = {}) {
  const sort = q.sort || 'tvl';
  if (!['tvl', 'fees', 'change_7d'].includes(sort)) return { error: 'sort must be tvl, fees or change_7d' };
  return { sort };
}

/* ── the x402 services ── */

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** Endpoints grouped into services: one per host. */
function group(endpoints) {
  const byHost = new Map();
  for (const e of endpoints) {
    if (!byHost.has(e.host)) byHost.set(e.host, []);
    byHost.get(e.host).push(e);
  }
  return [...byHost.entries()].map(([host, list]) => {
    list.sort((a, b) => b.payers_30d - a.payers_30d || b.calls_30d - a.calls_30d);
    const names = list.map(e => e.service).filter(Boolean);
    const name = names.sort((a, b) => names.filter(x => x === b).length - names.filter(x => x === a).length)[0] || host;
    const prices = list.map(e => e.price_usd).filter(p => p !== null);
    const last = list.map(e => e.last_called_at).filter(Boolean).sort().pop() || null;
    const payTo = new Map();
    for (const e of list) for (const [addr, net] of Object.entries(e.pay_to_networks)) payTo.set(addr, net);
    return {
      host, name,
      description: list.find(e => e.description)?.description || null,
      tags: [...new Set(list.flatMap(e => e.tags))].slice(0, 6),
      networks: [...new Set(list.flatMap(e => e.network_names))],
      network_ids: [...new Set(list.flatMap(e => e.networks))],
      price_usd: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
      endpoints: list.length,
      examples: list.slice(0, 3).map(e => ({ url: e.url, method: e.method, description: e.description, price_usd: e.price_usd })),
      calls_30d: list.reduce((t, e) => t + e.calls_30d, 0),
      payers_30d: Math.max(...list.map(e => e.payers_30d)), // per endpoint; the same payer may use several, so the largest is the floor
      busiest: { url: list[0].url, calls_30d: list[0].calls_30d, payers_30d: list[0].payers_30d },
      last_called_at: last,
      pay_to: [...payTo.entries()].map(([address, network]) => ({ address, network })),
      plain_http: list.some(e => !e.secure),
    };
  });
}

/** What the numbers suggest about one service, each with its source. */
function serviceSignals(s, now = Date.now()) {
  const out = [];
  // Judged on the busiest endpoint: a service's other endpoints can hide the pattern in its totals.
  const b = s.busiest || s;
  if (b.payers_30d >= 50 && b.calls_30d / b.payers_30d < 1.3) {
    out.push({ level: 'warn', text: `${s.endpoints > 1 ? 'Its busiest endpoint had ' : ''}${plural(b.calls_30d, 'call')} from ${plural(b.payers_30d, 'different payer')} in 30 days, about one each. Real users usually come back, so some of this traffic may be generated to look busy`, source: BAZAAR });
  }
  if (s.payers_30d < 20) out.push({ level: 'info', text: `Few users: ${plural(s.payers_30d, 'payer')} in 30 days`, source: BAZAAR });
  if (s.last_called_at) {
    const days = Math.floor((now - new Date(s.last_called_at)) / DAY);
    if (days >= 14) out.push({ level: 'warn', text: `No calls in ${days} days`, source: BAZAAR });
  }
  if (s.plain_http) out.push({ level: 'warn', text: 'Some endpoints use plain http: requests and answers can be read or changed on the way', source: 'The listing' });
  return out;
}

/** GoPlus on each EVM payment address of the services shown. Flags become 'bad' signals; failures are named. */
async function checkPayTo(services) {
  const notChecked = [];
  const jobs = [];
  for (const s of services) {
    for (const p of s.pay_to) {
      if (!EVM_GOPLUS.includes(p.network) || !/^0x[0-9a-fA-F]{40}$/.test(p.address)) continue;
      jobs.push(goplus.addressRisk(p.network, p.address.toLowerCase()).then(r => {
        if (r.not_checked) return;
        if (r.flags.length) s.signals.unshift({ level: 'bad', text: `GoPlus flags the address it's paid to (${p.address.slice(0, 6)}…${p.address.slice(-4)} on ${p.network}): ${r.flags.join(', ')}`, source: r.source });
      }).catch(err => { notChecked.push(err.message); }));
    }
  }
  await Promise.all(jobs);
  return notChecked.length ? [{ check: 'payment addresses (GoPlus)', reason: `${plural(notChecked.length, 'check')} couldn't run: ${notChecked[0]}` }] : [];
}

async function x402Services({ network = null, query = null, limit = 40 } = {}, now = Date.now()) {
  let l;
  try { l = await bazaar.listing(); } catch (err) { throw new AgentsRefused(`The x402 Bazaar didn't answer (${err.message}). Try again in a minute.`, 503); }
  const all = group(l.endpoints).filter(s => s.payers_30d >= MIN_PAYERS);
  const networks = [...new Set(all.flatMap(s => s.network_ids))];
  const matches = all.filter(s => (!network || s.network_ids.includes(network))
    && (!query || [s.name, s.host, s.description, ...s.tags].some(t => String(t || '').toLowerCase().includes(query))));
  matches.sort((a, b) => b.payers_30d - a.payers_30d || b.calls_30d - a.calls_30d);
  const shown = matches.slice(0, limit).map(s => ({ ...s, signals: serviceSignals(s, now), check_pay_to: s.pay_to.filter(p => /^0x[0-9a-fA-F]{40}$/.test(p.address)).map(p => `/?q=${p.address}`) }));
  const notChecked = await checkPayTo(shown);
  return {
    network, query, total: matches.length, services: shown,
    networks: networks.sort(),
    read: { endpoints: l.read, listed: l.listed_total, at: l.read_at },
    not_checked: notChecked,
    source: BAZAAR,
    note: `Services as their makers list them; RektBull hasn't tested any. Ranked by different payers in 30 days, from the ${l.read.toLocaleString('en-US')} busiest of ${(l.listed_total || 0).toLocaleString('en-US')} listed endpoints; services with fewer than ${MIN_PAYERS} payers are left out. Usage is Coinbase's count.`,
  };
}

/* ── the AI agent protocols ── */

async function protocols({ sort = 'tvl' } = {}) {
  const r = await discover.dapps({ category: 'AI Agents', sort, limit: 100 });
  return { sort, total: r.total, protocols: r.dapps, not_checked: r.not_checked, sources: r.sources, note: `Onchain AI-agent protocols as DefiLlama lists them (category "AI Agents"). ${r.note}` };
}

module.exports = { parseX402, parseProtocols, x402Services, protocols, group, serviceSignals, AgentsRefused, MIN_PAYERS };
