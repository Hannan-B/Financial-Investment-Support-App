-- ═══════════════════════════════════════════════════════════════════════
--  002_source_health.sql — source health without payload links
--  Implements PROJECT-PLAN.md §10.1 (escalation), §10.8 (diagnosis)
--
--  The last good and last failed response per source are kept as FILES in
--  the diagnostics folder, not as payload rows — so an agent fixing a broken
--  adapter can read and diff them directly (§10.8). The hash columns, and
--  their foreign keys into `payload`, go.
--
--  `failing_since` is added: "failed for three weeks" is a date, not a count
--  of refreshes (§10.1, persistent breakage must escalate).
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE source_health_new (
  source               TEXT PRIMARY KEY,
  last_ok_at           TEXT,
  last_failed_at       TEXT,
  last_failure_kind    TEXT CHECK (last_failure_kind IN ('unavailable', 'suspect')),
  last_failure         TEXT,           -- which check failed and the observed value, or why unavailable
  failing_since        TEXT,           -- first failure of the current run; NULL once it works again
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

INSERT INTO source_health_new (source, last_ok_at, last_failed_at, last_failure, consecutive_failures)
SELECT source, last_ok_at, last_failed_at, last_failure, consecutive_failures FROM source_health;

DROP TABLE source_health;
ALTER TABLE source_health_new RENAME TO source_health;

INSERT INTO schema_version (version, applied_at, description)
VALUES (2, datetime('now'), 'Source health: diagnostics as files, failing_since');
