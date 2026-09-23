/**
 * Pressing refresh.  PROJECT-PLAN.md §6A.1, §10.1, §10.2
 *
 *   1. holdings from Trading 212
 *   2. what kind each one is (fund or share) — asked of T212 only when unknown
 *   3. the contents of each held fund, and of the iShares reference funds —
 *      skipped when already fetched today (they change daily at most)
 *
 * Every source ends in a report: ok, already fresh, unavailable, or rejected.
 * Only validated data is stored; a failure leaves the last good data in place
 * for the screens to show, marked with its date.
 *
 * Company lookups (classify/lookup.ts) are separate: they take minutes, so
 * the screens do not wait for them.
 */
import type { Transport, ParseTools } from '../fetch/types.ts';
import type { Diagnostics } from '../fetch/diagnostics.ts';
import type { Db, Statement } from '../db/types.ts';
import { fetchSource } from '../fetch/record.ts';
import { positions, instruments } from '../sources/t212.ts';
import { FUNDS, SOURCES, fundByIsin } from '../sources/funds.ts';
import { saveFundHoldings, latestHoldings } from './fund-store.ts';
import { classifications, securityStatement, fieldStatement } from './master.ts';
import { lookthrough, type Lookthrough, type Position } from './lookthrough.ts';
import { money } from '../lib/money.ts';

export interface RefreshDeps {
  readonly db: Db;
  readonly diagnostics: Diagnostics;
  /** Fund issuers and other public sites. */
  readonly web: Transport;
  /** Trading 212, through Rust's allow-list. */
  readonly t212: Transport;
  readonly tools?: ParseTools;
  readonly now?: () => Date;
  readonly pause?: (ms: number) => Promise<void>;
}

export interface SourceReport {
  readonly label: string;
  readonly kind: 'ok' | 'fresh' | 'unavailable' | 'suspect';
  readonly detail?: string;
}

export async function refresh(deps: RefreshDeps): Promise<readonly SourceReport[]> {
  const now = deps.now ?? (() => new Date());
  const pause = () => (deps.pause ?? sleep)(1000);
  const reports: SourceReport[] = [];
  const common = { db: deps.db, diagnostics: deps.diagnostics, now, ...(deps.tools ? { tools: deps.tools } : {}) };

  // 1 ── holdings ─────────────────────────────────────────────────────────
  const held = await fetchSource(positions, '', { ...common, transport: deps.t212 });
  if (held.kind === 'ok') {
    const at = now().toISOString();
    const writes: Statement[] = [];
    for (const p of held.value) {
      // The row needs a kind; which one is decided by instrument_type below.
      writes.push(securityStatement(p.isin, p.name, fundByIsin(p.isin) ? 'etf' : 'equity', at));
      // T212's names read better than the funds' ('NVIDIA' vs 'NVIDIA CORP USD0.001').
      writes.push({ sql: 'UPDATE security SET name = ? WHERE isin = ?', params: [p.name, p.isin] });
      writes.push({
        sql: `INSERT OR REPLACE INTO holding (isin, as_of, t212_ticker, quantity, average_price_paid, price_currency, value, value_currency)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [p.isin, at, p.ticker, p.quantity, p.averagePricePaid, p.priceCurrency, p.value, p.accountCurrency],
      });
    }
    // An empty portfolio is still a snapshot: it records "nothing held".
    writes.push({ sql: 'INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)', params: ['holdings_as_of', at] });
    await deps.db.batch(writes);
    reports.push({ label: 'Trading 212 holdings', kind: 'ok', detail: `${held.value.length} holdings` });
  } else {
    reports.push({ label: 'Trading 212 holdings', ...failure(held) });
  }

  const current = await latestPositions(deps.db);

  // 2 ── fund or share? ───────────────────────────────────────────────────
  const unknown = current.filter((p) => p.kind === null);
  if (unknown.length > 0) {
    const types = await fetchSource(instruments, '', { ...common, transport: deps.t212 });
    if (types.kind === 'ok') {
      const day = now().toISOString().slice(0, 10);
      await deps.db.batch(unknown.flatMap((p) => {
        const type = types.value.get(p.isin);
        return type ? [
          fieldStatement(p.isin, 'instrument_type', type, 't212', 1, day),
          { sql: 'UPDATE security SET kind = ? WHERE isin = ?', params: [type === 'ETF' ? 'etf' : 'equity', p.isin] },
        ] : [];
      }));
      reports.push({ label: 'Trading 212 instrument list', kind: 'ok' });
    } else {
      reports.push({ label: 'Trading 212 instrument list', ...failure(types) });
    }
  }

  // 3 ── fund contents ────────────────────────────────────────────────────
  const heldIsins = new Set(current.map((p) => p.isin));
  const wanted = FUNDS.filter((f) => f.reference || heldIsins.has(f.isin));
  const stored = await latestHoldings(deps.db);
  const today = now().toISOString().slice(0, 10);

  for (const fund of wanted) {
    const label = `${fund.ticker} contents${fund.reference && !heldIsins.has(fund.isin) ? ' (reference)' : ''}`;
    if (stored.get(fund.isin)?.fetchedAt.slice(0, 10) === today) {
      reports.push({ label, kind: 'fresh' });
      continue;
    }
    const out = await fetchSource(SOURCES[fund.issuer], fund.key, { ...common, transport: deps.web });
    await pause();
    if (out.kind === 'ok') {
      await saveFundHoldings(deps.db, fund, out.value, now().toISOString());
      reports.push({ label, kind: 'ok', ...(out.value.asOf ? { detail: `as of ${out.value.asOf}` } : {}) });
    } else {
      reports.push({ label, ...failure(out) });
    }
  }
  return reports;
}

function failure(out: { kind: 'unavailable'; reason: string } | { kind: 'suspect'; failure: { check: string; expected: string; observed: string } }):
  Pick<SourceReport, 'kind' | 'detail'> {
  return out.kind === 'unavailable'
    ? { kind: 'unavailable', detail: out.reason }
    : { kind: 'suspect', detail: `${out.failure.observed} (expected ${out.failure.expected}) — nothing saved` };
}

// ── reading back ─────────────────────────────────────────────────────────

interface StoredPosition { readonly isin: string; readonly name: string; readonly kind: 'equity' | 'etf' | null; readonly value: number; }

/** The most recent holdings snapshot. */
async function latestPositions(db: Db): Promise<StoredPosition[]> {
  const rows = await db.query(
    `SELECT h.isin, s.name, f.value AS instrument_type, h.value
     FROM holding h
     JOIN security s ON s.isin = h.isin
     LEFT JOIN security_field f ON f.isin = h.isin AND f.field = 'instrument_type' AND f.source = 't212'
     WHERE h.as_of = (SELECT value FROM app_state WHERE key = 'holdings_as_of')`,
  );
  return rows.map((r) => {
    const isin = String(r['isin']);
    // A known fund is a fund. Anything else is a share only once T212's
    // instrument list has said so — never assumed.
    const type = r['instrument_type'];
    const kind = fundByIsin(isin) || type === 'ETF' ? 'etf' : type ? 'equity' : null;
    return { isin, name: String(r['name']), kind, value: Number(r['value']) };
  });
}

export interface Portfolio {
  /** When holdings were last fetched successfully; null before the first time. */
  readonly holdingsAsOf: string | null;
  readonly funds: readonly { readonly ticker: string; readonly asOf: string; readonly held: boolean }[];
  readonly result: Lookthrough;
}

/** Everything the portfolio screens show, from stored data only. */
export async function loadPortfolio(db: Db): Promise<Portfolio> {
  const [asOfRow] = await db.query("SELECT value FROM app_state WHERE key = 'holdings_as_of'");
  const held = await latestPositions(db);
  const stored = await latestHoldings(db);

  const unknownKind = held.filter((p) => p.kind === null);
  const positionsIn: Position[] = held.map((p) => ({
    isin: p.isin, name: p.name, kind: p.kind ?? 'etf', value: money(p.value, 'GBP'),
  }));
  const contents = new Map([...stored].flatMap(([isin, h]) => {
    const fund = fundByIsin(isin);
    return fund ? [[isin, { ticker: fund.ticker, issuer: h.issuer, asOf: h.asOf, rows: h.rows }] as const] : [];
  }));

  let result = lookthrough({ positions: positionsIn, contents, classifications: await classifications(db) });
  // A holding of unknown kind is treated as a fund that cannot be opened —
  // so it refuses the breakdowns rather than being counted as one company.
  if (unknownKind.length > 0 && result.breakdowns.kind === 'refused') {
    result = { ...result, breakdowns: { kind: 'refused', reasons: result.breakdowns.reasons.map((r) =>
      unknownKind.some((u) => r.startsWith(u.name)) ? `${r} (not yet known whether it is a fund or a share)` : r) } };
  }

  const heldIsins = new Set(held.map((p) => p.isin));
  return {
    holdingsAsOf: asOfRow ? String(asOfRow['value']) : null,
    funds: [...contents].map(([isin, c]) => ({ ticker: c.ticker, asOf: c.asOf, held: heldIsins.has(isin) })),
    result,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
