import type { Money } from '../lib/money.ts';
import { COUNTRY_NAMES } from '../categories/countries.ts';

const gbpFormat = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const gbpWhole = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });

/** Only GBP is ever shown on the portfolio screens (§11.1). */
export function gbp(m: Money<'GBP'>, whole = false): string {
  return (whole ? gbpWhole : gbpFormat).format(m.amount);
}

export function pct(share: number): string {
  const p = share * 100;
  return `${p < 0.1 && p > 0 ? '<0.1' : p.toFixed(1)}%`;
}

/** '2026-09-23T12:00:00Z' or '2026-09-18' → '23 Sep 2026' */
export function day(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** '… 14:05' for today, else the date. */
export function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? `today ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : day(iso);
}

export function countryName(key: string): string {
  if (key === 'cash') return 'Cash & derivatives in funds';
  if (key === 'unclassified') return 'Not yet classified';
  return COUNTRY_NAMES[key] ?? key;
}

const SYMBOL: Readonly<Record<string, string>> = { GBP: '£', USD: '$', EUR: '€', JPY: '¥' };

/** A price as quoted, the pence/pounds distinction visible: '3,631.50p', '$333.70', '185.04 CHF'. */
export function price(value: number, currency: string, digits = 2): string {
  const n = Math.abs(value).toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const sign = value < 0 ? '-' : '';
  if (currency === 'GBp') return `${sign}${n}p`;
  const s = SYMBOL[currency];
  return s ? `${sign}${s}${n}` : `${sign}${n} ${currency}`;
}

/** A company-sized amount: '$713.2B', '€950.0M', '-$1.2B'. */
export function big(value: number, currency: string | null): string {
  const abs = Math.abs(value);
  const [scaled, suffix] = abs >= 1e12 ? [abs / 1e12, 'T'] : abs >= 1e9 ? [abs / 1e9, 'B'] : abs >= 1e6 ? [abs / 1e6, 'M'] : [abs, ''];
  const n = scaled.toLocaleString('en-GB', { minimumFractionDigits: suffix ? 1 : 0, maximumFractionDigits: suffix ? 1 : 2 });
  const s = currency ? SYMBOL[currency] : undefined;
  const body = s ? `${s}${n}${suffix}` : `${n}${suffix}${currency ? ` ${currency}` : ''}`;
  return value < 0 ? `-${body}` : body;
}

/** A plain number to a sensible precision: 60.87, 0.0952, 1,234. */
export function num(value: number, digits?: number): string {
  const d = digits ?? (Math.abs(value) >= 100 ? 2 : Math.abs(value) >= 1 ? 2 : 4);
  return value.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Yahoo's exchange codes as people say them. */
export function exchangeName(code: string): string {
  return ({ NMS: 'Nasdaq', NGM: 'Nasdaq', NCM: 'Nasdaq', NYQ: 'NYSE', LSE: 'London', GER: 'Xetra', PAR: 'Paris', AMS: 'Amsterdam' } as Record<string, string>)[code] ?? code;
}
