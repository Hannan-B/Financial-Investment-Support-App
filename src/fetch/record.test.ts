/**
 * Outcomes made durable: source health, failure log, kept responses.
 * §10.1, §10.8, §11.5 step 0.4
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchSource } from './record.ts';
import { FixtureTransport, MemoryDiagnostics, OfflineTransport, StatusTransport } from './fixture.ts';
import { weightsSumTo100 } from './checks.ts';
import { extensionFor } from './diagnostics.ts';
import { NodeDb, migrationsFromDisk } from '../db/node.ts';
import { migrate } from '../db/migrate.ts';
import type { Source, Transport } from './types.ts';

interface Row { name: string; weightPct: number; }

const URL_KEY = 'https://example.test/fund/abc';

const fund: Source<readonly Row[]> = {
  id: 'testfund',
  core: true,
  request: (key) => ({ url: `https://example.test/fund/${key}`, headers: { authorization: 'SECRET' } }),
  parse: (res) => JSON.parse(new TextDecoder().decode(res.body)) as Row[],
  checks: [weightsSumTo100()],
};

async function fixture(rows: Row[]): Promise<Transport> {
  const path = join(await mkdtemp(join(tmpdir(), 'rec-')), 'r.json');
  await writeFile(path, JSON.stringify(rows));
  return new FixtureTransport({ [URL_KEY]: path }, 'application/json');
}
const good = () => fixture([{ name: 'A', weightPct: 60 }, { name: 'B', weightPct: 40 }]);
const truncated = () => fixture([{ name: 'A', weightPct: 60 }]);

async function setup() {
  const db = new NodeDb();
  await migrate(db, await migrationsFromDisk());
  return { db, diagnostics: new MemoryDiagnostics() };
}

async function health(db: NodeDb) {
  const [row] = await db.query("SELECT * FROM source_health WHERE source = 'testfund'");
  return row!;
}

let clock = 0;
const now = () => new Date(Date.UTC(2026, 8, 1) + (clock++) * 86_400_000);

test('ok keeps the response as last-good and marks the source healthy', async () => {
  const { db, diagnostics } = await setup();
  const out = await fetchSource(fund, 'abc', { transport: await good(), db, diagnostics, now });

  assert.equal(out.kind, 'ok');
  assert.ok(diagnostics.saved.has('testfund/last-good'));
  assert.equal(diagnostics.log.length, 0);
  const h = await health(db);
  assert.ok(h['last_ok_at']);
  assert.equal(h['consecutive_failures'], 0);
});

test('0.4 ACCEPTANCE — a corrupted response produces a log entry and saves nothing', async () => {
  const { db, diagnostics } = await setup();
  const out = await fetchSource(fund, 'abc', { transport: await truncated(), db, diagnostics, now });

  assert.equal(out.kind, 'suspect');
  assert.equal('value' in out, false, 'no parsed value may be returned for storage');
  assert.equal(diagnostics.saved.has('testfund/last-good'), false);
  assert.ok(diagnostics.saved.has('testfund/last-failed'), 'the bad response is kept for diagnosis');

  const [entry] = diagnostics.log;
  assert.equal(entry?.kind, 'suspect');
  assert.equal(entry?.check, 'weights-sum');
  assert.match(entry?.observed ?? '', /summed to 60\.00%/);
  assert.equal(entry?.url, URL_KEY);
  assert.equal(entry?.response, 'testfund/last-failed');

  const h = await health(db);
  assert.equal(h['last_failure_kind'], 'suspect');
  assert.match(String(h['last_failure']), /weights-sum/);
  assert.equal(h['last_ok_at'], null);
});

test('the failure log never contains request headers', async () => {
  const { db, diagnostics } = await setup();
  await fetchSource(fund, 'abc', { transport: await truncated(), db, diagnostics, now });
  assert.doesNotMatch(JSON.stringify(diagnostics.log), /SECRET/);
});

test('a failure does not overwrite the last good response', async () => {
  const { db, diagnostics } = await setup();
  await fetchSource(fund, 'abc', { transport: await good(), db, diagnostics, now });
  const kept = diagnostics.saved.get('testfund/last-good');
  await fetchSource(fund, 'abc', { transport: await truncated(), db, diagnostics, now });
  assert.equal(diagnostics.saved.get('testfund/last-good'), kept);
});

test('unavailable is logged and counted, but its body is not kept', async () => {
  const { db, diagnostics } = await setup();
  await fetchSource(fund, 'abc', { transport: new StatusTransport(406), db, diagnostics, now });
  await fetchSource(fund, 'abc', { transport: new OfflineTransport(), db, diagnostics, now });

  assert.equal(diagnostics.saved.size, 0);
  assert.deepEqual(diagnostics.log.map((e) => e.kind), ['unavailable', 'unavailable']);
  assert.equal(diagnostics.log[0]?.status, 406);
  assert.equal(diagnostics.log[1]?.reason, 'no internet');
  assert.equal((await health(db))['consecutive_failures'], 2);
});

test('persistent failure keeps its start date; success clears it', async () => {
  const { db, diagnostics } = await setup();
  const deps = { db, diagnostics, now };

  await fetchSource(fund, 'abc', { ...deps, transport: await truncated() });
  const first = (await health(db))['failing_since'];
  await fetchSource(fund, 'abc', { ...deps, transport: await truncated() });
  await fetchSource(fund, 'abc', { ...deps, transport: new StatusTransport(503) });

  let h = await health(db);
  assert.equal(h['failing_since'], first, 'the run started at the first failure');
  assert.equal(h['consecutive_failures'], 3);
  assert.equal(h['last_failure_kind'], 'unavailable');

  await fetchSource(fund, 'abc', { ...deps, transport: await good() });
  h = await health(db);
  assert.equal(h['failing_since'], null);
  assert.equal(h['consecutive_failures'], 0);
  assert.ok(h['last_failed_at'], 'the last failure stays on record');
});

test('kept responses are named by what the server actually sent', () => {
  assert.equal(extensionFor('application/json; charset=utf-8'), 'json');
  assert.equal(extensionFor('text/csv'), 'csv');
  assert.equal(extensionFor('application/vnd.ms-excel'), 'xls');
  assert.equal(extensionFor('text/html'), 'html');   // an error page where JSON was expected
  assert.equal(extensionFor(''), 'bin');
});
