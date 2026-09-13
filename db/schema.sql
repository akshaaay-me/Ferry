CREATE EXTENSION IF NOT EXISTS vector;

-- Companies and which ATS they publish through.
CREATE TABLE IF NOT EXISTS companies (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  ats         TEXT NOT NULL,           -- greenhouse | lever | ashby | workable | recruitee | smartrecruiters
  slug        TEXT NOT NULL,
  careers_url TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ats, slug)
);

CREATE TABLE IF NOT EXISTS jobs (
  id            SERIAL PRIMARY KEY,
  source        TEXT NOT NULL,
  source_job_id TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,         -- sha256(company|title|location): cross-source dedup key
  company       TEXT NOT NULL,
  title         TEXT NOT NULL,
  location      TEXT,
  remote        BOOLEAN,
  department    TEXT,
  salary        TEXT,
  url           TEXT NOT NULL,
  description   TEXT,
  posted_at     TIMESTAMPTZ,
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ,

  stage         TEXT NOT NULL DEFAULT 'new',   -- new | prefiltered | scored | rejected
  keyword_score REAL,
  embedding     vector(1024),
  similarity    REAL,
  score         REAL,
  score_attempts INTEGER NOT NULL DEFAULT 0,   -- LLM score() tries; give up (-> rejected) after 3
  verdict       JSONB,
  notified_at   TIMESTAMPTZ,
  viewed_at     TIMESTAMPTZ,                   -- stamped when you click "open posting" in the review UI

  -- Full pipeline; the canonical list lives in src/config.js PIPELINE_STATUSES.
  -- inbox | shortlist | applied | phone_screen | interview | offer | rejected |
  -- withdrawn | skipped   ('skipped' is reachable from any point)
  status        TEXT NOT NULL DEFAULT 'inbox',
  notes         TEXT,

  UNIQUE (source, source_job_id)
);

-- Idempotent add for databases created before this column existed.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS score_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS jobs_fingerprint_idx ON jobs (fingerprint);
CREATE INDEX IF NOT EXISTS jobs_stage_idx       ON jobs (stage);
CREATE INDEX IF NOT EXISTS jobs_status_idx      ON jobs (status);
CREATE INDEX IF NOT EXISTS jobs_score_idx       ON jobs (score DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS resumes (
  id          SERIAL PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  selection   JSONB NOT NULL,
  pdf_path    TEXT,
  html_path   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per status change - the pipeline timeline. jobs.status is always
-- the current value; this is the history behind it (applied -> phone_screen
-- -> interview -> offer/rejected/withdrawn, or straight to skipped).
CREATE TABLE IF NOT EXISTS job_events (
  id          SERIAL PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events (job_id, created_at);

-- Interview prep: same guardrail shape as resumes.selection - the model may
-- only reference story ids from profile.json's stories[], never invent one.
CREATE TABLE IF NOT EXISTS interview_preps (
  id          SERIAL PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  selection   JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
