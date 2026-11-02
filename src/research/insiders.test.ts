/**
 * Insider dealings: Finviz's table for US shares, London's Director/PDMR
 * notices.  PROJECT-PLAN.md §11.7 step 2.8
 *
 * Fixtures are the sites' own responses: Finviz for Apple (5 October) and
 * Walmart (2 November); nine London notices from Shell, Tesco, Lloyds, BP and
 * Vodafone (2 November), five layouts of the same regulatory form.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Transport, HttpRequest, HttpResponse } from '../fetch/types.ts';
import { MemoryDiagnostics } from '../fetch/fixture.ts';
import { NodeDb, migrationsFromDisk } from '../db/node.ts';
import { migrate } from '../db/migrate.ts';
import { search, profile, statement, statistics } from '../sources/stockanalysis.ts';
import { yahooPrices } from '../sources/yahoo.ts';
import { edgarSearch, edgarSubmissions, edgarConcept } from '../sources/edgar.ts';
import { finviz, type FinvizPage } from '../sources/finviz.ts';
import { investegate, investegateNotice, type PdmrNotice } from '../sources/investegate.ts';
import { TAGS, DEPRECIATION_TAGS } from './edgar.ts';
import { saveCatalogue } from './catalogue.ts';
import { openCompany } from './open.ts';
import { refreshCompany } from './company.ts';
import { loadReport } from './report.ts';
import { finvizDealings, noticeDealings, londonKind, writtenDate, writtenPrice, roleLevel, type Dealing } from './insiders.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fetch/fixtures/${name}`, import.meta.url));
const page = async (name: string) => ({ status: 200, body: new Uint8Array(await readFile(fixture(name))), contentType: 'text/html' });
const noClose = async () => null;

async function finvizPage(name: string): Promise<FinvizPage> {
  return finviz.parse(await page(name), {} as never) as FinvizPage;
}
async function notice(id: string): Promise<PdmrNotice> {
  return investegateNotice.parse(await page(`investegate-pdmr-${id}.html`), {} as never) as PdmrNotice;
}
const NOTICE_ISIN: Record<string, string> = { shel: 'GB00BP6MXD84', tsco: 'GB00BLGZ9862', lloy: 'GB0008706128', bp: 'GB0007980591', vod: 'GB00BH4HKS39' };
async function london(id: string, published: string, close: Parameters<typeof noticeDealings>[2] = noClose): Promise<Dealing[]> {
  const n = await notice(id);
  return noticeDealings(n.people, { url: `https://www.investegate.co.uk/announcement/${id}`, published, isin: NOTICE_ISIN[id.split('-')[0]!]! }, close);
}

// ── what a dealing is called ─────────────────────────────────────────────

test('London: bought or sold only in the market — purchase or acquisition, sale or disposal, and no plan', () => {
  assert.equal(londonKind('Sale of Ordinary shares'), 'sold');
  assert.equal(londonKind('Purchase of shares'), 'bought');
  // Plans, dividends, awards and options are "other", whatever the verb.
  assert.equal(londonKind('Purchase of shares by the Trustees under the Partnership Share Scheme of the Company’s Share Incentive Plan'), 'other');
  assert.equal(londonKind('Shares acquired through participation in the BP ShareMatch UK Plan'), 'other');
  assert.equal(londonKind('Dividend shares in respect of shares previously delivered under the annual bonus'), 'other');
  assert.equal(londonKind('Sale of shares to cover tax on vesting'), 'other');
  assert.equal(londonKind('Exercise of options and sale of shares'), 'other');
  // Shell's and Lloyds' words for market dealings count (decided 2026-11-02)…
  assert.equal(londonKind('Disposal of ordinary shares'), 'sold');
  assert.equal(londonKind('Acquisition of Shares'), 'bought');
  // …but not when they come from a plan or an award.
  assert.equal(londonKind('Acquisition of Shares under the Group’s Share Incentive Plan.'), 'other');
  assert.equal(londonKind('Conditional award of performance shares of Shell plc under the Shell Share Plan 2023'), 'other');
  assert.equal(londonKind('Sale and purchase of shares'), 'other', 'both at once: not one or the other');
});

test('London prices and dates as the notices write them', () => {
  assert.deepEqual(writtenPrice('£33.41'), { value: 33.41, currency: 'GBP' });
  assert.deepEqual(writtenPrice('€39.115'), { value: 39.115, currency: 'EUR' });
  assert.deepEqual(writtenPrice('GBP00.95744'), { value: 0.95744, currency: 'GBP' });
  assert.deepEqual(writtenPrice('£ 1.26725'), { value: 1.26725, currency: 'GBP' });
  assert.deepEqual(writtenPrice('535.2p'), { value: 535.2, currency: 'GBp' }, 'pence are pence');
  assert.deepEqual(writtenPrice('5.863'), { value: 5.863, currency: null }, 'no symbol: the form’s currency field decides');
  assert.equal(writtenPrice('See 4(c)'), null);
  assert.equal(writtenDate('2026-10-15'), '2026-10-15');
  assert.equal(writtenDate('July 31, 2026'), '2026-07-31');
  assert.equal(writtenDate('28 August 2026'), '2026-08-28');
  assert.equal(writtenDate('24/09/2026'), '2026-09-24', 'a UK form: day first');
  assert.equal(writtenDate('the 3rd'), null);
});

// ── who they are ─────────────────────────────────────────────────────────

test('each title as filed gets a level by fixed rules — every title in the saved Finviz pages and London notices', async () => {
  const cases: [string | null, string][] = [
    // executive
    ['Chief Executive Officer', 'executive'], ['Group Chief Executive Officer', 'executive'], ['President & CEO', 'executive'],
    ['President and CEO', 'executive'], ['President, Upstream', 'executive'], ['Chief Legal Officer and Company Secretary', 'executive'],
    ['Senior Vice President, CFO', 'executive'], ['Chief financial officer / director', 'executive'], ['UK CEO', 'executive'],
    ['CEO, Wealth & Insurance', 'executive'], ['Chief Sustainability Officer and Chief Corporate Affairs Officer', 'executive'],
    ['Executive Chair', 'executive'], ['Chief Legal Officer', 'executive'], ['Chief Financial Officer', 'executive'],
    ['President, Downstream, Renewables and Energy Solutions', 'executive'], ['President, Integrated Gas', 'executive'],
    ['President, Trading and Supply', 'executive'], ['Chief Human Resources and Corporate Officer', 'executive'],
    ['Chief People and Places Officer', 'executive'], ['CEO, Business & Commercial Banking', 'executive'],
    ['Chief Risk Officer', 'executive'], ['CEO, Consumer', 'executive'], ['Chief People Officer', 'executive'],
    ['Chief Strategy and Transformation Officer', 'executive'], ['Chief Technology Officer', 'executive'],
    ['CEO, Central Europe', 'executive'], ['Chief External and Corporate Affairs Officer', 'executive'],
    // board — "Non-Executive Director" is not an executive director
    ['Director', 'board'], ['Non-Executive Director', 'board'], ['Senior Independent Director', 'board'], ['Chairman', 'board'],
    // shareholders who file: Walmart's Walton family
    ['10% Owner', 'shareholder'], ['Other: Shareholder', 'shareholder'], ['Other: Stockholder', 'shareholder'],
    // other
    ['Executive Vice President', 'other'], ['EVP, Upstream', 'other'], ['SVP, GC and Government Affairs', 'other'],
    ['Senior Vice President', 'other'], ['Vice President, Finance', 'other'], ['Principal Accounting Officer', 'other'],
    ['Group General Counsel', 'other'], ['Former Director', 'other'], ['Former officer', 'other'],
    ['SVP, GC and Secretary', 'other'], ['EVP supply, trading & shipping', 'other'], ['EVP, legal', 'other'],
    ['Person closely associated with Wael Sawan, Chief Executive Officer', 'other'],
    // not stated: a Form 144 records no title
    ['Officer', 'not-stated'], [null, 'not-stated'], ['', 'not-stated'],
  ];
  for (const [title, level] of cases) assert.equal(roleLevel(title), level, String(title));
  // A title the saved pages hold but this table does not is noticed, so its level is decided, not assumed.
  const seen = new Set<string>();
  for (const name of ['finviz-aapl.html', 'finviz-wmt.html']) for (const r of (await finvizPage(name)).insiders!.rows) seen.add(r.cells[1]!);
  for (const name of (await readdir(fileURLToPath(new URL('../fetch/fixtures/', import.meta.url)))).filter((f) => f.startsWith('investegate-pdmr-'))) {
    for (const p of (await notice(name.replace(/^investegate-pdmr-|\.html$/g, ''))).people) seen.add(p.position ?? '');
  }
  const known = new Set(cases.map(([t]) => t));
  assert.deepEqual([...seen].filter((t) => !known.has(t)), []);
  assert.equal(seen.size, 43);
});

// ── Finviz (US) ──────────────────────────────────────────────────────────

test('Finviz’s Apple table: sales and intended sales, each linked to its SEC filing', async () => {
  const p = await finvizPage('finviz-aapl.html');
  const read = await finvizDealings(p.insiders!, noClose);
  assert.ok(Array.isArray(read));
  if (!Array.isArray(read)) return;
  assert.equal(read.length, 29);
  assert.deepEqual([...new Set(read.map((d) => `${d.wording} → ${d.kind}`))].sort(), ['Proposed Sale → intends-to-sell', 'Sale → sold']);
  const sale = read.find((d) => d.person === 'Newstead Jennifer' && d.tradedOn === '2026-09-29')!;
  assert.deepEqual([sale.shares, sale.price, sale.value, sale.currency, sale.sharesAfter, sale.filedOn],
    [2399, 336.18, 806496, 'USD', 41992, '2026-10-01']);
  assert.ok(read.every((d) => d.url.startsWith('https://www.sec.gov/Archives/edgar/data/320193/')), 'the SEC filing, over https');
  assert.ok(read.every((d) => !d.valueWorkedOut), 'Finviz states the value');
});

test('a market dealing far from that day’s close is left out with the reason — Finviz’s Cook line at $15.27', async () => {
  const p = await finvizPage('finviz-aapl.html');
  // Apple closed at $333.69 on 2 October (Yahoo); other days are not compared here.
  const read = await finvizDealings(p.insiders!, async (date) => (date === '2026-10-02' ? { close: 333.69, currency: 'USD', date } : null));
  if (!Array.isArray(read)) return assert.fail('read');
  const out = read.filter((d) => d.leftOut !== null);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.person, 'COOK TIMOTHY D');
  assert.match(out[0]!.leftOut!, /the price, \$15\.27, is far from the close of \$333\.69 on 2 October 2026/);
});

test('a Finviz value that is not price × shares is left out', async () => {
  const p = await finvizPage('finviz-aapl.html');
  const row = p.insiders!.rows[3]!;
  const edited = { ...p.insiders!, rows: [{ ...row, cells: row.cells.map((c, i) => (i === 6 ? '9,999,999' : c)) }] };
  const read = await finvizDealings(edited, noClose);
  if (!Array.isArray(read)) return assert.fail('read');
  assert.match(read[0]!.leftOut!, /not the price × shares/);
});

test('Finviz shows only its latest 100: Walmart’s reach back to 14 January, not a year', async () => {
  const p = await finvizPage('finviz-wmt.html');
  const read = await finvizDealings(p.insiders!, noClose);
  if (!Array.isArray(read)) return assert.fail('read');
  assert.equal(read.length, 100);
  assert.equal(read.map((d) => d.tradedOn!).sort()[0], '2026-01-14');
});

test('a changed Finviz insider table is suspect; a page without one lists nothing', async () => {
  const p = await finvizPage('finviz-aapl.html');
  const read = await finvizDealings({ ...p.insiders!, headings: p.insiders!.headings.map((h) => (h === 'Cost' ? 'Price' : h)) }, noClose);
  assert.ok(!Array.isArray(read) && /has changed/.test(read.suspect));
  const html = (await readFile(fixture('finviz-aapl.html'), 'utf8')).replace('>Insider Trading</th>', '>Something else</th>');
  const none = finviz.parse({ status: 200, body: new TextEncoder().encode(html), contentType: 'text/html' }, {} as never) as FinvizPage;
  assert.equal(none.insiders, null);
  assert.ok(none.fields.length > 80, 'the key statistics are unaffected');
});

// ── London notices ───────────────────────────────────────────────────────

test('Shell’s dividend shares: "other", in the currency and place each was dealt; the New York shares left out', async () => {
  const read = await london('shel-9794052', '2026-09-28T07:00:00');
  assert.equal(read.length, 12);
  assert.ok(read.every((d) => d.kind === 'other'));
  const ceo = read.filter((d) => d.person === 'Wael Sawan');
  assert.deepEqual(ceo.map((d) => [d.currency, d.price, d.shares, d.place, d.tradedOn]),
    [['EUR', 42.2073, 2211.85048, 'Amsterdam', '2026-09-24'], ['GBP', 36.17998, 2001.51133, 'London', '2026-09-24']]);
  const ads = read.filter((d) => d.leftOut !== null);
  assert.equal(ads.length, 1);
  assert.match(ads[0]!.leftOut!, /a different security, US7802593050: American Depositary Shares/);
});

test('Tesco’s sales: sold, value worked out as price × shares; its share-plan purchases are "other"', async () => {
  const sales = await london('tsco-9828090', '2026-10-16T07:00:00');
  assert.deepEqual(sales.map((d) => [d.person, d.role, d.kind, d.price, d.currency, d.shares, d.value, d.valueWorkedOut, d.leftOut]), [
    ['Emma Taylor', 'Chief People Officer', 'sold', 5.326514, 'GBP', 141116, 751656.35, true, null],
    ['Natasha Adams', 'Chief Strategy and Transformation Officer', 'sold', 5.348, 'GBP', 187389, 1002156.37, true, null],
  ]);
  const plan = await london('tsco-9841910', '2026-10-24T07:00:00');
  assert.equal(plan.length, 5);
  assert.ok(plan.every((d) => d.kind === 'other' && d.leftOut === null));
});

test('Vodafone: the price per share, not the total its aggregated line calls a price', async () => {
  const [d] = await london('vod-9782046', '2026-09-19T07:00:00');
  assert.deepEqual([d!.kind, d!.price, d!.shares, d!.value, d!.currency], ['sold', 1.26725, 500000, 633625, 'GBP']);
});

test('Lloyds: one line for each price and volume, with the form’s own row labels', async () => {
  const gray = await london('lloy-9853925', '2026-10-31T07:00:00');
  assert.deepEqual(gray.map((d) => [d.kind, d.wording, d.price, d.shares, d.currency]), [
    ['bought', 'Acquisition of Shares', 0.95744, 40375, 'GBP'],
    ['bought', 'Acquisition of Shares', 0.9542, 1000, 'GBP'],
  ]);
  const plan = await london('lloy-9818867', '2026-10-10T07:00:00');
  assert.deepEqual(plan.slice(0, 2).map((d) => [d.wording.replace(/^.*— /, ''), d.price, d.shares]),
    [['Partnership Shares', 1.006, 30], ['Matching Shares', 0, 44]]);
});

test('BP: no currency field, so the price’s own £ decides', async () => {
  const read = await london('bp-9820972', '2026-10-13T07:00:00');
  assert.equal(read.length, 4);
  assert.ok(read.every((d) => d.currency === 'GBP' && d.price === 5.863 && d.kind === 'other' && d.leftOut === null));
});

test('the pence trap: a price in pounds that is really pence is left out, not believed', async () => {
  const close = async (date: string) => ({ close: 533.0, currency: 'GBp', date });
  const ok = await london('tsco-9828090', '2026-10-16T07:00:00', close);
  assert.ok(ok.every((d) => d.leftOut === null), '£5.33 is 533p: agrees');
  const n = await notice('tsco-9828090');
  const wrong = n.people.map((p) => ({ ...p, dealings: p.dealings.map((t) => ({ ...t, lines: t.lines.map((l) => ({ ...l, price: '£532.65' })) })) }));
  const read = await noticeDealings(wrong, { url: 'u', published: '2026-10-16T07:00:00', isin: 'GB00BLGZ9862' }, close);
  assert.match(read[0]!.leftOut!, /the price, £532\.65, is far from the close of 533p/);
});

test('a date outside the month before the notice is left out — a form written month first is caught', async () => {
  const read = await london('shel-9794052', '2026-11-30T07:00:00');
  assert.ok(read.every((d) => d.leftOut !== null));
  assert.match(read[0]!.leftOut!, /not in the month before the notice/);
});

// ── 2.8 acceptance ───────────────────────────────────────────────────────

class Web implements Transport {
  readonly #routes = new Map<string, string | number>();
  route(url: string, fileOrStatus: string | number): this { this.#routes.set(url, fileOrStatus); return this; }
  async get(req: HttpRequest): Promise<HttpResponse> {
    const route = this.#routes.get(req.url) ?? (req.url.includes('/companyconcept/') ? 404 : undefined);
    if (route === undefined) throw new Error(`nothing served at ${req.url}`);
    if (typeof route === 'number') return { status: route, body: new Uint8Array(), contentType: 'text/plain' };
    return { status: 200, body: new Uint8Array(await readFile(route)), contentType: 'text/html' };
  }
}

/** Every Director/PDMR notice in Shell's two saved pages of announcements (May–October). */
const SHELL_NOTICES = ['9794052', '9748639', '9706040', '9699314', '9653947', '9582840', '9580273'];

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
    .route(statistics.request('aapl').url, fixture('sa-aapl-statistics.html'))
    .route(statistics.request('lon/SHEL').url, fixture('sa-shel-statistics.html'))
    .route(investegate.request('SHEL|1').url, fixture('investegate-shel-1.html'))
    .route(investegate.request('SHEL|2').url, fixture('investegate-shel-2.html'))
    .route(investegate.request('SHEL|3').url, 404);
  for (const id of SHELL_NOTICES) {
    w.route(`https://www.investegate.co.uk/announcement/gnw/shell--shel/director-pdmr-shareholding/${id}`, fixture(`investegate-pdmr-shel-${id}.html`));
  }
  for (const which of ['income-statement', 'balance-sheet', 'cash-flow-statement']) {
    w.route(statement.request(`lon/SHEL|${which}`).url, fixture(`sa-shel-${which}.html`));
  }
  for (const tag of [...Object.values(TAGS).flat(), ...DEPRECIATION_TAGS]) {
    const file = fixture(`edgar-concept-aapl-${tag}.json`);
    try { await readFile(file); w.route(edgarConcept.request(`0000320193:${tag}`).url, file); } catch { /* 404 */ }
  }
  return w;
}

async function refreshed(t212Ticker: string) {
  const db = new NodeDb();
  await migrate(db, await migrationsFromDisk());
  await saveCatalogue(db, [
    { ticker: 'AAPL_US_EQ', isin: 'US0378331005', name: 'Apple', shortName: 'AAPL', currency: 'USD', type: 'STOCK' },
    { ticker: 'SHELl_EQ', isin: 'GB00BP6MXD84', name: 'Shell', shortName: 'SHEL', currency: 'GBX', type: 'STOCK' },
  ], '2026-10-05T12:00:00Z');
  let tick = 0;
  const deps = { db, diagnostics: new MemoryDiagnostics(), transport: await web(), pause: async () => {},
    now: () => new Date(Date.UTC(2026, 9, 5, 18, 0, tick++)) };
  const o = await openCompany(t212Ticker, deps);
  if (o.kind !== 'opened') throw new Error(o.reason);
  const r = await refreshCompany(o.listingId, deps);
  if (r.kind !== 'saved') throw new Error(r.reason);
  return { db, report: (await loadReport(db, o.listingId))!, sources: r.sources };
}

test('2.8 ACCEPTANCE — Apple’s and Shell’s reports list the last year of dealings, each line linked to its filing; intended sales and plan shares are never market dealings; Finviz’s $15.27 line left out with its reason', async () => {
  // Apple: Finviz's table, read from the page already fetched for the key statistics.
  const apple = await refreshed('AAPL_US_EQ');
  assert.equal(apple.report.dealings.kind, 'ok', JSON.stringify(apple.report.dealings));
  if (apple.report.dealings.kind !== 'ok') return;
  const a = apple.report.dealings.data;
  assert.equal(a.source, 'finviz');
  assert.equal(a.dealings.length + a.leftOut.length, 29);
  assert.ok(a.dealings.every((d) => d.person && d.role && d.tradedOn && d.shares && d.price && d.value && d.currency === 'USD'));
  assert.ok(a.dealings.every((d) => d.url.startsWith('https://www.sec.gov/')), 'every line opens its SEC filing');
  assert.ok(a.dealings.filter((d) => d.wording === 'Proposed Sale').every((d) => d.kind === 'intends-to-sell'), 'an intended sale is not a sale');
  assert.equal(a.leftOut.length, 1);
  assert.match(a.leftOut[0]!.leftOut!, /\$15\.27, is far from the close/);
  assert.match(apple.report.dealings.data.note!, /Finviz listed 29 dealings, back to 16 October 2025/);

  // Shell: its Director/PDMR notices, found in the year of announcements.
  const shell = await refreshed('SHELl_EQ');
  assert.equal(shell.report.dealings.kind, 'ok', JSON.stringify([shell.report.dealings, shell.sources]));
  if (shell.report.dealings.kind !== 'ok') return;
  const s = shell.report.dealings.data;
  assert.equal(s.source, 'investegate');
  assert.deepEqual([...new Set(s.dealings.map((d) => d.url.split('/').pop()))].sort(), SHELL_NOTICES.slice().sort());
  const dividend = s.dealings.filter((d) => /^Dividend shares/.test(d.wording));
  assert.ok(dividend.length > 0 && dividend.every((d) => d.kind === 'other'), 'share-plan dividend shares are "other"');
  assert.ok(s.dealings.filter((d) => /award/i.test(d.wording)).every((d) => d.kind === 'other'), 'awards too');
  // Shell writes its directors' sales as "Disposal of ordinary shares": sold (decided 2026-11-02).
  const sales = s.dealings.filter((d) => /^Disposal/.test(d.wording));
  assert.deepEqual(sales.map((d) => [d.person, d.tradedOn, d.kind, d.currency, d.shares]), [
    ['Peter Costello', '2026-08-28', 'sold', 'GBP', 31786],
    ['Peter Costello', '2026-08-28', 'sold', 'EUR', 3214],
    ['Sinead Gorman', '2026-07-31', 'sold', 'GBP', 30000],
    ['Philippa Bounds', '2026-07-31', 'sold', 'GBP', 8000],
    ['Wael Sawan', '2026-05-22', 'sold', 'EUR', 40000],
  ]);
  assert.deepEqual([...new Set(s.dealings.map((d) => d.currency))].sort(), ['EUR', 'GBP'], 'each in the currency the notice states');
  assert.ok(s.dealings.every((d) => d.person && d.role && d.tradedOn && d.shares !== null && d.price !== null && d.value !== null));
  assert.ok(s.leftOut.length > 0 && s.leftOut.every((d) => /a different security, US7802593050/.test(d.leftOut!)), 'the New York shares are a different security');
  assert.ok(shell.sources.some((o) => o.source === 'insider-dealings' && o.outcome === 'ok'));
  // Each line carries its person's level beside the title.
  assert.deepEqual([...new Set(s.dealings.filter((d) => d.person === 'Wael Sawan').map((d) => d.level))], ['executive']);
  assert.deepEqual([...new Set(a.dealings.filter((d) => d.role === 'Officer').map((d) => d.level))], ['not-stated']);
});

test('a share outside the US and London collapses with the reason', async () => {
  const db = new NodeDb();
  await migrate(db, await migrationsFromDisk());
  const { fetchInsiders } = await import('./insiders.ts');
  const { securityStatement, ensureListing } = await import('../portfolio/master.ts');
  await db.batch([securityStatement('CH0012005267', 'Novartis', 'equity', '2026-10-05')]);
  const id = await ensureListing(db, { isin: 'CH0012005267', ticker: 'NOVN', exchange: 'EBS', currency: 'CHF', sourceKeys: { yahoo: 'NOVN.SW' } });
  const out = await fetchInsiders(id, { db, diagnostics: new MemoryDiagnostics(), transport: new Web() }, null, null);
  assert.deepEqual(out, { source: 'insider-dealings', outcome: 'not-covered', detail: 'Insider dealings are read for US and London shares only so far' });
});
