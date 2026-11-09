-- Contract Audit: each paid audit's result, kept so its PDF report can be
-- downloaded later (GET /v1/contracts/audit/<run id>/report.pdf). The run id
-- is the key: only someone who has it (the buyer) can download the report.
CREATE TABLE audit_reports (
  run_id      UUID PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  account_id  BIGINT REFERENCES accounts(id) ON DELETE SET NULL,
  chain       TEXT NOT NULL,
  address     TEXT NOT NULL,
  result      JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
