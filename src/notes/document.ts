/**
 * A company's notes document, and the rules for it.  PROJECT-PLAN.md §11.8
 *
 * As set out on 2026-11-02, it works like comments in Word: one
 * document per company, read top to bottom. The first round has opening
 * thoughts, comments on things on screen, and concluding thoughts; "Review
 * complete" ends it with a decision line — where he stands. Later visits add
 * comments and a new conclusion AFTER the previous one, so the document shows
 * what he thought at each point. Within a round, comments follow the tabs'
 * order.
 *
 * Pure functions over the entries: the database layer (`store.ts`) and the
 * demo both use them, so the rules cannot drift between the two.
 */

export type Label = 'to_review' | 'reviewing' | 'watching' | 'passed' | 'none';

/** In the order they are offered. */
export const LABELS: readonly (readonly [Label, string])[] = [
  ['to_review', 'To review'], ['reviewing', 'Reviewing'], ['watching', 'Watching'], ['passed', 'Passed'], ['none', 'No label'],
];
export const LABEL_NAMES: Readonly<Record<Label, string>> = Object.fromEntries(LABELS) as Record<Label, string>;
export const isLabel = (x: unknown): x is Label => typeof x === 'string' && x in LABEL_NAMES;

/** The report's tabs, in their order on screen — comments follow it. */
export const TABS = [
  ['overview', 'Overview'], ['financials', 'Financials'], ['technicals', 'Technicals'], ['news', 'News & Filings'],
  ['insiders', 'Insider dealings'], ['calendar', 'Calendar'], ['history', 'History'],
] as const;
export type Tab = (typeof TABS)[number][0];
export const TAB_NAMES: Readonly<Record<Tab, string>> = Object.fromEntries(TABS) as Record<Tab, string>;
export const isTab = (x: unknown): x is Tab => typeof x === 'string' && x in TAB_NAMES;

export type Sold = 'chose' | 'had_to';
export const SOLD_NAMES: Readonly<Record<Sold, string>> = { chose: 'chose to', had_to: 'had to' };

/** What a comment is about: its identity, never its place on screen (§6.2). */
export interface Target {
  /** 'fact:income.revenue:FY2025', 'news:<url>', 'price:2026-10-03' … */
  readonly key: string;
  /** 'Revenue · FY2025' */
  readonly label: string;
  /** As shown when the comment was written: '£61.2B', a headline, a dealing. */
  readonly value: string;
}

export interface Version { readonly writtenAt: string; readonly body: string; }

export interface Entry {
  readonly id: number;
  readonly round: number;
  readonly kind: 'opening' | 'comment' | 'concluding' | 'decision';
  readonly createdAt: string;
  /** Comments only. */
  readonly tab: Tab | null;
  /** Comments only; null for a comment on the tab as a whole. */
  readonly target: Target | null;
  readonly snapshotId: number | null;
  /** Decision lines only. */
  readonly stance: Label | null;
  readonly sold: Sold | null;
  /** Every wording, oldest first; the last is what shows. A decision line may have none. */
  readonly versions: readonly Version[];
  readonly deletedAt: string | null;
}

export const bodyOf = (e: Entry): string => e.versions.at(-1)?.body ?? '';
const live = (e: Entry) => e.deletedAt === null;
const written = (e: Entry) => live(e) && bodyOf(e).trim() !== '';

/** The round new writing goes into: one more than the decision lines so far. */
export function currentRound(entries: readonly Entry[]): number {
  return 1 + entries.filter((e) => e.kind === 'decision').length;
}

export interface ReviewState {
  readonly round: number;
  /** Opening thoughts are written once, in the first round. */
  readonly opening: Entry | null;
  /** This round's concluding thoughts, if written. */
  readonly concluding: Entry | null;
  /** The last decision line, if any. */
  readonly lastDecision: Entry | null;
  /** Something written in this round: the document carries on where he left off. */
  readonly inProgress: boolean;
}

export function reviewState(entries: readonly Entry[]): ReviewState {
  const round = currentRound(entries);
  const decisions = entries.filter((e) => e.kind === 'decision');
  return {
    round,
    opening: entries.find((e) => e.kind === 'opening' && written(e)) ?? null,
    concluding: entries.find((e) => e.kind === 'concluding' && e.round === round && written(e)) ?? null,
    lastDecision: decisions.at(-1) ?? null,
    inProgress: entries.some((e) => e.round === round && live(e)),
  };
}

/** Why Review complete cannot be pressed yet, or null when it can (§11.8 step 3.4). */
export function cannotCompleteReview(entries: readonly Entry[]): string | null {
  return reviewState(entries).concluding
    ? null
    : 'Write your concluding thoughts first — a completed review always has them';
}

/** Why this entry cannot be added, or null when it can. */
export function cannotAdd(entries: readonly Entry[], kind: 'opening' | 'comment' | 'concluding', body: string): string | null {
  if (body.trim() === '') return 'There is nothing written';
  const s = reviewState(entries);
  if (kind === 'opening' && s.round > 1) return 'Opening thoughts belong to the first review; later visits add comments and a new conclusion';
  if (kind === 'opening' && s.opening) return 'The opening thoughts are already written — edit them instead';
  if (kind === 'concluding' && s.concluding) return 'This review’s concluding thoughts are already written — edit them instead';
  return null;
}

const KIND_ORDER: Readonly<Record<Entry['kind'], number>> = { opening: 0, comment: 1, concluding: 2, decision: 3 };
const TAB_ORDER: Readonly<Record<string, number>> = Object.fromEntries(TABS.map(([t], i) => [t, i]));

/**
 * The whole document in reading order: round by round; within one, the
 * opening thoughts, comments in the tabs' order (each tab's in the order
 * written), the conclusion, then the decision line.
 */
export function inOrder(entries: readonly Entry[]): Entry[] {
  return [...entries].sort((a, b) =>
    a.round - b.round
    || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || (TAB_ORDER[a.tab ?? ''] ?? 0) - (TAB_ORDER[b.tab ?? ''] ?? 0)
    || a.createdAt.localeCompare(b.createdAt)
    || a.id - b.id);
}

export type Filter =
  | { readonly kind: 'all' }
  /** Only the latest conclusion and where he stood — what reopening shows after Review complete. */
  | { readonly kind: 'latest' }
  /** Opening and concluding thoughts and the decision lines, all rounds. */
  | { readonly kind: 'thoughts' }
  | { readonly kind: 'tab'; readonly tab: Tab };

/** What the panel opens on: the latest conclusion once a review is complete, else the whole document to carry on. */
export function openingFilter(entries: readonly Entry[]): Filter {
  const s = reviewState(entries);
  return s.lastDecision && !s.inProgress ? { kind: 'latest' } : { kind: 'all' };
}

export function filtered(entries: readonly Entry[], filter: Filter): Entry[] {
  const all = inOrder(entries);
  switch (filter.kind) {
    case 'all': return all;
    case 'thoughts': return all.filter((e) => e.kind !== 'comment');
    case 'tab': return all.filter((e) => e.kind === 'comment' && e.tab === filter.tab);
    case 'latest': {
      const last = reviewState(entries).lastDecision;
      if (!last) return all;
      return all.filter((e) => e.round === last.round && (e.kind === 'concluding' || e.kind === 'decision'));
    }
  }
}
