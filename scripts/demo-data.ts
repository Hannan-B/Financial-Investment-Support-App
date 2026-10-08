/**
 * Builds the demo portfolio the screens show in a plain browser (`npm run demo`).
 *
 * Holdings are INVENTED (t212-*.synthetic.json). Fund contents are the real
 * public files in src/fetch/fixtures. The 25 company classifications are what
 * the live lookup returned on 2026-09-23 — the state after a first refresh's
 * first minute of lookups. Output goes to src/ui/demo/ (git-ignored).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { NodeDb, migrationsFromDisk } from '../src/db/node.ts';
import { migrate } from '../src/db/migrate.ts';
import { refresh, loadPortfolio } from '../src/portfolio/refresh.ts';
import { securityStatement, fieldStatement } from '../src/portfolio/master.ts';
import { MemoryDiagnostics, FakeGoogleNews } from '../src/fetch/fixture.ts';
import { investegate } from '../src/sources/investegate.ts';
import { loadNews } from '../src/research/news.ts';
import { FUNDS, SOURCES } from '../src/sources/funds.ts';
import type { Transport, HttpRequest, HttpResponse, ParseTools } from '../src/fetch/types.ts';
import { saveCatalogue } from '../src/research/catalogue.ts';
import { openCompany } from '../src/research/open.ts';
import { refreshCompany } from '../src/research/company.ts';
import { loadReport, listReports } from '../src/research/report.ts';
import { search, profile, statement, statistics } from '../src/sources/stockanalysis.ts';
import { yahooPrices } from '../src/sources/yahoo.ts';
import { edgarSearch, edgarSubmissions, edgarConcept } from '../src/sources/edgar.ts';
import { finviz } from '../src/sources/finviz.ts';
import { TAGS, DEPRECIATION_TAGS } from '../src/research/edgar.ts';
import type { Instrument } from '../src/sources/t212.ts';

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

const db = new NodeDb();
await migrate(db, await migrationsFromDisk());
const now = () => new Date('2026-09-23T12:00:00Z');

const reports = await refresh({
  db, diagnostics: new MemoryDiagnostics(), tools, now, pause: async () => {},
  web: served(new Map(FUNDS.map((f) => [SOURCES[f.issuer].request(f.key).url, [fixture(FILES[f.ticker]![0]), FILES[f.ticker]![1]]]))),
  t212: served(new Map([
    ['/api/v0/equity/positions', [fixture('t212-positions.synthetic.json'), 'application/json']],
    ['/api/v0/equity/metadata/instruments', [fixture('t212-instruments.synthetic.json'), 'application/json']],
  ])),
});

await db.batch(LOOKED_UP.flatMap(([isin, name, sector, country]) => [
  securityStatement(isin, name, 'equity', now().toISOString()),
  fieldStatement(isin, 'sector', sector, 'stockanalysis', 2, '2026-09-23'),
  fieldStatement(isin, 'country', country, 'stockanalysis', 2, '2026-09-23'),
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
const routes = new Map<string, [string, string]>([
  [search.request('APPLE').url, [fixture('sa-search-apple.json'), 'application/json']],
  [search.request('SHELL').url, [fixture('sa-search-shell.json'), 'application/json']],
  [profile.request('/stocks/aapl/company/').url, [fixture('sa-profile-aapl.html'), 'text/html']],
  [profile.request('/quote/lon/SHEL/company/').url, [fixture('sa-profile-lon-shel.html'), 'text/html']],
  [yahooPrices.request('AAPL').url, [fixture('yahoo-aapl.json'), 'application/json']],
  [yahooPrices.request('SHEL.L').url, [fixture('yahoo-shel-l.json'), 'application/json']],
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
for (const t of ['AAPL_US_EQ', 'SHELl_EQ']) {
  const o = await openCompany(t, research);
  if (o.kind !== 'opened') throw new Error(`demo: could not open ${t}: ${o.reason}`);
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
await writeFile(out + 'research.json', JSON.stringify({ catalogue: CATALOGUE, opened, summaries: await listReports(db), reports: reportData, news: newsData }));
console.log(`demo data written to ${out}`);
