-- Yield proposals: moves RektBull prepared for a wallet to sign (with the
-- 0.1% move fee, a plain transfer the user signs next to the move), kept as
-- payment records; and what the yield risk watcher remembers between passes.
CREATE TABLE yield_moves (
  id            UUID PRIMARY KEY,
  account_id    BIGINT REFERENCES accounts(id),
  wallet        TEXT NOT NULL,
  chain         TEXT NOT NULL,
  asset         TEXT NOT NULL,
  from_protocol TEXT,
  to_protocol   TEXT,                -- null: a withdrawal to the wallet (free)
  amount_raw    NUMERIC(78, 0) NOT NULL,
  fee_raw       NUMERIC(78, 0) NOT NULL DEFAULT 0,
  fee_bps       INTEGER NOT NULL DEFAULT 0,
  fee_wallet    TEXT,
  checks        JSONB,               -- the figures the rules decided on
  status        TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'confirmed', 'failed')),
  tx_hashes     JSONB,
  fee_paid_raw  NUMERIC(78, 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at  TIMESTAMPTZ
);
CREATE INDEX yield_moves_account ON yield_moves (account_id);
CREATE INDEX yield_moves_wallet ON yield_moves (wallet);

CREATE TABLE yield_risk_state (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
