/**
 * Money — amount and currency are inseparable.  PROJECT-PLAN.md §7④
 *
 * The trap this exists to close: the London Stock Exchange quotes in PENCE
 * ("GBp") while the ISA is denominated in POUNDS ("GBP").  They differ by a
 * factor of 100 and look identical at a glance.  A bare `number` cannot tell
 * you which it is, so this module never lets one exist.
 */

/** ⚠️ 'GBp' is PENCE. 'GBP' is POUNDS. They are not the same currency. */
export type Currency = 'GBP' | 'GBp' | 'USD' | 'EUR' | 'JPY' | 'CHF' | 'CAD'
                     | 'AUD' | 'HKD' | 'KRW' | 'TWD' | 'SEK' | 'DKK' | 'NOK';

declare const MONEY: unique symbol;

export type Money<C extends Currency = Currency> = {
  readonly amount: number;
  readonly currency: C;
  readonly [MONEY]: true;
};

export function money<C extends Currency>(amount: number, currency: C): Money<C> {
  if (!Number.isFinite(amount)) {
    throw new TypeError(`money(): amount must be finite, got ${amount}`);
  }
  return { amount, currency } as Money<C>;
}

/**
 * Add two amounts. The currency must match.
 *
 * `NoInfer` on the second argument is load-bearing: without it TypeScript
 * widens C to `'GBP' | 'USD'` and happily accepts a mismatch. With it, C is
 * fixed by the first argument and the second must agree.
 */
export function add<C extends Currency>(a: Money<C>, b: Money<NoInfer<C>>): Money<C> {
  if (a.currency !== b.currency) {
    // Unreachable via TypeScript; guards against untyped callers and JSON.
    throw new TypeError(`Cannot add ${b.currency} to ${a.currency}`);
  }
  return money(a.amount + b.amount, a.currency);
}

export function subtract<C extends Currency>(a: Money<C>, b: Money<NoInfer<C>>): Money<C> {
  if (a.currency !== b.currency) {
    throw new TypeError(`Cannot subtract ${b.currency} from ${a.currency}`);
  }
  return money(a.amount - b.amount, a.currency);
}

/** Multiply by a plain number — e.g. a fund weight, or a quantity of shares. */
export function scale<C extends Currency>(m: Money<C>, factor: number): Money<C> {
  if (!Number.isFinite(factor)) {
    throw new TypeError(`scale(): factor must be finite, got ${factor}`);
  }
  return money(m.amount * factor, m.currency);
}

export function sum<C extends Currency>(items: readonly Money<C>[], currency: C): Money<C> {
  return items.reduce<Money<C>>((acc, m) => add(acc, m), money(0, currency));
}

/**
 * Pence → pounds.  This is a DENOMINATION change, not a currency conversion:
 * no exchange rate is involved and none should be applied.
 */
export function penceToPounds(m: Money<'GBp'>): Money<'GBP'> {
  return money(m.amount / 100, 'GBP');
}

export function poundsToPence(m: Money<'GBP'>): Money<'GBp'> {
  return money(m.amount * 100, 'GBp');
}

/** Display, with the pence/pounds distinction made visible rather than assumed. */
export function format(m: Money): string {
  if (m.currency === 'GBp') return `${m.amount.toFixed(2)}p`;
  const symbol: Partial<Record<Currency, string>> = { GBP: '£', USD: '$', EUR: '€', JPY: '¥' };
  const s = symbol[m.currency];
  return s ? `${s}${m.amount.toFixed(2)}` : `${m.amount.toFixed(2)} ${m.currency}`;
}
