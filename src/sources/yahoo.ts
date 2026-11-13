/**
 * Yahoo Finance daily prices.  PROJECT-PLAN.md §3, §11.7 step 2.1
 *
 * Keyed by Yahoo's own symbol: 'AAPL', 'SHEL.L', 'SAP.DE'. Ten years of daily
 * bars in one request, no key. The whole range is fetched every time: Yahoo's
 * closes are split-adjusted, so a split rewrites the entire history, and one
 * request a day per company is negligible (§10.2).
 *
 * 🔄 Read from Yahoo's ordinary history page since 2026-11-13 (decided then;
 *    plan appendix, *Phase 5*). Its data address
 *    (query1.finance.yahoo.com) is `Disallow: /` in robots.txt; the page
 *    (finance.yahoo.com/quote/…/history/) is allowed, and carries that same
 *    chart response inside it, so the reading below is unchanged.
 *
 * ⚠️ London quotes in PENCE. Yahoo says so ('GBp'); the currency is taken from
 *    the response, never assumed from the exchange (§7④).
 * ⚠️ During trading hours the last bar is today's price so far, not a close.
 *    It is dropped until the session has ended.
 */
import type { Check, Source } from '../fetch/types.ts';
import { asOfWithinDays } from '../fetch/checks.ts';
import { isCurrency, type Currency } from '../lib/money.ts';

export interface PriceBar {
  /** The trading day, in the exchange's own time zone. */
  readonly date: string;
  readonly open: number | null;
  readonly high: number | null;
  readonly low: number | null;
  readonly close: number;
  /** Adjusted for dividends as well as splits. */
  readonly adjClose: number | null;
  readonly volume: number | null;
}

export interface PriceHistory {
  /** The symbol Yahoo answered for — compared with the one asked for when storing. */
  readonly symbol: string;
  readonly currency: Currency;
  /** Yahoo's exchange code: 'NMS', 'LSE', 'GER'. */
  readonly exchange: string;
  readonly bars: readonly PriceBar[];
}

interface Meta {
  symbol?: unknown;
  currency?: unknown;
  exchangeName?: unknown;
  exchangeTimezoneName?: unknown;
  regularMarketTime?: unknown;
  currentTradingPeriod?: { regular?: { start?: unknown; end?: unknown } };
}

interface Result {
  meta?: Meta;
  timestamp?: unknown;
  indicators?: {
    quote?: Array<Record<'open' | 'high' | 'low' | 'close' | 'volume', unknown>>;
    adjclose?: Array<{ adjclose?: unknown }>;
  };
}

/** A timestamp as a calendar date where the exchange is, not where the user is. */
export function exchangeDate(epochSeconds: number, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(epochSeconds * 1000));
}

function column(values: unknown, length: number, name: string): (number | null)[] {
  if (!Array.isArray(values) || values.length !== length) {
    throw new Error(`${name}: expected ${length} values, got ${Array.isArray(values) ? values.length : typeof values}`);
  }
  return values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
}

export function parseChart(body: Uint8Array): PriceHistory {
  const json = JSON.parse(new TextDecoder().decode(body)) as { chart?: { result?: unknown; error?: unknown } };
  const result = (Array.isArray(json.chart?.result) ? json.chart.result[0] : undefined) as Result | undefined;
  if (!result?.meta) throw new Error(`no chart result: ${JSON.stringify(json.chart?.error ?? null).slice(0, 200)}`);
  const meta = result.meta;

  if (typeof meta.symbol !== 'string') throw new Error('no symbol in the response');
  if (!isCurrency(meta.currency)) throw new Error(`unrecognised currency: ${JSON.stringify(meta.currency)}`);
  if (typeof meta.exchangeName !== 'string') throw new Error('no exchange in the response');
  if (typeof meta.exchangeTimezoneName !== 'string') throw new Error('no exchange time zone in the response');

  const timestamps = result.timestamp;
  if (!Array.isArray(timestamps) || !timestamps.every((t) => typeof t === 'number')) {
    throw new Error('no timestamp array in the response');
  }
  const n = timestamps.length;
  const quote = result.indicators?.quote?.[0];
  if (!quote) throw new Error('no quote block in the response');
  const open = column(quote.open, n, 'open');
  const high = column(quote.high, n, 'high');
  const low = column(quote.low, n, 'low');
  const close = column(quote.close, n, 'close');
  const volume = column(quote.volume, n, 'volume');
  const adj = result.indicators?.adjclose?.[0]?.adjclose;
  const adjClose = adj === undefined ? new Array<null>(n).fill(null) : column(adj, n, 'adjclose');

  // Is the latest session still trading? Then its bar is not a close yet.
  const session = meta.currentTradingPeriod?.regular;
  const live = typeof session?.start === 'number' && typeof session.end === 'number'
    && typeof meta.regularMarketTime === 'number' && meta.regularMarketTime < session.end;
  const liveDate = live ? exchangeDate(session.start as number, meta.exchangeTimezoneName) : null;

  const bars: PriceBar[] = [];
  for (let i = 0; i < n; i++) {
    const c = close[i];
    // Yahoo pads holidays and suspended days with nulls: no trade, no bar.
    if (c == null) continue;
    const date = exchangeDate(timestamps[i] as number, meta.exchangeTimezoneName);
    if (date === liveDate) continue;
    bars.push({
      date, close: c, open: open[i] ?? null, high: high[i] ?? null, low: low[i] ?? null,
      adjClose: adjClose[i] ?? null, volume: volume[i] ?? null,
    });
  }
  return { symbol: meta.symbol, currency: meta.currency, exchange: meta.exchangeName, bars };
}

/**
 * The chart response the history page carries for its own chart: a
 * `<script type="application/json" data-sveltekit-fetched
 * data-url="https://query1.finance.yahoo.com/v8/finance/chart/AAPL?…">` holding
 * `{"status":200,…,"body":"<the chart JSON as a string>"}`. Exactly one such
 * block is expected; none (a changed page, or a consent page in its place) or
 * several (which one is ours?) is refused rather than guessed at.
 */
export function chartFromPage(body: Uint8Array): Uint8Array {
  const html = new TextDecoder().decode(body);
  const blocks: string[] = [];
  const open = /<script\b[^>]*\bdata-url="([^"]*)"[^>]*>/g;
  for (let m = open.exec(html); m; m = open.exec(html)) {
    const url = m[1]!.replace(/&amp;/g, '&');
    if (!/^https:\/\/query\d\.finance\.yahoo\.com\/v8\/finance\/chart\//.test(url)) continue;
    const end = html.indexOf('</script>', m.index + m[0].length);
    if (end < 0) throw new Error('the price data on the page is cut short');
    blocks.push(html.slice(m.index + m[0].length, end));
  }
  if (blocks.length === 0) throw new Error('the history page carries no price data (the page has changed, or it is not the history page)');
  if (blocks.length > 1) throw new Error(`the history page carries ${blocks.length} sets of price data, not one`);
  const wrapper = JSON.parse(blocks[0]!) as { status?: unknown; body?: unknown };
  if (wrapper.status !== 200) throw new Error(`the page's price data says status ${JSON.stringify(wrapper.status)}`);
  if (typeof wrapper.body !== 'string') throw new Error('the page\'s price data has no body');
  return new TextEncoder().encode(wrapper.body);
}

/**
 * The page for ten years to the end of the refresh's day (UTC). Fixed for the
 * whole day, so a day's refreshes ask the same address.
 */
export function historyUrl(symbol: string, at: Date): string {
  const y = at.getUTCFullYear(), m = at.getUTCMonth(), d = at.getUTCDate();
  const end = Date.UTC(y, m, d + 1) / 1000;
  const start = Date.UTC(y - 10, m, d + 1) / 1000;
  return `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/history/?period1=${start}&period2=${end}`;
}

// ── checks ───────────────────────────────────────────────────────────────

const someBars: Check<PriceHistory> = {
  name: 'bar-count',
  run: (h) => (h.bars.length > 0 ? null
    : { check: 'bar-count', expected: 'at least one daily bar', observed: 'none' }),
};

const datesAscending: Check<PriceHistory> = {
  name: 'dates-ascending',
  run(h) {
    for (let i = 1; i < h.bars.length; i++) {
      if (h.bars[i]!.date <= h.bars[i - 1]!.date) {
        return {
          check: 'dates-ascending',
          expected: 'one bar per day, oldest first',
          observed: `${h.bars[i]!.date} follows ${h.bars[i - 1]!.date}`,
        };
      }
    }
    return null;
  },
};

const positiveCloses: Check<PriceHistory> = {
  name: 'positive-closes',
  run(h) {
    const bad = h.bars.find((b) => b.close <= 0);
    return bad ? { check: 'positive-closes', expected: 'every close above zero', observed: `${bad.close} on ${bad.date}` } : null;
  },
};

/**
 * The pence/pounds trap, inside the data itself: a London price that switches
 * between pence and pounds partway through shows as a 100× step. No real
 * share moves 20× in a day once splits are adjusted for, so treat it as
 * breakage rather than store a history with a silent 100× error in it (§7④).
 */
const MAX_DAILY_FACTOR = 20;
const noUnitJumps: Check<PriceHistory> = {
  name: 'no-unit-jumps',
  run(h) {
    for (let i = 1; i < h.bars.length; i++) {
      const ratio = h.bars[i]!.close / h.bars[i - 1]!.close;
      if (ratio > MAX_DAILY_FACTOR || ratio < 1 / MAX_DAILY_FACTOR) {
        return {
          check: 'no-unit-jumps',
          expected: `no day-to-day move larger than ${MAX_DAILY_FACTOR}×`,
          observed: `${h.bars[i - 1]!.close} on ${h.bars[i - 1]!.date} → ${h.bars[i]!.close} on ${h.bars[i]!.date}`,
        };
      }
    }
    return null;
  },
};

export function makeYahooPrices(now?: () => Date): Source<PriceHistory> {
  return {
    id: 'yahoo-prices',
    core: true,
    request: (symbol) => ({ url: historyUrl(symbol, (now ?? (() => new Date()))()) }),
    parse: (res) => parseChart(chartFromPage(res.body)),
    checks: [
      someBars,
      datesAscending,
      positiveCloses,
      noUnitJumps,
      // Ten days covers long holiday closures; older means a frozen feed or a delisting.
      asOfWithinDays((h) => (h.bars.length ? new Date(`${h.bars[h.bars.length - 1]!.date}T00:00:00Z`) : null), 10, now),
    ],
  };
}

// No ready-made instance: the address depends on the day, so every caller
// passes the refresh's own clock (makeYahooPrices(deps.now)).
