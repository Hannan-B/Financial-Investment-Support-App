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
  /** What the holding cost, in the account currency (walletImpact.totalCost); null if not given. */
  readonly totalCost: number | null;
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
        totalCost: typeof w.totalCost === 'number' && Number.isFinite(w.totalCost) ? w.totalCost : null,
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

export interface Instrument {
  /** T212's own code: 'AAPL_US_EQ', 'SHELl_EQ'. */
  readonly ticker: string;
  readonly isin: string;
  readonly name: string;
  /** The ticker as people write it: 'AAPL', 'SHEL'. */
  readonly shortName: string;
  /** ⚠️ 'GBX' is pence. */
  readonly currency: string;
  readonly type: InstrumentType;
}

/**
 * Every instrument T212 offers: ~15,000 rows, limited to one request every
 * 50 seconds. Fetched when a holding's type is not yet known, and to search
 * for a company to research (§7.2).
 */
export const instruments: Source<Instrument[]> = {
  id: 't212-instruments',
  core: false,
  request: () => ({ url: '/api/v0/equity/metadata/instruments' }),
  parse(res) {
    const json = JSON.parse(new TextDecoder().decode(res.body)) as unknown;
    if (!Array.isArray(json)) throw new Error('instruments: expected an array');
    const out: Instrument[] = [];
    for (const i of json as Array<Record<string, unknown>>) {
      const { ticker, isin, name, shortName, currencyCode, type } = i;
      if (typeof ticker !== 'string' || typeof isin !== 'string' || typeof type !== 'string') continue;
      out.push({
        ticker, isin, type,
        name: typeof name === 'string' ? name : ticker,
        shortName: typeof shortName === 'string' ? shortName : ticker,
        currency: typeof currencyCode === 'string' ? currencyCode : '',
      });
    }
    return out;
  },
  checks: [rowCountBetween<Instrument>(1, 100_000)],
};

// ── history, in pages (§11.10 steps 5.2 and 5.4) ─────────────────────────
//
// Read 2026-11-13 from docs.trading212.com (API "v0", "Beta"): 50 items a
// page at most; `nextPagePath` is the next request, null at the end; 20
// requests a minute. Rust allows these paths with page parameters only.

export interface HistoryPage<T> {
  readonly items: readonly T[];
  /** The next page's path, or null at the end. */
  readonly next: string | null;
}

/** The documentation says to use `nextPagePath` whole; it is made a full path if it starts below `/api/v0`. */
export function nextPath(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error(`nextPagePath is not text: ${JSON.stringify(value)}`);
  if (value.startsWith('/api/v0/')) return value;
  if (value.startsWith('/equity/')) return `/api/v0${value}`;
  if (value.startsWith('api/v0/')) return `/${value}`;
  throw new Error(`unrecognised nextPagePath: ${value.slice(0, 120)}`);
}

export interface Dividend {
  /** Trading 212's own: a payment is stored once. */
  readonly reference: string;
  readonly isin: string;
  readonly ticker: string;
  readonly name: string;
  /** As Trading 212 gives it. */
  readonly paidOn: string;
  /** "In account's primary currency" (the documentation): pounds for this ISA. */
  readonly amount: number;
  readonly currency: string;
  readonly quantity: number;
  /** "In instrument currency": ⚠️ GBX is pence. */
  readonly grossPerShare: number | null;
  readonly shareCurrency: string | null;
  /** Trading 212's own word: ORDINARY, INTEREST, RETURN_OF_CAPITAL… (58 kinds). */
  readonly type: string;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function pageOf(res: { body: Uint8Array }): { items: unknown[]; next: string | null } {
  const json = JSON.parse(new TextDecoder().decode(res.body)) as { items?: unknown; nextPagePath?: unknown };
  if (!json || !Array.isArray(json.items)) throw new Error('expected { items: [...] }');
  return { items: json.items, next: nextPath(json.nextPagePath) };
}

export const DIVIDENDS_FIRST = '/api/v0/equity/history/dividends?limit=50';
export const ORDERS_FIRST = '/api/v0/equity/history/orders?limit=50';

export const dividends: Source<HistoryPage<Dividend>> = {
  id: 't212-dividends',
  core: false,
  request: (path) => ({ url: path || DIVIDENDS_FIRST }),
  parse(res) {
    const page = pageOf(res);
    return {
      next: page.next,
      items: page.items.map((d: any) => {
        const i = d?.instrument ?? {};
        const isin = typeof i.isin === 'string' ? i.isin : d?.isin;
        const amount = num(d?.amount);
        const quantity = num(d?.quantity);
        if (typeof d?.reference !== 'string' || typeof isin !== 'string' || amount === null || quantity === null
          || typeof d?.paidOn !== 'string' || typeof d?.type !== 'string') {
          throw new Error(`unexpected dividend shape: ${JSON.stringify(d).slice(0, 200)}`);
        }
        return {
          reference: d.reference, isin, amount, quantity, paidOn: d.paidOn, type: d.type,
          ticker: String(d.ticker ?? i.ticker ?? ''),
          name: String(i.name ?? d.ticker ?? isin),
          currency: String(d.currency ?? ''),
          grossPerShare: num(d.grossAmountPerShare),
          shareCurrency: typeof (d.tickerCurrency ?? i.currency) === 'string' ? String(d.tickerCurrency ?? i.currency) : null,
        };
      }),
    };
  },
  checks: [
    {
      name: 'account-currency',
      run(p) {
        const other = p.items.filter((d) => d.currency !== 'GBP');
        return other.length === 0 ? null : {
          check: 'account-currency', expected: 'every payment in GBP (the ISA account currency)',
          observed: `${other.length} in ${[...new Set(other.map((d) => d.currency || 'no currency'))].join(', ')}`,
        };
      },
    },
    {
      name: 'dividends-sane',
      run(p) {
        const bad = p.items.find((d) => !isValidIsin(d.isin) || d.quantity <= 0 || !/^\d{4}-\d{2}-\d{2}/.test(d.paidOn));
        return bad ? { check: 'dividends-sane', expected: 'a valid ISIN, units above zero and a date on every payment', observed: `${bad.reference}: ${bad.isin}, ${bad.quantity}, ${bad.paidOn}` } : null;
      },
    },
    {
      // Where the share is priced in pounds or pence the payment can be checked
      // against units × amount per unit: it can be less (tax), never more.
      name: 'paid-no-more-than-units-times-rate',
      run(p) {
        const bad = p.items.find((d) => {
          if (d.grossPerShare === null || (d.shareCurrency !== 'GBP' && d.shareCurrency !== 'GBX')) return false;
          const gross = d.quantity * d.grossPerShare / (d.shareCurrency === 'GBX' ? 100 : 1);
          return d.amount > gross * 1.02 + 0.01;
        });
        return bad ? {
          check: 'paid-no-more-than-units-times-rate', expected: 'a payment no larger than units × amount per unit',
          observed: `${bad.reference}: £${bad.amount} for ${bad.quantity} × ${bad.grossPerShare} ${bad.shareCurrency}`,
        } : null;
      },
    },
  ] satisfies Check<HistoryPage<Dividend>>[],
};

export interface Sale {
  readonly fillId: number;
  readonly orderId: number;
  readonly isin: string;
  readonly ticker: string;
  readonly name: string;
  readonly filledAt: string;
  /** Units sold, positive. */
  readonly quantity: number;
  readonly price: number;
  /** The share's currency — ⚠️ GBX is pence. */
  readonly priceCurrency: string;
  readonly netValue: number | null;
  readonly realisedPl: number | null;
  /** Undocumented: which currency netValue and realisedProfitLoss are in. */
  readonly walletCurrency: string | null;
  readonly fxRate: number | null;
  /**
   * The profit is taken only when its currency is pounds AND the net value
   * agrees with units × price (in pounds, with or without Trading 212's
   * fxRate either way round, within 2%). The documentation describes none of
   * these fields (2026-11-13), so each sale is checked on arrival.
   */
  readonly profitChecked: boolean;
}

/** Does the sale's net value agree with units × price? */
export function agrees(s: Omit<Sale, 'profitChecked'>): boolean {
  if (s.walletCurrency !== 'GBP' || s.netValue === null || s.realisedPl === null) return false;
  const gross = s.quantity * s.price;
  const candidates = s.priceCurrency === 'GBX' ? [gross / 100]
    : s.priceCurrency === 'GBP' ? [gross]
    : s.fxRate ? [gross / s.fxRate, gross * s.fxRate] : [];
  const net = Math.abs(s.netValue);
  return candidates.some((c) => c > 0 && Math.abs(net - c) / c <= 0.02);
}

/** Past orders; only filled sales are kept (buys and cancellations are not needed). */
export const sales: Source<HistoryPage<Sale> & { readonly skipped: number }> = {
  id: 't212-orders',
  core: false,
  request: (path) => ({ url: path || ORDERS_FIRST }),
  parse(res) {
    const page = pageOf(res);
    const items: Sale[] = [];
    let skipped = 0;
    for (const h of page.items as any[]) {
      const o = h?.order, f = h?.fill;
      if (!o || typeof o.side !== 'string') throw new Error(`unexpected order shape: ${JSON.stringify(h).slice(0, 200)}`);
      if (o.side !== 'SELL' || !f || (f.type ?? 'TRADE') !== 'TRADE' || !['FILLED', 'PARTIALLY_FILLED'].includes(o.status)) { skipped++; continue; }
      const i = o.instrument ?? {};
      const w = f.walletImpact ?? {};
      const quantity = num(f.quantity), price = num(f.price);
      if (typeof f.id !== 'number' || typeof o.id !== 'number' || typeof i.isin !== 'string' || quantity === null || price === null || typeof f.filledAt !== 'string') {
        throw new Error(`unexpected sale shape: ${JSON.stringify(h).slice(0, 200)}`);
      }
      const base = {
        fillId: f.id, orderId: o.id, isin: i.isin, ticker: String(i.ticker ?? o.ticker ?? ''), name: String(i.name ?? o.ticker ?? i.isin),
        filledAt: f.filledAt, quantity: Math.abs(quantity), price, priceCurrency: String(i.currency ?? o.currency ?? ''),
        netValue: num(w.netValue), realisedPl: num(w.realisedProfitLoss),
        walletCurrency: typeof w.currency === 'string' ? w.currency : null, fxRate: num(w.fxRate),
      };
      items.push({ ...base, profitChecked: agrees(base) });
    }
    return { items, next: page.next, skipped };
  },
  checks: [
    {
      name: 'sales-sane',
      run(p) {
        const bad = p.items.find((s) => !isValidIsin(s.isin) || s.quantity <= 0 || s.price <= 0 || !/^\d{4}-\d{2}-\d{2}/.test(s.filledAt));
        return bad ? { check: 'sales-sane', expected: 'a valid ISIN, units and price above zero and a date on every sale', observed: `${bad.fillId}: ${bad.isin}` } : null;
      },
    },
  ],
};
