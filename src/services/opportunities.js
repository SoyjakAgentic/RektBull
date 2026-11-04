/**
 * Opportunities: where a wallet could gain something. This adds the live
 * incentive campaigns (Merkl: pools and protocols paying extra rewards now);
 * claims, yield and DAO votes are the Find money and Governance desks, and a
 * wallet's own opportunities come from Home's checkup.
 *
 * Each campaign carries the facts that say what it would cost to take part:
 * the protocol's record from DefiLlama (hacks, audits, age), the risk its
 * action carries (borrowing can be liquidated, liquidity can lose to price
 * moves), whether Merkl verified the reward token, and when rewards end.
 * The reward rate is Merkl's, on top of the pool's own yield, and changes as
 * money comes in. Nothing here is a recommendation.
 */
const merkl = require('../providers/merkl');
const llama = require('../providers/llama');
const discover = require('./discover');

class OpportunitiesRefused extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}

const CHAIN_NAMES = { ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon', bsc: 'BNB Chain' };
const ACTIONS = {
  LEND: { label: 'Lend', risk: null },
  BORROW: { label: 'Borrow', risk: 'Borrowing: if your collateral falls in value, it can be sold (liquidated)' },
  POOL: { label: 'Provide liquidity', risk: 'Providing liquidity: price moves between the two tokens can leave you with less than holding them' },
  HOLD: { label: 'Hold', risk: null },
  STAKE: { label: 'Stake', risk: null },
  DROP: { label: 'Airdrop campaign', risk: null },
};
const SORTS = ['tvl', 'apr', 'ending'];
const MIN_TVL = 50000; // below this a rate is noise: a few dollars of rewards on almost nothing
const DAY = 86400000;

function parseCampaigns(q = {}) {
  const chain = q.chain || null;
  if (chain && !CHAIN_NAMES[chain]) return { error: `chain must be one of ${Object.keys(CHAIN_NAMES).join(', ')}` };
  const action = q.action ? String(q.action).toUpperCase() : null;
  if (action && !ACTIONS[action]) return { error: `action must be one of ${Object.keys(ACTIONS).map(a => a.toLowerCase()).join(', ')}` };
  const sort = q.sort || 'tvl';
  if (!SORTS.includes(sort)) return { error: `sort must be one of ${SORTS.join(', ')}` };
  const limit = q.limit === undefined ? 40 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { error: 'limit must be 1 to 100' };
  return { chain, action, sort, limit };
}

/** The facts for one campaign, each with its source. */
function campaignSignals(c, protocol, hackList, now = Date.now()) {
  const out = [];
  if (protocol) out.push(...discover.dappSignals(protocol, hackList, now).map(s => ({ ...s, text: `${c.protocol.name}: ${s.text}` })));
  else out.push({ level: 'warn', text: `${c.protocol?.name || 'The protocol'} isn't listed on DefiLlama: no hack or audit record to show`, source: 'DefiLlama' });
  const risk = ACTIONS[c.action]?.risk;
  if (risk) out.push({ level: 'warn', text: risk, source: 'What this action does' });
  const unverified = c.rewards.filter(r => !r.verified);
  if (unverified.length) out.push({ level: 'warn', text: `Reward token${unverified.length > 1 ? 's' : ''} not verified by Merkl: ${unverified.map(r => r.symbol).join(', ')}`, source: 'Merkl' });
  if (c.ends_at) {
    const d = (Date.parse(c.ends_at) - now) / DAY;
    if (d < 3) out.push({ level: 'warn', text: d < 1 ? 'Rewards end within a day' : `Rewards end in ${Math.ceil(d)} day${Math.ceil(d) === 1 ? "" : "s"}`, source: 'Merkl' });
  }
  return out;
}

async function campaigns({ chain = null, action = null, sort = 'tvl', limit = 40 } = {}) {
  const chains = chain ? [chain] : Object.keys(CHAIN_NAMES);
  const [lists, protos, hacks] = await Promise.all([
    Promise.allSettled(chains.map(c => merkl.live(c))),
    llama.protocols().catch(() => null),
    llama.hacks().catch(() => null),
  ]);
  const notChecked = [];
  lists.forEach((r, i) => { if (r.status === 'rejected') notChecked.push({ check: `campaigns on ${CHAIN_NAMES[chains[i]]}`, reason: r.reason.message }); });
  if (!lists.some(r => r.status === 'fulfilled')) throw new OpportunitiesRefused(`Merkl didn't answer (${notChecked[0]?.reason}). Try again in a minute.`);
  if (!protos) notChecked.push({ check: 'protocol records (hacks, audits)', reason: 'DefiLlama didn\'t answer' });
  const bySlug = new Map((protos || []).map(p => [p.slug, p]));
  const now = Date.now();
  const rows = lists.flatMap(r => (r.status === 'fulfilled' ? r.value : []))
    .filter(c => c.tvl_usd >= MIN_TVL && c.apr_pct > 0 && ACTIONS[c.action] && !c.rewards.some(t => t.test))
    .filter(c => !action || c.action === action)
    .filter(c => !c.ends_at || Date.parse(c.ends_at) > now)
    .map(c => {
      const p = c.protocol?.defillama_slug ? bySlug.get(c.protocol.defillama_slug) : null;
      return {
        ...c, chain_name: CHAIN_NAMES[c.chain], action_label: ACTIONS[c.action].label,
        apr_pct: Math.round(c.apr_pct * 100) / 100, tvl_usd: Math.round(c.tvl_usd),
        daily_rewards_usd: c.daily_rewards_usd === null ? null : Math.round(c.daily_rewards_usd),
        signals: campaignSignals(c, p, p && hacks ? hacks[p.id] || [] : [], now),
        checks: c.rewards.filter(t => /^0x[0-9a-f]{40}$/.test(t.address)).map(t => ({ symbol: t.symbol, href: `/safety?chain=${c.chain}&token=${t.address}` })),
        go: c.deposit_url || c.protocol?.url || null,
      };
    });
  const key = { tvl: r => r.tvl_usd, apr: r => r.apr_pct, ending: r => -(r.ends_at ? Date.parse(r.ends_at) : Infinity) }[sort];
  rows.sort((a, b) => key(b) - key(a));
  return {
    chain, action, sort, total: rows.length, campaigns: rows.slice(0, limit),
    actions: Object.entries(ACTIONS).map(([id, a]) => ({ id: id.toLowerCase(), label: a.label })),
    not_checked: notChecked,
    sources: ['Merkl (live campaigns: rate, money in it, rewards, end date)', 'DefiLlama (the protocol\'s hacks, audits and age)'],
    note: `The rate is Merkl's extra rewards, on top of the pool's own yield, and falls as more money comes in. Campaigns with under $${MIN_TVL / 1000}K in them aren't listed. Rewards you earn show up in Find money, ready to claim. Not a recommendation.`,
  };
}

module.exports = { campaigns, parseCampaigns, campaignSignals, ACTIONS, OpportunitiesRefused, MIN_TVL };
