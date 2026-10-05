/**
 * SEC EDGAR — US companies' own filed figures.  PROJECT-PLAN.md §3
 *
 * Three requests, none needing a contact email (settled 2026-09-23):
 *   · the EDGAR website's company search box, to find a ticker's SEC number (CIK)
 *   · the company's details, to confirm that number really is that listing
 *   · one figure ("concept") at a time, e.g. us-gaap/Revenues
 * The master ticker list (www.sec.gov) is deliberately not used: it refuses
 * requests without an email.
 *
 * ⚠️ The search box is what EDGAR's own website uses, not a documented data
 *    service. It is read like any other website, and checked like one.
 */
import type { Source } from '../fetch/types.ts';

const DATA = 'https://data.sec.gov';

/** A CIK written as EDGAR's file names want it: ten digits. */
export function cik10(cik: string | number): string {
  const digits = String(cik).replace(/^CIK/i, '');
  if (!/^\d{1,10}$/.test(digits)) throw new Error(`not a CIK: ${cik}`);
  return digits.padStart(10, '0');
}

// ── the search box ───────────────────────────────────────────────────────

export interface EdgarHit {
  readonly cik: string;
  readonly name: string;
  /** Upper-cased; empty for entities with no listed shares. */
  readonly tickers: readonly string[];
}

export const edgarSearch: Source<EdgarHit[]> = {
  id: 'edgar-search',
  core: false,
  request: (ticker) => ({ url: `https://efts.sec.gov/LATEST/search-index?keysTyped=${encodeURIComponent(ticker)}` }),
  parse(res) {
    const json = JSON.parse(new TextDecoder().decode(res.body)) as { hits?: { hits?: unknown } };
    if (!Array.isArray(json.hits?.hits)) throw new Error('no hits array in the search response');
    return (json.hits.hits as Array<{ _id?: unknown; _source?: { entity?: unknown; tickers?: unknown } }>).map((h) => {
      if (typeof h._id !== 'string') throw new Error(`unexpected hit: ${JSON.stringify(h).slice(0, 120)}`);
      const tickers = typeof h._source?.tickers === 'string' ? h._source.tickers : '';
      return {
        cik: cik10(h._id),
        name: String(h._source?.entity ?? ''),
        tickers: tickers.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean),
      };
    });
  },
  checks: [],
};

// ── the company's own details ────────────────────────────────────────────

export interface EdgarCompany {
  readonly cik: string;
  readonly name: string;
  /** Paired with `exchanges`, position for position. */
  readonly tickers: readonly string[];
  readonly exchanges: readonly string[];
}

export const edgarSubmissions: Source<EdgarCompany> = {
  id: 'edgar-submissions',
  core: true,
  request: (cik) => ({ url: `${DATA}/submissions/CIK${cik10(cik)}.json` }),
  parse(res) {
    const json = JSON.parse(new TextDecoder().decode(res.body)) as Record<string, unknown>;
    const { cik, name, tickers, exchanges } = json;
    if (typeof name !== 'string' || !Array.isArray(tickers) || !Array.isArray(exchanges)) {
      throw new Error('company details without a name, tickers and exchanges');
    }
    return {
      cik: cik10(String(cik)),
      name,
      tickers: tickers.map((t) => String(t).toUpperCase()),
      exchanges: exchanges.map((e) => String(e ?? '')),
    };
  },
  checks: [{
    name: 'tickers-paired',
    run: (c) => c.tickers.length === c.exchanges.length ? null
      : { check: 'tickers-paired', expected: 'one exchange per ticker', observed: `${c.tickers.length} tickers, ${c.exchanges.length} exchanges` },
  }],
};

// ── one figure ───────────────────────────────────────────────────────────

/** One value as filed. Durations (revenue) have a start; balances (assets) do not. */
export interface EdgarFact {
  readonly unit: string;
  readonly start: string | null;
  readonly end: string;
  readonly value: number;
  /** The fiscal year and period of the FILING it appeared in — not necessarily of the value. */
  readonly fy: number | null;
  readonly fp: string | null;
  readonly form: string;
  readonly filed: string;
  readonly accn: string;
}

export interface EdgarConcept {
  readonly tag: string;
  readonly facts: readonly EdgarFact[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Keyed '<cik>:<tag>', e.g. '0000104169:Revenues'. A company that never used the tag answers 404. */
export const edgarConcept: Source<EdgarConcept> = {
  id: 'edgar-concept',
  core: true,
  missingIsAnswer: true,
  request(key) {
    const [cik, tag] = key.split(':');
    if (!cik || !tag || !/^[A-Za-z]+$/.test(tag)) throw new Error(`not a '<cik>:<tag>' key: ${key}`);
    return { url: `${DATA}/api/xbrl/companyconcept/CIK${cik10(cik)}/us-gaap/${tag}.json` };
  },
  parse(res) {
    const json = JSON.parse(new TextDecoder().decode(res.body)) as { tag?: unknown; units?: unknown };
    if (typeof json.tag !== 'string' || typeof json.units !== 'object' || json.units === null) {
      throw new Error('no tag and units in the concept response');
    }
    const facts: EdgarFact[] = [];
    for (const [unit, list] of Object.entries(json.units as Record<string, unknown>)) {
      if (!Array.isArray(list)) throw new Error(`units.${unit} is not a list`);
      for (const f of list as Array<Record<string, unknown>>) {
        if (typeof f['val'] !== 'number' || !Number.isFinite(f['val'])) throw new Error(`non-numeric value in ${unit}`);
        if (typeof f['end'] !== 'string' || !DATE.test(f['end'])) throw new Error(`bad end date: ${String(f['end'])}`);
        if (typeof f['filed'] !== 'string' || !DATE.test(f['filed'])) throw new Error(`bad filing date: ${String(f['filed'])}`);
        facts.push({
          unit,
          start: typeof f['start'] === 'string' ? f['start'] : null,
          end: f['end'],
          value: f['val'],
          fy: typeof f['fy'] === 'number' ? f['fy'] : null,
          fp: typeof f['fp'] === 'string' ? f['fp'] : null,
          form: String(f['form'] ?? ''),
          filed: f['filed'],
          accn: String(f['accn'] ?? ''),
        });
      }
    }
    return { tag: json.tag, facts };
  },
  checks: [{
    name: 'has-values',
    run: (c) => c.facts.length > 0 ? null : { check: 'has-values', expected: 'at least one filed value', observed: 'none' },
  }],
};

// ── the company's filings: official announcements for the news panel (§6.6) ──

export interface Filing {
  readonly form: string;
  /** 'YYYY-MM-DD' */
  readonly filed: string;
  /** 8-K item codes: ['2.02', '9.01']. */
  readonly items: readonly string[];
  /** The filing's own page on sec.gov. */
  readonly url: string;
  readonly description: string;
}

/** Keyed by CIK; the same response as the company's details, read for its filings. */
export const edgarFilings: Source<Filing[]> = {
  id: 'edgar-filings',
  core: false,
  request: (cik) => ({ url: `${DATA}/submissions/CIK${cik10(cik)}.json` }),
  parse(res) {
    const json = JSON.parse(new TextDecoder().decode(res.body)) as { cik?: unknown; filings?: { recent?: Record<string, unknown> } };
    const r = json.filings?.recent;
    const columns = ['accessionNumber', 'filingDate', 'form', 'items', 'primaryDocument', 'primaryDocDescription'] as const;
    if (!r || !columns.every((c) => Array.isArray(r[c]))) throw new Error('no recent filings in the company details');
    const col = (c: (typeof columns)[number]) => r[c] as unknown[];
    const n = col('form').length;
    if (!columns.every((c) => col(c).length === n)) throw new Error('filing columns have different lengths');
    const cik = String(Number(cik10(String(json.cik))));
    return col('form').map((form, i) => {
      const accession = String(col('accessionNumber')[i]);
      const filed = String(col('filingDate')[i]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(filed)) throw new Error(`bad filing date: ${filed}`);
      return {
        form: String(form),
        filed,
        items: String(col('items')[i] ?? '').split(',').map((x) => x.trim()).filter(Boolean),
        url: `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}/${String(col('primaryDocument')[i])}`,
        description: String(col('primaryDocDescription')[i] ?? ''),
      };
    });
  },
  checks: [],
};
