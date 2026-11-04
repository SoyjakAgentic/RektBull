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

// ── Approval cleanup: a free preview (how many, how much at risk), then the paid cleanup ──
const PREVIEWS_PER_DAY = { account: 10, anonymous: 3 };

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
const CLAIM_LIMITS = { check: { account: 30, anonymous: 5 }, prepare: { account: 30, anonymous: 10 } };
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
const YIELD_LIMITS = { wallet: { account: 30, anonymous: 5 }, prepare: { account: 30, anonymous: 10 } };
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
const GOV_CHECKS = { account: 60, anonymous: 10 };
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
const FLAGS_PER_DAY = { account: 100, anonymous: 20 };
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

// ── Portfolio: what a wallet holds on six chains, its value, and the facts on each holding (free, a daily limit) ──
const portfolio = require('../services/portfolio');
const PORTFOLIO_PER_DAY = { account: 30, anonymous: 5 };
router.post('/v1/portfolio', validated(claims.parseWallet), async (req, res) => {
  const [subject, limit] = req.account ? [`account:${req.account.id}`, PORTFOLIO_PER_DAY.account] : [require('../privacy/ipKey').ipSubject(req.ip), PORTFOLIO_PER_DAY.anonymous];
  if (env.databaseUrl && !(await takeAllowance(subject, 'portfolio', limit))) {
    return res.status(429).json({ error: 'daily_limit', message: `Free portfolio reads are limited to ${limit} a day${req.account ? '' : ' without signing in (sign in for more)'}.` });
  }
  res.json(await portfolio.portfolio(req.input.wallet));
});

// ── Home: what a pasted address is, and a wallet's free checks from every desk at once ──
const home = require('../services/home');
const HOME_LIMITS = { lookup: { account: 120, anonymous: 30 }, checkup: { account: 10, anonymous: 3 } };
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

module.exports = router;
