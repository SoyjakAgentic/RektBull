const express = require('express');
const env = require('../config/env');
const db = require('../config/db');
const siwe = require('../auth/siwe');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { publicCatalog } = require('../payments/catalog');
const { methods } = require('../payments/stablecoins');
const credits = require('../payments/credits');
const invoices = require('../payments/invoices');
const passes = require('../payments/passes');
const x402 = require('../payments/x402');
const { paidRoute, takeAllowance } = require('../payments/gate');
const points = require('../payments/points');
const { product: productOf } = require('../payments/catalog');
const approvals = require('../services/approvals');
const dd = require('../services/dueDiligence');
const claude = require('../ai/claude');
const usage = require('../providers/usage');

const router = express.Router();

// ── Health ──────────────────────────────────────────────────────────────────
router.get('/health', async (_req, res) => {
  let database = 'not configured';
  if (env.databaseUrl) {
    try { await db.query('SELECT 1'); database = 'ok'; } catch { database = 'unreachable'; }
  }
  res.status(database === 'unreachable' ? 503 : 200).json({ ok: database !== 'unreachable', database });
});

// ── What's for sale, and how to pay ─────────────────────────────────────────
router.get('/v1/catalog', (_req, res) => res.json({ products: publicCatalog(), free_points: require('../payments/catalog').FREE_POINTS }));

// For developers and agents: the API described (the Developers page reads this), and as OpenAPI.
router.get('/v1/developers', (_req, res) => {
  res.set('cache-control', 'public, max-age=300');
  res.json({ ...require('../developers/api').reference(), mcp: { url: `${env.publicUrl}/mcp`, tools: require('../mcp/tools').list() }, openapi: `${env.publicUrl}/v1/openapi.json` });
});
router.get('/v1/openapi.json', (_req, res) => {
  res.set('cache-control', 'public, max-age=300');
  res.json(require('../developers/api').openapi(env.publicUrl));
});

router.get('/v1/payment-methods', (_req, res) => res.json({
  x402: { enabled: x402.enabled(), network: env.x402Network, asset: 'USDC' },
  nowpayments: { enabled: require('../payments/nowpayments').enabled(), note: 'Any coin NOWPayments takes, on its own payment page; it charges a fee per payment. USDT/USDC top-ups here have none.' },
  stablecoin_top_ups: { enabled: !!env.depositXpub, min_cents: env.minTopUpCents, chains: methods(env.paymentChains) },
}));

// ── Sign in with your wallet ────────────────────────────────────────────────
router.post('/v1/auth/nonce', async (req, res) => {
  res.json(await siwe.createChallenge({ address: req.body?.address, chainId: req.body?.chain_id }));
});

router.post('/v1/auth/verify', async (req, res) => {
  res.json(await siwe.verifyChallenge({ challengeId: req.body?.challenge_id, signature: req.body?.signature }));
});

router.get('/v1/me', requireAuth, async (req, res) => {
  const active = await passes.active(req.account.id);
  const now = active.find(p => new Date(p.starts_at) <= new Date());
  let included = null;
  if (now) {
    const p = productOf(now.product);
    included = {};
    for (const [id, n] of Object.entries(p.included_per_month || {})) included[id] = await points.includedLeft(req.account.id, id, n);
  }
  res.json({
    account: req.account,
    credits_cents: await credits.balance(req.account.id),
    points: await points.status(req.account),
    passes: active.map(p => ({ ...p, title: productOf(p.product).title })),
    ...(included ? { pass_included: included } : {}),
    ai_allowance: await require('../payments/aiAllowance').status(req.account.id),
  });
});

// ── Your data: download it, or delete what can be deleted ──
const myData = require('../privacy/myData');
router.get('/v1/me/export', requireAuth, async (req, res) => {
  res.set('content-disposition', 'attachment; filename="rektbull-my-data.json"');
  res.json(await myData.exportAll(req.account));
});
router.post('/v1/me/delete', requireAuth, async (req, res) => {
  try {
    res.json(await myData.deleteMine(req.account, req.body || {}));
  } catch (err) {
    if (err instanceof myData.DataRefused) return res.status(err.status).json({ error: 'refused', message: err.message });
    throw err;
  }
});

// ── Credits, invoices and passes ────────────────────────────────────────────
router.get('/v1/credits', requireAuth, async (req, res) => {
  res.json({ balance_cents: await credits.balance(req.account.id), history: await credits.history(req.account.id) });
});

router.post('/v1/invoices', requireAuth, async (req, res) => {
  res.status(201).json(await invoices.create(req.account.id, req.body || {}));
});
router.get('/v1/invoices', requireAuth, async (req, res) => res.json({ invoices: await invoices.list(req.account.id) }));
router.get('/v1/invoices/:id', requireAuth, async (req, res) => res.json(await invoices.get(req.account.id, req.params.id)));

// NOWPayments: a hosted checkout for credits or a pass; its notifications are signed, and every payment is read back before crediting.
const nowpayments = require('../payments/nowpayments');
const npCall = fn => async (req, res) => {
  try { res.status(201).json(await fn(req)); } catch (err) {
    if (err instanceof nowpayments.NowPaymentsError) return res.status(err.status).json({ error: 'refused', message: err.message });
    throw err;
  }
};
router.post('/v1/checkout/nowpayments', requireAuth, npCall(req => nowpayments.createCheckout(req.account.id, req.body || {})));
router.get('/v1/checkout/:id', requireAuth, async (req, res) => {
  try { res.json(await nowpayments.get(req.account.id, req.params.id)); } catch (err) {
    if (err instanceof nowpayments.NowPaymentsError) return res.status(err.status).json({ error: 'not_found', message: err.message });
    throw err;
  }
});
router.post('/v1/nowpayments/ipn', async (req, res) => {
  const { status, result } = await nowpayments.handleIpn(req.body, req.get('x-nowpayments-sig'));
  res.status(status).json({ result });
});
router.get('/v1/admin/hosted-invoices', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await db.query(`SELECT h.*, a.wallet FROM hosted_invoices h JOIN accounts a ON a.id = h.account_id WHERE ($1::text IS NULL OR h.status = $1) ORDER BY h.created_at DESC LIMIT 200`, [req.query.status || null]);
  res.json({ invoices: rows });
});

router.post('/v1/passes/:product', requireAuth, async (req, res) => {
  try {
    res.status(201).json(await passes.buy(req.account.id, req.params.product, `manual:${req.account.id}:${Date.now()}`));
  } catch (err) {
    if (err instanceof credits.InsufficientCredits) {
      return res.status(402).json({ error: 'insufficient_credits', balance_cents: err.balance, needed_cents: err.needed, top_up: 'POST /v1/invoices' });
    }
    throw err;
  }
});

// ── Paid runs: token due diligence ──────────────────────────────────────────
const target = req => dd.parseTarget(req.body);

router.get('/v1/tokens/chains', (_req, res) => res.json({ chains: require('../services/tokenRisk').SCAN_CHAINS }));

router.post('/v1/tokens/quick-check', paidRoute('token_quick_check', { validate: target, run: input => dd.quickCheck(input) }));

router.post('/v1/tokens/report', paidRoute('token_report', {
  validate: req => (claude.available() ? target(req) : { error: 'Reports are not available yet: the AI key is not configured' }),
  run: input => dd.fullReport(input),
}));

// ── Contract Audit: a first-pass review of a verified contract, with Slither in the analyzer service ──
const contractAudit = require('../services/contractAudit');
router.post('/v1/contracts/audit', paidRoute('contract_audit', {
  validate: req => contractAudit.parse(req.body),
  // Kept by run id, so the PDF report can be downloaded later by whoever holds the run id (the buyer).
  run: async (input, req, { runId }) => {
    const result = await contractAudit.run(input);
    await contractAudit.saveReport(runId, req.account?.id || null, input, result);
    return { ...result, report_pdf: `/v1/contracts/audit/${runId}/report.pdf` };
  },
}));
router.get('/v1/contracts/audit/:runId/report.pdf', async (req, res, next) => {
  try {
    const r = await contractAudit.report(req.params.runId);
    if (!r) return res.status(404).json({ error: 'not_found', message: 'No completed audit with that report id.' });
    const pdf = await require('../pages/auditPdf').render(r.result, { runId: req.params.runId, paidWith: r.paid_with });
    res.set('content-type', 'application/pdf').set('content-disposition', `attachment; filename="rektbull-audit-${r.chain}-${r.address}-${String(r.created_at.toISOString()).slice(0, 10)}.pdf"`).set('cache-control', 'private, max-age=3600').send(pdf);
  } catch (err) { next(err); }
});

// ── Launch Safety: was a new token's supply bundled at launch, and are the bundlers selling? ──
const launchSafety = require('../services/launchSafety');
router.post('/v1/launch/check', paidRoute('launch_check', { validate: req => launchSafety.parse(req.body), run: input => launchSafety.check(input) }));

// ── Approval cleanup: a free preview (how many, how much at risk), then the paid cleanup ──
const { FREE_LIMITS } = require('../payments/freeLimits');
const PREVIEWS_PER_DAY = FREE_LIMITS.approval_preview;

router.post('/v1/approvals/preview', async (req, res) => {
  const input = approvals.parseOwner(req.body);
  if (input.error) return res.status(400).json({ error: 'bad_request', message: input.error });
  const [subject, limit] = req.account ? [`account:${req.account.id}`, PREVIEWS_PER_DAY.account] : [require('../privacy/ipKey').ipSubject(req.ip), PREVIEWS_PER_DAY.anonymous];
  if (!(await takeAllowance(subject, 'approval_preview', limit))) {
    return res.status(429).json({ error: 'daily_limit', message: `Free previews are limited to ${limit} a day${req.account ? '' : ' without signing in (sign in for more)'}.` });
  }
  res.json(await approvals.preview(input.owner, { refresh: input.refresh }));
});

router.post('/v1/approvals/cleanup', paidRoute('approval_cleanup', {
  validate: req => approvals.parseOwner(req.body),
  run: input => approvals.cleanup(input.owner, { refresh: input.refresh }),
}));

// ── Find money: airdrops and unclaimed rewards (checking is free; claims carry a share as their fee) ──
const claims = require('../services/claims');
const CLAIM_LIMITS = { check: FREE_LIMITS.claims_check, prepare: FREE_LIMITS.claims_prepare };
const claimCall = fn => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    if (err instanceof claims.ClaimRefused) return res.status(err.status).json({ error: 'refused', message: err.message });
    throw err;
  }
};
const dailyLimit = kind => async (req, res, next) => {
  const limits = CLAIM_LIMITS[kind];
  const [subject, limit] = req.account ? [`account:${req.account.id}`, limits.account] : [require('../privacy/ipKey').ipSubject(req.ip), limits.anonymous];
  if (!env.databaseUrl || await takeAllowance(subject, `claims_${kind}`, limit)) return next();
  res.status(429).json({ error: 'daily_limit', message: `Free ${kind === 'check' ? 'checks' : 'claim preparations'} are limited to ${limit} a day${req.account ? '' : ' without signing in (sign in for more)'}.` });
};
const validated = parse => (req, res, next) => {
  const input = parse(req.body);
  if (input.error) return res.status(400).json({ error: 'bad_request', message: input.error });
  req.input = input;
  next();
};
router.post('/v1/claims/check', validated(claims.parseWallet), dailyLimit('check'), claimCall(req => claims.check(req.input.wallet, { accountId: req.account?.id || null })));
router.post('/v1/claims/prepare', validated(claims.parsePrepare), dailyLimit('prepare'), claimCall(req => claims.prepare(req.input, { accountId: req.account?.id || null })));
router.post('/v1/claims/:id/confirm', claimCall(req => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw new claims.ClaimRefused('No such claim.', 404);
  return claims.confirm(req.params.id, req.body?.tx_hashes);
}));
router.get('/v1/claims/programs', claimCall(async () => ({ programs: await claims.programs() })));

// ── Find money: yield proposals (Safety Pro), moves the wallet signs with a 0.1% fee ──
const yieldProposals = require('../yield/proposals');
const yieldVenues = require('../yield/venues');
const YIELD_LIMITS = { wallet: FREE_LIMITS.yield_wallet, prepare: FREE_LIMITS.yield_prepare };
const yieldCall = fn => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    if (err instanceof yieldVenues.YieldRefused) return res.status(err.status).json({ error: err.status === 402 ? 'safety_pro_required' : 'refused', message: err.message, ...(err.offer ? { offer: err.offer } : {}) });
    throw err;
  }
};
const yieldLimit = kind => async (req, res, next) => {
  const limits = YIELD_LIMITS[kind];
  const [subject, limit] = req.account ? [`account:${req.account.id}`, limits.account] : [require('../privacy/ipKey').ipSubject(req.ip), limits.anonymous];
  if (!env.databaseUrl || await takeAllowance(subject, `yield_${kind}`, limit)) return next();
  res.status(429).json({ error: 'daily_limit', message: `This is limited to ${limit} a day${req.account ? '' : ' without signing in (sign in for more)'}.` });
};
router.get('/v1/yield/rates', yieldCall(async () => ({
  rates: await require('../yield/rates').listRates(),
  ...(env.databaseUrl ? await require('../yield/risk').current() : { warnings: [] }),
  sources: ['Each venue\'s own contracts onchain', 'DefiLlama yields (a cross-check, and reward APYs, which the rules don\'t count)'],
})));
router.post('/v1/yield/wallet', validated(claims.parseWallet), yieldLimit('wallet'), yieldCall(req => yieldProposals.summary(req.input.wallet)));
router.post('/v1/yield/proposals', validated(claims.parseWallet), yieldCall(async req => {
  await yieldProposals.requirePro(req.account?.id);
  return yieldProposals.scan(req.input.wallet);
}));
router.post('/v1/yield/moves/prepare', validated(yieldProposals.parseMove), yieldLimit('prepare'), yieldCall(req => yieldProposals.prepare(req.input, { accountId: req.account?.id || null })));
router.post('/v1/yield/moves/:id/confirm', yieldCall(req => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw new yieldVenues.YieldRefused('No such move.', 404);
  return yieldProposals.confirm(req.params.id, req.body?.tx_hashes);
}));

// Automatic rebalancing: built, switched off (YIELD_AUTO_ENABLED); permissions are refused while it's off.
const yieldAuto = require('../yield/auto');
const autoCall = fn => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    if (err instanceof yieldAuto.AutoRefused || err instanceof yieldVenues.YieldRefused) return res.status(err.status).json({ error: 'refused', message: err.message });
    throw err;
  }
};
router.get('/v1/yield/auto', (_req, res) => res.json({
  enabled: env.yieldAutoEnabled, routers: env.yieldRouters,
  note: env.yieldAutoEnabled ? 'Automatic rebalancing uses a limited, revocable permission that may only call the RektBull Yield Router.' : 'Automatic rebalancing is built and switched off until the Yield Router is audited. Proposals you sign yourself work now.',
}));
router.get('/v1/yield/auto/setup', autoCall(req => yieldAuto.setupCalls(Number(req.query.chain_id), { limits: Object.fromEntries(['USDC', 'USDT', 'WETH'].filter(a => Number(req.query[a]) > 0).map(a => [a, Number(req.query[a])])), days: Number(req.query.days) || 30 })));
router.post('/v1/yield/auto/permissions', requireAuth, autoCall(async req => {
  await yieldProposals.requirePro(req.account.id);
  return yieldAuto.register(req.account, req.body || {}, { sessionKey: env.sessionKeyAddress });
}));
router.get('/v1/yield/auto/permissions', requireAuth, autoCall(async req => ({ permissions: await yieldAuto.list(req.account) })));
router.delete('/v1/yield/auto/permissions/:id', requireAuth, autoCall(req => yieldAuto.revoke(req.account, req.params.id)));

// ── Save money: the governance assistant (Snapshot votes; summaries are a paid run; votes are signed by the wallet) ──
const governance = require('../services/governance');
const govCall = (fn, status = 200) => async (req, res) => {
  try {
    res.status(status).json(await fn(req));
  } catch (err) {
    if (err instanceof governance.GovernanceRefused) return res.status(err.status).json({ error: 'refused', message: err.message });
    throw err;
  }
};
const GOV_CHECKS = FREE_LIMITS.governance_check;
router.post('/v1/governance/check', validated(claims.parseWallet), async (req, res, next) => {
  const [subject, limit] = req.account ? [`account:${req.account.id}`, GOV_CHECKS.account] : [require('../privacy/ipKey').ipSubject(req.ip), GOV_CHECKS.anonymous];
  if (!env.databaseUrl || await takeAllowance(subject, 'governance_check', limit)) return next();
  res.status(429).json({ error: 'daily_limit', message: `Free checks are limited to ${limit} a day${req.account ? '' : ' without signing in (sign in for more)'}.` });
}, govCall(req => governance.check(req.input.wallet, { accountId: req.account?.id || null })));
router.post('/v1/governance/summary', paidRoute('governance_summary', {
  validate: req => (claude.available() ? governance.parseProposalId(req.body) : { error: 'Summaries are not available yet: the AI key is not configured' }),
  run: input => governance.summarize(input),
}));
router.post('/v1/governance/votes/prepare', validated(governance.parseVote), govCall(req => governance.prepareVote(req.input)));
router.post('/v1/governance/votes', govCall(req => governance.submitVote(req.body || {}, { accountId: req.account?.id || null }), 201));
// On-chain governors: votes and delegations are transactions the wallet sends; prepared and simulated here.
const governorsSvc = require('../services/governors');
const onchainCall = fn => async (req, res) => {
  try { res.json(await fn(req)); } catch (err) {
    if (err instanceof governorsSvc.GovernorRefused || err instanceof governance.GovernanceRefused) return res.status(err.status).json({ error: 'refused', message: err.message });
    throw err;
  }
};
router.post('/v1/governance/onchain/votes/prepare', validated(governance.parseOnchainVote), onchainCall(req => governorsSvc.prepareVote(req.input)));
router.post('/v1/governance/onchain/delegate/prepare', validated(governance.parseDelegate), onchainCall(req => governorsSvc.prepareDelegate(req.input)));
router.get('/v1/governance/governors', requireAuth, onchainCall(async req => ({ registry: governorsSvc.REGISTRY, governors: await governance.savedGovernors(req.account.id) })));
router.post('/v1/governance/governors', requireAuth, onchainCall(req => governance.addGovernor(req.account.id, { chain: req.body?.chain, address: req.body?.address })));
router.delete('/v1/governance/governors/:chain/:address', requireAuth, onchainCall(req => governance.removeGovernor(req.account.id, req.params.chain, req.params.address)));
router.get('/v1/governance/spaces', requireAuth, govCall(async req => ({ spaces: await governance.savedSpaces(req.account.id) })));
router.post('/v1/governance/spaces', requireAuth, govCall(req => governance.addSpace(req.account.id, req.body?.space), 201));
router.delete('/v1/governance/spaces/:space', requireAuth, govCall(req => governance.removeSpace(req.account.id, req.params.space)));

// ── Discover: rankings, categories, chains, trending and new tokens (free, cached), each with its safety facts ──
const discover = require('../services/discover');
const discoverCall = (parse, fn) => async (req, res) => {
  const input = parse ? parse(req.query) : {};
  if (input.error) return res.status(400).json({ error: 'bad_request', message: input.error });
  try {
    res.set('cache-control', 'public, max-age=60');
    res.json(await fn(input, req));
  } catch (err) {
    if (err instanceof discover.DiscoverRefused) return res.status(err.status).json({ error: 'refused', message: err.message });
    throw err;
  }
};
const FLAGS_PER_DAY = FREE_LIMITS.discover_flags;

// ── Launches: new tokens with their checks (free, cached); buying and selling goes through the Trade desk ──
const launches = require('../services/launches');
const launchCall = fn => async (req, res) => {
  try {
    res.set('cache-control', 'public, max-age=60');
    res.json(await fn(req));
  } catch (err) {
    if (err instanceof launches.LaunchesRefused || err instanceof discover.DiscoverRefused) return res.status(err.status).json({ error: 'refused', message: err.message });
    throw err;
  }
};
router.get('/v1/launches', launchCall(req => {
  const input = launches.parse(req.query);
  if (input.error) throw new launches.LaunchesRefused(input.error);
  return launches.feed(input);
}));
router.get('/v1/launches/curves', launchCall(() => launches.curves()));
router.get('/v1/launches/:chain/:token', launchCall(req => launches.card({ chain: String(req.params.chain).toLowerCase(), token: req.params.token })));
router.get('/v1/discover/dapps', discoverCall(discover.parseDapps, input => discover.dapps(input)));
router.get('/v1/discover/categories', discoverCall(q => (q.chain && !discover.CHAIN_NAMES[q.chain] ? { error: 'unknown chain' } : { chain: q.chain || null }), input => discover.categories(input)));
router.get('/v1/discover/chains', discoverCall(null, () => discover.chainList()));
router.get('/v1/discover/tokens', discoverCall(discover.parseTokens, input => discover.tokens(input)));
router.get('/v1/discover/flags', async (req, res, next) => {
  const input = discover.parseFlags(req.query);
  if (input.error) return res.status(400).json({ error: 'bad_request', message: input.error });
  const [subject, limit] = req.account ? [`account:${req.account.id}`, FLAGS_PER_DAY.account] : [require('../privacy/ipKey').ipSubject(req.ip), FLAGS_PER_DAY.anonymous];
  if (env.databaseUrl && !(await takeAllowance(subject, 'discover_flags', limit))) {
    return res.status(429).json({ error: 'daily_limit', message: `Free flags are limited to ${limit} a day${req.account ? '' : ' without signing in (sign in for more)'}. The quick check is always available.` });
  }
  res.json(await discover.flags(input));
});

// ── Markets: DeFi in numbers, stablecoins and their pegs, the largest tokens (free, cached) ──
const markets = require('../services/markets');
const marketsCall = fn => async (req, res) => {
  try {
    res.set('cache-control', 'public, max-age=60');
    res.json(await fn(req));
  } catch (err) {
    if (err instanceof markets.MarketsRefused) return res.status(err.status).json({ error: 'refused', message: err.message });
    throw err;
  }
};
router.get('/v1/markets/overview', marketsCall(() => markets.overview()));
router.get('/v1/markets/stablecoins', marketsCall(() => markets.stablecoinList()));
router.get('/v1/markets/tokens', marketsCall(() => markets.tokens()));

// ── Opportunities: live incentive campaigns (Merkl), each with what it would cost to take part (free, cached) ──
const opportunities = require('../services/opportunities');
router.get('/v1/opportunities/campaigns', async (req, res) => {
  const input = opportunities.parseCampaigns(req.query);
  if (input.error) return res.status(400).json({ error: 'bad_request', message: input.error });
  try {
    res.set('cache-control', 'public, max-age=60');
    res.json(await opportunities.campaigns(input));
  } catch (err) {
    if (err instanceof opportunities.OpportunitiesRefused) return res.status(err.status).json({ error: 'refused', message: err.message });
    throw err;
  }
});

// ── Agents: onchain AI-agent protocols, and the x402 services agents can pay per call (free, cached) ──
const agents = require('../services/agents');
const agentsCall = (parse, fn) => async (req, res) => {
  const input = parse(req.query);
  if (input.error) return res.status(400).json({ error: 'bad_request', message: input.error });
  try {
    res.set('cache-control', 'public, max-age=300');
    res.json(await fn(input));
  } catch (err) {
    if (err instanceof agents.AgentsRefused || err instanceof discover.DiscoverRefused) return res.status(err.status).json({ error: 'refused', message: err.message });
    throw err;
  }
};
router.get('/v1/agents/protocols', agentsCall(agents.parseProtocols, input => agents.protocols(input)));
router.get('/v1/agents/x402', agentsCall(agents.parseX402, input => agents.x402Services(input)));

// ── Portfolio: what a wallet holds on six chains, its value, and the facts on each holding (free, a daily limit) ──
const portfolio = require('../services/portfolio');
const PORTFOLIO_PER_DAY = FREE_LIMITS.portfolio;
router.post('/v1/portfolio', validated(claims.parseWallet), async (req, res) => {
  const [subject, limit] = req.account ? [`account:${req.account.id}`, PORTFOLIO_PER_DAY.account] : [require('../privacy/ipKey').ipSubject(req.ip), PORTFOLIO_PER_DAY.anonymous];
  if (env.databaseUrl && !(await takeAllowance(subject, 'portfolio', limit))) {
    return res.status(429).json({ error: 'daily_limit', message: `Free portfolio reads are limited to ${limit} a day${req.account ? '' : ' without signing in (sign in for more)'}.` });
  }
  res.json(await portfolio.portfolio(req.input.wallet));
});

// ── Research: the hack tracker and the weekly digest (free) ──
const research = require('../services/research');
const researchCall = fn => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    if (err instanceof research.ResearchRefused) return res.status(err.status).json({ error: 'refused', message: err.message });
    throw err;
  }
};
router.get('/v1/research/hacks', (req, res, next) => {
  const input = research.parseHacks(req.query);
  if (input.error) return res.status(400).json({ error: 'bad_request', message: input.error });
  res.set('cache-control', 'public, max-age=300');
  return researchCall(() => research.hacks(input))(req, res, next);
});
router.get('/v1/research/digests', researchCall(async () => ({ digests: env.databaseUrl ? await research.digests() : [] })));
router.get('/v1/research/digests/latest', researchCall(() => research.digest(null)));
router.get('/v1/research/digests/:week', researchCall(req => research.digest(req.params.week)));
// The owner reviews each week's draft, may edit it, and publishes it or skips the week.
const mondayOf = s => {
  const at = /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? new Date(`${s}T00:00:00Z`) : null;
  if (!at || Number.isNaN(at.getTime()) || at.getUTCDay() !== 1) throw new research.ResearchRefused('week_start must be a Monday (YYYY-MM-DD)');
  return at;
};
router.get('/v1/admin/research/drafts', requireAuth, requireAdmin, researchCall(async () => ({
  drafts: await research.drafts(), newsletter: await require('../services/newsletter').counts(),
  newsletter_ready: !!env.resendApiKey && !!env.operatorPostalAddress,
})));
// Makes (or remakes) a week's draft by hand, e.g. the first one at launch.
router.post('/v1/admin/research/digest', requireAuth, requireAdmin, researchCall(req => {
  const at = req.body?.week_start ? mondayOf(req.body.week_start) : null;
  return research.makeDigest(at ? { start: at, end: new Date(at.getTime() + 7 * 86400000) } : research.lastWeek());
}));
router.post('/v1/admin/research/digests/:week/publish', requireAuth, requireAdmin, researchCall(async req => {
  mondayOf(req.params.week);
  const published = await research.publish(req.params.week, { text: req.body && 'text' in req.body ? req.body.text : undefined, accountId: req.account.id });
  require('../services/indexnow').ping([`/research/${req.params.week}`, '/research']); // tells search engines; never holds up the answer
  return published;
}));
router.post('/v1/admin/research/digests/:week/skip', requireAuth, requireAdmin, researchCall(req => {
  mondayOf(req.params.week);
  return research.skip(req.params.week, { accountId: req.account.id });
}));

// Sponsored posts: the owner adds them to a week's draft; readers' clicks go through a re-checked, counted redirect.
const sponsored = require('../services/sponsored');
const sponsoredCall = fn => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    if (err instanceof sponsored.SponsoredRefused || err instanceof research.ResearchRefused) return res.status(err.status).json({ error: 'refused', message: err.message });
    throw err;
  }
};
router.get('/v1/admin/research/sponsored', requireAuth, requireAdmin, sponsoredCall(async () => ({ sponsored: await sponsored.report() })));
router.post('/v1/admin/research/digests/:week/sponsored', requireAuth, requireAdmin, sponsoredCall(req => {
  mondayOf(req.params.week);
  const post = sponsored.parse(req.body);
  if (post.error) throw new sponsored.SponsoredRefused(post.error);
  return sponsored.put(req.params.week, post, { accountId: req.account.id });
}));
router.delete('/v1/admin/research/digests/:week/sponsored/:placement', requireAuth, requireAdmin, sponsoredCall(req => {
  mondayOf(req.params.week);
  if (!['top', 'bottom'].includes(req.params.placement)) throw new sponsored.SponsoredRefused('placement must be top or bottom');
  return sponsored.remove(req.params.week, req.params.placement);
}));
router.get('/v1/research/sponsored/:id', async (req, res) => {
  const r = env.databaseUrl ? await sponsored.follow(req.params.id) : { status: 404 };
  res.set('cache-control', 'no-store');
  if (r.status === 302) return res.redirect(302, r.url);
  if (r.status === 410) return res.status(410).type('text/plain').send(`Stopped: ${r.site} is now on a phishing list (${r.source}), so RektBull no longer sends anyone there. Don't open it.`);
  return res.status(404).type('text/plain').send('No such sponsored link.');
});

// ── The weekly newsletter: double opt-in, one-click unsubscribe (deletes the address) ──
const newsletter = require('../services/newsletter');
const SIGNUPS_PER_DAY = 5; // per IP address: enough for a person, too few to mail-bomb anyone
router.post('/v1/newsletter', async (req, res) => {
  if (!env.databaseUrl) return res.status(503).json({ error: 'unavailable', message: 'The newsletter isn\'t set up on this server yet.' });
  const input = newsletter.parseEmail(req.body);
  if (input.error) return res.status(400).json({ error: 'bad_request', message: input.error });
  if (!(await takeAllowance(require('../privacy/ipKey').ipSubject(req.ip), 'newsletter_signup', SIGNUPS_PER_DAY))) {
    return res.status(429).json({ error: 'limit', message: 'Too many sign-ups from here today. Try again tomorrow.' });
  }
  try {
    res.json(await newsletter.subscribe(input.email));
  } catch (err) {
    if (err instanceof newsletter.NewsletterRefused) return res.status(err.status).json({ error: 'refused', message: err.message });
    throw err;
  }
});
router.get('/v1/newsletter/confirm', async (req, res) => {
  const ok = env.databaseUrl && await newsletter.confirm(req.query.s, req.query.t);
  res.redirect(303, `/research?newsletter=${ok ? 'confirmed' : 'bad-link'}#newsletter`);
});
// GET is the link in the email; POST is the mail app's one-click unsubscribe (RFC 8058).
router.get('/v1/newsletter/unsubscribe', async (req, res) => {
  const ok = env.databaseUrl && await newsletter.unsubscribe(req.query.s, req.query.t);
  res.redirect(303, `/research?newsletter=${ok ? 'unsubscribed' : 'bad-link'}#newsletter`);
});
router.post('/v1/newsletter/unsubscribe', async (req, res) => {
  const ok = env.databaseUrl && await newsletter.unsubscribe(req.query.s, req.query.t);
  res.status(ok ? 200 : 400).json(ok ? { ok: true } : { error: 'bad_link', message: 'That unsubscribe link isn\'t valid.' });
});

// ── Home: what a pasted address is, and a wallet's free checks from every desk at once ──
const home = require('../services/home');
const HOME_LIMITS = { lookup: FREE_LIMITS.home_lookup, checkup: FREE_LIMITS.home_checkup };
const homeLimit = kind => async (req, res, next) => {
  const limits = HOME_LIMITS[kind];
  const [subject, limit] = req.account ? [`account:${req.account.id}`, limits.account] : [require('../privacy/ipKey').ipSubject(req.ip), limits.anonymous];
  if (!env.databaseUrl || await takeAllowance(subject, `home_${kind}`, limit)) return next();
  res.status(429).json({ error: 'daily_limit', message: `Free ${kind === 'lookup' ? 'lookups' : 'checkups'} are limited to ${limit} a day${req.account ? '' : ' without signing in (sign in for more)'}.` });
};
const homeCall = fn => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    if (err instanceof home.HomeRefused) return res.status(err.status).json({ error: 'refused', message: err.message });
    throw err;
  }
};
router.post('/v1/lookup', validated(home.parseQuery), homeLimit('lookup'), homeCall(req => home.identify(req.input)));
router.post('/v1/checkup', validated(claims.parseWallet), homeLimit('checkup'), homeCall(req => home.checkup(req.input.wallet, { accountId: req.account?.id || null })));

// ── The risk monitor (Safety Pro) ──
const monitor = require('../services/monitor');
const monitorCall = fn => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    if (err instanceof monitor.MonitorRefused) {
      return res.status(err.status).json({ error: err.status === 402 ? 'safety_pro_required' : 'refused', message: err.message, ...(err.offer ? { offer: err.offer } : {}) });
    }
    throw err;
  }
};
router.get('/v1/monitor', requireAuth, monitorCall(req => monitor.list(req.account.id)));
router.post('/v1/monitor/wallets', requireAuth, monitorCall(req => monitor.watch(req.account.id, req.body || {})));
router.delete('/v1/monitor/wallets/:id', requireAuth, monitorCall(req => monitor.unwatch(req.account.id, req.params.id)));
router.get('/v1/monitor/alerts', requireAuth, monitorCall(async req => ({ alerts: await monitor.alerts(req.account.id, { unreadOnly: req.query.unread === '1' }) })));
router.post('/v1/monitor/alerts/read', requireAuth, monitorCall(req => monitor.markRead(req.account.id, req.body?.ids)));

// ── AI agents: each agent's switch, schedule and settings; the runs happen in the worker ──
const myAgents = require('../services/myAgents');
const agentCall = fn => async (req, res) => {
  try { res.json(await fn(req)); } catch (err) {
    if (err instanceof myAgents.AgentsRefused) return res.status(err.status).json({ error: 'refused', message: err.message, ...(err.offer ? { offer: err.offer } : {}) });
    res.status(500).json({ error: 'internal', message: 'Something went wrong; try again.' });
  }
};
router.get('/v1/my-agents/catalog', (_req, res) => res.json({ agents: myAgents.catalog() }));
router.get('/v1/my-agents', requireAuth, agentCall(req => myAgents.list(req.account.id)));
router.patch('/v1/my-agents/:id', requireAuth, agentCall(req => myAgents.update(req.account.id, req.params.id, req.body || {})));

// ── Where alerts go: Telegram, email, browser push ──
const alertChannels = require('../alerts/channels');
const alertDispatch = require('../alerts/dispatch');
const channelCall = fn => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    if (err instanceof alertChannels.ChannelRefused) return res.status(err.status).json({ error: 'refused', message: err.message });
    throw err;
  }
};
router.get('/v1/alerts/channels', requireAuth, channelCall(req => alertChannels.list(req.account.id)));
router.post('/v1/alerts/channels/telegram', requireAuth, channelCall(req => alertChannels.startTelegram(req.account.id)));
router.post('/v1/alerts/channels/email', requireAuth, channelCall(req => alertChannels.startEmail(req.account.id, req.body?.email)));
router.post('/v1/alerts/channels/push', requireAuth, channelCall(req => alertChannels.addPush(req.account.id, req.body?.subscription, req.body?.label)));
router.patch('/v1/alerts/channels/:id', requireAuth, channelCall(req => alertChannels.update(req.account.id, req.params.id, req.body || {})));
router.delete('/v1/alerts/channels/:id', requireAuth, channelCall(req => alertChannels.remove(req.account.id, req.params.id)));
router.post('/v1/alerts/test', requireAuth, channelCall(req => alertDispatch.sendTest(req.account.id)));
// Telegram calls this when someone starts or stops the bot (secret header checked).
router.post('/v1/telegram/webhook', channelCall(req => alertChannels.telegramUpdate(req.headers, req.body)));
// Links from emails: they land on the page with the outcome.
router.get('/v1/alerts/confirm-email', async (req, res) => {
  const ok = await alertChannels.confirmEmail(req.query.code);
  res.redirect(302, `/safety?email=${ok ? 'confirmed' : 'expired'}#monitor-card`);
});
const unsubscribe = async (req, res) => {
  const ok = await alertChannels.unsubscribe(req.query.c, req.query.t);
  if (req.method === 'POST') return res.status(ok ? 200 : 400).json({ ok });
  res.redirect(302, `/safety?email=${ok ? 'unsubscribed' : 'bad-link'}#monitor-card`);
};
router.get('/v1/alerts/unsubscribe', unsubscribe);
router.post('/v1/alerts/unsubscribe', unsubscribe); // one-click unsubscribe (RFC 8058)

// ── The pre-sign check (the extension calls it before a wallet signs) ──
const presign = require('../services/presign');
router.post('/v1/presign/check', paidRoute('presign_check', {
  validate: req => { try { return presign.parse(req.body); } catch (err) { if (err instanceof presign.PresignRefused) return { error: err.message }; throw err; } },
  run: input => presign.check(input),
  record: input => ({ method: input.method, chain_id: input.chainId }), // not what was signed, nor where
}));

// ── Linking the browser extension ──
const extensionTokens = require('../auth/extensionTokens');
router.post('/v1/extension/tokens', requireAuth, async (req, res) => {
  if (req.account.scope) return res.status(403).json({ error: 'forbidden', message: 'Sign in on rektbull.com to link the extension.' });
  res.status(201).json(await extensionTokens.issue(req.account, req.body?.label));
});
router.get('/v1/extension/tokens', requireAuth, async (req, res) => res.json({ tokens: await extensionTokens.list(req.account.id) }));
router.delete('/v1/extension/tokens/:jti', requireAuth, async (req, res) => {
  const ok = await extensionTokens.revoke(req.account.id, req.params.jti);
  res.status(ok ? 200 : 404).json(ok ? { ok } : { error: 'not_found' });
});

router.use(require('./trading'));

// ── Admin ───────────────────────────────────────────────────────────────────
router.get('/v1/admin/provider-usage', requireAuth, requireAdmin, async (_req, res) => res.json({ usage: await usage.report(), ai: await claude.usageReport() }));

// Airdrops for the finder: each is checked when added (root onchain, proofs, a simulated claim).
router.get('/v1/admin/airdrops', requireAuth, requireAdmin, claimCall(async () => ({ programs: await claims.programs({ all: true }) })));
router.post('/v1/admin/airdrops', requireAuth, requireAdmin, validated(claims.parseProgram), claimCall(req => claims.addProgram(req.input, req.account.id)));
router.patch('/v1/admin/airdrops/:id', requireAuth, requireAdmin, claimCall(req => {
  if (!/^\d+$/.test(req.params.id)) throw new claims.ClaimRefused('No such airdrop.', 404);
  return claims.setActive(req.params.id, req.body?.active);
}));

// The admin panel (/admin): prices, agents, emergency stops (src/routes/admin.js).
router.use(require('./admin'));

module.exports = router;
