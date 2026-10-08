/**
 * Refreshing one company: fetch, validate, and capture a snapshot.
 * PROJECT-PLAN.md §10.1, §11.7 step 2.4
 *
 * Core sources — prices, and the figures (EDGAR for US listings,
 * stockanalysis elsewhere):
 *   unavailable → the snapshot still saves, marked incomplete, the outage recorded
 *   suspect     → no snapshot at all: being lied to is worse than learning nothing
 * Optional sources — key statistics (Finviz for US listings, stockanalysis's
 * statistics page elsewhere, which also gives the dates), US results dates
 * (stockanalysis) and news:
 *   anything but ok → recorded against the snapshot; nothing else changes
 */
import type { Transport, HttpRequest, HttpResponse } from '../fetch/types.ts';
import { fetchSource } from '../fetch/record.ts';
import { yahooPrices } from '../sources/yahoo.ts';
import { savePrices, loadPrices } from './prices.ts';
import { indicators, type Indicator, type Working } from './technicals.ts';
import { findCik, edgarFigures, secExchange, type FiguresDeps } from './edgar.ts';
import { stockanalysisFigures } from './stockanalysis.ts';
import { finvizFigures } from './finviz.ts';
import { keyStatistics } from './statistics.ts';
import { usEarningsDate } from './calendar.ts';
import { isCurrency } from '../lib/money.ts';
import type { Fact, Gap, FiguresOutcome } from './figures.ts';
import { saveSnapshot, type Payload, type SourceOutcome } from './snapshot.ts';
import { DISPLAY_NAME } from './report.ts';
import { fetchNews } from './news.ts';

export type CompanyRefresh =
  | { readonly kind: 'saved'; readonly snapshotId: number; readonly complete: boolean;
      readonly sources: readonly SourceOutcome[]; readonly newPayloads: number }
  | { readonly kind: 'refused'; readonly reason: string; readonly sources: readonly SourceOutcome[] };

/** Keeps every successful response, so the snapshot can keep them raw. */
class Recorder implements Transport {
  readonly kept: Payload[] = [];
  readonly #inner: Transport;
  readonly #skip: ReadonlySet<string>;
  constructor(inner: Transport, skip: ReadonlySet<string>) { this.#inner = inner; this.#skip = skip; }
  async get(req: HttpRequest): Promise<HttpResponse> {
    const res = await this.#inner.get(req);
    if (res.status === 200 && !this.#skip.has(req.url)) this.kept.push({ url: req.url, body: res.body, contentType: res.contentType });
    return res;
  }
}

interface Listing {
  readonly isin: string;
  readonly name: string;
  readonly ticker: string;
  /** Yahoo's exchange code: 'NMS', 'NYQ', 'LSE'. */
  readonly exchange: string;
  readonly currency: string;
  readonly keys: Readonly<Record<string, string>>;
}

async function loadListing(deps: FiguresDeps, listingId: number): Promise<Listing> {
  const [row] = await deps.db.query(
    `SELECT l.isin, l.ticker, l.exchange, l.currency, ${DISPLAY_NAME} AS name FROM listing l JOIN security s ON s.isin = l.isin WHERE l.id = ?`,
    [listingId],
  );
  if (!row) throw new Error(`no listing ${listingId}`);
  const keys = Object.fromEntries((await deps.db.query(
    'SELECT source, source_key FROM listing_source_key WHERE listing_id = ?', [listingId],
  )).map((r) => [String(r['source']), String(r['source_key'])]));
  return {
    isin: String(row['isin']), name: String(row['name']), ticker: String(row['ticker']),
    exchange: String(row['exchange']), currency: String(row['currency']), keys,
  };
}

export async function refreshCompany(listingId: number, deps: FiguresDeps): Promise<CompanyRefresh> {
  const listing = await loadListing(deps, listingId);
  const capturedAt = (deps.now ?? (() => new Date()))().toISOString();
  const sources: SourceOutcome[] = [];
  const facts: Fact[] = [];
  const gaps: Gap[] = [];
  let complete = true;

  // Prices are kept as rows (§10.3④), so Yahoo's ten-year response is not also kept raw.
  const symbol = listing.keys['yahoo'];
  const recorder = new Recorder(deps.transport, new Set(symbol ? [yahooPrices.request(symbol).url] : []));
  const d: FiguresDeps = { ...deps, transport: recorder };

  // ── prices (core) ──
  if (!symbol) {
    complete = false;
    sources.push({ source: 'yahoo-prices', outcome: 'not-covered', detail: 'no Yahoo symbol recorded for this listing' });
  } else {
    const out = await fetchSource(yahooPrices, symbol, d);
    if (out.kind === 'suspect') {
      sources.push({ source: 'yahoo-prices', outcome: 'suspect', detail: `${out.failure.check}: ${out.failure.observed}` });
      return { kind: 'refused', reason: `Yahoo prices failed a check: ${out.failure.observed}`, sources };
    }
    if (out.kind === 'unavailable') {
      complete = false;
      sources.push({ source: 'yahoo-prices', outcome: 'unavailable', detail: out.reason });
    } else {
      try {
        await savePrices(deps.db, listingId, out.value);
      } catch (e) {
        // A different symbol or currency from the listing's: wrong, not missing.
        const reason = e instanceof Error ? e.message : String(e);
        sources.push({ source: 'yahoo-prices', outcome: 'suspect', detail: reason });
        return { kind: 'refused', reason, sources };
      }
      sources.push({ source: 'yahoo-prices', outcome: 'ok', detail: `${out.value.bars.length} days to ${out.value.bars.at(-1)?.date}` });
    }
  }
  const prices = await loadPrices(deps.db, listingId);
  if (prices) priceFacts(prices, facts, gaps);
  else gaps.push({ fieldPath: 'price.close', reason: 'no prices stored for this listing yet' });

  // ── figures (core) ──
  const sec = secExchange(listing.exchange);
  let figures: FiguresOutcome;
  let figuresSource: string;
  if (sec) {
    figuresSource = 'edgar';
    let cik = listing.keys['edgar'];
    let found: FiguresOutcome | null = null;
    if (!cik) {
      // EDGAR writes class shares with a dash, as Finviz does: BRK-B.
      const r = await findCik(listing.keys['finviz'] ?? listing.ticker, sec, d);
      if (r.kind === 'found') {
        cik = r.cik;
        // Looked up once; confirmed then, remembered after (§3).
        await deps.db.batch([
          { sql: 'INSERT INTO listing_source_key (listing_id, source, source_key) VALUES (?, ?, ?)', params: [listingId, 'edgar', cik] },
          { sql: 'UPDATE security SET cik = ? WHERE isin = ?', params: [cik, listing.isin] },
        ]);
      } else {
        found = r.kind === 'not-found' ? { kind: 'not-covered', reason: r.reason } : r;
      }
    }
    figures = found ?? await edgarFigures(cik!, listing.name, d);
  } else if (listing.keys['stockanalysis']) {
    figuresSource = 'stockanalysis';
    figures = await stockanalysisFigures(listing.keys['stockanalysis'], listing.name, d);
  } else {
    figuresSource = 'stockanalysis';
    figures = { kind: 'not-covered', reason: 'no stockanalysis page recorded for this listing' };
  }
  if (figures.kind === 'suspect') {
    sources.push({ source: figuresSource, outcome: 'suspect', detail: figures.reason });
    return { kind: 'refused', reason: figures.reason, sources };
  }
  if (figures.kind === 'ok') {
    facts.push(...figures.figures.facts);
    gaps.push(...figures.figures.gaps);
    sources.push({ source: figuresSource, outcome: 'ok', detail: null });
  } else {
    if (figures.kind === 'unavailable') complete = false;
    sources.push({ source: figuresSource, outcome: figures.kind, detail: figures.reason });
  }

  // ── key statistics (optional): Finviz for US listings, stockanalysis elsewhere (§11.7 step 2.7) ──
  const statistics = sec
    ? { source: 'finviz', outcome: await finvizFigures(listing.keys['finviz'] ?? listing.ticker, d) }
    : {
        source: 'stockanalysis-statistics',
        outcome: listing.keys['stockanalysis']
          ? await keyStatistics(listing.keys['stockanalysis'], listing.currency, d)
          : { kind: 'not-covered', reason: 'no stockanalysis page recorded for this listing' } as const,
      };
  if (statistics.outcome.kind === 'ok') {
    facts.push(...statistics.outcome.figures.facts);
    gaps.push(...statistics.outcome.figures.gaps);
  } else if (!sec) {
    // The dates come from the same page: say why they are missing.
    for (const fieldPath of ['calendar.next_earnings', 'calendar.last_ex_dividend']) {
      gaps.push({ fieldPath, reason: `dates unavailable: ${statistics.outcome.reason}` });
    }
  }
  // Recorded whatever happened, so the panel can say why it is empty (§6.1).
  sources.push({
    source: statistics.source, outcome: statistics.outcome.kind,
    detail: statistics.outcome.kind === 'ok' ? null : statistics.outcome.reason,
  });

  // ── US results dates (optional): Finviz gives only the last ──
  if (sec) {
    const symbol = listing.keys['stockanalysis'];
    const dates = symbol ? await usEarningsDate(symbol, d)
      : { kind: 'not-covered', reason: 'no stockanalysis page recorded for this listing' } as const;
    if (dates.kind === 'ok') {
      facts.push(...dates.figures.facts);
      gaps.push(...dates.figures.gaps);
    } else {
      gaps.push({ fieldPath: 'calendar.next_earnings', reason: `dates unavailable: ${dates.reason}` });
    }
    sources.push({ source: 'stockanalysis-calendar', outcome: dates.kind, detail: dates.kind === 'ok' ? null : dates.reason });
  }

  // ── news (optional) — kept as headline rows, so its responses are not also kept raw ──
  try {
    sources.push(...await fetchNews(listingId, deps));
  } catch (e) {
    sources.push({ source: 'news', outcome: 'unavailable', detail: e instanceof Error ? e.message : String(e) });
  }

  const saved = await saveSnapshot(deps.db, {
    isin: listing.isin, capturedAt, complete, facts, gaps, sources, payloads: recorder.kept,
  });
  return { kind: 'saved', snapshotId: saved.snapshotId, complete, sources, newPayloads: saved.newPayloads };
}

// ── price and indicator facts ────────────────────────────────────────────

function priceFacts(prices: { currency: string; bars: readonly { date: string; close: number }[] }, facts: Fact[], gaps: Gap[]): void {
  const last = prices.bars[prices.bars.length - 1]!;
  const currency = isCurrency(prices.currency) ? prices.currency : null;
  facts.push({
    fieldPath: 'price.close', period: null, periodEnd: null, value: last.close, unit: prices.currency, currency,
    kind: 'actual', source: 'yahoo', tier: 2, asOf: last.date, detail: `close on ${last.date}`,
  });

  const all = indicators(prices as Parameters<typeof indicators>[0]);
  const add = (r: Indicator<unknown>, path: string, pick?: string) => {
    if (r.kind === 'insufficient') {
      gaps.push({ fieldPath: path, reason: `${r.indicator} needs ${r.needed} days of prices; ${r.have} stored` });
      return;
    }
    const w: Working = r.working;
    const line = pick ? w.result.find((l) => l.label === pick)! : w.result[w.result.length - 1]!;
    const money = w.unit === prices.currency;
    facts.push({
      fieldPath: path, period: null, periodEnd: null, value: line.value,
      unit: money ? prices.currency : 'index', currency: money ? currency : null,
      kind: 'actual', source: 'computed', tier: 2, asOf: w.date, detail: `${w.indicator} ${line.label}, from Yahoo prices`,
    });
  };
  const id = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_$/, '');
  for (const r of [...all.sma, ...all.ema, all.rsi, all.atr]) {
    if (r.kind === 'ok') add(r, `technical.${id(r.working.indicator)}`);
    else add(r, `technical.${id(r.indicator)}`);
  }
  const macdName = all.macd.kind === 'ok' ? all.macd.working.indicator : all.macd.indicator;
  for (const [label, suffix] of [['MACD line', 'line'], ['signal', 'signal'], ['histogram', 'histogram']] as const) {
    add(all.macd, `technical.${id(macdName)}.${suffix}`, label);
  }
  const bbName = all.bollinger.kind === 'ok' ? all.bollinger.working.indicator : all.bollinger.indicator;
  for (const band of ['upper', 'middle', 'lower'] as const) add(all.bollinger, `technical.${id(bbName)}.${band}`, band);
}
