-- NOWPayments: hosted invoices for credit top-ups and passes, paid in any
-- coin NOWPayments takes and forwarded to RektBull's payout wallet. Credited
-- once, through credit_ledger (ref nowpayments:<id>).
CREATE TABLE hosted_invoices (
  id            UUID PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES accounts(id),
  gateway       TEXT NOT NULL CHECK (gateway IN ('nowpayments')),
  amount_cents  INTEGER NOT NULL,
  product       TEXT,                  -- a pass bought once it's paid
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirming', 'underpaid', 'paid', 'expired')),
  np_invoice_id TEXT,
  np_payment_id TEXT,
  pay_currency  TEXT,
  invoice_url   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at       TIMESTAMPTZ
);
CREATE INDEX hosted_invoices_account ON hosted_invoices (account_id);
CREATE INDEX hosted_invoices_open ON hosted_invoices (status) WHERE status IN ('pending', 'confirming', 'expired');

-- Safety Pro renewal reminders: one of each kind per pass end date.
CREATE TABLE pass_reminders (
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  ends_at    TIMESTAMPTZ NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('7d', '1d', 'ended')),
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, ends_at, kind)
);
