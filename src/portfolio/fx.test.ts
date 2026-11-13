/**
 * Exchange rates in pounds, from the Bank of England.  §11.10 step 5.1
 *
 * Against the real page captured on 2026-11-13 (showing 12 November's rates:
 * the Bank had not yet published the 13th's). Edited copies, in a temporary
 * folder, test the failure cases.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HttpRequest, HttpResponse, Transport } from '../fetch/types.ts';
import { MemoryDiagnostics, OfflineTransport } from '../fetch/fixture.ts';
import { runSource } from '../fetch/run.ts';
import { NodeDb, migrationsFromDisk } from '../db/node.ts';
import { migrate } from '../db/migrate.ts';
import { makeBoeRates, BOE_CURRENCIES } from '../sources/boe.ts';
import { poundRates, toPounds, fromPounds, T212_FX_FEE } from './fx.ts';

const PAGE = fileURLToPath(new URL('../fetch/fixtures/boe-rates-2026-11-13.html', import.meta.url));
const FRIDAY = () => new Date('2026-11-13T17:00:00Z');

/** Serves one file, counting how often it is asked. */
class Page implements Transport {
  asked = 0;
  readonly #path: string;
  constructor(path: string) { this.#path = path; }
  async get(_req: HttpRequest): Promise<HttpResponse> {
    this.asked++;
    return { status: 200, body: new Uint8Array(await readFile(this.#path)), contentType: 'text/html' };
  }
}

async function db() {
  const d = new NodeDb();
  await migrate(d, await migrationsFromDisk());
  return d;
}

async function edited(edit: (html: string) => string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'boe-')), 'rates.html');
  await writeFile(path, edit(await readFile(PAGE, 'utf8')));
  return path;
}

async function read(path: string, now = FRIDAY) {
  return runSource(makeBoeRates(now), '', new Page(path));
}

test('5.1 ACCEPTANCE — a dollar amount in pounds shows its working: amount, rate, date and the Bank of England', async () => {
  const rates = await poundRates({ db: await db(), diagnostics: new MemoryDiagnostics(), transport: new Page(PAGE), now: FRIDAY });
  assert.equal(rates.kind, 'ok');
  const c = toPounds(1000, 'USD', rates);
  assert.ok('pounds' in c);
  assert.equal(c.pounds.toFixed(2), '755.40', '$1,000 at $1.3238 per £1');
  assert.deepEqual([c.from.amount, c.from.currency, c.rate?.perPound, c.rate?.date, c.rate?.fee], [1000, 'USD', 1.3238, '2026-11-12', 0]);
  const euro = toPounds(1000, 'EUR', rates);
  assert.ok('pounds' in euro && euro.rate?.perPound === 1.1961);
});

test('on a weekend the rates are the last working day’s, and the date says which day', async () => {
  const sunday = () => new Date('2026-11-15T10:00:00Z');
  const rates = await poundRates({ db: await db(), diagnostics: new MemoryDiagnostics(), transport: new Page(PAGE), now: sunday });
  assert.ok(rates.kind === 'ok');
  assert.equal(rates.date, '2026-11-12', 'the page’s own date, not the day asked');
});

test('a rate is fetched once a day, then read from storage', async () => {
  const d = await db();
  const page = new Page(PAGE);
  const deps = { db: d, diagnostics: new MemoryDiagnostics(), transport: page, now: FRIDAY };
  await poundRates(deps);
  await poundRates(deps);
  await poundRates({ ...deps, now: () => new Date('2026-11-13T23:59:00Z') });
  assert.equal(page.asked, 1);
  await poundRates({ ...deps, now: () => new Date('2026-11-14T09:00:00Z') });
  assert.equal(page.asked, 2, 'asked again the next day');
});

test('every row on the page is taken or listed as not taken, with the reason', async () => {
  const out = await read(PAGE);
  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') return;
  assert.equal(out.value.rates.length + out.value.notTaken.length, Object.keys(BOE_CURRENCIES).length, '27 rows seen live');
  assert.deepEqual(out.value.notTaken, [{ name: 'Bulgarian Lev', reason: 'no rate given that day' }]);
});

test('a rate outside the page’s own 52-week range is refused', async () => {
  const out = await read(await edited((h) => h.replace('     1.3238', '     13.238')));
  assert.equal(out.kind, 'suspect');
  if (out.kind === 'suspect') assert.equal(out.failure.check, 'within-52-week-range');
});

test('a decimal comma is refused, never read as a number', async () => {
  const out = await read(await edited((h) => h.replace('     1.3238', '     1,3238')));
  assert.equal(out.kind, 'suspect');
  if (out.kind === 'suspect') assert.match(out.failure.observed, /"1,3238" is not a plain number/);
});

test('a currency name the app does not know is listed as not taken, not guessed', async () => {
  const out = await read(await edited((h) => h.replace('>Swiss Franc<', '>Swiss Francs<')));
  assert.equal(out.kind, 'ok');
  if (out.kind === 'ok') assert.ok(out.value.notTaken.some((n) => n.name === 'Swiss Francs' && n.reason === 'a currency name the app does not know'));
});

test('a page without its date, or a week old, is refused', async () => {
  const undated = await read(await edited((h) => h.replace('&pound;1<br /> 12 Nov 2026', '&pound;1<br /> ')));
  assert.equal(undated.kind, 'suspect');
  const old = await read(PAGE, () => new Date('2026-11-20T09:00:00Z'));
  assert.equal(old.kind, 'suspect');
  if (old.kind === 'suspect') assert.equal(old.failure.check, 'as-of-freshness');
});

test('if the Bank does not answer, no pound figure is made up — the reason is given instead', async () => {
  const rates = await poundRates({ db: await db(), diagnostics: new MemoryDiagnostics(), transport: new OfflineTransport(), now: FRIDAY });
  assert.equal(rates.kind, 'none');
  const c = toPounds(1000, 'USD', rates);
  assert.ok('reason' in c);
  assert.match(c.reason, /Bank of England did not answer/);
});

test('if the Bank does not answer, the last stored rates are shown, marked as such', async () => {
  const d = await db();
  await poundRates({ db: d, diagnostics: new MemoryDiagnostics(), transport: new Page(PAGE), now: FRIDAY });
  const later = await poundRates({ db: d, diagnostics: new MemoryDiagnostics(), transport: new OfflineTransport(), now: () => new Date('2026-11-16T09:00:00Z') });
  assert.ok(later.kind === 'ok');
  assert.equal(later.date, '2026-11-12');
  assert.match(later.stale ?? '', /did not answer/);
});

test('a currency the Bank gives no rate for has no pound figure', async () => {
  const rates = await poundRates({ db: await db(), diagnostics: new MemoryDiagnostics(), transport: new Page(PAGE), now: FRIDAY });
  const c = toPounds(1000, 'BGN', rates);
  assert.ok('reason' in c && /no rate for BGN/.test(c.reason));
});

test('Trading 212’s 0.15% fee: selling dollars gives fewer pounds, buying gives fewer dollars', async () => {
  const rates = await poundRates({ db: await db(), diagnostics: new MemoryDiagnostics(), transport: new Page(PAGE), now: FRIDAY });
  const sell = toPounds(1000, 'USD', rates, 'sell');
  assert.ok('pounds' in sell);
  assert.equal(sell.pounds.toFixed(2), (1000 / (1.3238 * (1 + T212_FX_FEE))).toFixed(2));
  assert.ok(sell.pounds < 755.40);
  const buy = fromPounds(500, 'USD', rates, 'buy');
  assert.ok('amount' in buy);
  assert.equal(buy.amount.toFixed(2), (500 * 1.3238 * (1 - T212_FX_FEE)).toFixed(2));
});

test('pence are pounds ÷ 100: no rate, no fee', () => {
  const c = toPounds(3631.5, 'GBX', { kind: 'none', reason: 'offline' }, 'sell');
  assert.ok('pounds' in c);
  assert.equal(c.pounds, 36.315);
  assert.equal(c.rate, null);
});
