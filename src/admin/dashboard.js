/**
 * The admin panel's dashboard: money in, runs, refunds, AI spend, passes and
 * accounts over the last N days, each figure from its own table (named in
 * `source`). Revenue is what reached RektBull: deposits and hosted checkouts
 * credited, and x402 payments settled. Credits spent on runs and passes are
 * shown too, but they're the same money spent, not new money.
 */
const db = require('../config/db');
const claude = require('../ai/claude');

async function summary(days = 30) {
  const d = Math.min(Math.max(Number(days) || 30, 1), 365);
  const q = (sql, params = []) => db.query(sql, [d, ...params]).then(r => r.rows);
  const [money, runs, failed, passes, accounts, active, claimFees, yieldFees, ai] = await Promise.all([
    q(`SELECT
         COALESCE(sum(delta_cents) FILTER (WHERE reason = 'deposit' AND ref LIKE 'deposit:%'), 0)::bigint AS deposits_cents,
         COALESCE(sum(delta_cents) FILTER (WHERE reason = 'deposit' AND ref LIKE 'nowpayments:%'), 0)::bigint AS hosted_checkout_cents,
         COALESCE(-sum(delta_cents) FILTER (WHERE reason = 'run'), 0)::bigint AS credits_on_runs_cents,
         COALESCE(-sum(delta_cents) FILTER (WHERE reason = 'pass'), 0)::bigint AS credits_on_passes_cents,
         COALESCE(sum(delta_cents) FILTER (WHERE reason = 'refund'), 0)::bigint AS refunded_cents,
         COALESCE(sum(delta_cents) FILTER (WHERE reason = 'adjustment'), 0)::bigint AS adjustments_cents
       FROM credit_ledger WHERE created_at > now() - make_interval(days => $1)`),
    q(`SELECT product, payment_method, count(*)::int AS runs, COALESCE(sum(price_cents), 0)::bigint AS cents
         FROM runs WHERE status = 'succeeded' AND created_at > now() - make_interval(days => $1)
        GROUP BY product, payment_method ORDER BY product, payment_method`),
    q(`SELECT product, count(*)::int AS runs, (array_agg(error ORDER BY created_at DESC))[1] AS last_error
         FROM runs WHERE status = 'failed' AND created_at > now() - make_interval(days => $1) GROUP BY product ORDER BY runs DESC`),
    q(`SELECT product, count(*)::int AS bought FROM passes WHERE created_at > now() - make_interval(days => $1) GROUP BY product`),
    q(`SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at > now() - make_interval(days => $1))::int AS new FROM accounts`),
    db.query(`SELECT count(DISTINCT account_id)::int AS n FROM passes WHERE starts_at <= now() AND ends_at > now()`).then(r => r.rows),
    q(`SELECT count(*)::int AS paid FROM claims WHERE fee_paid IS NOT NULL AND created_at > now() - make_interval(days => $1)`),
    q(`SELECT count(*)::int AS paid FROM yield_moves WHERE fee_paid_raw IS NOT NULL AND created_at > now() - make_interval(days => $1)`),
    claude.usageReport(d),
  ]);
  const m = money[0];
  const x402 = runs.filter(r => r.payment_method === 'x402').reduce((s, r) => s + Number(r.cents), 0);
  const byDay = {};
  for (const r of ai) {
    const day = new Date(r.day).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + (r.estimated_usd || 0);
  }
  return {
    days: d,
    revenue: {
      total_cents: Number(m.deposits_cents) + Number(m.hosted_checkout_cents) + x402,
      deposits_cents: Number(m.deposits_cents), hosted_checkout_cents: Number(m.hosted_checkout_cents), x402_cents: x402,
      claim_fees_paid: claimFees[0].paid, yield_fees_paid: yieldFees[0].paid,
      source: 'credit_ledger (deposits, hosted checkouts), runs (x402), claims and yield_moves (fees paid in the claimed or moved token; counted, not priced)',
    },
    spent_from_credits: { runs_cents: Number(m.credits_on_runs_cents), passes_cents: Number(m.credits_on_passes_cents), refunded_cents: Number(m.refunded_cents), adjustments_cents: Number(m.adjustments_cents), source: 'credit_ledger' },
    runs: runs.map(r => ({ ...r, cents: Number(r.cents) })), failed_runs: failed,
    passes: { bought: passes, active_accounts: active[0].n, source: 'passes' },
    accounts: { ...accounts[0], source: 'accounts' },
    ai: { total_usd: Math.round(Object.values(byDay).reduce((s, v) => s + v, 0) * 100) / 100, by_day: Object.entries(byDay).sort().map(([day, usd]) => ({ day, usd: Math.round(usd * 100) / 100 })), source: 'ai_usage (estimated at list prices)' },
  };
}

module.exports = { summary };
