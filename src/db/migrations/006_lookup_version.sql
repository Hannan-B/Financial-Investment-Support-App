-- ═══════════════════════════════════════════════════════════════════════
--  006_lookup_version.sql — which search method a lookup miss was made with
--
--  A company not found is normally retried after a month. But what usually
--  turns a miss into a match is an improvement to the search itself (e.g.
--  spelling out 'INTL'). Recording the method's version lets every miss
--  from an older version be retried once, as soon as the method improves.
--  Existing rows predate versioning (0), so each is retried once.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE lookup_attempt ADD COLUMN method_version INTEGER NOT NULL DEFAULT 0;

INSERT INTO schema_version (version, applied_at, description)
VALUES (6, datetime('now'), 'Lookup method version');
