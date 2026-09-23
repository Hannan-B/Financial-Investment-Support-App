/**
 * Industry groups, level 1.  PROJECT-PLAN.md §4.4b, §12.10
 *
 * The app's own twelve (GICS sectors + cash). Each source's labels are mapped
 * in, never trusted as given: Waystone mixes levels, so 'Pharmaceuticals'
 * must roll up into Health Care, or Health Care reads 1% instead of 15%.
 *
 * A label missing from this table is an ERROR, not "Other" (§10.1). When a
 * source introduces a new one, the fund is rejected with the label named, and
 * the fix is one line here.
 */

export const SECTORS = [
  'Technology', 'Health Care', 'Industrials', 'Consumer Discretionary', 'Consumer Staples',
  'Materials', 'Energy', 'Communication', 'Utilities', 'Real Estate', 'Financials', 'Cash / Other',
] as const;

export type Sector = (typeof SECTORS)[number];

/** The eleven GICS sector names, as sources that use GICS spell them. */
const GICS: Readonly<Record<string, Sector>> = {
  'Information Technology': 'Technology',
  'Health Care': 'Health Care',
  'Industrials': 'Industrials',
  'Consumer Discretionary': 'Consumer Discretionary',
  'Consumer Staples': 'Consumer Staples',
  'Materials': 'Materials',
  'Energy': 'Energy',
  'Communication Services': 'Communication',
  'Utilities': 'Utilities',
  'Real Estate': 'Real Estate',
  'Financials': 'Financials',
};

export const SECTOR_MAPPING: Readonly<Record<string, Readonly<Record<string, Sector>>>> = {
  ishares: {
    ...GICS,
    'Communication': 'Communication',            // iShares shortens the GICS name
    'Cash and/or Derivatives': 'Cash / Other',
  },
  waystone: {
    ...GICS,
    // GICS industries reported where a sector belongs (§4.5)
    'Pharmaceuticals': 'Health Care',
    'Biotechnology': 'Health Care',
    'Health Care Supplies': 'Health Care',
    'Life Sciences Tools & Services': 'Health Care',
  },
};

export function mapSector(source: string, label: string): Sector | undefined {
  return SECTOR_MAPPING[source]?.[label];
}

export function knownSectorLabels(source: string): ReadonlySet<string> {
  return new Set(Object.keys(SECTOR_MAPPING[source] ?? {}));
}
