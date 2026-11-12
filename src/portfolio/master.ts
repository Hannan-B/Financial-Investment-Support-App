/**
 * The security master: one row per ISIN, fields from whichever source
 * supplied them, each with its provenance.  PROJECT-PLAN.md §4.2, §7③
 *
 * Values are the source's OWN labels, verbatim. Mapping into the app's
 * categories happens when reading, so it can change without re-fetching.
 */
import type { Db, Statement } from '../db/types.ts';

/** Tier 1 = issued by the company or fund itself; 2 = a third-party site (§3). */
export type Tier = 1 | 2 | 3;

export function securityStatement(isin: string, name: string, kind: 'equity' | 'etf', at: string): Statement {
  return {
    sql: 'INSERT INTO security (isin, name, kind, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (isin) DO NOTHING',
    params: [isin, name, kind, at],
  };
}

export function fieldStatement(
  isin: string, field: string, value: string, source: string, tier: Tier, asOf: string,
): Statement {
  return {
    sql: `INSERT INTO security_field (isin, field, value, source, tier, as_of) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (isin, field, source) DO UPDATE SET
            value = excluded.value, tier = excluded.tier, as_of = excluded.as_of`,
    params: [isin, field, value, source, tier, asOf],
  };
}

export interface ListingInput {
  readonly isin: string;
  readonly ticker: string;
  readonly exchange: string;
  /** ⚠️ 'GBp' for London: what the exchange quotes in, not what the ISA holds. */
  readonly currency: string;
  /** How each website names this listing: { yahoo: 'SHEL.L' } (§7.2). */
  readonly sourceKeys?: Readonly<Record<string, string>>;
}

/**
 * Find or create a listing; returns its id. The security must already exist.
 *
 * Refuses rather than repairs: a ticker and exchange already recorded under a
 * different ISIN or currency means something upstream has confused two
 * securities (§7.2), and quietly picking one would store prices against the
 * wrong company or in the wrong unit.
 */
export async function ensureListing(db: Db, l: ListingInput): Promise<number> {
  await db.query(
    'INSERT INTO listing (isin, ticker, exchange, currency) VALUES (?, ?, ?, ?) ON CONFLICT (ticker, exchange) DO NOTHING',
    [l.isin, l.ticker, l.exchange, l.currency],
  );
  const [row] = await db.query('SELECT id, isin, currency FROM listing WHERE ticker = ? AND exchange = ?', [l.ticker, l.exchange]);
  if (!row) throw new Error(`listing ${l.ticker} on ${l.exchange} could not be saved`);
  if (row['isin'] !== l.isin) {
    throw new Error(`${l.ticker} on ${l.exchange} is already recorded as ${String(row['isin'])}, not ${l.isin}`);
  }
  if (row['currency'] !== l.currency) {
    throw new Error(`${l.ticker} on ${l.exchange} is already recorded in ${String(row['currency'])}, not ${l.currency}`);
  }
  const id = Number(row['id']);
  for (const [source, key] of Object.entries(l.sourceKeys ?? {})) {
    await db.query(
      `INSERT INTO listing_source_key (listing_id, source, source_key) VALUES (?, ?, ?)
       ON CONFLICT (listing_id, source) DO UPDATE SET source_key = excluded.source_key`,
      [id, source, key],
    );
  }
  return id;
}

export interface Labelled { readonly label: string; readonly source: string; }
export interface Classification {
  readonly sector?: Labelled;
  readonly country?: Labelled;
  /** Stockanalysis's industry, verbatim — the only source that gives one (§11.9 step 4.4). */
  readonly industry?: Labelled;
  /** Stockanalysis's own sector, kept to say when it disagrees with the fund's. */
  readonly lookupSector?: string;
  /** Whether the company lookup has run for it: found, or no page with this ISIN. */
  readonly lookup?: 'found' | 'not-found';
}

/**
 * When two sources disagree, the fund issuers' own data wins — iShares' GICS
 * sector, iShares' and HSBC's country of risk — over a third-party site.
 */
const PREFERENCE = ['ishares', 'hsbc', 'waystone', 'invesco', 'stockanalysis'];

export async function classifications(db: Db): Promise<Map<string, Classification>> {
  const rows = await db.query(
    "SELECT isin, field, value, source FROM security_field WHERE field IN ('sector', 'country', 'industry')",
  );
  const rank = (source: string) => {
    const i = PREFERENCE.indexOf(source);
    return i < 0 ? PREFERENCE.length : i;
  };
  type Entry = { -readonly [K in keyof Classification]: Classification[K] };
  const best = new Map<string, Entry>();
  for (const r of rows) {
    const isin = String(r['isin']);
    const field = r['field'] as 'sector' | 'country' | 'industry';
    const candidate = { label: String(r['value']), source: String(r['source']) };
    const entry = best.get(isin) ?? {};
    if (field === 'sector' && candidate.source === 'stockanalysis') entry.lookupSector = candidate.label;
    const current = entry[field];
    if (!current || rank(candidate.source) < rank(current.source)) entry[field] = candidate;
    best.set(isin, entry);
  }
  for (const r of await db.query("SELECT isin, outcome FROM lookup_attempt WHERE source = 'stockanalysis'")) {
    const isin = String(r['isin']);
    best.set(isin, { ...best.get(isin), lookup: r['outcome'] === 'found' ? 'found' : 'not-found' });
  }
  return best;
}
