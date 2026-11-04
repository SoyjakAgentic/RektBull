/**
 * The MCP server's tools: RektBull's free checks and data, for AI agents.
 *
 * Read-only: no tool moves money, signs or prepares a transaction. Each runs
 * the same service as its HTTP route, checks its input the same way first,
 * and uses the same free daily allowance (FREE_LIMITS, shared with the
 * website and the API, per IP address or per signed-in wallet). Paid runs
 * aren't tools: `paid_services` says how to call them over HTTP with x402.
 * Every result keeps its sources, as the API's do.
 */
const env = require('../config/env');
const { FREE_LIMITS } = require('../payments/freeLimits');

const CHAINS = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bsc'];
const ALL_CHAINS = [...CHAINS, 'solana'];
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const WALLET = { type: 'object', properties: { wallet: str('An EVM wallet address (0x and 40 hex characters)', { pattern: '^0x[0-9a-fA-F]{40}$' }) }, required: ['wallet'], additionalProperties: false };
const NONE = { type: 'object', properties: {}, additionalProperties: false };

const svc = {
  home: () => require('../services/home'),
  claims: () => require('../services/claims'),
  approvals: () => require('../services/approvals'),
  discover: () => require('../services/discover'),
  markets: () => require('../services/markets'),
  opportunities: () => require('../services/opportunities'),
  research: () => require('../services/research'),
  governance: () => require('../services/governance'),
  portfolio: () => require('../services/portfolio'),
};
const wallet = args => svc.claims().parseWallet(args);

/**
 * name → { title, description, inputSchema, parse(args) → input | { error },
 *          limit (a FREE_LIMITS key, optional), run(input, ctx) }
 */
const TOOLS = {
  lookup_address: {
    title: 'What is this address?',
    description: 'Says what an address is on each chain (wallet, Safe, token, NFT collection, DAO governor or contract) and which RektBull check fits it. EVM or Solana.',
    inputSchema: { type: 'object', properties: { query: str('An EVM (0x…) or Solana address') }, required: ['query'], additionalProperties: false },
    parse: args => svc.home().parseQuery(args), limit: 'home_lookup',
    run: input => svc.home().identify(input),
  },
  wallet_checkup: {
    title: 'Wallet checkup',
    description: 'A wallet\'s free checkup from every RektBull desk at once: risky token approvals, unclaimed rewards, idle stablecoins that could earn, and open DAO votes. Each finding names its source.',
    inputSchema: WALLET, parse: wallet, limit: 'home_checkup',
    run: (input, ctx) => svc.home().checkup(input.wallet, { accountId: ctx.accountId }),
  },
  approvals_preview: {
    title: 'Open approvals',
    description: 'How many open token, NFT and Permit2 permissions a wallet has on six EVM chains, and how much money they put at risk. (The paid cleanup rates each one and prepares the revokes.)',
    inputSchema: WALLET, parse: args => svc.approvals().parseOwner(args), limit: 'approval_preview',
    run: input => svc.approvals().preview(input.owner, { refresh: false }),
  },
  portfolio: {
    title: 'Portfolio',
    description: 'What a wallet holds on six EVM chains, its value, and the facts on each holding (unpriced tokens and likely scam airdrops kept out of the total).',
    inputSchema: WALLET, parse: wallet, limit: 'portfolio',
    run: input => svc.portfolio().portfolio(input.wallet),
  },
  unclaimed_rewards: {
    title: 'Unclaimed rewards',
    description: 'Rewards and airdrops a wallet can claim (Merkl on six chains, and airdrops RektBull checked), each verified onchain.',
    inputSchema: WALLET, parse: wallet, limit: 'claims_check',
    run: (input, ctx) => svc.claims().check(input.wallet, { accountId: ctx.accountId }),
  },
  dao_votes: {
    title: 'Open DAO votes',
    description: 'DAO votes open for a wallet, on Snapshot and on onchain governors, with each proposal\'s actions decoded and flagged. Never a recommendation.',
    inputSchema: WALLET, parse: wallet, limit: 'governance_check',
    run: (input, ctx) => svc.governance().check(input.wallet, { accountId: ctx.accountId }),
  },
  token_flags: {
    title: 'Token safety flags',
    description: 'Free safety flags for one token. The paid quick check (see paid_services) goes further: sellability, taxes, owner powers, holders.',
    inputSchema: { type: 'object', properties: { chain: str('The token\'s chain', { enum: ALL_CHAINS }), token: str('The token\'s address') }, required: ['chain', 'token'], additionalProperties: false },
    parse: args => svc.discover().parseFlags(args), limit: 'discover_flags',
    run: input => svc.discover().flags(input),
  },
  dapp_rankings: {
    title: 'Dapp rankings',
    description: 'Dapps ranked by money locked (TVL), fees or weekly change, each with its hack and audit record from DefiLlama.',
    inputSchema: { type: 'object', properties: { chain: str('Only this chain', { enum: ALL_CHAINS }), category: str('A DefiLlama category, e.g. Lending, Dexs, AI Agents'), sort: str('Order', { enum: ['tvl', 'fees', 'change_7d'] }), limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many (50)' } }, additionalProperties: false },
    parse: args => svc.discover().parseDapps(args),
    run: input => svc.discover().dapps(input),
  },
  token_lists: {
    title: 'Trending and new tokens',
    description: 'Trending or newly launched tokens on a chain, with their pools. New tokens are where most scams are: check one before trading it.',
    inputSchema: { type: 'object', properties: { list: str('Which list', { enum: ['trending', 'new'] }), chain: str('The chain', { enum: ALL_CHAINS }) }, additionalProperties: false },
    parse: args => svc.discover().parseTokens(args),
    run: input => svc.discover().tokens(input),
  },
  markets_overview: {
    title: 'DeFi today',
    description: 'DeFi in numbers: money locked, DEX volume, fees and stablecoin supply, each with its weekly change and source.',
    inputSchema: NONE, parse: () => ({}),
    run: () => svc.markets().overview(),
  },
  stablecoins: {
    title: 'Stablecoins and their pegs',
    description: 'US dollar stablecoins: supply, and how close each is to its $1 peg, with warnings for any off peg or shrinking fast.',
    inputSchema: NONE, parse: () => ({}),
    run: () => svc.markets().stablecoinList(),
  },
  yield_rates: {
    title: 'Stablecoin and ETH rates',
    description: 'Supply rates on Aave, Compound and Spark (Ethereum, Base, Arbitrum), read from their contracts, with any risk warning on a venue.',
    inputSchema: NONE, parse: () => ({}),
    run: async () => ({
      rates: await require('../yield/rates').listRates(),
      ...(env.databaseUrl ? await require('../yield/risk').current() : { warnings: [] }),
      sources: ['Each venue\'s own contracts onchain', 'DefiLlama yields (a cross-check)'],
    }),
  },
  reward_campaigns: {
    title: 'Reward campaigns',
    description: 'Live reward campaigns (Merkl) on six chains, each with the protocol\'s hack and audit record and what taking part involves. Not advice.',
    inputSchema: { type: 'object', properties: { chain: str('Only this chain', { enum: CHAINS }), action: str('What you do to earn', { enum: ['lend', 'borrow', 'pool', 'hold', 'stake', 'drop'] }), sort: str('Order', { enum: ['tvl', 'apr', 'ending'] }), limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many (40)' } }, additionalProperties: false },
    parse: args => svc.opportunities().parseCampaigns(args),
    run: input => svc.opportunities().campaigns(input),
  },
  hack_tracker: {
    title: 'Hack tracker',
    description: 'Recorded crypto hacks (DefiLlama\'s record): totals for 30 days, 90 days and a year, techniques by amount lost, and the hacks newest first.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', enum: [30, 90, 365, 3650], description: 'The period (90)' }, technique: str('Only hacks done this way') }, additionalProperties: false },
    parse: args => svc.research().parseHacks(args),
    run: input => svc.research().hacks(input),
  },
  weekly_digest: {
    title: 'Weekly digest',
    description: 'RektBull Research\'s weekly digest of hacks, stablecoins, money flows and opportunities, with the facts it was written from and their sources. The latest, or a given week.',
    inputSchema: { type: 'object', properties: { week_start: str('A Monday, YYYY-MM-DD (the latest if left out)', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }) }, additionalProperties: false },
    parse: args => ({ week: args.week_start || null }),
    run: input => {
      if (!env.databaseUrl) throw Object.assign(new Error('The digest isn\'t available on this server.'), { status: 503 });
      return svc.research().digest(input.week);
    },
  },
  paid_services: {
    title: 'Paid services (x402)',
    description: 'RektBull\'s paid runs (token quick check, full token report, approval cleanup, pre-sign check, proposal summary): what each does, its price, and how to call it over HTTP with x402 (USDC on Base, no account).',
    inputSchema: NONE, parse: () => ({}),
    run: () => {
      const api = require('../developers/api');
      return {
        how_to_pay: 'Call the endpoint over HTTP. Without payment it answers 402 with x402 payment requirements (USDC on Base); pay with any x402 client and retry with the X-PAYMENT header. Charged only when the run succeeds. Or sign in with a wallet and use points, credits or Safety Pro.',
        services: api.reference().endpoints.filter(e => e.group === 'paid').map(e => ({ ...e, url: `${env.publicUrl}${e.path}` })),
        docs: `${env.publicUrl}/developers`,
      };
    },
  },
};

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/** The tools as tools/list returns them. */
function list() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name, title: t.title,
    description: t.limit ? `${t.description} Free: a daily allowance per IP address, shared with rektbull.com.` : t.description,
    inputSchema: t.inputSchema,
    annotations: { title: t.title, ...ANNOTATIONS },
    ...(t.limit ? { _meta: { 'com.rektbull/free_per_day': FREE_LIMITS[t.limit] } } : {}),
  }));
}

module.exports = { TOOLS, list };
