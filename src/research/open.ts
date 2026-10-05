/**
 * Opening a company for research: from a Trading 212 catalogue entry to a
 * listing every website can be asked about.  PROJECT-PLAN.md §7.2
 *
 *   1. stockanalysis page whose ISIN is exactly the entry's (the Phase 1
 *      lookup; a page found earlier is re-read and re-checked, not trusted)
 *   2. the names each site uses, from that page: 'LON-SHEL' → Yahoo 'SHEL.L',
 *      stockanalysis 'lon/SHEL'; 'AAPL' → Yahoo, Finviz and EDGAR 'AAPL'
 *   3. Yahoo's prices must be quoted in the currency Trading 212 quotes in —
 *      one ISIN can trade in London in pence and in Amsterdam in euros
 *
 * Anything that does not line up stops here, with the reason. A company is
 * never opened on a guess.
 */
import { fetchSource } from '../fetch/record.ts';
import { profile, type Profile } from '../sources/stockanalysis.ts';
import { yahooPrices } from '../sources/yahoo.ts';
import { lookupCompany, type LookupDeps } from '../classify/lookup.ts';
import { securityStatement, fieldStatement, ensureListing } from '../portfolio/master.ts';
import { savePrices } from './prices.ts';
import type { Db } from '../db/types.ts';

export type Opened =
  | { readonly kind: 'opened'; readonly listingId: number }
  | { readonly kind: 'refused'; readonly reason: string };

/** Trading 212's currency codes as Yahoo and the rest of the app write them. */
function yahooCurrency(t212: string): string {
  return t212 === 'GBX' ? 'GBp' : t212;
}

/** A listing already opened for this ISIN, if any. */
export async function listingFor(db: Db, isin: string): Promise<number | null> {
  const [row] = await db.query(
    `SELECT l.id FROM listing l JOIN listing_source_key k ON k.listing_id = l.id AND k.source = 'yahoo' WHERE l.isin = ?`,
    [isin],
  );
  return row ? Number(row['id']) : null;
}

export async function openCompany(t212Ticker: string, deps: LookupDeps): Promise<Opened> {
  const [entry] = await deps.db.query('SELECT * FROM instrument WHERE t212_ticker = ?', [t212Ticker]);
  if (!entry) return { kind: 'refused', reason: `${t212Ticker} is not in Trading 212's list` };
  const isin = String(entry['isin']);
  const name = String(entry['name']);
  const t212Currency = String(entry['currency']);
  if (entry['type'] !== 'STOCK') return { kind: 'refused', reason: `${name} is a fund; funds are opened up in the portfolio` };

  const existing = await listingFor(deps.db, isin);
  if (existing !== null) return { kind: 'opened', listingId: existing };

  // 1 ── the stockanalysis page for exactly this ISIN ──
  let page: string | null = null;
  let found: Profile | null = null;
  const [earlier] = await deps.db.query(
    "SELECT detail FROM lookup_attempt WHERE isin = ? AND source = 'stockanalysis' AND outcome = 'found'", [isin],
  );
  if (earlier) {
    const out = await fetchSource(profile, String(earlier['detail']), deps);
    if (out.kind === 'ok' && out.value.isin === isin) { page = String(earlier['detail']); found = out.value; }
  }
  if (!found) {
    const r = await lookupCompany(isin, name, deps);
    if (r.kind === 'failed') return { kind: 'refused', reason: `stockanalysis did not answer: ${r.reason}` };
    if (r.kind === 'not-found') return { kind: 'refused', reason: `no page on stockanalysis shows ISIN ${isin} (${r.detail})` };
    page = r.page;
    found = r.profile;
  }
  const info = found.listing;
  if (!info) return { kind: 'refused', reason: `the stockanalysis page for ${name} does not say how it is listed` };
  if (yahooCurrency(info.priceCurrency) !== yahooCurrency(t212Currency)) {
    return { kind: 'refused', reason: `stockanalysis quotes ${name} in ${info.priceCurrency}, Trading 212 in ${t212Currency}: not the same listing` };
  }

  // 2 ── each site's name for it ──
  const us = info.yahooSuffix === '' && !info.uid.includes('-');
  if (!us && info.yahooSuffix === '') return { kind: 'refused', reason: `the market of ${info.uid} (${info.exchange}) is not yet supported` };
  const ticker = us ? info.uid : info.uid.slice(info.uid.indexOf('-') + 1);
  const dashed = ticker.replace(/\./g, '-'); // BRK.B → BRK-B, BT.A → BT-A, as Yahoo, Finviz and EDGAR write them
  const yahoo = us ? dashed : `${dashed}${info.yahooSuffix}`;
  const stockanalysis = /^\/(?:quote\/([a-z]+\/[^/]+)|stocks\/([^/]+))\/company\/$/.exec(page!);
  const saSymbol = stockanalysis?.[1] ?? stockanalysis?.[2];
  if (!saSymbol) return { kind: 'refused', reason: `unrecognised stockanalysis page: ${page}` };

  // 3 ── Yahoo agrees on the currency ──
  const prices = await fetchSource(yahooPrices, yahoo, deps);
  if (prices.kind !== 'ok') {
    return { kind: 'refused', reason: `Yahoo has no prices for ${yahoo}: ${prices.kind === 'unavailable' ? prices.reason : prices.failure.observed}` };
  }
  if (prices.value.currency !== yahooCurrency(t212Currency)) {
    return { kind: 'refused', reason: `Yahoo quotes ${yahoo} in ${prices.value.currency}, Trading 212 in ${t212Currency}: not the same listing` };
  }

  const today = (deps.now ?? (() => new Date()))().toISOString();
  await deps.db.batch([
    securityStatement(isin, name, 'equity', today),
    ...(found.sector ? [fieldStatement(isin, 'sector', found.sector, 'stockanalysis', 2, today.slice(0, 10))] : []),
    ...(found.industry ? [fieldStatement(isin, 'industry', found.industry, 'stockanalysis', 2, today.slice(0, 10))] : []),
    ...(found.country ? [fieldStatement(isin, 'country', found.country, 'stockanalysis', 2, today.slice(0, 10))] : []),
  ]);
  const listingId = await ensureListing(deps.db, {
    isin, ticker, exchange: prices.value.exchange, currency: prices.value.currency,
    sourceKeys: { yahoo, stockanalysis: saSymbol, t212: t212Ticker, ...(us ? { finviz: dashed } : {}) },
  });
  await savePrices(deps.db, listingId, prices.value);
  return { kind: 'opened', listingId };
}
