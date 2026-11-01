-- Trading: approve-each trades the user signs, positions, and the registry of
-- automatic-trading permissions (session keys) for milestone 2.
-- RektBull never holds user funds: every row here describes the user's own wallet.

-- Off-chain safety settings for the trades RektBull proposes. The onchain
-- limits for automatic trading live in the Trade Router, set by the user.
CREATE TABLE trade_settings (
  account_id              BIGINT PRIMARY KEY REFERENCES accounts(id),
  max_trade_usd           NUMERIC NOT NULL DEFAULT 500,
  max_tax_bps             INTEGER NOT NULL DEFAULT 1000,   -- refuse tokens taxing more than 10%
  max_round_trip_loss_pct NUMERIC NOT NULL DEFAULT 30,     -- refuse buys whose sell-back loses more (honeypot test)
  slippage_bps            INTEGER NOT NULL DEFAULT 100,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One proposed trade. Approve-each: proposed -> approved (fresh checks, calls
-- built) -> submitted (the user's wallet sent it) -> confirmed / failed.
CREATE TABLE trade_proposals (
  id            UUID PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES accounts(id),
  wallet        TEXT NOT NULL,
  chain         TEXT NOT NULL,
  side          TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  token         TEXT NOT NULL,
  base          TEXT NOT NULL,
  amount_usd    NUMERIC,
  sell_fraction NUMERIC,
  status        TEXT NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed', 'approved', 'submitted', 'confirmed', 'failed', 'expired', 'cancelled')),
  plan          JSONB,           -- the checks and quote summary shown to the user
  calls         JSONB,           -- the transactions handed to the user's wallet
  tx_hash       TEXT,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at   TIMESTAMPTZ,
  submitted_at  TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);
CREATE INDEX trade_proposals_account ON trade_proposals (account_id, created_at DESC);
CREATE INDEX trade_proposals_submitted ON trade_proposals (status) WHERE status = 'submitted';

-- What RektBull's trades bought, per wallet and token, at what cost.
CREATE TABLE positions (
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  chain      TEXT NOT NULL,
  token      TEXT NOT NULL,
  amount_raw NUMERIC NOT NULL DEFAULT 0,
  cost_usd   NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, chain, token)
);

-- Automatic-trading permissions: MetaMask delegations to RektBull's session key.
-- Stored only after their structure, caveats and signature check out.
CREATE TABLE trade_permissions (
  id              UUID PRIMARY KEY,
  account_id      BIGINT NOT NULL REFERENCES accounts(id),
  wallet          TEXT NOT NULL,
  chain_id        INTEGER NOT NULL,
  wallet_type     TEXT NOT NULL CHECK (wallet_type IN ('metamask', 'safe', 'coinbase', 'phantom')),
  router          TEXT NOT NULL,
  delegate        TEXT NOT NULL,
  delegation      JSONB NOT NULL,
  delegation_hash TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ
);
CREATE INDEX trade_permissions_account ON trade_permissions (account_id, status);
