/**
 * HSBC fund holdings.  PROJECT-PLAN.md §4.2
 *
 * Keyed by the fund's ISIN. A legacy OLE2 `.xls`, decoded by Rust
 * (`ParseTools.xlsRows`). Supplies country but no sector — HSBC follows the
 * same MSCI Islamic rules as iShares, so iShares classifies ~99% of it.
 *
 * Layout: a few header rows (`Date` holds an Excel serial date), then a
 * table headed `ISIN, CUSIP, SecurityName, …, Country, LocalCurrencyCode,
 * Weighting`. Cash and accrual lines have no ISIN and can be negative.
 *
 * The document endpoint needs no investor-terms gate (the fund pages do).
 * It answers with a `301` to a lower-cased ISIN, so request that directly.
 */
import type { Source } from '../fetch/types.ts';
import { holdingsChecks, parseNumber, excelSerialDate, emptyToNull, type FundHoldings } from './holdings.ts';

export function makeHsbc(now?: () => Date): Source<FundHoldings> {
  return {
    id: 'hsbc',
    core: true,
    request: (isin) => ({
      url: `https://www.assetmanagement.hsbc.co.uk/api/v1/download/document/${encodeURIComponent(isin.toLowerCase())}/gb/en/holdings`,
    }),
    async parse(res, tools) {
      const sheet = await tools.xlsRows(res.body);

      const dateRow = sheet.find((r) => r[0] === 'Date');
      if (!dateRow?.[1]) throw new Error('no Date row');
      const asOf = excelSerialDate(dateRow[1]);

      const headerAt = sheet.findIndex((r) => r[0] === 'ISIN');
      if (headerAt < 0) throw new Error('no table headed ISIN');
      const header = sheet[headerAt]!;
      const at = (name: string): number => {
        const i = header.indexOf(name);
        if (i < 0) throw new Error(`missing column: ${name}`);
        return i;
      };
      const [isin, name, country, currency, weight] =
        ['ISIN', 'SecurityName', 'Country', 'LocalCurrencyCode', 'Weighting'].map(at) as [number, number, number, number, number];

      const rows = sheet.slice(headerAt + 1)
        .filter((r) => r.some((cell) => cell.trim() !== ''))
        .map((r) => {
          const id = emptyToNull(r[isin]);
          return {
            name: r[name] ?? '',
            weightPct: parseNumber(r[weight] ?? ''),
            isin: id,
            sedol: null,
            country: emptyToNull(r[country]),
            sector: null,
            currency: emptyToNull(r[currency]),
            kind: id ? 'equity' as const : 'cash' as const,
          };
        });
      return { asOf, rows };
    },
    checks: holdingsChecks({ rows: [20, 1500], maxAgeDays: 10, countries: true, identifier: 'isin', ...(now ? { now } : {}) }),
  };
}

export const hsbc = makeHsbc();
