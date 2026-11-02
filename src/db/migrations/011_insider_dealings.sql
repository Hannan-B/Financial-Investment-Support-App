-- ═══════════════════════════════════════════════════════════════════════
--  011_insider_dealings.sql — directors' and officers' dealings in shares
--  Implements PROJECT-PLAN.md §11.7 step 2.8
--
--  Kept as rows, like headlines: each refresh adds what is new, so a year
--  builds up even where a site lists less (Finviz shows only its latest
--  100). Every line keeps the source's own words for the dealing and a link
--  to the original filing or notice. A line that failed a check is kept
--  with the reason, so the report can say what was left out and why.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE insider_dealing (
  id          INTEGER PRIMARY KEY,
  isin        TEXT NOT NULL REFERENCES security(isin),
  source      TEXT NOT NULL CHECK (source IN ('finviz', 'investegate')),
  key         TEXT NOT NULL,            -- one line, unique within the company
  url         TEXT NOT NULL,            -- the SEC filing or the London notice
  filed_on    TEXT,                     -- when it was made public (ISO date)
  traded_on   TEXT,                     -- the dealing's own date (ISO date)
  person      TEXT,
  role        TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('bought', 'sold', 'intends-to-sell', 'other')),
  wording     TEXT NOT NULL,            -- the source's words: 'Sale', 'Proposed Sale', the notice's nature
  shares      REAL,
  price       REAL,
  value       REAL,
  currency    TEXT,                     -- as stated: 'USD', 'GBP', 'GBp', 'EUR'
  value_worked_out INTEGER NOT NULL DEFAULT 0,  -- 1: price × shares, worked out by the app
  shares_after REAL,                    -- holding after the dealing, where stated
  place       TEXT,                     -- London: where it was dealt ('Amsterdam')
  left_out    TEXT,                     -- why it is not shown as a dealing; NULL when it is
  first_seen  TEXT NOT NULL,
  UNIQUE (isin, key)
);
CREATE INDEX idx_insider_dealing_isin ON insider_dealing(isin, traded_on);

-- London notices are found in the announcements list, which until now was
-- read back 180 days. It is now read back a year: forget how far each
-- company's list was read, so its next refresh reaches a year back.
DELETE FROM news_fetch WHERE source = 'investegate';

INSERT INTO schema_version (version, applied_at, description)
VALUES (11, datetime('now'), 'Insider dealings');
