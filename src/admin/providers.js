/**
 * External services as the admin panel sees them: calls today against the
 * free plan, errors and the last one, whether a key is set (never the key),
 * a switch, a daily limit, and a "test now" call.
 *
 * Keys stay in Google Secret Manager: nothing here reads a key's value, and
 * nothing can set one. Switching a service off makes its callers refuse it
 * exactly as if its free plan were used up, so the fallback, where there is
 * one, takes over (an explorer, an RPC endpoint, a price source).
 */
const axios = require('axios');
const db = require('../config/db');
const env = require('../config/env');
const settings = require('./settings');
const usage = require('../providers/usage');

const set = name => !!String(process.env[name] || '').trim();

/**
 * Each service: what it's for, the settings that hold its key (shown as set or
 * not), its fallback, and a cheap test call where one exists. Services seen in
 * provider_usage but not listed here (rpc:<host>) are shown too.
 */
const KNOWN = {
  claude: { what: 'AI reports and summaries (Anthropic)', keys: ['ANTHROPIC_API_KEY'], fallback: 'None: AI runs are refused, never charged', budget: true,
    test: () => require('../ai/claude').ping() },
  etherscan: { what: 'Block explorer (contracts, transfers), all EVM chains', keys: ['ETHERSCAN_API_KEY'], fallback: 'Blockscout',
    test: () => require('../providers/explorer').explorerGet('ethereum', { module: 'proxy', action: 'eth_blockNumber' }) },
  blockscout: { what: 'Block explorer (paid key)', keys: ['BLOCKSCOUT_API_KEY'], fallback: 'Blockscout\'s public instances' },
  'blockscout-public': { what: 'Block explorer, public instances', keys: [], fallback: 'None' },
  rpc: { what: 'Chain nodes (RPC_URLS_<CHAIN>, then each chain\'s public endpoint)', keys: ['RPC_URLS_ETHEREUM', 'RPC_URLS_BASE'], fallback: 'The next endpoint, then the public one',
    test: () => require('../providers/rpc').evmRpc('base', 'eth_blockNumber', []) },
  defillama: { what: 'Protocols, prices, yields, hacks, stablecoins', keys: [], fallback: 'None for most; prices fall back to CoinGecko',
    test: () => usage.track('defillama', () => axios.get('https://api.llama.fi/protocols', { timeout: 10000, responseType: 'stream' }).then(r => r.data.destroy())) },
  coingecko: { what: 'Markets: coin prices and rankings', keys: [], fallback: 'DefiLlama prices',
    test: () => usage.track('coingecko', () => axios.get('https://api.coingecko.com/api/v3/ping', { timeout: 10000 })) },
  dexscreener: { what: 'Token pairs and liquidity', keys: [], fallback: 'GeckoTerminal',
    test: () => usage.track('dexscreener', () => axios.get('https://api.dexscreener.com/latest/dex/tokens/0x4200000000000000000000000000000000000006', { timeout: 10000 })) },
  geckoterminal: { what: 'New pools and trending tokens', keys: [], fallback: 'DexScreener',
    test: () => usage.track('geckoterminal', () => axios.get('https://api.geckoterminal.com/api/v2/networks?page=1', { timeout: 10000 })) },
  goplus: { what: 'Token and address security flags', keys: [], fallback: 'RektBull\'s own checks only, and the report says GoPlus couldn\'t be read' },
  '0x': { what: 'Swap quotes, sell simulation (taxes), the Trade desk', keys: ['ZEROEX_API_KEY'], fallback: 'None for quotes' },
  jupiter: { what: 'Solana swap quotes', keys: ['JUPITER_API_KEY'], fallback: 'None' },
  merkl: { what: 'Reward campaigns and claims', keys: [], fallback: 'None',
    test: () => usage.track('merkl', () => axios.get('https://api.merkl.xyz/v4/chains', { timeout: 10000 })) },
  snapshot: { what: 'DAO proposals and votes', keys: [], fallback: 'None',
    test: () => usage.track('snapshot', () => axios.post('https://hub.snapshot.org/graphql', { query: '{ spaces(first: 1) { id } }' }, { timeout: 10000 })) },
  'snapshot-sequencer': { what: 'Sending signed Snapshot votes', keys: [], fallback: 'None' },
  openchain: { what: 'Function and error names for the pre-sign check', keys: [], fallback: 'The raw selector is shown' },
  'github-raw': { what: 'Solidity\'s known compiler bugs (Contract Audit)', keys: [], fallback: 'The audit says the bug list couldn\'t be read' },
  analyzer: { what: 'Slither, in RektBull\'s own analyzer service (Contract Audit)', keys: ['ANALYZER_URL'], fallback: 'None: audits are refused, never charged',
    test: async () => {
      const ca = require('../services/contractAudit');
      const url = ca.analyzerUrl();
      if (!url) throw new Error('ANALYZER_URL is not set');
      await usage.track('analyzer', async () => { const r = await axios.get(`${url}/healthz`, { headers: await ca.authHeaders(url), timeout: 15000, validateStatus: () => true }); if (r.status !== 200) throw new Error(`answered ${r.status}`); });
    } },
  telegram: { what: 'The bot: alerts, Group Guard, Channel Poster', keys: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'], fallback: 'None; alerts are retried',
    test: () => require('../providers/telegramBot').call('getMe', {}) },
  resend: { what: 'Email alerts and the newsletter', keys: ['RESEND_API_KEY'], fallback: 'None; alerts are retried' },
  webpush: { what: 'Browser notifications', keys: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'], fallback: 'None; alerts are retried' },
  nowpayments: { what: 'Hosted crypto checkout', keys: ['NOWPAYMENTS_API_KEY', 'NOWPAYMENTS_IPN_SECRET'], fallback: 'Paying to a deposit address',
    test: () => usage.track('nowpayments', () => axios.get(`${String(env.nowpaymentsApiBase || 'https://api.nowpayments.io/v1').replace(/\/+$/, '')}/status`, { timeout: 10000 })) },
  x402_bazaar: { what: 'The x402 services directory (AI agents page)', keys: [], fallback: 'None' },
  indexnow: { what: 'Telling search engines about new pages', keys: ['INDEXNOW_KEY'], fallback: 'None; search engines find pages anyway' },
  'airdrop-tree': { what: 'Airdrop claim lists RektBull adds', keys: [], fallback: 'None' },
};

const family = name => (KNOWN[name] ? name : name.split(':')[0]);

/** Every service with today's numbers and what an admin set. */
async function list() {
  const { rows } = env.databaseUrl ? await db.query(
    `SELECT provider, sum(calls)::int AS calls_7d, sum(errors)::int AS errors_7d,
            sum(calls) FILTER (WHERE day = current_date)::int AS calls_today, sum(errors) FILTER (WHERE day = current_date)::int AS errors_today,
            max(last_call_at) AS last_call_at, max(last_error_at) AS last_error_at,
            (array_agg(last_error ORDER BY last_error_at DESC NULLS LAST))[1] AS last_error
       FROM provider_usage WHERE day > current_date - 7 GROUP BY provider`) : { rows: [] };
  const seen = Object.fromEntries(rows.map(r => [r.provider, r]));
  const names = [...new Set([...Object.keys(KNOWN), ...Object.keys(seen)])];
  const aiToday = env.databaseUrl ? (await require('../ai/claude').usageReport(1)).reduce((s, r) => s + (r.estimated_usd || 0), 0) : 0;
  return names.map(name => {
    const k = KNOWN[family(name)] || {};
    const u = seen[name] || {};
    const admin = settings.get(`provider:${name}`) || {};
    return {
      name, family: family(name), what: k.what || 'Seen in the usage records',
      keys: (k.keys || []).map(key => ({ name: key, set: set(key) })),
      fallback: k.fallback || null, can_test: !!k.test, budget: !!k.budget,
      calls_today: u.calls_today || 0, errors_today: u.errors_today || 0, calls_7d: u.calls_7d || 0, errors_7d: u.errors_7d || 0,
      last_call_at: u.last_call_at || null, last_error_at: u.last_error_at || null, last_error: u.last_error || null,
      limit: usage.limitFor(name) || null, env_limit: env.providerDailyLimits[name] || null,
      off: !!admin.off, daily_limit: admin.daily_limit ?? null,
      ...(k.budget ? { daily_usd: admin.daily_usd ?? null, spent_today_usd: Math.round(aiToday * 100) / 100 } : {}),
    };
  }).sort((a, b) => (b.calls_7d - a.calls_7d) || a.name.localeCompare(b.name));
}

/** Checks an admin's change to a service: { off?, daily_limit?, daily_usd? }; null clears a value. */
function check(name, input) {
  const known = !!KNOWN[family(name)];
  if (!known && !/^rpc:[a-z0-9.-]+$/i.test(name)) throw Object.assign(new Error('No such service.'), { status: 404 });
  const cur = { ...(settings.get(`provider:${name}`) || {}) };
  if ('off' in input) { if (typeof input.off !== 'boolean') throw Object.assign(new Error('off must be true or false.'), { status: 400 }); if (input.off) cur.off = true; else delete cur.off; }
  if ('daily_limit' in input) {
    if (input.daily_limit === null) delete cur.daily_limit;
    else if (!Number.isInteger(input.daily_limit) || input.daily_limit < 1 || input.daily_limit > 10000000) throw Object.assign(new Error('daily_limit must be a whole number of calls from 1 to 10,000,000, or null for the setting\'s.'), { status: 400 });
    else cur.daily_limit = input.daily_limit;
  }
  if ('daily_usd' in input) {
    if (!KNOWN[family(name)]?.budget) throw Object.assign(new Error('Only Claude has a daily budget.'), { status: 400 });
    if (input.daily_usd === null) delete cur.daily_usd;
    else if (!(typeof input.daily_usd === 'number' && input.daily_usd >= 1 && input.daily_usd <= 10000)) throw Object.assign(new Error('daily_usd must be from 1 to 10,000, or null for no budget.'), { status: 400 });
    else cur.daily_usd = Math.round(input.daily_usd * 100) / 100;
  }
  return Object.keys(cur).length ? cur : null;
}

/** One test call, counted like any other. Returns { ok, ms, error? }. */
async function test(name) {
  const k = KNOWN[family(name)];
  if (!k) throw Object.assign(new Error('No such service.'), { status: 404 });
  if (!k.test) throw Object.assign(new Error(`${name} has no test call; its numbers above come from real use.`), { status: 400 });
  const t0 = Date.now();
  try {
    await k.test();
    return { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: String(err.message || err).replace(/(api_?key|apikey|token|key)=[^&\s]+/gi, '$1=…').slice(0, 300) };
  }
}

module.exports = { KNOWN, list, check, test };
