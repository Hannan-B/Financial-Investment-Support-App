/**
 * Migration runner.  PROJECT-PLAN.md §10.4
 *
 * Rules, from the plan:
 *   · migrations run in a transaction — all or nothing
 *   · the app refuses to open a database written by a NEWER version, rather
 *     than corrupting it
 *   · a backup is taken before any change (added when the first migration
 *     that alters existing data appears — migration 1 creates from empty)
 */
import { invoke } from '@tauri-apps/api/core';
import initial from './migrations/001_initial.sql?raw';

interface Migration { readonly version: number; readonly name: string; readonly sql: string; }

const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: '001_initial', sql: initial },
];

export const LATEST = MIGRATIONS[MIGRATIONS.length - 1]!.version;

async function currentVersion(): Promise<number> {
  const exists = await invoke<Array<Record<string, unknown>>>('db_query', {
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
    params: [],
  });
  if (exists.length === 0) return 0;
  const rows = await invoke<Array<Record<string, unknown>>>('db_query', {
    sql: 'SELECT max(version) AS v FROM schema_version',
    params: [],
  });
  return Number(rows[0]?.['v'] ?? 0);
}

export async function migrate(): Promise<{ from: number; to: number }> {
  const from = await currentVersion();

  if (from > LATEST) {
    throw new Error(
      `This database was written by a newer version of the app ` +
      `(schema ${from}, this build understands ${LATEST}). ` +
      `Refusing to open it rather than risk damaging your data.`,
    );
  }

  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    await invoke('db_migrate', { sql: m.sql });
  }
  return { from, to: LATEST };
}
