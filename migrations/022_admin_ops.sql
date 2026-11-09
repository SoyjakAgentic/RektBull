-- The admin panel, part 2 (docs/ADMIN.md): when each external service was last
-- called and why it last failed, and when each background job last ran.
ALTER TABLE provider_usage
  ADD COLUMN last_call_at  TIMESTAMPTZ,
  ADD COLUMN last_error_at TIMESTAMPTZ,
  ADD COLUMN last_error    TEXT;

CREATE TABLE job_runs (
  name           TEXT PRIMARY KEY,
  runs           BIGINT NOT NULL DEFAULT 0,
  last_ok_at     TIMESTAMPTZ,
  last_error_at  TIMESTAMPTZ,
  last_error     TEXT
);
