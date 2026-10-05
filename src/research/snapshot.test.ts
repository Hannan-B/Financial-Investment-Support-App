/**
 * Snapshot capture.  §11.7 step 2.4: repeated refreshes with unchanged data
 * add no new payload blobs.  And §10.1: a core source that is down still
 * leaves a snapshot, marked incomplete; one that is wrong leaves none.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Transport, HttpRequest, HttpResponse } from '../fetch/types.ts';
import { MemoryDiagnostics } from '../fetch/fixture.ts';
import { NodeDb, migrationsFromDisk } from '../db/node.ts';
import { migrate } from '../db/migrate.ts';
import { securityStatement, ensureListing } from '../portfolio/master.ts';
import { yahooPrices } from '../sources/yahoo.ts';
import { edgarSearch, edgarSubmissions, edgarConcept } from '../sources/edgar.ts';
import { statement, overview } from '../sources/stockanalysis.ts';
import { finviz } from '../sources/finviz.ts';
import { TAGS, DEPRECIATION_TAGS } from './edgar.ts';
import { refreshCompany } from './company.ts';
import { loadPayload } from './snapshot.ts';
import { sha256 } from '../lib/sha256.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fetch/fixtures/${name}`, import.meta.url));
const APPLE_CIK = '0000320193';

class Web implements Transport {
  readonly asked: string[] = [];
  readonly #routes = new Map<string, string | number>();
  route(url: string, fileOrStatus: string | number): this { this.#routes.set(url, fileOrStatus); return this; }
  async get(req: HttpRequest): Promise<HttpResponse> {
    this.asked.push(req.url);
    const route = this.#routes.get(req.url) ?? (req.url.includes('/companyconcept/') ? 404 : undefined);
    if (route === undefined) throw new Error(`nothing served at ${req.url}`);
    if (typeof route === 'number') return { status: route, body: new Uint8Array(), contentType: 'text/plain' };
    return { status: 200, body: new Uint8Array(await readFile(route)), contentType: 'application/json' };
  }
}

async function appleWeb(): Promise<Web> {
  const web = new Web()
    .route(yahooPrices.request('AAPL').url, fixture('yahoo-aapl.json'))
    .route(edgarSearch.request('AAPL').url, fixture('edgar-search-aapl.json'))
    .route(edgarSubmissions.request(APPLE_CIK).url, fixture('edgar-submissions-aapl.json'))
    .route(finviz.request('AAPL').url, fixture('finviz-aapl.html'));
  for (const tag of [...Object.values(TAGS).flat(), ...DEPRECIATION_TAGS]) {
    const file = fixture(`edgar-concept-aapl-${tag}.json`);
    try { await readFile(file); web.route(edgarConcept.request(`${APPLE_CIK}:${tag}`).url, file); } catch { /* 404 */ }
  }
  return web;
}

function shellWeb(): Web {
  const web = new Web().route(yahooPrices.request('SHEL.L').url, fixture('yahoo-shel-l.json'))
    .route(overview.request('lon/SHEL').url, fixture('sa-shel-overview.html'));
  for (const which of ['income-statement', 'balance-sheet', 'cash-flow-statement']) {
    web.route(statement.request(`lon/SHEL|${which}`).url, fixture(`sa-shel-${which}.html`));
  }
  return web;
}

async function setup(transport: Transport) {
  const db = new NodeDb();
  await migrate(db, await migrationsFromDisk());
  await db.batch([
    securityStatement('US0378331005', 'Apple Inc.', 'equity', '2026-10-05'),
    securityStatement('GB00BP6MXD84', 'Shell plc', 'equity', '2026-10-05'),
  ]);
  const apple = await ensureListing(db, { isin: 'US0378331005', ticker: 'AAPL', exchange: 'NMS', currency: 'USD', sourceKeys: { yahoo: 'AAPL' } });
  const shell = await ensureListing(db, {
    isin: 'GB00BP6MXD84', ticker: 'SHEL', exchange: 'LSE', currency: 'GBp', sourceKeys: { yahoo: 'SHEL.L', stockanalysis: 'lon/SHEL' },
  });
  let tick = 0;
  const deps = {
    db, diagnostics: new MemoryDiagnostics(), transport, pause: async () => {},
    now: () => new Date(Date.UTC(2026, 9, 5, 18, 0, tick++)),
  };
  return { db, deps, apple, shell };
}

const count = async (db: NodeDb, table: string) => Number((await db.query(`SELECT count(*) AS n FROM ${table}`))[0]!['n']);

test('2.4 ACCEPTANCE — refreshing again with unchanged data adds no new payload blobs', async () => {
  const { db, deps, apple } = await setup(await appleWeb());
  const first = await refreshCompany(apple, deps);
  assert.equal(first.kind, 'saved');
  assert.ok(first.kind === 'saved' && first.newPayloads > 0);
  const blobs = await count(db, 'payload');

  const second = await refreshCompany(apple, deps);
  assert.equal(second.kind, 'saved');
  if (second.kind === 'saved') assert.equal(second.newPayloads, 0);
  assert.equal(await count(db, 'payload'), blobs, 'not one new blob');
  assert.equal(await count(db, 'snapshot'), 2, 'but every refresh is a snapshot');
  const perSnapshot = await db.query('SELECT snapshot_id, count(*) AS n FROM fact GROUP BY snapshot_id');
  assert.equal(perSnapshot.length, 2);
  assert.equal(perSnapshot[0]!['n'], perSnapshot[1]!['n'], 'and each has the full set of facts');
});

test('raw responses are kept compressed, and come back exactly as they arrived', async () => {
  const { db, deps, apple } = await setup(await appleWeb());
  await refreshCompany(apple, deps);
  const original = new Uint8Array(await readFile(fixture('finviz-aapl.html')));
  const kept = await loadPayload(db, sha256(original));
  assert.ok(kept, 'the Finviz page is kept');
  assert.deepEqual(kept.body, original);
  const [row] = await db.query('SELECT length(bytes) AS stored FROM payload WHERE hash = ?', [sha256(original)]);
  assert.ok(Number(row!['stored']) < original.length / 3, `stored compressed: ${row!['stored']} of ${original.length} bytes`);
});

test('what is kept raw: every response used, except Yahoo’s — prices are kept as rows', async () => {
  const { db, deps, apple } = await setup(await appleWeb());
  await refreshCompany(apple, deps);
  const urls = (await db.query('SELECT url FROM snapshot_payload')).map((r) => String(r['url']));
  assert.ok(!urls.some((u) => u.includes('finance.yahoo.com')));
  assert.ok(urls.some((u) => u.includes('/companyconcept/') && u.endsWith('/Revenues.json')));
  assert.ok(urls.some((u) => u.includes('finviz.com')));
  assert.ok(urls.some((u) => u.includes('efts.sec.gov')), 'the lookup too, the first time');
});

test('the SEC number is looked up once, then remembered', async () => {
  const web = await appleWeb();
  const { db, deps, apple } = await setup(web);
  await refreshCompany(apple, deps);
  const [key] = await db.query("SELECT source_key FROM listing_source_key WHERE listing_id = ? AND source = 'edgar'", [apple]);
  assert.equal(key?.['source_key'], APPLE_CIK);
  const [sec] = await db.query("SELECT cik FROM security WHERE isin = 'US0378331005'");
  assert.equal(sec?.['cik'], APPLE_CIK);

  web.asked.length = 0;
  await refreshCompany(apple, deps);
  assert.ok(!web.asked.some((u) => u.includes('efts.sec.gov')), 'no second lookup');
  // The company's details are still read — for its filings, the official news (§6.6).
});

test('a London snapshot: prices in pence, figures in dollars, indicators and dates, all with provenance', async () => {
  const { db, deps, shell } = await setup(shellWeb());
  const out = await refreshCompany(shell, deps);
  assert.equal(out.kind, 'saved');
  if (out.kind !== 'saved') return;
  assert.equal(out.complete, true);
  assert.deepEqual(out.sources.slice(0, 3).map((s) => [s.source, s.outcome]), [['yahoo-prices', 'ok'], ['stockanalysis', 'ok'], ['finviz', 'not-covered']]);
  assert.deepEqual(out.sources.slice(3).map((s) => s.source), ['investegate', 'google-news'], 'news follows, optional');

  const fact = async (path: string, period: string | null = null) => (await db.query(
    'SELECT * FROM fact WHERE snapshot_id = ? AND field_path = ? AND period IS ?', [out.snapshotId, path, period],
  ))[0]!;
  const close = await fact('price.close');
  assert.deepEqual([close['value_num'], close['currency'], close['as_of']], [3631.5, 'GBp', '2026-10-05']);
  const revenue = await fact('income.revenue', 'FY2025');
  assert.deepEqual([revenue['value_num'], revenue['currency'], revenue['source'], revenue['tier']], [266_886_000_000, 'USD', 'stockanalysis', 2]);
  const rsi = await fact('technical.rsi_14');
  assert.ok(Math.abs(Number(rsi['value_num']) - 60.865) < 1e-3);
  assert.deepEqual([rsi['unit'], rsi['currency']], ['index', null]);
  const upper = await fact('technical.bollinger_20_2.upper');
  assert.equal(upper['currency'], 'GBp');
  const earnings = await fact('calendar.next_earnings');
  assert.deepEqual([earnings['value_text'], earnings['kind']], ['2026-10-29', 'estimate']);
});

test('a core source that is down still leaves a snapshot — marked incomplete, the outage recorded', async () => {
  const web = shellWeb().route(statement.request('lon/SHEL|income-statement').url, 503);
  const { db, deps, shell } = await setup(web);
  const out = await refreshCompany(shell, deps);
  assert.equal(out.kind, 'saved');
  if (out.kind !== 'saved') return;
  assert.equal(out.complete, false);
  const [src] = await db.query("SELECT outcome, detail FROM snapshot_source WHERE snapshot_id = ? AND source = 'stockanalysis'", [out.snapshotId]);
  assert.equal(src?.['outcome'], 'unavailable');
  assert.match(String(src?.['detail']), /503/);
  assert.equal(await count(db, 'fact') > 0, true, 'prices and indicators are still captured');
});

test('a core source that answers wrongly leaves no snapshot at all', async () => {
  // Asked for BP's income statement, the site serves Shell's.
  const web = new Web()
    .route(yahooPrices.request('BP.L').url, 503)
    .route(statement.request('lon/BP|income-statement').url, fixture('sa-shel-income-statement.html'));
  const { db, deps } = await setup(web);
  await db.batch([securityStatement('GB0007980591', 'BP p.l.c.', 'equity', '2026-10-05')]);
  const bp = await ensureListing(db, { isin: 'GB0007980591', ticker: 'BP', exchange: 'LSE', currency: 'GBp', sourceKeys: { yahoo: 'BP.L', stockanalysis: 'lon/BP' } });
  const out = await refreshCompany(bp, deps);
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') assert.match(out.reason, /asked stockanalysis for LON-BP, got LON-SHEL/);
  assert.equal(await count(db, 'snapshot'), 0);
});

test('prices answered for a different listing refuse the snapshot', async () => {
  const web = new Web().route(yahooPrices.request('AAPL').url, fixture('yahoo-shel-l.json'));
  const { db, deps, apple } = await setup(web);
  const out = await refreshCompany(apple, deps);
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') assert.match(out.reason, /asked Yahoo for AAPL but the answer was for SHEL\.L/);
  assert.equal(await count(db, 'snapshot'), 0);
});

test('an optional source failing changes nothing but its own line', async () => {
  const web = (await appleWeb()).route(finviz.request('AAPL').url, 429);
  const { db, deps, apple } = await setup(web);
  const out = await refreshCompany(apple, deps);
  assert.equal(out.kind, 'saved');
  if (out.kind !== 'saved') return;
  assert.equal(out.complete, true);
  assert.deepEqual(out.sources.find((s) => s.source === 'finviz'), { source: 'finviz', outcome: 'unavailable', detail: 'Finviz: rate limited' });
  assert.equal((await db.query("SELECT count(*) AS n FROM fact WHERE field_path LIKE 'analyst.%'"))[0]!['n'], 0);
});

test('figures that do not exist are kept as gaps with their reasons', async () => {
  // Walmart, on a day Yahoo is down and nothing is stored yet: no price, and no gross profit ever filed.
  const WALMART = '0000104169';
  const web = new Web()
    .route(yahooPrices.request('WMT').url, 503)
    .route(edgarSearch.request('WMT').url, fixture('edgar-search-wmt.json'))
    .route(edgarSubmissions.request(WALMART).url, fixture('edgar-submissions-wmt.json'))
    .route(finviz.request('WMT').url, 429);
  for (const tag of [...Object.values(TAGS).flat(), ...DEPRECIATION_TAGS]) {
    const file = fixture(`edgar-concept-wmt-${tag}.json`);
    try { await readFile(file); web.route(edgarConcept.request(`${WALMART}:${tag}`).url, file); } catch { /* 404 */ }
  }
  const { db, deps } = await setup(web);
  await db.batch([securityStatement('US9311421039', 'Walmart Inc.', 'equity', '2026-10-05')]);
  const walmart = await ensureListing(db, { isin: 'US9311421039', ticker: 'WMT', exchange: 'NMS', currency: 'USD', sourceKeys: { yahoo: 'WMT' } });

  const out = await refreshCompany(walmart, deps);
  assert.equal(out.kind, 'saved');
  if (out.kind !== 'saved') return;
  assert.equal(out.complete, false, 'prices, a core source, were down');
  const gaps = new Map((await db.query('SELECT field_path, reason FROM snapshot_gap WHERE snapshot_id = ?', [out.snapshotId]))
    .map((r) => [String(r['field_path']), String(r['reason'])]));
  assert.match(gaps.get('income.gross_profit')!, /Walmart Inc\. files no annual gross profit/);
  assert.match(gaps.get('price.close')!, /no prices stored/);
  assert.equal((await db.query("SELECT count(*) AS n FROM fact WHERE field_path = 'income.revenue'"))[0]!['n'], 10);
});
