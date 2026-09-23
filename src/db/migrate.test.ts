/**
 * The schema and migration runner, against real SQLite.  §10.4, §11.5 step 0.2
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NodeDb, migrationsFromDisk } from './node.ts';
import { migrate, parseMigrations } from './migrate.ts';

test('0.2 ACCEPTANCE — schema builds from empty to the latest version', async () => {
  const db = new NodeDb();
  const migrations = await migrationsFromDisk();
  const { from, to } = await migrate(db, migrations);

  assert.equal(from, 0);
  assert.equal(to, migrations.length);
  const versions = await db.query('SELECT version FROM schema_version ORDER BY version');
  assert.deepEqual(versions.map((r) => r['version']), migrations.map((m) => m.version));
});

test('running again is a no-op', async () => {
  const db = new NodeDb();
  const migrations = await migrationsFromDisk();
  await migrate(db, migrations);
  const again = await migrate(db, migrations);
  assert.equal(again.from, again.to);
  const [row] = await db.query('SELECT count(*) AS n FROM schema_version');
  assert.equal(row?.['n'], migrations.length);
});

test('0.2 ACCEPTANCE — a failing migration rolls back completely', async () => {
  const db = new NodeDb();
  const migrations = await migrationsFromDisk();
  await migrate(db, migrations.slice(0, 1));

  const broken = {
    version: migrations.length + 1,
    name: 'broken',
    sql: 'CREATE TABLE half_done (x INTEGER); SELECT * FROM no_such_table;',
  };
  await assert.rejects(migrate(db, [...migrations, broken]));

  // Nothing from the batch survived — not migration 2, not the half-done table.
  const [v] = await db.query('SELECT max(version) AS v FROM schema_version');
  assert.equal(v?.['v'], 1);
  const half = await db.query("SELECT name FROM sqlite_master WHERE name = 'half_done'");
  assert.equal(half.length, 0);
});

test('refuses a database written by a newer version', async () => {
  const db = new NodeDb();
  const migrations = await migrationsFromDisk();
  await migrate(db, migrations);
  await assert.rejects(migrate(db, migrations.slice(0, 1)), /newer version/);
});

test('002 keeps existing source_health rows', async () => {
  const db = new NodeDb();
  const migrations = await migrationsFromDisk();
  await migrate(db, migrations.slice(0, 1));
  await db.query(
    "INSERT INTO source_health (source, last_ok_at, consecutive_failures) VALUES ('ishares', '2026-09-20', 2)",
  );
  await migrate(db, migrations.slice(0, 2));
  const [row] = await db.query("SELECT * FROM source_health WHERE source = 'ishares'");
  assert.equal(row?.['last_ok_at'], '2026-09-20');
  assert.equal(row?.['consecutive_failures'], 2);
  assert.equal(row?.['failing_since'], null);
});

test('migration files must be numbered without gaps', () => {
  assert.throws(() => parseMigrations({ '001_a.sql': '', '003_c.sql': '' }), /without gaps/);
  assert.throws(() => parseMigrations({ 'initial.sql': '' }), /NNN_name/);
});
