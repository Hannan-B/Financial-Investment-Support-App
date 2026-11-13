-- ═══════════════════════════════════════════════════════════════════════
--  013_income_and_planning.sql — dividends, sales, purification, plans
--  Implements PROJECT-PLAN.md §11.10 (Phase 5), as gone through step by
--  step on 2026-11-13
--
--  Exchange rates (5.1) need no new table: 001's fx_rate holds the Bank of
--  England's rates with base = 'GBP' (its comment, written for the ECB, is
--  out of date — the ECB is no longer used).
--
--  Everything from Trading 212 is stored as it says it, with its own
--  identifier, so a later refresh adds only what is new. Amounts keep their
--  currency beside them (§7④). Purification is arithmetic on his figures:
--  the rate is his, per item; nothing here proposes one (§8.5).
-- ═══════════════════════════════════════════════════════════════════════

-- What each holding cost, in pounds: Trading 212's walletImpact.totalCost
-- (5.5 — the profit if he sold at a price he types).
ALTER TABLE holding ADD COLUMN total_cost REAL;
ALTER TABLE holding ADD COLUMN total_cost_currency TEXT;

-- 5.2 — every dividend paid since the ISA was opened.
CREATE TABLE dividend (
  reference       TEXT PRIMARY KEY,     -- Trading 212's own: a payment is stored once
  isin            TEXT NOT NULL,
  t212_ticker     TEXT NOT NULL,
  name            TEXT NOT NULL,
  paid_on         TEXT NOT NULL,        -- as Trading 212 gives it
  amount          REAL NOT NULL,        -- what was paid …
  currency        TEXT NOT NULL,        -- … in the account currency (GBP)
  quantity        REAL NOT NULL,        -- units held when it was paid
  gross_per_share REAL,                 -- per unit, in …
  share_currency  TEXT,                 -- … the share's own currency (⚠️ GBX = pence)
  type            TEXT NOT NULL,        -- Trading 212's word: ORDINARY, INTEREST, …
  fetched_at      TEXT NOT NULL
);
CREATE INDEX idx_dividend_isin ON dividend(isin, paid_on);

-- 5.4 — every sale, from Trading 212's past orders.
CREATE TABLE sale (
  fill_id         INTEGER PRIMARY KEY,  -- Trading 212's fill.id
  order_id        INTEGER NOT NULL,
  isin            TEXT NOT NULL,
  t212_ticker     TEXT NOT NULL,
  name            TEXT NOT NULL,
  filled_at       TEXT NOT NULL,
  quantity        REAL NOT NULL,        -- units sold, positive
  price           REAL NOT NULL,        -- per unit, in …
  price_currency  TEXT NOT NULL,        -- … the share's currency
  net_value       REAL,                 -- walletImpact.netValue, in …
  realised_pl     REAL,                 -- walletImpact.realisedProfitLoss, in …
  wallet_currency TEXT,                 -- … this — undocumented, so checked on arrival:
  profit_checked  INTEGER NOT NULL CHECK (profit_checked IN (0, 1)),  -- 1 = in pounds, and the net value agrees with units × price
  fetched_at      TEXT NOT NULL
);
CREATE INDEX idx_sale_isin ON sale(isin, filled_at);

-- 5.4 — what he owes and has paid. One item per sale (its dividends are
-- worked out when shown), and the one interest payment typed by hand.
CREATE TABLE purification_item (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('sale', 'manual')),
  sale_fill_id   INTEGER UNIQUE REFERENCES sale(fill_id),
  isin           TEXT,
  on_date        TEXT NOT NULL,
  description    TEXT NOT NULL,
  amount         REAL,                  -- manual: the payment; a sale: a profit he typed, when Trading 212's could not be used
  rate_pct       REAL,                  -- his rate for this item, from his usual rate when it was created; NULL = not entered
  created_at     TEXT NOT NULL,
  settled_on     TEXT,
  settled_amount REAL,                  -- what was owed when he settled it, kept as it was
  CHECK ((kind = 'sale') = (sale_fill_id IS NOT NULL)),
  CHECK ((settled_on IS NULL) = (settled_amount IS NULL))
);

-- 5.5 — what he weighed, dated and kept: what he typed, and what the app
-- showed that day (the portfolio moves on; the plan records what he saw).
CREATE TABLE plan (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('buy', 'sell')),
  isin        TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  inputs      TEXT NOT NULL,            -- JSON
  outcome     TEXT NOT NULL             -- JSON
);
CREATE INDEX idx_plan_isin ON plan(isin, created_at);

INSERT INTO schema_version (version, applied_at, description)
VALUES (13, datetime('now'), 'Dividends, sales, purification, plans; what each holding cost');
