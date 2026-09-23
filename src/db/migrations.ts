/**
 * The migrations bundled into the app: every file in `./migrations/`.
 * Tests read the same directory from disk (`node.ts`), so the two cannot drift.
 */
import { parseMigrations } from './migrate.ts';

export const MIGRATIONS = parseMigrations(
  import.meta.glob<string>('./migrations/*.sql', { query: '?raw', import: 'default', eager: true }),
);

export const LATEST = MIGRATIONS[MIGRATIONS.length - 1]!.version;
