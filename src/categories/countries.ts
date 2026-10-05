/**
 * Countries.  PROJECT-PLAN.md §6A.3
 *
 * Every source spells them differently — 'Korea (South)', 'South Korea',
 * 'KOREA, REPUBLIC OF' — so each label maps to an ISO 3166 code. As with
 * sectors, an unknown label is an error, never a guess.
 *
 * ⚠️ iShares and HSBC report country of RISK (where the business is).
 *    Waystone reports some companies by where they are REGISTERED — Cayman
 *    Islands, Jersey. That is what it says, so that is what is shown.
 */

/** ISO 3166-1 alpha-2 → display name. 'EU' is ISO's reserved code, used for euro cash. */
export const COUNTRY_NAMES: Readonly<Record<string, string>> = {
  AE: 'United Arab Emirates', AR: 'Argentina', AT: 'Austria', AU: 'Australia', BD: 'Bangladesh',
  BE: 'Belgium', BH: 'Bahrain', BM: 'Bermuda', BR: 'Brazil', CA: 'Canada', CH: 'Switzerland',
  CI: "Côte d'Ivoire", CL: 'Chile', CN: 'China', CO: 'Colombia', CY: 'Cyprus',
  CZ: 'Czech Republic', DE: 'Germany', DK: 'Denmark', EG: 'Egypt', ES: 'Spain',
  EU: 'European Union', FI: 'Finland', FR: 'France', GB: 'United Kingdom', GG: 'Guernsey',
  GR: 'Greece', HK: 'Hong Kong', HU: 'Hungary', ID: 'Indonesia', IE: 'Ireland', IL: 'Israel',
  IM: 'Isle of Man', IN: 'India', IS: 'Iceland', IT: 'Italy', JE: 'Jersey', JO: 'Jordan',
  JP: 'Japan', KE: 'Kenya', KR: 'South Korea', KW: 'Kuwait', KY: 'Cayman Islands',
  KZ: 'Kazakhstan', LU: 'Luxembourg', MA: 'Morocco', MT: 'Malta', MU: 'Mauritius', MX: 'Mexico',
  MY: 'Malaysia', NG: 'Nigeria', NL: 'Netherlands', NO: 'Norway', NZ: 'New Zealand', OM: 'Oman',
  PA: 'Panama', PE: 'Peru', PH: 'Philippines', PK: 'Pakistan', PL: 'Poland', PT: 'Portugal',
  QA: 'Qatar', RO: 'Romania', RU: 'Russia', SA: 'Saudi Arabia', SE: 'Sweden', SG: 'Singapore',
  SI: 'Slovenia', TH: 'Thailand', TR: 'Turkey', TW: 'Taiwan', US: 'United States',
  VG: 'British Virgin Islands', VN: 'Vietnam', ZA: 'South Africa',
};

/** Spellings that differ from the display name, upper-cased. */
const ALIASES: Readonly<Record<string, string>> = {
  'KOREA (SOUTH)': 'KR',
  'KOREA, REPUBLIC OF': 'KR',
  'RUSSIAN FEDERATION': 'RU',
  'JERSEY, CHANNEL ISLANDS': 'JE',
  'COTE D\'IVOIRE': 'CI',
  'IVORY COAST': 'CI',
  'VIET NAM': 'VN',
};

const BY_LABEL: ReadonlyMap<string, string> = new Map([
  ...Object.entries(COUNTRY_NAMES).map(([code, name]) => [name.toUpperCase(), code] as const),
  ...Object.entries(ALIASES),
]);

export function mapCountry(label: string): string | undefined {
  return BY_LABEL.get(label.trim().toUpperCase());
}

/** For the labels-mapped check: every spelling that maps, upper-cased. */
export function isKnownCountry(label: string): boolean {
  return mapCountry(label) !== undefined;
}
