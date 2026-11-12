/**
 * Refresh all Watching (§11.9 step 4.5): one after another, carrying on past a failure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshEach, watching, type Result } from './refresh-all.ts';
import { NodeDb, migrationsFromDisk } from '../db/node.ts';
import { migrate } from '../db/migrate.ts';
import { listReports } from './report.ts';
import { setLabel } from '../notes/store.ts';
import type { CompanyRefresh } from './company.ts';

test('4.5 ACCEPTANCE — each company in turn; one that fails is reported and the rest still refresh; both bars move', async () => {
  const called: number[] = [];
  const steps: string[] = [];
  const companies: string[] = [];
  const finished: Result[] = [];
  const results = await refreshEach(
    [{ listingId: 1, name: 'Apple' }, { listingId: 2, name: 'Shell' }, { listingId: 3, name: 'BP' }],
    async (id, onStep): Promise<CompanyRefresh> => {
      called.push(id);
      onStep(0, 6, 'Prices');
      onStep(4, 6, 'News');
      if (id === 2) throw new Error('offline');
      return { kind: 'saved', snapshotId: id, complete: id !== 3, newPayloads: 1,
        sources: id === 3 ? [{ source: 'finviz', outcome: 'unavailable', detail: 'timeout' }] : [] };
    },
    {
      company: (done, total, t) => companies.push(`${done}/${total} ${t.name}`),
      step: (done, total, what) => steps.push(`${done}/${total} ${what}`),
      finished: (r) => finished.push(r),
    },
  );
  assert.deepEqual(called, [1, 2, 3], 'one after another, none skipped after the failure');
  assert.deepEqual(companies, ['0/3 Apple', '1/3 Shell', '2/3 BP'], 'the bar across companies');
  assert.equal(steps.length, 6, 'the bar within each company');
  assert.deepEqual(results.map((r) => [r.name, r.kind, r.detail]), [
    ['Apple', 'saved', null],
    ['Shell', 'failed', 'offline'],
    ['BP', 'saved', 'did not answer: finviz'],
  ]);
  assert.equal(finished.length, 3, 'each one is announced as it finishes');
});

test('4.5 ACCEPTANCE — only the companies labelled Watching are picked', async () => {
  const db = new NodeDb();
  await migrate(db, await migrationsFromDisk());
  const at = new Date('2026-11-12T10:00:00Z');
  for (const [isin, ticker, name] of [['US0378331005', 'AAPL', 'Apple'], ['GB00BP6MXD84', 'SHEL', 'Shell'], ['US67066G1040', 'NVDA', 'NVIDIA'], ['GB0007980591', 'BP', 'BP']] as const) {
    await db.query("INSERT INTO security (isin, name, kind, created_at) VALUES (?, ?, 'equity', 'x')", [isin, name]);
    await db.query("INSERT INTO listing (isin, ticker, exchange, currency) VALUES (?, ?, 'X', 'USD')", [isin, ticker]);
    await db.query("INSERT INTO listing_source_key (listing_id, source, source_key) SELECT id, 'yahoo', ? FROM listing WHERE isin = ?", [ticker, isin]);
  }
  await setLabel(db, 'US0378331005', 'watching', at);
  await setLabel(db, 'GB00BP6MXD84', 'watching', at);
  await setLabel(db, 'US67066G1040', 'watching', at);
  await setLabel(db, 'GB0007980591', 'reviewing', at);
  const picked = watching(await listReports(db)).map((t) => t.name).sort();
  assert.deepEqual(picked, ['Apple', 'NVIDIA', 'Shell'], 'three Watching; BP, labelled Reviewing, is left alone');
});
