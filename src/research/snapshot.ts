/**
 * Snapshots: what a company refresh learned, kept for good.  PROJECT-PLAN.md §7, §10.1, §10.3
 *
 * One snapshot per refresh, holding:
 *   · the facts — every figure, with its provenance (§7③)
 *   · each source's outcome, so an outage is never read as a change (§10.1)
 *   · the gaps — figures that do not exist, and why
 *   · the raw responses, compressed and content-addressed: a response
 *     identical to one already kept costs nothing (§10.3). Kept
 *     indefinitely, so a fixed parser can be re-run over all history (§7①).
 *
 * Nothing reads these until Phase 4. They are captured now because history
 * cannot be backfilled.
 */
import type { Db, Statement } from '../db/types.ts';
import type { Fact, Gap } from './figures.ts';
import { sha256 } from '../lib/sha256.ts';
import { gzip, gunzip, toHex, fromHex } from '../lib/gzip.ts';

export interface Payload {
  readonly url: string;
  readonly body: Uint8Array;
  readonly contentType: string;
}

export type SourceOutcomeKind = 'ok' | 'unavailable' | 'not-covered' | 'suspect';

export interface SourceOutcome {
  readonly source: string;
  readonly outcome: SourceOutcomeKind;
  readonly detail: string | null;
}

export interface SnapshotInput {
  readonly isin: string;
  readonly capturedAt: string;
  /** False when a core source was unavailable (§10.1). */
  readonly complete: boolean;
  readonly facts: readonly Fact[];
  readonly gaps: readonly Gap[];
  readonly sources: readonly SourceOutcome[];
  readonly payloads: readonly Payload[];
}

/** Saves a snapshot in one transaction. Returns its id and how many raw responses were new. */
export async function saveSnapshot(db: Db, s: SnapshotInput): Promise<{ snapshotId: number; newPayloads: number }> {
  // Identical bodies within one refresh are one payload.
  const byHash = new Map<string, Payload>();
  for (const p of s.payloads) {
    const hash = sha256(p.body);
    if (!byHash.has(hash)) byHash.set(hash, p);
  }
  const hashes = [...byHash.keys()];
  const known = new Set(hashes.length === 0 ? [] : (await db.query(
    `SELECT hash FROM payload WHERE hash IN (${hashes.map(() => '?').join(', ')})`, hashes,
  )).map((r) => String(r['hash'])));

  // Every row below finds its snapshot by (isin, captured_at), so all of it is one batch.
  const snapshot = 'SELECT s.id FROM snapshot s JOIN report r ON r.id = s.report_id WHERE r.isin = ? AND s.captured_at = ?';
  const key = [s.isin, s.capturedAt];
  const writes: Statement[] = [
    { sql: 'INSERT INTO report (isin, created_at) VALUES (?, ?) ON CONFLICT (isin) DO NOTHING', params: [s.isin, s.capturedAt] },
    { sql: 'UPDATE report SET last_refreshed_at = ? WHERE isin = ?', params: [s.capturedAt, s.isin] },
    {
      sql: 'INSERT INTO snapshot (report_id, captured_at, complete) SELECT id, ?, ? FROM report WHERE isin = ?',
      params: [s.capturedAt, s.complete ? 1 : 0, s.isin],
    },
  ];

  let newPayloads = 0;
  for (const [hash, p] of byHash) {
    if (!known.has(hash)) {
      newPayloads++;
      writes.push({
        sql: `INSERT INTO payload (hash, source, media_type, bytes, first_seen) VALUES (?, ?, ?, unhex(?), ?)
              ON CONFLICT (hash) DO NOTHING`,
        params: [hash, new URL(p.url).hostname, p.contentType || 'application/octet-stream', toHex(await gzip(p.body)), s.capturedAt],
      });
    }
    writes.push({
      sql: `INSERT INTO snapshot_payload (snapshot_id, hash, url) SELECT (${snapshot}), ?, ?`,
      params: [...key, hash, p.url],
    });
  }

  for (const f of s.facts) {
    writes.push({
      sql: `INSERT INTO fact (snapshot_id, field_path, period, period_end, value_num, value_text, unit, currency, kind, source, tier, as_of, detail)
            SELECT (${snapshot}), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`,
      params: [...key, f.fieldPath, f.period, f.periodEnd, typeof f.value === 'number' ? f.value : null,
        typeof f.value === 'string' ? f.value : null, f.unit, f.currency, f.kind, f.source, f.tier, f.asOf, f.detail],
    });
  }
  for (const o of s.sources) {
    writes.push({
      sql: `INSERT INTO snapshot_source (snapshot_id, source, outcome, detail) SELECT (${snapshot}), ?, ?, ?`,
      params: [...key, o.source, o.outcome, o.detail],
    });
  }
  for (const g of s.gaps) {
    writes.push({
      sql: `INSERT INTO snapshot_gap (snapshot_id, field_path, reason) SELECT (${snapshot}), ?, ?
            ON CONFLICT (snapshot_id, field_path) DO NOTHING`,
      params: [...key, g.fieldPath, g.reason],
    });
  }

  await db.batch(writes);
  const [row] = await db.query(snapshot, key);
  return { snapshotId: Number(row!['id']), newPayloads };
}

/** A kept raw response, decompressed — the bytes exactly as they arrived. */
export async function loadPayload(db: Db, hash: string): Promise<{ body: Uint8Array; mediaType: string } | null> {
  const [row] = await db.query('SELECT hex(bytes) AS hex, media_type FROM payload WHERE hash = ?', [hash]);
  if (!row) return null;
  return { body: await gunzip(fromHex(String(row['hex']))), mediaType: String(row['media_type']) };
}
