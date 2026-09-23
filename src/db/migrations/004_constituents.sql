-- ═══════════════════════════════════════════════════════════════════════
--  004_constituents.sql — fund contents keyed by row, not by name
--  Implements PROJECT-PLAN.md §4.2, §7⑤, §10.3④
--
--  Names repeat within a fund (Rio Tinto plc and Rio Tinto Ltd are both
--  'RIO TINTO' at iShares), so (fund, date, name) cannot be the key. Rows
--  are kept in the issuer's order instead. Also records whether a row is a
--  company or a cash line, and when it was fetched — Waystone publishes no
--  date of its own.
-- ═══════════════════════════════════════════════════════════════════════

DROP TABLE etf_constituent;

CREATE TABLE etf_constituent (
  etf_isin         TEXT NOT NULL REFERENCES security(isin),
  as_of            TEXT NOT NULL,      -- the issuer's date, else the fetch date
  position         INTEGER NOT NULL,   -- row order in the issuer's file
  kind             TEXT NOT NULL CHECK (kind IN ('equity', 'cash')),
  constituent_isin TEXT,               -- NULL for DJIW — matched by name (§4.5)
  sedol            TEXT,
  name             TEXT NOT NULL,
  weight_pct       REAL NOT NULL,
  country_label    TEXT,               -- source's own label, verbatim
  sector_label     TEXT,               -- source's own label, verbatim
  currency         TEXT,
  issuer           TEXT NOT NULL,      -- 'ishares' | 'invesco' | 'hsbc' | 'waystone'
  fetched_at       TEXT NOT NULL,
  PRIMARY KEY (etf_isin, as_of, position)
);
CREATE INDEX idx_constituent_isin ON etf_constituent(constituent_isin);

INSERT INTO schema_version (version, applied_at, description)
VALUES (4, datetime('now'), 'Fund contents keyed by row; kind and fetched_at');
