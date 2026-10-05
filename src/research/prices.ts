/**
 * Daily prices in the database.  PROJECT-PLAN.md §10.3④, §11.7 step 2.1
 *
 * Rows, not payloads: one row per listing per trading day, ~2,500 rows for
 * ten years. Only ever called with data that passed validation (§10.1).
 */
import type { Db, Statement } from '../db/types.ts';
import type { PriceBar, PriceHistory } from '../sources/yahoo.ts';

/**
 * Store a validated history against a listing. Refuses — and stores nothing —
 * when the response is for a different symbol, or quotes in a different
 * currency from the listing. That second case is the pence/pounds trap
 * (§7④): an LSE listing recorded as 'GBP' must not receive prices in 'GBp'.
 */
export async function savePrices(db: Db, listingId: number, history: PriceHistory): Promise<void> {
  const [listing] = await db.query(
    `SELECT l.ticker, l.currency, k.source_key AS yahoo FROM listing l
     LEFT JOIN listing_source_key k ON k.listing_id = l.id AND k.source = 'yahoo'
     WHERE l.id = ?`,
    [listingId],
  );
  if (!listing) throw new Error(`no listing ${listingId}`);
  const symbol = listing['yahoo'];
  if (typeof symbol !== 'string') throw new Error(`no Yahoo symbol recorded for ${String(listing['ticker'])}`);
  if (history.symbol.toUpperCase() !== symbol.toUpperCase()) {
    throw new Error(`asked Yahoo for ${symbol} but the answer was for ${history.symbol}`);
  }
  if (history.currency !== listing['currency']) {
    throw new Error(`Yahoo quotes ${symbol} in ${history.currency}, but the listing is in ${String(listing['currency'])}`);
  }

  // Re-fetched history overwrites: a split or dividend restates past closes.
  const writes: Statement[] = history.bars.map((b) => ({
    sql: `INSERT INTO price (listing_id, date, open, high, low, close, adj_close, volume, currency)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (listing_id, date) DO UPDATE SET
            open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
            adj_close = excluded.adj_close, volume = excluded.volume, currency = excluded.currency`,
    params: [listingId, b.date, b.open, b.high, b.low, b.close, b.adjClose, b.volume, history.currency],
  }));
  // One transaction: never half a history (§10.1).
  await db.batch(writes);
}

export interface StoredPrices {
  readonly currency: string;
  readonly bars: readonly PriceBar[];
}

/** A listing's stored prices, oldest first. */
export async function loadPrices(db: Db, listingId: number): Promise<StoredPrices | null> {
  const rows = await db.query('SELECT * FROM price WHERE listing_id = ? ORDER BY date', [listingId]);
  if (rows.length === 0) return null;
  const currencies = new Set(rows.map((r) => r['currency']));
  // savePrices cannot produce this; guards against anything that bypassed it.
  if (currencies.size > 1) throw new Error(`listing ${listingId} has prices in ${[...currencies].join(' and ')}`);
  const num = (v: unknown) => (v == null ? null : Number(v));
  return {
    currency: String(rows[0]!['currency']),
    bars: rows.map((r) => ({
      date: String(r['date']),
      open: num(r['open']), high: num(r['high']), low: num(r['low']),
      close: Number(r['close']), adjClose: num(r['adj_close']), volume: num(r['volume']),
    })),
  };
}
