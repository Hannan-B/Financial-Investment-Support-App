/**
 * stockanalysis.com — company search and company profile.  PROJECT-PLAN.md §3
 *
 * Used in Phase 1 to classify fund constituents that no fund source
 * classifies — mainly IGDA, whose Dow Jones Islamic screen includes NVIDIA,
 * Apple, Amazon and Alphabet, which MSCI's (iShares) excludes.
 *
 * The profile page prints the company's ISIN. A lookup is only accepted when
 * that ISIN is exactly the one asked for (§7.2): a similar name, an ADR or the
 * other share class is never taken as a match.
 */
import type { Source } from '../fetch/types.ts';
import type { Check } from '../fetch/types.ts';
import { isValidIsin, decodeEntities } from './holdings.ts';
import { knownSectorLabels } from '../categories/sectors.ts';
import { isKnownCountry } from '../categories/countries.ts';

const SITE = 'https://stockanalysis.com';

// ── search ───────────────────────────────────────────────────────────────

export interface SearchHit {
  /** The site's own symbol: 'NVDA', or 'tyo/6981' outside the US. */
  readonly symbol: string;
  readonly name: string;
  /** Path of the company profile page. */
  readonly profile: string;
}

export const search: Source<SearchHit[]> = {
  id: 'stockanalysis-search',
  core: false,
  request: (query) => ({ url: `${SITE}/api/search?q=${encodeURIComponent(query)}` }),
  parse(res) {
    const json = JSON.parse(new TextDecoder().decode(res.body)) as { data?: unknown };
    if (!Array.isArray(json.data)) throw new Error('no data array in search response');
    // t 's' = US stock; t 'sy' with st 's' = stock on another exchange. ETFs etc. are dropped.
    return (json.data as Array<{ s?: unknown; t?: unknown; st?: unknown; n?: unknown }>)
      .filter((d) => typeof d.s === 'string' && (d.t === 's' || (d.t === 'sy' && d.st === 's')))
      .map((d) => {
        const symbol = d.s as string;
        return {
          symbol,
          name: String(d.n ?? ''),
          profile: d.t === 's' ? `/stocks/${symbol.toLowerCase()}/company/` : `/quote/${symbol}/company/`,
        };
      });
  },
  checks: [],
};

/**
 * Most likely listings first, so a lookup usually costs two requests:
 * a US ISIN's plain US ticker; otherwise the company's home exchange.
 */
export function rankHits(isin: string, hits: readonly SearchHit[]): SearchHit[] {
  const country = isin.slice(0, 2);
  const home = HOME_EXCHANGES[country] ?? [];
  const score = (h: SearchHit): number => {
    const exchange = h.symbol.includes('/') ? h.symbol.split('/')[0]! : 'us';
    if (exchange === 'us' && !h.symbol.includes('.')) return country === 'US' ? 0 : 2;
    if (home.includes(exchange)) return 1;
    return 3;
  };
  return hits.map((h, i) => ({ h, i, s: score(h) })).sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.h);
}

/** ISIN country → stockanalysis exchange prefixes, primary first. */
const HOME_EXCHANGES: Readonly<Record<string, readonly string[]>> = {
  JP: ['tyo'], GB: ['lon'], DE: ['etr', 'fra'], FR: ['epa'], CH: ['swx'], NL: ['ams'],
  SE: ['sto'], DK: ['cph'], FI: ['hel'], NO: ['osl'], ES: ['bme'], IT: ['bit'], BE: ['ebr'],
  AT: ['vie'], PT: ['els'], IE: ['ise', 'lon'], AU: ['asx'], NZ: ['nzx'], CA: ['tsx'],
  HK: ['hkg'], KR: ['krx', 'kosdaq'], TW: ['tpe'], SG: ['sgx'], CN: ['sha', 'she', 'hkg'],
  IN: ['nse', 'bom'], TH: ['bkk'], MY: ['klse'], ID: ['idx'], BR: ['bvmf'], MX: ['bmv'],
  ZA: ['jse'], SA: ['tadawul'], AE: ['adx', 'dfm'], QA: ['qse'], KW: ['kwse'], TR: ['ist'],
};

/**
 * Fund names carry share-class and par-value noise:
 * 'ALPHABET INC-CL A USD0.001' → 'ALPHABET', 'ROCHE HOLDINGS AG CHF0.001 (BR)' → 'ROCHE'.
 */
export function searchQuery(fundName: string): string {
  const words = decodeEntities(fundName).toUpperCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[-/](CL|CLASS)\b.*$/, ' ')
    .replace(/\/THE\b/, ' ')
    .split(/[\s,]+/)
    .filter((w) => w && !NOISE.has(w) && !/^[A-Z]{3}[0-9.]+$/.test(w) && !/^[0-9.]+$/.test(w));
  while (words.at(-1) === '&') words.pop();
  return words.join(' ');
}

const NOISE = new Set([
  'INC', 'INC.', 'CORP', 'CORP.', 'CORPORATION', 'CO', 'CO.', 'LTD', 'LTD.', 'LIMITED', 'PLC',
  'AG', 'SA', 'NV', 'SE', 'ASA', 'AB', 'OYJ', 'SPA', 'HOLDINGS', 'HOLDING', 'GROUP', 'NPV',
  'CL', 'CLASS', 'A', 'B', 'C', 'SHARES', 'SHS', 'ORD', 'REG', 'ADR', 'ADS', 'SPON', 'EACH', 'R',
]);

// ── profile ──────────────────────────────────────────────────────────────

export interface Profile {
  readonly isin: string | null;
  readonly sector: string | null;
  readonly industry: string | null;
  readonly country: string | null;
}

export const profile: Source<Profile> = {
  id: 'stockanalysis-profile',
  core: false,
  request: (path) => ({ url: `${SITE}${path}` }),
  parse(res) {
    const html = new TextDecoder().decode(res.body);
    if (!html.includes('>ISIN Number<') && !html.includes('>Sector<')) {
      throw new Error('no company profile table on the page');
    }
    return {
      isin: cell(html, 'ISIN Number'),
      sector: cell(html, 'Sector'),
      industry: cell(html, 'Industry'),
      country: cell(html, 'Country'),
    };
  },
  checks: [
    labelMapped('sector', (l) => knownSectorLabels('stockanalysis').has(l)),
    labelMapped('country', isKnownCountry),
    {
      name: 'isin-valid',
      run: (p) => p.isin === null || isValidIsin(p.isin) ? null
        : { check: 'isin-valid', expected: 'a valid ISIN on the profile', observed: p.isin },
    },
  ],
};

/** The value cell following a `<td>Label</td>`, tags and comments stripped. */
function cell(html: string, label: string): string | null {
  const m = new RegExp(`>${label}</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`).exec(html);
  if (!m) return null;
  const text = decodeEntities(m[1]!.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '')).trim();
  return text && text !== '-' && text !== 'n/a' ? text : null;
}

function labelMapped(field: 'sector' | 'country', known: (l: string) => boolean): Check<Profile> {
  const name = `${field}-labels-mapped`;
  return {
    name,
    run: (p) => p[field] === null || known(p[field]!) ? null
      : { check: name, expected: `a known ${field} label`, observed: `unmapped: ${p[field]}` },
  };
}
