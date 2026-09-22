import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSource } from './run.ts';
import { FixtureTransport, OfflineTransport, StatusTransport } from './fixture.ts';
import { weightsSumTo100, rowCountBetween, labelsAllMapped } from './checks.ts';
import type { Source } from './types.ts';

interface Row { name: string; weightPct: number; sector: string; }

// fileURLToPath, not .pathname — this project's folder contains spaces, which
// .pathname percent-encodes into a path that does not exist.
const FIXTURE = fileURLToPath(new URL('./fixtures/waystone-djiw.csv', import.meta.url));
const URL_KEY = 'https://etfs.waystone.com/djiw';

/** Minimal Waystone CSV source — the real format, real data. */
const waystone: Source<readonly Row[]> = {
  id: 'waystone',
  core: true,
  request: () => ({ url: URL_KEY }),
  parse(res) {
    const text = new TextDecoder().decode(res.body).trim();
    const [header, ...lines] = text.split(/\r?\n/);
    if (!header?.includes('WEIGHT')) throw new Error('missing WEIGHT column');
    return lines.map((line) => {
      const cells = line.match(/("[^"]*"|[^,]+)/g)?.map((c) => c.replace(/^"|"$/g, '')) ?? [];
      return {
        name: cells[2] ?? '',
        sector: cells[4] ?? '',
        weightPct: parseFloat((cells[5] ?? '0').replace('%', '')),
      };
    });
  },
  checks: [weightsSumTo100(), rowCountBetween(50, 500)],
};

test('good fixture passes every check', async () => {
  const out = await runSource(waystone, 'djiw', new FixtureTransport({ [URL_KEY]: FIXTURE }));
  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') return;
  assert.equal(out.value.length, 92);
  assert.equal(out.value[0]?.name.startsWith('TAIWAN SEMICONDUCTOR'), true);
});

test('0.4 ACCEPTANCE — a truncated fixture is rejected and nothing is stored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fx-'));
  const { readFile } = await import('node:fs/promises');
  const full = await readFile(FIXTURE, 'utf8');
  const truncated = full.split('\n').slice(0, 40).join('\n');   // half the holdings
  const path = join(dir, 'truncated.csv');
  await writeFile(path, truncated);

  const out = await runSource(waystone, 'djiw', new FixtureTransport({ [URL_KEY]: path }));

  assert.equal(out.kind, 'suspect', 'truncated data must be suspect, not ok');
  if (out.kind !== 'suspect') return;
  assert.equal(out.failure.check, 'weights-sum');
  assert.match(out.failure.observed, /summed to/);
  assert.equal('value' in out, false, 'no parsed value may be returned for storage');
});

test('garbled response is suspect, not merely unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fx-'));
  const path = join(dir, 'garbage.csv');
  await writeFile(path, '<html>Service Unavailable</html>');
  const out = await runSource(waystone, 'djiw', new FixtureTransport({ [URL_KEY]: path }));
  assert.equal(out.kind, 'suspect');
  if (out.kind === 'suspect') assert.equal(out.failure.check, 'parse');
});

test('no internet is unavailable, NOT suspect', async () => {
  const out = await runSource(waystone, 'djiw', new OfflineTransport());
  assert.equal(out.kind, 'unavailable');
});

test('Invesco 406 is treated as unavailable, not as bad data', async () => {
  const out = await runSource(waystone, 'djiw', new StatusTransport(406));
  assert.equal(out.kind, 'unavailable');
  if (out.kind === 'unavailable') assert.match(out.reason, /406/);
});

test('401 and 403 give different, actionable reasons', async () => {
  const a = await runSource(waystone, 'x', new StatusTransport(401));
  const b = await runSource(waystone, 'x', new StatusTransport(403));
  assert.match(a.kind === 'unavailable' ? a.reason : '', /revoked/);
  assert.match(b.kind === 'unavailable' ? b.reason : '', /IP restriction/);
});

test('unmapped category labels are caught — the Wahed case', async () => {
  const known = new Set(['Information Technology', 'Industrials', 'Consumer Discretionary',
    'Materials', 'Consumer Staples', 'Energy', 'Health Care', 'Real Estate']);
  const withLabels: Source<readonly Row[]> = {
    ...waystone,
    checks: [labelsAllMapped<readonly Row[]>((rows) => rows.map((r) => r.sector), known)],
  };
  const out = await runSource(withLabels, 'djiw', new FixtureTransport({ [URL_KEY]: FIXTURE }));
  assert.equal(out.kind, 'suspect');
  if (out.kind !== 'suspect') return;
  // These are the four that would collapse Health Care from 15% to 1%.
  assert.match(out.failure.observed, /Pharmaceuticals/);
});
