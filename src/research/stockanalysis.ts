/**
 * A London or European company's figures from stockanalysis.com.
 * PROJECT-PLAN.md §3, §11.7 step 2.3
 *
 * Three statement pages for the seven figures (about five years). The dates
 * come with the key statistics (research/calendar.ts): the overview page
 * read here until October 2026 could not tell the next results from the last.
 *
 * ⚠️ The latest-quarter column ('TTM') is never mixed into the annual series:
 *    that is the fiscal-year seam of §3. Vodafone's FY2026 and its TTM column
 *    even share a fiscal year, so the column is recognised by its marker.
 */
import { fetchSource } from '../fetch/record.ts';
import { statement, siteUid, type StatementName, type StatementPage } from '../sources/stockanalysis.ts';
import { CONCEPTS, CONCEPT_NAMES, type Concept, type Fact, type Gap, type FiguresOutcome } from './figures.ts';
import type { FiguresDeps } from './edgar.ts';

/** Where each figure sits. Net income and equity are the shareholders' share, as in SEC filings. */
const ROWS: Readonly<Record<Concept, { statement: StatementName; row: string }>> = {
  revenue: { statement: 'income-statement', row: 'revenue' },
  gross_profit: { statement: 'income-statement', row: 'gp' },
  operating_income: { statement: 'income-statement', row: 'opinc' },
  ebitda: { statement: 'income-statement', row: 'ebitda' },
  net_income: { statement: 'income-statement', row: 'netinccmn' },
  eps: { statement: 'income-statement', row: 'epsdil' },
  total_assets: { statement: 'balance-sheet', row: 'assets' },
  equity: { statement: 'balance-sheet', row: 'totalCommonEquity' },
  operating_cash_flow: { statement: 'cash-flow-statement', row: 'ncfo' },
};

const PACE_MS = 1000;

/** `symbol` as the site writes it: 'lon/SHEL', 'etr/SAP'. */
export async function stockanalysisFigures(symbol: string, companyName: string, deps: FiguresDeps): Promise<FiguresOutcome> {
  const pause = deps.pause ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const uid = siteUid(symbol);
  const asOf = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);

  const pages = new Map<StatementName, StatementPage>();
  for (const which of ['income-statement', 'balance-sheet', 'cash-flow-statement'] as const) {
    if (pages.size > 0) await pause(PACE_MS);
    const out = await fetchSource(statement, `${symbol}|${which}`, deps);
    if (out.kind === 'unavailable' && out.response?.status === 404 && pages.size === 0) {
      return { kind: 'not-covered', reason: `stockanalysis has no page for ${symbol}` };
    }
    if (out.kind !== 'ok') {
      return { kind: out.kind, reason: `stockanalysis ${which}: ${out.kind === 'unavailable' ? out.reason : `${out.failure.check}: ${out.failure.observed}`}` };
    }
    // Never a figure from a different company than the one asked for (§7.2).
    if (out.value.uid !== uid) return { kind: 'suspect', reason: `asked stockanalysis for ${uid}, got ${out.value.uid}` };
    pages.set(which, out.value);
  }

  const currencies = new Set([...pages.values()].map((p) => p.currency));
  if (currencies.size > 1) {
    return { kind: 'suspect', reason: `stockanalysis statements disagree on currency: ${[...currencies].join(', ')}` };
  }

  const facts: Fact[] = [];
  const gaps: Gap[] = [];
  for (const concept of Object.keys(ROWS) as Concept[]) {
    const { statement: which, row } = ROWS[concept];
    const page = pages.get(which)!;
    const values = page.rows[row];
    const years = page.columns
      .map((c, i) => ({ c, v: values?.[i] ?? null }))
      .filter(({ c, v }) => c.datekey !== 'TTM' && v !== null);
    if (years.length === 0) {
      gaps.push({ fieldPath: CONCEPTS[concept], reason: `stockanalysis shows no ${CONCEPT_NAMES[concept].toLowerCase()} for ${companyName}` });
      continue;
    }
    for (const { c, v } of years.sort((a, b) => a.c.datekey.localeCompare(b.c.datekey))) {
      facts.push({
        fieldPath: CONCEPTS[concept],
        period: `FY${c.fiscalYear}`,
        periodEnd: c.datekey,
        value: v!,
        unit: concept === 'eps' ? `${page.currency}/share` : page.currency,
        currency: page.currency,
        kind: 'actual',
        source: 'stockanalysis',
        tier: 2,
        asOf,
        detail: `stockanalysis ${which}, "${row}"`,
      });
    }
  }

  return { kind: 'ok', figures: { source: 'stockanalysis', facts, gaps } };
}

