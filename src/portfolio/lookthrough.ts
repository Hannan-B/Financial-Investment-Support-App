/**
 * What you actually own once funds are opened up.  PROJECT-PLAN.md §6A, §7
 *
 *   exposure(company) = direct holding + Σ (fund value × weight in fund)
 *
 * A pure calculation: it reads, never writes, and the same code will later
 * compute "what if I bought this" (§6A.4).
 *
 * 🔴 If any held fund cannot be opened, the breakdowns are REFUSED, not
 * shown partially: missing one fund silently understates whole sectors
 * while looking plausible (§10.1). Totals are still shown — those come from
 * the broker, not from look-through.
 *
 * Nothing is scaled to make it add up. A fund whose listed weights sum to
 * 99.7% leaves 0.3% "not itemised by the fund", shown as such.
 */
import { money, add, scale, sum, type Money } from '../lib/money.ts';
import { companyName } from '../lib/names.ts';
import { mapSector, type Sector } from '../categories/sectors.ts';
import { mapCountry } from '../categories/countries.ts';
import type { Constituent } from '../sources/holdings.ts';
import type { Classification } from './master.ts';

export interface Position {
  readonly isin: string;
  readonly name: string;
  readonly kind: 'equity' | 'etf';
  readonly value: Money<'GBP'>;
}

export interface FundContents {
  readonly ticker: string;
  readonly issuer: string;
  readonly asOf: string;
  readonly rows: readonly Constituent[];
}

export interface LookthroughInput {
  readonly positions: readonly Position[];
  /** Latest valid contents, by fund ISIN. */
  readonly contents: ReadonlyMap<string, FundContents>;
  readonly classifications: ReadonlyMap<string, Classification>;
}

export interface CompanyExposure {
  readonly name: string;
  /** More than one when share classes or listings are merged (Alphabet A and C). */
  readonly isins: readonly string[];
  readonly direct: Money<'GBP'>;
  readonly viaFunds: readonly { readonly fund: string; readonly value: Money<'GBP'> }[];
  readonly total: Money<'GBP'>;
  readonly share: number;
}

export const UNCLASSIFIED = 'Not yet classified';
export type SectorKey = Sector | typeof UNCLASSIFIED;
/** ISO country code, or one of these. */
export type CountryKey = string | 'cash' | 'unclassified';

export interface Bucket<K> { readonly key: K; readonly value: Money<'GBP'>; readonly share: number; }

export interface Breakdowns {
  readonly kind: 'ok';
  readonly companies: readonly CompanyExposure[];
  readonly sectors: readonly Bucket<SectorKey>[];
  readonly countries: readonly Bucket<CountryKey>[];
  /** Cash and derivative lines inside funds, plus weight the funds did not itemise. */
  readonly cash: Money<'GBP'>;
}

export interface Lookthrough {
  readonly total: Money<'GBP'>;
  readonly direct: Money<'GBP'>;
  readonly viaFunds: Money<'GBP'>;
  readonly breakdowns: Breakdowns | { readonly kind: 'refused'; readonly reasons: readonly string[] };
}

export function lookthrough(input: LookthroughInput): Lookthrough {
  const gbp = (n: number) => money(n, 'GBP');
  const funds = input.positions.filter((p) => p.kind === 'etf');
  const direct = sum(input.positions.filter((p) => p.kind === 'equity').map((p) => p.value), 'GBP');
  const viaFunds = sum(funds.map((p) => p.value), 'GBP');
  const total = add(direct, viaFunds);

  const reasons = funds
    .filter((f) => !input.contents.has(f.isin))
    .map((f) => `${f.name}: its contents are not available, so the breakdowns would leave it out`);
  if (reasons.length > 0) return { total, direct, viaFunds, breakdowns: { kind: 'refused', reasons } };

  const share = (m: Money<'GBP'>) => (total.amount === 0 ? 0 : m.amount / total.amount);

  // ── classification ────────────────────────────────────────────────────
  const sectorOf = (row: { isin: string | null; sector: string | null }, issuer: string | null): SectorKey => {
    if (row.sector && issuer) return mapSector(issuer, row.sector) ?? UNCLASSIFIED;
    const c = row.isin ? input.classifications.get(row.isin)?.sector : undefined;
    return (c && mapSector(c.source, c.label)) ?? UNCLASSIFIED;
  };
  const countryOf = (row: { isin: string | null; country: string | null }): CountryKey => {
    if (row.country) return mapCountry(row.country) ?? 'unclassified';
    const c = row.isin ? input.classifications.get(row.isin)?.country : undefined;
    return (c && mapCountry(c.label)) ?? 'unclassified';
  };

  // ── accumulate ────────────────────────────────────────────────────────
  const sectors = new Map<SectorKey, Money<'GBP'>>();
  const countries = new Map<CountryKey, Money<'GBP'>>();
  const bump = <K>(map: Map<K, Money<'GBP'>>, key: K, value: Money<'GBP'>) =>
    map.set(key, add(map.get(key) ?? gbp(0), value));

  interface Acc { name: string; isins: Set<string>; direct: Money<'GBP'>; via: Map<string, Money<'GBP'>>; }
  const companies = new Map<string, Acc>();
  // Every row with a given ISIN joins the same company, whatever each fund
  // calls it; rows without one (DJIW) join by cleaned name.
  const keyForIsin = new Map<string, string>();
  const companyFor = (isin: string | null, name: string): Acc => {
    let key = isin ? keyForIsin.get(isin) : undefined;
    if (!key) {
      key = companyName(name) || name;
      if (isin) keyForIsin.set(isin, key);
    }
    let acc = companies.get(key);
    if (!acc) {
      acc = { name: key, isins: new Set(), direct: gbp(0), via: new Map() };
      companies.set(key, acc);
    }
    if (isin) acc.isins.add(isin);
    return acc;
  };

  let cash = gbp(0);

  for (const p of input.positions.filter((x) => x.kind === 'equity')) {
    const acc = companyFor(p.isin, p.name);
    acc.name = p.name;                     // the broker's name reads best
    acc.direct = add(acc.direct, p.value);
    bump(sectors, sectorOf({ isin: p.isin, sector: null }, null), p.value);
    bump(countries, countryOf({ isin: p.isin, country: null }), p.value);
  }

  for (const f of funds) {
    const contents = input.contents.get(f.isin)!;
    let listed = 0;
    for (const row of contents.rows) {
      listed += row.weightPct;
      const value = scale(f.value, row.weightPct / 100);
      if (row.kind === 'cash') {
        cash = add(cash, value);
        bump(sectors, 'Cash / Other', value);
        bump(countries, 'cash', value);
        continue;
      }
      const acc = companyFor(row.isin, row.name);
      acc.via.set(contents.ticker, add(acc.via.get(contents.ticker) ?? gbp(0), value));
      bump(sectors, sectorOf(row, contents.issuer), value);
      bump(countries, countryOf(row), value);
    }
    const unlisted = scale(f.value, (100 - listed) / 100);
    cash = add(cash, unlisted);
    bump(sectors, 'Cash / Other', unlisted);
    bump(countries, 'cash', unlisted);
  }

  const byValue = <T extends { value: Money<'GBP'> }>(a: T, b: T) => b.value.amount - a.value.amount;
  const buckets = <K>(map: Map<K, Money<'GBP'>>): Bucket<K>[] =>
    [...map].map(([key, value]) => ({ key, value, share: share(value) })).sort(byValue);

  return {
    total, direct, viaFunds,
    breakdowns: {
      kind: 'ok',
      companies: [...companies.values()]
        .map((c) => {
          const viaList = [...c.via].map(([fund, value]) => ({ fund, value })).sort(byValue);
          const t = add(c.direct, sum(viaList.map((v) => v.value), 'GBP'));
          return { name: c.name, isins: [...c.isins], direct: c.direct, viaFunds: viaList, total: t, share: share(t) };
        })
        .sort((a, b) => b.total.amount - a.total.amount),
      sectors: buckets(sectors),
      countries: buckets(countries),
      cash,
    },
  };
}
