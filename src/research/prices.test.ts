/**
 * Prices from Yahoo, against real responses captured on 2026-10-05.
 * §11.7 step 2.1: SHEL.L stores as GBp and AAPL as USD, without conversion errors.
 *
 * The AAPL response was captured while New York was still trading; the
 * SHEL.L one after London had closed. Between them they cover both cases of
 * the last bar.
 *
 * Since 2026-11-13 the app reads Yahoo's history page, not its data address
 * (robots.txt; plan appendix, *Phase 5*). The page carries the same chart
 * response, so the 5 October responses are served wrapped as that page; the
 * real pages captured on 13 November are tested on their own below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSource } from '../fetch/run.ts';
import { FixtureTransport, yahooPageFixture, yahooHistoryPage } from '../fetch/fixture.ts';
import { NodeDb, migrationsFromDisk } from '../db/node.ts';
import { migrate } from '../db/migrate.ts';
import { securityStatement, ensureListing } from '../portfolio/master.ts';
import { makeYahooPrices, exchangeDate, historyUrl, type PriceHistory } from '../sources/yahoo.ts';
import { savePrices, loadPrices } from './prices.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fetch/fixtures/${name}`, import.meta.url));
const now = () => new Date('2026-10-05T18:00:00Z');
const yahoo = makeYahooPrices(now);

const SHELL_LSE = { isin: 'GB00BP6MXD84', ticker: 'SHEL', exchange: 'LSE', currency: 'GBp', sourceKeys: { yahoo: 'SHEL.L' } };
const SHELL_NYSE = { isin: 'US7802593050', ticker: 'SHEL', exchange: 'NYSE', currency: 'USD', sourceKeys: { yahoo: 'SHEL' } };
const APPLE = { isin: 'US0378331005', ticker: 'AAPL', exchange: 'NASDAQ', currency: 'USD', sourceKeys: { yahoo: 'AAPL' } };

/** A saved chart response, served as Yahoo's history page for that symbol. */
async function read(symbol: string, path: string, source = yahoo) {
  const transport = new FixtureTransport({ [source.request(symbol).url]: await yahooPageFixture(path, symbol) }, 'text/html');
  return runSource(source, symbol, transport);
}

/** A page served as it is, with the status given. */
async function readPage(symbol: string, path: string, source = yahoo, status = 200) {
  return runSource(source, symbol, new FixtureTransport({ [source.request(symbol).url]: path }, 'text/html', status));
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

test('a symbol Yahoo does not know is “not found”, not a page read as having no prices', async () => {
  // The real answer, seen 2026-11-13: 404 and a redirect to the home page.
  const out = await readPage('NOPEQX.L', fixture('yahoo-history-not-found.html'), yahoo, 404);
  assert.equal(out.kind, 'unavailable');
  if (out.kind === 'unavailable') assert.equal(out.reason, 'not found for this security');
});

// ── the history page itself (captured 2026-11-13) ──────────────────────────

const nov13 = makeYahooPrices(() => new Date('2026-11-13T16:53:00Z'));

test('prices are read from Yahoo’s history page, which robots.txt allows — never its data address', () => {
  const url = nov13.request('SHEL.L').url;
  assert.ok(url.startsWith('https://finance.yahoo.com/quote/SHEL.L/history/?'), url);
  assert.ok(!url.includes('query1') && !url.includes('query2'), 'query1/query2 are Disallow: / in robots.txt');
  // Ten years to the end of the refresh's day: 14 Nov 2016 to 14 Nov 2026, midnight UTC.
  assert.equal(url, 'https://finance.yahoo.com/quote/SHEL.L/history/?period1=1479081600&period2=1794614400');
  assert.equal(historyUrl('SHEL.L', new Date('2026-11-13T00:00:01Z')), url, 'the same address all day');
});

test('Yahoo’s real history pages give ten years of prices: Apple in dollars on Nasdaq, Shell in pence in London', async () => {
  const apple = await readPage('AAPL', fixture('yahoo-aapl-history.html'), nov13);
  const shell = await readPage('SHEL.L', fixture('yahoo-shel-l-history.html'), nov13);
  assert.equal(apple.kind, 'ok', apple.kind === 'suspect' ? JSON.stringify(apple.failure) : '');
  assert.equal(shell.kind, 'ok', shell.kind === 'suspect' ? JSON.stringify(shell.failure) : '');
  if (apple.kind !== 'ok' || shell.kind !== 'ok') return;
  assert.deepEqual([apple.value.symbol, apple.value.currency, apple.value.exchange], ['AAPL', 'USD', 'NMS']);
  assert.deepEqual([shell.value.symbol, shell.value.currency, shell.value.exchange], ['SHEL.L', 'GBp', 'LSE']);
  for (const h of [apple.value, shell.value]) {
    assert.ok(h.bars.length > 2500, `ten years of bars, got ${h.bars.length}`);
    assert.equal(h.bars[0]!.date, '2016-11-14');
    assert.ok(h.bars.every((b) => b.adjClose !== null), 'adjusted closes, as before');
  }
  // Captured at 16:53 UTC: London had closed (16:30), New York was trading.
  assert.equal(shell.value.bars.at(-1)!.date, '2026-11-13');
  assert.equal(apple.value.bars.at(-1)!.date, '2026-11-12', 'Friday 13 November was still trading');
});

test('a page that no longer carries its price data is suspect — never read as no prices', async () => {
  const page = await readFile(fixture('yahoo-aapl-history.html'), 'utf8');
  const path = join(await mkdtemp(join(tmpdir(), 'yahoo-')), 'changed.html');
  await writeFile(path, page.replace(/data-url="https:\/\/query1\.finance\.yahoo\.com\/v8\/finance\/chart\//, 'data-url="https://query1.finance.yahoo.com/v9/finance/chart/'));
  const out = await readPage('AAPL', path, nov13);
  assert.equal(out.kind, 'suspect');
  if (out.kind === 'suspect') assert.match(out.failure.observed, /carries no price data/);
});

test('a page carrying two sets of price data is refused, not guessed between', async () => {
  const chart = await readFile(fixture('yahoo-shel-l.json'), 'utf8');
  const path = join(await mkdtemp(join(tmpdir(), 'yahoo-')), 'two.html');
  await writeFile(path, yahooHistoryPage(chart, 'SHEL.L') + yahooHistoryPage(chart, 'SHEL'));
  const out = await readPage('SHEL.L', path);
  assert.equal(out.kind, 'suspect');
  if (out.kind === 'suspect') assert.match(out.failure.observed, /2 sets of price data/);
});

test('price data the page itself marks as failed is suspect', async () => {
  const page = await readFile(fixture('yahoo-aapl-history.html'), 'utf8');
  const path = join(await mkdtemp(join(tmpdir(), 'yahoo-')), 'failed.html');
  const i = page.search(/data-url="https:\/\/query1\.finance\.yahoo\.com\/v8\/finance\/chart\//);
  await writeFile(path, page.slice(0, i) + page.slice(i).replace('{"status":200,', '{"status":500,'));
  const out = await readPage('AAPL', path, nov13);
  assert.equal(out.kind, 'suspect');
  if (out.kind === 'suspect') assert.match(out.failure.observed, /status 500/);
});
