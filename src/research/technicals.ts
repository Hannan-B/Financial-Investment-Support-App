/**
 * Technical indicators, computed from stored prices.  PROJECT-PLAN.md §3, §11.7 step 2.2
 *
 * Arithmetic, not a website's opinion: every result comes with its WORKING —
 * the formula, the numbers that went into the last step, and what came out —
 * so it can be checked by hand. The tests hold each working to that: redo the
 * sum from the numbers shown, and you must land on the result shown.
 *
 * Conventions, where sites differ (checked against stockanalysis for SHEL.L
 * on 2026-10-05: RSI(14) 60.87 and SMA(50) 3,444.42, both matching):
 *   · closes as Yahoo publishes them — adjusted for splits, not dividends
 *   · EMA starts from the simple average of its first n closes
 *   · RSI and ATR use Wilder's smoothing, as he defined them; a plain average
 *     of the last 14 changes gives a very different RSI (48.04 vs 60.87 that day)
 *   · Bollinger bands use the population standard deviation (÷ n)
 *   · ATR's first true range needs a previous close, so it starts on day 2
 */
import type { PriceBar } from '../sources/yahoo.ts';

export interface Line {
  readonly label: string;
  readonly value: number;
}

export interface Working {
  /** 'RSI(14)' */
  readonly indicator: string;
  /** The trading day the result is for. */
  readonly date: string;
  /** The listing's currency for price-based indicators ('GBp' = pence); otherwise what the number is. */
  readonly unit: string;
  readonly formula: readonly string[];
  /** The numbers the last step used. */
  readonly inputs: readonly Line[];
  readonly result: readonly Line[];
  readonly notes: readonly string[];
}

export type Indicator<S> =
  | { readonly kind: 'ok'; readonly series: S; readonly working: Working }
  /** Not enough history yet — a new listing, or a long gap. Never a guess. */
  | { readonly kind: 'insufficient'; readonly indicator: string; readonly needed: number; readonly have: number };

/** One value per bar, aligned with the bars; null until there is enough history. */
export type Series = readonly (number | null)[];

export interface Prices {
  readonly currency: string;
  readonly bars: readonly PriceBar[];
}

const CLOSES_NOTE = 'Closing prices as Yahoo publishes them: adjusted for share splits, not for dividends.';

function period(name: string, n: number, min = 1): void {
  if (!Number.isInteger(n) || n < min) throw new RangeError(`${name} must be a whole number of at least ${min}, got ${n}`);
}

function insufficient<S>(indicator: string, needed: number, have: number): Indicator<S> {
  return { kind: 'insufficient', indicator, needed, have };
}

// ── the arithmetic ───────────────────────────────────────────────────────

function smaSeries(values: readonly number[], n: number): Series {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= n) sum -= values[i - n]!;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** EMA over `values`, seeded with the SMA of its first n values. */
function emaSeries(values: readonly number[], n: number): Series {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < n) return out;
  const alpha = 2 / (n + 1);
  let ema = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = ema;
  for (let i = n; i < values.length; i++) {
    ema = alpha * values[i]! + (1 - alpha) * ema;
    out[i] = ema;
  }
  return out;
}

const closes = (p: Prices) => p.bars.map((b) => b.close);
const last = <T>(xs: readonly T[]): T => xs[xs.length - 1]!;

// ── SMA ──────────────────────────────────────────────────────────────────

export function sma(p: Prices, n: number): Indicator<Series> {
  period('SMA period', n);
  const name = `SMA(${n})`;
  if (p.bars.length < n) return insufficient(name, n, p.bars.length);
  const series = smaSeries(closes(p), n);
  const window = p.bars.slice(-n);
  return {
    kind: 'ok', series,
    working: {
      indicator: name, date: last(p.bars).date, unit: p.currency,
      formula: [`SMA = sum of the last ${n} closes ÷ ${n}`],
      inputs: window.map((b) => ({ label: `close ${b.date}`, value: b.close })),
      result: [{ label: name, value: last(series)! }],
      notes: [CLOSES_NOTE],
    },
  };
}

// ── EMA ──────────────────────────────────────────────────────────────────

export function ema(p: Prices, n: number): Indicator<Series> {
  period('EMA period', n);
  const name = `EMA(${n})`;
  // n closes to start from, and one more for a step of the formula to show.
  if (p.bars.length < n + 1) return insufficient(name, n + 1, p.bars.length);
  const series = emaSeries(closes(p), n);
  const alpha = 2 / (n + 1);
  return {
    kind: 'ok', series,
    working: {
      indicator: name, date: last(p.bars).date, unit: p.currency,
      formula: [
        `α = 2 ÷ (${n} + 1)`,
        'EMA today = α × close today + (1 − α) × EMA yesterday',
      ],
      inputs: [
        { label: 'α', value: alpha },
        { label: `close ${last(p.bars).date}`, value: last(p.bars).close },
        { label: `EMA ${p.bars[p.bars.length - 2]!.date}`, value: series[series.length - 2]! },
      ],
      result: [{ label: name, value: last(series)! }],
      notes: [
        `Started on ${p.bars[n - 1]!.date} from the simple average of the first ${n} closes; every close since moves it.`,
        CLOSES_NOTE,
      ],
    },
  };
}

// ── RSI ──────────────────────────────────────────────────────────────────

export function rsi(p: Prices, n = 14): Indicator<Series> {
  period('RSI period', n);
  const name = `RSI(${n})`;
  // n changes to start from, plus one more for a step to show.
  if (p.bars.length < n + 2) return insufficient(name, n + 2, p.bars.length);
  const c = closes(p);
  const series: (number | null)[] = new Array(c.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= n; i++) {
    const change = c[i]! - c[i - 1]!;
    avgGain += Math.max(change, 0) / n;
    avgLoss += Math.max(-change, 0) / n;
  }
  const value = (g: number, l: number) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));
  series[n] = value(avgGain, avgLoss);
  let prevGain = avgGain;
  let prevLoss = avgLoss;
  for (let i = n + 1; i < c.length; i++) {
    const change = c[i]! - c[i - 1]!;
    prevGain = avgGain;
    prevLoss = avgLoss;
    avgGain = (avgGain * (n - 1) + Math.max(change, 0)) / n;
    avgLoss = (avgLoss * (n - 1) + Math.max(-change, 0)) / n;
    series[i] = value(avgGain, avgLoss);
  }
  const today = last(p.bars);
  const yesterday = p.bars[p.bars.length - 2]!;
  return {
    kind: 'ok', series,
    working: {
      indicator: name, date: today.date, unit: 'index, 0 to 100',
      formula: [
        'change = close today − close yesterday; a rise is a gain, a fall is a loss',
        `average gain = (average gain yesterday × ${n - 1} + gain today) ÷ ${n}`,
        `average loss = (average loss yesterday × ${n - 1} + loss today) ÷ ${n}`,
        'RS = average gain ÷ average loss',
        'RSI = 100 − 100 ÷ (1 + RS)',
      ],
      inputs: [
        { label: `close ${today.date}`, value: today.close },
        { label: `close ${yesterday.date}`, value: yesterday.close },
        { label: `average gain ${yesterday.date}`, value: prevGain },
        { label: `average loss ${yesterday.date}`, value: prevLoss },
      ],
      result: [
        { label: 'average gain', value: avgGain },
        { label: 'average loss', value: avgLoss },
        ...(avgLoss === 0 ? [] : [{ label: 'RS', value: avgGain / avgLoss }]),
        { label: name, value: last(series)! },
      ],
      notes: [
        `Wilder's smoothing, started on ${p.bars[n]!.date} from the simple average of the first ${n} changes.`,
        ...(avgLoss === 0 ? ['No losses in the averaging, so RSI is 100 by definition.'] : []),
        CLOSES_NOTE,
      ],
    },
  };
}

// ── MACD ─────────────────────────────────────────────────────────────────

export interface MacdSeries {
  readonly macd: Series;
  readonly signal: Series;
  readonly histogram: Series;
}

export function macd(p: Prices, fast = 12, slow = 26, signalPeriod = 9): Indicator<MacdSeries> {
  period('MACD fast period', fast);
  period('MACD slow period', slow);
  period('MACD signal period', signalPeriod);
  if (fast >= slow) throw new RangeError(`MACD fast period (${fast}) must be shorter than the slow (${slow})`);
  const name = `MACD(${fast}, ${slow}, ${signalPeriod})`;
  // The first signal needs slow + signal − 1 closes; one more shows a step.
  const needed = slow + signalPeriod;
  if (p.bars.length < needed) return insufficient(name, needed, p.bars.length);

  const c = closes(p);
  const emaFast = emaSeries(c, fast);
  const emaSlow = emaSeries(c, slow);
  const macdLine: (number | null)[] = c.map((_, i) => (emaSlow[i] == null ? null : emaFast[i]! - emaSlow[i]!));
  // The signal is an EMA of the MACD line, from where the line begins.
  const start = slow - 1;
  const signalTail = emaSeries(macdLine.slice(start) as number[], signalPeriod);
  const signal: (number | null)[] = [...new Array<null>(start).fill(null), ...signalTail];
  const histogram = macdLine.map((m, i) => (m == null || signal[i] == null ? null : m - signal[i]!));

  return {
    kind: 'ok', series: { macd: macdLine, signal, histogram },
    working: {
      indicator: name, date: last(p.bars).date, unit: p.currency,
      formula: [
        `MACD line = EMA(${fast}) − EMA(${slow}) of the closes`,
        `signal = EMA(${signalPeriod}) of the MACD line`,
        'histogram = MACD line − signal',
      ],
      inputs: [
        { label: `EMA(${fast})`, value: last(emaFast)! },
        { label: `EMA(${slow})`, value: last(emaSlow)! },
        { label: `signal ${p.bars[p.bars.length - 2]!.date}`, value: signal[signal.length - 2]! },
      ],
      result: [
        { label: 'MACD line', value: last(macdLine)! },
        { label: 'signal', value: last(signal)! },
        { label: 'histogram', value: last(histogram)! },
      ],
      notes: [
        `The signal's EMA uses α = 2 ÷ (${signalPeriod} + 1), stepping from the signal yesterday shown above.`,
        CLOSES_NOTE,
      ],
    },
  };
}

// ── Bollinger bands ──────────────────────────────────────────────────────

export interface BollingerSeries {
  readonly middle: Series;
  readonly upper: Series;
  readonly lower: Series;
}

export function bollinger(p: Prices, n = 20, k = 2): Indicator<BollingerSeries> {
  period('Bollinger period', n);
  if (!(Number.isFinite(k) && k > 0)) throw new RangeError(`Bollinger width must be above zero, got ${k}`);
  const name = `Bollinger(${n}, ${k})`;
  if (p.bars.length < n) return insufficient(name, n, p.bars.length);

  const c = closes(p);
  const middle = smaSeries(c, n);
  const sd = (i: number) => {
    const m = middle[i]!;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (c[j]! - m) ** 2;
    return Math.sqrt(s / n);
  };
  const upper = middle.map((m, i) => (m == null ? null : m + k * sd(i)));
  const lower = middle.map((m, i) => (m == null ? null : m - k * sd(i)));
  const i = c.length - 1;

  return {
    kind: 'ok', series: { middle, upper, lower },
    working: {
      indicator: name, date: last(p.bars).date, unit: p.currency,
      formula: [
        `middle = SMA(${n}) = sum of the last ${n} closes ÷ ${n}`,
        `SD = √( sum of (close − middle)² over the last ${n} closes ÷ ${n} )`,
        `upper = middle + ${k} × SD`,
        `lower = middle − ${k} × SD`,
      ],
      inputs: p.bars.slice(-n).map((b) => ({ label: `close ${b.date}`, value: b.close })),
      result: [
        { label: 'middle', value: middle[i]! },
        { label: 'SD', value: sd(i) },
        { label: 'upper', value: upper[i]! },
        { label: 'lower', value: lower[i]! },
      ],
      notes: ['Population standard deviation (÷ n), as Bollinger defined the bands.', CLOSES_NOTE],
    },
  };
}

// ── ATR ──────────────────────────────────────────────────────────────────

export function atr(p: Prices, n = 14): Indicator<Series> {
  period('ATR period', n);
  const name = `ATR(${n})`;
  const bars = p.bars;
  // Wilder's average runs through all history, so it starts after the last
  // day without a high or low — a gap cannot be smoothed over.
  let from = 0;
  for (let i = 0; i < bars.length; i++) if (bars[i]!.high == null || bars[i]!.low == null) from = i + 1;
  // A first day for the previous close, n ranges to start from, one more step to show.
  if (bars.length - from < n + 2) return insufficient(name, n + 2, bars.length - from);

  const series: (number | null)[] = new Array(bars.length).fill(null);
  const ranges = (i: number) => {
    const b = bars[i]!;
    const prevClose = bars[i - 1]!.close;
    return [b.high! - b.low!, Math.abs(b.high! - prevClose), Math.abs(b.low! - prevClose)] as const;
  };
  const tr = (i: number) => Math.max(...ranges(i));

  let value = 0;
  for (let i = from + 1; i <= from + n; i++) value += tr(i) / n;
  series[from + n] = value;
  let prev = value;
  for (let i = from + n + 1; i < bars.length; i++) {
    prev = value;
    value = (value * (n - 1) + tr(i)) / n;
    series[i] = value;
  }

  const t = bars.length - 1;
  const [hl, hc, lc] = ranges(t);
  return {
    kind: 'ok', series,
    working: {
      indicator: name, date: bars[t]!.date, unit: p.currency,
      formula: [
        'true range = the largest of: high − low, |high − close yesterday|, |low − close yesterday|',
        `ATR = (ATR yesterday × ${n - 1} + true range today) ÷ ${n}`,
      ],
      inputs: [
        { label: `high ${bars[t]!.date}`, value: bars[t]!.high! },
        { label: `low ${bars[t]!.date}`, value: bars[t]!.low! },
        { label: `close ${bars[t - 1]!.date}`, value: bars[t - 1]!.close },
        { label: `ATR ${bars[t - 1]!.date}`, value: prev },
      ],
      result: [
        { label: 'high − low', value: hl },
        { label: '|high − close yesterday|', value: hc },
        { label: '|low − close yesterday|', value: lc },
        { label: 'true range', value: tr(t) },
        { label: name, value },
      ],
      notes: [
        `Wilder's smoothing, started on ${bars[from + n]!.date} from the simple average of the first ${n} true ranges.`,
        'Highs and lows adjusted for share splits, as Yahoo publishes them.',
      ],
    },
  };
}

// ── all of them, with the periods in use ─────────────────────────────────

export interface IndicatorSettings {
  readonly sma: readonly number[];
  readonly ema: readonly number[];
  readonly rsi: number;
  readonly macd: { readonly fast: number; readonly slow: number; readonly signal: number };
  readonly bollinger: { readonly period: number; readonly width: number };
  readonly atr: number;
}

/** The usual periods. Changed in place on the chart, and remembered (§12.5). */
export const DEFAULT_SETTINGS: IndicatorSettings = {
  sma: [20, 50, 200],
  ema: [12, 26],
  rsi: 14,
  macd: { fast: 12, slow: 26, signal: 9 },
  bollinger: { period: 20, width: 2 },
  atr: 14,
};

export function indicators(p: Prices, s: IndicatorSettings = DEFAULT_SETTINGS) {
  return {
    sma: s.sma.map((n) => sma(p, n)),
    ema: s.ema.map((n) => ema(p, n)),
    rsi: rsi(p, s.rsi),
    macd: macd(p, s.macd.fast, s.macd.slow, s.macd.signal),
    bollinger: bollinger(p, s.bollinger.period, s.bollinger.width),
    atr: atr(p, s.atr),
  };
}
