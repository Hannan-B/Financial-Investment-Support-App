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
import { companyName } from '../lib/names.ts';
import { knownSectorLabels } from '../categories/sectors.ts';
import { isKnownCountry } from '../categories/countries.ts';
import { isCurrency, type Currency } from '../lib/money.ts';

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

/** A fund's name for a company, cleaned into a search query. */
export const searchQuery = companyName;

// ── profile ──────────────────────────────────────────────────────────────

export interface Profile {
  readonly isin: string | null;
  readonly sector: string | null;
  readonly industry: string | null;
  readonly country: string | null;
  /** How the site names and quotes this listing; null if the page lacks its info block. */
  readonly listing: ListingInfo | null;
}

export interface ListingInfo {
  /** 'LON-SHEL', 'LLY' — the same id the statement pages carry. */
  readonly uid: string;
  /** 'London Stock Exchange', 'NYSE', 'NASDAQ'. */
  readonly exchange: string;
  /** Yahoo's suffix for the exchange: '.L', '.T'; '' for the US. */
  readonly yahooSuffix: string;
  /** The currency the PRICE is quoted in — 'GBX' is pence. */
  readonly priceCurrency: string;
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
      listing: listingInfo(html),
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

/** The page's own block about this listing — not the peers and lists further down. */
function listingInfo(html: string): ListingInfo | null {
  const at = html.indexOf('data:{info:{');
  if (at < 0) return null;
  let info: string;
  try { info = objectAfter(html.slice(at + 'data:'.length), 'info'); } catch { return null; }
  const field = (name: string) => new RegExp(`[{,]${name}:"([^"]*)"`).exec(info)?.[1] ?? null;
  const uid = field('uid');
  const exchange = field('exchange');
  const priceCurrency = /curr:\{[^}]*price:"([^"]+)"/.exec(info)?.[1] ?? null;
  if (!uid || !exchange || !priceCurrency) return null;
  return { uid, exchange, yahooSuffix: field('apiext') ?? '', priceCurrency };
}

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

// ── financial statements ─────────────────────────────────────────────────
//
// Used for London and European companies (§3); US companies' figures come
// from their own SEC filings. Each statement page embeds its numbers as one
// flat object, `financialData`, in full units (not the millions the table
// shows), with the reporting currency stated separately — Vodafone's London
// listing reports in euros.

export type StatementName = 'income-statement' | 'balance-sheet' | 'cash-flow-statement';

export interface StatementColumn {
  /** '2025-12-31', or 'TTM' for the latest quarter — never part of an annual series. */
  readonly datekey: string;
  readonly fiscalYear: string;
  readonly fiscalQuarter: string;
}

export interface StatementPage {
  /** The site's identity for the company: 'LON-SHEL'. Checked against what was asked for. */
  readonly uid: string;
  readonly currency: Currency;
  readonly columns: readonly StatementColumn[];
  readonly rows: Readonly<Record<string, readonly (number | null)[]>>;
}

/** 'lon/SHEL' is a London share; a bare 'aapl' is a US one. */
function quotePath(symbol: string): string {
  return symbol.includes('/') ? `/quote/${symbol}` : `/stocks/${symbol.toLowerCase()}`;
}

/** The site's uid for a symbol: 'lon/SHEL' → 'LON-SHEL'. */
export function siteUid(symbol: string): string {
  return symbol.replace('/', '-').toUpperCase();
}

function uidOf(html: string): string {
  const m = /uid:"([^"]+)"/.exec(html);
  if (!m) throw new Error('no company id on the page');
  return m[1]!;
}

/** The text of `name:{…}` in the page's embedded data, braces matched. */
function objectAfter(html: string, name: string): string {
  const at = html.indexOf(`${name}:{`);
  if (at < 0) throw new Error(`no ${name} on the page`);
  let depth = 0;
  let inString = false;
  for (let i = at + name.length + 1; i < html.length; i++) {
    const ch = html[i];
    if (inString) { if (ch === '\\') i++; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return html.slice(at + name.length + 1, i + 1);
  }
  throw new Error(`${name} is not closed`);
}

/** Every `key:[…]` in a flat object, as JavaScript writes them: `void 0` for missing, `.75` for 0.75. */
function arrays(obj: string): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>();
  for (const m of obj.matchAll(/([A-Za-z_][A-Za-z0-9_]*):\[([^\]]*)\]/g)) {
    const json = `[${m[2]!.replace(/void 0/g, 'null').replace(/(^|,)(-?)\./g, (_, sep, sign) => `${sep}${sign}0.`)}]`;
    out.set(m[1]!, JSON.parse(json) as unknown[]);
  }
  return out;
}

export const statement: Source<StatementPage> = {
  id: 'stockanalysis-statement',
  core: true,
  /** Keyed '<symbol>|<statement>', e.g. 'lon/SHEL|balance-sheet'. */
  request(key) {
    const [symbol, which] = key.split('|');
    if (!symbol || !which) throw new Error(`not a '<symbol>|<statement>' key: ${key}`);
    return { url: `${SITE}${quotePath(symbol)}/financials/${which}/` };
  },
  parse(res) {
    const html = new TextDecoder().decode(res.body);
    const currency = /curr:\{[^}]*financial:"([^"]+)"/.exec(html)?.[1];
    if (!isCurrency(currency)) throw new Error(`unrecognised reporting currency: ${JSON.stringify(currency ?? null)}`);
    const data = arrays(objectAfter(html, 'financialData'));
    const datekey = data.get('datekey');
    const fiscalYear = data.get('fiscalYear');
    const fiscalQuarter = data.get('fiscalQuarter');
    if (!datekey || !fiscalYear || !fiscalQuarter) throw new Error('no datekey, fiscalYear and fiscalQuarter in financialData');
    const columns = datekey.map((d, i) => ({
      datekey: String(d), fiscalYear: String(fiscalYear[i] ?? ''), fiscalQuarter: String(fiscalQuarter[i] ?? ''),
    }));
    const rows: Record<string, (number | null)[]> = {};
    for (const [key, values] of data) {
      if (key === 'datekey' || key === 'fiscalYear' || key === 'fiscalQuarter') continue;
      if (values.length !== columns.length) throw new Error(`${key} has ${values.length} values for ${columns.length} columns`);
      rows[key] = values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
    }
    return { uid: uidOf(html), currency, columns, rows };
  },
  checks: [{
    name: 'annual-columns',
    run(p) {
      const annual = p.columns.filter((c) => c.datekey !== 'TTM');
      const bad = annual.find((c) => !/^\d{4}-\d{2}-\d{2}$/.test(c.datekey) || !/^\d{4}$/.test(c.fiscalYear));
      if (annual.length > 0 && !bad) return null;
      return {
        check: 'annual-columns',
        expected: 'at least one fiscal year, each with an end date and a year',
        observed: bad ? `column ${JSON.stringify(bad)}` : 'no annual columns',
      };
    },
  }],
};

// ── statistics: key statistics for any market ────────────────────────────
//
// The counterpart of Finviz's snapshot for London and European shares
// (§11.7 step 2.7). Each figure is embedded as {id, title, value, hover};
// `hover` carries the fuller number ('216,402,153,472' where the table shows
// '216.40B'). The page states its currencies, and they differ — Shell's:
//   main: GBP      company amounts, converted by the site from the reporting currency
//   price: GBX     price-based figures (the target price), in PENCE
//   dividend: GBP  dividends
//   financial: USD what the company reports in
// The reader takes nothing on trust: see research/statistics.ts.
//
// The page also carries the dates, with a sentence that says what the
// earnings date IS — "The next confirmed earnings date is …" or "The last
// earnings date was …". The date field alone does not: between announcements
// it holds the last results (Oracle, October 2026). See research/calendar.ts.

export interface StatisticsItem {
  readonly title: string;
  /** As the table shows it: 'Feb 24, 2014', 'Buy'. Null where the site withholds it (its paid tier). */
  readonly value: string | null;
  /** The fuller figure: '216,402,153,472', '-6.424%', 'n/a'. */
  readonly hover: string | null;
}

export interface StatisticsPage {
  readonly uid: string;
  /** The site's currency codes, as written: 'GBP', 'GBX'. */
  readonly currencies: { readonly main: string; readonly price: string; readonly dividend: string; readonly financial: string };
  /** The price on the page, in `currencies.price`. */
  readonly price: number;
  readonly items: ReadonlyMap<string, StatisticsItem>;
  /** What the page says about the earnings date, in its own words; null if it says nothing. */
  readonly datesText: string | null;
}

/** Figures the reader depends on; a page without them has changed layout. */
const STATISTICS_EXPECTED = ['marketcap', 'sharesout', 'pe', 'debtEquity', 'employees'];

const STRING_OR_NULL = String.raw`(null|"(?:[^"\\]|\\.)*")`;
const ITEM = new RegExp(String.raw`\{id:"(\w+)",title:"((?:[^"\\]|\\.)*)",value:${STRING_OR_NULL},hover:${STRING_OR_NULL}`, 'g');

export const statistics: Source<StatisticsPage> = {
  id: 'stockanalysis-statistics',
  core: false,
  request: (symbol) => ({ url: `${SITE}${quotePath(symbol)}/statistics/` }),
  parse(res) {
    const html = new TextDecoder().decode(res.body);
    const at = html.indexOf('data:{info:{');
    if (at < 0) throw new Error('no listing information on the page');
    const info = objectAfter(html.slice(at + 'data:'.length), 'info');
    const curr = /curr:\{([^}]*)\}/.exec(info)?.[1] ?? '';
    const code = (name: string) => {
      const c = new RegExp(`${name}:"([^"]*)"`).exec(curr)?.[1];
      if (!c) throw new Error(`the page states no ${name} currency`);
      return c;
    };
    const price = Number(/[{,]p:(-?\d+(?:\.\d+)?)[,}]/.exec(objectAfter(info, 'quote'))?.[1] ?? NaN);
    if (!Number.isFinite(price) || price <= 0) throw new Error('no price on the page');
    const items = new Map<string, StatisticsItem>();
    const text = (s: string) => (s === 'null' ? null : JSON.parse(s) as string);
    const dates = /dates:\{text:("(?:[^"\\]|\\.)*")/.exec(html)?.[1];
    for (const m of html.matchAll(ITEM)) {
      if (!items.has(m[1]!)) items.set(m[1]!, { title: JSON.parse(`"${m[2]!}"`) as string, value: text(m[3]!), hover: text(m[4]!) });
    }
    return {
      uid: uidOf(html),
      currencies: { main: code('main'), price: code('price'), dividend: code('dividend'), financial: code('financial') },
      price,
      items,
      datesText: dates ? JSON.parse(dates) as string : null,
    };
  },
  checks: [{
    name: 'statistics-present',
    run(p) {
      const missing = STATISTICS_EXPECTED.filter((id) => !p.items.has(id));
      return missing.length === 0 ? null
        : { check: 'statistics-present', expected: `the page to include ${STATISTICS_EXPECTED.join(', ')}`, observed: `missing: ${missing.join(', ')}` };
    },
  }],
};
