-- ═══════════════════════════════════════════════════════════════════════
--  007_snapshot_record.sql — what each snapshot heard, and what it did not
--  Implements PROJECT-PLAN.md §10.1, §7①, §11.7 step 2.4
--
--  A snapshot must distinguish "this source was down that day" from "this
--  figure does not exist", or the History view (§6.5) would read an outage
--  as a figure changing to nothing. Each source's outcome is kept per
--  snapshot, and each missing figure with its reason.
--
--  Raw responses are content-addressed, so the hash alone does not say which
--  request a payload answered. The URL is kept with the link, which is what
--  re-running a fixed parser over history needs (§7①).
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE snapshot_payload ADD COLUMN url TEXT;

CREATE TABLE snapshot_source (
  snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,           -- 'yahoo-prices' | 'edgar' | 'stockanalysis' | 'finviz'
  outcome     TEXT NOT NULL CHECK (outcome IN ('ok','unavailable','not-covered','suspect')),
  detail      TEXT,
  PRIMARY KEY (snapshot_id, source)
);

CREATE TABLE snapshot_gap (
  snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  field_path  TEXT NOT NULL,
  reason      TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, field_path)
);

INSERT INTO schema_version (version, applied_at, description)
VALUES (7, datetime('now'), 'Snapshot source outcomes, gaps and payload URLs');
