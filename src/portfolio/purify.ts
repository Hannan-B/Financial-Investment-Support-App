/**
 * Purification — arithmetic on his figures, never a ruling.  PROJECT-PLAN.md §11.10 step 5.4, §8.5
 *
 * As gone through on 2026-11-13: one item per sale. The rate is his — each
 * new item starts with his usual rate (he set 5%) and he changes it there,
 * "based on whatever Zoya says". The rate multiplies:
 *   - the profit on the sale (a loss has nothing to purify on the sale), and
 *   - every dividend that holding paid while it was held — each counted once,
 *     at the first sale on or after the day it was paid, so a later partial
 *     sale does not count it again. Every dividend counts, whatever a fund
 *     says it does itself (decided 2026-11-13).
 * The one interest payment is an item typed by hand. Settling ticks items
 * off in one go with the date paid; what was owed is kept as it was then.
 * Nothing is flagged as overdue; the app proposes no rate of its own.
 */
import type { Db, Statement } from '../db/types.ts';
import { usualRate } from './income.ts';

export interface Counted {
  readonly reference: string;
  readonly paidOn: string;
  readonly pounds: number;
}

export type Profit =
  | { readonly kind: 'trading212'; readonly pounds: number }
  | { readonly kind: 'typed'; readonly pounds: number }
  | { readonly kind: 'unknown'; readonly reason: string };

export interface Item {
  readonly id: number;
  readonly kind: 'sale' | 'manual';
  readonly isin: string | null;
  readonly date: string;
  readonly description: string;
  readonly ratePct: number | null;
  /** A sale: its profit or loss. */
  readonly profit: Profit | null;
  /** A sale: its units and price, as Trading 212 recorded them. */
  readonly sold: { readonly quantity: number; readonly price: number; readonly currency: string } | null;
  /** A manual item: the payment. */
  readonly amount: number | null;
  /** A sale: the dividends counted with it. */
  readonly dividends: readonly Counted[];
  /** What is owed; null while the rate or the profit is missing. Settled items: as it was when settled. */
  readonly owed: number | null;
  readonly settled: { readonly on: string; readonly amount: number } | null;
}

export interface Purification {
  readonly usualRate: number | null;
  /** Newest first. */
  readonly items: readonly Item[];
  /** The total of items not yet settled whose amount is known. */
  readonly outstanding: number;
  /** Items still waiting for a rate or a profit before they can be added up. */
  readonly incomplete: number;
  /** Dividends with no sale since: counted at the holding's next sale. */
  readonly notYetCounted: ReadonlyMap<string, readonly Counted[]>;
}

const pennies = (n: number) => Math.round(n * 100) / 100;

/** What an item comes to: rate × (profit if a profit + its dividends), or rate × the payment. */
export function owedOn(ratePct: number | null, base: { profit: Profit | null; dividends: readonly Counted[]; amount: number | null }): number | null {
  if (ratePct === null) return null;
  if (base.profit) {
    if (base.profit.kind === 'unknown') return null;
    const onSale = Math.max(base.profit.pounds, 0);
    return pennies((ratePct / 100) * (onSale + base.dividends.reduce((n, d) => n + d.pounds, 0)));
  }
  return base.amount === null ? null : pennies((ratePct / 100) * base.amount);
}

export async function loadPurification(db: Db): Promise<Purification> {
  const sales = await db.query('SELECT fill_id, isin, filled_at, quantity, price, price_currency, realised_pl, wallet_currency, profit_checked FROM sale ORDER BY filled_at');
  const divs = await db.query('SELECT reference, isin, paid_on, amount FROM dividend ORDER BY paid_on');

  // Each dividend goes to the first sale of that holding on or after the day it was paid.
  const bySale = new Map<number, Counted[]>();
  const notYet = new Map<string, Counted[]>();
  for (const d of divs) {
    const isin = String(d['isin']);
    const day = String(d['paid_on']).slice(0, 10);
    const counted: Counted = { reference: String(d['reference']), paidOn: day, pounds: Number(d['amount']) };
    const sale = sales.find((s) => String(s['isin']) === isin && String(s['filled_at']).slice(0, 10) >= day);
    if (sale) {
      const id = Number(sale['fill_id']);
      bySale.set(id, [...(bySale.get(id) ?? []), counted]);
    } else {
      notYet.set(isin, [...(notYet.get(isin) ?? []), counted]);
    }
  }
  const saleById = new Map(sales.map((s) => [Number(s['fill_id']), s]));

  const rows = await db.query(
    'SELECT id, kind, sale_fill_id, isin, on_date, description, amount, rate_pct, settled_on, settled_amount FROM purification_item ORDER BY on_date DESC, id DESC',
  );
  const items: Item[] = rows.map((r) => {
    const kind = String(r['kind']) as Item['kind'];
    const ratePct = r['rate_pct'] === null ? null : Number(r['rate_pct']);
    const typed = r['amount'] === null ? null : Number(r['amount']);
    let profit: Profit | null = null;
    let sold: Item['sold'] = null;
    let dividends: Counted[] = [];
    if (kind === 'sale') {
      const s = saleById.get(Number(r['sale_fill_id']));
      dividends = bySale.get(Number(r['sale_fill_id'])) ?? [];
      if (s) sold = { quantity: Number(s['quantity']), price: Number(s['price']), currency: String(s['price_currency']) };
      if (typed !== null) profit = { kind: 'typed', pounds: typed };
      else if (s && Number(s['profit_checked']) === 1 && s['realised_pl'] !== null) profit = { kind: 'trading212', pounds: Number(s['realised_pl']) };
      else profit = { kind: 'unknown', reason: s?.['wallet_currency'] && s['wallet_currency'] !== 'GBP'
        ? `Trading 212 gave the profit in ${String(s['wallet_currency'])}, not pounds — type it from Trading 212's app`
        : 'Trading 212’s figures for this sale did not add up (units × price against what was paid), so its profit is not used — type it from Trading 212’s app' };
    }
    const settled = r['settled_on'] === null ? null : { on: String(r['settled_on']), amount: Number(r['settled_amount']) };
    return {
      id: Number(r['id']), kind, isin: r['isin'] === null ? null : String(r['isin']), date: String(r['on_date']),
      description: String(r['description']), ratePct, profit, sold, amount: kind === 'manual' ? typed : null, dividends,
      owed: settled ? settled.amount : owedOn(ratePct, { profit, dividends, amount: kind === 'manual' ? typed : null }),
      settled,
    };
  });

  const open = items.filter((i) => !i.settled);
  return {
    usualRate: await usualRate(db),
    items,
    outstanding: pennies(open.reduce((n, i) => n + (i.owed ?? 0), 0)),
    incomplete: open.filter((i) => i.owed === null).length,
    notYetCounted: notYet,
  };
}

export type Change = { readonly kind: 'done' } | { readonly kind: 'refused'; readonly reason: string };
const DONE: Change = { kind: 'done' };
const no = (reason: string): Change => ({ kind: 'refused', reason });

async function unsettled(db: Db, id: number): Promise<Change | null> {
  const [row] = await db.query('SELECT settled_on FROM purification_item WHERE id = ?', [id]);
  if (!row) return no('That item no longer exists');
  return row['settled_on'] === null ? null : no('It is settled: what was owed is kept as it was');
}

const isRate = (pct: number) => Number.isFinite(pct) && pct >= 0 && pct <= 100;

/** His rate for one item; no other item changes. */
export async function setItemRate(db: Db, id: number, pct: number | null): Promise<Change> {
  const blocked = await unsettled(db, id);
  if (blocked) return blocked;
  if (pct !== null && !isRate(pct)) return no('A rate is a percentage from 0 to 100');
  await db.query('UPDATE purification_item SET rate_pct = ? WHERE id = ?', [pct, id]);
  return DONE;
}

/**
 * His usual rate into every unsettled item that has no rate yet — one click,
 * asked for 2026-11-13: setting 5% left the 20 sales already listed blank.
 * An item with a rate of its own, or settled, is never changed.
 */
export async function fillMissingRates(db: Db): Promise<Change & { filled?: number }> {
  const pct = await usualRate(db);
  if (pct === null) return no('Set your usual rate first');
  const [row] = await db.query('SELECT count(*) AS n FROM purification_item WHERE rate_pct IS NULL AND settled_on IS NULL');
  await db.query('UPDATE purification_item SET rate_pct = ? WHERE rate_pct IS NULL AND settled_on IS NULL', [pct]);
  return { kind: 'done', filled: Number(row?.['n'] ?? 0) };
}

/** A sale's profit typed by him, when Trading 212's cannot be used — or cleared again. */
export async function setTypedProfit(db: Db, id: number, pounds: number | null): Promise<Change> {
  const blocked = await unsettled(db, id);
  if (blocked) return blocked;
  if (pounds !== null && !Number.isFinite(pounds)) return no('Type the profit in pounds, e.g. 180.00 (a loss as -25.00)');
  await db.query("UPDATE purification_item SET amount = ? WHERE id = ? AND kind = 'sale'", [pounds, id]);
  return DONE;
}

/** An item typed by hand: the one interest payment. */
export async function addManual(db: Db, item: { date: string; description: string; pounds: number; ratePct: number | null }, now: Date): Promise<Change> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date)) return no('Choose the date it was paid');
  if (!item.description.trim()) return no('Say what it was, e.g. "Interest on cash"');
  if (!Number.isFinite(item.pounds) || item.pounds <= 0) return no('Type the amount in pounds');
  if (item.ratePct !== null && !isRate(item.ratePct)) return no('A rate is a percentage from 0 to 100');
  await db.query(
    "INSERT INTO purification_item (kind, on_date, description, amount, rate_pct, created_at) VALUES ('manual', ?, ?, ?, ?, ?)",
    [item.date, item.description.trim(), item.pounds, item.ratePct, now.toISOString()],
  );
  return DONE;
}

/** A hand-typed item, unsettled, can be taken back; a sale's item cannot (the sale happened). */
export async function deleteManual(db: Db, id: number): Promise<Change> {
  const blocked = await unsettled(db, id);
  if (blocked) return blocked;
  const [row] = await db.query('SELECT kind FROM purification_item WHERE id = ?', [id]);
  if (String(row?.['kind']) !== 'manual') return no('A sale’s item stays: the sale happened');
  await db.query('DELETE FROM purification_item WHERE id = ?', [id]);
  return DONE;
}

/** Several items settled in one action, with the date he paid. Each must have its amount worked out. */
export async function settle(db: Db, ids: readonly number[], paidOn: string): Promise<Change> {
  if (ids.length === 0) return no('Tick the items you have paid');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) return no('Choose the date you paid');
  const p = await loadPurification(db);
  const chosen = ids.map((id) => p.items.find((i) => i.id === id));
  if (chosen.some((i) => !i)) return no('An item no longer exists');
  const already = chosen.find((i) => i!.settled);
  if (already) return no(`“${already.description}” is already settled`);
  const missing = chosen.find((i) => i!.owed === null);
  if (missing) return no(`“${missing.description}” has no amount yet — give it a rate${missing.profit?.kind === 'unknown' ? ' and its profit' : ''} first`);
  const writes: Statement[] = chosen.map((i) => ({
    sql: 'UPDATE purification_item SET settled_on = ?, settled_amount = ? WHERE id = ?',
    params: [paidOn, i!.owed, i!.id],
  }));
  await db.batch(writes);
  return DONE;
}
