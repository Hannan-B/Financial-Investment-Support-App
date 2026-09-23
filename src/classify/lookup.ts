/**
 * Classifying companies no fund source classifies.  PROJECT-PLAN.md §4.4b
 *
 * Search stockanalysis by name, open the likeliest listings, and accept the
 * first whose page shows exactly the ISIN asked for. Largest holdings first,
 * one request at a time with a pause between, so the first run classifies
 * most of the weight within minutes and the tail follows.
 *
 * Results are remembered: a found company is never looked up again; one with
 * no match is retried after a month, in case the site adds it.
 */
import type { FetchDeps } from '../fetch/record.ts';
import { fetchSource } from '../fetch/record.ts';
import { search, profile, rankHits, searchQuery, type Profile } from '../sources/stockanalysis.ts';
import { securityStatement, fieldStatement } from '../portfolio/master.ts';
import type { Statement } from '../db/types.ts';

export interface LookupDeps extends FetchDeps {
  /** Waits between requests. Tests pass a no-op. */
  readonly pause?: (ms: number) => Promise<void>;
  readonly paceMs?: number;
}

export type LookupResult =
  | { readonly kind: 'found'; readonly page: string; readonly profile: Profile }
  | { readonly kind: 'not-found'; readonly detail: string }
  /** The site did not answer properly. Nothing is concluded; try again later. */
  | { readonly kind: 'failed'; readonly reason: string };

/** At most this many profile pages per search — bounds the cost of a miss. */
const MAX_CANDIDATES = 4;

export async function lookupCompany(isin: string, fundName: string, deps: LookupDeps): Promise<LookupResult> {
  const pause = () => (deps.pause ?? sleep)(deps.paceMs ?? 1000);
  const full = searchQuery(fundName);
  const queries = [...new Set([full, full.split(' ').slice(0, 2).join(' ')])].filter(Boolean);
  const tried: string[] = [];
  const seen = new Set<string>();

  for (const query of queries) {
    const found = await fetchSource(search, query, deps);
    await pause();
    if (found.kind !== 'ok') return { kind: 'failed', reason: describe(found) };

    const candidates = rankHits(isin, found.value).filter((h) => !seen.has(h.profile)).slice(0, MAX_CANDIDATES);
    for (const hit of candidates) {
      seen.add(hit.profile);
      const page = await fetchSource(profile, hit.profile, deps);
      await pause();
      if (page.kind === 'unavailable') return { kind: 'failed', reason: page.reason };
      if (page.kind === 'suspect') { tried.push(`${hit.symbol} (unreadable)`); continue; }
      if (page.value.isin === isin) return { kind: 'found', page: hit.profile, profile: page.value };
      tried.push(`${hit.symbol} is ${page.value.isin ?? 'no ISIN'}`);
    }
    tried.push(`searched "${query}"`);
  }
  return { kind: 'not-found', detail: tried.join('; ') };
}

export interface Company { readonly isin: string; readonly name: string; readonly weight: number; }

export interface ClassifySummary {
  readonly found: number;
  readonly notFound: number;
  /** Set when the run stopped early because the site stopped answering. */
  readonly stopped?: string;
}

/**
 * Look up every company that has no sector yet, largest first.
 * Stops at the first failure: if the site is down or throttling, carrying on
 * would only hammer it.
 */
export async function classifyMissing(
  companies: readonly Company[],
  deps: LookupDeps,
  opts: { readonly retryAfterDays?: number; readonly onProgress?: (done: number, total: number) => void } = {},
): Promise<ClassifySummary> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - (opts.retryAfterDays ?? 30) * 86_400_000).toISOString();

  const classified = new Set((await deps.db.query(
    "SELECT DISTINCT isin FROM security_field WHERE field = 'sector'",
  )).map((r) => String(r['isin'])));
  const recentlyMissed = new Set((await deps.db.query(
    "SELECT isin FROM lookup_attempt WHERE source = 'stockanalysis' AND outcome = 'not-found' AND attempted_at > ?",
    [cutoff],
  )).map((r) => String(r['isin'])));

  const todo = [...companies]
    .filter((c) => !classified.has(c.isin) && !recentlyMissed.has(c.isin))
    .sort((a, b) => b.weight - a.weight);

  let found = 0;
  let notFound = 0;
  for (const [i, company] of todo.entries()) {
    const result = await lookupCompany(company.isin, company.name, deps);
    const at = (deps.now ?? (() => new Date()))().toISOString();

    if (result.kind === 'failed') return { found, notFound, stopped: result.reason };

    const writes: Statement[] = [];
    if (result.kind === 'found') {
      found++;
      const day = at.slice(0, 10);
      writes.push(securityStatement(company.isin, company.name, 'equity', at));
      for (const field of ['sector', 'industry', 'country'] as const) {
        const value = result.profile[field];
        if (value) writes.push(fieldStatement(company.isin, field, value, 'stockanalysis', 2, day));
      }
    } else {
      notFound++;
    }
    writes.push({
      sql: `INSERT INTO lookup_attempt (isin, source, attempted_at, outcome, detail) VALUES (?, 'stockanalysis', ?, ?, ?)
            ON CONFLICT (isin, source) DO UPDATE SET
              attempted_at = excluded.attempted_at, outcome = excluded.outcome, detail = excluded.detail`,
      params: [company.isin, at, result.kind, result.kind === 'found' ? result.page : result.detail],
    });
    await deps.db.batch(writes);
    opts.onProgress?.(i + 1, todo.length);
  }
  return { found, notFound };
}

function describe(out: { kind: string; reason?: string; failure?: { check: string; observed: string } }): string {
  return out.kind === 'unavailable' ? out.reason ?? 'unavailable' : `${out.failure?.check}: ${out.failure?.observed}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
