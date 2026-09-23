/**
 * Waystone fund holdings — Wahed's DJIW.  PROJECT-PLAN.md §4.5
 *
 * Keyed by the fund's page name on etfs.waystone.com. A plain CSV:
 * `ISIN,TICKER,NAME,COUNTRY,SECTOR,WEIGHT`.
 *
 * ⚠️ The ISIN column repeats the FUND's own ISIN on every row, so it is
 *    discarded. TICKER is a SEDOL. Companies are matched on SEDOL or name.
 * ⚠️ SECTOR mixes levels: 'Pharmaceuticals' sits beside 'Health Care'.
 *    Mapping rolls these up (Health Care 14.99%, not 1%).
 * ⚠️ Numeric SEDOLs lose their leading zeros (AstraZeneca's 0989529 arrives
 *    as 989529), so they are padded back to seven characters.
 * ⚠️ The file carries no as-of date, so freshness cannot be checked.
 */
import type { Source } from '../fetch/types.ts';
import { parseCsv } from '../lib/csv.ts';
import { holdingsChecks, parseNumber, emptyToNull, type FundHoldings } from './holdings.ts';

const COLUMNS = ['ISIN', 'TICKER', 'NAME', 'COUNTRY', 'SECTOR', 'WEIGHT'];

export const waystone: Source<FundHoldings> = {
  id: 'waystone',
  core: true,
  request: (slug) => ({
    url: `https://etfs.waystone.com/fund/${encodeURIComponent(slug)}/?download_holdings=1`,
  }),
  parse(res) {
    const [header, ...lines] = parseCsv(new TextDecoder().decode(res.body).replace(/^﻿/, ''));
    if (header?.join(',') !== COLUMNS.join(',')) {
      throw new Error(`unexpected columns: ${header?.join(',') ?? 'none'}`);
    }
    const rows = lines.map(([, sedol, name, country, sector, weight]) => {
      const raw = emptyToNull(sedol);
      const id = raw && /^\d{1,6}$/.test(raw) ? raw.padStart(7, '0') : raw;
      if (id !== null && !/^[0-9A-Z]{7}$/.test(id)) throw new Error(`not a SEDOL: ${JSON.stringify(id)}`);
      return {
        name: name ?? '',
        weightPct: parseNumber(weight ?? ''),
        isin: null,
        sedol: id,
        country: emptyToNull(country),
        sector: emptyToNull(sector),
        currency: null,
        kind: id ? 'equity' as const : 'cash' as const,
      };
    });
    return { asOf: null, rows };
  },
  checks: holdingsChecks({ rows: [20, 500], identifier: 'sedol' }),
};
