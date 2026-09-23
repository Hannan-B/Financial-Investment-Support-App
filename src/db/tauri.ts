import { invoke } from '@tauri-apps/api/core';
import type { Db, Row, SqlValue, Statement } from './types.ts';

/** The real database, in the OS application-support directory (§12.3). */
export class TauriDb implements Db {
  query(sql: string, params: readonly SqlValue[] = []): Promise<Row[]> {
    return invoke<Row[]>('db_query', { sql, params });
  }

  batch(statements: readonly Statement[]): Promise<void> {
    return invoke('db_batch', { statements: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })) });
  }

  migrate(scripts: readonly string[]): Promise<void> {
    return invoke('db_migrate', { scripts });
  }
}
