-- Milestone 2: autonomous trading through users' permissions (session keys).

-- A trade RektBull's session key makes through a user's permission, without
-- asking each time. Every one goes through the Trade Router, whose onchain
-- rules apply whatever happens here.
CREATE TABLE trade_intents (
  id            UUID PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES accounts(id),
  wallet        TEXT NOT NULL,
  chain_id      INTEGER NOT NULL,
  permission_id UUID REFERENCES trade_permissions(id),
  side          TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  token         TEXT NOT NULL,           -- the token bought or sold
  base          TEXT NOT NULL,           -- the router token on the other side
  amount_usd    NUMERIC,                 -- buys
  sell_amount   NUMERIC,                 -- sells, raw units
  source        TEXT NOT NULL CHECK (source IN ('user', 'exit', 'agent')),
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'sent', 'confirmed', 'failed', 'cancelled')),
  tx_hash       TEXT,
  result        JSONB,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);
CREATE INDEX trade_intents_queue ON trade_intents (status, created_at) WHERE status IN ('queued', 'sent');
CREATE INDEX trade_intents_account ON trade_intents (account_id, created_at DESC);

-- Every signature RektBull's own keys make, so each one in KMS's audit log
-- can be matched to a trade. A KMS signature with no row here is an alarm.
CREATE TABLE key_signatures (
  id         BIGSERIAL PRIMARY KEY,
  signer     TEXT NOT NULL,      -- the key's address
  digest     TEXT NOT NULL,
  purpose    TEXT NOT NULL,      -- e.g. 'redeem:<intent id>'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX key_signatures_digest ON key_signatures (digest);

-- Exit rules for positions bought automatically. Defaults: sell everything at
-- -20% or +50%. Sells of what the router bought are exempt from the limits.
ALTER TABLE trade_settings ADD COLUMN stop_loss_pct NUMERIC NOT NULL DEFAULT 20;
ALTER TABLE trade_settings ADD COLUMN take_profit_pct NUMERIC NOT NULL DEFAULT 50;
ALTER TABLE trade_settings ADD COLUMN auto_exit BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE positions ADD COLUMN exit_intent_id UUID;
ALTER TABLE positions ADD COLUMN exit_reason TEXT;
