/**
 * Dividends (5.2) and purification (5.4), through the app's own Refresh.
 * §11.10, as gone through on 2026-11-13.
 *
 * Trading 212 data is INVENTED (t212-*.synthetic.json), in the shapes its
 * documentation gives (read 2026-11-13): no real dividend or sale response has
 * been seen yet. Invented: a fund that exists nowhere (ISIN ZZ…, so the
 * history can be nobody's) held, paid three times and sold in May 2026;
 * NVIDIA paid quarterly and partly sold in August.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HttpRequest, HttpResponse, Transport } from '../fetch/types.ts';
import { MemoryDiagnostics } from '../fetch/fixture.ts';
import { NodeDb, migrationsFromDisk } from '../db/node.ts';
import { migrate } from '../db/migrate.ts';
import { nextPath } from '../sources/t212.ts';
import { fetchDividends, fetchSales, loadDividends, isaYear, paymentType, setUsualRate } from './income.ts';
import { loadPurification, setItemRate, setTypedProfit, addManual, settle, deleteManual, fillMissingRates } from './purify.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fetch/fixtures/${name}`, import.meta.url));
/** An invented fund — ZZ is no country — so the test history can be nobody's. */
const INVENTED = 'ZZ00INVENT08';
const NVDA = 'US67066G1040';
const D1 = '/api/v0/equity/history/dividends?limit=50';
const D2 = '/api/v0/equity/history/dividends?limit=50&cursor=1774396800000';
const ORDERS = '/api/v0/equity/history/orders?limit=50';

class T212 implements Transport {
  readonly asked: string[] = [];
  readonly routes: Map<string, string | number>;
  constructor(routes: Record<string, string | number>) { this.routes = new Map(Object.entries(routes)); }
  async get(req: HttpRequest): Promise<HttpResponse> {
    this.asked.push(req.url);
    const r = this.routes.get(req.url);
    if (r === undefined) throw new Error(`nothing served at ${req.url}`);
    if (typeof r === 'number') return { status: r, body: new TextEncoder().encode('Scope( history:dividends ) missing for API key'), contentType: 'text/plain' };
    return { status: 200, body: new Uint8Array(await readFile(r)), contentType: 'application/json' };
  }
}
const everything = () => new T212({
  [D1]: fixture('t212-dividends-1.synthetic.json'), [D2]: fixture('t212-dividends-2.synthetic.json'), [ORDERS]: fixture('t212-orders.synthetic.json'),
});

async function setup(rate: number | null = 5) {
  const db = new NodeDb();
  await migrate(db, await migrationsFromDisk());
  if (rate !== null) await setUsualRate(db, rate);
  const deps = (t212: Transport) => ({ db, diagnostics: new MemoryDiagnostics(), transport: t212, now: () => new Date('2026-11-13T18:00:00Z') });
  const pause = async () => {};
  return { db, deps, pause };
}

async function edited(file: string, edit: (j: any) => void): Promise<string> {
  const j = JSON.parse(await readFile(fixture(file), 'utf8'));
  edit(j);
  const path = join(await mkdtemp(join(tmpdir(), 't212-')), file);
  await writeFile(path, JSON.stringify(j));
  return path;
}

// ── 5.2 dividends ────────────────────────────────────────────────────────

test('5.2 ACCEPTANCE — every dividend is fetched page by page, stored once, and a later refresh adds only new ones', async () => {
  const { db, deps, pause } = await setup();
  const web = everything();
  const first = await fetchDividends(deps(web), pause);
  assert.deepEqual([first.kind, first.items, first.added], ['ok', 6, 6]);
  assert.deepEqual(web.asked, [D1, D2], 'both pages, following nextPagePath');

  const again = await fetchDividends(deps(everything()), pause);
  assert.deepEqual([again.items, again.added], [6, 0]);
  assert.equal((await loadDividends(db)).payments.length, 6, 'not stored twice');

  const withNew = await edited('t212-dividends-1.synthetic.json', (j) => {
    j.items.unshift({ ...j.items[0], reference: 'SYN-D-007', paidOn: '2027-01-04T13:00:00.000+00:00' });
  });
  const later = await fetchDividends(deps(new T212({ [D1]: withNew, [D2]: fixture('t212-dividends-2.synthetic.json') })), pause);
  assert.deepEqual([later.items, later.added], [7, 1]);
});

test('5.2 ACCEPTANCE — the list is newest first, in pounds with units and amount per unit, with totals for each ISA year and all years', async () => {
  const { db, deps, pause } = await setup();
  await fetchDividends(deps(everything()), pause);
  const h = await loadDividends(db);
  assert.deepEqual(h.payments.map((p) => p.paidOn), ['2026-10-02', '2026-07-03', '2026-03-25', '2026-01-02', '2025-09-24', '2025-03-26']);
  const march = h.payments.find((p) => p.reference === 'SYN-D-004')!;
  assert.deepEqual([march.pounds, march.quantity, march.perUnit, march.perUnitCurrency, paymentType(march.type)], [6.08, 40, 15.2, 'GBX', 'Ordinary dividend']);
  assert.deepEqual(h.years.map((y) => [y.label, y.span, Math.round(y.pounds * 100) / 100, y.payments]), [
    ['2026/27', '6 Apr 2026 – 5 Apr 2027', 0.11, 2],
    ['2025/26', '6 Apr 2025 – 5 Apr 2026', 11.98, 3],
    ['2024/25', '6 Apr 2024 – 5 Apr 2025', 5.56, 1],
  ]);
  assert.equal(Math.round(h.total * 100) / 100, 17.65);
});

test('an ISA year runs 6 April to 5 April: 5 April ends one year, 6 April starts the next', () => {
  assert.equal(isaYear('2026-04-05').label, '2025/26');
  assert.equal(isaYear('2026-04-06').label, '2026/27');
  assert.equal(isaYear('2026-01-01').label, '2025/26');
  assert.equal(isaYear('1999-12-31').label, '1999/00');
});

test('5.2 ACCEPTANCE — each fund has its own payments, and a fund since sold still shows them', async () => {
  const { db, deps, pause } = await setup();
  await fetchDividends(deps(everything()), pause);
  const isdw = await loadDividends(db, INVENTED);
  assert.equal(isdw.payments.length, 3, 'INVENTED was sold in May; its payments stay');
  assert.ok(isdw.payments.every((p) => p.isin === INVENTED));
  assert.deepEqual(isdw.years.map((y) => y.label), ['2025/26', '2024/25']);
});

test('5.2 ACCEPTANCE — if Trading 212 refuses, what was stored stays, with when it was last updated and why', async () => {
  const { db, deps, pause } = await setup();
  await fetchDividends(deps(everything()), pause);
  const refused = await fetchDividends({ ...deps(new T212({ [D1]: 403 })), now: () => new Date('2026-11-20T09:00:00Z') }, pause);
  assert.equal(refused.kind, 'unavailable');
  const h = await loadDividends(db);
  assert.equal(h.payments.length, 6);
  assert.deepEqual([h.last?.kind, h.last?.at.slice(0, 10)], ['unavailable', '2026-11-20']);
  assert.match(h.last?.detail ?? '', /refused — check IP restriction or permissions/);
});

test('a payment not in pounds is refused, and nothing from that refresh is stored', async () => {
  const { db, deps, pause } = await setup();
  const euro = await edited('t212-dividends-2.synthetic.json', (j) => { j.items[0].currency = 'EUR'; });
  const out = await fetchDividends(deps(new T212({ [D1]: fixture('t212-dividends-1.synthetic.json'), [D2]: euro })), pause);
  assert.equal(out.kind, 'suspect');
  assert.equal((await loadDividends(db)).payments.length, 0, 'half a history would look complete');
});

test('a payment larger than units × amount per unit is refused (pence read as pounds)', async () => {
  const { deps, pause } = await setup();
  const big = await edited('t212-dividends-2.synthetic.json', (j) => { j.items[1].amount = 584; });
  const out = await fetchDividends(deps(new T212({ [D1]: fixture('t212-dividends-1.synthetic.json'), [D2]: big })), pause);
  assert.equal(out.kind, 'suspect');
  assert.match(out.detail ?? '', /SYN-D-002/);
});

test('nextPagePath is used whole, and made a full path if it starts below /api/v0', () => {
  assert.equal(nextPath('/api/v0/equity/history/dividends?cursor=1'), '/api/v0/equity/history/dividends?cursor=1');
  assert.equal(nextPath('/equity/history/dividends?cursor=1'), '/api/v0/equity/history/dividends?cursor=1');
  assert.equal(nextPath(null), null);
  assert.throws(() => nextPath('https://elsewhere.example/x'));
});

test('payment types read in plain words; one not seen before reads as its own name', () => {
  assert.equal(paymentType('RETURN_OF_CAPITAL_NON_US'), 'Return of capital');
  assert.equal(paymentType('INTEREST_MANUFACTURED_PAYMENT'), 'Interest (manufactured payment)');
  assert.equal(paymentType('DIVIDENDS_PAID_BY_US_CORPORATIONS'), 'Dividend (US company)');
  assert.equal(paymentType('PTP_UNCHARACTERISED_INCOME'), 'Ptp uncharacterised income');
});

// ── 5.4 purification ─────────────────────────────────────────────────────

async function withHistory(rate: number | null = 5) {
  const s = await setup(rate);
  await fetchDividends(s.deps(everything()), s.pause);
  await fetchSales(s.deps(everything()), s.pause);
  return s;
}

test('5.4 ACCEPTANCE — each sale is an item: profit × rate, plus each dividend paid while held × the same rate', async () => {
  const { db } = await withHistory();
  const p = await loadPurification(db);
  assert.equal(p.items.length, 2, 'two sales; the buy is not an item');
  const [nvda, isdw] = p.items;
  assert.equal(isdw!.description, 'Sold 40 Invented Income Fund (test data)');
  assert.deepEqual([isdw!.ratePct, isdw!.profit, isdw!.dividends.map((d) => d.reference)], [5, { kind: 'trading212', pounds: 180 }, ['SYN-D-001', 'SYN-D-002', 'SYN-D-004']]);
  assert.equal(isdw!.owed, 9.87, '5% × (£180 + £17.48)');
  assert.deepEqual(nvda!.dividends.map((d) => d.reference), ['SYN-D-003', 'SYN-D-005']);
  assert.equal(nvda!.owed, 0.72, '5% × (£14.20 + £0.12)');
  assert.deepEqual(p.notYetCounted.get(NVDA)?.map((d) => d.reference), ['SYN-D-006'], 'paid after the sale: waits for the next one');
  assert.equal(p.outstanding, 10.59);
});

test('5.4 ACCEPTANCE — a new item starts with his usual rate; changing the usual rate, or one item’s, changes no other item', async () => {
  const { db, deps, pause } = await withHistory();
  await setUsualRate(db, 2.5);
  await fetchSales(deps(everything()), pause);
  const [nvda, isdw] = (await loadPurification(db)).items;
  assert.deepEqual([nvda!.ratePct, isdw!.ratePct], [5, 5], 'the usual rate when they were created');
  assert.equal((await setItemRate(db, isdw!.id, 3)).kind, 'done');
  const after = (await loadPurification(db)).items;
  assert.deepEqual(after.map((i) => i.ratePct), [5, 3]);
});

test('5.4 ACCEPTANCE — a sale at a loss has nothing to purify on the sale, but its dividends still count', async () => {
  const { db } = await withHistory();
  const isdw = (await loadPurification(db)).items[1]!;
  await setTypedProfit(db, isdw.id, -25);
  const after = (await loadPurification(db)).items[1]!;
  assert.deepEqual(after.profit, { kind: 'typed', pounds: -25 });
  assert.equal(after.owed, 0.87, '5% × (£0 + £17.48)');
});

test('5.4 ACCEPTANCE — a dividend is counted once: a later partial sale counts only what was paid since', async () => {
  const { db, deps, pause } = await withHistory();
  const more = await edited('t212-orders.synthetic.json', (j) => {
    j.items.unshift({ order: { ...j.items[0].order, id: 9004 }, fill: { ...j.items[0].fill, id: 7004, filledAt: '2026-10-20T15:00:00.000+00:00' } });
  });
  await fetchSales(deps(new T212({ [ORDERS]: more })), pause);
  const p = await loadPurification(db);
  const nvdaSales = p.items.filter((i) => i.isin === NVDA);
  assert.deepEqual(nvdaSales.map((i) => i.dividends.map((d) => d.reference)), [['SYN-D-006'], ['SYN-D-003', 'SYN-D-005']]);
  assert.equal(p.notYetCounted.get(NVDA), undefined);
});

test('5.4 ACCEPTANCE — with no usual rate set, an item says the rate is not entered and adds nothing up', async () => {
  const { db } = await withHistory(null);
  const p = await loadPurification(db);
  assert.ok(p.items.every((i) => i.ratePct === null && i.owed === null));
  assert.deepEqual([p.outstanding, p.incomplete], [0, 2]);
});

test('5.4 ACCEPTANCE — the interest payment is typed by hand and works the same way', async () => {
  const { db } = await withHistory();
  assert.equal((await addManual(db, { date: '2025-06-01', description: 'Interest on cash', pounds: 3.4, ratePct: 100 }, new Date())).kind, 'done');
  const item = (await loadPurification(db)).items.find((i) => i.kind === 'manual')!;
  assert.deepEqual([item.amount, item.owed], [3.4, 3.4]);
  assert.equal((await addManual(db, { date: '', description: 'x', pounds: 1, ratePct: 5 }, new Date())).kind, 'refused');
  assert.equal((await deleteManual(db, item.id)).kind, 'done');
});

test('5.4 ACCEPTANCE — several items settle in one action with the date paid; what was owed is kept, and only unticked items stay owing', async () => {
  const { db } = await withHistory();
  const [nvda, isdw] = (await loadPurification(db)).items;
  assert.equal((await settle(db, [nvda!.id, isdw!.id], '2026-11-14')).kind, 'done');
  const p = await loadPurification(db);
  assert.deepEqual(p.items.map((i) => i.settled), [{ on: '2026-11-14', amount: 0.72 }, { on: '2026-11-14', amount: 9.87 }]);
  assert.equal(p.outstanding, 0);
  assert.equal((await setItemRate(db, isdw!.id, 1)).kind, 'refused', 'a settled item is kept as it was');
  assert.equal((await settle(db, [isdw!.id], '2026-11-15')).kind, 'refused');
});

test('an item cannot be settled before its amount is known', async () => {
  const { db } = await withHistory(null);
  const out = await settle(db, [(await loadPurification(db)).items[0]!.id], '2026-11-14');
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') assert.match(out.reason, /no amount yet/);
});

test('5.4 ACCEPTANCE — Trading 212’s profit is used only when its figures agree; otherwise he types it', async () => {
  const { db, deps, pause } = await setup();
  const odd = await edited('t212-orders.synthetic.json', (j) => { j.items[1].fill.walletImpact.netValue = 14; });
  await fetchSales(deps(new T212({ [ORDERS]: odd })), pause);
  const isdw = (await loadPurification(db)).items.find((i) => i.isin === INVENTED)!;
  assert.equal(isdw.profit?.kind, 'unknown');
  assert.equal(isdw.owed, null);
  await setTypedProfit(db, isdw.id, 180);
  assert.equal((await loadPurification(db)).items.find((i) => i.isin === INVENTED)!.owed, 9, '5% × £180; no dividends fetched in this test');
});

test('a profit given in another currency is not used', async () => {
  const { db, deps, pause } = await setup();
  const usd = await edited('t212-orders.synthetic.json', (j) => { j.items[0].fill.walletImpact.currency = 'USD'; });
  await fetchSales(deps(new T212({ [ORDERS]: usd })), pause);
  const nvda = (await loadPurification(db)).items.find((i) => i.isin === NVDA)!;
  assert.equal(nvda.profit?.kind, 'unknown');
  if (nvda.profit?.kind === 'unknown') assert.match(nvda.profit.reason, /in USD, not pounds/);
});

test('one click fills every sale without a rate with his usual rate; a sale with its own rate, or settled, is untouched', async () => {
  const { db } = await withHistory(null);
  assert.equal((await fillMissingRates(db)).kind, 'refused', 'no usual rate yet');
  const [nvda, isdw] = (await loadPurification(db)).items;
  await setItemRate(db, nvda!.id, 3);
  await setUsualRate(db, 5);
  const out = await fillMissingRates(db);
  assert.deepEqual([out.kind, out.filled], ['done', 1]);
  assert.deepEqual((await loadPurification(db)).items.map((i) => [i.id, i.ratePct]), [[nvda!.id, 3], [isdw!.id, 5]]);
});
