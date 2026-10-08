/**
 * Key statistics for London and European shares, from stockanalysis.com.
 * PROJECT-PLAN.md §3, §7.1, §11.7 step 2.7
 *
 * The counterpart of Finviz's snapshot (research/finviz.ts), on the same
 * field paths wherever the concept is the same, so one Key statistics panel
 * serves both. Forecasts go under `analyst.`, as estimates.
 *
 * 🔴 The currency trap. The page states three currencies, and on Shell's
 *    they are not the same: company amounts in POUNDS (converted by the site
 *    from Shell's dollars), the target price in PENCE, dividends in pounds.
 *    Every figure names which one it is in, and each currency is confirmed
 *    against a figure the page states independently before anything in it
 *    is taken:
 *      main      market value ÷ shares in issue = the price, in that currency
 *      price     the page's own listing currency is the listing's; and the
 *                target agrees with the stated distance from the price
 *      dividend  dividend ÷ price = the stated yield
 *    A figure whose currency cannot be confirmed is a gap with the reason —
 *    never a number that might be a hundred times wrong.
 *
 * Optional throughout: the report works fully without it (§3).
 */
import { fetchSource } from '../fetch/record.ts';
import { statistics, siteUid, type StatisticsPage } from '../sources/stockanalysis.ts';
import { isCurrency, type Currency } from '../lib/money.ts';
import { monthDayYear } from '../lib/dates.ts';
import type { Fact, Gap, FiguresOutcome } from './figures.ts';
import type { FiguresDeps } from './edgar.ts';
import { statisticsDates } from './calendar.ts';

/** Which of the page's currencies a money figure is in. */
type In = 'main' | 'price' | 'dividend';
type Unit = 'amount' | 'per-share' | 'ratio' | 'percent' | 'count' | 'shares' | 'days' | 'score' | 'date' | 'text';

interface Field {
  /** The site's id for the figure: 'evEbitda'. */
  readonly id: string;
  readonly path: string;
  /** What the report calls it — Finviz's name where the path is shared. */
  readonly name: string;
  readonly unit: Unit;
  /** Required for 'amount' and 'per-share'. */
  readonly in?: In;
  readonly kind?: 'estimate';
}

const f = (id: string, path: string, name: string, unit: Unit, more: { in?: In; kind?: 'estimate' } = {}): Field =>
  ({ id, path, name, unit, ...more });
const MAIN = { in: 'main' } as const;
const ESTIMATE = { kind: 'estimate' } as const;

const FIELDS: readonly Field[] = [
  // ── analyst predictions ──
  f('priceTarget', 'analyst.target_price', 'Target price', 'per-share', { in: 'price', kind: 'estimate' }),
  f('analystRatings', 'analyst.consensus', 'Consensus rating', 'text', ESTIMATE),
  // How many forecasts there are is a fact about them, not a forecast.
  f('analystCount', 'analyst.count', 'Analysts covering', 'count'),
  f('peForward', 'analyst.forward_pe', 'Forward P/E', 'ratio', ESTIMATE),
  f('pegRatio', 'analyst.peg', 'PEG (P/E ÷ expected growth)', 'ratio', ESTIMATE),
  f('revenue3y', 'analyst.revenue_growth_next_3y', 'Revenue growth forecast, 3 years', 'percent', ESTIMATE),
  f('eps3y', 'analyst.eps_growth_next_3y', 'Earnings growth forecast, 3 years', 'percent', ESTIMATE),

  // ── valuation ──
  f('marketcap', 'valuation.market_cap', 'Market value', 'amount', MAIN),
  f('enterpriseValue', 'valuation.enterprise_value', 'Enterprise value', 'amount', MAIN),
  f('pe', 'valuation.pe_ttm', 'P/E, last 12 months', 'ratio'),
  f('ps', 'valuation.ps', 'Price ÷ sales', 'ratio'),
  f('pb', 'valuation.pb', 'Price ÷ book value', 'ratio'),
  f('ptbvRatio', 'valuation.p_tangible_book', 'Price ÷ tangible book value', 'ratio'),
  f('pfcf', 'valuation.p_fcf', 'Price ÷ free cash flow', 'ratio'),
  f('pocf', 'valuation.p_ocf', 'Price ÷ operating cash flow', 'ratio'),
  f('evEarnings', 'valuation.ev_earnings', 'EV ÷ earnings', 'ratio'),
  f('evSales', 'valuation.ev_sales', 'EV ÷ sales', 'ratio'),
  f('evEbitda', 'valuation.ev_ebitda', 'EV ÷ EBITDA', 'ratio'),
  f('evEbit', 'valuation.ev_ebit', 'EV ÷ EBIT', 'ratio'),
  f('evFcf', 'valuation.ev_fcf', 'EV ÷ free cash flow', 'ratio'),
  f('bvps', 'valuation.book_per_share', 'Book value per share', 'per-share', MAIN),
  f('earningsYield', 'valuation.earnings_yield', 'Earnings yield', 'percent'),
  f('fcfYield', 'valuation.fcf_yield', 'Free cash flow yield', 'percent'),

  // ── last twelve months — kept apart from the fiscal years (§3) ──
  f('revenue', 'ttm.revenue', 'Revenue, last 12 months', 'amount', MAIN),
  f('gp', 'ttm.gross_profit', 'Gross profit, last 12 months', 'amount', MAIN),
  f('opinc', 'ttm.operating_income', 'Operating income, last 12 months', 'amount', MAIN),
  f('pretax', 'ttm.pretax_income', 'Pre-tax income, last 12 months', 'amount', MAIN),
  f('netinc', 'ttm.net_income', 'Net income, last 12 months', 'amount', MAIN),
  f('ebitda', 'ttm.ebitda', 'EBITDA, last 12 months', 'amount', MAIN),
  f('ebit', 'ttm.ebit', 'EBIT, last 12 months', 'amount', MAIN),
  f('eps', 'ttm.eps', 'Earnings per share, last 12 months', 'per-share', MAIN),
  f('taxexp', 'ttm.income_tax', 'Income tax, last 12 months', 'amount', MAIN),
  f('taxrate', 'ttm.effective_tax_rate', 'Effective tax rate', 'percent'),
  f('ncfo', 'ttm.operating_cash_flow', 'Operating cash flow, last 12 months', 'amount', MAIN),
  f('capex', 'ttm.capex', 'Capital spending, last 12 months', 'amount', MAIN),
  f('depreciationAmortization', 'ttm.depreciation_amortization', 'Depreciation and amortisation, last 12 months', 'amount', MAIN),
  f('netBorrowing', 'ttm.net_borrowing', 'Net borrowing, last 12 months', 'amount', MAIN),
  f('fcf', 'ttm.free_cash_flow', 'Free cash flow, last 12 months', 'amount', MAIN),
  f('fcfps', 'ttm.fcf_per_share', 'Free cash flow per share, last 12 months', 'per-share', MAIN),

  // ── profitability ──
  f('grossMargin', 'profitability.gross_margin', 'Gross margin', 'percent'),
  f('operatingMargin', 'profitability.operating_margin', 'Operating margin', 'percent'),
  f('pretaxMargin', 'profitability.pretax_margin', 'Pre-tax margin', 'percent'),
  f('profitMargin', 'profitability.profit_margin', 'Profit margin', 'percent'),
  f('ebitdaMargin', 'profitability.ebitda_margin', 'EBITDA margin', 'percent'),
  f('ebitMargin', 'profitability.ebit_margin', 'EBIT margin', 'percent'),
  f('fcfMargin', 'profitability.fcf_margin', 'Free cash flow margin', 'percent'),
  f('roa', 'profitability.roa', 'Return on assets', 'percent'),
  f('roe', 'profitability.roe', 'Return on equity', 'percent'),
  f('roic', 'profitability.roic', 'Return on invested capital', 'percent'),
  f('roce', 'profitability.roce', 'Return on capital employed', 'percent'),
  f('assetturnover', 'profitability.asset_turnover', 'Asset turnover', 'ratio'),
  f('inventoryturnover', 'profitability.inventory_turnover', 'Inventory turnover', 'ratio'),

  // ── financial health ──
  f('debtEquity', 'health.debt_equity', 'Debt ÷ equity', 'ratio'),
  f('debtEbitda', 'health.debt_ebitda', 'Debt ÷ EBITDA', 'ratio'),
  f('debtFcf', 'health.debt_fcf', 'Debt ÷ free cash flow', 'ratio'),
  f('currentRatio', 'health.current_ratio', 'Current ratio', 'ratio'),
  f('quickRatio', 'health.quick_ratio', 'Quick ratio', 'ratio'),
  f('interestCoverage', 'health.interest_coverage', 'Interest cover', 'ratio'),
  f('totalcash', 'health.cash', 'Cash and equivalents', 'amount', MAIN),
  f('debt', 'health.total_debt', 'Total debt', 'amount', MAIN),
  f('netcash', 'health.net_cash', 'Net cash (cash − debt)', 'amount', MAIN),
  f('netcashpershare', 'health.net_cash_per_share', 'Net cash per share', 'per-share', MAIN),
  f('equity', 'health.book_value', 'Equity (book value)', 'amount', MAIN),
  f('workingcapital', 'health.working_capital', 'Working capital', 'amount', MAIN),
  f('zScore', 'health.altman_z', 'Altman Z-score', 'score'),
  f('fScore', 'health.piotroski_f', 'Piotroski F-score (0–9)', 'score'),

  // ── dividends ──
  // Not Finviz's "dividend, last 12 months": Shell's £1.154 is close to its
  // latest payment × 4 (£1.157), not its last four payments (£1.128).
  f('dps', 'dividend.annual', 'Annual dividend, at the current rate', 'per-share', { in: 'dividend' }),
  f('dividendYield', 'dividend.annual_yield', 'Dividend yield, at the current rate', 'percent'),
  f('dividendGrowth', 'dividend.growth_1y', 'Dividend growth, past year', 'percent'),
  f('dividendGrowthYears', 'dividend.growth_years', 'Years of dividend growth', 'count'),
  f('payoutRatio', 'dividend.payout', 'Share of earnings paid out', 'percent'),
  f('fcfPayoutRatio', 'dividend.fcf_payout', 'Share of free cash flow paid out', 'percent'),
  f('buybackYield', 'dividend.buyback_yield', 'Buyback yield', 'percent'),
  f('totalReturn', 'dividend.shareholder_yield', 'Shareholder yield (dividends + buybacks)', 'percent'),

  // ── ownership and short interest ──
  f('sharesInsiders', 'ownership.insider_pct', 'Owned by insiders', 'percent'),
  f('sharesInstitutions', 'ownership.institutional_pct', 'Owned by institutions', 'percent'),
  f('shortFloat', 'short.float_pct', 'Shares sold short', 'percent'),
  f('shortShares', 'short.shares_out_pct', 'Shares sold short, of all shares in issue', 'percent'),
  f('shortInterest', 'short.shares', 'Shares sold short, number', 'shares'),
  f('shortPriorMonth', 'short.shares_prior_month', 'Shares sold short, a month before', 'shares'),
  f('shortRatio', 'short.ratio_days', 'Days to cover short sales', 'days'),

  // ── trading ──
  f('beta', 'trading.beta', 'Beta (movement against the market)', 'ratio'),
  f('averageVolume', 'trading.average_volume_20d', 'Average daily volume, 20 days', 'shares'),
  f('ch1y', 'performance.year', 'Price change, year', 'percent'),

  // ── the company ──
  f('employees', 'company.employees', 'Employees', 'count'),
  f('revPerEmployee', 'company.revenue_per_employee', 'Revenue per employee', 'amount', MAIN),
  f('profitPerEmployee', 'company.profit_per_employee', 'Profit per employee', 'amount', MAIN),
  f('sharesout', 'company.shares_outstanding', 'Shares in issue', 'shares'),
  f('sharesOutClass', 'company.shares_in_class', 'Shares in issue, this share class', 'shares'),
  f('float', 'company.shares_float', 'Shares freely traded', 'shares'),
  f('sharesgrowthyoy', 'company.shares_change_year', 'Change in shares in issue, year', 'percent'),
  f('sharesgrowthqoq', 'company.shares_change_quarter', 'Change in shares in issue, quarter', 'percent'),
  f('lastSplitDate', 'company.last_split_date', 'Last share split', 'date'),
  f('splitRatio', 'company.last_split_ratio', 'Last split: new shares for each old', 'ratio'),
];

/** On the page but not read as statistics, and why. */
export const NOT_TAKEN: Readonly<Record<string, string>> = {
  earningsdate: 'read as a date, with the sentence that says whether it is next or last (calendar.ts)',
  exdivdate: 'read as a date, next or last by the calendar (calendar.ts)',
  sma50: 'the app works out its own averages, showing the working',
  sma200: 'the app works out its own averages, showing the working',
  rsi: 'the app works out its own RSI, showing the working',
  priceTargetChange: 'arithmetic on the day’s price; the target itself is kept',
  lastSplitType: 'follows from the split ratio',
  wacc: 'rests on an assumed market return, not on the company’s figures',
  lynchFairValue: 'paid tier only', lynchUpside: 'paid tier only',
  grahamNumber: 'paid tier only', grahamUpside: 'paid tier only',
};

/** Every figure taken, by its field path. */
export const STATISTICS_FIELDS: readonly Pick<Field, 'id' | 'path' | 'name'>[] = FIELDS;

/** What the report calls each statistic. */
export const STATISTICS_NAMES: Readonly<Record<string, string>> = Object.fromEntries(FIELDS.map((x) => [x.path, x.name]));

/** More unreadable values than this means the page has changed: none of it is used (§10.1). */
const MAX_UNREADABLE = 5;
/** It follows the statement pages: paced like them. */
const PACE_MS = 1000;

/**
 * The site's currency codes as the app's. 'GBX' is pence — said explicitly,
 * and the only minor unit taken; any other code the app does not know
 * (South African cents, Israeli agorot) leaves its figures as gaps.
 */
export function appCurrency(code: string): Currency | null {
  if (code === 'GBX') return 'GBp';
  return isCurrency(code) && code !== 'GBp' ? code : null;
}

/** The page's price expressed in `target`: as quoted, or pence as pounds. No exchange rate is ever applied. */
function priceIn(target: Currency, price: number, quoted: Currency): number | null {
  if (target === quoted) return price;
  if (quoted === 'GBp' && target === 'GBP') return price / 100;
  return null;
}

const SCALE: Readonly<Record<string, number>> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

const missing = (t: string | null | undefined) => t == null || /^(n\/a|-|)$/.test(t.trim());

/** '216,402,153,472' · '-6.424%' · '10.36B' → the number and the scale it was written in; throws when unrecognised. */
function written(text: string, unit: Unit): { readonly n: number; readonly scale: number } {
  const t = text.trim();
  const m = /^([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(%|[KMBT])?$/.exec(t);
  const suffix = m?.[2];
  const ok = m && (suffix === '%') === (unit === 'percent') && (!suffix || suffix === '%' || unit === 'amount' || unit === 'shares');
  if (!ok) throw new Error(`unrecognised value ${JSON.stringify(t)}`);
  const scale = suffix && suffix !== '%' ? SCALE[suffix]! : 1;
  return { n: Number(m[1]!.replace(/,/g, '')) * scale, scale };
}

/**
 * One figure → its number, date or text; null for 'n/a' or withheld; throws
 * when unrecognised. A number is written twice — rounded in the table, in full
 * on hover — and the two must agree: a decimal comma would make '26,093%'
 * look like a valid twenty-six thousand, but never agree with '26,09%'.
 */
function read(field: Field, item: { value: string | null; hover: string | null }): number | string | null {
  if (field.unit === 'date' || field.unit === 'text') {
    if (missing(item.value)) return null;
    return field.unit === 'date' ? monthDayYear(item.value!.trim()) : item.value!.trim();
  }
  if (missing(item.hover) && missing(item.value)) return null;
  if (missing(item.hover) || missing(item.value)) throw new Error(`shown as ${JSON.stringify(item.value)}, in full ${JSON.stringify(item.hover)}`);
  const full = written(item.hover!, field.unit);
  const shown = written(item.value!, field.unit);
  // The table rounds to two decimals of the scale it writes in ('216.40B', '3.39', '6.13%').
  if (Math.abs(full.n - shown.n) > 0.006 * shown.scale && Math.abs(full.n - shown.n) > 0.005 * Math.abs(full.n)) {
    throw new Error(`shown as ${item.value}, in full ${item.hover}`);
  }
  return full.n;
}

/** A plain number from the page by id ('5,724,167,530', '6.13%'), or null — for the confirmations. */
function figure(page: StatisticsPage, id: string): number | null {
  const m = /^([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)%?$/.exec(page.items.get(id)?.hover?.trim() ?? '');
  return m ? Number(m[1]!.replace(/,/g, '')) : null;
}

type Confirmed = { readonly currency: Currency } | { readonly why: string };

/** Each of the page's currencies, confirmed or with the reason it could not be. */
function confirmCurrencies(page: StatisticsPage, quoted: Currency): Record<In, Confirmed> {
  const close = (a: number, b: number, tolerance: number) => Math.abs(a / b - 1) <= tolerance;
  const known = (name: In): Currency | { why: string } => {
    const code = page.currencies[name];
    return appCurrency(code) ?? { why: `stockanalysis states them in ${code}, which the app does not know` };
  };

  const main = ((): Confirmed => {
    const c = known('main');
    if (typeof c === 'object') return c;
    const currency = c;
    const cap = figure(page, 'marketcap');
    const shares = figure(page, 'sharesout');
    const price = priceIn(currency, page.price, quoted);
    if (cap === null || !shares) return { why: 'the market value or share count needed to check them is missing' };
    if (price === null) return { why: `the price is in ${page.currencies.price} and they in ${page.currencies.main}, so they cannot be checked` };
    return close(cap / shares, price, 0.02) ? { currency }
      : { why: `market value ÷ shares (${(cap / shares).toFixed(4)}) is not the price (${price}) in ${currency}` };
  })();

  const target = ((): Confirmed => {
    const t = figure(page, 'priceTarget');
    const stated = figure(page, 'priceTargetChange');
    if (t === null || stated === null) return { why: 'the stated distance from the price needed to check it is missing' };
    return Math.abs(t / page.price - 1 - stated / 100) <= 0.01 ? { currency: quoted }
      : { why: `${t} is not ${stated}% from the price of ${page.price} ${page.currencies.price}` };
  })();

  const dividend = ((): Confirmed => {
    const c = known('dividend');
    if (typeof c === 'object') return c;
    const dps = figure(page, 'dps');
    const yieldPct = figure(page, 'dividendYield');
    const price = priceIn(c, page.price, quoted);
    if (dps === null || !yieldPct) return { why: 'the dividend yield needed to check it is missing' };
    if (price === null) return { why: `the price is in ${page.currencies.price} and dividends in ${page.currencies.dividend}, so it cannot be checked` };
    return close(dps / price, yieldPct / 100, 0.05) ? { currency: c }
      : { why: `${dps} ÷ the price (${price} ${c}) is not the stated yield of ${yieldPct}%` };
  })();

  return { main, price: target, dividend };
}

/**
 * `symbol` as the site writes it ('lon/SHEL'); `listingCurrency` as the app
 * holds it ('GBp'), already confirmed against Trading 212 when opened.
 */
export async function keyStatistics(symbol: string, listingCurrency: string, deps: FiguresDeps): Promise<FiguresOutcome> {
  const pause = deps.pause ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  await pause(PACE_MS);
  const uid = siteUid(symbol);
  const out = await fetchSource(statistics, symbol, deps);
  if (out.kind === 'unavailable' && out.response?.status === 404) {
    return { kind: 'not-covered', reason: `stockanalysis has no statistics page for ${symbol}` };
  }
  if (out.kind !== 'ok') {
    return { kind: out.kind, reason: `stockanalysis statistics: ${out.kind === 'unavailable' ? out.reason : `${out.failure.check}: ${out.failure.observed}`}` };
  }
  const page = out.value;
  // Never a figure from a different company or listing than the one asked for (§7.2).
  if (page.uid !== uid) return { kind: 'suspect', reason: `asked stockanalysis for ${uid}, got ${page.uid}` };
  const quoted = appCurrency(page.currencies.price);
  if (quoted !== listingCurrency) {
    return { kind: 'suspect', reason: `stockanalysis prices ${uid} in ${page.currencies.price}; the listing is in ${listingCurrency}` };
  }

  const confirmed = confirmCurrencies(page, quoted);
  const asOf = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);
  const facts: Fact[] = [];
  const gaps: Gap[] = [];
  const unreadable: string[] = [];
  for (const field of FIELDS) {
    const item = page.items.get(field.id);
    if (!item) { gaps.push({ fieldPath: field.path, reason: `stockanalysis's page has no "${field.id}"` }); continue; }
    let value: number | string | null;
    try { value = read(field, item); } catch {
      unreadable.push(`${item.title}: ${JSON.stringify(item.hover)}`);
      gaps.push({ fieldPath: field.path, reason: `stockanalysis's "${item.title}" was not in the expected form` });
      continue;
    }
    if (value === null) { gaps.push({ fieldPath: field.path, reason: `stockanalysis shows no ${field.name.toLowerCase()} for ${uid}` }); continue; }

    let currency: Currency | null = null;
    let unit: string = field.unit;
    if (field.unit === 'amount' || field.unit === 'per-share') {
      const c = confirmed[field.in!];
      if ('why' in c) {
        gaps.push({ fieldPath: field.path, reason: `stockanalysis's "${item.title}" not taken — its currency is not certain: ${c.why}` });
        continue;
      }
      currency = c.currency;
      unit = field.unit === 'amount' ? currency : `${currency}/share`;
    }
    const converted = field.in === 'main' && page.currencies.main !== page.currencies.financial
      ? `, converted by stockanalysis from ${page.currencies.financial}` : '';
    facts.push({
      fieldPath: field.path, period: null, periodEnd: null, value, unit, currency,
      kind: field.kind ?? 'actual', source: 'stockanalysis', tier: 2, asOf,
      detail: `stockanalysis statistics "${item.title}"${converted}`,
    });
  }
  const dates = statisticsDates(page, asOf, true);
  facts.push(...dates.facts);
  gaps.push(...dates.gaps);
  if (unreadable.length > MAX_UNREADABLE) {
    return { kind: 'suspect', reason: `stockanalysis statistics: ${unreadable.length} values not in the expected form, e.g. ${unreadable.slice(0, 3).join('; ')}` };
  }
  return { kind: 'ok', figures: { source: 'stockanalysis', facts, gaps } };
}
