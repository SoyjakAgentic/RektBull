-- Research: one digest a week. The facts are gathered from RektBull's own
-- data, each with its source, and kept as they were; the text is the AI's
-- write-up of those facts only (NULL when no AI was available: the page then
-- shows the facts alone).
CREATE TABLE research_digests (
  week_start DATE PRIMARY KEY,             -- the Monday (UTC) the week began
  week_end   DATE NOT NULL,                -- the Monday after
  facts      JSONB NOT NULL,
  text       TEXT,
  model      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
