-- ═══════════════════════════════════════════════════════════════════════
--  010_news.sql — headlines, and what the user did with them
--  Implements PROJECT-PLAN.md §6.6, §11.7 step 2.6
--
--  Headlines are kept as rows — date, publisher, headline, link — never the
--  article and never the source's snippet. They accumulate: each refresh
--  adds what is new, so a review months later still has the quarter's news
--  even if a source has since gone.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE news_item (
  id           INTEGER PRIMARY KEY,
  isin         TEXT NOT NULL REFERENCES security(isin),
  url          TEXT NOT NULL,
  title        TEXT NOT NULL,
  publisher    TEXT NOT NULL,            -- 'The Guardian', 'SEC', 'RNS (GlobeNewswire)'
  host         TEXT,                     -- 'theguardian.com' — what the approved list is checked against
  published_at TEXT NOT NULL,            -- ISO date or timestamp
  section      TEXT NOT NULL CHECK (section IN ('official', 'press')),
  label        TEXT CHECK (label IN ('official', 'regulator', 'press-release')),
  routine      INTEGER NOT NULL DEFAULT 0,  -- daily buyback notices and the like: hidden until asked (§6.6)
  results      INTEGER NOT NULL DEFAULT 0,  -- a results announcement: where "since the last results" starts
  source       TEXT NOT NULL,            -- 'sec' | 'investegate' | 'google-news'
  detail       TEXT,                     -- e.g. '8-K items 2.02, 9.01'
  first_seen   TEXT NOT NULL,
  UNIQUE (isin, url)
);
CREATE INDEX idx_news_item_isin ON news_item(isin, published_at);

-- How far each company's news has been fetched, so a refresh asks only for what is new.
CREATE TABLE news_fetch (
  isin        TEXT NOT NULL,
  source      TEXT NOT NULL,
  fetched_to  TEXT NOT NULL,             -- the latest date asked for
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (isin, source)
);

-- "Not about this company" — one click, remembered for good.
CREATE TABLE news_hidden (
  isin      TEXT NOT NULL,
  url       TEXT NOT NULL,
  hidden_at TEXT NOT NULL,
  PRIMARY KEY (isin, url)
);

CREATE TABLE news_opened (
  isin      TEXT NOT NULL,
  url       TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  PRIMARY KEY (isin, url)
);

-- When each company's news was last looked at: what is "new since last time".
CREATE TABLE news_view (
  isin            TEXT PRIMARY KEY,
  last_viewed_at  TEXT NOT NULL,
  previous_viewed_at TEXT
);

-- Other names a company's headlines use: brands, former names (§6.6).
CREATE TABLE company_alias (
  isin  TEXT NOT NULL,
  alias TEXT NOT NULL,
  PRIMARY KEY (isin, alias)
);

-- Publishers switched on or off by the user; defaults live in the code.
CREATE TABLE publisher_choice (
  host  TEXT PRIMARY KEY,
  shown INTEGER NOT NULL
);

INSERT INTO schema_version (version, applied_at, description)
VALUES (10, datetime('now'), 'News headlines, choices and views');
