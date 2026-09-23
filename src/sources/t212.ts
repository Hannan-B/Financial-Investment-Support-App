/**
 * Trading 212 — holdings, and what kind of thing each one is.
 * PROJECT-PLAN.md §8.2
 *
 * Requests are PATHS, not URLs: the transport is Rust's `t212_get`, which
 * holds the key and refuses any path not on its read-only allow-list. The
 * frontend never sees the key and cannot name an order endpoint.
 *
 * Values arrive in the account currency — GBP for this ISA — so the portfolio
 * needs no currency conversion (§11.1).
 */
import type { Source, Check } from '../fetch/types.ts';
import { rowCountBetween } from '../fetch/checks.ts';
import { isValidIsin } from './holdings.ts';

export interface HeldPosition {
  readonly isin: string;
  readonly name: string;
  /** T212's own code, e.g. 'IGDAl_EQ'. */
  readonly ticker: string;
  readonly quantity: number;
  /** In the instrument's own currency — ⚠️ T212 writes pence as 'GBX'. */
  readonly averagePricePaid: number;
  readonly priceCurrency: string;
  /** Current value in the account currency. */
  readonly value: number;
  readonly accountCurrency: string;
}

export const positions: Source<HeldPosition[]> = {
  id: 't212-positions',
  core: true,
  request: () => ({ url: '/api/v0/equity/positions' }),
  parse(res) {
    const json = JSON.parse(new TextDecoder().decode(res.body)) as unknown;
    if (!Array.isArray(json)) throw new Error('positions: expected an array');
    return json.map((p: any) => {
      const i = p?.instrument;
      const w = p?.walletImpact;
      if (typeof i?.isin !== 'string' || typeof w?.currentValue !== 'number' || typeof p?.quantity !== 'number') {
        throw new Error(`unexpected position shape: ${JSON.stringify(p).slice(0, 160)}`);
      }
      return {
        isin: i.isin,
        name: String(i.name ?? i.ticker ?? i.isin),
        ticker: String(i.ticker ?? ''),
        quantity: p.quantity,
        averagePricePaid: Number(p.averagePricePaid),
        priceCurrency: String(i.currency ?? ''),
        value: w.currentValue,
        accountCurrency: String(w.currency ?? ''),
      };
    });
  },
  checks: [
    rowCountBetween<HeldPosition>(0, 1000),
    {
      name: 'account-currency',
      run(ps) {
        const other = ps.filter((p) => p.accountCurrency !== 'GBP');
        return other.length === 0 ? null : {
          check: 'account-currency',
          expected: 'values in GBP (the ISA account currency)',
          observed: `${other.length} in ${[...new Set(other.map((p) => p.accountCurrency))].join(', ')}`,
        };
      },
    },
    {
      name: 'isins-valid',
      run(ps) {
        const bad = ps.filter((p) => !isValidIsin(p.isin));
        return bad.length === 0 ? null
          : { check: 'isins-valid', expected: 'a valid ISIN on every position', observed: bad.map((p) => p.isin).join(', ') };
      },
    },
    {
      name: 'values-sane',
      run(ps) {
        const bad = ps.filter((p) => !Number.isFinite(p.value) || p.value < 0 || p.quantity <= 0);
        return bad.length === 0 ? null
          : { check: 'values-sane', expected: 'positive quantities and values', observed: bad.map((p) => p.name).join(', ') };
      },
    },
  ] satisfies Check<HeldPosition[]>[],
};

export type InstrumentType = 'ETF' | 'STOCK' | string;

/**
 * Every instrument T212 offers: ~15,000 rows, limited to one request every
 * 50 seconds. Fetched only when a holding's type is not yet known.
 */
export const instruments: Source<Map<string, InstrumentType>> = {
  id: 't212-instruments',
  core: false,
  request: () => ({ url: '/api/v0/equity/metadata/instruments' }),
  parse(res) {
    const json = JSON.parse(new TextDecoder().decode(res.body)) as unknown;
    if (!Array.isArray(json)) throw new Error('instruments: expected an array');
    const types = new Map<string, InstrumentType>();
    for (const i of json as Array<{ isin?: unknown; type?: unknown }>) {
      if (typeof i.isin === 'string' && typeof i.type === 'string') types.set(i.isin, i.type);
    }
    return types;
  },
  checks: [],
};
