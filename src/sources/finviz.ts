/**
 * Finviz — US listings only; optional.  PROJECT-PLAN.md §3, §7.1
 *
 * One page per company, read once per refresh: `/stock?t=TICKER` (it moved
 * from /quote.ashx in September 2026; robots.txt permits it). Never /export,
 * /screener or /api. Anything outside the US answers 404 — and a London
 * ticker is never swapped for the New York one that does exist (§3: SHEL.L
 * is not SHEL).
 */
import type { Source } from '../fetch/types.ts';
import { decodeEntities } from './holdings.ts';

export interface FinvizPage {
  /** The ticker the page is about — checked against the one asked for. */
  readonly ticker: string;
  /** The snapshot table, label → value, in page order. Labels can repeat ('EPS next Y'). */
  readonly fields: readonly (readonly [string, string])[];
  /**
   * The insider table (§11.7 step 2.8), as written: its headings and each
   * row's cells, with the row's link to the SEC filing. Null when the page has
   * none — a company that files no Form 4s, such as Shell's New York shares.
   */
  readonly insiders: { readonly headings: readonly string[]; readonly rows: readonly InsiderRow[] } | null;
}

export interface InsiderRow {
  readonly cells: readonly string[];
  readonly filing: string | null;
}

/** Labels the reader depends on; a page without them has changed layout. */
const EXPECTED = ['Market Cap', 'P/E', 'Price', 'Target Price', 'Recom'];

const text = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, '')).trim();

/** The table headed "Insider Trading" — seen live 2026-11-02 as nine columns, at most 100 rows. */
function insiderTable(html: string): FinvizPage['insiders'] {
  const at = html.indexOf('>Insider Trading</th>');
  if (at < 0) return null;
  const start = html.lastIndexOf('<table', at);
  const end = html.indexOf('</table>', at);
  // Judged by the insider reader, not here: a broken insider table must not cost the key statistics.
  if (start < 0 || end < 0) return { headings: [], rows: [] };
  const table = html.slice(start, end);
  const headings = [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]!));
  const rows = [...table.matchAll(/<tr class="fv-insider-row[^"]*"[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => ({
    cells: [...m[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => text(c[1]!)),
    filing: /href="(https?:\/\/www\.sec\.gov\/[^"]+)"/.exec(m[1]!)?.[1] ?? null,
  }));
  return { headings, rows };
}

export const finviz: Source<FinvizPage> = {
  id: 'finviz',
  core: false,
  request(ticker) {
    if (!/^[A-Z0-9.\-]{1,10}$/.test(ticker)) throw new Error(`not a ticker: ${ticker}`);
    return { url: `https://finviz.com/stock?t=${encodeURIComponent(ticker)}` };
  },
  parse(res) {
    const html = new TextDecoder().decode(res.body);
    const ticker = /<h1[^>]*data-ticker="([^"]+)"/.exec(html)?.[1];
    if (!ticker) throw new Error('no ticker heading on the page');
    // The snapshot is drawn as six side-by-side tables, each marked snapshot-table2.
    const tables = [...html.matchAll(/<table[^>]*snapshot-table2[^>]*>([\s\S]*?)<\/table>/g)].map((m) => m[1]!);
    if (tables.length === 0) throw new Error('no snapshot table on the page');
    const cells = tables.flatMap((t) => [...t.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]).map((m) => text(m[1]!));
    if (cells.length % 2 !== 0) throw new Error(`snapshot table has an odd number of cells (${cells.length})`);
    const fields: (readonly [string, string])[] = [];
    for (let i = 0; i < cells.length; i += 2) fields.push([cells[i]!, cells[i + 1]!]);
    return { ticker: ticker.toUpperCase(), fields, insiders: insiderTable(html) };
  },
  checks: [{
    name: 'snapshot-labels',
    run(p) {
      const labels = new Set(p.fields.map(([l]) => l));
      const missing = EXPECTED.filter((l) => !labels.has(l));
      return missing.length === 0 ? null
        : { check: 'snapshot-labels', expected: `the snapshot to include ${EXPECTED.join(', ')}`, observed: `missing: ${missing.join(', ')}` };
    },
  }],
};
