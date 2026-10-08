/**
 * Results and ex-dividend dates: next or last, never confused.  Against
 * stockanalysis's statistics pages for Apple, Oracle and Shell and Finviz's
 * Apple page.
 * Done when (agreed with 2.3's US dates, 2026-10-08): Apple's next results
 * show 2 Nov 2026, confirmed; a company between announcements shows no next
 * date, with the reason — never its last one.
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
import { finviz } from '../sources/finviz.ts';
import { usEarningsDate, exDividendFact } from './calendar.ts';
import { keyStatistics } from './statistics.ts';
import { finvizFigures } from './finviz.ts';
import type { Figures, FiguresOutcome } from './figures.ts';
import type { FiguresDeps } from './edgar.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fetch/fixtures/${name}`, import.meta.url));

class Web implements Transport {
  readonly #routes = new Map<string, string | number>();
  route(url: string, fileOrStatus: string | number): this { this.#routes.set(url, fileOrStatus); return this; }
  async get(req: HttpRequest): Promise<HttpResponse> {
    const route = this.#routes.get(req.url);
    if (route === undefined) throw new Error(`nothing served at ${req.url}`);
    if (typeof route === 'number') return { status: route, body: new Uint8Array(), contentType: 'text/plain' };
    return { status: 200, body: new Uint8Array(await readFile(route)), contentType: 'text/html' };
  }
}

async function deps(transport: Transport, day = '2026-10-08'): Promise<FiguresDeps> {
  const db = new NodeDb();
  await migrate(db, await migrationsFromDisk());
  return { db, diagnostics: new MemoryDiagnostics(), transport, now: () => new Date(`${day}T18:00:00Z`), pause: async () => {} };
}

function figures(out: FiguresOutcome): Figures {
  assert.equal(out.kind, 'ok', out.kind !== 'ok' ? out.reason : '');
  return (out as { figures: Figures }).figures;
}

/** A fixture, edited, served at `url`. */
async function edited(name: string, edit: (html: string) => string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cal-'));
  await writeFile(join(dir, name), edit(await readFile(fixture(name), 'utf8')));
  return join(dir, name);
}

const next = (f: Figures) => f.facts.find((x) => x.fieldPath === 'calendar.next_earnings');
const gap = (f: Figures, path = 'calendar.next_earnings') => f.gaps.find((g) => g.fieldPath === path)?.reason;

test('2.3 ACCEPTANCE (US dates) — Apple’s next results: 2 Nov 2026, confirmed, after the market closes', async () => {
  const web = new Web().route(statistics.request('aapl').url, fixture('sa-aapl-statistics.html'));
  const f = figures(await usEarningsDate('aapl', await deps(web)));
  assert.deepEqual([next(f)?.value, next(f)?.kind, next(f)?.detail], ['2026-11-02', 'estimate', 'stockanalysis: confirmed, after market close'],
    'Apple announced 2 November on 6 October; Nasdaq’s vendor still guessed 29 October');
  assert.equal(f.facts.length, 1, 'Finviz gives US ex-dividend dates; not taken twice');
});

test('2.3 ACCEPTANCE (US dates) — between announcements the date shown is the last results: no next date, and the reason', async () => {
  // Oracle in October 2026: stockanalysis's date field says "Sep 10, 2026" under "Earnings Date".
  const web = new Web().route(statistics.request('orcl').url, fixture('sa-orcl-statistics.html'));
  const f = figures(await usEarningsDate('orcl', await deps(web)));
  assert.equal(next(f), undefined);
  assert.equal(gap(f), 'no date announced yet — the last results were on 2026-09-10');
});

test('Shell: the next results are taken because the page says they are confirmed; the ex-dividend date is past, so the last', async () => {
  const web = new Web().route(statistics.request('lon/SHEL').url, fixture('sa-shel-statistics.html'));
  const f = figures(await keyStatistics('lon/SHEL', 'GBp', await deps(web)));
  assert.deepEqual([next(f)?.value, next(f)?.kind, next(f)?.detail], ['2026-10-29', 'estimate', 'stockanalysis: confirmed']);
  const exDiv = f.facts.find((x) => x.fieldPath === 'calendar.last_ex_dividend')!;
  assert.deepEqual([exDiv.value, exDiv.kind], ['2026-08-13', 'actual']);
});

test('a "next" date that has already passed is not shown as next', async () => {
  const web = new Web().route(statistics.request('aapl').url, fixture('sa-aapl-statistics.html'));
  const f = figures(await usEarningsDate('aapl', await deps(web, '2026-11-05')));
  assert.equal(next(f), undefined);
  assert.match(gap(f)!, /"next" date, 2026-11-02, has already passed/);
});

test('wording the reader does not know is a gap, never a guess', async () => {
  const file = await edited('sa-aapl-statistics.html', (h) => h.replaceAll('The next confirmed earnings date is', 'The next estimated earnings date is'));
  const f = figures(await usEarningsDate('aapl', await deps(new Web().route(statistics.request('aapl').url, file))));
  assert.equal(next(f), undefined);
  assert.match(gap(f)!, /^stockanalysis's wording was not recognised: "The next estimated earnings date is Monday, November 2, 2026/);
});

test('the sentence and the date field must agree', async () => {
  const file = await edited('sa-aapl-statistics.html', (h) => h.replace('value:"Nov 2, 2026",hover:"Nov 2, 2026"', 'value:"Nov 3, 2026",hover:"Nov 3, 2026"'));
  const f = figures(await usEarningsDate('aapl', await deps(new Web().route(statistics.request('aapl').url, file))));
  assert.equal(next(f), undefined);
  assert.match(gap(f)!, /sentence \(2026-11-02\) and its date field \(Nov 3, 2026\) disagree/);
});

test('dates from a page about another company are refused; no page is not covered', async () => {
  const web = new Web().route(statistics.request('msft').url, fixture('sa-aapl-statistics.html')).route(statistics.request('nope').url, 404);
  const wrong = await usEarningsDate('msft', await deps(web));
  assert.equal(wrong.kind, 'suspect');
  if (wrong.kind === 'suspect') assert.match(wrong.reason, /asked stockanalysis for MSFT, got AAPL/);
  assert.equal((await usEarningsDate('nope', await deps(web))).kind, 'not-covered');
});

test('an ex-dividend date still to come is the next one, held as an estimate — Finviz too', async () => {
  // Walmart's was declared for 11 Dec 2026 and shown in October, on both sites.
  const file = await edited('finviz-aapl.html', (h) => h.replace('>Aug 10, 2026<', '>Dec 11, 2026<'));
  const f = figures(await finvizFigures('AAPL', await deps(new Web().route(finviz.request('AAPL').url, file))));
  const exDiv = f.facts.filter((x) => /ex_dividend/.test(x.fieldPath));
  assert.deepEqual(exDiv.map((x) => [x.fieldPath, x.value, x.kind]), [['calendar.next_ex_dividend', '2026-12-11', 'estimate']]);
  assert.equal(exDividendFact('2026-10-08', '2026-10-08', 'finviz', '').fieldPath, 'calendar.last_ex_dividend', 'on the day itself, it has happened');
});
