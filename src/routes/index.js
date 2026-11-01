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
const { paidRoute } = require('../payments/gate');
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
router.get('/v1/catalog', (_req, res) => res.json({ products: publicCatalog() }));

router.get('/v1/payment-methods', (_req, res) => res.json({
  x402: { enabled: x402.enabled(), network: env.x402Network, asset: 'USDC' },
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
  res.json({
    account: req.account,
    credits_cents: await credits.balance(req.account.id),
    passes: await passes.active(req.account.id),
  });
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

router.post('/v1/tokens/quick-check', paidRoute('token_quick_check', { validate: target, run: dd.quickCheck }));

router.post('/v1/tokens/report', paidRoute('token_report', {
  validate: req => (claude.available() ? target(req) : { error: 'Reports are not available yet: the AI key is not configured' }),
  run: dd.fullReport,
}));

router.use(require('./trading'));

// ── Admin ───────────────────────────────────────────────────────────────────
router.get('/v1/admin/provider-usage', requireAuth, requireAdmin, async (_req, res) => res.json({ usage: await usage.report() }));

module.exports = router;
