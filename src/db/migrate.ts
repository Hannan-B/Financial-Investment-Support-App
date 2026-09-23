/**
 * Migration runner.  PROJECT-PLAN.md §10.4
 *
 * Rules, from the plan:
 *   · all pending migrations run in ONE transaction — all or nothing
 *   · the app refuses to open a database written by a NEWER version, rather
 *     than corrupting it
 *   · a backup is taken before any change — done in Rust (`db_migrate`),
 *     where the database file is
 *
 * Migrations are the `.sql` files in `./migrations/`, numbered `NNN_name.sql`.
 * Adding a file is the whole of adding a migration.
 */
import type { Db } from './types.ts';

export interface Migration { readonly version: number; readonly name: string; readonly sql: string; }

/**
 * Turns `{ 'path/001_initial.sql': sql, ... }` into ordered migrations.
 * Refuses gaps and duplicates: a missing number means a lost file.
 */
export function parseMigrations(files: Readonly<Record<string, string>>): Migration[] {
  const migrations = Object.entries(files).map(([path, sql]) => {
    const name = path.split('/').pop()!.replace(/\.sql$/, '');
    const match = /^(\d{3})_/.exec(name);
    if (!match) throw new Error(`migration file not numbered NNN_name.sql: ${path}`);
    return { version: Number(match[1]), name, sql };
  });
  migrations.sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`migrations must be numbered 1, 2, 3… without gaps; found ${m.name} at position ${i + 1}`);
    }
  });
  return migrations;
}

async function currentVersion(db: Db): Promise<number> {
  const exists = await db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
  );
  if (exists.length === 0) return 0;
  const rows = await db.query('SELECT max(version) AS v FROM schema_version');
  return Number(rows[0]?.['v'] ?? 0);
}

export async function migrate(
  db: Db,
  migrations: readonly Migration[],
): Promise<{ from: number; to: number }> {
  const latest = migrations[migrations.length - 1]?.version ?? 0;
  const from = await currentVersion(db);

  if (from > latest) {
    throw new Error(
      `This database was written by a newer version of the app ` +
      `(schema ${from}, this build understands ${latest}). ` +
      `Refusing to open it rather than risk damaging your data.`,
    );
  }

  const pending = migrations.filter((m) => m.version > from);
  if (pending.length > 0) await db.migrate(pending.map((m) => m.sql));
  return { from, to: latest };
}
