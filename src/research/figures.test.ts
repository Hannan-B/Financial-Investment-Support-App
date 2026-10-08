/**
 * Company figures from EDGAR, stockanalysis and Finviz, against responses
 * captured on 2026-10-05.
 * §11.7 step 2.3: Walmart's missing GrossProfit produces a visible gap, not a wrong number.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Transport, HttpRequest, HttpResponse } from '../fetch/types.ts';
import { MemoryDiagnostics } from '../fetch/fixture.ts';
import { NodeDb, migrationsFromDisk } from '../db/node.ts';
import { migrate } from '../db/migrate.ts';
import { edgarSearch, edgarSubmissions, edgarConcept } from '../sources/edgar.ts';
import { wikidataCik } from '../sources/wikidata.ts';
import { statement } from '../sources/stockanalysis.ts';
import { finviz } from '../sources/finviz.ts';
import { monthDayYear } from '../lib/dates.ts';
import { findCik, edgarFigures, TAGS, DEPRECIATION_TAGS, type FiguresDeps } from './edgar.ts';
import { stockanalysisFigures } from './stockanalysis.ts';
import { finvizFigures, ANALYST_PREFIX } from './finviz.ts';
import { series, type Figures, type FiguresOutcome } from './figures.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fetch/fixtures/${name}`, import.meta.url));
const WALMART = '0000104169';
const APPLE = '0000320193';

/** Serves fixtures by URL; an EDGAR concept with no fixture answers 404, as EDGAR does. */
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

function edgarWeb(): Web {
  const web = new Web()
    .route(edgarSearch.request('AAPL').url, fixture('edgar-search-aapl.json'))
    .route(edgarSearch.request('WMT').url, fixture('edgar-search-wmt.json'))
    .route(edgarSubmissions.request(APPLE).url, fixture('edgar-submissions-aapl.json'))
    .route(edgarSubmissions.request(WALMART).url, fixture('edgar-submissions-wmt.json'));
  for (const [cik, co] of [[APPLE, 'aapl'], [WALMART, 'wmt']] as const) {
    for (const tag of [...Object.values(TAGS).flat(), ...DEPRECIATION_TAGS]) {
      web.route(edgarConcept.request(`${cik}:${tag}`).url, fixture(`edgar-concept-${co}-${tag}.json`));
    }
  }
  return web;
}

/** Concept fixtures that do not exist on disk stand for tags never filed: serve 404 for those. */
async function only404sForMissing(web: Web): Promise<Web> {
  for (const [cik, co] of [[APPLE, 'aapl'], [WALMART, 'wmt']] as const) {
    for (const tag of [...Object.values(TAGS).flat(), ...DEPRECIATION_TAGS]) {
      try { await readFile(fixture(`edgar-concept-${co}-${tag}.json`)); } catch { web.route(edgarConcept.request(`${cik}:${tag}`).url, 404); }
    }
  }
  return web;
}

async function deps(transport: Transport): Promise<FiguresDeps & { db: NodeDb; diagnostics: MemoryDiagnostics }> {
  const db = new NodeDb();
  await migrate(db, await migrationsFromDisk());
  return { db, diagnostics: new MemoryDiagnostics(), transport, now: () => new Date('2026-10-05T18:00:00Z'), pause: async () => {} };
}

function figures(out: FiguresOutcome): Figures {
  assert.equal(out.kind, 'ok', out.kind !== 'ok' ? out.reason : '');
  return (out as { figures: Figures }).figures;
}

const byPeriod = (f: Figures, concept: Parameters<typeof series>[1]) => new Map(series(f, concept).map((x) => [x.period, x]));

// ── EDGAR ────────────────────────────────────────────────────────────────

test('2.3 ACCEPTANCE — Walmart’s missing GrossProfit is a visible gap, not a wrong number', async () => {
  const d = await deps(await only404sForMissing(edgarWeb()));
  const f = figures(await edgarFigures(WALMART, 'Walmart Inc.', d));

  assert.equal(series(f, 'gross_profit').length, 0, 'no gross profit figure of any kind');
  const gap = f.gaps.find((g) => g.fieldPath === 'income.gross_profit');
  assert.ok(gap, 'the missing figure is reported');
  assert.match(gap.reason, /Walmart Inc\. files no annual gross profit under GrossProfit/);
  // Everything else is there, for ten years.
  for (const concept of ['revenue', 'operating_income', 'ebitda', 'net_income', 'eps', 'total_assets', 'equity', 'operating_cash_flow'] as const) {
    assert.equal(series(f, concept).length, 10, concept);
  }
  assert.equal(f.gaps.length, 1);
});

test('Walmart’s revenue is its total revenues, not net sales without membership income', async () => {
  const d = await deps(await only404sForMissing(edgarWeb()));
  const revenue = byPeriod(figures(await edgarFigures(WALMART, 'Walmart Inc.', d)), 'revenue');
  const fy2026 = revenue.get('FY2026')!;
  assert.equal(fy2026.value, 713_163_000_000, 'Revenues, not RevenueFromContractWithCustomer (706.4B)');
  assert.equal(fy2026.periodEnd, '2026-01-31', 'Walmart’s year ending January 2026 is its FY2026');
  assert.match(fy2026.detail, /^us-gaap:Revenues, 10-K filed/);
  assert.equal(fy2026.currency, 'USD');
  assert.equal(fy2026.kind, 'actual');
  assert.equal(fy2026.tier, 1);
});

test('net income and equity are the shareholders’ share, ahead of totals that include minority interests', async () => {
  const d = await deps(await only404sForMissing(edgarWeb()));
  const f = figures(await edgarFigures(WALMART, 'Walmart Inc.', d));
  assert.match(byPeriod(f, 'net_income').get('FY2026')!.detail, /^us-gaap:NetIncomeLoss,/);
  assert.match(byPeriod(f, 'equity').get('FY2026')!.detail, /^us-gaap:StockholdersEquity,/);
});

test('Apple’s revenue joins three tags across the years into one ten-year series', async () => {
  const d = await deps(await only404sForMissing(edgarWeb()));
  const f = figures(await edgarFigures(APPLE, 'Apple Inc.', d));
  const revenue = series(f, 'revenue');
  assert.deepEqual(revenue.map((r) => r.period), ['FY2016', 'FY2017', 'FY2018', 'FY2019', 'FY2020', 'FY2021', 'FY2022', 'FY2023', 'FY2024', 'FY2025']);
  const tags = new Set(revenue.map((r) => r.detail.split(',')[0]));
  assert.deepEqual([...tags].sort(), ['us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax', 'us-gaap:Revenues']);
  const fy2025 = byPeriod(f, 'revenue').get('FY2025')!;
  assert.equal(fy2025.value, 416_161_000_000);
  assert.equal(fy2025.periodEnd, '2025-09-27');
  assert.equal(byPeriod(f, 'gross_profit').get('FY2025')!.value, 195_201_000_000);
  assert.equal(f.gaps.length, 0);
});

test('balances are taken only at fiscal year ends', async () => {
  const d = await deps(await only404sForMissing(edgarWeb()));
  const f = figures(await edgarFigures(APPLE, 'Apple Inc.', d));
  const yearEnds = new Set(series(f, 'revenue').map((r) => r.periodEnd));
  for (const a of series(f, 'total_assets')) assert.ok(yearEnds.has(a.periodEnd), `${a.periodEnd} is a year end`);
});

test('a figure a company never filed is an answer, not a failure: nothing is logged', async () => {
  const d = await deps(await only404sForMissing(edgarWeb()));
  await edgarFigures(WALMART, 'Walmart Inc.', d);
  assert.equal(d.diagnostics.log.length, 0);
  const [health] = await d.db.query("SELECT consecutive_failures FROM source_health WHERE source = 'edgar-concept'");
  assert.equal(health?.['consecutive_failures'], 0);
});

test('EDGAR failing partway gives no figures at all, never a partial set', async () => {
  const web = (await only404sForMissing(edgarWeb())).route(edgarConcept.request(`${WALMART}:Assets`).url, 503);
  const out = await edgarFigures(WALMART, 'Walmart Inc.', await deps(web));
  assert.equal(out.kind, 'unavailable');
  if (out.kind === 'unavailable') assert.match(out.reason, /EDGAR Assets: server error \(503\)/);
});

// ── finding the company ──────────────────────────────────────────────────

test('the SEC number is found by the search box and confirmed against the company’s own record', async () => {
  const d = await deps(edgarWeb());
  assert.deepEqual(await findCik('wmt', 'Nasdaq', d), { kind: 'found', cik: WALMART, name: 'Walmart Inc.', via: 'edgar-search' });
});

test('the right ticker on the wrong exchange is refused, with the reason', async () => {
  const out = await findCik('WMT', 'NYSE', await deps(edgarWeb()));
  assert.equal(out.kind, 'not-found');
  if (out.kind === 'not-found') assert.match(out.reason, /Walmart Inc\. \(0000104169\) lists WMT on Nasdaq/);
});

test('when the search box has no exact match, Wikidata is asked — and still confirmed by the SEC', async () => {
  // The search for AAPL here returns only Walmart-like hits, none listing AAPL.
  const web = edgarWeb()
    .route(edgarSearch.request('AAPL').url, fixture('edgar-search-wmt.json'))
    .route(wikidataCik.request('AAPL').url, fixture('wikidata-cik-aapl.json'));
  assert.deepEqual(await findCik('AAPL', 'Nasdaq', await deps(web)), { kind: 'found', cik: APPLE, name: 'Apple Inc.', via: 'wikidata' });
});

test('a search hit that merely contains the ticker in its name is not taken', async () => {
  // 'Permuto Capital AAPL Trust I' is in the AAPL results with no tickers of its own.
  const web = edgarWeb();
  const d = await deps(web);
  await findCik('AAPL', 'Nasdaq', d);
  assert.ok(!web.asked.some((u) => u.includes('CIK0002055491')), 'never even looked at');
});

// ── stockanalysis ────────────────────────────────────────────────────────

function shellWeb(): Web {
  return new Web()
    .route(statement.request('lon/SHEL|income-statement').url, fixture('sa-shel-income-statement.html'))
    .route(statement.request('lon/SHEL|balance-sheet').url, fixture('sa-shel-balance-sheet.html'))
    .route(statement.request('lon/SHEL|cash-flow-statement').url, fixture('sa-shel-cash-flow-statement.html'));
}

test('Shell from stockanalysis: five fiscal years in dollars, as reported, and the latest quarter left out', async () => {
  const f = figures(await stockanalysisFigures('lon/SHEL', 'Shell plc', await deps(shellWeb())));
  const revenue = series(f, 'revenue');
  assert.deepEqual(revenue.map((r) => r.period), ['FY2021', 'FY2022', 'FY2023', 'FY2024', 'FY2025']);
  assert.equal(revenue.at(-1)!.value, 266_886_000_000);
  assert.ok(!f.facts.some((x) => x.periodEnd === 'TTM' || x.period === 'FY2026'), 'no trailing-twelve-month figure');
  for (const x of f.facts.filter((x) => x.period)) {
    assert.equal(x.currency, 'USD', 'Shell reports in dollars, though its London price is in pence');
    assert.equal(x.tier, 2);
  }
  assert.equal(byPeriod(f, 'total_assets').get('FY2025')!.value, 370_350_000_000);
  assert.equal(series(f, 'operating_cash_flow').length, 5);
  assert.equal(f.gaps.length, 0);
});

test('figures are taken in the currency the page states — euros for a London listing like Vodafone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sa-'));
  const web = shellWeb();
  for (const which of ['income-statement', 'balance-sheet', 'cash-flow-statement']) {
    const html = (await readFile(fixture(`sa-shel-${which}.html`), 'utf8')).replace('financial:"USD"', 'financial:"EUR"');
    await writeFile(join(dir, `${which}.html`), html);
    web.route(statement.request(`lon/SHEL|${which}`).url, join(dir, `${which}.html`));
  }
  const f = figures(await stockanalysisFigures('lon/SHEL', 'Shell plc', await deps(web)));
  assert.ok(f.facts.filter((x) => x.period).every((x) => x.currency === 'EUR'));
});

test('a page about a different company is refused', async () => {
  const web = new Web().route(statement.request('lon/BP|income-statement').url, fixture('sa-shel-income-statement.html'));
  const out = await stockanalysisFigures('lon/BP', 'BP p.l.c.', await deps(web));
  assert.equal(out.kind, 'suspect');
  if (out.kind === 'suspect') assert.match(out.reason, /asked stockanalysis for LON-BP, got LON-SHEL/);
});

test('a company stockanalysis does not have is not covered — distinct from the site failing', async () => {
  const web = new Web().route(statement.request('lon/NOPE|income-statement').url, 404);
  assert.equal((await stockanalysisFigures('lon/NOPE', 'Nope', await deps(web))).kind, 'not-covered');
});

// ── Finviz ───────────────────────────────────────────────────────────────

test('Finviz: analyst predictions are estimates under their own heading; ownership and short interest are facts', async () => {
  const web = new Web().route(finviz.request('AAPL').url, fixture('finviz-aapl.html'));
  const f = figures(await finvizFigures('aapl', await deps(web)));
  const get = (p: string) => f.facts.find((x) => x.fieldPath === p)!;

  assert.deepEqual([get('analyst.target_price').value, get('analyst.target_price').currency], [335.75, 'USD']);
  assert.equal(get('analyst.rating').value, 2.16);
  assert.equal(get('analyst.eps_next_year').value, 9.61, 'the first "EPS next Y" is the amount');
  assert.equal(get('analyst.eps_growth_next_year').value, 8.74, 'the second is the growth rate');
  assert.equal(get('analyst.forward_pe').value, 34.73);
  assert.ok(f.facts.filter((x) => x.fieldPath.startsWith(ANALYST_PREFIX)).every((x) => x.kind === 'estimate'));

  assert.deepEqual([get('ownership.insider_pct').value, get('ownership.insider_pct').kind], [0.12, 'actual']);
  assert.equal(get('short.float_pct').value, 0.88);
  assert.equal(get('calendar.last_ex_dividend').value, '2026-08-10');
  assert.ok(!f.facts.some((x) => x.fieldPath.startsWith('income.')), 'trailing-twelve-month sales are not taken');
});

test('Finviz has no London listings, and the New York ticker is never used instead', async () => {
  const web = new Web().route(finviz.request('SHEL.L').url, 404);
  const out = await finvizFigures('SHEL.L', await deps(web));
  assert.equal(out.kind, 'not-covered');
  assert.deepEqual(web.asked, [finviz.request('SHEL.L').url], 'one request, for exactly the ticker asked');
});

test('a Finviz page for a different ticker is refused', async () => {
  const web = new Web().route(finviz.request('MSFT').url, fixture('finviz-aapl.html'));
  const out = await finvizFigures('MSFT', await deps(web));
  assert.equal(out.kind, 'suspect');
  if (out.kind === 'suspect') assert.match(out.reason, /asked Finviz for MSFT, got AAPL/);
});

test('one Finviz value in an unexpected shape is a gap with the reason; the rest of the page is kept', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fv-'));
  const html = (await readFile(fixture('finviz-aapl.html'), 'utf8')).replace('>335.75<', '>335,75<');
  await writeFile(join(dir, 'p.html'), html);
  const web = new Web().route(finviz.request('AAPL').url, join(dir, 'p.html'));
  const f = figures(await finvizFigures('AAPL', await deps(web)));
  assert.ok(!f.facts.some((x) => x.fieldPath === 'analyst.target_price'));
  assert.match(f.gaps.find((g) => g.fieldPath === 'analyst.target_price')!.reason, /not in the expected form/);
  assert.ok(f.facts.length > 80);
});

test('many Finviz values in unexpected shapes mean the page has changed: none of it is used', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fv-'));
  // Every percentage written with a comma: the page's format has changed.
  const html = (await readFile(fixture('finviz-aapl.html'), 'utf8')).replace(/>(-?\d+)\.(\d+)%</g, '>$1,$2%<');
  await writeFile(join(dir, 'p.html'), html);
  const web = new Web().route(finviz.request('AAPL').url, join(dir, 'p.html'));
  const out = await finvizFigures('AAPL', await deps(web));
  assert.equal(out.kind, 'suspect');
  if (out.kind === 'suspect') assert.match(out.reason, /values not in the expected form/);
});

test('the whole Finviz snapshot is kept: valuation, health, employees, EPS — forecasts marked as such', async () => {
  const web = new Web().route(finviz.request('AAPL').url, fixture('finviz-aapl.html'));
  const f = figures(await finvizFigures('AAPL', await deps(web)));
  const get = (p: string) => f.facts.find((x) => x.fieldPath === p)!;
  assert.equal(f.facts.length, 82);
  assert.equal(get('company.employees').value, 166_000);
  assert.equal(get('valuation.market_cap').value, 4_870_000_000_000);
  assert.equal(get('health.debt_equity').value, 0.78);
  assert.deepEqual([get('analyst.peg').value, get('analyst.peg').kind], [2.73, 'estimate']);
  assert.deepEqual([get('analyst.dividend_next_year').value, get('analyst.dividend_yield_next_year').value], [1.1, 0.33]);
  assert.deepEqual([get('trading.high_52w').value, get('trading.below_high_52w').value], [345.34, -3.37]);
  assert.equal(get('company.ipo_date').value, '1980-12-12');
  assert.ok(!f.facts.some((x) => /rsi|sma|atr/i.test(x.fieldPath)), 'the app works those out itself');
  assert.ok(!f.facts.some((x) => x.fieldPath.startsWith('income.')), 'twelve-month figures stay out of the fiscal years');
});

// ── dates ────────────────────────────────────────────────────────────────

test('dates as the sites write them', () => {
  assert.equal(monthDayYear('Oct 29, 2026'), '2026-10-29');
  assert.equal(monthDayYear('Aug 1, 2026'), '2026-08-01');
  assert.equal(monthDayYear('n/a'), null);
  assert.equal(monthDayYear('-'), null);
  assert.throws(() => monthDayYear('29/10/2026'));
});

test('EPS arrives per share, in dollars — the latest filing’s figure, so restated after splits', async () => {
  const d = await deps(await only404sForMissing(edgarWeb()));
  const apple = byPeriod(figures(await edgarFigures(APPLE, 'Apple Inc.', d)), 'eps').get('FY2025')!;
  assert.deepEqual([apple.value, apple.unit, apple.currency], [7.46, 'USD/share', 'USD']);
  const walmart = byPeriod(figures(await edgarFigures(WALMART, 'Walmart Inc.', d)), 'eps').get('FY2024')!;
  assert.equal(walmart.value, 1.91, 'after the 2024 three-for-one split, not the $5.65 first filed');
});

test('EBITDA is worked out — operating income plus depreciation — and says so', async () => {
  const d = await deps(await only404sForMissing(edgarWeb()));
  const f = figures(await edgarFigures(APPLE, 'Apple Inc.', d));
  const ebitda = byPeriod(f, 'ebitda').get('FY2025')!;
  const opInc = byPeriod(f, 'operating_income').get('FY2025')!.value as number;
  assert.equal(ebitda.value, opInc + 11_698_000_000);
  assert.match(ebitda.detail, /^worked out: operating income \(us-gaap:OperatingIncomeLoss\) \d+ \+ depreciation and amortisation \(us-gaap:DepreciationDepletionAndAmortization\) 11698000000$/);
  assert.equal(series(f, 'ebitda').length, 10);
});

test('Walmart’s depreciation changed tag around 2019; EBITDA still covers every year', async () => {
  const d = await deps(await only404sForMissing(edgarWeb()));
  const ebitda = series(figures(await edgarFigures(WALMART, 'Walmart Inc.', d)), 'ebitda');
  assert.equal(ebitda.length, 10);
  assert.match(ebitda.at(-1)!.detail, /DepreciationAmortizationAndAccretionNet/);
});
