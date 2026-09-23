/**
 * The database, as the rest of the app sees it.
 *
 * Two implementations: the real one goes through Rust (`tauri.ts`); the test
 * one uses Node's built-in SQLite (`node.ts`).  Same schema, same SQL — so the
 * schema and every query can be tested without opening the app.
 */

export type SqlValue = string | number | null;
export type Row = Readonly<Record<string, unknown>>;

export interface Db {
  query(sql: string, params?: readonly SqlValue[]): Promise<Row[]>;
  /**
   * Apply migration scripts: all of them or none, in one transaction (§10.4).
   * The real implementation backs the database up first.
   */
  migrate(scripts: readonly string[]): Promise<void>;
}
