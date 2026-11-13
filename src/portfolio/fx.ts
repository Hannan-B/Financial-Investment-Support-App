/**
 * Pounds and other currencies.  PROJECT-PLAN.md §11.10 step 5.1
 *
 * Today's Bank of England rates, fetched once a day and then read from
 * storage. Every conversion carries its working: the amount, the rate, its
 * date and where it came from — "$1,000 = £755.40 at $1.3238 per £1, Bank of
 * England, 12 Nov 2026". If no rate can be had, no pound figure is made up:
 * the caller shows the original amount and the reason.
 *
 * ⚠️ Pence are not a currency conversion: 'GBp' ÷ 100 is pounds, no rate,
 *    no fee (§7④).
 *
 * Trading 212's currency fee, as its help centre states it (read 2026-11-13,
 * "What is the FX fee? (Invest & Stocks ISA)"): an order in another currency
 * converts at "the spot exchange rate + 0.15% FX fee" — buying, the rate is
 * lowered by 0.15% (fewer dollars per pound); selling, raised by 0.15% (more
 * dollars per pound back). Dividends pay no fee.
 */
import type { Db } from '../db/types.ts';
import type { FetchDeps } from '../fetch/record.ts';
import { fetchSource } from '../fetch/record.ts';
import { makeBoeRates } from '../sources/boe.ts';

export const T212_FX_FEE = 0.0015;
const FETCHED_ON = 'fx.boe.fetched_on';

export interface PoundRates {
  readonly kind: 'ok';
  /** The day the rates are for — the last working day on a weekend. */
  readonly date: string;
  /** How many of each currency £1 buys. */
  readonly perPound: ReadonlyMap<string, number>;
  /** Set when today's fetch failed and older stored rates are shown instead. */
  readonly stale: string | null;
}
export type RatesOutcome = PoundRates | { readonly kind: 'none'; readonly reason: string };

async function stored(db: Db): Promise<{ date: string; perPound: Map<string, number> } | null> {
  const rows = await db.query(
    "SELECT date, quote, rate FROM fx_rate WHERE base = 'GBP' AND date = (SELECT max(date) FROM fx_rate WHERE base = 'GBP')",
  );
  if (rows.length === 0) return null;
  return { date: String(rows[0]!['date']), perPound: new Map(rows.map((r) => [String(r['quote']), Number(r['rate'])])) };
}

/**
 * Today's rates: from storage if already fetched today, else from the Bank.
 * A failed fetch falls back to the last stored rates, marked stale.
 */
export async function poundRates(deps: FetchDeps): Promise<RatesOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const today = now.toISOString().slice(0, 10);
  const [done] = await deps.db.query('SELECT value FROM app_state WHERE key = ?', [FETCHED_ON]);
  const have = await stored(deps.db);
  if (have && done && String(done['value']) === today) return { kind: 'ok', ...have, stale: null };

  const out = await fetchSource(makeBoeRates(() => now), '', deps);
  if (out.kind === 'ok') {
    await deps.db.batch([
      ...out.value.rates.map((r) => ({
        sql: "INSERT OR REPLACE INTO fx_rate (date, base, quote, rate) VALUES (?, 'GBP', ?, ?)",
        params: [out.value.date, r.currency, r.perPound],
      })),
      { sql: 'INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)', params: [FETCHED_ON, today] },
    ]);
    return { kind: 'ok', ...(await stored(deps.db))!, stale: null };
  }
  const why = out.kind === 'unavailable' ? `the Bank of England did not answer (${out.reason})`
    : `the Bank of England's page did not pass a check (${out.failure.observed})`;
  if (have) return { kind: 'ok', ...have, stale: why };
  return { kind: 'none', reason: why };
}

/** One conversion, with everything needed to show its working. */
export interface Conversion {
  readonly from: { readonly amount: number; readonly currency: string };
  readonly pounds: number;
  /** null for pence: no rate is involved. */
  readonly rate: {
    readonly perPound: number;
    /** After Trading 212's fee, when one applies. */
    readonly applied: number;
    readonly fee: number;
    readonly date: string;
    readonly stale: string | null;
  } | null;
}

export type Direction = 'buy' | 'sell' | 'none';

function feeRate(perPound: number, direction: Direction): number {
  if (direction === 'buy') return perPound * (1 - T212_FX_FEE);
  if (direction === 'sell') return perPound * (1 + T212_FX_FEE);
  return perPound;
}

/**
 * An amount in a share's currency, in pounds. Selling dollars, Trading 212
 * gives back fewer pounds than the Bank's rate: its fee is applied.
 */
export function toPounds(amount: number, currency: string, rates: RatesOutcome, direction: Direction = 'none'):
  Conversion | { readonly reason: string } {
  if (currency === 'GBP') return { from: { amount, currency }, pounds: amount, rate: null };
  if (currency === 'GBp' || currency === 'GBX') return { from: { amount, currency: 'GBp' }, pounds: amount / 100, rate: null };
  if (rates.kind === 'none') return { reason: `no exchange rate: ${rates.reason}` };
  const perPound = rates.perPound.get(currency);
  if (perPound === undefined) return { reason: `the Bank of England gives no rate for ${currency}` };
  const applied = feeRate(perPound, direction);
  return {
    from: { amount, currency }, pounds: amount / applied,
    rate: { perPound, applied, fee: direction === 'none' ? 0 : T212_FX_FEE, date: rates.date, stale: rates.stale },
  };
}

/** Pounds into a share's currency: what £500 buys in dollars, after Trading 212's fee. */
export function fromPounds(pounds: number, currency: string, rates: RatesOutcome, direction: Direction = 'buy'):
  { readonly amount: number; readonly currency: string; readonly rate: Conversion['rate'] } | { readonly reason: string } {
  if (currency === 'GBP') return { amount: pounds, currency, rate: null };
  if (currency === 'GBp' || currency === 'GBX') return { amount: pounds * 100, currency: 'GBp', rate: null };
  if (rates.kind === 'none') return { reason: `no exchange rate: ${rates.reason}` };
  const perPound = rates.perPound.get(currency);
  if (perPound === undefined) return { reason: `the Bank of England gives no rate for ${currency}` };
  const applied = feeRate(perPound, direction);
  return {
    amount: pounds * applied, currency,
    rate: { perPound, applied, fee: direction === 'none' ? 0 : T212_FX_FEE, date: rates.date, stale: rates.stale },
  };
}
