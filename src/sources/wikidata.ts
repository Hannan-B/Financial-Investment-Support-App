/**
 * Wikidata — the fallback for a US company's SEC number.  PROJECT-PLAN.md §3
 *
 * Used only when EDGAR's own search box finds no exact ticker match. Free and
 * keyless, but volunteer-maintained, so smaller companies may be missing — and
 * whatever it returns is still confirmed against the SEC's own details before
 * use, exactly as a search-box result is.
 */
import type { Source } from '../fetch/types.ts';
import { cik10 } from './edgar.ts';

/** Every CIK recorded for a company listed under this ticker, on any exchange. */
export const wikidataCik: Source<string[]> = {
  id: 'wikidata-cik',
  core: false,
  request(ticker) {
    if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) throw new Error(`not a ticker: ${ticker}`);
    const query = `SELECT DISTINCT ?cik WHERE { ?item p:P414 ?st . ?st pq:P249 "${ticker}" . ?item wdt:P5531 ?cik . }`;
    return {
      url: `https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}`,
      headers: { accept: 'application/sparql-results+json' },
    };
  },
  parse(res) {
    const json = JSON.parse(new TextDecoder().decode(res.body)) as { results?: { bindings?: unknown } };
    if (!Array.isArray(json.results?.bindings)) throw new Error('no results in the Wikidata response');
    const ciks = (json.results.bindings as Array<{ cik?: { value?: unknown } }>)
      .map((b) => b.cik?.value)
      .filter((v): v is string => typeof v === 'string' && /^\d{1,10}$/.test(v))
      .map(cik10);
    return [...new Set(ciks)];
  },
  checks: [],
};
