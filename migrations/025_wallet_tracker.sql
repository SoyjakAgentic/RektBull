-- The wallet tracker (Trade desk, stage 3): wallets an account follows, the
-- buys and sells read from the chain for them, and how far each chain has
-- been read. Addresses are stored for both families now so Solana needs no
-- schema change when it comes: EVM lowercased, Solana as given (base58 is
-- case-sensitive).
CREATE TABLE followed_wallets (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  address     TEXT NOT NULL,
  family      TEXT NOT NULL CHECK (family IN ('evm', 'solana')),
  label       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, address)
);
CREATE INDEX followed_wallets_address ON followed_wallets (address);

-- Public onchain facts about a followed wallet's trades (not tied to an account); kept 35 days.
CREATE TABLE wallet_trades (
  id          BIGSERIAL PRIMARY KEY,
  chain       TEXT NOT NULL,
  wallet      TEXT NOT NULL,
  tx_hash     TEXT NOT NULL,
  block       BIGINT NOT NULL,
  side        TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  token       TEXT NOT NULL,
  symbol      TEXT,
  amount      NUMERIC,                     -- whole tokens; null when the token's decimals couldn't be read
  other       JSONB NOT NULL DEFAULT '{}', -- what was paid or received: { token, symbol, amount } or { native, symbol, amount }
  usd         NUMERIC,                     -- about how much it was worth, when a price was found
  seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain, tx_hash, wallet, token, side)
);
CREATE INDEX wallet_trades_wallet ON wallet_trades (wallet, seen_at DESC);
CREATE INDEX wallet_trades_seen ON wallet_trades (seen_at);

CREATE TABLE wallet_tracker_cursors (
  chain       TEXT PRIMARY KEY,
  block       BIGINT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
