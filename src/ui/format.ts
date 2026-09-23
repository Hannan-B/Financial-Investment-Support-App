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
