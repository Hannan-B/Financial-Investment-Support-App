import type { Check, ValidationFailure } from './types.ts';

/**
 * Reusable checks.  Every one of these caught something real during research
 * (§10.1) — they are not hypothetical.
 */

export interface Weighted { readonly weightPct: number; }

/**
 * Fund weights must sum to ~100%.
 * This is precisely how the Invesco and iShares adapters were confirmed correct,
 * and how a truncated or partly-parsed holdings list is caught.
 */
export function weightsSumTo100<T extends Weighted>(
  min = 99, max = 101,
): Check<readonly T[]> {
  return {
    name: 'weights-sum',
    run(rows) {
      const total = rows.reduce((n, r) => n + r.weightPct, 0);
      if (total >= min && total <= max) return null;
      return {
        check: 'weights-sum',
        expected: `weights to sum to ${min}–${max}%`,
        observed: `summed to ${total.toFixed(2)}% across ${rows.length} rows`,
      };
    },
  };
}

/** A fund silently returning an empty or stub list. */
export function rowCountBetween<T>(min: number, max: number): Check<readonly T[]> {
  return {
    name: 'row-count',
    run(rows) {
      if (rows.length >= min && rows.length <= max) return null;
      return {
        check: 'row-count',
        expected: `between ${min} and ${max} rows`,
        observed: `${rows.length} rows`,
      };
    },
  };
}

/** A frozen or cached endpoint quietly serving stale data. */
export function asOfWithinDays<T>(
  getAsOf: (parsed: T) => Date | null,
  days: number,
  now: () => Date = () => new Date(),
): Check<T> {
  return {
    name: 'as-of-freshness',
    run(parsed) {
      const asOf = getAsOf(parsed);
      if (!asOf) {
        return { check: 'as-of-freshness', expected: 'an as-of date', observed: 'none present' };
      }
      const age = (now().getTime() - asOf.getTime()) / 86_400_000;
      if (age <= days) return null;
      return {
        check: 'as-of-freshness',
        expected: `data no more than ${days} days old`,
        observed: `${Math.floor(age)} days old (${asOf.toISOString().slice(0, 10)})`,
      };
    },
  };
}

/**
 * Every category label must be mapped. §12.10
 * Unknown labels raise an error — never guessed, never dropped into "Other".
 * Wahed demonstrably emits GICS *industry* names, so new ones will appear.
 */
export function labelsAllMapped<T>(
  getLabels: (parsed: T) => readonly string[],
  known: ReadonlySet<string>,
): Check<T> {
  return {
    name: 'labels-mapped',
    run(parsed) {
      const unknown = [...new Set(getLabels(parsed))].filter((l) => !known.has(l));
      if (unknown.length === 0) return null;
      return {
        check: 'labels-mapped',
        expected: 'every category label to have a mapping',
        observed: `unmapped: ${unknown.join(', ')}`,
      };
    },
  };
}

export type { Check, ValidationFailure };
