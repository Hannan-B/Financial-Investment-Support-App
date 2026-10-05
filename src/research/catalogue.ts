/**
 * Trading 212's catalogue: the companies that can be researched.  PROJECT-PLAN.md §7.2
 *
 * Choosing from this list means only shares the ISA can buy are opened, and
 * each arrives with its ISIN. Kept locally and searched locally; fetched again
 * when a month old, or when asked.
 */
import type { Db, Statement } from '../db/types.ts';
import type { FetchDeps } from '../fetch/record.ts';
import type { Transport } from '../fetch/types.ts';
import { fetchSource } from '../fetch/record.ts';
import { instruments, type Instrument } from '../sources/t212.ts';

const MAX_AGE_DAYS = 30;

export async function saveCatalogue(db: Db, list: readonly Instrument[], fetchedAt: string): Promise<void> {
  const writes: Statement[] = [{ sql: 'DELETE FROM instrument' }];
  for (const i of list) {
    writes.push({
      sql: `INSERT INTO instrument (t212_ticker, isin, name, short_name, currency, type, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (t212_ticker) DO NOTHING`,
      params: [i.ticker, i.isin, i.name, i.shortName, i.currency, i.type, fetchedAt],
    });
  }
  await db.batch(writes);
}

/** When the catalogue was last fetched, and how many entries it has. */
export async function catalogueInfo(db: Db): Promise<{ fetchedAt: string | null; count: number }> {
  const [row] = await db.query('SELECT max(fetched_at) AS at, count(*) AS n FROM instrument');
  return { fetchedAt: (row?.['at'] as string | null) ?? null, count: Number(row?.['n'] ?? 0) };
}

/**
 * Fetches the catalogue if there is none, or it is a month old, or `force`.
 * Returns why not, when it could not.
 */
export async function ensureCatalogue(
  deps: Omit<FetchDeps, 'transport'> & { t212: Transport }, force = false,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const now = (deps.now ?? (() => new Date()))();
  const { fetchedAt, count } = await catalogueInfo(deps.db);
  const fresh = fetchedAt && now.getTime() - Date.parse(fetchedAt) < MAX_AGE_DAYS * 86_400_000;
  if (count > 0 && fresh && !force) return { ok: true };
  const out = await fetchSource(instruments, '', { ...deps, transport: deps.t212 });
  if (out.kind !== 'ok') {
    const reason = out.kind === 'unavailable' ? out.reason : out.failure.observed;
    // An older list still serves for searching; say so rather than fail.
    return count > 0 ? { ok: true } : { ok: false, reason: `Trading 212's list of shares: ${reason}` };
  }
  await saveCatalogue(deps.db, out.value, now.toISOString());
  return { ok: true };
}

export interface CatalogueHit {
  readonly t212Ticker: string;
  readonly isin: string;
  readonly name: string;
  readonly shortName: string;
  /** Trading 212's code: 'GBX' is pence. */
  readonly currency: string;
  readonly type: string;
  /** Read from Trading 212's own code: 'US', 'London', or null where the code does not say plainly. */
  readonly market: 'US' | 'London' | null;
}

export function marketOf(t212Ticker: string): CatalogueHit['market'] {
  if (/_US_EQ$/.test(t212Ticker)) return 'US';
  if (/l_EQ$/.test(t212Ticker)) return 'London';
  return null;
}

/** Ticker first — exact, then starting with — then name. Shares only; funds are opened from the portfolio. */
export async function searchCatalogue(db: Db, query: string, limit = 25): Promise<CatalogueHit[]> {
  const q = query.trim();
  if (q.length === 0) return [];
  const rows = await db.query(
    `SELECT *, CASE
               WHEN short_name = ? COLLATE NOCASE THEN 0
               WHEN short_name LIKE ? ESCAPE '\\' THEN 1
               WHEN name LIKE ? ESCAPE '\\' THEN 2
               ELSE 3 END AS rank
     FROM instrument
     WHERE type = 'STOCK' AND (short_name LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')
     ORDER BY rank, length(short_name), name
     LIMIT ?`,
    (() => {
      const esc = q.replace(/[\\%_]/g, (c) => `\\${c}`);
      return [q, `${esc}%`, `${esc}%`, `${esc}%`, `%${esc}%`, limit];
    })(),
  );
  return rows.map((r) => ({
    t212Ticker: String(r['t212_ticker']), isin: String(r['isin']), name: String(r['name']),
    shortName: String(r['short_name']), currency: String(r['currency']), type: String(r['type']),
    market: marketOf(String(r['t212_ticker'])),
  }));
}
