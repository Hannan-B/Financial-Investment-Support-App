/**
 * Fund contents in the database.  PROJECT-PLAN.md §7⑤, §10.3④
 *
 * Only ever called with data that passed validation (§10.1).
 *
 * Retention: the latest list per fund, plus the last list of each earlier
 * month. IGDA alone is ~1,260 rows; kept daily that is ~460,000 rows a year,
 * against a whole-app budget of 500 MB for a decade.
 */
import type { Db, Statement } from '../db/types.ts';
import type { Fund } from '../sources/funds.ts';
import type { Constituent, FundHoldings } from '../sources/holdings.ts';
import { securityStatement, fieldStatement } from './master.ts';

export async function saveFundHoldings(db: Db, fund: Fund, holdings: FundHoldings, fetchedAt: string): Promise<void> {
  const asOf = holdings.asOf ?? fetchedAt.slice(0, 10);
  const writes: Statement[] = [
    securityStatement(fund.isin, fund.name, 'etf', fetchedAt),
    // A second refresh the same day replaces, not duplicates.
    { sql: 'DELETE FROM etf_constituent WHERE etf_isin = ? AND as_of = ?', params: [fund.isin, asOf] },
  ];
  for (const [position, r] of holdings.rows.entries()) {
    writes.push({
      sql: `INSERT INTO etf_constituent (etf_isin, as_of, position, kind, constituent_isin, sedol, name,
              weight_pct, country_label, sector_label, currency, issuer, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [fund.isin, asOf, position, r.kind, r.isin, r.sedol, r.name, r.weightPct,
        r.country, r.sector, r.currency, fund.issuer, fetchedAt],
    });
    // What the issuer says about each company goes into the master, with
    // provenance, so funds that omit it can borrow it (§4.2).
    if (r.kind === 'equity' && r.isin) {
      writes.push(securityStatement(r.isin, r.name, 'equity', fetchedAt));
      if (r.sector) writes.push(fieldStatement(r.isin, 'sector', r.sector, fund.issuer, 1, asOf));
      if (r.country) writes.push(fieldStatement(r.isin, 'country', r.country, fund.issuer, 1, asOf));
    }
  }
  writes.push({
    sql: `DELETE FROM etf_constituent WHERE etf_isin = ? AND as_of NOT IN (
            SELECT max(as_of) FROM etf_constituent WHERE etf_isin = ? GROUP BY substr(as_of, 1, 7))`,
    params: [fund.isin, fund.isin],
  });
  // One transaction: a crash midway can never leave half a fund (§10.1).
  await db.batch(writes);
}

export interface StoredHoldings {
  readonly asOf: string;
  readonly fetchedAt: string;
  readonly issuer: string;
  readonly rows: readonly Constituent[];
}

/** The latest contents of each fund, by fund ISIN. */
export async function latestHoldings(db: Db): Promise<Map<string, StoredHoldings>> {
  const rows = await db.query(
    `SELECT c.* FROM etf_constituent c
     JOIN (SELECT etf_isin, max(as_of) AS as_of FROM etf_constituent GROUP BY etf_isin) latest
       ON latest.etf_isin = c.etf_isin AND latest.as_of = c.as_of
     ORDER BY c.etf_isin, c.position`,
  );
  const out = new Map<string, { asOf: string; fetchedAt: string; issuer: string; rows: Constituent[] }>();
  for (const r of rows) {
    const isin = String(r['etf_isin']);
    let entry = out.get(isin);
    if (!entry) {
      entry = { asOf: String(r['as_of']), fetchedAt: String(r['fetched_at']), issuer: String(r['issuer']), rows: [] };
      out.set(isin, entry);
    }
    entry.rows.push({
      name: String(r['name']),
      weightPct: Number(r['weight_pct']),
      isin: (r['constituent_isin'] as string | null) ?? null,
      sedol: (r['sedol'] as string | null) ?? null,
      country: (r['country_label'] as string | null) ?? null,
      sector: (r['sector_label'] as string | null) ?? null,
      currency: (r['currency'] as string | null) ?? null,
      kind: r['kind'] === 'cash' ? 'cash' : 'equity',
    });
  }
  return out;
}
