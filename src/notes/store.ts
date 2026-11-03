/**
 * Notes, labels, decisions and the ineligible marker, in the database.
 * PROJECT-PLAN.md §11.8, migration 012.
 *
 * The rules live in `document.ts`; this file reads and writes. Nothing is
 * ever overwritten: an edit adds a version, a deletion hides an entry and
 * keeps its wording, a label change adds a dated row, a cleared marker keeps
 * both dates.
 */
import type { Db, Statement } from '../db/types.ts';
import {
  cannotAdd, cannotCompleteReview, currentRound, bodyOf, isLabel, isTab,
  type Entry, type Label, type Sold, type Tab, type Target, type Version,
} from './document.ts';

export type Refused = { readonly kind: 'refused'; readonly reason: string };
export type Done = { readonly kind: 'done' };
const refused = (reason: string): Refused => ({ kind: 'refused', reason });
const DONE: Done = { kind: 'done' };

export async function loadEntries(db: Db, isin: string): Promise<Entry[]> {
  const rows = await db.query('SELECT * FROM note_entry WHERE isin = ? ORDER BY id', [isin]);
  const versions = new Map<number, Version[]>();
  for (const v of await db.query(
    'SELECT v.entry_id, v.written_at, v.body FROM note_version v JOIN note_entry e ON e.id = v.entry_id WHERE e.isin = ? ORDER BY v.id',
    [isin],
  )) {
    const id = Number(v['entry_id']);
    versions.set(id, [...(versions.get(id) ?? []), { writtenAt: String(v['written_at']), body: String(v['body']) }]);
  }
  return rows.map((r) => {
    const id = Number(r['id']);
    const key = r['target'] as string | null;
    return {
      id,
      round: Number(r['round']),
      kind: r['kind'] as Entry['kind'],
      createdAt: String(r['created_at']),
      tab: isTab(r['tab']) ? r['tab'] : null,
      target: key === null ? null : { key, label: String(r['target_label'] ?? ''), value: String(r['target_value'] ?? '') },
      snapshotId: r['snapshot_id'] == null ? null : Number(r['snapshot_id']),
      stance: isLabel(r['stance']) ? r['stance'] : null,
      sold: r['sold'] === 'chose' || r['sold'] === 'had_to' ? r['sold'] : null,
      versions: versions.get(id) ?? [],
      deletedAt: (r['deleted_at'] as string | null) ?? null,
    };
  });
}

/** The entry just inserted in the same batch — batches are one transaction, so nothing can come between. */
const LAST_ENTRY = '(SELECT max(id) FROM note_entry)';

export type NewEntry =
  | { readonly kind: 'opening' | 'concluding'; readonly body: string }
  | { readonly kind: 'comment'; readonly tab: Tab; readonly target: Target | null; readonly snapshotId: number | null; readonly body: string };

export async function addEntry(db: Db, isin: string, entry: NewEntry, now: Date): Promise<Done | Refused> {
  const entries = await loadEntries(db, isin);
  const why = cannotAdd(entries, entry.kind, entry.body);
  if (why) return refused(why);
  const at = now.toISOString();
  const c = entry.kind === 'comment' ? entry : null;
  await db.batch([
    {
      sql: `INSERT INTO note_entry (isin, round, kind, created_at, tab, target, target_label, target_value, snapshot_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [isin, currentRound(entries), entry.kind, at, c?.tab ?? null, c?.target?.key ?? null,
        c?.target?.label ?? null, c?.target?.value ?? null, c?.snapshotId ?? null],
    },
    { sql: `INSERT INTO note_version (entry_id, written_at, body) VALUES (${LAST_ENTRY}, ?, ?)`, params: [at, entry.body.trim()] },
  ]);
  return DONE;
}

async function entryById(db: Db, id: number): Promise<Entry | null> {
  const [row] = await db.query('SELECT isin FROM note_entry WHERE id = ?', [id]);
  if (!row) return null;
  return (await loadEntries(db, String(row['isin']))).find((e) => e.id === id) ?? null;
}

/** A new wording; the earlier ones stay readable (§11.8 step 3.1). A decision line's comment may be emptied. */
export async function editEntry(db: Db, id: number, body: string, now: Date): Promise<Done | Refused> {
  const e = await entryById(db, id);
  if (!e) return refused('That entry no longer exists');
  if (e.deletedAt) return refused('That entry was deleted');
  const text = body.trim();
  if (text === '' && e.kind !== 'decision') return refused('There is nothing written — to remove it, delete it');
  if (text === bodyOf(e)) return DONE;
  await db.query('INSERT INTO note_version (entry_id, written_at, body) VALUES (?, ?, ?)', [id, now.toISOString(), text]);
  return DONE;
}

/** Hidden, not erased: its wording can still be read. */
export async function deleteEntry(db: Db, id: number, now: Date): Promise<Done | Refused> {
  const e = await entryById(db, id);
  if (!e) return refused('That entry no longer exists');
  if (e.kind === 'decision') return refused('A decision line marks the end of a review and stays; its comment can be edited');
  if (!e.deletedAt) await db.query('UPDATE note_entry SET deleted_at = ? WHERE id = ?', [now.toISOString(), id]);
  return DONE;
}

// ── labels (§11.8 step 3.3) ──────────────────────────────────────────────

export async function labelOf(db: Db, isin: string): Promise<Label> {
  const [row] = await db.query('SELECT label FROM label_change WHERE isin = ? ORDER BY id DESC LIMIT 1', [isin]);
  return isLabel(row?.['label']) ? row['label'] : 'none';
}

export interface LabelChange { readonly at: string; readonly label: Label; }

export async function labelHistory(db: Db, isin: string): Promise<LabelChange[]> {
  return (await db.query('SELECT changed_at, label FROM label_change WHERE isin = ? ORDER BY id', [isin]))
    .map((r) => ({ at: String(r['changed_at']), label: r['label'] as Label }));
}

function labelStatement(isin: string, label: Label, now: Date): Statement {
  return { sql: 'INSERT INTO label_change (isin, changed_at, label) VALUES (?, ?, ?)', params: [isin, now.toISOString(), label] };
}

/** Only he changes a label; setting the one it already has records nothing. */
export async function setLabel(db: Db, isin: string, label: Label, now: Date): Promise<void> {
  if ((await labelOf(db, isin)) !== label) await db.batch([labelStatement(isin, label, now)]);
}

// ── decisions (§11.8 step 3.4) ──────────────────────────────────────────

export interface Decision {
  readonly stance: Label;
  /** Set when he sold; whether it was his choice changes what looking back shows (§8.4). */
  readonly sold: Sold | null;
  /** Optional, encouraged. */
  readonly comment: string;
}

function decisionStatements(isin: string, round: number, d: Decision, label: Label, now: Date): Statement[] {
  const at = now.toISOString();
  return [
    {
      sql: 'INSERT INTO note_entry (isin, round, kind, created_at, stance, sold) VALUES (?, ?, ?, ?, ?, ?)',
      params: [isin, round, 'decision', at, d.stance, d.sold],
    },
    ...(d.comment.trim() ? [{ sql: `INSERT INTO note_version (entry_id, written_at, body) VALUES (${LAST_ENTRY}, ?, ?)`, params: [at, d.comment.trim()] }] : []),
    ...(label !== d.stance ? [labelStatement(isin, d.stance, now)] : []),
  ];
}

/** Review complete: refused until this review's concluding thoughts are written. */
export async function completeReview(db: Db, isin: string, d: Decision, now: Date): Promise<Done | Refused> {
  const entries = await loadEntries(db, isin);
  const why = cannotCompleteReview(entries);
  if (why) return refused(why);
  await db.batch(decisionStatements(isin, currentRound(entries), d, await labelOf(db, isin), now));
  return DONE;
}

// ── the ineligible marker (§8.4, §11.8 step 3.5) ─────────────────────────

export interface Mark {
  readonly id: number;
  readonly markedAt: string;
  readonly note: string | null;
  readonly sellBy: string | null;
  readonly sellByBasis: 'date' | 'next_results' | null;
  /** Taken from a results date still to come: it can move. */
  readonly sellByExpected: boolean;
  readonly soldAt: string | null;
  readonly clearedAt: string | null;
  readonly clearedReason: string | null;
}

function markOf(r: Readonly<Record<string, unknown>>): Mark {
  return {
    id: Number(r['id']),
    markedAt: String(r['marked_at']),
    note: (r['note'] as string | null) ?? null,
    sellBy: (r['sell_by'] as string | null) ?? null,
    sellByBasis: r['sell_by_basis'] === 'date' || r['sell_by_basis'] === 'next_results' ? r['sell_by_basis'] : null,
    sellByExpected: Number(r['sell_by_expected']) === 1,
    soldAt: (r['sold_at'] as string | null) ?? null,
    clearedAt: (r['cleared_at'] as string | null) ?? null,
    clearedReason: (r['cleared_reason'] as string | null) ?? null,
  };
}

/** Every marker for one holding, oldest first. */
export async function marksFor(db: Db, isin: string): Promise<Mark[]> {
  return (await db.query('SELECT * FROM ineligible_mark WHERE isin = ? ORDER BY id', [isin])).map(markOf);
}

/** The marker in force — or sold and not cleared — for each ISIN that has one. */
export async function currentMarks(db: Db): Promise<Map<string, Mark>> {
  const rows = await db.query(
    `SELECT * FROM ineligible_mark m WHERE id = (SELECT max(id) FROM ineligible_mark WHERE isin = m.isin) AND cleared_at IS NULL`,
  );
  return new Map(rows.map((r) => [String(r['isin']), markOf(r)]));
}

/**
 * The next results date from the last refresh, if it is still to come.
 * stockanalysis's date is held as an estimate: companies move it (§7.1).
 */
export async function nextResults(db: Db, isin: string, today: string): Promise<{ date: string } | { reason: string }> {
  const [row] = await db.query(
    `SELECT f.value_text FROM fact f JOIN snapshot s ON s.id = f.snapshot_id JOIN report r ON r.id = s.report_id
     WHERE r.isin = ? AND f.field_path = 'calendar.next_earnings'
     AND s.captured_at = (SELECT max(s2.captured_at) FROM snapshot s2 WHERE s2.report_id = r.id)`,
    [isin],
  );
  const date = row?.['value_text'];
  if (typeof date !== 'string') return { reason: 'No results date is known — refresh the company, or choose a date' };
  if (date < today) return { reason: `The results date from the last refresh, ${date}, has passed — refresh the company, or choose a date` };
  return { date };
}

export type SellBy = { readonly basis: 'date'; readonly date: string } | { readonly basis: 'next_results' };

export async function markIneligible(
  db: Db, isin: string, m: { readonly sellBy: SellBy | null; readonly note: string }, now: Date,
): Promise<Done | Refused> {
  if ((await currentMarks(db)).get(isin)?.soldAt === null) return refused('It is already marked ineligible');
  let sellBy: string | null = null;
  if (m.sellBy?.basis === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.sellBy.date)) return refused('Choose a sell-by date');
    sellBy = m.sellBy.date;
  } else if (m.sellBy?.basis === 'next_results') {
    // Filled in once, when set; it does not follow later moves (decided 2026-11-02).
    const next = await nextResults(db, isin, now.toISOString().slice(0, 10));
    if ('reason' in next) return refused(next.reason);
    sellBy = next.date;
  }
  await db.query(
    `INSERT INTO ineligible_mark (isin, marked_at, note, sell_by, sell_by_basis, sell_by_expected) VALUES (?, ?, ?, ?, ?, ?)`,
    [isin, now.toISOString(), m.note.trim() || null, sellBy, sellBy ? m.sellBy!.basis : null, m.sellBy?.basis === 'next_results' ? 1 : 0],
  );
  return DONE;
}

/** Clearing needs a written reason; the marker and its dates are kept (§8.4). */
export async function clearIneligible(db: Db, isin: string, reason: string, now: Date): Promise<Done | Refused> {
  const mark = (await currentMarks(db)).get(isin);
  if (!mark) return refused('It is not marked ineligible');
  if (!reason.trim()) return refused('Clearing the marker needs a short written reason');
  await db.query('UPDATE ineligible_mark SET cleared_at = ?, cleared_reason = ? WHERE id = ?', [now.toISOString(), reason.trim(), mark.id]);
  return DONE;
}

/**
 * Confirm sold: the decision line from 3.4 with "had to" chosen, in one
 * step, and the sale date on the marker. Needs no concluding thoughts — it
 * is a change outside a review.
 */
export async function confirmSold(db: Db, isin: string, d: Omit<Decision, 'sold'>, now: Date): Promise<Done | Refused> {
  const mark = (await currentMarks(db)).get(isin);
  if (!mark) return refused('It is not marked ineligible');
  if (mark.soldAt) return refused('The sale is already recorded');
  const entries = await loadEntries(db, isin);
  await db.batch([
    ...decisionStatements(isin, currentRound(entries), { ...d, sold: 'had_to' }, await labelOf(db, isin), now),
    { sql: 'UPDATE ineligible_mark SET sold_at = ? WHERE id = ?', params: [now.toISOString(), mark.id] },
  ]);
  return DONE;
}
