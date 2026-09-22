/**
 * Regression tests for the personal-data boundary.  PROJECT-PLAN.md §12.3
 *
 * Git remembers everything: anything committed once stays in the history after
 * deletion. The boundary cannot be fixed retrospectively, so it is tested
 * rather than trusted.
 *
 * This caught a real bug — a trailing comment on the same line as `/exports/`
 * made the whole line a literal pattern, so exported notes and decisions were
 * committable.
 *
 * ⚠️ These tests NEVER create or delete files. `git check-ignore` operates on
 * path names, not on files that exist. An earlier version of this test wrote a
 * placeholder at each path and removed it afterwards — which destroyed the real
 * PROJECT-PLAN.md. Do not reintroduce that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function isIgnored(relPath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', relPath], { cwd: REPO });
    return true;
  } catch {
    return false;
  }
}

const MUST_BE_IGNORED = [
  'data/tracker.db',
  'tracker.sqlite',
  'tracker.db-wal',
  'exports/notes.md',
  'exports/decisions.csv',
  'exports/purification.csv',
  'logs/failures.log',
  'backups/tracker.db',
  'api.key',
  'secrets.secret',
  '.env',
  '.env.local',
  'PROJECT-PLAN.md',
  'SESSION-RECORD.md',
  'anything.session.md',
  'notes/anything.md',
];

for (const path of MUST_BE_IGNORED) {
  test(`personal data is not committable: ${path}`, () => {
    assert.equal(isIgnored(path), true, `${path} MUST be git-ignored`);
  });
}

const MUST_BE_TRACKED = [
  'src/lib/money.ts',
  'src/fetch/fixtures/waystone-djiw.csv',   // public market data, needed offline
  'src/fetch/fixtures/hsbc-hies.xls',
  'src/db/migrations/001_initial.sql',
  'src-tauri/src/main.rs',
];

for (const path of MUST_BE_TRACKED) {
  test(`needed for the build, so must NOT be ignored: ${path}`, () => {
    assert.equal(isIgnored(path), false, `${path} must be tracked`);
  });
}
