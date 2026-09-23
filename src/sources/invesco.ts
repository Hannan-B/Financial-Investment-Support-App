/**
 * Invesco fund holdings.  PROJECT-PLAN.md §4.2
 *
 * Keyed by the fund's ISIN. Supplies name, ISIN and weight only — no sector,
 * no country. Those come from the security master, filled by iShares and by
 * company lookups.
 *
 * ⚠️ Throttles with `406`, not `429` (run.ts treats it as unavailable).
 * ⚠️ As of 2026-09-23 it answers a plain request, and REFUSES one carrying
 *    `origin: https://www.invesco.com` — the opposite of what was recorded on
 *    2026-09-22. Send no extra headers.
 */
import type { Source } from '../fetch/types.ts';
import { holdingsChecks, decodeEntities, emptyToNull, type FundHoldings } from './holdings.ts';

interface Row { name?: unknown; isin?: unknown; weight?: unknown; }

export function makeInvesco(now?: () => Date): Source<FundHoldings> {
  return {
    id: 'invesco',
    core: true,
    request: (isin) => ({
      url: `https://dng-api.invesco.com/cache/v1/accounts/en_GB/shareclasses/${encodeURIComponent(isin)}` +
        '/holdings/index?idType=isin&loadType=initial',
    }),
    parse(res) {
      const json = JSON.parse(new TextDecoder().decode(res.body)) as { effectiveDate?: unknown; holdings?: unknown };
      if (!Array.isArray(json.holdings)) throw new Error('no holdings array in the response');
      if (typeof json.effectiveDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(json.effectiveDate)) {
        throw new Error(`unrecognised effectiveDate: ${JSON.stringify(json.effectiveDate)}`);
      }
      const rows = (json.holdings as Row[]).map((h) => {
        if (typeof h.weight !== 'number' || typeof h.name !== 'string') {
          throw new Error(`unexpected holding shape: ${JSON.stringify(h).slice(0, 120)}`);
        }
        const isin = typeof h.isin === 'string' ? emptyToNull(h.isin) : null;
        return {
          name: decodeEntities(h.name),
          weightPct: h.weight,
          isin,
          sedol: null,
          country: null,
          sector: null,
          currency: null,
          // The only row without an ISIN is 'Cash and/or Derivatives'.
          kind: isin ? 'equity' as const : 'cash' as const,
        };
      });
      return { asOf: json.effectiveDate, rows };
    },
    checks: holdingsChecks({ rows: [30, 3000], maxAgeDays: 10, identifier: 'isin', ...(now ? { now } : {}) }),
  };
}

export const invesco = makeInvesco();
