/**
 * RektBull's public API, described once: the Developers page, the OpenAPI
 * document (/v1/openapi.json) and the MCP server's list of paid services are
 * all built from this list. A route that isn't here still works; this is
 * what we document and support for developers and agents.
 *
 * Each entry: method, path, group, summary, where its input goes (query or
 * body, with each field described; `required` ones marked), and either the
 * free daily allowance it uses (FREE_LIMITS key) or the product it charges
 * (catalog id).
 */
const { FREE_LIMITS } = require('../payments/freeLimits');
const { product, usd, X402_DEFAULT_CLIENT_CAP_CENTS } = require('../payments/catalog');

const EVM6 = 'ethereum, base, arbitrum, optimism, polygon or bsc';
const WALLET = { wallet: { required: true, text: 'An EVM wallet address (0x and 40 hex characters)' } };

const GROUPS = [
  ['free', 'Free, no account', 'Read-only and free. Some have a daily allowance per IP address (higher when signed in); the rest are cached and only rate-limited (120 requests a minute per IP).'],
  ['paid', 'Paid runs', 'Pay per call with x402 (USDC on Base, no account), or sign in and use points, credits or Safety Pro. Charged only when the run succeeds; input is checked before any charge.'],
  ['account', 'Accounts, and transactions to sign', 'Where marked, sign in with your wallet (SIWE: nonce, sign, verify) for a bearer token. Prepared transactions are for the user\'s wallet to sign; RektBull never holds funds or keys.'],
];

const ENDPOINTS = [
  // free
  { method: 'POST', path: '/v1/lookup', group: 'free', summary: 'What an address is on each chain: wallet, Safe, token, NFT collection, DAO governor or contract', body: { query: { required: true, text: 'An EVM or Solana address' } }, limit: 'home_lookup' },
  { method: 'POST', path: '/v1/checkup', group: 'free', summary: 'A wallet\'s free checkup from every desk at once: risky approvals, unclaimed rewards, idle stablecoins, open DAO votes', body: WALLET, limit: 'home_checkup' },
  { method: 'POST', path: '/v1/approvals/preview', group: 'free', summary: 'How many open token and NFT permissions a wallet has on six chains, and how much they put at risk', body: WALLET, limit: 'approval_preview' },
  { method: 'POST', path: '/v1/portfolio', group: 'free', summary: 'What a wallet holds on six chains, its value, and the facts on each holding', body: WALLET, limit: 'portfolio' },
  { method: 'POST', path: '/v1/claims/check', group: 'free', summary: 'Rewards and airdrops a wallet can claim, each verified onchain', body: WALLET, limit: 'claims_check' },
  { method: 'POST', path: '/v1/governance/check', group: 'free', summary: 'DAO votes open for a wallet (Snapshot and onchain governors), with each proposal\'s actions decoded', body: WALLET, limit: 'governance_check' },
  { method: 'GET', path: '/v1/discover/dapps', group: 'free', summary: 'Dapps ranked by TVL, fees or weekly change, with their hack and audit record', query: { chain: { text: `${EVM6} or solana` }, category: { text: 'A DefiLlama category, e.g. Lending' }, sort: { text: 'tvl, fees or change_7d' }, limit: { text: '1 to 100 (50)' } } },
  { method: 'GET', path: '/v1/discover/tokens', group: 'free', summary: 'Trending or new tokens on a chain, with their pools', query: { list: { text: 'trending or new' }, chain: { text: `${EVM6} or solana` } } },
  { method: 'GET', path: '/v1/discover/flags', group: 'free', summary: 'Free safety flags for one token (the quick check goes further)', query: { chain: { required: true, text: `${EVM6} or solana` }, token: { required: true, text: 'The token\'s address' } }, limit: 'discover_flags' },
  { method: 'GET', path: '/v1/markets/overview', group: 'free', summary: 'DeFi in numbers: TVL, DEX volume, fees, stablecoins, each with its source' },
  { method: 'GET', path: '/v1/markets/stablecoins', group: 'free', summary: 'US dollar stablecoins, their supply and how close each is to its peg' },
  { method: 'GET', path: '/v1/markets/tokens', group: 'free', summary: 'The largest tokens by market value' },
  { method: 'GET', path: '/v1/opportunities/campaigns', group: 'free', summary: 'Live reward campaigns (Merkl), each with the protocol\'s record and what taking part involves', query: { chain: { text: EVM6 }, action: { text: 'lend, borrow, pool, hold, stake or drop' }, sort: { text: 'tvl, apr or ending' }, limit: { text: '1 to 100 (40)' } } },
  { method: 'GET', path: '/v1/agents/protocols', group: 'free', summary: 'Onchain AI-agent protocols (DefiLlama\'s "AI Agents"), with their hack and audit record', query: { sort: { text: 'tvl, fees or change_7d' } } },
  { method: 'GET', path: '/v1/agents/x402', group: 'free', summary: 'Paid APIs agents can call with x402 (Coinbase\'s Bazaar), ranked by real payers, with signals such as usage that looks generated or a flagged payment address', query: { network: { text: 'base, solana, polygon …' }, q: { text: 'Search names, descriptions and tags' }, limit: { text: '1 to 100 (40)' } } },
  { method: 'GET', path: '/v1/yield/rates', group: 'free', summary: 'Stablecoin and ETH supply rates on Aave, Compound and Spark, read from their contracts' },
  { method: 'GET', path: '/v1/research/hacks', group: 'free', summary: 'Recorded hacks: totals per period, techniques by amount, newest first', query: { days: { text: '30, 90, 365 or 3650 (90)' }, technique: { text: 'Only hacks done this way' } } },
  { method: 'GET', path: '/v1/research/digests/latest', group: 'free', summary: 'The latest weekly digest, with the facts it was written from and their sources' },
  { method: 'GET', path: '/v1/catalog', group: 'free', summary: 'Every product, its price and how it can be paid for' },
  { method: 'GET', path: '/v1/payment-methods', group: 'free', summary: 'The payment rails switched on here: x402, stablecoin top-ups, NOWPayments' },
  // paid
  { method: 'POST', path: '/v1/tokens/quick-check', group: 'paid', summary: 'Can a token be sold, what does it tax, what can its owner do, how concentrated are holders', body: { chain: { required: true, text: `${EVM6} or solana` }, token_address: { required: true, text: 'The token\'s address' } }, product: 'token_quick_check' },
  { method: 'POST', path: '/v1/tokens/report', group: 'paid', summary: 'The full due-diligence report on a token, in plain English, every finding with its source', body: { chain: { required: true, text: `${EVM6} or solana` }, token_address: { required: true, text: 'The token\'s address' } }, product: 'token_report' },
  { method: 'POST', path: '/v1/contracts/audit', group: 'paid', summary: 'A first-pass security review of a verified contract: Slither, audit-checklist patterns, the compiler\'s known bugs, and a plain-English summary. Takes up to a few minutes', body: { chain: { required: true, text: EVM6 }, address: { required: true, text: 'The contract\'s address (a proxy\'s implementation is read with it)' } }, product: 'contract_audit' },
  { method: 'POST', path: '/v1/launch/check', group: 'paid', summary: 'Was a new token\'s launch bundled? Its largest first-hour buyers, shared funders, links back to the deployer, and what they hold now', body: { chain: { required: true, text: `${EVM6} or solana` }, token: { required: true, text: 'The token\'s address (a Solana mint on Solana)' } }, product: 'launch_check' },
  { method: 'POST', path: '/v1/approvals/cleanup', group: 'paid', summary: 'Every open permission on six chains, rated with sources, and the revokes prepared for the wallet to sign', body: WALLET, product: 'approval_cleanup' },
  { method: 'POST', path: '/v1/presign/check', group: 'paid', summary: 'Before signing: what a transaction or signature would do, simulated, with every spender, recipient and the site checked', body: { method: { required: true, text: 'eth_sendTransaction, eth_signTypedData_v4, personal_sign …' }, params: { required: true, text: 'The request\'s params array, as the site sent it' }, from: { text: 'The signing address' }, chain_id: { text: 'The chain\'s id' }, origin: { text: 'The site\'s URL' } }, product: 'presign_check' },
  { method: 'POST', path: '/v1/governance/summary', group: 'paid', summary: 'A DAO proposal in plain English from its own text. Never a recommendation', body: { proposal_id: { required: true, text: 'A Snapshot proposal id, or an onchain proposal number with chain and governor' }, chain: { text: 'For onchain proposals' }, governor: { text: 'For onchain proposals: the governor contract' } }, product: 'governance_summary' },
  // account
  { method: 'POST', path: '/v1/auth/nonce', group: 'account', summary: 'Start signing in: a SIWE message for the wallet to sign', body: { address: { required: true, text: 'The wallet address' }, chain_id: { text: 'The chain the wallet is on' } } },
  { method: 'POST', path: '/v1/auth/verify', group: 'account', summary: 'Finish signing in: the signed message for a bearer token', body: { challenge_id: { required: true, text: 'The challenge_id from /v1/auth/nonce' }, signature: { required: true, text: 'The wallet\'s signature of its message' } } },
  { method: 'GET', path: '/v1/me', group: 'account', summary: 'Your account: points, credits, passes', auth: true },
  { method: 'POST', path: '/v1/invoices', group: 'account', summary: 'Top up credits with USDT or USDC: an address of your own to send to', auth: true, body: { chain: { required: true, text: 'The chain you\'ll send from' }, token: { required: true, text: 'USDT or USDC' }, amount_cents: { text: 'How much, in cents (or product: a pass to buy)' }, product: { text: 'A pass from the catalog' } } },
  { method: 'POST', path: '/v1/claims/prepare', group: 'account', summary: 'Prepare claims for the wallet to sign (the fee is a share of what\'s claimed, in the same bundle)', body: { wallet: { required: true, text: 'The wallet' }, chain: { required: true, text: EVM6 }, ids: { required: true, text: 'Ids of found items from /v1/claims/check (up to 20)' } }, limit: 'claims_prepare' },
  { method: 'POST', path: '/v1/yield/moves/prepare', group: 'account', summary: 'Prepare a yield move for the wallet to sign (0.1% of the amount moved)', body: { wallet: { required: true, text: 'The wallet' }, chain: { required: true, text: 'ethereum, base or arbitrum' }, asset: { required: true, text: 'USDC, USDT or ETH' }, from: { text: 'The venue now (or none, for a deposit)' }, to: { text: 'The venue to move to (or none, for a withdrawal)' }, amount_usd: { text: 'How much, in US dollars (or all: true)' } }, limit: 'yield_prepare' },
  { method: 'GET', path: '/v1/monitor', group: 'account', summary: 'The risk monitor: wallets you watch and their alerts (Safety Pro)', auth: true },
  { method: 'GET', path: '/v1/my-agents', group: 'account', summary: 'Your AI agents: each one\'s switch, schedule, status and last run', auth: true },
  { method: 'PATCH', path: '/v1/my-agents/:id', group: 'account', summary: 'Switch an AI agent on or off, set its schedule, or (Token Watch) its tokens', auth: true, body: { enabled: { text: 'true or false' }, every_hours: { text: 'One of the agent\'s schedules, in hours' }, tokens: { text: 'Token Watch only: up to 10 of { chain, token }' } } },
];

/** A paid endpoint's price line, from the catalog. */
function priceOf(id) {
  const p = product(id);
  return {
    product: id, price_usd: usd(p.price_cents), points: p.points || null, x402: !!p.x402,
    x402_note: p.x402 && p.price_cents > X402_DEFAULT_CLIENT_CAP_CENTS ? 'Above the $1 default limit of most x402 clients: raise your client\'s limit, or pay with credits.' : null,
  };
}

/** The endpoints with their allowance or price filled in, for the page and the API. */
function reference() {
  return {
    groups: GROUPS.map(([id, title, text]) => ({ id, title, text })),
    endpoints: ENDPOINTS.map(e => ({
      method: e.method, path: e.path, group: e.group, summary: e.summary, auth: !!e.auth,
      input: e.body ? { in: 'body', fields: e.body } : e.query ? { in: 'query', fields: e.query } : null,
      ...(e.limit ? { free_per_day: FREE_LIMITS[e.limit] } : {}),
      ...(e.product ? { price: priceOf(e.product) } : {}),
    })),
  };
}

const field = f => ({ type: 'string', description: f.text });

/** An OpenAPI 3.1 document for the same endpoints. */
function openapi(publicUrl) {
  const paths = {};
  for (const e of ENDPOINTS) {
    const op = {
      summary: e.summary,
      tags: [GROUPS.find(g => g[0] === e.group)[1]],
      responses: {
        200: { description: 'The result, every fact with its source' },
        400: { description: 'The input was refused; the message says why (nothing is charged)' },
        ...(e.limit ? { 429: { description: `Over the free daily allowance (${FREE_LIMITS[e.limit].anonymous} a day per IP, ${FREE_LIMITS[e.limit].account} signed in)` } } : {}),
        ...(e.product ? { 402: { description: `Payment required: ${priceOf(e.product).price_usd} by x402 (the body says how), or sign in and use points, credits or Safety Pro` } } : {}),
        ...(e.auth ? { 401: { description: 'Sign in first' } } : {}),
      },
    };
    if (e.query) op.parameters = Object.entries(e.query).map(([name, f]) => ({ name, in: 'query', required: !!f.required, schema: field(f) }));
    if (e.body) {
      op.requestBody = { required: true, content: { 'application/json': { schema: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(e.body).map(([k, f]) => [k, k === 'params' ? { type: 'array', description: f.text } : k === 'ids' ? { type: 'array', items: { type: 'string' }, description: f.text } : field(f)])),
        required: Object.entries(e.body).filter(([, f]) => f.required).map(([k]) => k),
      } } } };
    }
    if (e.auth) op.security = [{ wallet: [] }];
    if (e.product) op['x-price'] = priceOf(e.product);
    (paths[e.path] ||= {})[e.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: { title: 'RektBull API', version: '1', description: 'Check, protect, find and trade. Every check names its source; transactions are prepared for the user\'s wallet to sign. Not financial advice.' },
    servers: [{ url: publicUrl }],
    components: { securitySchemes: { wallet: { type: 'http', scheme: 'bearer', description: 'From signing in with your wallet: POST /v1/auth/nonce, then /v1/auth/verify' } } },
    paths,
  };
}

module.exports = { ENDPOINTS, GROUPS, reference, openapi, priceOf };
