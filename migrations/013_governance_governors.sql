-- On-chain governors an account added by hand, on top of the ones RektBull
-- reads for every wallet (src/services/governors.js REGISTRY).
CREATE TABLE governance_governors (
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  chain      TEXT NOT NULL,
  address    TEXT NOT NULL,
  name       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, chain, address)
);
