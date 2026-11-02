/**
 * What RektBull sells, at what price, and how each thing can be paid for.
 * Crypto only: x402 (USDC per call), or credits topped up with USDT/USDC.
 *
 * x402 note: x402 client libraries default to refusing payments over about
 * $1 a call unless the payer raises that limit (soyjak-agentic's own agent
 * wallets use the same $1 default). Products above $1 still accept x402 for
 * payers who raised it, but the main way to buy them is credits.
 */
const X402_DEFAULT_CLIENT_CAP_CENTS = 100;

const PRODUCTS = {
  token_quick_check: {
    kind: 'run',
    title: 'Token quick check',
    description: 'Can it be sold, what does it tax, what can the owner do, how concentrated are holders.',
    price_cents: 25,
    x402: true,
    free_per_day: 5, // for signed-in wallets
  },
  token_report: {
    kind: 'run',
    title: 'Token due diligence report',
    description: 'The full scan plus liquidity, volume and age, explained in plain English.',
    price_cents: 300,
    x402: true,
    free_per_day: 0,
  },
  approval_cleanup: {
    kind: 'run',
    title: 'Approval cleanup',
    description: 'Every token and NFT permission your wallet has given, on six chains: which are risky and why, how much they could take, and the transactions to revoke them (your wallet signs).',
    price_cents: 500,
    x402: true,
    free_per_day: 0,
  },
  pro_30d: {
    kind: 'pass',
    title: 'RektBull Pro, 30 days',
    description: 'Unlimited quick checks for 30 days (fair use: 200 a day). Prepaid; nothing renews automatically.',
    price_cents: 900,
    x402: false,
    days: 30,
    covers: ['token_quick_check'],
    fair_use_per_day: 200,
  },
  pro_365d: {
    kind: 'pass',
    title: 'RektBull Pro, 365 days',
    description: 'Unlimited quick checks for a year (fair use: 200 a day). Prepaid; nothing renews automatically.',
    price_cents: 7900,
    x402: false,
    days: 365,
    covers: ['token_quick_check'],
    fair_use_per_day: 200,
  },
};

function product(id) {
  const p = PRODUCTS[id];
  if (!p) throw Object.assign(new Error(`unknown product ${id}`), { status: 400 });
  return { id, ...p };
}

/** The ways a product can be paid for, in the order they're tried. */
function rails(p) {
  const out = [];
  if (p.kind === 'run') out.push('pass', 'free', 'credits');
  else out.push('credits');
  if (p.x402) out.push('x402');
  return out.filter(r => r !== 'free' || p.free_per_day > 0);
}

const usd = cents => `$${(cents / 100).toFixed(2)}`;

function publicCatalog() {
  return Object.keys(PRODUCTS).map(id => {
    const p = product(id);
    return {
      id, kind: p.kind, title: p.title, description: p.description,
      price_cents: p.price_cents, price_usd: usd(p.price_cents),
      pay_with: rails(p),
      ...(p.free_per_day ? { free_per_day: p.free_per_day } : {}),
      ...(p.days ? { days: p.days, covers: p.covers } : {}),
      ...(p.x402 && p.price_cents > X402_DEFAULT_CLIENT_CAP_CENTS ? { x402_note: 'Above the $1 default limit of most x402 clients: raise your client\'s limit, or pay with credits.' } : {}),
    };
  });
}

module.exports = { PRODUCTS, product, rails, publicCatalog, usd, X402_DEFAULT_CLIENT_CAP_CENTS };
