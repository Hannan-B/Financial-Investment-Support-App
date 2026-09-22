-- ═══════════════════════════════════════════════════════════════════════
--  001_initial.sql — foundation schema
--  Implements PROJECT-PLAN.md §7 (data model), §7.1, §7.2, §8.4–8.6
--
--  Conventions:
--    · dates are TEXT, ISO-8601 ("2026-09-22" or full timestamp)
--    · booleans are INTEGER 0/1 (SQLite has no boolean type)
--    · money is ALWAYS amount + currency together, never a bare number (§7④)
--    · provenance lives on the FACT, not the snapshot (§7③)
-- ═══════════════════════════════════════════════════════════════════════

PRAGMA foreign_keys = ON;

-- ── schema versioning (§10.4) ──────────────────────────────────────────
CREATE TABLE schema_version (
  version     INTEGER NOT NULL,
  applied_at  TEXT    NOT NULL,
  description TEXT    NOT NULL
);

-- ═══════════════════════════════════════════════════════════════════════
--  SECURITY MASTER (§4.2, §7.2)
--  ISIN-keyed. Fields are enriched from whichever source supplies them,
--  so provenance is per-field, not per-row.
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE security (
  isin        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('equity','etf','cash','derivative')),
  cik         TEXT,                    -- US filers only (EDGAR)
  sedol       TEXT,                    -- DJIW gives SEDOL, not ISIN (§4.5)
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_security_sedol ON security(sedol) WHERE sedol IS NOT NULL;
CREATE INDEX idx_security_name  ON security(name);

-- Per-field provenance for the master (§7③).
-- One row per (security, field) — e.g. ('US0378331005','sector').
CREATE TABLE security_field (
  isin        TEXT NOT NULL REFERENCES security(isin) ON DELETE CASCADE,
  field       TEXT NOT NULL,           -- 'sector' | 'country' | 'industry' | …
  value       TEXT NOT NULL,           -- the source's OWN label, verbatim (§4.4b)
  source      TEXT NOT NULL,           -- 'ishares' | 'stockanalysis' | 'manual' | …
  tier        INTEGER NOT NULL,        -- 1 = official, 2 = scraped, 3 = manual (§3)
  as_of       TEXT NOT NULL,
  PRIMARY KEY (isin, field, source)
);

-- One security, many listings. SHEL.L and SHEL are the SAME company
-- but DIFFERENT securities with different ISINs (§7.2).
CREATE TABLE listing (
  id          INTEGER PRIMARY KEY,
  isin        TEXT NOT NULL REFERENCES security(isin) ON DELETE CASCADE,
  ticker      TEXT NOT NULL,
  exchange    TEXT NOT NULL,
  currency    TEXT NOT NULL,           -- ⚠️ 'GBp' (pence) ≠ 'GBP' (pounds)
  UNIQUE (ticker, exchange)
);

-- How each website refers to this security. Never guess, never substitute (§7.2).
CREATE TABLE listing_source_key (
  listing_id  INTEGER NOT NULL REFERENCES listing(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,           -- 'yahoo' | 'finviz' | 'stockanalysis' | 'edgar'
  source_key  TEXT NOT NULL,           -- 'SHEL.L' | 'SHEL' | 'lon/SHEL' | CIK
  PRIMARY KEY (listing_id, source)
);

-- ═══════════════════════════════════════════════════════════════════════
--  CATEGORIES (§4.4b, §12.10)
--  Granular label stored verbatim; the tree is a VIEW over it, so the
--  mapping can change without re-fetching anything.
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE category (
  id        INTEGER PRIMARY KEY,
  level     INTEGER NOT NULL CHECK (level IN (1,2,3)),  -- sector / group / industry
  name      TEXT NOT NULL,
  parent_id INTEGER REFERENCES category(id),
  UNIQUE (level, name)
);

CREATE TABLE category_mapping (
  source       TEXT NOT NULL,          -- 'ishares' | 'waystone' | 'stockanalysis' | …
  source_label TEXT NOT NULL,          -- 'Pharmaceuticals', 'Information Technology'
  category_id  INTEGER NOT NULL REFERENCES category(id),
  PRIMARY KEY (source, source_label)
);
-- ⚠️ A label with no row here MUST raise an error (§10.1).
--    Never guess, never fall back to "Other".

-- ═══════════════════════════════════════════════════════════════════════
--  REPORTS, SNAPSHOTS, FACTS (§7)
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE report (
  id                INTEGER PRIMARY KEY,
  isin              TEXT NOT NULL REFERENCES security(isin),
  created_at        TEXT NOT NULL,
  last_refreshed_at TEXT,
  last_reviewed_at  TEXT,              -- deliberately separate from refreshed (§6.3)
  stance            TEXT CHECK (stance IN ('reviewing','watching','passed')),
  stance_set_at     TEXT,
  UNIQUE (isin)
);

CREATE TABLE snapshot (
  id          INTEGER PRIMARY KEY,
  report_id   INTEGER NOT NULL REFERENCES report(id) ON DELETE CASCADE,
  captured_at TEXT NOT NULL,
  complete    INTEGER NOT NULL DEFAULT 1,  -- 0 = a core source was unavailable (§10.1)
  UNIQUE (report_id, captured_at)
);

-- Raw payloads, content-addressed by hash so unchanged data is stored once (§10.3).
CREATE TABLE payload (
  hash        TEXT PRIMARY KEY,        -- sha256 of the bytes
  source      TEXT NOT NULL,
  media_type  TEXT NOT NULL,
  bytes       BLOB NOT NULL,           -- gzipped
  first_seen  TEXT NOT NULL
);
CREATE TABLE snapshot_payload (
  snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  hash        TEXT NOT NULL REFERENCES payload(hash),
  PRIMARY KEY (snapshot_id, hash)
);

-- The queryable numbers.
CREATE TABLE fact (
  id          INTEGER PRIMARY KEY,
  snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  field_path  TEXT NOT NULL,           -- 'income.revenue' — the universal key (§7②)
  period      TEXT,                    -- 'FY2025' | 'Q3-2026' | NULL for point-in-time
  value_num   REAL,
  value_text  TEXT,
  unit        TEXT,                    -- 'USD' | 'GBp' | 'percent' | 'ratio' | 'count'
  currency    TEXT,                    -- required when the value is money (§7④)
  kind        TEXT NOT NULL DEFAULT 'actual'
              CHECK (kind IN ('actual','estimate')),   -- §7.1
  source      TEXT NOT NULL,
  tier        INTEGER NOT NULL,
  as_of       TEXT NOT NULL,           -- when it became KNOWN (§6.5 bitemporality)
  CHECK (value_num IS NOT NULL OR value_text IS NOT NULL)
);
CREATE INDEX idx_fact_lookup ON fact(snapshot_id, field_path);
CREATE INDEX idx_fact_series ON fact(field_path, period, kind);

-- ═══════════════════════════════════════════════════════════════════════
--  NOTES AND DECISIONS (§6.2, §8.6)
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE note (
  id             INTEGER PRIMARY KEY,
  report_id      INTEGER NOT NULL REFERENCES report(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL,
  body           TEXT NOT NULL,        -- markdown; ALWAYS required (§8.6)
  is_decision    INTEGER NOT NULL DEFAULT 0,
  decision_kind  TEXT CHECK (decision_kind IN
                   ('started_reviewing','watching','passed','bought',
                    'considered_selling_held','sold')),
  -- anchored notes only (§6.2)
  snapshot_id    INTEGER REFERENCES snapshot(id),
  field_path     TEXT,                 -- anchor by FIELD IDENTITY, never position
  value_at_write TEXT                  -- so the note survives a restatement
);
CREATE INDEX idx_note_report ON note(report_id, created_at);

CREATE TABLE note_tag (
  note_id INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);

-- Zoya verdicts and eligibility, as dated records (§8.4)
CREATE TABLE judgement (
  id         INTEGER PRIMARY KEY,
  isin       TEXT NOT NULL REFERENCES security(isin),
  recorded_at TEXT NOT NULL,
  eligible   INTEGER NOT NULL,         -- 1 = eligible, 0 = not
  note       TEXT NOT NULL,            -- required, including when clearing (§8.4)
  source     TEXT NOT NULL DEFAULT 'zoya'
);
CREATE INDEX idx_judgement_isin ON judgement(isin, recorded_at);

-- ═══════════════════════════════════════════════════════════════════════
--  PORTFOLIO (§6A, §8.2)
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE holding (
  id                  INTEGER PRIMARY KEY,
  isin                TEXT NOT NULL REFERENCES security(isin),
  quantity            REAL NOT NULL,
  average_price_paid  REAL NOT NULL,   -- from T212, not computed (§8.4)
  price_currency      TEXT NOT NULL,
  as_of               TEXT NOT NULL,
  source              TEXT NOT NULL DEFAULT 't212',
  UNIQUE (isin, as_of)
);

-- Fund contents. Shared and time-versioned, not copied per snapshot (§7⑤).
CREATE TABLE etf_constituent (
  etf_isin         TEXT NOT NULL REFERENCES security(isin),
  as_of            TEXT NOT NULL,
  constituent_isin TEXT,               -- NULL for DJIW — match on sedol/name (§4.5)
  sedol            TEXT,
  name             TEXT NOT NULL,
  weight_pct       REAL NOT NULL,
  country_label    TEXT,               -- source's own label, verbatim
  sector_label     TEXT,               -- source's own label, verbatim
  currency         TEXT,
  issuer           TEXT NOT NULL,      -- 'ishares' | 'invesco' | 'hsbc' | 'waystone'
  PRIMARY KEY (etf_isin, as_of, name)
);
CREATE INDEX idx_constituent_isin ON etf_constituent(constituent_isin);

CREATE TABLE price (
  listing_id INTEGER NOT NULL REFERENCES listing(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  open       REAL, high REAL, low REAL, close REAL, adj_close REAL,
  volume     INTEGER,
  currency   TEXT NOT NULL,            -- ⚠️ 'GBp' for LSE
  PRIMARY KEY (listing_id, date)
);

CREATE TABLE fx_rate (
  date   TEXT NOT NULL,
  base   TEXT NOT NULL,                -- ECB publishes EUR-based; cross-rate as needed
  quote  TEXT NOT NULL,
  rate   REAL NOT NULL,
  PRIMARY KEY (date, base, quote)
);

-- ═══════════════════════════════════════════════════════════════════════
--  SOURCE HEALTH (§10.1, §10.8)
--  Keeps the last GOOD response per source — the one thing that cannot
--  be recovered once a website changes.
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE source_health (
  source           TEXT PRIMARY KEY,
  last_ok_at       TEXT,
  last_ok_hash     TEXT REFERENCES payload(hash),
  last_failed_at   TEXT,
  last_failed_hash TEXT REFERENCES payload(hash),
  last_failure     TEXT,               -- which check failed, and the observed value
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

INSERT INTO schema_version (version, applied_at, description)
VALUES (1, datetime('now'), 'Foundation: security master, snapshots, facts, notes, portfolio, source health');
