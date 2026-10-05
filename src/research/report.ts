/**
 * What a company report shows, read from stored data.  PROJECT-PLAN.md §6.1, §10.1
 *
 * Each panel is either shown or COLLAPSED TO ONE LINE WITH THE REASON (§6.1):
 * a London share's analyst predictions say "Finviz covers US listings only",
 * not nothing. A source that failed at the latest refresh shows its last good
 * data, marked stale with the date, rather than going blank (§10.1).
 */
import type { Db } from '../db/types.ts';
import { classifications } from '../portfolio/master.ts';
import { loadPrices, type StoredPrices } from './prices.ts';
import { CONCEPTS, CONCEPT_NAMES, type Concept, type Fact, type Gap } from './figures.ts';
import type { SourceOutcome, SourceOutcomeKind } from './snapshot.ts';
import { ANALYST_PREFIX } from './finviz.ts';

export interface ReportSummary {
  readonly listingId: number;
  readonly isin: string;
  readonly name: string;
  readonly ticker: string;
  /** Yahoo's exchange code: 'NMS', 'LSE'. */
  readonly exchange: string;
  /** The currency the price is quoted in — 'GBp' is pence. */
  readonly currency: string;
  readonly refreshedAt: string | null;
}

export interface Stale {
  /** When the data shown was captured. */
  readonly capturedAt: string;
  /** What went wrong at the latest refresh. */
  readonly why: string;
}

export type Panel<T> =
  | { readonly kind: 'ok'; readonly data: T; readonly stale: Stale | null }
  | { readonly kind: 'collapsed'; readonly reason: string };

export interface FigureRow {
  readonly concept: Concept;
  readonly name: string;
  /** One per period, oldest first; null where the year has no figure. */
  readonly cells: readonly (Fact | null)[];
}

export interface FiguresPanel {
  readonly source: string;
  readonly periods: readonly string[];
  readonly rows: readonly FigureRow[];
  readonly gaps: readonly Gap[];
}

export interface StatGroup {
  readonly title: string;
  readonly facts: readonly Fact[];
}

/** How the key statistics are grouped on the report, in order. */
export const STAT_GROUPS: readonly { readonly title: string; readonly paths: RegExp }[] = [
  { title: 'Valuation', paths: /^valuation\./ },
  { title: 'Last 12 months', paths: /^(ttm\.|calendar\.last_results$)/ },
  { title: 'Profitability', paths: /^profitability\./ },
  { title: 'Financial health', paths: /^health\./ },
  { title: 'Dividends', paths: /^(dividend\.|calendar\.last_ex_dividend$)/ },
  { title: 'Ownership and short interest', paths: /^(ownership|short)\./ },
  { title: 'Trading', paths: /^trading\./ },
  { title: 'Price performance', paths: /^performance\./ },
  { title: 'The company', paths: /^company\./ },
];

export interface ReportData {
  readonly summary: ReportSummary;
  readonly sector: string | null;
  readonly country: string | null;
  readonly prices: StoredPrices | null;
  readonly snapshot: {
    readonly id: number; readonly capturedAt: string; readonly complete: boolean; readonly sources: readonly SourceOutcome[];
  } | null;
  readonly figures: Panel<FiguresPanel>;
  /** Other people's forecasts — shown under their own heading, never among the facts. */
  readonly predictions: Panel<readonly Fact[]>;
  /** Everything else Finviz shows, in groups: valuation, health, ownership, … */
  readonly keyStats: Panel<readonly StatGroup[]>;
  readonly calendar: Panel<{ readonly facts: readonly Fact[]; readonly gaps: readonly Gap[] }>;
}

/**
 * Trading 212's name for the company ('Apple') before a fund file's
 * ('APPLE INC USD0.00001'), which is what the master holds for companies
 * first seen inside a fund.
 */
export const DISPLAY_NAME = `coalesce((SELECT min(i.name) FROM instrument i WHERE i.isin = s.isin AND i.type = 'STOCK'), s.name)`;

const SUMMARY_SQL = `
  SELECT l.id, l.isin, l.ticker, l.exchange, l.currency, ${DISPLAY_NAME} AS name, r.last_refreshed_at
  FROM listing l
  JOIN listing_source_key k ON k.listing_id = l.id AND k.source = 'yahoo'
  JOIN security s ON s.isin = l.isin
  LEFT JOIN report r ON r.isin = l.isin`;

function summaryOf(r: Readonly<Record<string, unknown>>): ReportSummary {
  return {
    listingId: Number(r['id']), isin: String(r['isin']), name: String(r['name']), ticker: String(r['ticker']),
    exchange: String(r['exchange']), currency: String(r['currency']), refreshedAt: (r['last_refreshed_at'] as string | null) ?? null,
  };
}

/** Every company opened for research, most recently refreshed first. */
export async function listReports(db: Db): Promise<ReportSummary[]> {
  const rows = await db.query(`${SUMMARY_SQL} ORDER BY r.last_refreshed_at IS NULL, r.last_refreshed_at DESC, name`);
  return rows.map(summaryOf);
}

function factOf(r: Readonly<Record<string, unknown>>): Fact {
  return {
    fieldPath: String(r['field_path']),
    period: (r['period'] as string | null) ?? null,
    periodEnd: (r['period_end'] as string | null) ?? null,
    value: r['value_num'] != null ? Number(r['value_num']) : String(r['value_text']),
    unit: String(r['unit'] ?? ''),
    currency: (r['currency'] as Fact['currency']) ?? null,
    kind: r['kind'] === 'estimate' ? 'estimate' : 'actual',
    source: String(r['source']),
    tier: Number(r['tier']) as Fact['tier'],
    asOf: String(r['as_of']),
    detail: String(r['detail'] ?? ''),
  };
}

export async function loadReport(db: Db, listingId: number): Promise<ReportData | null> {
  const [row] = await db.query(`${SUMMARY_SQL} WHERE l.id = ?`, [listingId]);
  if (!row) return null;
  const summary = summaryOf(row);
  const labels = (await classifications(db)).get(summary.isin);
  const prices = await loadPrices(db, listingId);

  const snapshots = (await db.query(
    `SELECT s.id, s.captured_at, s.complete FROM snapshot s JOIN report r ON r.id = s.report_id
     WHERE r.isin = ? ORDER BY s.captured_at DESC`, [summary.isin],
  )).map((s) => ({ id: Number(s['id']), capturedAt: String(s['captured_at']), complete: Number(s['complete']) === 1 }));
  const latest = snapshots[0];

  const base = { summary, sector: labels?.sector?.label ?? null, country: labels?.country?.label ?? null, prices };
  if (!latest) {
    const never = { kind: 'collapsed', reason: 'Not refreshed yet — press Refresh' } as const;
    return { ...base, snapshot: null, figures: never, predictions: never, keyStats: never, calendar: never };
  }

  const outcomes = async (id: number) => (await db.query(
    'SELECT source, outcome, detail FROM snapshot_source WHERE snapshot_id = ? ORDER BY rowid', [id],
  )).map((o) => ({ source: String(o['source']), outcome: o['outcome'] as SourceOutcomeKind, detail: (o['detail'] as string | null) ?? null }));
  const latestSources = await outcomes(latest.id);
  const facts = async (id: number) => (await db.query('SELECT * FROM fact WHERE snapshot_id = ? ORDER BY id', [id])).map(factOf);
  const gaps = async (id: number): Promise<Gap[]> => (await db.query(
    'SELECT field_path, reason FROM snapshot_gap WHERE snapshot_id = ?', [id],
  )).map((g) => ({ fieldPath: String(g['field_path']), reason: String(g['reason']) }));

  /** The newest snapshot in which `source` answered properly — the latest, or the last good one, marked stale. */
  async function fromSource<T>(source: string, build: (snapshotId: number) => Promise<T | null>, emptyReason: string): Promise<Panel<T>> {
    const now = latestSources.find((o) => o.source === source);
    if (!now) return { kind: 'collapsed', reason: `${source} was not read at the last refresh` };
    if (now.outcome === 'not-covered') return { kind: 'collapsed', reason: now.detail ?? `${source} does not cover this company` };
    for (const s of snapshots) {
      const o = s.id === latest!.id ? now : (await outcomes(s.id)).find((x) => x.source === source);
      if (o?.outcome !== 'ok') continue;
      const data = await build(s.id);
      if (data === null) return { kind: 'collapsed', reason: emptyReason };
      const stale = s.id === latest!.id ? null : { capturedAt: s.capturedAt, why: `${now.outcome}: ${now.detail ?? ''}`.trim() };
      return { kind: 'ok', data, stale };
    }
    return { kind: 'collapsed', reason: `${source} ${now.outcome === 'suspect' ? 'gave data that failed its checks' : 'has not answered'}: ${now.detail ?? ''}`.trim() };
  }

  const figuresSource = latestSources.find((o) => o.source === 'edgar' || o.source === 'stockanalysis')?.source ?? 'edgar';
  const figures = await fromSource<FiguresPanel>(figuresSource, async (id) => {
    const all = (await facts(id)).filter((f) => f.source === figuresSource && f.period !== null);
    if (all.length === 0) return null;
    const periods = [...new Set(all.map((f) => f.period!))].sort();
    const rows = (Object.keys(CONCEPTS) as Concept[]).map((concept) => ({
      concept,
      name: CONCEPT_NAMES[concept],
      cells: periods.map((p) => all.find((f) => f.fieldPath === CONCEPTS[concept] && f.period === p) ?? null),
    }));
    const figureGaps = (await gaps(id)).filter((g) => /^(income|balance|cashflow)\./.test(g.fieldPath));
    return { source: figuresSource, periods, rows, gaps: figureGaps };
  }, 'no figures in the last good refresh');

  const finvizFacts = (prefix: (path: string) => boolean) => async (id: number) => {
    const list = (await facts(id)).filter((f) => f.source === 'finviz' && prefix(f.fieldPath));
    return list.length ? list : null;
  };
  const predictions = await fromSource('finviz', finvizFacts((p) => p.startsWith(ANALYST_PREFIX)), 'Finviz shows no analyst predictions for this company');
  const keyStats = await fromSource<readonly StatGroup[]>('finviz', async (id) => {
    const list = (await facts(id)).filter((f) => f.source === 'finviz' && !f.fieldPath.startsWith(ANALYST_PREFIX));
    const groups = STAT_GROUPS.map((g) => ({ title: g.title, facts: list.filter((f) => g.paths.test(f.fieldPath)) }))
      .filter((g) => g.facts.length > 0);
    return groups.length ? groups : null;
  }, 'Finviz shows no statistics for this company');

  const latestFacts = (await facts(latest.id)).filter((f) => f.fieldPath.startsWith('calendar.'));
  const calendarGaps = (await gaps(latest.id)).filter((g) => g.fieldPath.startsWith('calendar.'));
  if (figuresSource === 'edgar' && !latestFacts.some((f) => f.fieldPath === 'calendar.next_earnings')) {
    calendarGaps.push({ fieldPath: 'calendar.next_earnings', reason: 'US earnings dates arrive with the Nasdaq calendar, not yet built' });
  }
  const calendar: Panel<{ facts: readonly Fact[]; gaps: readonly Gap[] }> = latestFacts.length || calendarGaps.length
    ? { kind: 'ok', data: { facts: latestFacts, gaps: calendarGaps }, stale: null }
    : { kind: 'collapsed', reason: 'No dates at the last refresh' };

  return {
    ...base,
    snapshot: { ...latest, sources: latestSources },
    figures, predictions, keyStats, calendar,
  };
}
