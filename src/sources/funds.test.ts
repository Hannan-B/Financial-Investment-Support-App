/**
 * The four fund readers against real data captured on 2026-09-23.
 * §11.6 step 1.2: all nine parse and validate; a truncated fixture is rejected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSource } from '../fetch/run.ts';
import { FixtureTransport } from '../fetch/fixture.ts';
import type { ParseTools, Source } from '../fetch/types.ts';
import { FUNDS, type Fund } from './funds.ts';
import { makeIshares } from './ishares.ts';
import { makeInvesco } from './invesco.ts';
import { makeHsbc } from './hsbc.ts';
import { waystone } from './waystone.ts';
import { isValidIsin, parseDayMonthYear, excelSerialDate, type FundHoldings } from './holdings.ts';
import { parseCsv } from '../lib/csv.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fetch/fixtures/${name}`, import.meta.url));

// The fixtures' own week, so the freshness check does not expire with time.
const now = () => new Date('2026-09-23T12:00:00Z');
const SOURCES: Record<Fund['issuer'], Source<FundHoldings>> = {
  ishares: makeIshares(now), invesco: makeInvesco(now), hsbc: makeHsbc(now), waystone,
};

const FILES: Record<string, { file: string; type: string }> = {
  ISDE: { file: 'ishares-isde.json', type: 'application/json' },
  ISUS: { file: 'ishares-isus.json', type: 'application/json' },
  ISWD: { file: 'ishares-iswd.json', type: 'application/json' },
  IGDA: { file: 'invesco-igda.json', type: 'application/json' },
  MWIM: { file: 'invesco-mwim.json', type: 'application/json' },
  HIPS: { file: 'hsbc-hips.xls', type: 'application/xls' },
  HIES: { file: 'hsbc-hies.xls', type: 'application/xls' },
  HIJS: { file: 'hsbc-hijs.xls', type: 'application/xls' },
  DJIW: { file: 'waystone-djiw.csv', type: 'text/csv' },
};

/** Stands in for Rust: the golden decoding the Rust tests check the .xls against. */
function goldenXls(fund: string, edit: (rows: string[][]) => string[][] = (r) => r): ParseTools {
  return {
    async xlsRows() {
      const rows = JSON.parse(await readFile(fixture(`hsbc-${fund.toLowerCase()}.rows.json`), 'utf8')) as string[][];
      return edit(rows);
    },
  };
}

async function read(fund: Fund, path = fixture(FILES[fund.ticker]!.file), tools?: ParseTools) {
  const source = SOURCES[fund.issuer];
  const url = source.request(fund.key).url;
  const transport = new FixtureTransport({ [url]: path }, FILES[fund.ticker]!.type);
  return runSource(source, fund.key, transport, tools ?? goldenXls(fund.ticker));
}

for (const fund of FUNDS) {
  test(`1.2 ACCEPTANCE — ${fund.ticker} parses and validates`, async () => {
    const out = await read(fund);
    assert.equal(out.kind, 'ok', out.kind === 'suspect' ? JSON.stringify(out.failure) : out.kind === 'unavailable' ? out.reason : '');
  });
}

test('1.2 ACCEPTANCE — a truncated fixture is rejected, for every format', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'funds-'));
  const byTicker = (t: string) => FUNDS.find((f) => f.ticker === t)!;

  // JSON (iShares): drop the second half of every column.
  const is = JSON.parse(await readFile(fixture('ishares-iswd.json'), 'utf8'));
  for (const col of Object.values<any>(is.componentsByNameMap.holdings.containersByNameMap.all.dataPointsByNameMap)) {
    if (Array.isArray(col.formattedValue) && col.formattedValue.length > 100) {
      col.formattedValue = col.formattedValue.slice(0, 100);
    }
  }
  await writeFile(join(dir, 'is.json'), JSON.stringify(is));

  // JSON (Invesco): the first 300 holdings.
  const inv = JSON.parse(await readFile(fixture('invesco-igda.json'), 'utf8'));
  inv.holdings = inv.holdings.slice(0, 300);
  await writeFile(join(dir, 'inv.json'), JSON.stringify(inv));

  // CSV (Waystone): the first 40 lines.
  const csv = (await readFile(fixture('waystone-djiw.csv'), 'utf8')).split('\n').slice(0, 40).join('\n');
  await writeFile(join(dir, 'w.csv'), csv);

  const cases = [
    await read(byTicker('ISWD'), join(dir, 'is.json')),
    await read(byTicker('IGDA'), join(dir, 'inv.json')),
    await read(byTicker('DJIW'), join(dir, 'w.csv')),
    // .xls (HSBC): the decoded sheet stops after 150 rows. (Its last rows are
    // cash and tax accruals worth ~0.01% — losing those is rightly accepted.)
    await read(byTicker('HIES'), undefined, goldenXls('HIES', (rows) => rows.slice(0, 150))),
  ];
  for (const out of cases) {
    assert.equal(out.kind, 'suspect');
    if (out.kind === 'suspect') assert.equal(out.failure.check, 'weights-sum');
  }
});

test('an error page where JSON was expected is suspect, not unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'funds-'));
  await writeFile(join(dir, 'e.html'), '<html>We are updating our site</html>');
  const out = await read(FUNDS.find((f) => f.ticker === 'IGDA')!, join(dir, 'e.html'));
  assert.equal(out.kind, 'suspect');
});

test('holdings older than ten days are rejected', async () => {
  const later = makeInvesco(() => new Date('2026-10-15T12:00:00Z'));
  const url = later.request('IE000UOXRAM8').url;
  const out = await runSource(later, 'IE000UOXRAM8', new FixtureTransport({ [url]: fixture('invesco-igda.json') }, 'application/json'));
  assert.equal(out.kind, 'suspect');
  if (out.kind === 'suspect') assert.equal(out.failure.check, 'as-of-freshness');
});

// ── what each reader extracts ────────────────────────────────────────────

async function holdings(ticker: string): Promise<FundHoldings> {
  const out = await read(FUNDS.find((f) => f.ticker === ticker)!);
  assert.equal(out.kind, 'ok');
  return (out as { value: FundHoldings }).value;
}

test('iShares: dates, sectors, countries and cash lines', async () => {
  const h = await holdings('ISDE');
  assert.equal(h.asOf, '2026-09-22');
  assert.deepEqual(h.rows[0], {
    name: 'SK HYNIX', weightPct: 15.66, isin: 'KR7000660001', sedol: null,
    country: 'Korea (South)', sector: 'Information Technology', currency: 'KRW', kind: 'equity',
  });
  const cash = h.rows.find((r) => r.name === 'USD CASH');
  assert.equal(cash?.kind, 'cash');
  assert.equal(cash?.isin, null);
});

test('Invesco: ISINs and weights only; entities decoded; cash has no ISIN', async () => {
  const h = await holdings('IGDA');
  assert.equal(h.asOf, '2026-09-22');
  assert.equal(h.rows.length, 1261);
  assert.equal(h.rows[0]?.isin, 'US67066G1040');
  assert.equal(h.rows[0]?.sector, null);
  assert.ok(h.rows.some((r) => r.name === 'ELI LILLY & CO NPV'));
  assert.deepEqual(h.rows.filter((r) => r.kind === 'cash').map((r) => r.name), ['Cash and/or Derivatives']);
});

test('HSBC: Excel date, country but no sector, negative cash lines kept', async () => {
  const h = await holdings('HIES');
  assert.equal(h.asOf, '2026-09-18');
  assert.ok(h.rows.every((r) => r.sector === null));
  assert.ok(h.rows.some((r) => r.kind === 'equity' && r.country));
  assert.ok(h.rows.some((r) => r.kind === 'cash' && r.weightPct < 0), 'accrual lines can be negative');
});

test('Waystone: SEDOLs, not the fund ISIN; no date; mixed-level sectors kept verbatim', async () => {
  const h = await holdings('DJIW');
  assert.equal(h.asOf, null);
  assert.equal(h.rows.length, 92);
  assert.ok(h.rows.every((r) => r.isin === null));
  assert.equal(h.rows[0]?.sedol, '2113382');
  assert.equal(h.rows[1]?.country, 'KOREA, REPUBLIC OF');
  assert.ok(h.rows.some((r) => r.sector === 'Pharmaceuticals'));
  assert.ok(h.rows.some((r) => r.sedol === '0989529'), 'leading zeros restored (AstraZeneca)');
});

// ── helpers ──────────────────────────────────────────────────────────────

test('ISIN check digits', () => {
  for (const good of ['US0378331005', 'US67066G1040', 'KR7005930003', 'IE00B27YCN58', 'GB0009895292']) {
    assert.equal(isValidIsin(good), true, good);
  }
  for (const bad of ['US0378331006', 'NVIDIA CORP', 'us0378331005', '037833100', '']) {
    assert.equal(isValidIsin(bad), false, bad);
  }
});

test('dates as the issuers write them', () => {
  assert.equal(parseDayMonthYear('22/Sept/2026'), '2026-09-22');
  assert.equal(parseDayMonthYear('31/Aug/2026'), '2026-08-31');
  assert.equal(excelSerialDate('46283'), '2026-09-18');
  assert.throws(() => parseDayMonthYear('2026-09-22'));
  assert.throws(() => excelSerialDate('6.31217'));
});

test('CSV: quoted commas, doubled quotes, CRLF, blank lines', () => {
  assert.deepEqual(
    parseCsv('a,"KOREA, REPUBLIC OF","say ""hi"""\r\n\r\nb,,c\n'),
    [['a', 'KOREA, REPUBLIC OF', 'say "hi"'], ['b', '', 'c']],
  );
  assert.throws(() => parseCsv('a,"open'));
});
