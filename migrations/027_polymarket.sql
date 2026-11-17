-- Polymarket (docs/POLYMARKET.md). RektBull never holds a user's funds, keys or
-- CLOB API credentials: these tables hold what it prepared for a wallet to
-- sign, what the user's browser reported back, and what Polymarket's public
-- builder-trades feed says filled.

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
  source        TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'rule', 'auto')),
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

-- Fills carrying RektBull's builder code, from Polymarket's public builder-trades feed.
-- One row per trade and side, so reading the feed again never counts a fill twice.
-- The fee is charged and paid out by Polymarket; fee_usd is what the builder rate makes it.
CREATE TABLE polymarket_fills (
  trade_id          TEXT NOT NULL,
  trade_type        TEXT NOT NULL,          -- TAKER or MAKER
  order_hash        TEXT NOT NULL DEFAULT '',
  maker             TEXT NOT NULL,          -- the wallet that traded
  account_id        BIGINT REFERENCES accounts(id) ON DELETE SET NULL,
  order_id          UUID,
  asset_id          TEXT,
  condition_id      TEXT,
  side              TEXT,
  shares            NUMERIC NOT NULL,
  price             NUMERIC NOT NULL,
  notional_usd      NUMERIC NOT NULL,
  fee_bps           INTEGER NOT NULL,
  fee_usd           NUMERIC NOT NULL,
  polymarket_fee_usd NUMERIC,               -- Polymarket's own fee on the trade, as the feed reports it
  status            TEXT,
  tx_hash           TEXT,
  matched_at        TIMESTAMPTZ,
  seen_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (trade_id, trade_type, order_hash)
);
CREATE INDEX polymarket_fills_matched ON polymarket_fills (matched_at DESC);
CREATE INDEX polymarket_fills_account ON polymarket_fills (account_id, matched_at DESC);

-- Price rules: "buy/sell this outcome when its price reaches X". When one triggers, the order is
-- proposed for the user to sign, or placed with a Session Key when the user granted one.
CREATE TABLE polymarket_rules (
  id            UUID PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  wallet        TEXT NOT NULL,
  signer        TEXT NOT NULL,
  wallet_type   TEXT NOT NULL,
  asset_id      TEXT NOT NULL,
  market_slug   TEXT,
  title         TEXT,
  outcome       TEXT,
  side          TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  trigger_price NUMERIC NOT NULL,          -- BUY: when the best ask is at or below; SELL: when the best bid is at or above (take profit) ...
  stop_price    NUMERIC,                   -- ... or, for a SELL, at or below this (stop loss)
  amount_usd    NUMERIC,                   -- BUY: USD to spend, fees included
  shares        NUMERIC,                   -- SELL: shares to sell
  mode          TEXT NOT NULL DEFAULT 'propose' CHECK (mode IN ('propose', 'auto')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'proposed', 'placed', 'cancelled', 'expired', 'failed')),
  note          TEXT,
  order_id      UUID,
  expires_at    TIMESTAMPTZ NOT NULL,
  checked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX polymarket_rules_active ON polymarket_rules (checked_at NULLS FIRST) WHERE status = 'active';
CREATE INDEX polymarket_rules_account ON polymarket_rules (account_id, created_at DESC);

-- Polymarket Session Keys a user authorized for RektBull's key (the public address only), with the
-- limits RektBull's trade service keeps to. Polymarket enforces: trading only, no withdrawals, 180 days.
CREATE TABLE polymarket_sessions (
  id              UUID PRIMARY KEY,
  account_id      BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  signer          TEXT NOT NULL,           -- the Deposit Wallet's owner
  wallet          TEXT NOT NULL,           -- the Deposit Wallet
  session_signer  TEXT NOT NULL,           -- RektBull's key in KMS (public address)
  valid_until     BIGINT NOT NULL,         -- Polymarket's expiry (180 days)
  stop_at         TIMESTAMPTZ NOT NULL,    -- the user's own, shorter expiry: RektBull places nothing after it
  max_order_usd   NUMERIC NOT NULL,
  max_day_usd     NUMERIC NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked', 'failed')),
  batch_id        UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ
);
CREATE INDEX polymarket_sessions_account ON polymarket_sessions (account_id, status);
