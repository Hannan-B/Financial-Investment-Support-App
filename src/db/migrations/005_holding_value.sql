-- ═══════════════════════════════════════════════════════════════════════
--  005_holding_value.sql — holdings as Trading 212 reports them
--  Implements PROJECT-PLAN.md §8.2, §6A.1
--
--  Look-through needs each holding's current value, which T212 supplies
--  already in the account currency (GBP for the ISA). Each refresh adds one
--  row per holding, so the last good holdings can be shown — marked stale —
--  when a refresh fails (§10.1).
-- ═══════════════════════════════════════════════════════════════════════

DROP TABLE holding;

CREATE TABLE holding (
  isin                TEXT NOT NULL REFERENCES security(isin),
  as_of               TEXT NOT NULL,   -- when fetched
  t212_ticker         TEXT NOT NULL,
  quantity            REAL NOT NULL,
  average_price_paid  REAL NOT NULL,   -- from T212, not computed (§8.4) …
  price_currency      TEXT NOT NULL,   -- … in the instrument's currency (⚠️ GBX = pence)
  value               REAL NOT NULL,   -- current value …
  value_currency      TEXT NOT NULL,   -- … in the account currency (GBP)
  source              TEXT NOT NULL DEFAULT 't212',
  PRIMARY KEY (isin, as_of)
);
CREATE INDEX idx_holding_as_of ON holding(as_of);

-- Small facts about the app's own state, e.g. which holdings snapshot is
-- current ('holdings_as_of'). An empty portfolio is still a snapshot.
CREATE TABLE app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO schema_version (version, applied_at, description)
VALUES (5, datetime('now'), 'Holdings with current value; app state');
