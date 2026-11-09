-- The admin panel (/admin): what the owners changed, and a log of every change.
-- admin_settings holds only what differs from the defaults in the code:
--   price:<product>   { price_cents?, points?, fee_bps?, pro_fee_bps? }
--   free_points       { per_month?, new_wallet?, per_ip_per_day? }
--   ai_allowance      { cents_per_30_days }
--   agent:<id>        { state: 'hidden' | 'off' }
--   stop:<name>       { on: true }
-- A missing row means the default. Nothing here is a secret.
CREATE TABLE admin_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_log (
  id      BIGSERIAL PRIMARY KEY,
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  wallet  TEXT NOT NULL,
  action  TEXT NOT NULL,
  key     TEXT NOT NULL,
  before  JSONB,
  after   JSONB,
  reason  TEXT NOT NULL
);
CREATE INDEX admin_log_at ON admin_log (at DESC);
