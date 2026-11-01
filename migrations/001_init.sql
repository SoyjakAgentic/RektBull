-- RektBull's first schema. Accounts are wallets; money is credits in cents.

CREATE TABLE accounts (
  id            BIGSERIAL PRIMARY KEY,
  wallet        TEXT NOT NULL UNIQUE,          -- lowercase 0x address; the account is the wallet
  deposit_index INTEGER UNIQUE,                -- HD child of CRYPTO_DEPOSIT_XPUB, given on the first invoice
  email         TEXT,                          -- optional, alerts only
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index 0 is never handed out, so it can't collide with a test address.
CREATE SEQUENCE deposit_index_seq START 1;

-- A sign-in message we issued. The client signs exactly this text.
CREATE TABLE siwe_challenges (
  id         UUID PRIMARY KEY,
  wallet     TEXT NOT NULL,
  message    TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);

-- Credits. The balance is the sum; nothing is ever updated in place.
-- ref makes each entry idempotent (a deposit or a refund is written once).
CREATE TABLE credit_ledger (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  delta_cents INTEGER NOT NULL,
  reason      TEXT NOT NULL,                   -- deposit | run | refund | pass | adjustment
  ref         TEXT UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_account ON credit_ledger (account_id);

-- What a user said they'd pay. Deposits are credited whether or not an
-- invoice matches, so a late or odd-sized payment is never lost.
CREATE TABLE invoices (
  id              UUID PRIMARY KEY,
  account_id      BIGINT NOT NULL REFERENCES accounts(id),
  chain           TEXT NOT NULL,
  token           TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL,
  deposit_address TEXT NOT NULL,
  product         TEXT,                        -- bought from credits once paid, e.g. a pass
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired')),
  paid_cents      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX invoices_account ON invoices (account_id, status);

-- Every stablecoin transfer seen landing on a deposit address.
CREATE TABLE deposits (
  id           BIGSERIAL PRIMARY KEY,
  chain        TEXT NOT NULL,
  token        TEXT NOT NULL,
  tx_hash      TEXT NOT NULL,
  log_index    INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  from_address TEXT NOT NULL,
  to_address   TEXT NOT NULL,
  account_id   BIGINT NOT NULL REFERENCES accounts(id),
  amount_raw   NUMERIC NOT NULL,
  amount_cents INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'seen' CHECK (status IN ('seen', 'credited', 'reorged')),
  seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  credited_at  TIMESTAMPTZ,
  UNIQUE (chain, tx_hash, log_index)
);

CREATE TABLE watcher_cursors (
  chain      TEXT NOT NULL,
  token      TEXT NOT NULL,
  last_block BIGINT NOT NULL,
  PRIMARY KEY (chain, token)
);

-- Prepaid time (no recurring charges in crypto).
CREATE TABLE passes (
  id         BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  product    TEXT NOT NULL,
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX passes_account ON passes (account_id, ends_at);

-- Every paid or free run, and how it was paid.
CREATE TABLE runs (
  id             UUID PRIMARY KEY,
  account_id     BIGINT REFERENCES accounts(id),
  product        TEXT NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('free', 'credits', 'x402', 'pass')),
  price_cents    INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  input          JSONB,
  x402_payer     TEXT,
  x402_tx        TEXT,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ
);

CREATE TABLE free_usage (
  subject TEXT NOT NULL,                       -- account:<id>
  product TEXT NOT NULL,
  day     DATE NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, product, day)
);

-- Calls made to each data provider per UTC day, to stay inside free plans.
CREATE TABLE provider_usage (
  provider TEXT NOT NULL,
  day      DATE NOT NULL,
  calls    INTEGER NOT NULL DEFAULT 0,
  errors   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, day)
);

CREATE TABLE cache (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX cache_expiry ON cache (expires_at);
