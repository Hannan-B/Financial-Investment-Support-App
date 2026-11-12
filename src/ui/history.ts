/**
 * The History tab's table: how every figure moved between his checks.
 * PROJECT-PLAN.md §6.3, §6.5, §11.9 steps 4.1–4.3 (as settled 2026-11-12)
 *
 * Columns are his checks — each time he pressed Review complete — showing
 * the refresh he had read by then, then "now". A switch adds every refresh in
 * between. Each figure shows its value at each point, the change from the
 * point before, and two changes on the right: since the last check and since
 * the oldest point shown.
 *
 * Each change is given in its usual terms: amounts and prices in %, figures
 * already in % in points ("24% → 26%" is +2.00 pts, not +8%), P/E and other
 * ratios as a plain difference, dates as old → new, words as was → now.
 * Results carry their year, so new results are never read as a change in an
 * old one; an earlier year a company has since revised is flagged.
 *
 * Pure: the real app and the demo both build the table here.
 */
import type { Fact } from '../research/figures.ts';
import type { HistoryFacts, StoredSnapshot } from '../research/history.ts';
import { FIGURE_NAMES, figureName } from '../research/names.ts';
import type { Entry, Label, Sold } from '../notes/document.ts';
import { day, factValue } from './format.ts';

// ── checks and columns ───────────────────────────────────────────────────

export interface Check {
  readonly at: string;
  readonly round: number;
  readonly stance: Label;
  readonly sold: Sold | null;
}

/** Each "Where I stand" line Review complete wrote, oldest first. */
export function checksOf(entries: readonly Entry[]): Check[] {
  return entries
    .filter((e) => e.kind === 'decision' && e.stance && !e.deletedAt)
    .map((e) => ({ at: e.createdAt, round: e.round, stance: e.stance!, sold: e.sold }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

export interface Column {
  /** The refresh shown: for a check, the latest one made before it. Null if there was none. */
  readonly snapshot: StoredSnapshot | null;
  readonly check: Check | null;
  readonly lastCheck: boolean;
  readonly now: boolean;
}

export interface ColumnOptions {
  /** Every refresh, not only the checks (step 4.3 as settled). */
  readonly everyRefresh: boolean;
  /** How many of the latest checks to show — 5 at first. */
  readonly checks: number;
}

/**
 * The columns, oldest first. "Now" is the latest refresh — left out when that
 * is the very refresh his last check read: there is nothing new to set
 * against it until he refreshes.
 */
export function columns(h: HistoryFacts, checks: readonly Check[], o: ColumnOptions): { columns: Column[]; earlier: number } {
  const snaps = h.snapshots;
  const read = (c: Check) => [...snaps].reverse().find((s) => s.capturedAt <= c.at) ?? null;
  const shown = checks.slice(Math.max(0, checks.length - o.checks));
  const last = checks.at(-1) ?? null;
  const col = (c: Check): Column => ({ snapshot: read(c), check: c, lastCheck: c === last, now: false });
  const latest = snaps.at(-1) ?? null;

  let out: Column[];
  if (!o.everyRefresh) {
    out = shown.map(col);
  } else {
    out = shown.filter((c) => read(c) === null).map(col);
    // From the oldest check shown — or from the first refresh, when no earlier check is hidden.
    const hiding = shown.length < checks.length;
    const from = !hiding ? '' : shown.map(read).find((s) => s !== null)?.capturedAt ?? '';
    for (const s of snaps) {
      if (from === null || s.capturedAt < from) continue;
      const here = shown.filter((c) => read(c)?.id === s.id);
      if (here.length) out.push(...here.map(col));
      else out.push({ snapshot: s, check: null, lastCheck: false, now: s === latest });
    }
  }
  const readLast = out.at(-1)?.lastCheck && out.at(-1)?.snapshot === latest;
  if (latest && !readLast && !out.some((c) => c.now)) out.push({ snapshot: latest, check: null, lastCheck: false, now: true });
  return { columns: out, earlier: checks.length - shown.length };
}

// ── groups ───────────────────────────────────────────────────────────────

interface Rule {
  readonly title: string;
  readonly note?: string;
  readonly paths: RegExp;
  readonly subs?: readonly { readonly title: string; readonly paths: RegExp }[];
}

/** The History tab's groups, in order; a figure goes in the first that matches. */
export const HISTORY_GROUPS: readonly Rule[] = [
  { title: 'Price and returns', paths: /^(price\.|performance\.|trading\.(high_52w|low_52w|below_high_52w|above_low_52w)$)/,
    subs: [{ title: 'Price change', paths: /^performance\./ }, { title: '52-week range', paths: /^trading\./ }] },
  { title: 'Yearly results', note: 'each number carries its year', paths: /^(income|balance|cashflow)\./,
    subs: [{ title: 'Income', paths: /^income\./ }, { title: 'Balance sheet', paths: /^balance\./ }, { title: 'Cash flow', paths: /^cashflow\./ }] },
  { title: 'Last 12 months', paths: /^ttm\./,
    subs: [{ title: 'Growth', paths: /growth/ }, { title: 'Against forecast', paths: /surprise/ }] },
  { title: 'Profitability', paths: /^profitability\./ },
  { title: 'Valuation', paths: /^valuation\./,
    subs: [
      { title: 'Size', paths: /^valuation\.(market_cap|enterprise_value)$/ },
      { title: 'Per share', paths: /_per_share$/ },
      { title: 'Price compared with…', paths: /./ },
    ] },
  { title: 'Financial health', paths: /^health\./ },
  { title: 'Dividends', paths: /^dividend\./ },
  { title: 'Technicals', paths: /^technical\./,
    subs: [
      { title: 'Moving averages', paths: /\.(sma|ema)_/ },
      { title: 'Momentum', paths: /\.(rsi|macd)_/ },
      { title: 'Volatility', paths: /\.(atr|bollinger)_/ },
    ] },
  { title: 'Trading', paths: /^trading\./ },
  { title: 'Ownership and short selling', paths: /^(ownership|short)\./,
    subs: [{ title: 'Ownership', paths: /^ownership\./ }, { title: 'Short selling', paths: /^short\./ }] },
  { title: 'The company', paths: /^company\./ },
  { title: 'Dates', paths: /^calendar\./ },
  { title: 'Analyst predictions', note: "other people's forecasts — not facts", paths: /^analyst\./ },
];
/** Where a figure no group names goes — a test keeps every named figure out of it. */
export const OTHER = 'Other figures';

export function placeOf(path: string): { group: string; sub: string | null } {
  const g = HISTORY_GROUPS.find((r) => r.paths.test(path));
  if (!g) return { group: OTHER, sub: null };
  return { group: g.title, sub: g.subs?.find((s) => s.paths.test(path))?.title ?? null };
}

const ORDER = new Map(Object.keys(FIGURE_NAMES).map((p, i) => [p, i]));
const byOrder = (a: string, b: string) => (ORDER.get(a) ?? 1e9) - (ORDER.get(b) ?? 1e9) || a.localeCompare(b);

export interface Grouped<T> {
  readonly title: string;
  readonly note: string | null;
  /** Figures outside any sub-group come first, under a null title. */
  readonly subs: readonly { readonly title: string | null; readonly items: readonly T[] }[];
}

/** Puts items in the History groups and sub-groups, in the sites' own order. */
export function grouped<T>(items: readonly T[], pathOf: (t: T) => string): Grouped<T>[] {
  const sorted = [...items].sort((a, b) => byOrder(pathOf(a), pathOf(b)));
  const titles = [...HISTORY_GROUPS.map((g) => g.title), OTHER];
  return titles.flatMap((title) => {
    const rule = HISTORY_GROUPS.find((g) => g.title === title);
    const mine = sorted.filter((t) => placeOf(pathOf(t)).group === title);
    if (!mine.length) return [];
    const subTitles = [null, ...(rule?.subs ?? []).map((s) => s.title)];
    const subs = subTitles
      .map((sub) => ({ title: sub, items: mine.filter((t) => placeOf(pathOf(t)).sub === sub) }))
      .filter((s) => s.items.length);
    return [{ title, note: rule?.note ?? null, subs }];
  });
}

// ── changes ──────────────────────────────────────────────────────────────

export interface Change {
  readonly text: string;
  /** 'FY2024 → FY2025' when the two values are for different years. */
  readonly periods: string | null;
}

const minus = '−';
function signed(x: number, digits: number): string {
  const n = Math.abs(x).toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${x > 0 ? '+' : x < 0 ? minus : '±'}${n}`;
}
const short = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/**
 * The change from `a` to `b`, in the figure's usual terms. `laterAt` is when
 * `b` was read: a "next" date already past by then was a different event.
 */
export function change(a: Fact, b: Fact, laterAt: string): Change {
  const periods = a.period && b.period && a.period !== b.period ? `${a.period} → ${b.period}` : null;
  if (a.currency !== b.currency) return { text: `now in ${b.currency ?? 'another unit'} — not compared`, periods };
  const x = a.value;
  const y = b.value;
  if (typeof x === 'string' || typeof y === 'string') {
    if (x === y) return { text: 'no change', periods };
    if (b.unit === 'date' && typeof x === 'string' && typeof y === 'string') {
      if (/\.next_/.test(b.fieldPath)) {
        return x < laterAt.slice(0, 10) ? { text: 'the next one', periods } : { text: `moved from ${short(x)} to ${short(y)}`, periods };
      }
      return { text: `was ${day(x)}, now ${day(y)}`, periods };
    }
    return { text: `was ${String(x)}, now ${String(y)}`, periods };
  }
  if (x === y) return { text: a.period && a.period === b.period ? (a.period.startsWith('FY') ? 'same year' : 'same period') : 'no change', periods };
  const d = y - x;
  switch (b.unit) {
    case 'percent': return { text: `${signed(d, 2)} pts`, periods };
    case 'index': return { text: `${signed(d, 1)} pts`, periods };
    case 'days': return { text: `${signed(d, 1)} days`, periods };
    case 'ratio': case 'rating': case 'score': return { text: signed(d, 2), periods };
  }
  // Amounts, prices, counts: a percentage, unless it would mislead — from zero, or across a loss.
  if (x <= 0 || y < 0) return { text: `${d > 0 ? '+' : minus}${factValue({ ...b, value: Math.abs(d) })}`, periods };
  return { text: `${signed((y / x - 1) * 100, 1)}%`, periods };
}

// ── rows ─────────────────────────────────────────────────────────────────

export interface Revision { readonly period: string; readonly from: Fact; readonly to: Fact; }

export interface Cell {
  /** The figure at that point; for yearly results, the latest year known then. */
  readonly fact: Fact | null;
  /** Why there is none. */
  readonly missing: string | null;
  /** From the column before. */
  readonly step: Change | null;
  /** Earlier years the company has changed since the column before. */
  readonly revised: readonly Revision[];
}

export interface Row {
  readonly path: string;
  readonly name: string;
  readonly cells: readonly Cell[];
  readonly sinceLastCheck: Change | null;
  readonly sinceOldest: Change | null;
}

const SITE: Readonly<Record<string, string>> = {
  'yahoo-prices': 'Yahoo', finviz: 'Finviz', edgar: 'The SEC filings', stockanalysis: 'stockanalysis',
  'stockanalysis-statistics': "stockanalysis's statistics page", 'stockanalysis-calendar': 'stockanalysis',
};
/** The refresh outcome that answers for a figure from this source. */
function outcomeSources(f: Fact): string[] {
  switch (f.source) {
    case 'yahoo': case 'computed': return ['yahoo-prices'];
    case 'stockanalysis': return f.period ? ['stockanalysis'] : ['stockanalysis-statistics', 'stockanalysis-calendar'];
    default: return [f.source];
  }
}

export function rows(h: HistoryFacts, cols: readonly Column[], visible: (path: string) => boolean): Row[] {
  const bySnapshot = new Map<number, Map<string, Fact[]>>();
  for (const f of h.facts) {
    const m = bySnapshot.get(f.snapshotId) ?? new Map<string, Fact[]>();
    bySnapshot.set(f.snapshotId, m);
    m.set(f.fieldPath, [...(m.get(f.fieldPath) ?? []), f]);
  }
  const shownSnapshots = new Set(cols.flatMap((c) => (c.snapshot ? [c.snapshot.id] : [])));
  const paths = [...new Set(h.facts.filter((f) => shownSnapshots.has(f.snapshotId)).map((f) => f.fieldPath))].filter(visible);

  const latestOf = (facts: readonly Fact[] | undefined): Fact | null => {
    if (!facts?.length) return null;
    return [...facts].sort((a, b) => (a.periodEnd ?? a.period ?? '').localeCompare(b.periodEnd ?? b.period ?? '')).at(-1)!;
  };
  const lastCheckAt = cols.findIndex((c) => c.lastCheck);
  // With no refresh since the last check, the comparisons end at that check.
  const nowAt = cols.length - 1;

  return paths.map((path) => {
    const sample = h.facts.find((f) => f.fieldPath === path)!;
    const why = (s: StoredSnapshot | null): string => {
      if (!s) return 'not refreshed before this check';
      const gap = h.gaps.find((g) => g.snapshotId === s.id && g.fieldPath === path);
      if (gap) return gap.reason;
      const o = s.outcomes.find((x) => outcomeSources(sample).includes(x.source));
      if (o && o.outcome !== 'ok') {
        const site = SITE[o.source] ?? o.source;
        return o.outcome === 'suspect' ? `${site} gave data that failed its checks` : o.outcome === 'not-covered' ? `${site} does not cover it` : `${site} did not answer`;
      }
      return 'not saved at this refresh';
    };
    const all = cols.map((c) => (c.snapshot ? bySnapshot.get(c.snapshot.id)?.get(path) : undefined));
    const facts = all.map(latestOf);
    const cells: Cell[] = cols.map((c, i) => {
      const fact = facts[i]!;
      const prev = i > 0 ? facts[i - 1] : null;
      const revised: Revision[] = [];
      if (i > 0 && sample.period) {
        for (const to of all[i] ?? []) {
          const from = all[i - 1]?.find((f) => f.period === to.period);
          if (from && from.value !== to.value) revised.push({ period: to.period!, from, to });
        }
      }
      return {
        fact, missing: fact ? null : why(c.snapshot),
        step: fact && prev ? change(prev, fact, c.snapshot!.capturedAt) : null,
        revised,
      };
    });
    const between = (from: number, to: number): Change | null => {
      if (from < 0 || to < 0 || from >= to) return null;
      const a = facts[from];
      const b = facts[to];
      return a && b ? change(a, b, cols[to]!.snapshot!.capturedAt) : null;
    };
    return {
      path, name: figureName(path), cells,
      sinceLastCheck: between(lastCheckAt, nowAt),
      sinceOldest: between(0, nowAt),
    };
  });
}
