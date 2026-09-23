/**
 * iShares fund holdings.  PROJECT-PLAN.md §4.2
 *
 * Keyed by iShares' own `portfolioId`, not ISIN (see funds.ts).
 *
 * The only fund source with company sectors — so it is also fetched as
 * REFERENCE data for funds that lack them, whether or not an iShares fund is
 * held (HSBC: ~99% of weight classified this way).
 *
 * ⚠️ Moved on 2026-09-23 from ishares.com to blackrock.com. The response is
 * column-oriented: each field is a parallel array under `dataPointsByNameMap`.
 * Without `asOfDate` it returns the latest holdings.
 */
import type { Source } from '../fetch/types.ts';
import {
  holdingsChecks, parseNumber, parseDayMonthYear, emptyToNull,
  type FundHoldings, type Constituent,
} from './holdings.ts';

const BASE = 'https://www.blackrock.com/varnish-api/uk-retail01-product-data/product-data/api/v2/get-product-data';

export function makeIshares(now?: () => Date): Source<FundHoldings> {
  return {
    id: 'ishares',
    core: true,
    request: (portfolioId) => ({
      url: `${BASE}?component=holdings.all&portfolioId=${encodeURIComponent(portfolioId)}` +
        '&locale=en_GB&targetSite=ishares-uk&portfolioType=ISHARES_FUND_DATA',
    }),
    parse(res) {
      const json = JSON.parse(new TextDecoder().decode(res.body));
      const cols = json?.componentsByNameMap?.holdings?.containersByNameMap?.all?.dataPointsByNameMap;
      if (!cols) throw new Error('no holdings table in the response');

      const col = (name: string): string[] => {
        const values = cols[name]?.formattedValue;
        if (!Array.isArray(values)) throw new Error(`missing column: ${name}`);
        return values.map((v: unknown) => String(v ?? ''));
      };
      const isin = col('isin');
      const name = col('issueName');
      const weight = col('holdingPercent');
      const sector = col('sectorName');
      const country = col('countryOfRisk');
      const currency = col('marketCurrencyCode');
      const assetClass = col('assetClass');
      for (const c of [name, weight, sector, country, currency, assetClass]) {
        if (c.length !== isin.length) throw new Error('columns have different lengths');
      }

      const rows = isin.map((id, i): Constituent => ({
        name: name[i]!,
        weightPct: parseNumber(weight[i]!),
        isin: id === '-' ? null : emptyToNull(id),
        sedol: null,
        country: emptyToNull(country[i]),
        sector: emptyToNull(sector[i]),
        currency: emptyToNull(currency[i]),
        kind: assetClass[i] === 'Equity' ? 'equity' : 'cash',
      }));
      return { asOf: parseDayMonthYear(String(cols.asOfDate?.formattedValue ?? '')), rows };
    },
    checks: holdingsChecks({ rows: [50, 3000], maxAgeDays: 10, identifier: 'isin', ...(now ? { now } : {}) }),
  };
}

export const ishares = makeIshares();
