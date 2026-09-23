/**
 * What every fund reader produces, and the checks every fund must pass.
 * PROJECT-PLAN.md §4.2, §10.1
 *
 * Labels (country, sector) are kept exactly as the issuer wrote them. Mapping
 * them into the app's own categories happens later, and can change without
 * fetching anything again (§4.4b).
 */
import type { Check } from '../fetch/types.ts';
import { weightsSumTo100, rowCountBetween, asOfWithinDays } from '../fetch/checks.ts';
import { knownSectorLabels } from '../categories/sectors.ts';
import { isKnownCountry } from '../categories/countries.ts';

export interface Constituent {
  readonly name: string;
  /** Percent of the fund. Can be negative for cash adjustments. */
  readonly weightPct: number;
  readonly isin: string | null;
  /** DJIW publishes SEDOLs instead of ISINs (§4.5). */
  readonly sedol: string | null;
  readonly country: string | null;
  readonly sector: string | null;
  readonly currency: string | null;
  /** Cash, FX and derivative lines: real weight, but not a company. */
  readonly kind: 'equity' | 'cash';
}

export interface FundHoldings {
  /** ISO date the issuer says the list is as of. Null if it publishes none. */
  readonly asOf: string | null;
  readonly rows: readonly Constituent[];
}

export interface HoldingsCheckOptions {
  readonly rows: readonly [min: number, max: number];
  /** Omit for an issuer that publishes no date (Waystone). */
  readonly maxAgeDays?: number;
  readonly now?: () => Date;
  /** Equity rows must carry this identifier, or the columns have shifted. */
  readonly identifier: 'isin' | 'sedol';
  /** Sector labels must be in this source's mapping (§12.10). Omit if none supplied. */
  readonly sectors?: string;
  /** Country labels must all be recognised. */
  readonly countries?: boolean;
}

export function holdingsChecks(opts: HoldingsCheckOptions): Check<FundHoldings>[] {
  const onRows = (check: Check<readonly Constituent[]>): Check<FundHoldings> => ({
    name: check.name,
    run: (h) => check.run(h.rows),
  });
  return [
    onRows(weightsSumTo100<Constituent>()),
    onRows(rowCountBetween<Constituent>(...opts.rows)),
    ...(opts.maxAgeDays === undefined ? [] : [
      asOfWithinDays<FundHoldings>((h) => (h.asOf ? new Date(h.asOf) : null), opts.maxAgeDays, opts.now),
    ]),
    identifiersPresent(opts.identifier),
    isinsValid,
    ...(opts.sectors === undefined ? [] : [
      labelsMapped('sector', (l) => knownSectorLabels(opts.sectors!).has(l)),
    ]),
    ...(opts.countries ? [labelsMapped('country', isKnownCountry)] : []),
  ];
}

/**
 * Every label must have a mapping — never guessed, never "Other" (§10.1).
 * Wahed demonstrably emits industry names where sectors belong; the next one
 * must stop the fund, not quietly shrink a sector.
 */
function labelsMapped(field: 'sector' | 'country', known: (label: string) => boolean): Check<FundHoldings> {
  const name = `${field}-labels-mapped`;
  return {
    name,
    run(h) {
      const unknown = [...new Set(h.rows.map((r) => r[field]).filter((l): l is string => l !== null && !known(l)))];
      if (unknown.length === 0) return null;
      return {
        check: name,
        expected: `every ${field} label to have a mapping`,
        observed: `unmapped: ${unknown.join(', ')}`,
      };
    },
  };
}

/** Every company row must carry its identifier; cash lines need not. */
function identifiersPresent(field: 'isin' | 'sedol'): Check<FundHoldings> {
  return {
    name: 'identifiers-present',
    run(h) {
      const missing = h.rows.filter((r) => r.kind === 'equity' && !r[field]);
      if (missing.length === 0) return null;
      return {
        check: 'identifiers-present',
        expected: `every company row to have a ${field.toUpperCase()}`,
        observed: `${missing.length} without, e.g. ${missing.slice(0, 3).map((r) => r.name).join('; ')}`,
      };
    },
  };
}

/** A shifted column puts names or tickers where ISINs belong. */
const isinsValid: Check<FundHoldings> = {
  name: 'isins-valid',
  run(h) {
    const bad = h.rows.filter((r) => r.isin !== null && !isValidIsin(r.isin));
    if (bad.length === 0) return null;
    return {
      check: 'isins-valid',
      expected: 'every ISIN to pass its check digit',
      observed: `${bad.length} invalid, e.g. ${bad.slice(0, 3).map((r) => r.isin).join(', ')}`,
    };
  },
};

/** ISO 6166: two letters, nine alphanumerics, one Luhn check digit. */
export function isValidIsin(isin: string): boolean {
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin)) return false;
  const digits = [...isin].map((c) => parseInt(c, 36)).join('');
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

// ── parsing helpers shared by the readers ────────────────────────────────

/** '1,096.16' · '8.60%' · '14.81' → number. Throws rather than guessing. */
export function parseNumber(text: string): number {
  const n = Number(text.replace(/[,%\s]/g, ''));
  if (text.trim() === '' || !Number.isFinite(n)) throw new Error(`not a number: ${JSON.stringify(text)}`);
  return n;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** iShares writes '22/Sept/2026'. */
export function parseDayMonthYear(text: string): string {
  const m = /^(\d{1,2})\/([A-Za-z]{3,9})\/(\d{4})$/.exec(text.trim());
  const month = m ? MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) : -1;
  if (!m || month < 0) throw new Error(`unrecognised date: ${JSON.stringify(text)}`);
  return isoDate(Date.UTC(Number(m[3]), month, Number(m[1])));
}

/** Excel stores dates as days since 30 Dec 1899 (HSBC: '46283' = 2026-09-18). */
export function excelSerialDate(text: string): string {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 30_000 || n > 80_000) throw new Error(`not an Excel date: ${JSON.stringify(text)}`);
  return isoDate(Date.UTC(1899, 11, 30) + n * 86_400_000);
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Invesco sends 'ELI LILLY &amp; CO'. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

export function emptyToNull(text: string | undefined): string | null {
  const t = text?.trim();
  return t ? t : null;
}
