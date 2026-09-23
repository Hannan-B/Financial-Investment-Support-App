/**
 * Label mapping, level 1.  §11.6 step 1.3
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSource } from '../fetch/run.ts';
import { FixtureTransport } from '../fetch/fixture.ts';
import { waystone } from '../sources/waystone.ts';
import type { FundHoldings } from '../sources/holdings.ts';
import { mapSector, SECTORS, SECTOR_MAPPING } from './sectors.ts';
import { mapCountry, COUNTRY_NAMES } from './countries.ts';

const DJIW = fileURLToPath(new URL('../fetch/fixtures/waystone-djiw.csv', import.meta.url));
const URL_KEY = waystone.request('djiw').url;

async function readDjiw(path = DJIW) {
  return runSource(waystone, 'djiw', new FixtureTransport({ [URL_KEY]: path }));
}

test('1.3 ACCEPTANCE — DJIW reports Health Care 14.99%, not 1%', async () => {
  const out = await readDjiw();
  assert.equal(out.kind, 'ok');
  const { rows } = (out as { value: FundHoldings }).value;

  const verbatim = rows.filter((r) => r.sector === 'Health Care').reduce((n, r) => n + r.weightPct, 0);
  const mapped = rows
    .filter((r) => r.sector && mapSector('waystone', r.sector) === 'Health Care')
    .reduce((n, r) => n + r.weightPct, 0);

  assert.equal(verbatim.toFixed(2), '1.01', 'what the label alone says');
  assert.equal(mapped.toFixed(2), '14.99', 'what the fund actually holds');
});

test('a new industry-level label stops the fund, naming the label', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cat-'));
  const csv = (await readFile(DJIW, 'utf8')).replace('"Information Technology",8.60%', 'Semiconductors,8.60%');
  await writeFile(join(dir, 'd.csv'), csv);

  const out = await readDjiw(join(dir, 'd.csv'));
  assert.equal(out.kind, 'suspect');
  if (out.kind !== 'suspect') return;
  assert.equal(out.failure.check, 'sector-labels-mapped');
  assert.match(out.failure.observed, /Semiconductors/);
});

test('an unrecognised country stops the fund too', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cat-'));
  const csv = (await readFile(DJIW, 'utf8')).replace('JAPAN,', 'NIPPON,');
  await writeFile(join(dir, 'd.csv'), csv);
  const out = await readDjiw(join(dir, 'd.csv'));
  assert.equal(out.kind, 'suspect');
  if (out.kind === 'suspect') assert.equal(out.failure.check, 'country-labels-mapped');
});

test('every mapping lands on one of the twelve', () => {
  for (const [source, table] of Object.entries(SECTOR_MAPPING)) {
    for (const [label, sector] of Object.entries(table)) {
      assert.ok(SECTORS.includes(sector), `${source}: ${label} → ${sector}`);
    }
  }
});

test('the same country, however it is spelled', () => {
  for (const label of ['Korea (South)', 'South Korea', 'KOREA, REPUBLIC OF']) assert.equal(mapCountry(label), 'KR');
  assert.equal(mapCountry('UNITED KINGDOM'), 'GB');
  assert.equal(mapCountry('Russian Federation'), 'RU');
  assert.equal(mapCountry('Narnia'), undefined);
  assert.equal(Object.keys(COUNTRY_NAMES).every((c) => /^[A-Z]{2}$/.test(c)), true);
});
