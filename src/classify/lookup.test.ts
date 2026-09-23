/**
 * Company lookups against real stockanalysis pages captured 2026-09-23.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupCompany, classifyMissing, type LookupDeps } from './lookup.ts';
import { search, profile, searchQuery, rankHits } from '../sources/stockanalysis.ts';
import { FixtureTransport, MemoryDiagnostics, OfflineTransport } from '../fetch/fixture.ts';
import { NodeDb, migrationsFromDisk } from '../db/node.ts';
import { migrate } from '../db/migrate.ts';
import { classifications } from '../portfolio/master.ts';
import type { Transport } from '../fetch/types.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fetch/fixtures/${name}`, import.meta.url));
const s = (q: string) => search.request(q).url;
const p = (path: string) => profile.request(path).url;

/** Real pages, served by URL; the right content type for each. */
class Site implements Transport {
  readonly requested: string[] = [];
  readonly #json: FixtureTransport;
  readonly #html: FixtureTransport;
  constructor(json: Record<string, string>, html: Record<string, string>) {
    this.#json = new FixtureTransport(json, 'application/json');
    this.#html = new FixtureTransport(html, 'text/html');
  }
  get(req: { url: string }) {
    this.requested.push(req.url);
    return req.url.includes('/api/search') ? this.#json.get(req) : this.#html.get(req);
  }
}

const site = () => new Site(
  {
    [s('ELI LILLY')]: fixture('sa-search-eli-lilly.json'),
    [s('ALPHABET')]: fixture('sa-search-alphabet.json'),
    [s('MURATA MANUFACTURING')]: fixture('sa-search-murata.json'),
  },
  {
    [p('/stocks/lly/company/')]: fixture('sa-profile-lly.html'),
    [p('/stocks/googl/company/')]: fixture('sa-profile-googl.html'),
    [p('/stocks/goog/company/')]: fixture('sa-profile-goog.html'),
    [p('/quote/tyo/6981/company/')]: fixture('sa-profile-tyo-6981.html'),
  },
);

async function deps(transport: Transport): Promise<LookupDeps & { db: NodeDb }> {
  const db = new NodeDb();
  await migrate(db, await migrationsFromDisk());
  return { db, transport, diagnostics: new MemoryDiagnostics(), pause: async () => {} };
}

test('fund names become search queries', () => {
  assert.equal(searchQuery('ALPHABET INC-CL A USD0.001'), 'ALPHABET');
  assert.equal(searchQuery('ELI LILLY &amp; CO NPV'), 'ELI LILLY');
  assert.equal(searchQuery('ROCHE HOLDINGS AG CHF0.001 (BR)'), 'ROCHE');
  assert.equal(searchQuery('Murata Manufacturing Co Ltd'), 'MURATA MANUFACTURING');
  assert.equal(searchQuery('PROCTER & GAMBLE CO/THE NPV'), 'PROCTER & GAMBLE');
  assert.equal(searchQuery('TAIWAN SEMICONDUCTOR MANUFACTURING SPON ADS EACH R'), 'TAIWAN SEMICONDUCTOR MANUFACTURING');
  // Seen live: 'INTL' found nothing; the site's search only knows the full word.
  assert.equal(searchQuery('INTL BUSINESS MACHINES CORP USD0.2'), 'INTERNATIONAL BUSINESS MACHINES');
  assert.equal(searchQuery('TAKEUCHI MFG CO LTD NPV'), 'TAKEUCHI MANUFACTURING');
});

test('a US company: two requests, sector and industry found', async () => {
  const web = site();
  const r = await lookupCompany('US5324571083', 'ELI LILLY NPV', await deps(web));
  assert.equal(r.kind, 'found');
  if (r.kind !== 'found') return;
  assert.deepEqual(r.profile, {
    isin: 'US5324571083', sector: 'Healthcare', industry: 'Drug Manufacturers - General', country: 'United States',
  });
  assert.equal(web.requested.length, 2);
});

test('a Japanese company is found on its home exchange, not an ADR', async () => {
  const hits = rankHits('JP3914400001', [
    { symbol: 'otc/MRAAY', name: '', profile: '' },
    { symbol: 'tyo/6981', name: '', profile: '' },
  ]);
  assert.equal(hits[0]?.symbol, 'tyo/6981');

  const r = await lookupCompany('JP3914400001', 'Murata Manufacturing Co Ltd', await deps(site()));
  assert.equal(r.kind, 'found');
  if (r.kind === 'found') assert.equal(r.profile.country, 'Japan');
});

test('share classes are told apart by ISIN, never by name', async () => {
  const a = await lookupCompany('US02079K3059', 'ALPHABET INC-CL A USD0.001', await deps(site()));
  const c = await lookupCompany('US02079K1079', 'ALPHABET INC-CL C USD0.001', await deps(site()));
  assert.equal(a.kind === 'found' && a.page, '/stocks/googl/company/');
  assert.equal(c.kind === 'found' && c.page, '/stocks/goog/company/');
});

test('a similar name with a different ISIN is never accepted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sa-'));
  await writeFile(join(dir, 'only-lly.json'), JSON.stringify({ status: 200, data: [{ s: 'LLY', t: 's', n: 'Eli Lilly and Company' }] }));
  const web = new Site({ [s('ELI LILLY')]: join(dir, 'only-lly.json') }, { [p('/stocks/lly/company/')]: fixture('sa-profile-lly.html') });

  const r = await lookupCompany('US0378331005', 'ELI LILLY NPV', await deps(web));
  assert.equal(r.kind, 'not-found');
  if (r.kind === 'not-found') assert.match(r.detail, /LLY is US5324571083/);
});

test('classifying stores verbatim labels that map, largest first, and remembers', async () => {
  const web = site();
  const d = await deps(web);
  const companies = [
    { isin: 'JP3914400001', name: 'Murata Manufacturing Co Ltd', weight: 0.14 },
    { isin: 'US5324571083', name: 'ELI LILLY &amp; CO NPV', weight: 1.43 },
  ];
  const first = await classifyMissing(companies, d);
  assert.deepEqual(first, { found: 2, notFound: 0 });
  assert.equal(web.requested[0], s('ELI LILLY'), 'the heavier holding is looked up first');

  const cls = await classifications(d.db);
  assert.deepEqual(cls.get('US5324571083')?.sector, { label: 'Healthcare', source: 'stockanalysis' });
  assert.deepEqual(cls.get('JP3914400001')?.country, { label: 'Japan', source: 'stockanalysis' });

  const before = web.requested.length;
  const again = await classifyMissing(companies, d);
  assert.deepEqual(again, { found: 0, notFound: 0 });
  assert.equal(web.requested.length, before, 'nothing already classified is looked up again');
});

test('an issuer sector outranks a looked-up one', async () => {
  const d = await deps(new OfflineTransport());
  await d.db.query("INSERT INTO security (isin, name, kind, created_at) VALUES ('US5324571083', 'ELI LILLY', 'equity', 'x')");
  await d.db.query("INSERT INTO security_field VALUES ('US5324571083', 'sector', 'Healthcare', 'stockanalysis', 2, 'x')");
  await d.db.query("INSERT INTO security_field VALUES ('US5324571083', 'sector', 'Health Care', 'ishares', 1, 'x')");
  const cls = await classifications(d.db);
  assert.equal(cls.get('US5324571083')?.sector?.source, 'ishares');
});

test('a candidate whose page does not exist is skipped, not treated as the site failing', async () => {
  // Seen live: a search listed wse/INTL, whose page is a 404. Treating that as
  // an outage stopped every run at the same company, for good.
  const dir = await mkdtemp(join(tmpdir(), 'sa-'));
  // Both plain US tickers, so they are tried in the site's order: the missing page first.
  await writeFile(join(dir, 'hits.json'), JSON.stringify({ status: 200, data: [
    { s: 'LLYX', t: 's', n: 'Eli Lilly (old listing)' },
    { s: 'LLY', t: 's', n: 'Eli Lilly and Company' },
  ] }));
  const pages = new Site({ [s('ELI LILLY')]: join(dir, 'hits.json') }, { [p('/stocks/lly/company/')]: fixture('sa-profile-lly.html') });
  const missing = p('/stocks/llyx/company/');
  const asked: string[] = [];
  const web: Transport = {
    get: (req) => {
      asked.push(req.url);
      return req.url === missing
        ? Promise.resolve({ status: 404, body: new Uint8Array(), contentType: 'text/html' })
        : pages.get(req);
    },
  };

  const r = await lookupCompany('US5324571083', 'ELI LILLY', await deps(web));
  assert.ok(asked.includes(missing), 'the missing page was tried');
  assert.equal(r.kind, 'found', 'and the next candidate was still tried');

  const run = await classifyMissing([{ isin: 'US5324571083', name: 'ELI LILLY', weight: 1 }], await deps(web));
  assert.deepEqual(run, { found: 1, notFound: 0 }, 'the run carries on rather than stopping');
});

test('offline: the run stops at once and records nothing', async () => {
  const d = await deps(new OfflineTransport());
  const out = await classifyMissing([{ isin: 'US5324571083', name: 'ELI LILLY', weight: 1 }], d);
  assert.equal(out.stopped, 'no internet');
  assert.equal((await d.db.query('SELECT * FROM lookup_attempt')).length, 0);
});
