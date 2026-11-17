-- Polymarket (docs/POLYMARKET.md). RektBull never holds a user's funds, keys or
-- CLOB API credentials: these tables hold what it prepared for a wallet to
-- sign, and what the user's browser reported back.

-- Orders RektBull prepared: by the user (manual), or proposed by a rule for the user to sign.
CREATE TABLE polymarket_orders (
  id            UUID PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  wallet        TEXT NOT NULL,            -- the Polymarket wallet (the order's maker)
  signer        TEXT NOT NULL,            -- the account's own key
  wallet_type   TEXT NOT NULL CHECK (wallet_type IN ('deposit', 'proxy', 'safe', 'eoa')),
  asset_id      TEXT NOT NULL,
  condition_id  TEXT,
  market_slug   TEXT,
  title         TEXT,
  outcome       TEXT,
  side          TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  order_type    TEXT NOT NULL CHECK (order_type IN ('GTC', 'GTD', 'FOK', 'FAK')),
  price         NUMERIC NOT NULL,
  shares        NUMERIC NOT NULL,
  notional_usd  NUMERIC NOT NULL,
  builder       TEXT NOT NULL,            -- the builder code signed into the order
  order_hash    TEXT NOT NULL,            -- the order's EIP-712 hash on its exchange
  source        TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'rule', 'auto')), -- rule and auto: not built yet
  rule_id       UUID,
  status        TEXT NOT NULL DEFAULT 'prepared'
                CHECK (status IN ('prepared', 'proposed', 'submitted', 'rejected', 'cancelled', 'expired')),
  prepared      JSONB NOT NULL,           -- the typed data, request body and summary handed to the wallet
  clob_order_id TEXT,
  clob_status   TEXT,                     -- live, matched, delayed, unmatched (as the CLOB answered)
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX polymarket_orders_account ON polymarket_orders (account_id, created_at DESC);
CREATE INDEX polymarket_orders_hash ON polymarket_orders (order_hash);
CREATE INDEX polymarket_orders_wallet ON polymarket_orders (wallet);

-- Wallet transactions prepared for a signature: approvals, redemptions, withdrawals,
-- Session Key grants and revocations. The relay sends only what is stored here.
CREATE TABLE polymarket_batches (
  id          UUID PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  signer      TEXT NOT NULL,
  wallet      TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('approvals', 'redeem', 'withdraw', 'session_authorize', 'session_revoke')),
  nonce       TEXT NOT NULL,
  deadline    BIGINT NOT NULL,
  calls       JSONB NOT NULL,
  detail      JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'submitted', 'confirmed', 'failed')),
  relayer_id  TEXT,
  tx_hash     TEXT,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX polymarket_batches_account ON polymarket_batches (account_id, created_at DESC);
