/**
 * Refresh end to end: invented Trading 212 holdings, real fund contents.
 * §11.4 — "a broken source shows an error and saves nothing".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refresh, loadPortfolio, type RefreshDeps } from './refresh.ts';
import { MemoryDiagnostics, StatusTransport } from '../fetch/fixture.ts';
import type { Transport, HttpRequest, HttpResponse, ParseTools } from '../fetch/types.ts';
import { NodeDb, migrationsFromDisk } from '../db/node.ts';
import { migrate } from '../db/migrate.ts';
import { FUNDS, SOURCES } from '../sources/funds.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fetch/fixtures/${name}`, import.meta.url));
const FILES: Record<string, [string, string]> = {
  ISDE: ['ishares-isde.json', 'application/json'], ISUS: ['ishares-isus.json', 'application/json'],
  ISWD: ['ishares-iswd.json', 'application/json'], IGDA: ['invesco-igda.json', 'application/json'],
  MWIM: ['invesco-mwim.json', 'application/json'], HIPS: ['hsbc-hips.xls', 'application/xls'],
  HIES: ['hsbc-hies.xls', 'application/xls'], HIJS: ['hsbc-hijs.xls', 'application/xls'],
  DJIW: ['waystone-djiw.csv', 'text/csv'],
};

/** Serves files by URL, and remembers what was asked for. */
class Served implements Transport {
  readonly asked: string[] = [];
  readonly #routes: Map<string, [string, string]>;
  constructor(routes: Map<string, [string, string]>) { this.#routes = routes; }
  async get(req: HttpRequest): Promise<HttpResponse> {
    this.asked.push(req.url);
    const route = this.#routes.get(req.url);
    if (!route) throw new Error(`nothing served at ${req.url}`);
    return { status: 200, body: new Uint8Array(await readFile(route[0])), contentType: route[1] };
  }
}

function web(overrides: Record<string, string> = {}): Served {
  return new Served(new Map(FUNDS.map((f) => {
    const [file, type] = FILES[f.ticker]!;
    return [SOURCES[f.issuer].request(f.key).url, [overrides[f.ticker] ?? fixture(file), type]];
  })));
}

function t212(positionsFile = fixture('t212-positions.synthetic.json')): Served {
  return new Served(new Map([
    ['/api/v0/equity/positions', [positionsFile, 'application/json']],
    ['/api/v0/equity/metadata/instruments', [fixture('t212-instruments.synthetic.json'), 'application/json']],
  ]));
}

const golden: ParseTools = {
  async xlsRows(bytes) {
    for (const t of ['hies', 'hips', 'hijs']) {
      if ((await readFile(fixture(`hsbc-${t}.xls`))).length === bytes.length) {
        return JSON.parse(await readFile(fixture(`hsbc-${t}.rows.json`), 'utf8'));
      }
    }
    throw new Error('unknown .xls');
  },
};

async function setup(parts: Partial<RefreshDeps> = {}) {
  const db = new NodeDb();
  await migrate(db, await migrationsFromDisk());
  let day = 0;
  const deps: RefreshDeps = {
    db, diagnostics: new MemoryDiagnostics(), web: web(), t212: t212(), tools: golden,
    now: () => new Date(Date.UTC(2026, 8, 23, 12, 0, day)), pause: async () => {}, ...parts,
  };
  return { db, deps, tick: () => { day++; } };
}

const SYNTHETIC_TOTAL = 7586.21 + 2685.84 + 3348.66 + 1185.6 + 1146.37;

test('11.4 — refresh, then see totals, true exposure and breakdowns', async () => {
  const { db, deps } = await setup();
  const reports = await refresh(deps);

  assert.deepEqual(reports.filter((r) => r.kind !== 'ok'), [], JSON.stringify(reports));
  assert.deepEqual(reports.map((r) => r.label).slice(0, 2), ['Trading 212 holdings', 'Trading 212 instrument list']);
  // Held funds, plus the three iShares reference funds; never MWIM or DJIW, which are not held.
  assert.deepEqual(reports.slice(2).map((r) => r.label).sort(), [
    'HIES contents', 'HIJS contents', 'HIPS contents', 'IGDA contents',
    'ISDE contents (reference)', 'ISUS contents (reference)', 'ISWD contents (reference)',
  ]);

  const p = await loadPortfolio(db);
  assert.ok(Math.abs(p.result.total.amount - SYNTHETIC_TOTAL) < 1e-6);
  assert.ok(Math.abs(p.result.direct.amount - 1146.37) < 1e-6);
  assert.equal(p.result.breakdowns.kind, 'ok');
  if (p.result.breakdowns.kind !== 'ok') return;
  const nvda = p.result.breakdowns.companies.find((c) => c.isins.includes('US67066G1040'))!;
  assert.deepEqual(nvda.viaFunds.map((v) => v.fund), ['IGDA']);
  assert.ok(nvda.direct.amount > 0);
  assert.equal(nvda.name, 'NVIDIA', "the broker's name, not 'NVIDIA CORP USD0.001'");

  // Both dates the screen needs (§6A.1): holdings, and each fund's contents.
  assert.ok(p.holdingsAsOf?.startsWith('2026-09-23'));
  assert.deepEqual(p.funds.find((f) => f.ticker === 'HIES'), { ticker: 'HIES', asOf: '2026-09-18', held: true });
  assert.deepEqual(p.funds.find((f) => f.ticker === 'ISDE'), { ticker: 'ISDE', asOf: '2026-09-22', held: false });
});

test('a second refresh the same day does not re-fetch fund contents', async () => {
  const { deps } = await setup();
  await refresh(deps);
  const again = web();
  const reports = await refresh({ ...deps, web: again });
  assert.equal(again.asked.length, 0);
  assert.ok(reports.filter((r) => r.label.includes('contents')).every((r) => r.kind === 'fresh'));
});

test('the instrument list is asked for only when a holding is new', async () => {
  const { deps } = await setup();
  await refresh(deps);
  const second = t212();
  await refresh({ ...deps, t212: second });
  assert.deepEqual(second.asked, ['/api/v0/equity/positions']);
});

test('11.4 — a broken fund source shows an error and saves nothing; last good data stays', async () => {
  const { db, deps, tick } = await setup();
  await refresh(deps);
  const before = await loadPortfolio(db);

  // Next day, IGDA's file comes back cut short.
  tick();
  const dir = await mkdtemp(join(tmpdir(), 'rf-'));
  const igda = JSON.parse(await readFile(fixture('invesco-igda.json'), 'utf8'));
  igda.holdings = igda.holdings.slice(0, 200);
  await writeFile(join(dir, 'igda.json'), JSON.stringify(igda));
  const reports = await refresh({ ...deps, now: () => new Date('2026-09-24T12:00:00Z'), web: web({ IGDA: join(dir, 'igda.json') }) });

  const bad = reports.find((r) => r.label === 'IGDA contents')!;
  assert.equal(bad.kind, 'suspect');
  assert.match(bad.detail!, /summed to .* nothing saved/);
  const after = await loadPortfolio(db);
  assert.deepEqual(after.funds.find((f) => f.ticker === 'IGDA'), before.funds.find((f) => f.ticker === 'IGDA'),
    'IGDA still shows its last good contents, with their date');
  assert.equal(after.result.breakdowns.kind, 'ok');
});

test('🔴 a broken fund with no earlier contents refuses the breakdowns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rf-'));
  await writeFile(join(dir, 'igda.json'), '<html>maintenance</html>');
  const { db, deps } = await setup({ web: web({ IGDA: join(dir, 'igda.json') }) });
  await refresh(deps);
  const p = await loadPortfolio(db);
  assert.equal(p.result.breakdowns.kind, 'refused');
  assert.ok(p.result.total.amount > 0, 'the total is still known');
});

test('T212 refusing the key is reported with the reason; earlier holdings stay', async () => {
  const { db, deps } = await setup();
  await refresh(deps);
  const reports = await refresh({ ...deps, t212: new StatusTransport(403) });
  assert.equal(reports[0]?.kind, 'unavailable');
  assert.match(reports[0]!.detail!, /IP restriction/);
  const p = await loadPortfolio(db);
  assert.ok(Math.abs(p.result.total.amount - SYNTHETIC_TOTAL) < 1e-6);
});

test('a held fund the app cannot open refuses the breakdowns, naming it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rf-'));
  const ps = JSON.parse(await readFile(fixture('t212-positions.synthetic.json'), 'utf8'));
  ps.push({ ...ps[0], instrument: { ticker: 'VWRPl_EQ', name: 'Some World ETF', isin: 'IE00BK5BQT80', currency: 'GBP' } });
  await writeFile(join(dir, 'p.json'), JSON.stringify(ps));
  const instruments = JSON.parse(await readFile(fixture('t212-instruments.synthetic.json'), 'utf8'));
  instruments.push({ ...instruments[0], isin: 'IE00BK5BQT80', type: 'ETF', name: 'Some World ETF' });
  await writeFile(join(dir, 'i.json'), JSON.stringify(instruments));

  const { db, deps } = await setup({
    t212: new Served(new Map([
      ['/api/v0/equity/positions', [join(dir, 'p.json'), 'application/json']],
      ['/api/v0/equity/metadata/instruments', [join(dir, 'i.json'), 'application/json']],
    ])),
  });
  await refresh(deps);
  const p = await loadPortfolio(db);
  assert.equal(p.result.breakdowns.kind, 'refused');
  if (p.result.breakdowns.kind === 'refused') assert.match(p.result.breakdowns.reasons.join(), /Some World ETF/);
});

test('an unknown holding with no instrument list is not guessed to be a share', async () => {
  const { db, deps } = await setup({
    t212: new Served(new Map([['/api/v0/equity/positions', [fixture('t212-positions.synthetic.json'), 'application/json']]])),
  });
  const reports = await refresh(deps);
  assert.equal(reports.find((r) => r.label === 'Trading 212 instrument list')?.kind, 'unavailable');
  const p = await loadPortfolio(db);
  assert.equal(p.result.breakdowns.kind, 'refused');
  if (p.result.breakdowns.kind === 'refused') assert.match(p.result.breakdowns.reasons.join(), /NVIDIA.*fund or a share/);
});
