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
const settings = require('../admin/settings');

/** What an admin may change in the admin panel (/admin), within these limits. Anything else is fixed here. */
const DEFAULT_FREE_POINTS = { per_month: 30, new_wallet: 10, per_ip_per_day: 20 };
const DEFAULT_AI_ALLOWANCE_CENTS = 200;
const LIMITS = {
  price_cents: { run: [1, 100000], pass: [100, 100000] }, // $0.01 to $1,000 a run; $1 to $1,000 a pass
  points: [1, 100],
  fee_bps: [0, 1000], // a claim fee of at most 10%
  free_points: [0, 1000],
};
/** Fees that aren't the panel's to change, and why. */
const FIXED = { yield_move: 'Fixed at 0.1%: the audited Yield Router charges exactly this, so the prepared moves must too.' };

/**
 * Free points: every signed-in wallet gets this many a month (UTC), spent on
 * the runs that have a `points` cost. Wallets with no transactions yet get
 * fewer, so new wallets can't farm them. Reports aren't payable with points
 * (each one costs real AI money).
 */
const FREE_POINTS = Object.defineProperties({}, Object.fromEntries(Object.keys(DEFAULT_FREE_POINTS).map(k => [k, {
  enumerable: true, get: () => settings.get('free_points')?.[k] ?? DEFAULT_FREE_POINTS[k],
}])));

const SAFETY_PRO = {
  covers: ['token_quick_check', 'approval_cleanup', 'token_report', 'risk_monitor', 'presign_check', 'airdrop_claim', 'yield_proposals', 'governance_summary', 'launch_check'],
  fair_use_per_day: { token_quick_check: 200, approval_cleanup: 20, presign_check: 500, launch_check: 30 },
  // AI runs are counted at what they cost RektBull in Claude usage, up to $2 in each 30 days of the
  // pass (src/payments/aiAllowance.js); then they're paid like any other run.
  ai_allowance: Object.defineProperties({ uses: ['token_report', 'governance_summary'] }, {
    cents_per_30_days: { enumerable: true, get: () => settings.get('ai_allowance')?.cents_per_30_days ?? DEFAULT_AI_ALLOWANCE_CENTS },
  }),
  monitor: { wallets: 3, every_hours: 24 },
};
const PRO_TEXT = 'Unlimited token checks and approval cleanups (fair use), an AI allowance every 30 days for full token reports and proposal summaries (about 20 reports; an answer already written for someone else uses none of it; once it is used up, they are paid like any run until it resets), pre-sign checks in the RektBull extension, the risk monitor (up to 3 wallets checked every day for new risky approvals, flagged or upgraded spenders, and stablecoin depegs), a 3% claim fee instead of 5% on airdrops and rewards you claim through RektBull, yield proposals (where your stablecoins and ETH could earn more, with the moves prepared for your wallet to sign, and alerts when a venue you hold turns risky), and DAO votes: alerts when a vote opens or is about to close for a wallet you watch.';

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
  launch_check: {
    kind: 'run',
    title: 'Launch check',
    description: 'Was a new token\'s early supply bundled by insiders, and are they selling? The largest buyers in its first hour, where each one\'s funds came from, wallets sharing a funder, links back to the deployer, and what they hold now. Every finding with its source.',
    price_cents: 50,
    points: 2,
    x402: true,
  },
  contract_audit: {
    kind: 'run',
    title: 'Contract audit',
    description: 'A first-pass security review of a verified contract (and a proxy\'s implementation): Slither\'s ~100 detectors on the contract compiled as it was verified, pattern checks from an audit checklist, the compiler\'s known bugs, and who holds power over it, explained in plain English, with a downloadable PDF report. Flags for a person to confirm, not a full audit. Not financial advice.',
    price_cents: 9900,
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
  governance_summary: {
    kind: 'run',
    title: 'Proposal summary',
    description: 'A DAO proposal in plain English, from its own text: what would change, what money and powers it moves, what each choice does, and what the text doesn\'t say. Never a recommendation.',
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

/** The fields of a product an admin may change. */
function editable(id) {
  const p = PRODUCTS[id];
  if (!p || FIXED[id]) return [];
  if (p.kind === 'run') return p.points ? ['price_cents', 'points'] : ['price_cents'];
  if (p.kind === 'pass') return ['price_cents'];
  if (p.kind === 'fee') return ['fee_bps', 'pro_fee_bps'];
  return [];
}

/** A product as sold now: its defaults here, with any price an admin set. */
function product(id) {
  const p = PRODUCTS[id];
  if (!p) throw Object.assign(new Error(`unknown product ${id}`), { status: 400 });
  const set = settings.get(`price:${id}`) || {};
  const over = Object.fromEntries(editable(id).filter(k => Number.isInteger(set[k])).map(k => [k, set[k]]));
  return { id, ...p, ...over };
}

const refused = message => Object.assign(new Error(message), { status: 400 });
const inRange = (name, v, [lo, hi], show = x => x) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw refused(`${name} must be a whole number from ${show(lo)} to ${show(hi)}.`);
  return v;
};

/** Checks an admin's new prices for a product; returns what to store (only what differs from the default), or null. */
function checkPrice(id, input) {
  const p = PRODUCTS[id];
  if (!p) throw Object.assign(new Error(`unknown product ${id}`), { status: 404 });
  if (FIXED[id]) throw refused(FIXED[id]);
  const fields = editable(id);
  const unknown = Object.keys(input).filter(k => !fields.includes(k));
  if (unknown.length) throw refused(`${p.title}: only ${fields.join(', ')} can be changed here (not ${unknown.join(', ')}).`);
  if (!Object.keys(input).length) throw refused(`Nothing to change: send ${fields.join(' or ')}.`);
  const now = product(id);
  const next = { ...Object.fromEntries(fields.map(k => [k, now[k]])), ...input };
  if ('price_cents' in input) inRange('price_cents', input.price_cents, LIMITS.price_cents[p.kind], short);
  if ('points' in input) inRange('points', input.points, LIMITS.points);
  for (const k of ['fee_bps', 'pro_fee_bps']) if (k in input) inRange(k, input[k], LIMITS.fee_bps, b => `${b / 100}%`);
  if (p.kind === 'fee' && next.pro_fee_bps > next.fee_bps) throw refused('The Safety Pro fee can\'t be more than the standard fee.');
  const differs = Object.fromEntries(fields.filter(k => next[k] !== p[k]).map(k => [k, next[k]]));
  return Object.keys(differs).length ? differs : null;
}

function checkFreePoints(input) {
  const unknown = Object.keys(input).filter(k => !(k in DEFAULT_FREE_POINTS));
  if (unknown.length) throw refused(`Free points: only ${Object.keys(DEFAULT_FREE_POINTS).join(', ')} can be changed.`);
  for (const [k, v] of Object.entries(input)) inRange(k, v, LIMITS.free_points);
  const next = { ...FREE_POINTS, ...input };
  if (next.new_wallet > next.per_month) throw refused('A new wallet can\'t get more points than everyone else.');
  const differs = Object.fromEntries(Object.keys(DEFAULT_FREE_POINTS).filter(k => next[k] !== DEFAULT_FREE_POINTS[k]).map(k => [k, next[k]]));
  return Object.keys(differs).length ? differs : null;
}

/** The AI allowance can't be more than a 30-day pass costs, so a pass never loses money on AI. */
function checkAiAllowance(cents) {
  inRange('cents_per_30_days', cents, [0, product('pro_30d').price_cents], short);
  return cents === DEFAULT_AI_ALLOWANCE_CENTS ? null : { cents_per_30_days: cents };
}

const PRICE_FIELDS = ['price_cents', 'points', 'fee_bps', 'pro_fee_bps'];
const priceFields = p => Object.fromEntries(PRICE_FIELDS.filter(k => p[k] !== undefined && p[k] !== null).map(k => [k, p[k]]));

/** Everything the admin panel shows for prices: defaults, what's set now, and what can change. */
function adminPrices() {
  return {
    products: Object.keys(PRODUCTS).map(id => {
      const p = PRODUCTS[id], fields = editable(id);
      return {
        id, kind: p.kind, title: p.title, editable: fields, fixed: FIXED[id] || null,
        defaults: priceFields(p), current: priceFields(product(id)), changed: !!settings.get(`price:${id}`),
        limits: Object.fromEntries(fields.map(k => [k, k === 'price_cents' ? LIMITS.price_cents[p.kind] : k === 'points' ? LIMITS.points : LIMITS.fee_bps])),
      };
    }),
    free_points: { defaults: DEFAULT_FREE_POINTS, current: { ...FREE_POINTS }, changed: !!settings.get('free_points'), limits: LIMITS.free_points },
    ai_allowance: { default_cents: DEFAULT_AI_ALLOWANCE_CENTS, cents_per_30_days: SAFETY_PRO.ai_allowance.cents_per_30_days, changed: !!settings.get('ai_allowance'), limits: [0, product('pro_30d').price_cents] },
  };
}

/** "$9", "$0.25": a price as the pages write it. */
const short = cents => (cents % 100 === 0 ? `$${(cents / 100).toLocaleString('en-US')}` : `$${(cents / 100).toFixed(2)}`);

/**
 * Puts today's prices into page text: {{price:id}} "$9", {{usd:id}} "9" (for
 * structured data), {{points:id}} "5", {{fee:id}} and {{profee:id}} "5%",
 * {{free_points}} "30", {{ai_allowance}} "$2". Anything else is left as it is.
 */
function fill(text) {
  return String(text).replace(/\{\{(price|usd|points|fee|profee):([a-z0-9_]+)\}\}|\{\{(free_points|ai_allowance)\}\}/g, (m, kind, id, single) => {
    if (single === 'free_points') return String(FREE_POINTS.per_month);
    if (single === 'ai_allowance') return short(SAFETY_PRO.ai_allowance.cents_per_30_days);
    if (!PRODUCTS[id]) return m;
    const p = product(id);
    if (kind === 'price') return short(p.price_cents);
    if (kind === 'usd') return String(p.price_cents / 100);
    if (kind === 'points') return p.points ? String(p.points) : m;
    if (kind === 'fee') return p.fee_bps === undefined ? m : `${p.fee_bps / 100}%`;
    return p.pro_fee_bps === undefined ? m : `${p.pro_fee_bps / 100}%`;
  });
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
      ...(SAFETY_PRO.ai_allowance.uses.includes(id) ? { in_pro_ai_allowance: true } : {}),
      ...(p.days ? { days: p.days, covers: p.covers, fair_use_per_day: p.fair_use_per_day, ai_allowance_usd_per_30_days: p.ai_allowance.cents_per_30_days / 100 } : {}),
      ...(p.x402 && p.price_cents > X402_DEFAULT_CLIENT_CAP_CENTS ? { x402_note: 'Above the $1 default limit of most x402 clients: raise your client\'s limit, or pay with credits.' } : {}),
    };
  });
}

module.exports = { PRODUCTS, FREE_POINTS, SAFETY_PRO, product, rails, publicCatalog, usd, short, fill, editable, checkPrice, checkFreePoints, checkAiAllowance, adminPrices, X402_DEFAULT_CLIENT_CAP_CENTS };
