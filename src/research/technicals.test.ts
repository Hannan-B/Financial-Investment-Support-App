/**
 * Technical indicators.  §11.7 step 2.2: each shows its formula and inputs
 * alongside the result.
 *
 * Three kinds of evidence:
 *   · small series worked by hand
 *   · Shell (SHEL.L, 2026-10-05) against stockanalysis's published figures,
 *     and against an independent implementation for the ones it does not publish
 *   · every working redone from the numbers it shows — it must land on its result
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runSource } from '../fetch/run.ts';
import { FixtureTransport } from '../fetch/fixture.ts';
import { makeYahooPrices, type PriceBar } from '../sources/yahoo.ts';
import {
  sma, ema, rsi, macd, bollinger, atr, indicators, DEFAULT_SETTINGS,
  type Indicator, type Prices, type Working,
} from './technicals.ts';

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
function near(actual: number | null | undefined, expected: number, eps = 1e-9) {
  assert.ok(actual != null && close(actual, expected, eps), `expected ${expected}, got ${actual}`);
}

/** Bars from closes (and optionally highs and lows), one a day from 1 June 2026. */
function bars(closes: readonly number[], hl?: readonly (readonly [number | null, number | null])[]): Prices {
  return {
    currency: 'USD',
    bars: closes.map((c, i): PriceBar => ({
      date: new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10),
      open: null, high: hl ? hl[i]![0] : c, low: hl ? hl[i]![1] : c, close: c, adjClose: null, volume: null,
    })),
  };
}

function ok<S>(r: Indicator<S>): { series: S; working: Working } {
  assert.equal(r.kind, 'ok', r.kind === 'insufficient' ? `needs ${r.needed}, has ${r.have}` : '');
  return r as { kind: 'ok'; series: S; working: Working };
}

const value = (w: Working, label: string) => {
  const line = [...w.inputs, ...w.result].find((l) => l.label === label);
  assert.ok(line, `no line "${label}" in ${w.indicator}`);
  return line.value;
};
const result = (w: Working) => w.result[w.result.length - 1]!.value;

let shell: Prices | undefined;
async function shellPrices(): Promise<Prices> {
  if (shell) return shell;
  const source = makeYahooPrices(() => new Date('2026-10-05T18:00:00Z'));
  const path = fileURLToPath(new URL('../fetch/fixtures/yahoo-shel-l.json', import.meta.url));
  const out = await runSource(source, 'SHEL.L', new FixtureTransport({ [source.request('SHEL.L').url]: path }, 'application/json'));
  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') throw new Error('unreachable');
  shell = { currency: out.value.currency, bars: out.value.bars };
  return shell;
}

// ── worked by hand ───────────────────────────────────────────────────────

test('SMA by hand: the last three of 1–5 average 4', () => {
  const r = ok(sma(bars([1, 2, 3, 4, 5]), 3));
  assert.deepEqual(r.series, [null, null, 2, 3, 4]);
});

test('EMA by hand: starts from the average of the first three, then halves the gap each day', () => {
  // α = 2 ÷ (3 + 1) = 0.5; start 2; 0.5×4 + 0.5×2 = 3; 0.5×5 + 0.5×3 = 4
  const r = ok(ema(bars([1, 2, 3, 4, 5]), 3));
  assert.deepEqual(r.series, [null, null, 2, 3, 4]);
});

test('RSI by hand, Wilder smoothing over two days', () => {
  // changes +1 −1 +2 −1. Start: gain 0.5, loss 0.5 → 50.
  // then gain (0.5 + 2) ÷ 2 = 1.25, loss (0.5 + 0) ÷ 2 = 0.25 → RS 5 → 83.33
  // then gain (1.25 + 0) ÷ 2 = 0.625, loss (0.25 + 1) ÷ 2 = 0.625 → 50
  const r = ok(rsi(bars([10, 11, 10, 12, 11]), 2));
  assert.equal(r.series[2], 50);
  near(r.series[3], 100 - 100 / 6);
  near(r.series[4], 50);
});

test('RSI is 100 when there were no losses at all', () => {
  const r = ok(rsi(bars([1, 2, 3, 4, 5, 6]), 3));
  assert.equal(result(r.working), 100);
  assert.ok(r.working.notes.some((n) => /No losses/.test(n)));
});

test('Bollinger by hand: the textbook series with mean 5 and standard deviation 2', () => {
  const r = ok(bollinger(bars([2, 4, 4, 4, 5, 5, 7, 9]), 8, 2));
  assert.equal(value(r.working, 'middle'), 5);
  assert.equal(value(r.working, 'SD'), 2);
  assert.equal(value(r.working, 'upper'), 9);
  assert.equal(value(r.working, 'lower'), 1);
});

test('ATR by hand, including a gap where yesterday’s close is outside today’s range', () => {
  // Day 1's ranges are 2, 2, 0 → 2; day 2's are 2, 2, 0 → 2; ATR starts at (2 + 2) ÷ 2 = 2.
  // Day 3: high − low is only 1, but |high − 11| is 2 → true range 2, ATR (2 + 2) ÷ 2 = 2.
  // Day 4 gaps up: high 20, low 19, yesterday's close 12.5 → true range 7.5, ATR (2 + 7.5) ÷ 2.
  const p = bars([9, 10, 11, 12.5, 19.5], [[10, 8], [11, 9], [12, 10], [13, 12], [20, 19]]);
  const r = ok(atr(p, 2));
  assert.deepEqual(r.series.slice(0, 3), [null, null, 2]);
  near(r.series[3], (2 * 1 + 2) / 2);
  near(r.series[4], (2 * 1 + 7.5) / 2);
  assert.equal(value(r.working, 'true range'), 7.5);
});

test('ATR starts again after a day with no high or low, rather than smoothing over the gap', () => {
  const p = bars([1, 2, 3, 4, 5, 6, 7, 8], [[1, 1], [2, 2], [null, null], [4, 3], [5, 4], [6, 5], [7, 6], [8, 7]]);
  const r = ok(atr(p, 2));
  assert.deepEqual(r.series.slice(0, 5), [null, null, null, null, null], 'nothing before the gap counts');
  assert.match(r.working.notes[0]!, /started on 2026-06-06/);
});

test('MACD: the line is the fast EMA less the slow, the signal an EMA of the line', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + 10 * Math.sin(i / 5) + i / 3);
  const p = bars(closes);
  const m = ok(macd(p, 12, 26, 9));
  const fast = ok(ema(p, 12)).series;
  const slow = ok(ema(p, 26)).series;
  for (let i = 25; i < 60; i++) near(m.series.macd[i], fast[i]! - slow[i]!);
  assert.equal(m.series.signal[32], null, 'the signal needs nine MACD values first');
  const firstNine = m.series.macd.slice(25, 34) as number[];
  near(m.series.signal[33], firstNine.reduce((a, b) => a + b) / 9);
});

// ── against the outside world ────────────────────────────────────────────

test('2.2 — Shell matches stockanalysis: RSI(14) 60.87 and SMA(50) 3,444.42 pence', async () => {
  const p = await shellPrices();
  near(result(ok(rsi(p, 14)).working), 60.865, 1e-4);
  near(result(ok(sma(p, 50)).working), 3444.42, 1e-6);
  // stockanalysis shows SMA(200) 3,170.19; Yahoo's closes give 3,170.28. A 0.09p gap
  // over 200 days is one close differing between their data and Yahoo's, not the method.
  near(result(ok(sma(p, 200)).working), 3170.2825, 1e-9);
});

test('Shell matches an independent implementation of EMA, MACD, Bollinger and ATR', async () => {
  // Reference values from a separate Python implementation of the same definitions.
  const p = await shellPrices();
  near(result(ok(ema(p, 12)).working), 3587.7755243846013);
  near(result(ok(ema(p, 26)).working), 3536.8795569158474);
  const m = ok(macd(p)).working;
  near(value(m, 'MACD line'), 50.89596746875395);
  near(value(m, 'signal'), 55.780451380310154);
  near(value(m, 'histogram'), -4.884483911556202);
  const b = ok(bollinger(p)).working;
  near(value(b, 'middle'), 3573.75);
  near(value(b, 'SD'), 49.09977087522914);
  near(value(b, 'upper'), 3671.949541750458);
  near(value(b, 'lower'), 3475.550458249542);
  near(result(ok(atr(p)).working), 66.81593105312241);
});

// ── the working is true ──────────────────────────────────────────────────

test('2.2 ACCEPTANCE — every indicator shows its formula, inputs and result, and the inputs give the result', async () => {
  const p = await shellPrices();
  const all = indicators(p);
  const workings = [...all.sma, ...all.ema, all.rsi, all.macd, all.bollinger, all.atr].map((r) => ok<unknown>(r).working);
  assert.equal(workings.length, 9);
  for (const w of workings) {
    assert.ok(w.formula.length > 0 && w.inputs.length > 0 && w.result.length > 0, w.indicator);
    assert.equal(w.date, '2026-10-05', w.indicator);
  }
  const [sma20, sma50, sma200, ema12, ema26, rsi14, macdW, bb, atr14] = workings as [Working, ...Working[]];

  for (const [w, n] of [[sma20, 20], [sma50, 50], [sma200, 200]] as const) {
    assert.equal(w!.inputs.length, n, `${w!.indicator} lists every close it averaged`);
    near(w!.inputs.reduce((s, l) => s + l.value, 0) / n, result(w!));
  }

  for (const w of [ema12!, ema26!]) {
    const [alpha, today, yesterday] = w.inputs.map((l) => l.value) as [number, number, number];
    near(alpha * today + (1 - alpha) * yesterday, result(w));
  }

  {
    const [today, yesterday, gain, loss] = rsi14!.inputs.map((l) => l.value) as [number, number, number, number];
    const change = today - yesterday;
    const g = (gain * 13 + Math.max(change, 0)) / 14;
    const l = (loss * 13 + Math.max(-change, 0)) / 14;
    near(100 - 100 / (1 + g / l), result(rsi14!));
  }

  {
    const [fast, slow, signalYesterday] = macdW!.inputs.map((l) => l.value) as [number, number, number];
    const line = fast - slow;
    const signal = (2 / 10) * line + (1 - 2 / 10) * signalYesterday;
    near(line, value(macdW!, 'MACD line'));
    near(signal, value(macdW!, 'signal'));
    near(line - signal, value(macdW!, 'histogram'));
  }

  {
    const cs = bb!.inputs.map((l) => l.value);
    const mid = cs.reduce((a, b) => a + b) / cs.length;
    const sd = Math.sqrt(cs.reduce((s, c) => s + (c - mid) ** 2, 0) / cs.length);
    near(mid, value(bb!, 'middle'));
    near(mid + 2 * sd, value(bb!, 'upper'));
    near(mid - 2 * sd, value(bb!, 'lower'));
  }

  {
    const [high, low, prevClose, prevAtr] = atr14!.inputs.map((l) => l.value) as [number, number, number, number];
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    near((prevAtr * 13 + tr) / 14, result(atr14!));
  }
});

test('price-based results are in the listing’s own currency — pence for Shell', async () => {
  const p = await shellPrices();
  for (const r of [sma(p, 50), ema(p, 12), macd(p), bollinger(p), atr(p)]) assert.equal(ok<unknown>(r).working.unit, 'GBp');
  assert.equal(ok(rsi(p)).working.unit, 'index, 0 to 100');
});

// ── periods ──────────────────────────────────────────────────────────────

test('periods are the user’s: a different RSI period is a different, labelled result', async () => {
  const p = await shellPrices();
  const nine = ok(indicators(p, { ...DEFAULT_SETTINGS, rsi: 9 }).rsi).working;
  assert.equal(nine.indicator, 'RSI(9)');
  assert.notEqual(result(nine), result(ok(rsi(p, 14)).working));
});

test('too little history says how much is needed, rather than guessing', () => {
  const p = bars(Array.from({ length: 50 }, (_, i) => 100 + i));
  assert.deepEqual(sma(p, 200), { kind: 'insufficient', indicator: 'SMA(200)', needed: 200, have: 50 });
  assert.equal(macd(bars([1, 2, 3])).kind, 'insufficient');
  assert.equal(rsi(bars([1, 2, 3])).kind, 'insufficient');
  assert.equal(atr(bars([1, 2, 3])).kind, 'insufficient');
});

test('nonsense periods are refused', () => {
  const p = bars([1, 2, 3]);
  assert.throws(() => sma(p, 0), RangeError);
  assert.throws(() => ema(p, 2.5), RangeError);
  assert.throws(() => macd(p, 26, 12, 9), /must be shorter/);
  assert.throws(() => bollinger(p, 20, 0), RangeError);
});
