-- The governance assistant: Snapshot spaces an account added by hand (on top
-- of the ones its wallet follows or voted in), and the votes RektBull sent
-- to Snapshot for a wallet that signed them.
CREATE TABLE governance_spaces (
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  space_id   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, space_id)
);

CREATE TABLE governance_votes (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT REFERENCES accounts(id),
  wallet      TEXT NOT NULL,
  space_id    TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  choice      JSONB NOT NULL,
  receipt_id  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX governance_votes_account ON governance_votes (account_id);
