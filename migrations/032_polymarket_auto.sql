-- Automatic Polymarket trading through RektBull's Session Key (docs/POLYMARKET.md, "Automatic trading").
-- A session is one user's authorization of RektBull's key for their Deposit Wallet, with the limits
-- RektBull keeps to (not enforced onchain: Polymarket has no such limits) and the user's own stop date.
CREATE TABLE polymarket_sessions (
  id               UUID PRIMARY KEY,
  account_id       BIGINT NOT NULL REFERENCES accounts(id),
  signer           TEXT NOT NULL,              -- the Deposit Wallet's owner (the user's own key)
  wallet           TEXT NOT NULL,              -- the Deposit Wallet
  session_signer   TEXT NOT NULL,              -- RektBull's Session Key (public address; the key is in KMS)
  valid_until      BIGINT NOT NULL,            -- Polymarket's fixed term: 180 days (unix seconds)
  stop_at          TIMESTAMPTZ NOT NULL,       -- the user's own, earlier stop: RektBull places nothing after it
  max_order_usd    NUMERIC(14, 2) NOT NULL,
  max_day_usd      NUMERIC(14, 2) NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked', 'failed', 'ended')),
  batch_id         UUID,                       -- the authorization the owner signed
  country          TEXT,                       -- where the user was when they turned it on, and last seen
  seen_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX polymarket_sessions_one_live ON polymarket_sessions (account_id) WHERE status IN ('pending', 'active');

-- Each automated entry: what was asked, what Polymarket filled, and RektBull's fee on the fill.
CREATE TABLE polymarket_auto_orders (
  id             UUID PRIMARY KEY,
  account_id     BIGINT NOT NULL REFERENCES accounts(id),
  session_id     UUID NOT NULL REFERENCES polymarket_sessions(id),
  forecast_id    BIGINT REFERENCES ai_forecasts(id),
  market         TEXT NOT NULL,
  asset_id       TEXT NOT NULL,
  outcome        TEXT,
  amount_usd     NUMERIC(14, 2) NOT NULL,
  price_limit    NUMERIC(10, 6) NOT NULL,
  status         TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'filled', 'unfilled', 'refused', 'failed')),
  clob_order_id  TEXT,
  filled_usd     NUMERIC(14, 4),
  fee_usd        NUMERIC(10, 4),
  fee_paid_from  TEXT,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, forecast_id)
);
CREATE INDEX polymarket_auto_orders_account ON polymarket_auto_orders (account_id, created_at DESC);
