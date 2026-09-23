import { DatabaseSync } from 'node:sqlite';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Db, Row, SqlValue } from './types.ts';
import { parseMigrations, type Migration } from './migrate.ts';

/**
 * In-memory SQLite for tests, using Node's built-in driver.  Tests only.
 *
 * Mirrors the Rust side: foreign keys on, migrations in one transaction.
 * It takes no backup — that is Rust's job, and is tested there.
 */
export class NodeDb implements Db {
  readonly #db = new DatabaseSync(':memory:');

  constructor() {
    this.#db.exec('PRAGMA foreign_keys = ON');
  }

  async query(sql: string, params: readonly SqlValue[] = []): Promise<Row[]> {
    const stmt = this.#db.prepare(sql);
    // Mirror Rust's db_query: statements that return no columns still run.
    if (stmt.columns().length === 0) {
      stmt.run(...params);
      return [];
    }
    return stmt.all(...params) as Row[];
  }

  async migrate(scripts: readonly string[]): Promise<void> {
    this.#db.exec('BEGIN');
    try {
      for (const sql of scripts) this.#db.exec(sql);
      this.#db.exec('COMMIT');
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
  }
}

/** The migration files on disk — the same directory the app bundles. */
export async function migrationsFromDisk(): Promise<Migration[]> {
  const dir = fileURLToPath(new URL('./migrations/', import.meta.url));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql'));
  const entries = await Promise.all(
    files.map(async (f) => [f, await readFile(join(dir, f), 'utf8')] as const),
  );
  return parseMigrations(Object.fromEntries(entries));
}
