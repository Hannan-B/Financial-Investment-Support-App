/**
 * Dividends and sales from Trading 212.  PROJECT-PLAN.md §11.10 steps 5.2, 5.4
 *
 * Fetched when he presses Refresh on the portfolio, every page since the ISA
 * was opened; each payment and sale is stored once, by Trading 212's own
 * identifier, so a later refresh adds only what is new. Both are optional
 * sources (§10.1): if Trading 212 does not answer, the holdings still save
 * and the screens show what was stored, with when.
 *
 * Only what has been paid: nothing announced or expected (§11.10 step 5.2,
 * "only deal with what I have, not speculation").
 */
import type { Db, Statement } from '../db/types.ts';
import type { FetchDeps } from '../fetch/record.ts';
import type { Source } from '../fetch/types.ts';
import { fetchSource } from '../fetch/record.ts';
import { dividends as dividendSource, sales as saleSource, type HistoryPage, type Dividend, type Sale } from '../sources/t212.ts';

/** Trading 212 allows 20 history requests a minute: one every three seconds and a bit. */
export const PAGE_PAUSE_MS = 3100;
/** Far more than an ISA's history needs (50 a page); a stop, should `nextPagePath` never end. */
const MAX_PAGES = 200;

export interface HistoryOutcome {
  readonly kind: 'ok' | 'unavailable' | 'suspect';
  readonly items: number;
  readonly added: number;
  readonly detail: string | null;
}

async function allPages<T>(source: Source<HistoryPage<T>>, deps: FetchDeps, pause: () => Promise<void>):
  Promise<{ kind: 'ok'; items: T[] } | { kind: 'unavailable' | 'suspect'; detail: string; items: T[] }> {
  const items: T[] = [];
  let path = '';
  for (let n = 0; n < MAX_PAGES; n++) {
    if (n > 0) await pause();
    const out = await fetchSource(source, path, deps);
    if (out.kind === 'unavailable') return { kind: 'unavailable', detail: out.reason, items };
    if (out.kind === 'suspect') return { kind: 'suspect', detail: `${out.failure.observed} (expected ${out.failure.expected})`, items };
    items.push(...out.value.items);
    if (!out.value.next) return { kind: 'ok', items };
    path = out.value.next;
  }
  return { kind: 'suspect', detail: `more than ${MAX_PAGES} pages — stopped`, items };
}

const STATE = { dividends: 'dividends.last', sales: 'sales.last', usualRate: 'purification.usual_rate' } as const;

async function remember(db: Db, key: string, at: string, out: HistoryOutcome): Promise<void> {
  await db.query('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)', [key, JSON.stringify({ at, ...out })]);
}

/**
 * Every dividend Trading 212 has paid. A suspect page stores nothing from
 * that refresh: half a history would look complete (§10.1).
 */
export async function fetchDividends(deps: FetchDeps, pause: () => Promise<void>): Promise<HistoryOutcome> {
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const got = await allPages(dividendSource, deps, pause);
  let added = 0;
  if (got.kind === 'ok') {
    const known = new Set((await deps.db.query('SELECT reference FROM dividend')).map((r) => String(r['reference'])));
    const writes: Statement[] = got.items.map((d: Dividend) => {
      if (!known.has(d.reference)) added++;
      return {
        sql: `INSERT OR REPLACE INTO dividend (reference, isin, t212_ticker, name, paid_on, amount, currency, quantity, gross_per_share, share_currency, type, fetched_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [d.reference, d.isin, d.ticker, d.name, d.paidOn, d.amount, d.currency, d.quantity, d.grossPerShare, d.shareCurrency, d.type, at],
      };
    });
    await deps.db.batch(writes);
  }
  const out: HistoryOutcome = { kind: got.kind, items: got.items.length, added, detail: got.kind === 'ok' ? null : got.detail };
  await remember(deps.db, STATE.dividends, at, out);
  return out;
}

/**
 * Every sale. Each new sale becomes a purification item carrying his usual
 * rate as it is today; changing the usual rate later changes no item.
 */
export async function fetchSales(deps: FetchDeps, pause: () => Promise<void>): Promise<HistoryOutcome> {
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const got = await allPages(saleSource, deps, pause);
  let added = 0;
  if (got.kind === 'ok') {
    const known = new Set((await deps.db.query('SELECT fill_id FROM sale')).map((r) => Number(r['fill_id'])));
    const rate = await usualRate(deps.db);
    const writes: Statement[] = [];
    for (const s of got.items as Sale[]) {
      if (!known.has(s.fillId)) added++;
      writes.push({
        sql: `INSERT OR REPLACE INTO sale (fill_id, order_id, isin, t212_ticker, name, filled_at, quantity, price, price_currency, net_value, realised_pl, wallet_currency, profit_checked, fetched_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [s.fillId, s.orderId, s.isin, s.ticker, s.name, s.filledAt, s.quantity, s.price, s.priceCurrency, s.netValue, s.realisedPl, s.walletCurrency, s.profitChecked ? 1 : 0, at],
      });
      writes.push({
        sql: `INSERT OR IGNORE INTO purification_item (kind, sale_fill_id, isin, on_date, description, rate_pct, created_at)
              VALUES ('sale', ?, ?, ?, ?, ?, ?)`,
        params: [s.fillId, s.isin, s.filledAt.slice(0, 10), `Sold ${s.quantity} ${s.name}`, rate, at],
      });
    }
    await deps.db.batch(writes);
  }
  const out: HistoryOutcome = { kind: got.kind, items: got.items.length, added, detail: got.kind === 'ok' ? null : got.detail };
  await remember(deps.db, STATE.sales, at, out);
  return out;
}

// ── his usual rate (§11.10 step 5.4: "set the usual rate at 5%") ─────────

export async function usualRate(db: Db): Promise<number | null> {
  const [row] = await db.query('SELECT value FROM app_state WHERE key = ?', [STATE.usualRate]);
  const n = row ? Number(row['value']) : NaN;
  return Number.isFinite(n) ? n : null;
}

export async function setUsualRate(db: Db, pct: number): Promise<void> {
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error('A rate is a percentage from 0 to 100');
  await db.query('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)', [STATE.usualRate, String(pct)]);
}

// ── reading back ─────────────────────────────────────────────────────────

export interface Payment {
  readonly reference: string;
  readonly isin: string;
  readonly name: string;
  readonly ticker: string;
  /** The day, as Trading 212 dates it: '2026-03-27'. */
  readonly paidOn: string;
  readonly pounds: number;
  readonly quantity: number;
  readonly perUnit: number | null;
  /** ⚠️ 'GBX' is pence, as Trading 212 writes it. */
  readonly perUnitCurrency: string | null;
  readonly type: string;
}

export interface IsaYear {
  /** '2025/26' */
  readonly label: string;
  /** '6 Apr 2025 – 5 Apr 2026' */
  readonly span: string;
  readonly start: string;
  readonly pounds: number;
  readonly payments: number;
}

export interface LastFetch { readonly at: string; readonly kind: HistoryOutcome['kind']; readonly detail: string | null; }

export interface DividendHistory {
  /** Newest first. */
  readonly payments: readonly Payment[];
  readonly years: readonly IsaYear[];
  readonly total: number;
  /** The last time they were asked for, and how it went; null before the first time. */
  readonly last: LastFetch | null;
}

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The ISA year a day falls in: 6 April to 5 April (settled 2026-11-13).
 * A payment on 5 April counts in the year ending that day; one on 6 April in the next.
 */
export function isaYear(day: string): { label: string; span: string; start: string } {
  const y = Number(day.slice(0, 4));
  const md = day.slice(5, 10);
  const from = md >= '04-06' ? y : y - 1;
  return {
    label: `${from}/${String((from + 1) % 100).padStart(2, '0')}`,
    span: `6 ${MONTH[3]} ${from} – 5 ${MONTH[3]} ${from + 1}`,
    start: `${from}-04-06`,
  };
}

export async function lastFetch(db: Db, which: 'dividends' | 'sales'): Promise<LastFetch | null> {
  const [row] = await db.query('SELECT value FROM app_state WHERE key = ?', [STATE[which]]);
  if (!row) return null;
  const v = JSON.parse(String(row['value'])) as LastFetch;
  return { at: v.at, kind: v.kind, detail: v.detail };
}

export async function loadDividends(db: Db, isin?: string): Promise<DividendHistory> {
  const rows = await db.query(
    `SELECT reference, isin, name, t212_ticker, paid_on, amount, quantity, gross_per_share, share_currency, type
     FROM dividend ${isin ? 'WHERE isin = ?' : ''} ORDER BY paid_on DESC, reference`,
    isin ? [isin] : [],
  );
  const payments: Payment[] = rows.map((r) => ({
    reference: String(r['reference']), isin: String(r['isin']), name: String(r['name']), ticker: String(r['t212_ticker']),
    paidOn: String(r['paid_on']).slice(0, 10), pounds: Number(r['amount']), quantity: Number(r['quantity']),
    perUnit: r['gross_per_share'] === null ? null : Number(r['gross_per_share']),
    perUnitCurrency: r['share_currency'] === null ? null : String(r['share_currency']),
    type: String(r['type']),
  }));
  const years = new Map<string, { label: string; span: string; start: string; pounds: number; payments: number }>();
  for (const p of payments) {
    const y = isaYear(p.paidOn);
    const acc = years.get(y.label) ?? { ...y, pounds: 0, payments: 0 };
    acc.pounds += p.pounds;
    acc.payments++;
    years.set(y.label, acc);
  }
  return {
    payments,
    years: [...years.values()].sort((a, b) => b.start.localeCompare(a.start)),
    total: payments.reduce((n, p) => n + p.pounds, 0),
    last: await lastFetch(db, 'dividends'),
  };
}

/** Trading 212's payment type in plain words; one it has not been seen to use reads as its own name. */
export function paymentType(type: string): string {
  const manufactured = type.endsWith('_MANUFACTURED_PAYMENT');
  const base = manufactured ? type.slice(0, -'_MANUFACTURED_PAYMENT'.length) : type;
  const named: Record<string, string> = {
    ORDINARY: 'Ordinary dividend', DIVIDEND: 'Dividend', BONUS: 'Bonus', INTEREST: 'Interest',
    PROPERTY_INCOME: 'Property income', PROPERTY_INCOME_DISTRIBUTION: 'Property income distribution',
    RETURN_OF_CAPITAL: 'Return of capital', RETURN_OF_CAPITAL_NON_US: 'Return of capital',
    CAPITAL_GAINS_DISTRIBUTION: 'Capital gains distribution', CAPITAL_GAINS_DISTRIBUTION_NON_US: 'Capital gains distribution',
    CAPITAL_GAINS: 'Capital gains', DEMERGER: 'Demerger', INTERIM_LIQUIDATION: 'Interim liquidation',
    OTHER_INCOME: 'Other income', TAX_EXEMPTED: 'Tax-exempt payment',
    DIVIDENDS_PAID_BY_US_CORPORATIONS: 'Dividend (US company)', DIVIDENDS_PAID_BY_FOREIGN_CORPORATIONS: 'Dividend (non-US company)',
    INTEREST_PAID_BY_US_OBLIGORS: 'Interest (US payer)', INTEREST_PAID_BY_FOREIGN_CORPORATIONS: 'Interest (non-US company)',
  };
  const words = named[base] ?? base.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  return manufactured ? `${words} (manufactured payment)` : words;
}
