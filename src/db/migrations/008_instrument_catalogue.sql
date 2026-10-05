-- ═══════════════════════════════════════════════════════════════════════
--  008_instrument_catalogue.sql — everything Trading 212 offers
--  Implements PROJECT-PLAN.md §7.2, §11.7 step 2.5
--
--  Companies are researched by choosing from this list, so only shares the
--  ISA can actually buy can be opened, and each is identified by its ISIN
--  from the start (§7.2). ~15,000 rows, replaced whole on each fetch;
--  Trading 212 allows one fetch every 50 seconds, and the app asks far less.
--
--  ⚠️ currency is Trading 212's code: 'GBX' means pence.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE instrument (
  t212_ticker TEXT PRIMARY KEY,          -- 'AAPL_US_EQ', 'SHELl_EQ'
  isin        TEXT NOT NULL,
  name        TEXT NOT NULL,
  short_name  TEXT NOT NULL,
  currency    TEXT NOT NULL,
  type        TEXT NOT NULL,             -- 'STOCK' | 'ETF' | …
  fetched_at  TEXT NOT NULL
);
CREATE INDEX idx_instrument_isin ON instrument(isin);
CREATE INDEX idx_instrument_short_name ON instrument(short_name COLLATE NOCASE);

INSERT INTO schema_version (version, applied_at, description)
VALUES (8, datetime('now'), 'Trading 212 instrument catalogue');
