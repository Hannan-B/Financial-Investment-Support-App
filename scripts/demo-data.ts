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
import { MemoryDiagnostics } from '../src/fetch/fixture.ts';
import { FUNDS, SOURCES } from '../src/sources/funds.ts';
import type { Transport, HttpRequest, HttpResponse, ParseTools } from '../src/fetch/types.ts';

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
console.log(`demo data written to ${out}`);
