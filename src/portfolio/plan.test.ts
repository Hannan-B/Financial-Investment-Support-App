/**
 * The planning area.  §11.10 step 5.5, as gone through on 2026-11-13.
 *
 * Invented Trading 212 holdings, dividends and sales (t212-*.synthetic.json),
 * real fund contents, the Bank of England's rates of 12 Nov 2026. Apple is
 * "opened" by writing what opening stores: its listing, sector, country and a
 * price.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { refresh, type RefreshDeps } from './refresh.ts';
import { MemoryDiagnostics } from '../fetch/fixture.ts';
import type { Transport, HttpRequest, HttpResponse, ParseTools } from '../fetch/types.ts';
import type { Db, Statement, SqlValue, Row } from '../db/types.ts';
import { NodeDb, migrationsFromDisk } from '../db/node.ts';
import { migrate } from '../db/migrate.ts';
import { FUNDS, SOURCES } from '../sources/funds.ts';
import { ensureListing, securityStatement, fieldStatement } from './master.ts';
import { savePrices } from '../research/prices.ts';
import { setUsualRate } from './income.ts';
import { planBuy, planSell, savePlan, listPlans, unitsFor } from './plan.ts';
import { T212_FX_FEE, type RatesOutcome } from './fx.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fetch/fixtures/${name}`, import.meta.url));
const FILES: Record<string, [string, string]> = {
  ISDE: ['ishares-isde.json', 'application/json'], ISUS: ['ishares-isus.json', 'application/json'],
  ISWD: ['ishares-iswd.json', 'application/json'], IGDA: ['invesco-igda.json', 'application/json'],
  MWIM: ['invesco-mwim.json', 'application/json'], HIPS: ['hsbc-hips.xls', 'application/xls'],
  HIES: ['hsbc-hies.xls', 'application/xls'], HIJS: ['hsbc-hijs.xls', 'application/xls'],
  DJIW: ['waystone-djiw.csv', 'text/csv'],
};
class Served implements Transport {
  readonly #routes: Map<string, [string, string]>;
  constructor(routes: Map<string, [string, string]>) { this.#routes = routes; }
  async get(req: HttpRequest): Promise<HttpResponse> {
    const route = this.#routes.get(req.url);
    if (!route) throw new Error(`nothing served at ${req.url}`);
    return { status: 200, body: new Uint8Array(await readFile(route[0])), contentType: route[1] };
  }
}
const golden: ParseTools = {
  async xlsRows(bytes) {
    for (const t of ['hies', 'hips', 'hijs']) {
      if ((await readFile(fixture(`hsbc-${t}.xls`))).length === bytes.length) return JSON.parse(await readFile(fixture(`hsbc-${t}.rows.json`), 'utf8'));
    }
    throw new Error('unknown .xls');
  },
};

const APPLE = 'US0378331005';
const IGDA = 'IE000UOXRAM8';
const NVDA = 'US67066G1040';
const HIPS = 'IE000AGFZM58';
const RATES: RatesOutcome = { kind: 'ok', date: '2026-11-12', perPound: new Map([['USD', 1.3238], ['EUR', 1.1961]]), stale: null };
const NO_RATES: RatesOutcome = { kind: 'none', reason: 'the Bank of England did not answer (no internet)' };

async function setup(): Promise<Db> {
  const db = new NodeDb();
  await migrate(db, await migrationsFromDisk());
  await setUsualRate(db, 5);
  const deps: RefreshDeps = {
    db, diagnostics: new MemoryDiagnostics(), tools: golden, pause: async () => {}, now: () => new Date('2026-09-23T12:00:00Z'),
    web: new Served(new Map(FUNDS.map((f) => [SOURCES[f.issuer].request(f.key).url, [fixture(FILES[f.ticker]![0]), FILES[f.ticker]![1]]]))),
    t212: new Served(new Map([
      ['/api/v0/equity/positions', [fixture('t212-positions.synthetic.json'), 'application/json']],
      ['/api/v0/equity/metadata/instruments', [fixture('t212-instruments.synthetic.json'), 'application/json']],
      ['/api/v0/equity/history/dividends?limit=50', [fixture('t212-dividends-1.synthetic.json'), 'application/json']],
      ['/api/v0/equity/history/dividends?limit=50&cursor=1774396800000', [fixture('t212-dividends-2.synthetic.json'), 'application/json']],
      ['/api/v0/equity/history/orders?limit=50', [fixture('t212-orders.synthetic.json'), 'application/json']],
    ])),
  };
  await refresh(deps);
  // What opening Apple stores (research/open.ts): its name, classification, listing and prices.
  await db.batch([
    securityStatement(APPLE, 'Apple Inc.', 'equity', '2026-11-13'),
    fieldStatement(APPLE, 'sector', 'Technology', 'stockanalysis', 2, '2026-11-13'),
    fieldStatement(APPLE, 'country', 'United States', 'stockanalysis', 2, '2026-11-13'),
  ]);
  const apple = await ensureListing(db, { isin: APPLE, ticker: 'AAPL', exchange: 'NMS', currency: 'USD', sourceKeys: { yahoo: 'AAPL' } });
  await savePrices(db, apple, { symbol: 'AAPL', currency: 'USD', exchange: 'NMS', bars: [
    { date: '2026-11-11', open: null, high: null, low: null, close: 198, adjClose: 198, volume: null },
    { date: '2026-11-12', open: null, high: null, low: null, close: 200, adjClose: 200, volume: null },
  ] });
  return db;
}

test('5.5 ACCEPTANCE — buying: each amount beside "now", the company’s total counted directly and through each fund', async () => {
  const db = await setup();
  const plan = await planBuy(db, APPLE, [500, 750], RATES);
  assert.equal(plan.kind, 'ok', plan.kind === 'refused' ? plan.reason : '');
  if (plan.kind !== 'ok') return;
  assert.equal(plan.now.direct, 0);
  assert.deepEqual(plan.now.viaFunds.map((v) => v.fund), ['IGDA'], 'Apple held today only through IGDA');
  const via = plan.now.viaFunds[0]!.value;
  const [five, seven] = plan.options;
  assert.equal(five!.company.direct, 500);
  assert.equal(five!.company.viaFunds[0]!.value, via, 'what the funds hold does not change');
  assert.ok(Math.abs(five!.company.total - (via + 500)) < 1e-9);
  assert.ok(Math.abs(five!.company.share - (via + 500) / (plan.total + 500)) < 1e-12, 'a share of the bigger whole');
  assert.ok(seven!.company.share > five!.company.share);
  const tech = five!.sectors.find((s) => s.key === 'Technology')!;
  assert.ok(Math.abs(tech.after.value - tech.before.value - 500) < 1e-6, 'Technology gains the £500');
  const us = five!.countries.find((c) => c.key === 'US')!;
  assert.ok(Math.abs(us.after.value - us.before.value - 500) < 1e-6);
  assert.equal(five!.largest.length, 10);
  assert.ok(five!.largest.some((r) => r.after.value === five!.company.total), 'Apple among the ten largest after £500');
});

test('5.5 ACCEPTANCE — pounds become shares at the latest price and the Bank of England rate less Trading 212’s fee: part-shares and whole shares', async () => {
  const db = await setup();
  const plan = await planBuy(db, APPLE, [500], RATES);
  assert.ok(plan.kind === 'ok');
  const u = plan.options[0]!.units;
  assert.ok('units' in u);
  const expected = 500 * 1.3238 * (1 - T212_FX_FEE) / 200;
  assert.equal(u.units.toFixed(4), expected.toFixed(4));
  assert.equal(u.whole, 3);
  assert.equal(u.leftover.toFixed(2), (500 - 3 * (500 / expected)).toFixed(2));
  assert.deepEqual([u.price.amount, u.price.currency, u.price.date, u.rate?.perPound, u.rate?.fee, u.rate?.date], [200, 'USD', '2026-11-12', 1.3238, T212_FX_FEE, '2026-11-12']);
});

test('a London share priced in pence needs no rate: £500 at 3631.5p', () => {
  const u = unitsFor(500, { amount: 3631.5, currency: 'GBp', date: '2026-10-05' }, NO_RATES);
  assert.ok('units' in u);
  assert.equal(u.units.toFixed(4), (50000 / 3631.5).toFixed(4));
  assert.deepEqual([u.whole, u.rate], [13, null]);
  assert.ok(Math.abs(u.leftover - (500 - 13 * 36.315)) < 1e-9, '£27.905 left');
});

test('with no exchange rate, a dollar share shows no units — the reason instead', async () => {
  const db = await setup();
  const plan = await planBuy(db, APPLE, [500], NO_RATES);
  assert.ok(plan.kind === 'ok');
  assert.deepEqual(plan.options[0]!.units, { reason: 'no exchange rate: the Bank of England did not answer (no internet)' });
});

test('a company not opened cannot be planned', async () => {
  const db = await setup();
  const plan = await planBuy(db, 'US5949181045', [500], RATES);
  assert.equal(plan.kind, 'refused');
});

test('5.5 ACCEPTANCE — selling: the sale in pounds at the Bank’s rate less the fee, what it cost, the profit, purification, what is left', async () => {
  const db = await setup();
  const plan = await planSell(db, NVDA, 250, null, RATES);
  assert.equal(plan.kind, 'ok', plan.kind === 'refused' ? plan.reason : '');
  if (plan.kind !== 'ok') return;
  assert.deepEqual([plan.units, plan.proceeds.amount, plan.proceeds.currency], [6.25, 1562.5, 'USD']);
  assert.ok('pounds' in plan.pounds);
  const pounds = 1562.5 / (1.3238 * (1 + T212_FX_FEE));
  assert.equal(plan.pounds.pounds.toFixed(2), pounds.toFixed(2));
  assert.equal(plan.cost, 842.9, 'Trading 212’s cost, stored by the refresh');
  assert.equal(plan.profit, Math.round((pounds - 842.9) * 100) / 100);
  assert.deepEqual(plan.dividends, [{ paidOn: '2026-10-02', pounds: 0.05 }], 'paid since the last sale: it would count at this one');
  assert.equal(plan.ratePct, 5);
  assert.equal(plan.purification, Math.round(0.05 * (plan.profit! + 0.05) * 100) / 100);
  assert.equal(plan.left, Math.round((pounds - plan.purification!) * 100) / 100);
});

test('selling part of a holding costs only those units', async () => {
  const db = await setup();
  const plan = await planSell(db, IGDA, 45, 100, RATES);
  assert.ok(plan.kind === 'ok');
  assert.equal(plan.cost, Math.round(6190.5 * 100 / 250 * 100) / 100);
});

test('selling at a loss: nothing to purify on the sale, dividends still count', async () => {
  const db = await setup();
  const plan = await planSell(db, NVDA, 100, null, RATES);
  assert.ok(plan.kind === 'ok');
  assert.ok(plan.profit! < 0);
  assert.equal(plan.purification, Math.round(0.05 * 0.05 * 100) / 100);
});

test('a holding priced in pence sells in pounds with no rate and no fee', async () => {
  const db = await setup();
  const plan = await planSell(db, HIPS, 1500, null, NO_RATES);
  assert.ok(plan.kind === 'ok');
  assert.ok('pounds' in plan.pounds);
  assert.equal(plan.pounds.pounds, 1500 * 180.5 / 100);
  assert.equal(plan.pounds.rate, null);
  assert.equal(plan.proceeds.currency, 'GBp');
});

test('more units than held, or no price, is refused', async () => {
  const db = await setup();
  assert.equal((await planSell(db, NVDA, 250, 7, RATES)).kind, 'refused');
  assert.equal((await planSell(db, NVDA, 0, null, RATES)).kind, 'refused');
  assert.equal((await planSell(db, APPLE, 200, null, RATES)).kind, 'refused', 'not held');
});

test('5.5 ACCEPTANCE — each plan is kept with its date and listed later', async () => {
  const db = await setup();
  const buy = await planBuy(db, APPLE, [500, 750], RATES);
  await savePlan(db, { kind: 'buy', isin: APPLE, name: 'Apple Inc.', inputs: { amounts: [500, 750] }, outcome: buy }, new Date('2026-11-13T19:00:00Z'));
  await savePlan(db, { kind: 'sell', isin: NVDA, name: 'NVIDIA', inputs: { price: 250 }, outcome: {} }, new Date('2026-11-14T09:00:00Z'));
  const all = await listPlans(db);
  assert.deepEqual(all.map((p) => [p.kind, p.name, p.createdAt.slice(0, 10)]), [['sell', 'NVIDIA', '2026-11-14'], ['buy', 'Apple Inc.', '2026-11-13']]);
  assert.deepEqual((await listPlans(db, APPLE))[0]!.inputs, { amounts: [500, 750] });
});

/** Records every statement, to show what planning writes. */
class Watched implements Db {
  readonly writes: string[] = [];
  readonly #db: Db;
  constructor(db: Db) { this.#db = db; }
  query(sql: string, params?: readonly SqlValue[]): Promise<Row[]> {
    if (!/^\s*SELECT/i.test(sql)) this.writes.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
    return this.#db.query(sql, params);
  }
  batch(s: readonly Statement[]): Promise<void> { this.writes.push(...s.map((x) => x.sql.trim().split(/\s+/).slice(0, 3).join(' '))); return this.#db.batch(s); }
  migrate(scripts: readonly string[]): Promise<void> { return this.#db.migrate(scripts); }
}

test('5.5 ACCEPTANCE — no plan can place an order: planning reads, calculates, and writes only the plan it keeps', async () => {
  const watched = new Watched(await setup());
  await planBuy(watched, APPLE, [500], RATES);
  await planSell(watched, NVDA, 250, null, RATES);
  assert.deepEqual(watched.writes, [], 'working it out writes nothing');
  await savePlan(watched, { kind: 'buy', isin: APPLE, name: 'Apple Inc.', inputs: {}, outcome: {} }, new Date());
  assert.deepEqual(watched.writes, ['INSERT INTO plan']);
  // And it has no road to Trading 212: no transport is given to it, and it imports none.
  const source = await readFile(fileURLToPath(new URL('./plan.ts', import.meta.url)), 'utf8');
  assert.ok(!/from '\.\.\/(sources\/t212|fetch\/tauri)/.test(source));
  assert.ok(!/\/equity\/orders/.test(source));
});
