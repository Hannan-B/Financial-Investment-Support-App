/**
 * Prices from Yahoo, against real responses captured on 2026-10-05.
 * §11.7 step 2.1: SHEL.L stores as GBp and AAPL as USD, without conversion errors.
 *
 * The AAPL response was captured while New York was still trading; the
 * SHEL.L one after London had closed. Between them they cover both cases of
 * the last bar.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSource } from '../fetch/run.ts';
import { FixtureTransport } from '../fetch/fixture.ts';
import { NodeDb, migrationsFromDisk } from '../db/node.ts';
import { migrate } from '../db/migrate.ts';
import { securityStatement, ensureListing } from '../portfolio/master.ts';
import { makeYahooPrices, exchangeDate, type PriceHistory } from '../sources/yahoo.ts';
import { savePrices, loadPrices } from './prices.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fetch/fixtures/${name}`, import.meta.url));
const now = () => new Date('2026-10-05T18:00:00Z');
const yahoo = makeYahooPrices(now);

const SHELL_LSE = { isin: 'GB00BP6MXD84', ticker: 'SHEL', exchange: 'LSE', currency: 'GBp', sourceKeys: { yahoo: 'SHEL.L' } };
const SHELL_NYSE = { isin: 'US7802593050', ticker: 'SHEL', exchange: 'NYSE', currency: 'USD', sourceKeys: { yahoo: 'SHEL' } };
const APPLE = { isin: 'US0378331005', ticker: 'AAPL', exchange: 'NASDAQ', currency: 'USD', sourceKeys: { yahoo: 'AAPL' } };

async function read(symbol: string, path: string, source = yahoo) {
  const transport = new FixtureTransport({ [source.request(symbol).url]: path }, 'application/json');
  return runSource(source, symbol, transport);
}

async function history(symbol: string, file: string): Promise<PriceHistory> {
  const out = await read(symbol, fixture(file));
  assert.equal(out.kind, 'ok', out.kind === 'suspect' ? JSON.stringify(out.failure) : out.kind === 'unavailable' ? out.reason : '');
  return (out as { value: PriceHistory }).value;
}

async function setup() {
  const db = new NodeDb();
  await migrate(db, await migrationsFromDisk());
  await db.batch([
    securityStatement(SHELL_LSE.isin, 'Shell plc', 'equity', '2026-10-05'),
    securityStatement(SHELL_NYSE.isin, 'Shell plc ADR', 'equity', '2026-10-05'),
    securityStatement(APPLE.isin, 'Apple Inc.', 'equity', '2026-10-05'),
  ]);
  return db;
}

/** A copy of a fixture with its JSON edited, for the failure cases. */
async function edited(file: string, edit: (result: any) => void): Promise<string> {
  const json = JSON.parse(await readFile(fixture(file), 'utf8'));
  edit(json.chart.result[0]);
  const path = join(await mkdtemp(join(tmpdir(), 'yahoo-')), file);
  await writeFile(path, JSON.stringify(json));
  return path;
}

test('2.1 ACCEPTANCE — SHEL.L stores as GBp and AAPL as USD, without conversion errors', async () => {
  const db = await setup();
  const shell = await ensureListing(db, SHELL_LSE);
  const apple = await ensureListing(db, APPLE);
  await savePrices(db, shell, await history('SHEL.L', 'yahoo-shel-l.json'));
  await savePrices(db, apple, await history('AAPL', 'yahoo-aapl.json'));

  const s = (await loadPrices(db, shell))!;
  assert.equal(s.currency, 'GBp');
  assert.deepEqual(s.bars.at(-1)?.date, '2026-10-05');
  assert.equal(s.bars.at(-1)?.close, 3631.5, 'pence, exactly as quoted — not 36.315');

  const a = (await loadPrices(db, apple))!;
  assert.equal(a.currency, 'USD');
  assert.ok(a.bars.length > 2500, `ten years of bars, got ${a.bars.length}`);
});

test('a listing recorded in pounds refuses prices quoted in pence, and stores nothing', async () => {
  const db = await setup();
  const wrong = await ensureListing(db, { ...SHELL_LSE, currency: 'GBP' });
  await assert.rejects(savePrices(db, wrong, await history('SHEL.L', 'yahoo-shel-l.json')), /in GBp, but the listing is in GBP/);
  assert.equal(await loadPrices(db, wrong), null);
});

test('SHEL and SHEL.L stay apart: London prices cannot be stored against the New York listing', async () => {
  const db = await setup();
  const london = await ensureListing(db, SHELL_LSE);
  const newYork = await ensureListing(db, SHELL_NYSE);
  assert.notEqual(london, newYork);
  await assert.rejects(savePrices(db, newYork, await history('SHEL.L', 'yahoo-shel-l.json')), /asked Yahoo for SHEL but the answer was for SHEL\.L/);
  assert.equal(await loadPrices(db, newYork), null);
});

test('a ticker and exchange already recorded under another ISIN or currency is refused', async () => {
  const db = await setup();
  await ensureListing(db, SHELL_LSE);
  await assert.rejects(ensureListing(db, { ...SHELL_LSE, isin: SHELL_NYSE.isin }), /already recorded as GB00BP6MXD84/);
  await assert.rejects(ensureListing(db, { ...SHELL_LSE, currency: 'GBP' }), /already recorded in GBp/);
});

test('today’s bar is dropped while the market is still open, kept once it has closed', async () => {
  const apple = await history('AAPL', 'yahoo-aapl.json');
  const raw = JSON.parse(await readFile(fixture('yahoo-aapl.json'), 'utf8')).chart.result[0];
  assert.equal(apple.bars.length, raw.timestamp.length - 1);
  assert.equal(apple.bars.at(-1)?.date, '2026-10-02', 'Monday 5 October was still trading');

  const shell = await history('SHEL.L', 'yahoo-shel-l.json');
  assert.equal(shell.bars.at(-1)?.date, '2026-10-05', 'London had closed');
});

test('dates are the exchange’s own calendar day, not the viewer’s', () => {
  const t = Date.UTC(2026, 9, 4, 23, 30) / 1000; // 23:30 on Sunday 4 October, UTC
  assert.equal(exchangeDate(t, 'Asia/Tokyo'), '2026-10-05');
  assert.equal(exchangeDate(t, 'Europe/London'), '2026-10-05');
  assert.equal(exchangeDate(t, 'America/New_York'), '2026-10-04');
});

test('refreshing again overwrites rather than duplicates, so restated closes replace old ones', async () => {
  const db = await setup();
  const shell = await ensureListing(db, SHELL_LSE);
  const first = await history('SHEL.L', 'yahoo-shel-l.json');
  await savePrices(db, shell, first);
  const restated = { ...first, bars: first.bars.map((b, i) => (i === 0 ? { ...b, close: b.close / 2 } : b)) };
  await savePrices(db, shell, restated);

  const stored = (await loadPrices(db, shell))!;
  assert.equal(stored.bars.length, first.bars.length);
  assert.equal(stored.bars[0]?.close, first.bars[0]!.close / 2);
});

test('a history that switches from pence to pounds partway is rejected', async () => {
  const path = await edited('yahoo-shel-l.json', (r) => {
    const close = r.indicators.quote[0].close as number[];
    for (let i = 2000; i < close.length; i++) close[i] = close[i]! / 100;
  });
  const out = await read('SHEL.L', path);
  assert.equal(out.kind, 'suspect');
  if (out.kind === 'suspect') assert.equal(out.failure.check, 'no-unit-jumps');
});

test('a currency the app does not know is rejected, never guessed', async () => {
  const path = await edited('yahoo-shel-l.json', (r) => { r.meta.currency = 'ZAc'; });
  const out = await read('SHEL.L', path);
  assert.equal(out.kind, 'suspect');
  if (out.kind === 'suspect') assert.match(out.failure.observed, /unrecognised currency: "ZAc"/);
});

test('a feed that stopped updating is rejected', async () => {
  const later = makeYahooPrices(() => new Date('2026-11-01T12:00:00Z'));
  const out = await read('SHEL.L', fixture('yahoo-shel-l.json'), later);
  assert.equal(out.kind, 'suspect');
  if (out.kind === 'suspect') assert.equal(out.failure.check, 'as-of-freshness');
});

test('Yahoo’s “symbol not found” answer is suspect, not silently empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yahoo-'));
  const path = join(dir, 'missing.json');
  await writeFile(path, JSON.stringify({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }));
  const out = await read('NOPE.L', path);
  assert.equal(out.kind, 'suspect');
  if (out.kind === 'suspect') assert.match(out.failure.observed, /symbol may be delisted/);
});
