/**
 * Builds the demo portfolio the screens show in a plain browser (`npm run demo`).
 *
 * Holdings are INVENTED (t212-*.synthetic.json). Fund contents are the real
 * public files in src/fetch/fixtures. The 25 company classifications are what
 * the live lookup returned on 2026-09-23 — the state after a first refresh's
 * first minute of lookups. Output goes to src/ui/demo/ (git-ignored).
 *
 * Apple's History tab (§11.9 step 4.1): five earlier refreshes, each made by
 * the app's own code from the saved responses CUT BACK to what was known on
 * that day — Yahoo's prices up to it, the SEC filings filed by it. The other
 * sites' pages were saved only once, so on those days they "did not answer".
 * The checks and their notes are invented.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { NodeDb, migrationsFromDisk } from '../src/db/node.ts';
import { migrate } from '../src/db/migrate.ts';
import { refresh, loadPortfolio, portfolioInput } from '../src/portfolio/refresh.ts';
import { securityStatement, fieldStatement } from '../src/portfolio/master.ts';
import { MemoryDiagnostics, FakeGoogleNews, yahooPageFixture, yahooHistoryPage } from '../src/fetch/fixture.ts';
import { investegate } from '../src/sources/investegate.ts';
import { loadNews } from '../src/research/news.ts';
import { FUNDS, SOURCES } from '../src/sources/funds.ts';
import type { Transport, HttpRequest, HttpResponse, ParseTools } from '../src/fetch/types.ts';
import { saveCatalogue } from '../src/research/catalogue.ts';
import { openCompany } from '../src/research/open.ts';
import { refreshCompany } from '../src/research/company.ts';
import { loadReport, listReports } from '../src/research/report.ts';
import { loadHistoryFacts, knownFigures } from '../src/research/history.ts';
import { search, profile, statement, statistics } from '../src/sources/stockanalysis.ts';
import { historyUrl } from '../src/sources/yahoo.ts';
import { makeBoeRates } from '../src/sources/boe.ts';
import { poundRates } from '../src/portfolio/fx.ts';
import { loadDividends, setUsualRate } from '../src/portfolio/income.ts';
import { loadPurification } from '../src/portfolio/purify.ts';
import { planCompany, planHoldings, planIncome } from '../src/portfolio/plan.ts';
import { edgarSearch, edgarSubmissions, edgarConcept } from '../src/sources/edgar.ts';
import { finviz } from '../src/sources/finviz.ts';
import { TAGS, DEPRECIATION_TAGS } from '../src/research/edgar.ts';
import type { Instrument } from '../src/sources/t212.ts';
import type { ReportData } from '../src/research/report.ts';
import type { NewsView } from '../src/research/news.ts';
import { addEntry, completeReview, setLabel, markIneligible, loadEntries, labelHistory, marksFor } from '../src/notes/store.ts';
import { targetKey } from '../src/notes/targets.ts';
import { big, day } from '../src/ui/format.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../src/fetch/fixtures/${name}`, import.meta.url));
const FILES: Record<string, [string, string]> = {
  ISDE: ['ishares-isde.json', 'application/json'], ISUS: ['ishares-isus.json', 'application/json'],
  ISWD: ['ishares-iswd.json', 'application/json'], IGDA: ['invesco-igda.json', 'application/json'],
  MWIM: ['invesco-mwim.json', 'application/json'], HIPS: ['hsbc-hips.xls', 'application/xls'],
  HIES: ['hsbc-hies.xls', 'application/xls'], HIJS: ['hsbc-hijs.xls', 'application/xls'],
  DJIW: ['waystone-djiw.csv', 'text/csv'],
};

function served(routes: Map<string, [string, string]>): Transport {
  return {
    async get(req: HttpRequest): Promise<HttpResponse> {
      const route = routes.get(req.url);
      if (!route) throw new Error(`nothing at ${req.url}`);
      return { status: 200, body: new Uint8Array(await readFile(route[0])), contentType: route[1] };
    },
  };
}

const tools: ParseTools = {
  async xlsRows(bytes) {
    for (const t of ['hies', 'hips', 'hijs']) {
      if ((await readFile(fixture(`hsbc-${t}.xls`))).length === bytes.length) {
        return JSON.parse(await readFile(fixture(`hsbc-${t}.rows.json`), 'utf8'));
      }
    }
    throw new Error('unknown .xls');
  },
};

// What the live lookup found for IGDA's 25 largest unclassified companies.
const LOOKED_UP: [string, string, string, string][] = [
  ['US67066G1040', 'NVIDIA', 'Technology', 'United States'],
  ['US0378331005', 'APPLE', 'Technology', 'United States'],
  ['US0231351067', 'AMAZON.COM', 'Consumer Discretionary', 'United States'],
  ['US02079K3059', 'ALPHABET', 'Communication Services', 'United States'],
  ['US11135F1012', 'BROADCOM', 'Technology', 'United States'],
  ['US02079K1079', 'ALPHABET', 'Communication Services', 'United States'],
  ['US30303M1027', 'META PLATFORMS', 'Communication Services', 'United States'],
  ['US5324571083', 'ELI LILLY', 'Healthcare', 'United States'],
  ['US92826C8394', 'VISA', 'Financials', 'United States'],
  ['US9311421039', 'WALMART', 'Consumer Staples', 'United States'],
  ['US00287Y1091', 'ABBVIE', 'Healthcare', 'United States'],
  ['US57636Q1040', 'MASTERCARD', 'Financials', 'United States'],
  ['US58933Y1055', 'MERCK', 'Healthcare', 'United States'],
  ['US1912161007', 'COCA-COLA', 'Consumer Staples', 'United States'],
  ['US91324P1021', 'UNITEDHEALTH', 'Healthcare', 'United States'],
  ['CH1499059983', 'ROCHE', 'Healthcare', 'Switzerland'],
  ['US4370761029', 'HOME DEPOT', 'Consumer Discretionary', 'United States'],
  ['CH0012005267', 'NOVARTIS', 'Healthcare', 'Switzerland'],
  ['US68389X1054', 'ORACLE', 'Technology', 'United States'],
  ['US8825081040', 'TEXAS INSTRUMENTS', 'Technology', 'United States'],
  ['US4824801009', 'KLA', 'Technology', 'United States'],
  ['US8835561023', 'THERMO FISHER SCIENTIFIC', 'Healthcare', 'United States'],
  ['CH0038863350', 'NESTLE', 'Consumer Staples', 'Switzerland'],
  ['US5738741041', 'MARVELL TECHNOLOGY', 'Technology', 'United States'],
  ['DE0007236101', 'SIEMENS', 'Industrials', 'Germany'],
];

// The industries the live lookup found for those of them it reached (§11.9 step 4.4) — stockanalysis's own words.
const INDUSTRY: Record<string, string> = {
  US67066G1040: 'Semiconductors', US0378331005: 'Consumer Electronics', US0231351067: 'Internet Retail',
  US02079K3059: 'Internet Content & Information', US02079K1079: 'Internet Content & Information', US11135F1012: 'Semiconductors',
  US30303M1027: 'Internet Content & Information', US5324571083: 'Drug Manufacturers - General', US92826C8394: 'Credit Services',
  US9311421039: 'Discount Stores', US00287Y1091: 'Drug Manufacturers - General', US57636Q1040: 'Credit Services',
  US58933Y1055: 'Drug Manufacturers - General', US1912161007: 'Beverages - Non-Alcoholic', US91324P1021: 'Healthcare Plans',
  CH1499059983: 'Drug Manufacturers - General', US4370761029: 'Home Improvement Retail',
};

const db = new NodeDb();
await migrate(db, await migrationsFromDisk());
const now = () => new Date('2026-09-23T12:00:00Z');

// Purification's usual rate, as he set it (§11.10 step 5.4): each invented sale's item starts with it.
await setUsualRate(db, 5);
const reports = await refresh({
  db, diagnostics: new MemoryDiagnostics(), tools, now, pause: async () => {},
  web: served(new Map(FUNDS.map((f) => [SOURCES[f.issuer].request(f.key).url, [fixture(FILES[f.ticker]![0]), FILES[f.ticker]![1]]]))),
  t212: served(new Map([
    ['/api/v0/equity/positions', [fixture('t212-positions.synthetic.json'), 'application/json']],
    ['/api/v0/equity/metadata/instruments', [fixture('t212-instruments.synthetic.json'), 'application/json']],
    // INVENTED dividends and sales (§11.10 steps 5.2, 5.4), in the shapes Trading 212's documentation gives.
    ['/api/v0/equity/history/dividends?limit=50', [fixture('t212-dividends-1.synthetic.json'), 'application/json']],
    ['/api/v0/equity/history/dividends?limit=50&cursor=1774396800000', [fixture('t212-dividends-2.synthetic.json'), 'application/json']],
    ['/api/v0/equity/history/orders?limit=50', [fixture('t212-orders.synthetic.json'), 'application/json']],
  ])),
});

await db.batch(LOOKED_UP.flatMap(([isin, name, sector, country]) => [
  securityStatement(isin, name, 'equity', now().toISOString()),
  fieldStatement(isin, 'sector', sector, 'stockanalysis', 2, '2026-09-23'),
  fieldStatement(isin, 'country', country, 'stockanalysis', 2, '2026-09-23'),
  ...(INDUSTRY[isin] ? [fieldStatement(isin, 'industry', INDUSTRY[isin], 'stockanalysis', 2, '2026-10-05')] : []),
]));

const out = fileURLToPath(new URL('../src/ui/demo/', import.meta.url));
await mkdir(out, { recursive: true });
await writeFile(out + 'portfolio.json', JSON.stringify(await loadPortfolio(db)));
await writeFile(out + 'reports.json', JSON.stringify(reports));

// ── research: Apple and Shell, opened and refreshed from saved responses ──
// The same code as the app, run against what the sites returned on 2026-10-05.
const CATALOGUE: Instrument[] = [
  { ticker: 'AAPL_US_EQ', isin: 'US0378331005', name: 'Apple', shortName: 'AAPL', currency: 'USD', type: 'STOCK' },
  { ticker: 'SHELl_EQ', isin: 'GB00BP6MXD84', name: 'Shell', shortName: 'SHEL', currency: 'GBX', type: 'STOCK' },
  { ticker: 'NVDA_US_EQ', isin: 'US67066G1040', name: 'NVIDIA', shortName: 'NVDA', currency: 'USD', type: 'STOCK' },
  { ticker: 'BPl_EQ', isin: 'GB0007980591', name: 'BP', shortName: 'BP.', currency: 'GBX', type: 'STOCK' },
];
const OPENED = new Date('2026-10-05T18:00:00Z');   // the clock the demo opens and refreshes with
const routes = new Map<string, [string, string]>([
  [search.request('APPLE').url, [fixture('sa-search-apple.json'), 'application/json']],
  [search.request('SHELL').url, [fixture('sa-search-shell.json'), 'application/json']],
  [profile.request('/stocks/aapl/company/').url, [fixture('sa-profile-aapl.html'), 'text/html']],
  [profile.request('/quote/lon/SHEL/company/').url, [fixture('sa-profile-lon-shel.html'), 'text/html']],
  // Yahoo is read from its history page since 2026-11-13: the saved responses, wrapped as that page.
  [historyUrl('AAPL', OPENED), [await yahooPageFixture(fixture('yahoo-aapl.json'), 'AAPL'), 'text/html']],
  [historyUrl('SHEL.L', OPENED), [await yahooPageFixture(fixture('yahoo-shel-l.json'), 'SHEL.L'), 'text/html']],
  [edgarSearch.request('AAPL').url, [fixture('edgar-search-aapl.json'), 'application/json']],
  [edgarSubmissions.request('0000320193').url, [fixture('edgar-submissions-aapl.json'), 'application/json']],
  [finviz.request('AAPL').url, [fixture('finviz-aapl.html'), 'text/html']],
  [statistics.request('aapl').url, [fixture('sa-aapl-statistics.html'), 'text/html']],
  [statistics.request('lon/SHEL').url, [fixture('sa-shel-statistics.html'), 'text/html']],
  ...['income-statement', 'balance-sheet', 'cash-flow-statement'].map((w) =>
    [statement.request(`lon/SHEL|${w}`).url, [fixture(`sa-shel-${w}.html`), 'text/html']] as [string, [string, string]]),
]);
for (const tag of [...Object.values(TAGS).flat(), ...DEPRECIATION_TAGS]) {
  const file = fixture(`edgar-concept-aapl-${tag}.json`);
  try { await readFile(file); routes.set(edgarConcept.request(`0000320193:${tag}`).url, [file, 'application/json']); } catch { /* never filed */ }
}
routes.set(investegate.request('SHEL|1').url, [fixture('investegate-shel-1.html'), 'text/html']);
routes.set(investegate.request('SHEL|2').url, [fixture('investegate-shel-2.html'), 'text/html']);
// Shell's Director/PDMR notices in those pages, for the insider dealings tab (§11.7 step 2.8).
for (const id of ['9794052', '9748639', '9706040', '9699314', '9653947', '9582840', '9580273']) {
  routes.set(`https://www.investegate.co.uk/announcement/gnw/shell--shel/director-pdmr-shareholding/${id}`, [fixture(`investegate-pdmr-shel-${id}.html`), 'text/html']);
}
const google = new FakeGoogleNews(await readFile(fixture('google-news-apple.xml'), 'utf8'), await readFile(fixture('google-news-shell.xml'), 'utf8'));
const files = served(routes);
const notFound = () => Promise.resolve({ status: 404, body: new Uint8Array(), contentType: 'text/plain' });
const research = {
  db, diagnostics: new MemoryDiagnostics(), pause: async () => {}, now: () => new Date('2026-10-05T18:00:00Z'),
  transport: {
    get: (req: HttpRequest) => req.url.startsWith('https://news.google.com/') ? Promise.resolve(google.answer(req.url))
      : routes.has(req.url) ? files.get(req)
      : req.url.includes('/companyconcept/') || req.url.includes('investegate.co.uk') ? notFound()
      : files.get(req),
  },
};
await saveCatalogue(db, CATALOGUE, '2026-10-05T12:00:00Z');
const opened: Record<string, number> = {};
const reportData: Record<number, unknown> = {};
const newsData: Record<number, unknown> = {};
// What the saved responses knew on an earlier day: prices to that day, filings filed by then. Nothing else.
const EARLIER = ['2025-07-07', '2025-11-03', '2026-02-09', '2026-05-11', '2026-08-03'];
function asKnownOn(day: string): Transport {
  return {
    async get(req: HttpRequest): Promise<HttpResponse> {
      const json = async () => JSON.parse(new TextDecoder().decode((await files.get(req)).body));
      const out = (v: unknown): HttpResponse => ({ status: 200, body: new TextEncoder().encode(JSON.stringify(v)), contentType: 'application/json' });
      if (req.url === historyUrl('AAPL', new Date(`${day}T18:00:00Z`))) {
        const j = JSON.parse(await readFile(fixture('yahoo-aapl.json'), 'utf8'));
        const r = j.chart.result[0];
        const end = Date.parse(`${day}T23:59:59Z`) / 1000;
        const keep = r.timestamp.filter((t: number) => t <= end).length;
        const cut = (a: unknown[]) => a.slice(0, keep);
        r.timestamp = cut(r.timestamp);
        for (const k of Object.keys(r.indicators.quote[0])) r.indicators.quote[0][k] = cut(r.indicators.quote[0][k]);
        r.indicators.adjclose[0].adjclose = cut(r.indicators.adjclose[0].adjclose);
        delete r.meta.currentTradingPeriod;   // that day's last bar is a close
        delete r.events;
        return { status: 200, body: new TextEncoder().encode(yahooHistoryPage(JSON.stringify(j), 'AAPL')), contentType: 'text/html' };
      }
      if (req.url.includes('/companyconcept/') && routes.has(req.url)) {
        const j = await json();
        for (const unit of Object.keys(j.units)) j.units[unit] = j.units[unit].filter((e: { filed: string }) => e.filed <= day);
        return out(j);
      }
      if (req.url === edgarSearch.request('AAPL').url || req.url === edgarSubmissions.request('0000320193').url) return files.get(req);
      if (req.url.includes('/companyconcept/')) return notFound();   // a tag Apple never filed
      return { status: 503, body: new Uint8Array(), contentType: 'text/plain' };
    },
  };
}

for (const t of ['AAPL_US_EQ', 'SHELl_EQ']) {
  const o = await openCompany(t, research);
  if (o.kind !== 'opened') throw new Error(`demo: could not open ${t}: ${o.reason}`);
  if (t === 'AAPL_US_EQ') {
    for (const day of EARLIER) {
      // Opening the company stored ten years of prices to 2026; on this day only those to it were known.
      await db.query('DELETE FROM price WHERE listing_id = ? AND date > ?', [o.listingId, day]);
      const r = await refreshCompany(o.listingId, { ...research, transport: asKnownOn(day), now: () => new Date(`${day}T18:00:00Z`) });
      if (r.kind !== 'saved') throw new Error(`demo: Apple as on ${day}: ${r.reason}`);
    }
  }
  const r = await refreshCompany(o.listingId, research);
  if (r.kind !== 'saved') throw new Error(`demo: could not refresh ${t}: ${r.reason}`);
  opened[t] = o.listingId;
  reportData[o.listingId] = await loadReport(db, o.listingId);
  const [l] = await db.query('SELECT isin FROM listing WHERE id = ?', [o.listingId]);
  const at = new Date('2026-10-05T18:00:00Z');
  newsData[o.listingId] = {
    default: await loadNews(db, String(l!['isin']), at), 'last-180-days': await loadNews(db, String(l!['isin']), at, 'last-180-days'),
  };
}
// ── notes: INVENTED, to show the notes screens (§11.8), written by the app's own code ──
const SHELL = 'GB00BP6MXD84', APPLE = 'US0378331005';
const on = (d: number, h = 9) => new Date(Date.UTC(2026, 9, d, h));
const done = (r: { kind: string; reason?: string }) => { if (r.kind !== 'done') throw new Error(`demo notes: ${r.reason}`); };
const shell = reportData[opened['SHELl_EQ']!] as ReportData;
if (shell.figures.kind !== 'ok') throw new Error('demo: Shell has no figures');
const revenueRow = shell.figures.data.rows.find((r) => r.concept === 'revenue')!;
const revenue = [...revenueRow.cells].reverse().find((c) => c !== null)!;
const headline = (newsData[opened['SHELl_EQ']!] as Record<string, NewsView>)['default']!.official[0];
await setLabel(db, SHELL, 'to_review', on(1));
await setLabel(db, SHELL, 'reviewing', on(5, 18));
done(await addEntry(db, SHELL, { kind: 'opening', body: 'Demo note, invented. Looking at Shell for its cash flow: is the dividend covered, and how much debt is there?' }, on(5, 19)));
done(await addEntry(db, SHELL, { kind: 'comment', tab: 'financials', snapshotId: shell.snapshot!.id,
  target: { key: targetKey.fact(revenue), label: `${revenueRow.name} · ${revenue.period}`, value: big(revenue.value as number, revenue.currency) },
  body: 'Revenue lower than the year before — oil prices, not volumes?' }, on(5, 20)));
if (headline) {
  done(await addEntry(db, SHELL, { kind: 'comment', tab: 'news', snapshotId: shell.snapshot!.id,
    target: { key: targetKey.news(headline.url), label: `${headline.publisher} · ${day(headline.published)}`, value: headline.title },
    body: 'Read this before the results.' }, on(5, 21)));
}
done(await addEntry(db, SHELL, { kind: 'concluding', body: 'Cash flow looks strong; want to see the next results before going further.' }, on(5, 22)));
done(await completeReview(db, SHELL, { stance: 'watching', sold: null, comment: 'Waiting for the next results' }, on(5, 23)));
done(await addEntry(db, SHELL, { kind: 'comment', tab: 'overview', snapshotId: shell.snapshot!.id, target: null, body: 'Second look: the price has drifted since.' }, on(20)));
// Apple: five checks, one after each earlier refresh, so the History tab has something to show.
const at = (day: string, h: number) => new Date(`${day}T${String(h).padStart(2, '0')}:00:00Z`);
await setLabel(db, APPLE, 'reviewing', at(EARLIER[0]!, 19));
done(await addEntry(db, APPLE, { kind: 'opening', body: 'Demo note, invented. Apple: how much of the price is the services business?' }, at(EARLIER[0]!, 19)));
const CONCLUSIONS = [
  'Services growing; waiting for the full-year results.',
  'Full-year results in: revenue and margins up.',
  'Nothing new since the results; the price has kept rising.',
  'Shares well above their 200-day average now.',
  'Price fell back below its 20-day average over the summer.',
];
for (const [i, day] of EARLIER.entries()) {
  done(await addEntry(db, APPLE, { kind: 'concluding', body: `Demo note, invented. ${CONCLUSIONS[i]}` }, at(day, 20)));
  done(await completeReview(db, APPLE, { stance: 'watching', sold: null, comment: '' }, at(day, 21)));
}
const fund = (await loadPortfolio(db)).holdings.find((h) => h.kind === 'etf')!;
done(await markIneligible(db, fund.isin, { sellBy: { basis: 'date', date: '2026-10-31' }, note: 'Demo marker, invented' }, on(15)));
const notes: Record<string, unknown> = {};
for (const isin of [SHELL, APPLE, fund.isin]) {
  notes[isin] = { entries: await loadEntries(db, isin), labels: await labelHistory(db, isin), marks: await marksFor(db, isin) };
}

const history: Record<string, unknown> = {};
for (const isin of [SHELL, APPLE]) history[isin] = await loadHistoryFacts(db, isin);
await writeFile(out + 'research.json', JSON.stringify({
  catalogue: CATALOGUE, opened, summaries: await listReports(db), reports: reportData, news: newsData, notes, history, knownFigures: await knownFigures(db),
}));
// ── income and planning (§11.10): the app's own code over the invented history ──
const rates = await poundRates({ db, diagnostics: new MemoryDiagnostics(), now: () => new Date('2026-11-13T17:00:00Z'),
  transport: served(new Map([[makeBoeRates().request('').url, [fixture('boe-rates-2026-11-13.html'), 'text/html']]])) });
const purification = await loadPurification(db);
const planInput = (await portfolioInput(db)).input;
const companies: Record<string, unknown> = {};
for (const isin of [SHELL, APPLE]) companies[isin] = await planCompany(db, isin);
const holdingsForSale = await planHoldings(db);
const incomes: Record<string, unknown> = {};
for (const h of holdingsForSale) incomes[h.isin] = await planIncome(db, h.isin);
await writeFile(out + 'income.json', JSON.stringify({
  dividends: await loadDividends(db),
  purification: { ...purification, notYetCounted: [...purification.notYetCounted] },
  rates: rates.kind === 'ok' ? { ...rates, perPound: [...rates.perPound] } : rates,
  planning: {
    input: { positions: planInput.positions, contents: [...planInput.contents], classifications: [...planInput.classifications] },
    companies, holdings: holdingsForSale, incomes,
  },
}));
console.log(`demo data written to ${out}`);
