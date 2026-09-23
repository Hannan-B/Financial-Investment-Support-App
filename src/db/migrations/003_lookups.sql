-- ═══════════════════════════════════════════════════════════════════════
--  003_lookups.sql — remembering company lookups
--  Implements PROJECT-PLAN.md §4.4b (classification), §10.2 (pacing)
--
--  Classifying a fund's companies can take ~950 lookups the first time.
--  Results go into security_field like any other source. This table records
--  that a lookup was TRIED, so a company with no match is not searched again
--  on every refresh — only after a while, in case the site adds it.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE lookup_attempt (
  isin         TEXT NOT NULL,
  source       TEXT NOT NULL,          -- 'stockanalysis'
  attempted_at TEXT NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('found', 'not-found')),
  detail       TEXT,                   -- the page matched, or the searches tried
  PRIMARY KEY (isin, source)
);

INSERT INTO schema_version (version, applied_at, description)
VALUES (3, datetime('now'), 'Company lookup attempts');
