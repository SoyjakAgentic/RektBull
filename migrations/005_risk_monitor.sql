-- The risk monitor (part of Safety Pro): wallets an account watches, what
-- the last check saw, and the alerts it raised.
CREATE TABLE monitored_wallets (
  id              BIGSERIAL PRIMARY KEY,
  account_id      BIGINT NOT NULL REFERENCES accounts(id),
  wallet          TEXT NOT NULL,
  label           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_check_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checked_at TIMESTAMPTZ,
  last_error      TEXT,
  snapshot        JSONB,                       -- what the last check saw, to compare with the next
  UNIQUE (account_id, wallet)
);
CREATE INDEX monitored_wallets_due ON monitored_wallets (next_check_at);

CREATE TABLE monitor_alerts (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  wallet_id   BIGINT REFERENCES monitored_wallets(id) ON DELETE SET NULL,
  wallet      TEXT NOT NULL,
  kind        TEXT NOT NULL,                   -- new_approval, spender_flagged, spender_upgraded, depeg, watching_started
  severity    TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  title       TEXT NOT NULL,
  detail      JSONB NOT NULL DEFAULT '{}',
  dedupe_key  TEXT NOT NULL,                   -- the same thing is never alerted twice
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ,
  UNIQUE (account_id, dedupe_key)
);
CREATE INDEX monitor_alerts_account ON monitor_alerts (account_id, created_at DESC);
