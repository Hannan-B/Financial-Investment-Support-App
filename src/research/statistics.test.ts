/**
 * Key statistics from stockanalysis's statistics page, against Shell's and
 * SAP's pages captured on 2026-10-08.
 * §11.7 step 2.7: Shell's employee count, EV/EBITDA, debt to equity and
 * target price (in pence), each in the right currency.
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
import { statistics } from '../sources/stockanalysis.ts';
import { keyStatistics, appCurrency, NOT_TAKEN, STATISTICS_FIELDS } from './statistics.ts';
import { FINVIZ_NAMES, ANALYST_PREFIX } from './finviz.ts';
import { STAT_GROUPS } from './report.ts';
import type { Figures, FiguresOutcome } from './figures.ts';
import type { FiguresDeps } from './edgar.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fetch/fixtures/${name}`, import.meta.url));

class Web implements Transport {
  readonly asked: string[] = [];
  readonly #routes = new Map<string, string | number>();
  route(url: string, fileOrStatus: string | number): this { this.#routes.set(url, fileOrStatus); return this; }
  async get(req: HttpRequest): Promise<HttpResponse> {
    this.asked.push(req.url);
    const route = this.#routes.get(req.url);
    if (route === undefined) throw new Error(`nothing served at ${req.url}`);
    if (typeof route === 'number') return { status: route, body: new Uint8Array(), contentType: 'text/plain' };
    return { status: 200, body: new Uint8Array(await readFile(route)), contentType: 'text/html' };
  }
}

async function deps(transport: Transport): Promise<FiguresDeps & { db: NodeDb; diagnostics: MemoryDiagnostics }> {
  const db = new NodeDb();
  await migrate(db, await migrationsFromDisk());
  return { db, diagnostics: new MemoryDiagnostics(), transport, now: () => new Date('2026-10-08T18:00:00Z'), pause: async () => {} };
}

function figures(out: FiguresOutcome): Figures {
  assert.equal(out.kind, 'ok', out.kind !== 'ok' ? out.reason : '');
  return (out as { figures: Figures }).figures;
}

/** Shell's page, served as found or edited — to test the failures. */
async function shell(edit: (html: string) => string = (h) => h): Promise<FiguresOutcome> {
  const dir = await mkdtemp(join(tmpdir(), 'sa-stats-'));
  await writeFile(join(dir, 'p.html'), edit(await readFile(fixture('sa-shel-statistics.html'), 'utf8')));
  return keyStatistics('lon/SHEL', 'GBp', await deps(new Web().route(statistics.request('lon/SHEL').url, join(dir, 'p.html'))));
}

const get = (f: Figures, path: string) => f.facts.find((x) => x.fieldPath === path);
const gap = (f: Figures, path: string) => f.gaps.find((g) => g.fieldPath === path)?.reason;

test('2.7 ACCEPTANCE — Shell: employees, EV/EBITDA, debt to equity and the target price in pence, each in its currency', async () => {
  const f = figures(await shell());
  assert.deepEqual([get(f, 'company.employees')?.value, get(f, 'company.employees')?.currency], [84_000, null]);
  assert.deepEqual([get(f, 'valuation.ev_ebitda')?.value, get(f, 'valuation.ev_ebitda')?.unit], [5.15, 'ratio']);
  assert.deepEqual([get(f, 'health.debt_equity')?.value, get(f, 'health.debt_equity')?.unit], [0.4, 'ratio']);
  const target = get(f, 'analyst.target_price')!;
  assert.deepEqual([target.value, target.unit, target.currency, target.kind], [4012.04, 'GBp/share', 'GBp', 'estimate'],
    'pence, like the share price — not pounds, like the company amounts beside it');
});

test('Shell’s company amounts are in pounds, as stockanalysis converted them from dollars — and say so', async () => {
  const f = figures(await shell());
  const cap = get(f, 'valuation.market_cap')!;
  assert.deepEqual([cap.value, cap.unit, cap.currency], [216_402_153_472, 'GBP', 'GBP']);
  assert.match(cap.detail, /^stockanalysis statistics "Market Cap", converted by stockanalysis from USD$/);
  const eps = get(f, 'ttm.eps')!;
  assert.deepEqual([eps.value, eps.unit], [3.394, 'GBP/share'], 'the fuller figure, not the 3.39 the table shows');
  assert.deepEqual([get(f, 'ttm.income_tax')?.value, get(f, 'ttm.income_tax')?.currency], [10_360_000_000, 'GBP'], 'written "10.36B" even in full');
  const dividend = get(f, 'dividend.annual')!;
  assert.deepEqual([dividend.value, dividend.unit], [1.154, 'GBP/share']);
  assert.doesNotMatch(dividend.detail, /converted/, 'dividends are in their own stated currency');
  assert.equal(get(f, 'trading.average_volume_20d')?.value, 8_456_813);
});

test('forecasts are estimates under analyst.; everything else is fact, and nothing is a twelve-month figure among the fiscal years', async () => {
  const f = figures(await shell());
  const analyst = f.facts.filter((x) => x.fieldPath.startsWith(ANALYST_PREFIX));
  assert.deepEqual(analyst.map((x) => [x.fieldPath, x.kind]), [
    ['analyst.target_price', 'estimate'], ['analyst.consensus', 'estimate'], ['analyst.count', 'actual'],
    ['analyst.forward_pe', 'estimate'], ['analyst.peg', 'estimate'],
    ['analyst.revenue_growth_next_3y', 'estimate'], ['analyst.eps_growth_next_3y', 'estimate'],
  ]);
  assert.equal(get(f, 'analyst.consensus')?.value, 'Buy');
  assert.ok(f.facts.filter((x) => !x.fieldPath.startsWith(ANALYST_PREFIX) && x.fieldPath !== 'calendar.next_earnings')
    .every((x) => x.kind === 'actual'), 'the next results date is an estimate too: it can move (calendar.test.ts)');
  assert.ok(f.facts.every((x) => x.period === null), 'no fiscal-year figures: those come from the statements');
  assert.ok(!f.facts.some((x) => /rsi|sma/i.test(x.fieldPath)), 'the app works those out itself');
});

test('a London share has no short-interest figures: gaps with the reason, not zeros', async () => {
  const f = figures(await shell());
  assert.equal(f.facts.length, 89, '87 statistics and two dates');
  assert.match(gap(f, 'short.float_pct')!, /^stockanalysis shows no shares sold short for LON-SHEL$/);
  assert.ok(!get(f, 'short.float_pct'));
});

test('SAP in Frankfurt: everything in euros, nothing converted, and its last split read as a date', async () => {
  const web = new Web().route(statistics.request('etr/SAP').url, fixture('sa-sap-statistics.html'));
  const f = figures(await keyStatistics('etr/SAP', 'EUR', await deps(web)));
  assert.ok(f.facts.filter((x) => x.currency).every((x) => x.currency === 'EUR'));
  assert.ok(!f.facts.some((x) => /converted/.test(x.detail)));
  assert.deepEqual([get(f, 'analyst.target_price')?.unit, get(f, 'company.last_split_date')?.value], ['EUR/share', '2006-12-21']);
});

// ── the currency trap ────────────────────────────────────────────────────

test('company amounts that do not agree with the price are not taken — ratios still are', async () => {
  // Market value a hundred times too big: as if counted in pence while labelled pounds.
  const f = figures(await shell((h) => h.replace('hover:"216,402,153,472"', 'hover:"21,640,215,347,200"')));
  assert.ok(!get(f, 'ttm.revenue'));
  assert.match(gap(f, 'ttm.revenue')!, /currency is not certain: market value ÷ shares \(3780\.5\d*\) is not the price \(37\.805\) in GBP/);
  assert.equal(get(f, 'valuation.ev_ebitda')?.value, 5.15, 'ratios carry no currency');
  assert.equal(get(f, 'analyst.target_price')?.currency, 'GBp', 'the price currency is confirmed separately');
});

test('a target price that is not where the page says it is from the price is not taken', async () => {
  // The target written in pounds while the page prices in pence.
  const f = figures(await shell((h) => h.replace('{id:"priceTarget",title:"Price Target",value:"4,012.04",hover:"4,012.04"}',
    '{id:"priceTarget",title:"Price Target",value:"40.12",hover:"40.12"}')));
  assert.ok(!get(f, 'analyst.target_price'));
  assert.match(gap(f, 'analyst.target_price')!, /40\.12 is not 6\.13% from the price of 3780\.5 GBX/);
});

test('a dividend that does not give the stated yield is not taken', async () => {
  const f = figures(await shell((h) => h.replace('{id:"dps",title:"Dividend Per Share",value:"1.15",hover:"1.154"}',
    '{id:"dps",title:"Dividend Per Share",value:"115.40",hover:"115.4"}')));
  assert.ok(!get(f, 'dividend.annual'));
  assert.match(gap(f, 'dividend.annual')!, /not the stated yield of 3\.052%/);
  assert.equal(get(f, 'dividend.annual_yield')?.value, 3.052);
});

test('a currency the app does not know leaves its amounts as gaps, never a guess', async () => {
  const f = figures(await shell((h) => h.replace('curr:{main:"GBP"', 'curr:{main:"ZAC"')));
  assert.ok(!f.facts.some((x) => x.detail.includes('converted')), 'no company amount taken');
  assert.match(gap(f, 'valuation.market_cap')!, /stockanalysis states them in ZAC, which the app does not know/);
  assert.equal(get(f, 'dividend.annual')?.currency, 'GBP', 'dividends state their own currency, confirmed separately');
  assert.equal(appCurrency('GBX'), 'GBp', 'pence, said explicitly');
  assert.equal(appCurrency('GBp'), null, 'the site never writes that; if it did, it would not be guessed at');
});

test('a page pricing the share in another currency than the listing’s is a different listing: refused', async () => {
  const out = await shell((h) => h.replace('price:"GBX"', 'price:"USD"'));
  assert.equal(out.kind, 'suspect');
  assert.match((out as { reason: string }).reason, /prices LON-SHEL in USD; the listing is in GBp/);
});

// ── the page ─────────────────────────────────────────────────────────────

test('a statistics page about a different company is refused', async () => {
  const web = new Web().route(statistics.request('lon/BP.').url, fixture('sa-shel-statistics.html'));
  const out = await keyStatistics('lon/BP.', 'GBp', await deps(web));
  assert.equal(out.kind, 'suspect');
  if (out.kind === 'suspect') assert.match(out.reason, /asked stockanalysis for LON-BP\., got LON-SHEL/);
});

test('no statistics page is not covered — distinct from the site failing', async () => {
  const web = new Web().route(statistics.request('lon/NOPE').url, 404).route(statistics.request('lon/DOWN').url, 503);
  assert.equal((await keyStatistics('lon/NOPE', 'GBp', await deps(web))).kind, 'not-covered');
  assert.equal((await keyStatistics('lon/DOWN', 'GBp', await deps(web))).kind, 'unavailable');
});

test('one value in an unexpected shape is a gap with the reason; many mean the page has changed', async () => {
  const one = figures(await shell((h) => h.replace('hover:"0.40"', 'hover:"0,40"')));
  assert.match(gap(one, 'health.debt_equity')!, /"Debt \/ Equity" was not in the expected form/);
  assert.equal(one.facts.length, 88);

  const many = await shell((h) => h.replace(/hover:"(-?\d+)\.(\d+)%"/g, 'hover:"$1,$2%"'));
  assert.equal(many.kind, 'suspect');
  assert.match((many as { reason: string }).reason, /values not in the expected form/);
});

test('every figure on the page is taken or set aside with a reason — a new one is noticed', async () => {
  const html = await readFile(fixture('sa-shel-statistics.html'), 'utf8');
  const onPage = [...html.matchAll(/\{id:"(\w+)",title:/g)].map((m) => m[1]!);
  const taken = new Set(STATISTICS_FIELDS.map((x) => x.id));
  assert.deepEqual(onPage.filter((id) => !taken.has(id) && !(id in NOT_TAKEN)), []);
  assert.equal(onPage.length, 106);
});

test('a figure Finviz also has shares its field path and its name, and every one has a place on the report', () => {
  for (const x of STATISTICS_FIELDS) {
    if (x.path in FINVIZ_NAMES) assert.equal(x.name, FINVIZ_NAMES[x.path], x.path);
    assert.ok(x.path.startsWith(ANALYST_PREFIX) || STAT_GROUPS.some((g) => g.paths.test(x.path)), `${x.path} would never be shown`);
  }
  assert.equal(new Set(STATISTICS_FIELDS.map((x) => x.path)).size, STATISTICS_FIELDS.length, 'one path per figure');
});
