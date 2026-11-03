/**
 * What RektBull sells, at what price, and how each thing can be paid for.
 * Crypto only: x402 (USDC per call), credits topped up with USDT/USDC, and
 * claim fees (a share of claimed tokens, in a transfer the user signs).
 *
 * x402 note: x402 client libraries default to refusing payments over about
 * $1 a call unless the payer raises that limit (soyjak-agentic's own agent
 * wallets use the same $1 default). Products above $1 still accept x402 for
 * payers who raised it, but the main way to buy them is credits.
 */
const X402_DEFAULT_CLIENT_CAP_CENTS = 100;

/**
 * Free points: every signed-in wallet gets this many a month (UTC), spent on
 * the runs that have a `points` cost. Wallets with no transactions yet get
 * fewer, so new wallets can't farm them. Reports aren't payable with points
 * (each one costs real AI money).
 */
const FREE_POINTS = { per_month: 30, new_wallet: 10, per_ip_per_day: 20 };

const SAFETY_PRO = {
  covers: ['token_quick_check', 'approval_cleanup', 'token_report', 'risk_monitor', 'presign_check', 'airdrop_claim', 'yield_proposals'],
  fair_use_per_day: { token_quick_check: 200, approval_cleanup: 20, presign_check: 500 },
  included_per_month: { token_report: 5 },
  monitor: { wallets: 3, every_hours: 24 },
};
const PRO_TEXT = 'Unlimited token checks and approval cleanups (fair use), 5 AI reports a month, pre-sign checks in the RektBull extension, the risk monitor (up to 3 wallets checked every day for new risky approvals, flagged or upgraded spenders, and stablecoin depegs), a 3% claim fee instead of 5% on airdrops and rewards you claim through RektBull, and yield proposals: where your stablecoins and ETH could earn more, with the moves prepared for your wallet to sign, and alerts when a venue you hold turns risky.';

const PRODUCTS = {
  token_quick_check: {
    kind: 'run',
    title: 'Token quick check',
    description: 'Can it be sold, what does it tax, what can the owner do, how concentrated are holders.',
    price_cents: 25,
    points: 1,
    x402: true,
  },
  token_report: {
    kind: 'run',
    title: 'Token due diligence report',
    description: 'The full scan plus liquidity, volume and age, explained in plain English.',
    price_cents: 300,
    points: null,
    x402: true,
  },
  presign_check: {
    kind: 'run',
    title: 'Pre-sign check',
    description: 'Before you sign: what a transaction or signature would do, simulated, with every spender, recipient and the site itself checked.',
    price_cents: 10,
    points: 1,
    x402: true,
  },
  approval_cleanup: {
    kind: 'run',
    title: 'Approval cleanup',
    description: 'Every token and NFT permission your wallet has given, on six chains: which are risky and why, how much they could take, and the transactions to revoke them (your wallet signs).',
    price_cents: 100,
    points: 5,
    x402: true,
  },
  // Find money: not charged through the gate. When RektBull prepares a claim,
  // a share of the claimed tokens goes to RektBull's fee wallet in a plain
  // transfer the user signs next to the claim (no approval; RektBull holds
  // nothing). Checking is free; claiming directly on the project's site is too.
  airdrop_claim: {
    kind: 'fee',
    title: 'Claim fee',
    description: 'Checking for unclaimed airdrops and rewards is free. Claim through RektBull and a share of what you receive is sent to RektBull in a separate transfer you sign with the claim. Free when the tokens can\'t be transferred yet, or the fee is worth less than its gas.',
    price_cents: 0,
    fee_bps: 500,
    pro_fee_bps: 300,
    x402: false,
  },
  // Yield proposals are in Safety Pro; each move RektBull prepares carries a
  // 0.1% fee, a plain transfer in the moved asset that the user signs with
  // the move (exits to the wallet are free).
  yield_move: {
    kind: 'fee',
    title: 'Yield move fee',
    description: 'Yield proposals are part of Safety Pro. Each move RektBull prepares carries 0.1% of the amount moved, sent to RektBull in a transfer you sign with the move. Withdrawals to your wallet are free.',
    price_cents: 0,
    fee_bps: 10,
    pro_fee_bps: 10,
    x402: false,
  },
  pro_30d: {
    kind: 'pass',
    title: 'Safety Pro, 30 days',
    description: `${PRO_TEXT} Prepaid; nothing renews automatically.`,
    price_cents: 900,
    x402: false,
    days: 30,
    ...SAFETY_PRO,
  },
  pro_365d: {
    kind: 'pass',
    title: 'Safety Pro, 365 days',
    description: `${PRO_TEXT} Prepaid; nothing renews automatically.`,
    price_cents: 7900,
    x402: false,
    days: 365,
    ...SAFETY_PRO,
  },
};

function product(id) {
  const p = PRODUCTS[id];
  if (!p) throw Object.assign(new Error(`unknown product ${id}`), { status: 400 });
  return { id, ...p };
}

/** The ways a product can be paid for, in the order they're tried. */
function rails(p) {
  if (p.kind === 'fee') return ['claim_transfer'];
  const out = [];
  if (p.kind === 'run') out.push('pass', 'points', 'credits');
  else out.push('credits');
  if (p.x402) out.push('x402');
  return out.filter(r => r !== 'points' || p.points > 0);
}

const usd = cents => `$${(cents / 100).toFixed(2)}`;

function publicCatalog() {
  return Object.keys(PRODUCTS).map(id => {
    const p = product(id);
    return {
      id, kind: p.kind, title: p.title, description: p.description,
      price_cents: p.price_cents, price_usd: usd(p.price_cents),
      pay_with: rails(p),
      ...(p.points ? { points: p.points } : {}),
      ...(p.kind === 'fee' ? { fee_bps: p.fee_bps, pro_fee_bps: p.pro_fee_bps } : {}),
      ...(p.days ? { days: p.days, covers: p.covers, fair_use_per_day: p.fair_use_per_day, included_per_month: p.included_per_month } : {}),
      ...(p.x402 && p.price_cents > X402_DEFAULT_CLIENT_CAP_CENTS ? { x402_note: 'Above the $1 default limit of most x402 clients: raise your client\'s limit, or pay with credits.' } : {}),
    };
  });
}

module.exports = { PRODUCTS, FREE_POINTS, SAFETY_PRO, product, rails, publicCatalog, usd, X402_DEFAULT_CLIENT_CAP_CENTS };
