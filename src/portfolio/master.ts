/**
 * The security master: one row per ISIN, fields from whichever source
 * supplied them, each with its provenance.  PROJECT-PLAN.md §4.2, §7③
 *
 * Values are the source's OWN labels, verbatim. Mapping into the app's
 * categories happens when reading, so it can change without re-fetching.
 */
import type { Db } from '../db/types.ts';

/** Tier 1 = issued by the company or fund itself; 2 = a third-party site (§3). */
export type Tier = 1 | 2 | 3;

export async function ensureSecurity(
  db: Db, isin: string, name: string, kind: 'equity' | 'etf', at: string,
): Promise<void> {
  await db.query(
    'INSERT INTO security (isin, name, kind, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (isin) DO NOTHING',
    [isin, name, kind, at],
  );
}

export async function setField(
  db: Db, isin: string, field: string, value: string, source: string, tier: Tier, asOf: string,
): Promise<void> {
  await db.query(
    `INSERT INTO security_field (isin, field, value, source, tier, as_of) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (isin, field, source) DO UPDATE SET
       value = excluded.value, tier = excluded.tier, as_of = excluded.as_of`,
    [isin, field, value, source, tier, asOf],
  );
}

export interface Labelled { readonly label: string; readonly source: string; }
export interface Classification { readonly sector?: Labelled; readonly country?: Labelled; }

/**
 * When two sources disagree, the fund issuers' own data wins — iShares' GICS
 * sector, iShares' and HSBC's country of risk — over a third-party site.
 */
const PREFERENCE = ['ishares', 'hsbc', 'waystone', 'invesco', 'stockanalysis'];

export async function classifications(db: Db): Promise<Map<string, Classification>> {
  const rows = await db.query(
    "SELECT isin, field, value, source FROM security_field WHERE field IN ('sector', 'country')",
  );
  const rank = (source: string) => {
    const i = PREFERENCE.indexOf(source);
    return i < 0 ? PREFERENCE.length : i;
  };
  const best = new Map<string, { sector?: Labelled; country?: Labelled }>();
  for (const r of rows) {
    const isin = String(r['isin']);
    const field = r['field'] as 'sector' | 'country';
    const candidate = { label: String(r['value']), source: String(r['source']) };
    const entry = best.get(isin) ?? {};
    const current = entry[field];
    if (!current || rank(candidate.source) < rank(current.source)) entry[field] = candidate;
    best.set(isin, entry);
  }
  return best;
}
