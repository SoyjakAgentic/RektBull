-- Research: one digest a week, and the newsletter that carries it.
--
-- A digest's facts are gathered from RektBull's own data, each with its
-- source, and kept as they were. The writer drafts from them; the fact-check
-- removes any sentence they don't support; the owner reads it, may edit it,
-- and publishes it (or skips the week). Only a published digest is shown or
-- emailed.
CREATE TABLE research_digests (
  week_start  DATE PRIMARY KEY,               -- the Monday (UTC) the week began
  week_end    DATE NOT NULL,                  -- the Monday after
  facts       JSONB NOT NULL,
  draft       TEXT,                           -- the writer's draft
  checked     TEXT,                           -- the draft after the fact-check: what the owner reviews
  check_notes JSONB NOT NULL DEFAULT '[]',    -- sentences the fact-check removed, and any step that couldn't run
  text        TEXT,                           -- what was published (the owner may have edited it); NULL = the facts alone
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'skipped')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by BIGINT REFERENCES accounts(id),
  emailed_at  TIMESTAMPTZ                     -- when the newsletter finished sending it
);

-- Newsletter subscribers: an email address and when it was confirmed.
-- Unsubscribing deletes the row; unconfirmed sign-ups are deleted after 7 days.
CREATE TABLE newsletter_subscribers (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirm_sent_at TIMESTAMPTZ,
  confirmed_at    TIMESTAMPTZ
);

-- Which subscribers each digest has gone to, so a send that stops part-way resumes.
CREATE TABLE newsletter_sends (
  week_start    DATE NOT NULL REFERENCES research_digests(week_start),
  subscriber_id BIGINT NOT NULL REFERENCES newsletter_subscribers(id) ON DELETE CASCADE,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  error         TEXT,
  PRIMARY KEY (week_start, subscriber_id)
);
