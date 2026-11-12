/**
 * Look-through on real fund contents (2026-09-23), through the real database
 * path: reader → validation → store → latest → look-through.
 * §11.6 step 1.4. The portfolio values are invented; the fund contents are not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runSource } from '../fetch/run.ts';
import { FixtureTransport } from '../fetch/fixture.ts';
import type { ParseTools, Source } from '../fetch/types.ts';
import { NodeDb, migrationsFromDisk } from '../db/node.ts';
import { migrate } from '../db/migrate.ts';
import { FUNDS, type Fund } from '../sources/funds.ts';
import { makeIshares } from '../sources/ishares.ts';
import { makeInvesco } from '../sources/invesco.ts';
import { makeHsbc } from '../sources/hsbc.ts';
import { waystone } from '../sources/waystone.ts';
import type { FundHoldings } from '../sources/holdings.ts';
import { saveFundHoldings, latestHoldings } from './fund-store.ts';
import { classifications, fieldStatement, securityStatement } from './master.ts';
import { lookthrough, UNCLASSIFIED, type Position, type FundContents, type Lookthrough, type IndustryBucket } from './lookthrough.ts';
import { money } from '../lib/money.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fetch/fixtures/${name}`, import.meta.url));
const now = () => new Date('2026-09-23T12:00:00Z');
const SOURCES: Record<Fund['issuer'], Source<FundHoldings>> = {
  ishares: makeIshares(now), invesco: makeInvesco(now), hsbc: makeHsbc(now), waystone,
};
const FILES: Record<string, string> = {
  ISDE: 'ishares-isde.json', ISUS: 'ishares-isus.json', ISWD: 'ishares-iswd.json',
  IGDA: 'invesco-igda.json', MWIM: 'invesco-mwim.json',
  HIPS: 'hsbc-hips.xls', HIES: 'hsbc-hies.xls', HIJS: 'hsbc-hijs.xls', DJIW: 'waystone-djiw.csv',
};
const golden: ParseTools = {
  async xlsRows(bytes) {
    for (const t of ['hies', 'hips', 'hijs']) {
      const xls = new Uint8Array(await readFile(fixture(`hsbc-${t}.xls`)));
      if (xls.length === bytes.length) return JSON.parse(await readFile(fixture(`hsbc-${t}.rows.json`), 'utf8'));
    }
    throw new Error('unknown .xls');
  },
};

async function loaded(tickers: readonly string[]) {
  const db = new NodeDb();
  await migrate(db, await migrationsFromDisk());
  for (const fund of FUNDS.filter((f) => tickers.includes(f.ticker))) {
    const source = SOURCES[fund.issuer];
    const out = await runSource(source, fund.key, new FixtureTransport({ [source.request(fund.key).url]: fixture(FILES[fund.ticker]!) }), golden);
    assert.equal(out.kind, 'ok', fund.ticker);
    await saveFundHoldings(db, fund, (out as { value: FundHoldings }).value, now().toISOString());
  }
  return db;
}

async function contentsOf(db: NodeDb): Promise<Map<string, FundContents>> {
  const stored = await latestHoldings(db);
  return new Map([...stored].map(([isin, h]) => [isin, { ...h, ticker: FUNDS.find((f) => f.isin === isin)!.ticker }]));
}

const fund = (ticker: string, value: number): Position => {
  const f = FUNDS.find((x) => x.ticker === ticker)!;
  return { isin: f.isin, name: f.name, kind: 'etf', value: money(value, 'GBP') };
};
const NVIDIA: Position = { isin: 'US67066G1040', name: 'NVIDIA', kind: 'equity', value: money(1200, 'GBP') };
const PORTFOLIO = [fund('IGDA', 10_000), fund('HIPS', 3_000), fund('HIES', 4_000), fund('HIJS', 2_000), NVIDIA];

// Reference funds are loaded but not held — they only classify.
const REFERENCE = ['ISDE', 'ISUS', 'ISWD'];
const HELD = ['IGDA', 'HIPS', 'HIES', 'HIJS'];

async function run(positions = PORTFOLIO, extra: (db: NodeDb) => Promise<void> = async () => {}): Promise<Lookthrough> {
  const db = await loaded([...REFERENCE, ...HELD]);
  await extra(db);
  return lookthrough({ positions, contents: await contentsOf(db), classifications: await classifications(db) });
}

const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} ${a} ≠ ${b}`);

test('1.4 ACCEPTANCE — company totals reconcile to portfolio value', async () => {
  const r = await run();
  assert.equal(r.breakdowns.kind, 'ok');
  if (r.breakdowns.kind !== 'ok') return;

  near(r.total.amount, 20_200);
  near(r.direct.amount, 1_200);
  near(r.viaFunds.amount, 19_000);
  const companies = r.breakdowns.companies.reduce((n, c) => n + c.total.amount, 0);
  near(companies + r.breakdowns.cash.amount, r.total.amount, 'companies + cash');
  near(r.breakdowns.sectors.reduce((n, s) => n + s.value.amount, 0), r.total.amount, 'sectors');
  near(r.breakdowns.countries.reduce((n, s) => n + s.value.amount, 0), r.total.amount, 'countries');
});

test('a company held directly and through a fund is one row, showing both', async () => {
  const r = await run();
  if (r.breakdowns.kind !== 'ok') return assert.fail();
  const nvda = r.breakdowns.companies.find((c) => c.isins.includes('US67066G1040'))!;
  near(nvda.direct.amount, 1_200);
  near(nvda.viaFunds.find((v) => v.fund === 'IGDA')!.value.amount, 845.93);
  near(nvda.total.amount, 2_045.93);
  assert.equal(r.breakdowns.companies[0], nvda, 'the largest exposure comes first');
});

test('share classes merge: Alphabet A and C are one company', async () => {
  const r = await run();
  if (r.breakdowns.kind !== 'ok') return assert.fail();
  const alphabet = r.breakdowns.companies.filter((c) => c.name === 'ALPHABET');
  assert.equal(alphabet.length, 1);
  assert.deepEqual([...alphabet[0]!.isins].sort(), ['US02079K1079', 'US02079K3059']);
});

test('one company across funds that name it differently is one row', async () => {
  // HSBC: 'Samsung Electronics Co Ltd' · Invesco: 'SAMSUNG ELECTRONICS CO KRW100'
  const r = await run();
  if (r.breakdowns.kind !== 'ok') return assert.fail();
  const samsung = r.breakdowns.companies.filter((c) => c.isins.includes('KR7005930003'));
  assert.equal(samsung.length, 1);
  assert.deepEqual(samsung[0]!.viaFunds.map((v) => v.fund).sort(), ['HIES', 'IGDA']);
});

test('HSBC funds are classified by iShares data; IGDA shows its gap honestly', async () => {
  const r = await run([fund('HIPS', 1_000), fund('HIJS', 1_000)]);
  if (r.breakdowns.kind !== 'ok') return assert.fail();
  const unclassified = r.breakdowns.sectors.find((s) => s.key === UNCLASSIFIED)?.value.amount ?? 0;
  assert.ok(unclassified < 5, `HIPS + HIJS unclassified: £${unclassified.toFixed(2)} of £2,000`);

  const igda = await run([fund('IGDA', 1_000)]);
  if (igda.breakdowns.kind !== 'ok') return assert.fail();
  const gap = igda.breakdowns.sectors.find((s) => s.key === UNCLASSIFIED)!;
  assert.ok(gap.share > 0.55 && gap.share < 0.62, `IGDA unclassified before lookups: ${(gap.share * 100).toFixed(1)}%`);
});

test('a company lookup moves weight out of "not yet classified" — and nothing else moves', async () => {
  const before = await run([fund('IGDA', 1_000)]);
  const after = await run([fund('IGDA', 1_000)], async (db) => {
    await db.batch([
      securityStatement('US67066G1040', 'NVIDIA', 'equity', 'x'),
      fieldStatement('US67066G1040', 'sector', 'Technology', 'stockanalysis', 2, '2026-09-23'),
    ]);
  });
  const get = (r: Lookthrough, k: string) => {
    if (r.breakdowns.kind !== 'ok') return assert.fail('breakdowns refused');
    return r.breakdowns.sectors.find((s) => s.key === k)?.value.amount ?? 0;
  };

  near(get(after, 'Technology') - get(before, 'Technology'), 84.593);
  near(get(before, UNCLASSIFIED) - get(after, UNCLASSIFIED), 84.593);
  for (const k of ['Health Care', 'Industrials', 'Energy', 'Cash / Other']) near(get(after, k), get(before, k), k);
});

test('🔴 a held fund with no contents refuses the breakdowns — never shows them partially', async () => {
  const unknown: Position = { isin: 'IE00BK5BQT80', name: 'Some Other ETF', kind: 'etf', value: money(5_000, 'GBP') };
  const r = await run([...PORTFOLIO, unknown]);
  assert.equal(r.breakdowns.kind, 'refused');
  if (r.breakdowns.kind === 'refused') assert.match(r.breakdowns.reasons[0]!, /Some Other ETF/);
  near(r.total.amount, 25_200, 'totals still shown — they come from the broker');
});

test('weight a fund does not itemise is shown as such, not scaled away', async () => {
  const r = await run([fund('HIPS', 1_000)]);   // HIPS weights sum to 99.70%
  if (r.breakdowns.kind !== 'ok') return assert.fail();
  const companies = r.breakdowns.companies.reduce((n, c) => n + c.total.amount, 0);
  assert.ok(r.breakdowns.cash.amount >= 2.9, `cash + unitemised ${r.breakdowns.cash.amount}`);
  near(companies + r.breakdowns.cash.amount, 1_000);
});

test('storing again the same day replaces; older months keep one list each', async () => {
  const db = await loaded(['HIPS']);
  const hips = FUNDS.find((f) => f.ticker === 'HIPS')!;
  const one = { asOf: '2026-08-14', rows: [{ name: 'X', weightPct: 100, isin: null, sedol: null, country: null, sector: null, currency: null, kind: 'cash' as const }] };
  await saveFundHoldings(db, hips, one, '2026-08-14T10:00:00Z');
  await saveFundHoldings(db, hips, { ...one, asOf: '2026-08-29' }, '2026-08-29T10:00:00Z');
  await saveFundHoldings(db, hips, { ...one, asOf: '2026-08-29' }, '2026-08-29T11:00:00Z');

  const dates = await db.query('SELECT DISTINCT as_of FROM etf_constituent ORDER BY as_of');
  assert.deepEqual(dates.map((d) => d['as_of']), ['2026-08-29', '2026-09-18']);
  const latest = await latestHoldings(db);
  assert.equal(latest.get(hips.isin)?.asOf, '2026-09-18');
});

// ── industries within sectors (§11.9 step 4.4) ──────────────────────────

const SAMSUNG = 'KR7005930003';    // in HIES and IGDA; its sector comes from iShares
const looked = (isin: string, sector: string, industry: string) => async (db: NodeDb) => {
  await db.batch([
    fieldStatement(isin, 'sector', sector, 'stockanalysis', 2, '2026-11-12'),
    fieldStatement(isin, 'industry', industry, 'stockanalysis', 2, '2026-11-12'),
  ]);
  await db.query("INSERT INTO lookup_attempt (isin, source, attempted_at, outcome, method_version) VALUES (?, 'stockanalysis', 'x', 'found', 2)", [isin]);
};

test('4.4 ACCEPTANCE — enriching a fund leaves its level-1 weights identical; each sector\'s industries add up to it', async () => {
  const before = await run();
  // Stockanalysis files Samsung under another sector than iShares does: the fund's word stands.
  const after = await run(PORTFOLIO, looked(SAMSUNG, 'Industrials', 'Consumer Electronics'));
  if (before.breakdowns.kind !== 'ok' || after.breakdowns.kind !== 'ok') return assert.fail('breakdowns refused');

  assert.equal(after.breakdowns.sectors.length, before.breakdowns.sectors.length);
  for (const s of before.breakdowns.sectors) {
    near(after.breakdowns.sectors.find((x) => x.key === s.key)!.value.amount, s.value.amount, s.key);
  }
  for (const s of after.breakdowns.sectors) {
    const inside: readonly IndustryBucket[] | undefined = after.breakdowns.industries[s.key];
    if (s.key === UNCLASSIFIED || s.key === 'Cash / Other') { assert.equal(inside, undefined, `${s.key} has no industries`); continue; }
    near(inside!.reduce((n, i) => n + i.value.amount, 0), s.value.amount, `${s.key}'s industries`);
  }

  const tech = after.breakdowns.industries['Technology']!;
  const samsung = tech.find((i) => i.key === 'Consumer Electronics')!;
  assert.ok(samsung, 'Samsung counted under Technology, its fund sector');
  assert.equal(samsung.companies, 1);
  assert.deepEqual(samsung.elsewhere.map((e) => e.sector), ['Industrials'], 'the disagreement is noted, not acted on');
});

test('a company not looked up yet and one stockanalysis has no page for are told apart', async () => {
  const r = await run(PORTFOLIO, async (db) => {
    await db.query("INSERT INTO lookup_attempt (isin, source, attempted_at, outcome, method_version) VALUES (?, 'stockanalysis', 'x', 'not-found', 2)", [SAMSUNG]);
  });
  if (r.breakdowns.kind !== 'ok') return assert.fail();
  const keys = r.breakdowns.industries['Technology']!.map((i) => i.key);
  assert.ok(keys.includes('Not found on stockanalysis'), keys.join(', '));
  assert.ok(keys.includes('Not looked up yet'), 'the rest are waiting, and say so');
});

test('two spellings of one industry are one line; the stored label stays as the site wrote it', async () => {
  const r = await run(PORTFOLIO, looked(SAMSUNG, 'Technology', 'Scientific & Technical Instrument'));
  if (r.breakdowns.kind !== 'ok') return assert.fail();
  assert.ok(r.breakdowns.industries['Technology']!.some((i) => i.key === 'Scientific & Technical Instruments'));
});
