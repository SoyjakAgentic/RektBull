-- Find money: airdrops and unclaimed rewards.
--
-- airdrop_programs: Merkle airdrops an admin added, each checked when added
-- (the published tree's root matches the distributor's onchain root, sample
-- proofs verify, a claim simulates). airdrop_entries: that tree, imported,
-- so a wallet lookup is one indexed query.
CREATE TABLE airdrop_programs (
  id                BIGSERIAL PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  chain             TEXT NOT NULL,
  distributor       TEXT NOT NULL,
  token             TEXT NOT NULL,
  format            TEXT NOT NULL CHECK (format IN ('uniswap', 'oz-standard')),
  claim_signature   TEXT NOT NULL,
  claimed_signature TEXT NOT NULL,
  root_signature    TEXT NOT NULL,
  merkle_root       TEXT NOT NULL,
  tree_url          TEXT NOT NULL,
  official_url      TEXT NOT NULL,
  source            TEXT NOT NULL,
  ends_at           TIMESTAMPTZ,
  entries           INTEGER NOT NULL DEFAULT 0,
  active            BOOLEAN NOT NULL DEFAULT true,
  added_by          BIGINT REFERENCES accounts(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE airdrop_entries (
  id         BIGSERIAL PRIMARY KEY,
  program_id BIGINT NOT NULL REFERENCES airdrop_programs(id) ON DELETE CASCADE,
  account    TEXT NOT NULL,
  idx        BIGINT,
  amount     NUMERIC(78, 0) NOT NULL,
  proof      JSONB NOT NULL
);
CREATE INDEX airdrop_entries_account ON airdrop_entries (account);

-- Claims RektBull prepared for a wallet to sign, with the claim fee (a share
-- of the claimed tokens, as its own transfer the user signs next to the
-- claim). Kept as payment records.
CREATE TABLE claims (
  id           UUID PRIMARY KEY,
  account_id   BIGINT REFERENCES accounts(id),
  wallet       TEXT NOT NULL,
  chain        TEXT NOT NULL,
  chain_id     INTEGER NOT NULL,
  items        JSONB NOT NULL,
  fee_bps      INTEGER NOT NULL,
  fee_wallet   TEXT,
  status       TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'confirmed', 'failed')),
  tx_hashes    JSONB,
  received     JSONB,
  fee_paid     JSONB,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);
CREATE INDEX claims_account ON claims (account_id);
CREATE INDEX claims_wallet ON claims (wallet);
