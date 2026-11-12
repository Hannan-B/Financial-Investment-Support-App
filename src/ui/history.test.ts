/**
 * The History tab's table (§11.9 steps 4.1–4.3, as settled 2026-11-12).
 * Invented figures on a fixed clock: what matters here is the arithmetic and
 * the wording, not any company's numbers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Fact } from '../research/figures.ts';
import type { HistoryFacts, StoredSnapshot } from '../research/history.ts';
import { shows } from '../research/history.ts';
import { FIGURE_NAMES } from '../research/names.ts';
import { checksOf, columns, rows, change, placeOf, grouped, OTHER, type Check } from './history.ts';
import type { Entry } from '../notes/document.ts';

const snap = (id: number, capturedAt: string, outcomes: StoredSnapshot['outcomes'] = []): StoredSnapshot =>
  ({ id, capturedAt, complete: true, outcomes });
const fact = (snapshotId: number, fieldPath: string, value: number | string, more: Partial<Fact> = {}): Fact & { snapshotId: number } => ({
  snapshotId, fieldPath, value, period: null, periodEnd: null, unit: 'USD', currency: 'USD', kind: 'actual',
  source: 'finviz', tier: 2, asOf: '2026-01-01', detail: '', ...more,
});
const check = (at: string, round: number): Check => ({ at, round, stance: 'watching', sold: null });
const decision = (id: number, createdAt: string, round: number, deletedAt: string | null = null): Entry => ({
  id, round, kind: 'decision', createdAt, tab: null, target: null, snapshotId: null, stance: 'watching', sold: null, versions: [], deletedAt,
});

test('a check is each Review complete — its "Where I stand" line; deleted ones and other entries are not checks', () => {
  const entries: Entry[] = [
    decision(2, '2026-05-01T10:00:00Z', 2),
    decision(1, '2026-01-01T10:00:00Z', 1),
    { ...decision(3, '2026-03-01T10:00:00Z', 1), kind: 'concluding', stance: null },
    decision(4, '2026-06-01T10:00:00Z', 3, '2026-06-02T00:00:00Z'),
  ];
  assert.deepEqual(checksOf(entries).map((c) => c.at), ['2026-01-01T10:00:00Z', '2026-05-01T10:00:00Z']);
});

// Six checks, each after a refresh; a seventh refresh since the last check.
const SIX: HistoryFacts = {
  snapshots: [1, 2, 3, 4, 5, 6, 7].map((m) => snap(m, `2026-0${m}-01T09:00:00Z`)),
  facts: [1, 2, 3, 4, 5, 6, 7].flatMap((m) => [
    fact(m, 'profitability.gross_margin', 20 + m, { unit: 'percent', currency: null }),
    fact(m, 'price.close', 100 * m, { source: 'yahoo' }),
  ]),
  gaps: [],
};
const SIX_CHECKS = [1, 2, 3, 4, 5, 6].map((m) => check(`2026-0${m}-01T18:00:00Z`, m));

test('4.1 ACCEPTANCE — six checks: the last five and now, each dated, the last check marked; "Show earlier" adds the sixth', () => {
  const { columns: cols, earlier } = columns(SIX, SIX_CHECKS, { everyRefresh: false, checks: 5 });
  assert.equal(earlier, 1, 'one check not shown');
  assert.deepEqual(cols.map((c) => c.snapshot?.capturedAt.slice(0, 7)), ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']);
  assert.deepEqual(cols.map((c) => (c.now ? 'now' : c.lastCheck ? 'last check' : 'check')), ['check', 'check', 'check', 'check', 'last check', 'now']);
  assert.equal(columns(SIX, SIX_CHECKS, { everyRefresh: false, checks: 10 }).columns.length, 7, 'all six checks and now');

  const [margin] = rows(SIX, cols, (p) => p === 'profitability.gross_margin');
  assert.equal(margin!.cells[1]!.step!.text, '+1.00 pts', 'from the check before');
  assert.equal(margin!.sinceLastCheck!.text, '+1.00 pts');
  assert.equal(margin!.sinceOldest!.text, '+5.00 pts');
});

test('4.1 ACCEPTANCE — each change in its usual terms', () => {
  const at = '2026-06-01T00:00:00Z';
  const c = (a: Partial<Fact> & { value: number | string }, b: Partial<Fact> & { value: number | string }, path = 'x.y') =>
    change(fact(1, path, a.value, a), fact(2, path, b.value, b), at).text;
  assert.equal(c({ value: 24, unit: 'percent', currency: null }, { value: 26, unit: 'percent', currency: null }), '+2.00 pts', 'a margin in points, not +8.3%');
  assert.equal(c({ value: 200 }, { value: 220 }, 'price.close'), '+10.0%', 'a price in %');
  assert.equal(c({ value: 28.4, unit: 'ratio', currency: null }, { value: 31.1, unit: 'ratio', currency: null }, 'valuation.pe_ttm'), '+2.70', 'P/E as a plain difference');
  assert.equal(c({ value: 71.9, unit: 'index', currency: null }, { value: 40.3, unit: 'index', currency: null }, 'technical.rsi_14'), '−31.6 pts', 'RSI in points');
  assert.equal(c({ value: '2026-10-29', unit: 'date', currency: null }, { value: '2026-11-02', unit: 'date', currency: null }, 'calendar.next_earnings'), 'moved from 29 Oct to 2 Nov');
  assert.equal(c({ value: '2026-04-30', unit: 'date', currency: null }, { value: '2026-07-30', unit: 'date', currency: null }, 'calendar.next_earnings'), 'the next one', 'a date already past by then was a different event');
  assert.equal(c({ value: 'Strong Buy', unit: 'text', currency: null }, { value: 'Buy', unit: 'text', currency: null }, 'analyst.consensus'), 'was Strong Buy, now Buy');
  assert.equal(c({ value: -5e9 }, { value: 3e9 }, 'income.net_income'), '+$8.0B', 'across a loss: the amount, not a percentage');
  assert.equal(c({ value: 1, currency: 'USD' }, { value: 1, currency: 'GBP' }), 'now in GBP — not compared');
});

test('4.1 ACCEPTANCE — new results carry both years; an earlier year the company revised is flagged', () => {
  const y = (s: number, period: string, value: number) => fact(s, 'income.revenue', value, { source: 'edgar', period, periodEnd: `${period.slice(2)}-09-30` });
  const h: HistoryFacts = {
    snapshots: [snap(1, '2025-07-07T09:00:00Z'), snap(2, '2025-11-03T09:00:00Z'), snap(3, '2026-02-09T09:00:00Z')],
    facts: [y(1, 'FY2023', 383e9), y(1, 'FY2024', 391e9), y(2, 'FY2024', 390e9), y(2, 'FY2025', 416e9), y(3, 'FY2024', 390e9), y(3, 'FY2025', 416e9)],
    gaps: [],
  };
  const cols = columns(h, [check('2025-07-07T18:00:00Z', 1), check('2025-11-03T18:00:00Z', 2)], { everyRefresh: false, checks: 5 }).columns;
  const [revenue] = rows(h, cols, () => true);
  assert.equal(revenue!.cells[0]!.fact!.period, 'FY2024', 'the latest year known then');
  assert.equal(revenue!.cells[1]!.fact!.period, 'FY2025');
  assert.deepEqual(revenue!.cells[1]!.step, { text: '+6.4%', periods: 'FY2024 → FY2025' });
  assert.deepEqual(revenue!.cells[1]!.revised.map((r) => [r.period, r.from.value, r.to.value]), [['FY2024', 391e9, 390e9]]);
  assert.equal(revenue!.cells[2]!.step!.text, 'same year', 'no new results between');
  assert.equal(revenue!.cells[2]!.revised.length, 0);
});

test('4.3 — with 3 refreshes between two checks: 2 checks and now; switched on, all 5 refreshes, checks still marked', () => {
  const h: HistoryFacts = {
    snapshots: [1, 2, 3, 4, 5].map((m) => snap(m, `2026-0${m}-01T09:00:00Z`)),
    facts: [1, 2, 3, 4, 5].map((m) => fact(m, 'price.close', 100 + m, { source: 'yahoo' })),
    gaps: [],
  };
  const checks = [check('2026-01-01T18:00:00Z', 1), check('2026-05-01T18:00:00Z', 2)];
  const off = columns(h, checks, { everyRefresh: false, checks: 5 }).columns;
  assert.deepEqual(off.map((c) => [c.snapshot?.id, c.check ? 'check' : c.now ? 'now' : '']), [[1, 'check'], [5, 'check']],
    'no refresh since the last check: no "now" column repeating it');

  const on = columns(h, checks, { everyRefresh: true, checks: 5 }).columns;
  assert.deepEqual(on.map((c) => [c.snapshot?.id, c.check ? 'check' : c.now ? 'now' : 'refresh']),
    [[1, 'check'], [2, 'refresh'], [3, 'refresh'], [4, 'refresh'], [5, 'check']]);
  const [p] = rows(h, on, () => true);
  assert.deepEqual(p!.cells.map((c) => c.step?.text ?? null), [null, '+1.0%', '+1.0%', '+1.0%', '+1.0%'], 'each against the column before');
  assert.equal(p!.sinceLastCheck, null, 'nothing since the last check to compare');
  assert.equal(p!.sinceOldest!.text, '+4.0%', 'the oldest shown against the last: 101 → 105');

  // Refreshes before the first check are shown too, unless an earlier check is hidden.
  const before = { ...h, snapshots: [snap(0, '2025-12-01T09:00:00Z'), ...h.snapshots], facts: [fact(0, 'price.close', 99, { source: 'yahoo' }), ...h.facts] };
  assert.equal(columns(before, checks, { everyRefresh: true, checks: 5 }).columns[0]!.snapshot!.id, 0, 'all of them, from the first refresh');
  assert.equal(columns(before, checks, { everyRefresh: true, checks: 1 }).columns[0]!.snapshot!.id, 5, 'from the oldest check shown');

  // A refresh after the last check brings "now" back.
  const later = { ...h, snapshots: [...h.snapshots, snap(6, '2026-06-01T09:00:00Z')], facts: [...h.facts, fact(6, 'price.close', 110, { source: 'yahoo' })] };
  const cols = columns(later, checks, { everyRefresh: false, checks: 5 }).columns;
  assert.deepEqual(cols.map((c) => c.now), [false, false, true]);
  assert.equal(rows(later, cols, () => true)[0]!.sinceLastCheck!.text, '+4.8%');
});

test('a missing figure says why: no refresh before the check, a gap, a source that did not answer', () => {
  const h: HistoryFacts = {
    snapshots: [snap(1, '2026-02-01T09:00:00Z'), snap(2, '2026-03-01T09:00:00Z', [{ source: 'finviz', outcome: 'unavailable', detail: 'timeout' }]),
      snap(3, '2026-04-01T09:00:00Z')],
    facts: [fact(1, 'valuation.pe_ttm', 30, { unit: 'ratio', currency: null }), fact(3, 'valuation.pe_ttm', 31, { unit: 'ratio', currency: null })],
    gaps: [{ snapshotId: 3, fieldPath: 'valuation.peg', reason: 'Finviz shows "-" for it' }],
  };
  const cols = columns(h, [check('2026-01-01T18:00:00Z', 1), check('2026-03-01T18:00:00Z', 2)], { everyRefresh: false, checks: 5 }).columns;
  const [pe] = rows(h, cols, () => true);
  assert.deepEqual(pe!.cells.map((c) => c.missing), ['not refreshed before this check', 'Finviz did not answer', null]);
  assert.equal(pe!.sinceOldest, null, 'nothing to compare with');
});

test('4.1 ACCEPTANCE — a figure hidden for all and added back for one company shows for that one only', () => {
  const hidden = { hidden: ['technical.atr_14', 'technical.rsi_14'], extra: [] };
  const apple = { hidden: hidden.hidden, extra: ['technical.rsi_14'] };
  assert.equal(shows(hidden, 'technical.rsi_14'), false);
  assert.equal(shows(apple, 'technical.rsi_14'), true);
  assert.equal(shows(apple, 'technical.atr_14'), false);
  assert.equal(shows(apple, 'price.close'), true, 'everything else shows');
  const cols = columns(SIX, SIX_CHECKS, { everyRefresh: false, checks: 5 }).columns;
  assert.deepEqual(rows(SIX, cols, (p) => shows({ hidden: ['price.close'], extra: [] }, p)).map((r) => r.path), ['profitability.gross_margin']);
});

test('every figure the app names has a History group — none falls into "Other figures"', () => {
  const lost = Object.keys(FIGURE_NAMES).filter((p) => placeOf(p).group === OTHER);
  assert.deepEqual(lost, []);
  assert.deepEqual(placeOf('technical.macd_12_26_9.signal'), { group: 'Technicals', sub: 'Momentum' });
  assert.deepEqual(placeOf('trading.high_52w'), { group: 'Price and returns', sub: '52-week range' });
  assert.deepEqual(placeOf('valuation.pe_ttm'), { group: 'Valuation', sub: 'Price compared with…' });
  const g = grouped(['analyst.target_price', 'price.close', 'technical.sma_50', 'technical.rsi_14'], (p) => p);
  assert.deepEqual(g.map((x) => x.title), ['Price and returns', 'Technicals', 'Analyst predictions']);
  assert.deepEqual(g[1]!.subs.map((s) => s.title), ['Moving averages', 'Momentum']);
});
