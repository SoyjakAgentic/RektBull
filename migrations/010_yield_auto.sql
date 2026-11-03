-- Automatic yield rebalancing (built, switched off: YIELD_AUTO_ENABLED).
-- yield_permissions: MetaMask delegations to RektBull's session key that may
-- only call the Yield Router's deposit, move and withdraw. yield_auto_actions:
-- what the trade service did with them (the hash is stored before sending).
CREATE TABLE yield_permissions (
  id              UUID PRIMARY KEY,
  account_id      BIGINT NOT NULL REFERENCES accounts(id),
  wallet          TEXT NOT NULL,
  chain_id        INTEGER NOT NULL,
  router          TEXT NOT NULL,
  delegate        TEXT NOT NULL,
  delegation      JSONB NOT NULL,
  delegation_hash TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ
);
CREATE INDEX yield_permissions_account ON yield_permissions (account_id);

CREATE TABLE yield_auto_actions (
  id            UUID PRIMARY KEY,
  permission_id UUID NOT NULL REFERENCES yield_permissions(id),
  kind          TEXT NOT NULL CHECK (kind IN ('deposit', 'move', 'withdraw')),
  from_venue    INTEGER,
  to_venue      INTEGER NOT NULL,
  asset         TEXT NOT NULL,
  amount_raw    NUMERIC(78, 0),          -- null: all of the position
  reason        TEXT,
  status        TEXT NOT NULL CHECK (status IN ('sent', 'confirmed', 'failed')),
  tx_hash       TEXT,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at  TIMESTAMPTZ
);
CREATE INDEX yield_auto_actions_permission ON yield_auto_actions (permission_id);
