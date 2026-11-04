/**
 * Merkl's live incentive campaigns: pools and protocols paying extra rewards
 * right now, on each RektBull chain. Free and keyless; the top 100 per chain
 * by money in them, cut to what Opportunities shows and cached 15 minutes
 * (6 chains: about 600 calls a day whatever the traffic).
 */
const axios = require('axios');
const { EVM } = require('./chains');
const { track } = require('./usage');
const { cached } = require('../lib/cache');

const API = 'https://api.merkl.xyz/v4';

function campaign(o, chain) {
  const rewards = (o.rewardsRecord?.breakdowns || []).map(b => b.token).filter(Boolean);
  return {
    id: String(o.id), chain, name: o.name, action: o.action, type: o.type,
    started_at: o.lastCampaignCreatedAt ? new Date(Number(o.lastCampaignCreatedAt) * 1000).toISOString() : null,
    apr_pct: typeof o.apr === 'number' ? o.apr : null,
    tvl_usd: typeof o.tvl === 'number' ? o.tvl : null,
    daily_rewards_usd: typeof o.dailyRewards === 'number' ? o.dailyRewards : null,
    ends_at: o.latestCampaignEnd ? new Date(Number(o.latestCampaignEnd) * 1000).toISOString() : null,
    how: (o.howToSteps || []).slice(0, 3),
    deposit_url: (o.depositUrls || [])[0] || null,
    protocol: o.protocol ? { id: o.protocol.id, name: o.protocol.name, url: o.protocol.url || null, defillama_slug: o.protocol.trustData?.slug || null } : null,
    tokens: (o.tokens || []).map(t => ({ symbol: t.displaySymbol || t.symbol, address: String(t.address || '').toLowerCase() })),
    rewards: [...new Map(rewards.map(t => [String(t.address).toLowerCase(), {
      symbol: t.displaySymbol || t.symbol, address: String(t.address).toLowerCase(), verified: t.verified === true, test: t.isTest === true,
    }])).values()],
  };
}

/** Live campaigns on one chain. */
function live(chain) {
  const chainId = EVM[chain]?.chainId;
  if (!chainId) throw new Error(`Merkl isn't read on ${chain}`);
  return cached(`merkl:live:${chain}`, 900, async () => {
    const rows = await track('merkl', async () => (await axios.get(`${API}/opportunities`, {
      params: { chainId, status: 'LIVE', items: 100, sort: 'tvl', order: 'desc' }, timeout: 20000,
    })).data);
    return (Array.isArray(rows) ? rows : []).map(o => campaign(o, chain));
  });
}

module.exports = { live, CHAINS: Object.keys(EVM) };
