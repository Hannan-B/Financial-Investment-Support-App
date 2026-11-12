/**
 * What the History tab reads and keeps.  PROJECT-PLAN.md §6.4, §11.9 steps 4.1–4.3
 *
 * Every refresh already keeps every figure (§6.4), so the History tab needs
 * nothing new stored about the figures — only which of them he has chosen to
 * see. Checks are not stored here either: a check is pressing Review complete
 * (settled 2026-11-12), and each one already leaves a dated "Where I stand"
 * line in the notes.
 *
 * His choices, in `app_state` (no migration needed):
 *   history.hidden          figures hidden for every company
 *   history.extra.<ISIN>    figures shown again for that company only
 * Hidden, never deleted: a hidden figure is still saved at every refresh.
 */
import type { Db } from '../db/types.ts';
import type { Fact } from './figures.ts';
import type { SourceOutcome } from './snapshot.ts';
import { factOf } from './report.ts';

export interface StoredSnapshot {
  readonly id: number;
  readonly capturedAt: string;
  readonly complete: boolean;
  /** What each source did at this refresh (§10.1). */
  readonly outcomes: readonly SourceOutcome[];
}

export interface HistoryFacts {
  /** Oldest first. */
  readonly snapshots: readonly StoredSnapshot[];
  readonly facts: readonly (Fact & { readonly snapshotId: number })[];
  /** Figures a refresh looked for and did not get, with the reason. */
  readonly gaps: readonly { readonly snapshotId: number; readonly fieldPath: string; readonly reason: string }[];
}

export async function loadHistoryFacts(db: Db, isin: string): Promise<HistoryFacts> {
  const snaps = await db.query(
    `SELECT s.id, s.captured_at, s.complete FROM snapshot s JOIN report r ON r.id = s.report_id
     WHERE r.isin = ? ORDER BY s.captured_at`, [isin],
  );
  const ids = snaps.map((s) => Number(s['id']));
  if (ids.length === 0) return { snapshots: [], facts: [], gaps: [] };
  const inList = ids.map(() => '?').join(',');
  const outcomes = await db.query(`SELECT snapshot_id, source, outcome, detail FROM snapshot_source WHERE snapshot_id IN (${inList}) ORDER BY rowid`, ids);
  const facts = await db.query(`SELECT * FROM fact WHERE snapshot_id IN (${inList}) ORDER BY id`, ids);
  const gaps = await db.query(`SELECT snapshot_id, field_path, reason FROM snapshot_gap WHERE snapshot_id IN (${inList})`, ids);
  return {
    snapshots: snaps.map((s) => ({
      id: Number(s['id']), capturedAt: String(s['captured_at']), complete: Number(s['complete']) === 1,
      outcomes: outcomes.filter((o) => Number(o['snapshot_id']) === Number(s['id'])).map((o) => ({
        source: String(o['source']), outcome: o['outcome'] as SourceOutcome['outcome'], detail: (o['detail'] as string | null) ?? null,
      })),
    })),
    facts: facts.map((f) => ({ ...factOf(f), snapshotId: Number(f['snapshot_id']) })),
    gaps: gaps.map((g) => ({ snapshotId: Number(g['snapshot_id']), fieldPath: String(g['field_path']), reason: String(g['reason']) })),
  };
}

/** Every figure any refresh has saved, for any company: what the figures window offers. */
export async function knownFigures(db: Db): Promise<string[]> {
  return (await db.query('SELECT DISTINCT field_path FROM fact ORDER BY field_path')).map((r) => String(r['field_path']));
}

/** Which figures the History tab shows: everything, less what he hid, plus what he added back for one company. */
export interface Choices {
  /** Hidden for every company. */
  readonly hidden: readonly string[];
  /** Shown for this company although hidden for the others. */
  readonly extra: readonly string[];
}

export const shows = (c: Choices, path: string): boolean => !c.hidden.includes(path) || c.extra.includes(path);

const HIDDEN = 'history.hidden';
const extraKey = (isin: string) => `history.extra.${isin}`;

function list(value: unknown): string[] {
  try {
    const v = JSON.parse(String(value));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export async function loadChoices(db: Db, isin: string): Promise<Choices> {
  const rows = await db.query('SELECT key, value FROM app_state WHERE key IN (?, ?)', [HIDDEN, extraKey(isin)]);
  const get = (k: string) => list(rows.find((r) => r['key'] === k)?.['value'] ?? '[]');
  return { hidden: get(HIDDEN), extra: get(extraKey(isin)) };
}

export async function saveChoices(db: Db, isin: string, c: Choices): Promise<void> {
  const put = (key: string, value: readonly string[]) => ({
    sql: 'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    params: [key, JSON.stringify([...new Set(value)].sort())],
  });
  await db.batch([put(HIDDEN, c.hidden), put(extraKey(isin), c.extra.filter((p) => c.hidden.includes(p)))]);
}
