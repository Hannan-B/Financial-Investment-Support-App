/**
 * Choosing a company, opening it, and what its report shows.
 * §11.7 step 2.5: opening a London share shows Finviz collapsed, explained, not blank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Transport, HttpRequest, HttpResponse } from '../fetch/types.ts';
import { MemoryDiagnostics } from '../fetch/fixture.ts';
import { NodeDb, migrationsFromDisk } from '../db/node.ts';
import { migrate } from '../db/migrate.ts';
import { search, profile, statement, overview } from '../sources/stockanalysis.ts';
import { yahooPrices } from '../sources/yahoo.ts';
import { edgarSearch, edgarSubmissions, edgarConcept } from '../sources/edgar.ts';
import { finviz } from '../sources/finviz.ts';
import { TAGS, DEPRECIATION_TAGS } from './edgar.ts';
import { saveCatalogue, searchCatalogue } from './catalogue.ts';
import { openCompany } from './open.ts';
import { refreshCompany } from './company.ts';
import { loadReport, listReports } from './report.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fetch/fixtures/${name}`, import.meta.url));

class Web implements Transport {
  readonly asked: string[] = [];
  readonly #routes = new Map<string, string | number>();
  route(url: string, fileOrStatus: string | number): this { this.#routes.set(url, fileOrStatus); return this; }
  async get(req: HttpRequest): Promise<HttpResponse> {
    this.asked.push(req.url);
    const route = this.#routes.get(req.url) ?? (req.url.includes('/companyconcept/') ? 404 : undefined);
    if (route === undefined) throw new Error(`nothing served at ${req.url}`);
    if (typeof route === 'number') return { status: route, body: new Uint8Array(), contentType: 'text/plain' };
    return { status: 200, body: new Uint8Array(await readFile(route)), contentType: 'text/html' };
  }
}

async function web(): Promise<Web> {
  const w = new Web()
    .route(search.request('APPLE').url, fixture('sa-search-apple.json'))
    .route(search.request('SHELL').url, fixture('sa-search-shell.json'))
    .route(profile.request('/stocks/aapl/company/').url, fixture('sa-profile-aapl.html'))
    .route(profile.request('/quote/lon/SHEL/company/').url, fixture('sa-profile-lon-shel.html'))
    .route(yahooPrices.request('AAPL').url, fixture('yahoo-aapl.json'))
    .route(yahooPrices.request('SHEL.L').url, fixture('yahoo-shel-l.json'))
    .route(edgarSearch.request('AAPL').url, fixture('edgar-search-aapl.json'))
    .route(edgarSubmissions.request('0000320193').url, fixture('edgar-submissions-aapl.json'))
    .route(finviz.request('AAPL').url, fixture('finviz-aapl.html'))
    .route(overview.request('lon/SHEL').url, fixture('sa-shel-overview.html'));
  for (const which of ['income-statement', 'balance-sheet', 'cash-flow-statement']) {
    w.route(statement.request(`lon/SHEL|${which}`).url, fixture(`sa-shel-${which}.html`));
  }
  for (const tag of [...Object.values(TAGS).flat(), ...DEPRECIATION_TAGS]) {
    const file = fixture(`edgar-concept-aapl-${tag}.json`);
    try { await readFile(file); w.route(edgarConcept.request(`0000320193:${tag}`).url, file); } catch { /* 404 */ }
  }
  return w;
}

const CATALOGUE = [
  { ticker: 'AAPL_US_EQ', isin: 'US0378331005', name: 'Apple', shortName: 'AAPL', currency: 'USD', type: 'STOCK' },
  { ticker: 'APLE_US_EQ', isin: 'US03784Y2000', name: 'Apple Hospitality REIT', shortName: 'APLE', currency: 'USD', type: 'STOCK' },
  { ticker: 'SHELl_EQ', isin: 'GB00BP6MXD84', name: 'Shell', shortName: 'SHEL', currency: 'GBX', type: 'STOCK' },
  { ticker: 'IGDAl_EQ', isin: 'IE000UOXRAM8', name: 'Invesco Dow Jones Islamic Global Developed Markets', shortName: 'IGDA', currency: 'USD', type: 'ETF' },
];

async function setup(transport?: Transport) {
  const db = new NodeDb();
  await migrate(db, await migrationsFromDisk());
  await saveCatalogue(db, CATALOGUE, '2026-10-05T12:00:00Z');
  const w = transport ?? await web();
  let tick = 0;
  const deps = {
    db, diagnostics: new MemoryDiagnostics(), transport: w, pause: async () => {},
    now: () => new Date(Date.UTC(2026, 9, 5, 18, 0, tick++)),
  };
  return { db, deps, web: w as Web };
}

// ── choosing ─────────────────────────────────────────────────────────────

test('searching the catalogue: exact ticker first, then tickers starting so, then names; shares only', async () => {
  const { db } = await setup();
  assert.deepEqual((await searchCatalogue(db, 'aapl')).map((h) => h.shortName), ['AAPL']);
  // APLE's ticker starts with AP; Apple's only its name does.
  assert.deepEqual((await searchCatalogue(db, 'ap')).map((h) => h.shortName), ['APLE', 'AAPL']);
  const shell = await searchCatalogue(db, 'shell');
  assert.deepEqual(shell.map((h) => [h.shortName, h.market, h.currency]), [['SHEL', 'London', 'GBX']]);
  assert.deepEqual(await searchCatalogue(db, 'igda'), [], 'funds are opened from the portfolio, not here');
  assert.deepEqual(await searchCatalogue(db, '%'), [], 'a wildcard is just a character');
});

// ── opening ──────────────────────────────────────────────────────────────

async function listing(db: NodeDb, id: number) {
  const [l] = await db.query('SELECT ticker, exchange, currency, isin FROM listing WHERE id = ?', [id]);
  const keys = Object.fromEntries((await db.query('SELECT source, source_key FROM listing_source_key WHERE listing_id = ?', [id]))
    .map((k) => [k['source'], k['source_key']]));
  return { ...l, keys };
}

test('opening Apple: identity confirmed by ISIN, and every site’s name for it', async () => {
  const { db, deps } = await setup();
  const out = await openCompany('AAPL_US_EQ', deps);
  assert.equal(out.kind, 'opened');
  if (out.kind !== 'opened') return;
  assert.deepEqual(await listing(db, out.listingId), {
    ticker: 'AAPL', exchange: 'NMS', currency: 'USD', isin: 'US0378331005',
    keys: { yahoo: 'AAPL', stockanalysis: 'aapl', t212: 'AAPL_US_EQ', finviz: 'AAPL' },
  });
});

test('opening Shell in London: pence, Yahoo SHEL.L, and no Finviz name at all', async () => {
  const { db, deps } = await setup();
  const out = await openCompany('SHELl_EQ', deps);
  assert.equal(out.kind, 'opened');
  if (out.kind !== 'opened') return;
  assert.deepEqual(await listing(db, out.listingId), {
    ticker: 'SHEL', exchange: 'LSE', currency: 'GBp', isin: 'GB00BP6MXD84',
    keys: { yahoo: 'SHEL.L', stockanalysis: 'lon/SHEL', t212: 'SHELl_EQ' },
  });
  const [prices] = await db.query('SELECT count(*) AS n FROM price WHERE listing_id = ?', [out.listingId]);
  assert.ok(Number(prices!['n']) > 2500, 'prices arrive with the opening');
});

test('the same ISIN quoted in another currency is a different listing, and is refused', async () => {
  const { db, deps } = await setup();
  await saveCatalogue(db, [{ ...CATALOGUE[2]!, ticker: 'SHELLa_EQ', currency: 'EUR' }], '2026-10-05T12:00:00Z');
  const out = await openCompany('SHELLa_EQ', deps);
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') assert.match(out.reason, /stockanalysis quotes Shell in GBX, Trading 212 in EUR: not the same listing/);
  assert.equal((await db.query('SELECT count(*) AS n FROM listing'))[0]!['n'], 0);
});

test('a fund is not opened as a company', async () => {
  const { deps } = await setup();
  const out = await openCompany('IGDAl_EQ', deps);
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') assert.match(out.reason, /is a fund/);
});

test('opening a company twice is the same listing, with no second lookup', async () => {
  const { deps, web: w } = await setup();
  const first = await openCompany('AAPL_US_EQ', deps);
  w.asked.length = 0;
  assert.deepEqual(await openCompany('AAPL_US_EQ', deps), first);
  assert.deepEqual(w.asked, []);
});

// ── the report ───────────────────────────────────────────────────────────

test('before any refresh, every panel says so', async () => {
  const { db, deps } = await setup();
  const out = await openCompany('SHELl_EQ', deps);
  const r = (await loadReport(db, (out as { listingId: number }).listingId))!;
  assert.ok(r.prices && r.prices.bars.length > 0, 'the price chart already has its data');
  assert.deepEqual(r.predictions, { kind: 'collapsed', reason: 'Not refreshed yet — press Refresh' });
});

test('2.5 ACCEPTANCE — a London share’s analyst predictions collapse with the reason, not blank', async () => {
  const { db, deps } = await setup();
  const { listingId } = (await openCompany('SHELl_EQ', deps)) as { listingId: number };
  await refreshCompany(listingId, deps);
  const r = (await loadReport(db, listingId))!;

  assert.deepEqual(r.predictions, { kind: 'collapsed', reason: 'Finviz covers US listings only' });
  assert.deepEqual(r.keyStats, { kind: 'collapsed', reason: 'Finviz covers US listings only' });
  assert.equal(r.figures.kind, 'ok');
  if (r.figures.kind === 'ok') {
    assert.equal(r.figures.data.source, 'stockanalysis');
    assert.deepEqual(r.figures.data.periods, ['FY2021', 'FY2022', 'FY2023', 'FY2024', 'FY2025']);
    const revenue = r.figures.data.rows.find((x) => x.concept === 'revenue')!;
    assert.equal(revenue.cells.at(-1)?.value, 266_886_000_000);
    assert.equal(revenue.cells.at(-1)?.currency, 'USD');
    assert.match(revenue.cells.at(-1)!.detail, /stockanalysis income-statement/);
  }
  assert.equal(r.sector, 'Energy', 'from the stockanalysis profile read when opening');
});

test('a US share: ten years of filed figures, analyst predictions apart from the facts, and the missing US earnings date explained', async () => {
  const { db, deps } = await setup();
  const { listingId } = (await openCompany('AAPL_US_EQ', deps)) as { listingId: number };
  await refreshCompany(listingId, deps);
  const r = (await loadReport(db, listingId))!;

  assert.equal(r.figures.kind, 'ok');
  if (r.figures.kind === 'ok') {
    assert.equal(r.figures.data.periods.length, 10);
    assert.match(r.figures.data.rows[0]!.cells.at(-1)!.detail, /^us-gaap:/);
  }
  assert.equal(r.predictions.kind, 'ok');
  if (r.predictions.kind === 'ok') {
    assert.ok(r.predictions.data.every((f) => f.kind === 'estimate' && f.fieldPath.startsWith('analyst.')));
  }
  assert.equal(r.keyStats.kind, 'ok');
  if (r.keyStats.kind === 'ok') {
    assert.deepEqual(r.keyStats.data.map((g) => g.title), ['Valuation', 'Last 12 months', 'Profitability', 'Financial health',
      'Dividends', 'Ownership and short interest', 'Trading', 'Price performance', 'The company']);
    const company = r.keyStats.data.find((g) => g.title === 'The company')!;
    assert.ok(company.facts.some((f) => f.fieldPath === 'company.employees' && f.value === 166_000));
  }
  if (r.calendar.kind === 'ok') {
    assert.match(r.calendar.data.gaps.find((g) => g.fieldPath === 'calendar.next_earnings')!.reason, /Nasdaq calendar/);
  }
});

test('a source that failed at the latest refresh shows its last good data, marked stale', async () => {
  const { db, deps, web: w } = await setup();
  const { listingId } = (await openCompany('AAPL_US_EQ', deps)) as { listingId: number };
  await refreshCompany(listingId, deps);
  const [first] = await db.query('SELECT captured_at FROM snapshot ORDER BY captured_at');
  w.route(finviz.request('AAPL').url, 429);
  await refreshCompany(listingId, deps);

  const r = (await loadReport(db, listingId))!;
  assert.equal(r.predictions.kind, 'ok');
  if (r.predictions.kind === 'ok') {
    assert.deepEqual(r.predictions.stale, { capturedAt: first!['captured_at'], why: 'unavailable: Finviz: rate limited' });
  }
});

test('the research list: what has been opened, most recently refreshed first', async () => {
  const { db, deps } = await setup();
  const apple = (await openCompany('AAPL_US_EQ', deps)) as { listingId: number };
  const shell = (await openCompany('SHELl_EQ', deps)) as { listingId: number };
  await refreshCompany(shell.listingId, deps);
  assert.deepEqual((await listReports(db)).map((r) => [r.ticker, r.refreshedAt !== null]), [['SHEL', true], ['AAPL', false]]);
  assert.ok(apple.listingId !== shell.listingId);
});

test('a company first seen inside a fund is shown by Trading 212’s name, not the fund file’s', async () => {
  const { db, deps } = await setup();
  await db.query("INSERT INTO security (isin, name, kind, created_at) VALUES ('US0378331005', 'APPLE INC USD0.00001', 'equity', '2026-09-23')");
  const { listingId } = (await openCompany('AAPL_US_EQ', deps)) as { listingId: number };
  assert.equal((await loadReport(db, listingId))!.summary.name, 'Apple');
});
