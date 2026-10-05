/**
 * Company figures, whichever site they came from.  PROJECT-PLAN.md §3, §7, §7.1
 *
 * Every adapter turns its site's numbers into FACTS named after the concept —
 * 'income.revenue', never what a website calls it (§10.4) — each carrying its
 * currency, whether it is an actual or an estimate (§7.1), where it came from
 * and when it became known (§7③). A figure that cannot be found is a GAP with
 * a reason, shown as such: never a guess, never a figure from a nearby line.
 */
import type { Currency } from '../lib/money.ts';

/** The seven figures in every report, by their field paths (§7②). */
export const CONCEPTS = {
  revenue: 'income.revenue',
  gross_profit: 'income.gross_profit',
  operating_income: 'income.operating_income',
  ebitda: 'income.ebitda',
  net_income: 'income.net_income',
  eps: 'income.eps_diluted',
  total_assets: 'balance.total_assets',
  equity: 'balance.equity',
  operating_cash_flow: 'cashflow.operating',
} as const;
export type Concept = keyof typeof CONCEPTS;

export const CONCEPT_NAMES: Readonly<Record<Concept, string>> = {
  revenue: 'Revenue',
  gross_profit: 'Gross profit',
  operating_income: 'Operating income',
  ebitda: 'EBITDA',
  net_income: 'Net income',
  eps: 'Earnings per share (diluted)',
  total_assets: 'Total assets',
  equity: "Shareholders' equity",
  operating_cash_flow: 'Operating cash flow',
};

export interface Fact {
  readonly fieldPath: string;
  /** 'FY2025' for annual figures; null for a point-in-time figure such as a target price. */
  readonly period: string | null;
  /** Last day of the period, for annual figures. */
  readonly periodEnd: string | null;
  readonly value: number | string;
  /** The currency for money ('USD/share' per share); otherwise what the number is: 'ratio', 'percent', 'date'. */
  readonly unit: string;
  readonly currency: Currency | null;
  readonly kind: 'actual' | 'estimate';
  readonly source: string;
  /** 1 = filed by the company itself; 2 = a third-party site (§3). */
  readonly tier: 1 | 2 | 3;
  /** When it became known: the filing date where there is one, otherwise the day it was read. */
  readonly asOf: string;
  /** The source's own name for it, so any figure can be found again at the source. */
  readonly detail: string;
}

export interface Gap {
  readonly fieldPath: string;
  readonly reason: string;
}

export interface Figures {
  readonly source: string;
  readonly facts: readonly Fact[];
  readonly gaps: readonly Gap[];
}

export type FiguresOutcome =
  | { readonly kind: 'ok'; readonly figures: Figures }
  /** This source cannot serve this company — e.g. a London share on Finviz. Not a failure. */
  | { readonly kind: 'not-covered'; readonly reason: string }
  /** The source did not answer: offline, throttled, server error. Recorded as absent (§10.1). */
  | { readonly kind: 'unavailable'; readonly reason: string }
  /** It answered, but wrongly — failed validation, or about a different company. Nothing from it is used (§10.1). */
  | { readonly kind: 'suspect'; readonly reason: string };

/** Annual facts for one concept, oldest first. */
export function series(figures: Figures, concept: Concept): Fact[] {
  return figures.facts
    .filter((f) => f.fieldPath === CONCEPTS[concept] && f.period !== null)
    .sort((a, b) => (a.periodEnd ?? '').localeCompare(b.periodEnd ?? ''));
}
