/**
 * A US company's figures from its own SEC filings.  PROJECT-PLAN.md §3, §11.7 step 2.3
 *
 * 1. Find the SEC number: EDGAR's search box, Wikidata if that misses — and
 *    either way confirmed against the SEC's own record of the company's
 *    tickers and exchanges (§7.2). A near match is a miss.
 * 2. Read each figure under its candidate tags, in priority order. A company
 *    can change tag over the years (Apple: SalesRevenueNet → Revenues →
 *    RevenueFromContractWithCustomer…), so earlier tags fill each year first
 *    and later tags only the years still empty.
 * 3. Keep the last ten fiscal years. A figure under none of its tags is a GAP:
 *    Walmart files no GrossProfit, and the report says so (§3).
 */
import type { FetchDeps } from '../fetch/record.ts';
import { fetchSource } from '../fetch/record.ts';
import { edgarSearch, edgarSubmissions, edgarConcept, type EdgarFact } from '../sources/edgar.ts';
import { wikidataCik } from '../sources/wikidata.ts';
import { isCurrency, type Currency } from '../lib/money.ts';
import { CONCEPTS, CONCEPT_NAMES, type Concept, type Fact, type Gap, type FiguresOutcome } from './figures.ts';

export interface FiguresDeps extends FetchDeps {
  /** Waits between requests. Tests pass a no-op. */
  readonly pause?: (ms: number) => Promise<void>;
}

/** SEC's fair-access limit is ten requests a second; stay well under it. */
const PACE_MS = 150;

/**
 * Candidate tags, first choice first.
 *
 * ⚠️ Revenue starts with `Revenues`, the TOTAL, not the narrower revenue-from-
 *    contracts tag the plan first listed: Walmart files both, and the narrower
 *    one is net sales without membership income ($706.4B against total
 *    revenues of $713.2B, FY2026). Apple, Microsoft and NVIDIA file identical
 *    values under both wherever both exist (checked 2026-10-05).
 */
export const TAGS: Readonly<Record<Exclude<Concept, 'ebitda'>, readonly string[]>> = {
  revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax',
    'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet', 'SalesRevenueGoodsNet'],
  gross_profit: ['GrossProfit'],
  operating_income: ['OperatingIncomeLoss'],
  net_income: ['NetIncomeLoss', 'ProfitLoss'],
  eps: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'],
  total_assets: ['Assets'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  operating_cash_flow: ['NetCashProvidedByUsedInOperatingActivities',
    'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
};

/**
 * EBITDA is not an accounting figure, so no company files it: it is worked out
 * as operating income + depreciation and amortisation, and says so. The
 * depreciation tag changes over the years too (Walmart, around 2019); the
 * fullest first — Apple's `DepreciationAndAmortization` is only part of it.
 */
export const DEPRECIATION_TAGS = ['DepreciationDepletionAndAmortization', 'DepreciationAmortizationAndAccretionNet',
  'DepreciationAndAmortization'] as const;

/** Balances at a date, rather than totals over a year. */
const BALANCES: ReadonlySet<Concept> = new Set(['total_assets', 'equity']);

const YEARS = 10;

/** Yahoo's exchange codes as the SEC names the exchanges. */
const SEC_EXCHANGE: Readonly<Record<string, string>> = {
  NMS: 'Nasdaq', NGM: 'Nasdaq', NCM: 'Nasdaq', NAS: 'Nasdaq', NYQ: 'NYSE',
};
export function secExchange(yahooExchange: string): string | null {
  return SEC_EXCHANGE[yahooExchange] ?? null;
}

// ── 1. which company ─────────────────────────────────────────────────────

export type CikResult =
  | { readonly kind: 'found'; readonly cik: string; readonly name: string; readonly via: 'edgar-search' | 'wikidata' }
  | { readonly kind: 'not-found'; readonly reason: string }
  | { readonly kind: 'unavailable' | 'suspect'; readonly reason: string };

/** The SEC number for a ticker on a US exchange ('Nasdaq', 'NYSE'), confirmed. */
export async function findCik(ticker: string, exchange: string, deps: FiguresDeps): Promise<CikResult> {
  const t = ticker.toUpperCase();
  const pause = deps.pause ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const search = await fetchSource(edgarSearch, t, deps);
  if (search.kind !== 'ok') return { kind: search.kind, reason: `EDGAR search: ${describe(search)}` };
  let candidates = search.value.filter((h) => h.tickers.includes(t)).map((h) => h.cik);
  let via: 'edgar-search' | 'wikidata' = 'edgar-search';

  if (candidates.length === 0) {
    const wd = await fetchSource(wikidataCik, t, deps);
    if (wd.kind === 'ok') { candidates = wd.value; via = 'wikidata'; }
  }

  const tried: string[] = [];
  for (const cik of candidates.slice(0, 3)) {
    await pause(PACE_MS);
    const company = await fetchSource(edgarSubmissions, cik, deps);
    if (company.kind !== 'ok') return { kind: company.kind, reason: `EDGAR company details: ${describe(company)}` };
    const at = company.value.tickers.indexOf(t);
    const listedOn = at >= 0 ? company.value.exchanges[at]! : null;
    if (listedOn !== null && listedOn.toLowerCase() === exchange.toLowerCase()) {
      return { kind: 'found', cik: company.value.cik, name: company.value.name, via };
    }
    tried.push(`${company.value.name} (${cik}) lists ${t} ${listedOn ? `on ${listedOn}` : 'nowhere'}`);
  }
  return {
    kind: 'not-found',
    reason: candidates.length === 0
      ? `no SEC filer lists the ticker ${t}`
      : `no SEC filer lists ${t} on ${exchange}: ${tried.join('; ')}`,
  };
}

function describe(out: { kind: string; reason?: string; failure?: { check: string; observed: string } }): string {
  return out.kind === 'unavailable' ? out.reason! : `${out.failure!.check}: ${out.failure!.observed}`;
}

// ── 2. the figures ───────────────────────────────────────────────────────

const days = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / 86_400_000;

/** 'USD' → USD; 'USD/shares' (per-share figures) → USD; 'pure', 'shares' → not money. */
function currencyOf(unit: string): Currency | null {
  const c = unit.replace(/\/shares$/, '');
  return isCurrency(c) ? c : null;
}
const unitOf = (unit: string) => unit.endsWith('/shares') ? `${unit.replace(/\/shares$/, '')}/share` : unit;

/**
 * The annual values in a tag's filings, by period end: annual reports only,
 * a year long for durations, the most recently filed value for each period
 * (a later report can restate an earlier year).
 */
function annual(facts: readonly EdgarFact[], balance: boolean): Map<string, EdgarFact> {
  const out = new Map<string, EdgarFact>();
  for (const f of facts) {
    if ((f.form !== '10-K' && f.form !== '10-K/A') || f.fp !== 'FY' || currencyOf(f.unit) === null) continue;
    if (balance ? f.start !== null : f.start === null || days(f.start, f.end) < 350 || days(f.start, f.end) > 380) continue;
    const seen = out.get(f.end);
    if (!seen || f.filed > seen.filed) out.set(f.end, f);
  }
  return out;
}

/**
 * Which fiscal year a period end belongs to. Each filing says its own fiscal
 * year (`fy`) — but every value inside it carries that year, comparatives
 * included, so the year is read from each filing's LATEST period, and the
 * company's habit (Walmart: the year ending January 2026 is FY2026; some
 * retailers call the year ending February 2025 FY2024) applied to the rest.
 */
function fiscalYearLabeller(all: readonly EdgarFact[]): (end: string) => string {
  const latest = new Map<string, EdgarFact>();
  for (const f of all) {
    if (f.fy === null || f.fp !== 'FY') continue;
    const seen = latest.get(f.accn);
    if (!seen || f.end > seen.end) latest.set(f.accn, f);
  }
  const offsets = new Map<number, number>();
  for (const f of latest.values()) {
    const offset = f.fy! - Number(f.end.slice(0, 4));
    offsets.set(offset, (offsets.get(offset) ?? 0) + 1);
  }
  const offset = [...offsets.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  return (end) => `FY${Number(end.slice(0, 4)) + offset}`;
}

/** Ten fiscal years of the seven figures for one company, with a gap for anything not filed. */
export async function edgarFigures(cik: string, companyName: string, deps: FiguresDeps): Promise<FiguresOutcome> {
  const pause = deps.pause ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const read = new Map<Concept | 'depreciation', { tag: string; facts: readonly EdgarFact[] }[]>();
  const wanted: [Concept | 'depreciation', readonly string[]][] = [
    ...(Object.entries(TAGS) as [Concept, readonly string[]][]), ['depreciation', DEPRECIATION_TAGS],
  ];

  for (const [concept, tags] of wanted) {
    const found: { tag: string; facts: readonly EdgarFact[] }[] = [];
    for (const tag of tags) {
      await pause(PACE_MS);
      const out = await fetchSource(edgarConcept, `${cik}:${tag}`, deps);
      if (out.kind === 'ok') found.push({ tag, facts: out.value.facts });
      else if (out.kind === 'unavailable' && out.response?.status === 404) continue; // never filed under this tag
      else return { kind: out.kind, reason: `EDGAR ${tag}: ${describe(out)}` };
    }
    read.set(concept, found);
  }

  const everything = [...read.values()].flat().flatMap((r) => r.facts);
  const label = fiscalYearLabeller(everything);

  // Year ends come from the year-long figures; balances count only on those dates.
  const yearEnds = new Set<string>();
  for (const [concept, found] of read) {
    if (concept === 'depreciation' || BALANCES.has(concept)) continue;
    for (const { facts } of found) for (const end of annual(facts, false).keys()) yearEnds.add(end);
  }
  const kept = new Set([...yearEnds].sort().slice(-YEARS));

  // Each year from the first tag that has it (§3).
  const yearly = new Map<Concept | 'depreciation', Map<string, { tag: string; fact: EdgarFact }>>();
  for (const [concept, found] of read) {
    const byEnd = new Map<string, { tag: string; fact: EdgarFact }>();
    for (const { tag, facts: tagFacts } of found) {
      for (const [end, fact] of annual(tagFacts, concept !== 'depreciation' && BALANCES.has(concept))) {
        if (kept.has(end) && !byEnd.has(end)) byEnd.set(end, { tag, fact });
      }
    }
    yearly.set(concept, byEnd);
  }

  const facts: Fact[] = [];
  const gaps: Gap[] = [];
  const fact = (concept: Concept, end: string, value: number, f: EdgarFact, detail: string): Fact => ({
    fieldPath: CONCEPTS[concept], period: label(end), periodEnd: end, value,
    unit: unitOf(f.unit), currency: currencyOf(f.unit), kind: 'actual', source: 'edgar', tier: 1, asOf: f.filed, detail,
  });
  for (const concept of Object.keys(CONCEPTS) as Concept[]) {
    if (concept === 'ebitda') {
      const opInc = yearly.get('operating_income')!;
      const dep = yearly.get('depreciation')!;
      const ends = [...opInc.keys()].filter((e) => dep.has(e)).sort();
      if (ends.length === 0) {
        gaps.push({ fieldPath: CONCEPTS.ebitda, reason: `${companyName} files no operating income and depreciation for the same years, so EBITDA cannot be worked out` });
      }
      for (const end of ends) {
        const o = opInc.get(end)!, d = dep.get(end)!;
        if (currencyOf(o.fact.unit) !== currencyOf(d.fact.unit)) continue;
        facts.push(fact('ebitda', end, o.fact.value + d.fact.value, o.fact.filed >= d.fact.filed ? o.fact : d.fact,
          `worked out: operating income (us-gaap:${o.tag}) ${o.fact.value} + depreciation and amortisation (us-gaap:${d.tag}) ${d.fact.value}`));
      }
      continue;
    }
    const byEnd = yearly.get(concept)!;
    if (byEnd.size === 0) {
      gaps.push({
        fieldPath: CONCEPTS[concept],
        reason: `${companyName} files no annual ${CONCEPT_NAMES[concept].toLowerCase()} under ${TAGS[concept].join(' or ')}`,
      });
      continue;
    }
    for (const [end, { tag, fact: f }] of [...byEnd].sort(([a], [b]) => a.localeCompare(b))) {
      facts.push(fact(concept, end, f.value, f, `us-gaap:${tag}, ${f.form} filed ${f.filed}`));
    }
  }
  return { kind: 'ok', figures: { source: 'edgar', facts, gaps } };
}
