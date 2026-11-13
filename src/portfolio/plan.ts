/**
 * The planning area — "what if", never "do".  PROJECT-PLAN.md §11.10 step 5.5, §6A.4
 *
 * As gone through on 2026-11-13:
 *   - Buying: amounts in pounds for one company he has opened and reviewed
 *     (£500, £750 …), each beside "now", his funds counted in. He does not
 *     compare companies with each other.
 *   - Selling: a price HE types (in the share's own currency) and how many
 *     units; the app works out what follows, purification included.
 *   - Trading 212's 0.15% currency fee is included; the Bank of England rate
 *     and the fee are both stated.
 *   - Each plan is kept with its date — what he typed and what the app showed.
 *
 * 🔴 Nothing here can place an order, and the app proposes no amount and no
 *    price (§2: it informs, never advises). These functions only read and
 *    calculate; `savePlan` writes a record of what was weighed, nothing else.
 */
import type { Db } from '../db/types.ts';
import { money } from '../lib/money.ts';
import { lookthrough, type Lookthrough, type Breakdowns, type CompanyExposure, type LookthroughInput } from './lookthrough.ts';
import { portfolioInput } from './refresh.ts';
import { fromPounds, toPounds, type RatesOutcome, type Conversion } from './fx.ts';
import { loadPurification } from './purify.ts';
import { loadPrices } from '../research/prices.ts';
import { DISPLAY_NAME } from '../research/report.ts';

export interface Share { readonly value: number; readonly share: number; }
export interface Row { readonly key: string; readonly before: Share; readonly after: Share; }

export interface CompanyNow {
  readonly direct: number;
  readonly viaFunds: readonly { readonly fund: string; readonly value: number }[];
  readonly total: number;
  readonly share: number;
}

export interface Units {
  /** Part-shares: what the pounds buy. */
  readonly units: number;
  /** Whole shares only, and the pounds left over. */
  readonly whole: number;
  readonly leftover: number;
  readonly price: { readonly amount: number; readonly currency: string; readonly date: string };
  readonly rate: Conversion['rate'];
}

export interface BuyOption {
  readonly pounds: number;
  readonly company: CompanyNow;
  readonly sectors: readonly Row[];
  readonly countries: readonly Row[];
  /** The ten largest companies afterwards, with where each stood before. */
  readonly largest: readonly Row[];
  readonly units: Units | { readonly reason: string };
}

export type BuyPlan =
  | {
    readonly kind: 'ok';
    readonly isin: string;
    readonly name: string;
    readonly total: number;
    readonly now: CompanyNow;
    readonly sector: string | null;
    readonly country: string | null;
    readonly options: readonly BuyOption[];
  }
  | { readonly kind: 'refused'; readonly reason: string };

const companyIn = (b: Breakdowns, isin: string): CompanyExposure | undefined => b.companies.find((c) => c.isins.includes(isin));
const nowOf = (c: CompanyExposure | undefined): CompanyNow => c
  ? { direct: c.direct.amount, viaFunds: c.viaFunds.map((v) => ({ fund: v.fund, value: v.value.amount })), total: c.total.amount, share: c.share }
  : { direct: 0, viaFunds: [], total: 0, share: 0 };

function rows<K>(before: readonly { key: K; value: { amount: number }; share: number }[],
  after: readonly { key: K; value: { amount: number }; share: number }[], keys: readonly K[]): Row[] {
  return keys.map((k) => {
    const b = before.find((x) => x.key === k), a = after.find((x) => x.key === k);
    return { key: String(k), before: { value: b?.value.amount ?? 0, share: b?.share ?? 0 }, after: { value: a?.value.amount ?? 0, share: a?.share ?? 0 } };
  });
}

async function latestPrice(db: Db, isin: string): Promise<{ amount: number; currency: string; date: string } | null> {
  const listings = await db.query('SELECT id FROM listing WHERE isin = ? ORDER BY id', [isin]);
  for (const l of listings) {
    const p = await loadPrices(db, Number(l['id']));
    const last = p?.bars.at(-1);
    if (p && last) return { amount: last.close, currency: p.currency, date: last.date };
  }
  return null;
}

/** What the pounds buy: part-shares, and whole shares with the pounds left over. */
export function unitsFor(pounds: number, price: { amount: number; currency: string; date: string }, rates: RatesOutcome): Units | { reason: string } {
  const spend = fromPounds(pounds, price.currency, rates, 'buy');
  if ('reason' in spend) return spend;
  // One unit in pounds, at the same rate and fee: pence ÷ 100 needs neither.
  const perUnit = price.currency === 'GBp' || price.currency === 'GBX' ? price.amount / 100
    : spend.rate ? price.amount / spend.rate.applied : price.amount;
  const units = pounds / perUnit;
  const whole = Math.floor(units + 1e-9);
  return { units, whole, leftover: pounds - whole * perUnit, price, rate: spend.rate };
}

/** What a buying plan needs about the company: from opening it (§7.2). */
export interface PlanCompany {
  readonly isin: string;
  readonly name: string;
  readonly price: { readonly amount: number; readonly currency: string; readonly date: string } | null;
}

/** The arithmetic, on stored data passed in: the same in the app and the demo. */
export function buyPlanFrom(input: LookthroughInput, company: PlanCompany, amounts: readonly number[], rates: RatesOutcome): BuyPlan {
  const good = amounts.filter((a) => Number.isFinite(a) && a > 0);
  if (good.length === 0) return { kind: 'refused', reason: 'Type an amount in pounds' };
  const { isin, name, price } = company;
  const before: Lookthrough = lookthrough(input);
  if (before.breakdowns.kind !== 'ok') return { kind: 'refused', reason: `the portfolio's breakdowns are withheld: ${before.breakdowns.reasons.join('; ')}` };
  const b = before.breakdowns;
  const c = input.classifications.get(isin);

  const options: BuyOption[] = good.map((pounds) => {
    const after = lookthrough({ ...input, positions: [...input.positions, { isin, name, kind: 'equity', value: money(pounds, 'GBP') }] });
    const a = after.breakdowns as Breakdowns;   // the same funds as before: cannot be refused
    const sectorKeys = [...new Set([...a.sectors.slice(0, 6).map((s) => s.key), ...b.sectors.slice(0, 6).map((s) => s.key)])];
    const countryKeys = [...new Set([...a.countries.slice(0, 6).map((s) => s.key), ...b.countries.slice(0, 6).map((s) => s.key)])];
    const largest = a.companies.slice(0, 10).map((x) => {
      const was = b.companies.find((y) => y.isins.some((i) => x.isins.includes(i)) || y.name === x.name);
      return { key: x.isins.includes(isin) ? name : x.name, before: { value: was?.total.amount ?? 0, share: was?.share ?? 0 }, after: { value: x.total.amount, share: x.share } };
    });
    return {
      pounds, company: nowOf(companyIn(a, isin)),
      sectors: rows(b.sectors, a.sectors, sectorKeys).sort((x, y) => y.after.value - x.after.value),
      countries: rows(b.countries, a.countries, countryKeys).sort((x, y) => y.after.value - x.after.value),
      largest,
      units: price ? unitsFor(pounds, price, rates) : { reason: 'no price stored — refresh the company' },
    };
  });

  return {
    kind: 'ok', isin, name, total: before.total.amount, now: nowOf(companyIn(b, isin)),
    sector: c?.sector?.label ?? null, country: c?.country?.label ?? null, options,
  };
}

/** A company he has opened (and so reviewed): it has a listing, a classification and prices. */
export async function planCompany(db: Db, isin: string): Promise<PlanCompany | null> {
  const [sec] = await db.query(`SELECT ${DISPLAY_NAME} AS name FROM security s WHERE s.isin = ? AND EXISTS (SELECT 1 FROM listing l WHERE l.isin = s.isin)`, [isin]);
  return sec ? { isin, name: String(sec['name']), price: await latestPrice(db, isin) } : null;
}

export async function planBuy(db: Db, isin: string, amounts: readonly number[], rates: RatesOutcome): Promise<BuyPlan> {
  const company = await planCompany(db, isin);
  if (!company) return { kind: 'refused', reason: 'Open the company first: the plan needs its sector, country and price' };
  return buyPlanFrom((await portfolioInput(db)).input, company, amounts, rates);
}

// ── selling ──────────────────────────────────────────────────────────────

export type SellPlan =
  | {
    readonly kind: 'ok';
    readonly isin: string;
    readonly name: string;
    readonly units: number;
    readonly held: number;
    readonly price: { readonly amount: number; readonly currency: string };
    /** The sale in the share's currency. */
    readonly proceeds: { readonly amount: number; readonly currency: string };
    /** In pounds, at the Bank of England rate after Trading 212's fee; or why not. */
    readonly pounds: Conversion | { readonly reason: string };
    /** What these units cost him, in pounds (Trading 212's figure). */
    readonly cost: number | null;
    readonly costReason: string | null;
    readonly profit: number | null;
    readonly ratePct: number | null;
    /** Dividends not yet counted at a sale (5.4's rule): they would count at this one. */
    readonly dividends: readonly { readonly paidOn: string; readonly pounds: number }[];
    readonly purification: number | null;
    /** What he would receive less what he would give. */
    readonly left: number | null;
    readonly profitAfter: number | null;
    /** Worth per unit now, from his holding: for reference beside the price he types. */
    readonly nowPerUnit: number;
  }
  | { readonly kind: 'refused'; readonly reason: string };

const pennies = (n: number) => Math.round(n * 100) / 100;

/** What a selling plan needs about the holding: from the last refresh. */
export interface PlanHolding {
  readonly isin: string;
  readonly name: string;
  readonly quantity: number;
  /** As Trading 212 writes it: ⚠️ 'GBX' is pence. */
  readonly priceCurrency: string;
  /** Worth now, in pounds. */
  readonly value: number;
  readonly totalCost: number | null;
  readonly totalCostCurrency: string | null;
}

export interface PlanIncome {
  readonly ratePct: number | null;
  /** Dividends not yet counted at a sale (5.4's rule). */
  readonly dividends: readonly { readonly paidOn: string; readonly pounds: number }[];
}

/** The arithmetic, on stored data passed in: the same in the app and the demo. */
export function sellPlanFrom(h: PlanHolding, price: number, units: number | null, rates: RatesOutcome, income: PlanIncome): SellPlan {
  if (!Number.isFinite(price) || price <= 0) return { kind: 'refused', reason: 'Type a price' };
  const held = h.quantity;
  const n = units ?? held;
  if (!Number.isFinite(n) || n <= 0) return { kind: 'refused', reason: 'Type how many units' };
  if (n > held + 1e-9) return { kind: 'refused', reason: `You hold ${held} units` };
  const shown = h.priceCurrency === 'GBX' ? 'GBp' : h.priceCurrency;
  const proceeds = price * n;
  const pounds = toPounds(proceeds, h.priceCurrency, rates, 'sell');

  const costReason = h.totalCost === null ? 'What it cost is not stored yet — press Refresh on the portfolio once'
    : h.totalCostCurrency !== 'GBP' ? `Trading 212 gave the cost in ${h.totalCostCurrency}, not pounds` : null;
  const cost = costReason ? null : pennies(h.totalCost! * n / held);
  const profit = cost !== null && 'pounds' in pounds ? pennies(pounds.pounds - cost) : null;

  const { ratePct, dividends } = income;
  const divTotal = dividends.reduce((s, d) => s + d.pounds, 0);
  const give = ratePct !== null && profit !== null ? pennies((ratePct / 100) * (Math.max(profit, 0) + divTotal)) : null;

  return {
    kind: 'ok', isin: h.isin, name: h.name, units: n, held,
    price: { amount: price, currency: shown }, proceeds: { amount: proceeds, currency: shown },
    pounds, cost, costReason, profit, ratePct, dividends, purification: give,
    left: give !== null && 'pounds' in pounds ? pennies(pounds.pounds - give) : null,
    profitAfter: give !== null && profit !== null ? pennies(profit - give) : null,
    nowPerUnit: h.value / held,
  };
}

/** Each holding as the last refresh left it. */
export async function planHoldings(db: Db): Promise<PlanHolding[]> {
  const rows = await db.query(
    `SELECT h.isin, h.quantity, h.price_currency, h.value, h.total_cost, h.total_cost_currency, s.name FROM holding h JOIN security s ON s.isin = h.isin
     WHERE h.as_of = (SELECT value FROM app_state WHERE key = 'holdings_as_of')`);
  return rows.map((h) => ({
    isin: String(h['isin']), name: String(h['name']), quantity: Number(h['quantity']), priceCurrency: String(h['price_currency']), value: Number(h['value']),
    totalCost: h['total_cost'] === null ? null : Number(h['total_cost']),
    totalCostCurrency: h['total_cost_currency'] === null ? null : String(h['total_cost_currency']),
  }));
}

export async function planIncome(db: Db, isin: string): Promise<PlanIncome> {
  const p = await loadPurification(db);
  return { ratePct: p.usualRate, dividends: (p.notYetCounted.get(isin) ?? []).map((d) => ({ paidOn: d.paidOn, pounds: d.pounds })) };
}

export async function planSell(db: Db, isin: string, price: number, units: number | null, rates: RatesOutcome): Promise<SellPlan> {
  const h = (await planHoldings(db)).find((x) => x.isin === isin);
  if (!h) return { kind: 'refused', reason: 'Not held at the last refresh' };
  return sellPlanFrom(h, price, units, rates, await planIncome(db, isin));
}

// ── kept ─────────────────────────────────────────────────────────────────

export interface SavedPlan {
  readonly id: number;
  readonly kind: 'buy' | 'sell';
  readonly isin: string;
  readonly name: string;
  readonly createdAt: string;
  readonly inputs: unknown;
  readonly outcome: unknown;
}

export async function savePlan(db: Db, plan: { kind: 'buy' | 'sell'; isin: string; name: string; inputs: unknown; outcome: unknown }, now: Date): Promise<void> {
  await db.query('INSERT INTO plan (kind, isin, name, created_at, inputs, outcome) VALUES (?, ?, ?, ?, ?, ?)',
    [plan.kind, plan.isin, plan.name, now.toISOString(), JSON.stringify(plan.inputs), JSON.stringify(plan.outcome)]);
}

export async function listPlans(db: Db, isin?: string): Promise<SavedPlan[]> {
  const rows = await db.query(`SELECT * FROM plan ${isin ? 'WHERE isin = ?' : ''} ORDER BY created_at DESC, id DESC`, isin ? [isin] : []);
  return rows.map((r) => ({
    id: Number(r['id']), kind: String(r['kind']) as 'buy' | 'sell', isin: String(r['isin']), name: String(r['name']),
    createdAt: String(r['created_at']), inputs: JSON.parse(String(r['inputs'])), outcome: JSON.parse(String(r['outcome'])),
  }));
}
