-- Monthly allowances: free points per signed-in wallet, and what a pass
-- includes per month (e.g. 5 reports). One row per subject, key and month.
CREATE TABLE period_usage (
  subject   TEXT NOT NULL,                 -- account:<id>
  key       TEXT NOT NULL,                 -- 'points', or '<product>:pass'
  period    TEXT NOT NULL,                 -- 'YYYY-MM' (UTC)
  allowance INTEGER NOT NULL,
  used      INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (subject, key, period)
);

-- What the AI reports cost: tokens per model per UTC day, so the real cost
-- per report can be read back (GET /v1/admin/provider-usage).
CREATE TABLE ai_usage (
  day           DATE NOT NULL,
  model         TEXT NOT NULL,
  calls         INTEGER NOT NULL DEFAULT 0,
  input_tokens  BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model)
);

-- Runs can now be paid with free points.
ALTER TABLE runs DROP CONSTRAINT runs_payment_method_check;
ALTER TABLE runs ADD CONSTRAINT runs_payment_method_check CHECK (payment_method IN ('x402', 'credits', 'free', 'pass', 'points'));
