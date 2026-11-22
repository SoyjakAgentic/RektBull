/**
 * Service switches, set in the admin panel: any service RektBull offers can be
 * paused, and switched back on, without a deploy. The owner asked for this on
 * 22 November 2026 ("from the admin panel, we should be able to suspend
 * services, not limited to this, but every service").
 *
 * The rule everywhere: pausing stops new work. It never stops a user getting
 * out: selling, closing, cancelling, withdrawing, redeeming and revoking stay
 * open, as with region blocks. A paused paid run is refused before any charge.
 * Read from the database on each request (settings.read), so a switch takes
 * effect at once on every instance.
 *
 * AI agents, the emergency stops and the AI forecasts and picks have their own
 * switches (agentStates.js, stops.js, forecasts/settings.js); they aren't
 * repeated here.
 */
const settings = require('./settings');

const SERVICES = {
  // Paid runs (payments/gate.js): refused before any charge.
  token_quick_check: { name: 'Token quick check', group: 'Checks', stops: 'New checks.' },
  token_report: {
    name: 'Token due diligence report', group: 'Checks', stops: 'New reports.',
    // The owner held it off on 22 November 2026: competitors' scanners are free, and a free report has an AI cost per token.
    default_paused: true,
  },
  launch_check: { name: 'Launch check (bundles and insiders)', group: 'Checks', stops: 'New checks run on their own (the Trade desk still runs it before a buy).' },
  presign_check: { name: 'Pre-sign check', group: 'Checks', stops: 'New checks from the page, the extension and the MetaMask Snap.' },
  governance_summary: { name: 'Proposal summary', group: 'Checks', stops: 'New summaries.' },
  approval_cleanup: { name: 'Approval cleanup', group: 'Checks', stops: 'New cleanups. Revokes the wallet already signed still go through.' },
  // Desks.
  trade: { name: 'Trade desk (swaps, including Launches buys)', group: 'Trading', stops: 'Buys, and new automatic-trading permissions and intents.', open: 'Sells, cancels and revokes.' },
  perps: { name: 'Perps (Hyperliquid)', group: 'Trading', stops: 'Opening or adding to positions, leverage and margin changes, and new agent approvals.', open: 'Closing, cancelling and revoking.' },
  predictions: { name: 'Predictions (Polymarket)', group: 'Trading', stops: 'Buys, approvals, wallet set-up, funding and new automatic trading.', open: 'Selling, redeeming, withdrawing, stopping automatic trading, and sending what was already prepared.' },
  yield: { name: 'Yield moves', group: 'Find money', stops: 'Deposits and moves, and new automatic permissions.', open: 'Withdrawals to the wallet and revokes.' },
  claims: { name: 'Airdrop and unclaimed-funds finder', group: 'Find money', stops: 'New checks and claims.', open: 'Confirming a claim the wallet already sent.' },
  governance_votes: { name: 'Governance votes', group: 'Save money', stops: 'Preparing and sending new votes.' },
  checkup: { name: 'Free wallet checkup', group: 'Home', stops: 'New checkups.' },
};

class ServicePaused extends Error {
  constructor(id) {
    const s = SERVICES[id];
    super(`${s.name} is paused by RektBull for now. Nothing was charged.${s.open ? ` Still open: ${s.open}` : ''}`);
    this.status = 503; this.code = 'service_paused'; this.service = id;
  }
}

const key = id => `service:${id}`;
const known = id => Object.prototype.hasOwnProperty.call(SERVICES, id);
const pausedOf = (id, v) => (v && typeof v.paused === 'boolean' ? v.paused : !!SERVICES[id].default_paused);

/** Is it paused? Read from the database, never the minute-old copy. */
async function isPaused(id) {
  if (!known(id)) throw new Error(`unknown service ${id}`);
  return pausedOf(id, await settings.read(key(id)));
}

/** Throws ServicePaused (503) when it is; for routes. Ids that aren't services pass. */
async function refuseIfPaused(id) {
  if (known(id) && await isPaused(id)) throw new ServicePaused(id);
}

/** Express middleware: refuses while paused, unless `exit(req)` says this request is a way out. */
function gate(id, exit = () => false) {
  if (!known(id)) throw new Error(`unknown service ${id}`);
  return async (req, res, next) => {
    try {
      if (!exit(req)) await refuseIfPaused(id);
      next();
    } catch (err) {
      if (err instanceof ServicePaused) return res.status(503).json({ error: 'service_paused', service: id, message: err.message });
      next(err);
    }
  };
}

/** Pauses or resumes one service, logged with the admin's reason. */
async function set(id, paused, { wallet, reason }) {
  if (!known(id)) throw Object.assign(new Error('No such service.'), { status: 404 });
  if (typeof paused !== 'boolean') throw Object.assign(new Error('paused must be true or false.'), { status: 400 });
  // Stored only when it differs from the service's default, so "back to the default" is a null.
  const value = paused === !!SERVICES[id].default_paused ? null : { paused };
  await settings.set(key(id), value, { wallet, action: paused ? 'service_paused' : 'service_resumed', reason });
  return { id, paused };
}

/** Paused, from the settings' minute-old copy: for pages and the catalog, never for refusing (that reads the database). */
function pausedNow(id) {
  return known(id) && pausedOf(id, settings.get(key(id)));
}

async function list() {
  return Promise.all(Object.entries(SERVICES).map(async ([id, s]) => ({
    id, name: s.name, group: s.group, stops: s.stops, open: s.open || null, default_paused: !!s.default_paused, paused: await isPaused(id),
  })));
}

module.exports = { SERVICES, ServicePaused, isPaused, refuseIfPaused, gate, set, list, pausedNow };
