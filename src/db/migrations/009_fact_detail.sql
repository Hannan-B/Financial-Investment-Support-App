-- ═══════════════════════════════════════════════════════════════════════
--  009_fact_detail.sql — where exactly each figure came from
--  Implements PROJECT-PLAN.md §7③, §11.4 ("every figure traceable")
--
--  A fact already names its source and tier. These add the source's own name
--  for the figure (e.g. 'us-gaap:Revenues, 10-K filed 2026-03-18') and the
--  last day of the period it covers, so any number on screen can be found
--  again at its source.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE fact ADD COLUMN period_end TEXT;
ALTER TABLE fact ADD COLUMN detail TEXT;

INSERT INTO schema_version (version, applied_at, description)
VALUES (9, datetime('now'), 'Fact period end and source detail');
