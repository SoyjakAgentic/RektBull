-- Sponsored posts in the weekly digest: added by the owner to a week's draft,
-- at most one above the digest and one below it, always labelled as paid.
-- They're fixed once the digest is published, so the page and the email show
-- what was approved. Clicks are a plain count (nothing about who clicked).
CREATE TABLE research_sponsored (
  id          BIGSERIAL PRIMARY KEY,
  week_start  DATE NOT NULL REFERENCES research_digests(week_start) ON DELETE CASCADE,
  placement   TEXT NOT NULL CHECK (placement IN ('top', 'bottom')),
  sponsor     TEXT NOT NULL,                 -- who paid for it, shown in the label
  headline    TEXT NOT NULL,
  body        TEXT NOT NULL,                 -- plain text, no markup
  url         TEXT NOT NULL,                 -- https only; checked against a phishing list when added and on every click
  link_check  JSONB NOT NULL,                -- what that check said when it was added, and its source
  clicks      INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT REFERENCES accounts(id),
  UNIQUE (week_start, placement)
);
