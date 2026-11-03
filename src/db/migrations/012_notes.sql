-- ═══════════════════════════════════════════════════════════════════════
--  012_notes.sql — notes, labels, decisions and the ineligible marker
--  Implements PROJECT-PLAN.md §11.8 (Phase 3), as gone through step by step
--  on 2026-11-02
--
--  One notes document per company, kept by ISIN so a company needs no
--  refresh before it can be written about. A document runs in rounds: the
--  first has the opening thoughts; each ends with a decision line ("where I
--  stand"), after which later comments and a new conclusion start the next.
--  Nothing written is ever overwritten: an edit adds a version, a deletion
--  hides the entry and keeps its versions (§11.8 step 3.1).
--
--  001's note, note_tag and judgement tables were designed before that
--  walk-through and never written to (all empty on the real database,
--  2026-11-02); they are replaced here. report.stance is superseded by
--  label_change, which keeps the history 3.6's export needs.
-- ═══════════════════════════════════════════════════════════════════════

DROP TABLE note_tag;
DROP TABLE note;
DROP TABLE judgement;

CREATE TABLE note_entry (
  id           INTEGER PRIMARY KEY,
  isin         TEXT NOT NULL REFERENCES security(isin),
  round        INTEGER NOT NULL CHECK (round >= 1),
  kind         TEXT NOT NULL CHECK (kind IN ('opening', 'comment', 'concluding', 'decision')),
  created_at   TEXT NOT NULL,
  -- a comment: the tab it was written on and what it is about (§6.2)
  tab          TEXT,                  -- 'overview' | 'financials' | …
  target       TEXT,                  -- the item's identity, never its place on screen; NULL = the tab as a whole
  target_label TEXT,                  -- 'Revenue · FY2025'
  target_value TEXT,                  -- as shown when written — survives a restatement or the item leaving the screen
  snapshot_id  INTEGER REFERENCES snapshot(id),   -- the refresh it was written against, if any
  -- a decision line (§8.6): where he stands, and for a sale whether it was chosen (§8.4)
  stance       TEXT CHECK (stance IN ('to_review', 'reviewing', 'watching', 'passed', 'none')),
  sold         TEXT CHECK (sold IN ('chose', 'had_to')),
  deleted_at   TEXT,
  CHECK ((kind = 'comment') = (tab IS NOT NULL)),
  CHECK ((kind = 'decision') = (stance IS NOT NULL)),
  CHECK (sold IS NULL OR kind = 'decision')
);
CREATE INDEX idx_note_entry ON note_entry(isin, round, created_at);

-- Every wording an entry has had, oldest first; the newest is what shows.
CREATE TABLE note_version (
  id         INTEGER PRIMARY KEY,
  entry_id   INTEGER NOT NULL REFERENCES note_entry(id) ON DELETE CASCADE,
  written_at TEXT NOT NULL,
  body       TEXT NOT NULL
);
CREATE INDEX idx_note_version ON note_version(entry_id, id);

-- The label on a company, as a dated history: the latest row is the label (§11.8 step 3.3).
CREATE TABLE label_change (
  id         INTEGER PRIMARY KEY,
  isin       TEXT NOT NULL REFERENCES security(isin),
  changed_at TEXT NOT NULL,
  label      TEXT NOT NULL CHECK (label IN ('to_review', 'reviewing', 'watching', 'passed', 'none'))
);
CREATE INDEX idx_label_change ON label_change(isin, id);

-- Marked no longer eligible to hold (§8.4, §11.8 step 3.5). The dates are a
-- record in their own right: purification uses the time between marking and
-- selling (§8.5). Clearing needs a written reason; both rows are kept.
CREATE TABLE ineligible_mark (
  id             INTEGER PRIMARY KEY,
  isin           TEXT NOT NULL REFERENCES security(isin),
  marked_at      TEXT NOT NULL,
  note           TEXT,
  sell_by        TEXT,                -- ISO date, his own choice; optional
  sell_by_basis  TEXT CHECK (sell_by_basis IN ('date', 'next_results')),
  sell_by_expected INTEGER NOT NULL DEFAULT 0,  -- 1: taken from a results date still to come, which can move
  sold_at        TEXT,
  cleared_at     TEXT,
  cleared_reason TEXT,
  CHECK ((sell_by IS NULL) = (sell_by_basis IS NULL)),
  CHECK ((cleared_at IS NULL) = (cleared_reason IS NULL))
);
CREATE INDEX idx_ineligible_mark ON ineligible_mark(isin, id);

INSERT INTO schema_version (version, applied_at, description)
VALUES (12, datetime('now'), 'Notes documents, labels, decisions and the ineligible marker');
