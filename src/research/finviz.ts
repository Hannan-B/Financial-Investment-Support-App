/**
 * Finviz's snapshot for a US listing.  PROJECT-PLAN.md §3, §7.1, §10.3②
 *
 * The whole snapshot is kept as facts, named after the concept and grouped
 * the way the report shows them. Two kinds, kept apart:
 *   · ANALYST PREDICTIONS (`analyst.`) — target price, rating, earnings
 *     estimates, forward P/E, PEG. Other people's forecasts, stored as
 *     estimates so they can be scored against what happened, and shown in
 *     their own panel (decided 2026-10-05).
 *   · Everything else — valuation, profitability, health, ownership, … — as facts.
 *
 * Not taken: price, change and volume (Yahoo's), and Finviz's RSI, ATR and
 * moving averages — the app works those out itself, showing the working.
 * Last-twelve-month sales and income are kept under `ttm.`, never beside the
 * fiscal years in the figures table (§3, the TTM seam).
 *
 * Optional throughout: the report works fully without Finviz (§3).
 */
import { fetchSource } from '../fetch/record.ts';
import { finviz } from '../sources/finviz.ts';
import { monthDayYear } from '../lib/dates.ts';
import type { Fact, Gap, FiguresOutcome } from './figures.ts';
import type { FiguresDeps } from './edgar.ts';
import { exDividendFact } from './calendar.ts';

/** How a value is written: '335.75' · '0.12%' · '4870.00B' · 'Aug 10, 2026' · text. */
type Parse = 'number' | 'percent' | 'scaled' | 'date' | 'text';
type Unit = 'USD' | 'USD/share' | 'ratio' | 'percent' | 'days' | 'date' | 'rating' | 'count' | 'shares' | 'text';

interface Part {
  readonly path: string;
  /** What the report calls it. */
  readonly name: string;
  readonly parse: Parse;
  readonly unit: Unit;
  readonly kind?: 'estimate';
}

interface Field {
  readonly label: string;
  /** Which appearance of the label: 'EPS next Y' is first an amount, then a growth rate. */
  readonly nth?: number;
  /** One value, or several written together: '1.10 (0.33%)', '6.89% 17.91%'. */
  readonly parts: readonly Part[];
}

const one = (label: string, path: string, name: string, parse: Parse, unit: Unit, kind?: 'estimate', nth?: number): Field =>
  ({ label, ...(nth === undefined ? {} : { nth }), parts: [{ path, name, parse, unit, ...(kind ? { kind } : {}) }] });

/** Everything under `analyst.` is shown in the "Analyst predictions" panel. */
export const ANALYST_PREFIX = 'analyst.';

const FIELDS: readonly Field[] = [
  // ── analyst predictions ──
  one('Target Price', 'analyst.target_price', 'Target price', 'number', 'USD/share', 'estimate'),
  one('Recom', 'analyst.rating', 'Consensus rating', 'number', 'rating', 'estimate'),
  one('EPS next Q', 'analyst.eps_next_quarter', 'Earnings per share, next quarter', 'number', 'USD/share', 'estimate'),
  one('EPS next Y', 'analyst.eps_next_year', 'Earnings per share, next year', 'number', 'USD/share', 'estimate', 0),
  one('EPS next Y', 'analyst.eps_growth_next_year', 'Earnings growth, next year', 'percent', 'percent', 'estimate', 1),
  one('EPS this Y', 'analyst.eps_growth_this_year', 'Earnings growth, this year', 'percent', 'percent', 'estimate'),
  one('EPS next 5Y', 'analyst.eps_growth_next_5y', 'Earnings growth a year, next 5 years', 'percent', 'percent', 'estimate'),
  one('Forward P/E', 'analyst.forward_pe', 'Forward P/E', 'number', 'ratio', 'estimate'),
  one('PEG', 'analyst.peg', 'PEG (P/E ÷ expected growth)', 'number', 'ratio', 'estimate'),
  { label: 'Dividend Est.', parts: [
    { path: 'analyst.dividend_next_year', name: 'Dividend, next year', parse: 'number', unit: 'USD/share', kind: 'estimate' },
    { path: 'analyst.dividend_yield_next_year', name: 'Dividend yield, next year', parse: 'percent', unit: 'percent', kind: 'estimate' },
  ] },

  // ── valuation ──
  one('Market Cap', 'valuation.market_cap', 'Market value', 'scaled', 'USD'),
  one('Enterprise Value', 'valuation.enterprise_value', 'Enterprise value', 'scaled', 'USD'),
  one('P/E', 'valuation.pe_ttm', 'P/E, last 12 months', 'number', 'ratio'),
  one('P/S', 'valuation.ps', 'Price ÷ sales', 'number', 'ratio'),
  one('P/B', 'valuation.pb', 'Price ÷ book value', 'number', 'ratio'),
  one('P/C', 'valuation.p_cash', 'Price ÷ cash', 'number', 'ratio'),
  one('P/FCF', 'valuation.p_fcf', 'Price ÷ free cash flow', 'number', 'ratio'),
  one('EV/EBITDA', 'valuation.ev_ebitda', 'EV ÷ EBITDA', 'number', 'ratio'),
  one('EV/Sales', 'valuation.ev_sales', 'EV ÷ sales', 'number', 'ratio'),
  one('Book/sh', 'valuation.book_per_share', 'Book value per share', 'number', 'USD/share'),
  one('Cash/sh', 'valuation.cash_per_share', 'Cash per share', 'number', 'USD/share'),

  // ── last twelve months ──
  one('Sales', 'ttm.revenue', 'Revenue, last 12 months', 'scaled', 'USD'),
  one('Income', 'ttm.net_income', 'Net income, last 12 months', 'scaled', 'USD'),
  one('EPS (ttm)', 'ttm.eps', 'Earnings per share, last 12 months', 'number', 'USD/share'),
  one('EPS Y/Y TTM', 'ttm.eps_growth', 'Earnings growth, year on year', 'percent', 'percent'),
  one('Sales Y/Y TTM', 'ttm.revenue_growth', 'Revenue growth, year on year', 'percent', 'percent'),
  one('EPS Q/Q', 'ttm.eps_growth_quarter', 'Earnings growth, quarter on quarter', 'percent', 'percent'),
  one('Sales Q/Q', 'ttm.revenue_growth_quarter', 'Revenue growth, quarter on quarter', 'percent', 'percent'),
  { label: 'EPS past 3/5Y', parts: [
    { path: 'ttm.eps_growth_past_3y', name: 'Earnings growth a year, past 3 years', parse: 'percent', unit: 'percent' },
    { path: 'ttm.eps_growth_past_5y', name: 'Earnings growth a year, past 5 years', parse: 'percent', unit: 'percent' },
  ] },
  { label: 'Sales past 3/5Y', parts: [
    { path: 'ttm.revenue_growth_past_3y', name: 'Revenue growth a year, past 3 years', parse: 'percent', unit: 'percent' },
    { path: 'ttm.revenue_growth_past_5y', name: 'Revenue growth a year, past 5 years', parse: 'percent', unit: 'percent' },
  ] },
  { label: 'EPS/Sales Surpr.', parts: [
    { path: 'ttm.eps_surprise', name: 'Earnings against forecast, last report', parse: 'percent', unit: 'percent' },
    { path: 'ttm.revenue_surprise', name: 'Revenue against forecast, last report', parse: 'percent', unit: 'percent' },
  ] },
  one('Earnings', 'calendar.last_results', 'Last results', 'text', 'text'),

  // ── profitability ──
  one('Gross Margin', 'profitability.gross_margin', 'Gross margin', 'percent', 'percent'),
  one('Oper. Margin', 'profitability.operating_margin', 'Operating margin', 'percent', 'percent'),
  one('Profit Margin', 'profitability.profit_margin', 'Profit margin', 'percent', 'percent'),
  one('ROA', 'profitability.roa', 'Return on assets', 'percent', 'percent'),
  one('ROE', 'profitability.roe', 'Return on equity', 'percent', 'percent'),
  one('ROIC', 'profitability.roic', 'Return on invested capital', 'percent', 'percent'),

  // ── financial health ──
  one('Debt/Eq', 'health.debt_equity', 'Debt ÷ equity', 'number', 'ratio'),
  one('LT Debt/Eq', 'health.lt_debt_equity', 'Long-term debt ÷ equity', 'number', 'ratio'),
  one('Current Ratio', 'health.current_ratio', 'Current ratio', 'number', 'ratio'),
  one('Quick Ratio', 'health.quick_ratio', 'Quick ratio', 'number', 'ratio'),

  // ── dividends ──
  { label: 'Dividend TTM', parts: [
    { path: 'dividend.last_12_months', name: 'Dividend, last 12 months', parse: 'number', unit: 'USD/share' },
    { path: 'dividend.yield', name: 'Dividend yield', parse: 'percent', unit: 'percent' },
  ] },
  one('Payout', 'dividend.payout', 'Share of earnings paid out', 'percent', 'percent'),
  { label: 'Dividend Gr. 3/5Y', parts: [
    { path: 'dividend.growth_3y', name: 'Dividend growth a year, past 3 years', parse: 'percent', unit: 'percent' },
    { path: 'dividend.growth_5y', name: 'Dividend growth a year, past 5 years', parse: 'percent', unit: 'percent' },
  ] },
  one('Dividend Ex-Date', 'calendar.last_ex_dividend', 'Last ex-dividend date', 'date', 'date'),

  // ── the company ──
  one('Employees', 'company.employees', 'Employees', 'number', 'count'),
  one('IPO', 'company.ipo_date', 'Listed since', 'date', 'date'),
  one('Index', 'company.indices', 'In the indices', 'text', 'text'),
  one('Shs Outstand', 'company.shares_outstanding', 'Shares in issue', 'scaled', 'shares'),
  one('Shs Float', 'company.shares_float', 'Shares freely traded', 'scaled', 'shares'),

  // ── ownership and short interest ──
  one('Insider Own', 'ownership.insider_pct', 'Owned by insiders', 'percent', 'percent'),
  one('Insider Trans', 'ownership.insider_change_pct', 'Insiders’ buying (+) or selling (−), 6 months', 'percent', 'percent'),
  one('Inst Own', 'ownership.institutional_pct', 'Owned by institutions', 'percent', 'percent'),
  one('Inst Trans', 'ownership.institutional_change_pct', 'Institutions’ buying (+) or selling (−), 3 months', 'percent', 'percent'),
  one('Short Float', 'short.float_pct', 'Shares sold short', 'percent', 'percent'),
  one('Short Ratio', 'short.ratio_days', 'Days to cover short sales', 'number', 'days'),
  one('Short Interest', 'short.shares', 'Shares sold short, number', 'scaled', 'shares'),

  // ── trading ──
  { label: '52W High', parts: [
    { path: 'trading.high_52w', name: '52-week high', parse: 'number', unit: 'USD/share' },
    { path: 'trading.below_high_52w', name: 'Price against 52-week high', parse: 'percent', unit: 'percent' },
  ] },
  { label: '52W Low', parts: [
    { path: 'trading.low_52w', name: '52-week low', parse: 'number', unit: 'USD/share' },
    { path: 'trading.above_low_52w', name: 'Price against 52-week low', parse: 'percent', unit: 'percent' },
  ] },
  one('Beta', 'trading.beta', 'Beta (movement against the market)', 'number', 'ratio'),
  { label: 'Volatility', parts: [
    { path: 'trading.volatility_week', name: 'Daily volatility, past week', parse: 'percent', unit: 'percent' },
    { path: 'trading.volatility_month', name: 'Daily volatility, past month', parse: 'percent', unit: 'percent' },
  ] },
  one('Avg Volume', 'trading.average_volume', 'Average daily volume', 'scaled', 'shares'),
  one('Rel Volume', 'trading.relative_volume', 'Today’s volume against average', 'number', 'ratio'),
  one('Perf Week', 'performance.week', 'Price change, week', 'percent', 'percent'),
  one('Perf Month', 'performance.month', 'Price change, month', 'percent', 'percent'),
  one('Perf Quarter', 'performance.quarter', 'Price change, quarter', 'percent', 'percent'),
  one('Perf Half Y', 'performance.half_year', 'Price change, half year', 'percent', 'percent'),
  one('Perf YTD', 'performance.year_to_date', 'Price change, year to date', 'percent', 'percent'),
  one('Perf Year', 'performance.year', 'Price change, year', 'percent', 'percent'),
  one('Perf 3Y', 'performance.three_years', 'Price change, 3 years', 'percent', 'percent'),
  one('Perf 5Y', 'performance.five_years', 'Price change, 5 years', 'percent', 'percent'),
  one('Perf 10Y', 'performance.ten_years', 'Price change, 10 years', 'percent', 'percent'),
];

/** What the report calls each Finviz figure. */
export const FINVIZ_NAMES: Readonly<Record<string, string>> =
  Object.fromEntries(FIELDS.flatMap((f) => f.parts.map((p) => [p.path, p.name])));

/** More unreadable values than this means the page has changed: none of it is used (§10.1). */
const MAX_UNREADABLE = 5;

const SCALE: Readonly<Record<string, number>> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

/** One written value → its number or text; null for Finviz's '-'; throws when unrecognised. */
function read(text: string, parse: Parse): number | string | null {
  const t = text.trim();
  if (t === '-' || t === '') return null;
  const fail = () => { throw new Error(`unrecognised ${parse} value ${JSON.stringify(text)}`); };
  switch (parse) {
    case 'number': return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : fail();
    case 'percent': { const m = /^(-?\d+(?:\.\d+)?)%$/.exec(t); return m ? Number(m[1]) : fail(); }
    case 'scaled': { const m = /^(-?\d+(?:\.\d+)?)([KMBT])?$/.exec(t); return m ? Number(m[1]) * (m[2] ? SCALE[m[2]]! : 1) : fail(); }
    case 'date': return monthDayYear(t) ?? fail();
    case 'text': return t;
  }
}

/** '1.10 (0.33%)' → ['1.10', '0.33%']; '6.89% 17.91%' → two; a lone value → itself. */
function split(text: string, count: number): string[] {
  if (count === 1) return [text];
  const pieces = text.replace(/[()]/g, ' ').trim().split(/\s+/);
  // '-' alone stands for every part missing.
  return pieces.length === 1 && pieces[0] === '-' ? new Array<string>(count).fill('-') : pieces;
}

export async function finvizFigures(ticker: string, deps: FiguresDeps): Promise<FiguresOutcome> {
  const t = ticker.toUpperCase();
  const out = await fetchSource(finviz, t, deps);
  if (out.kind === 'unavailable' && out.response?.status === 404) {
    return { kind: 'not-covered', reason: `Finviz covers US listings only; it has no page for ${t}` };
  }
  if (out.kind !== 'ok') {
    return { kind: out.kind, reason: `Finviz: ${out.kind === 'unavailable' ? out.reason : `${out.failure.check}: ${out.failure.observed}`}` };
  }
  if (out.value.ticker !== t) return { kind: 'suspect', reason: `asked Finviz for ${t}, got ${out.value.ticker}` };

  const asOf = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);
  const facts: Fact[] = [];
  const gaps: Gap[] = [];
  const unreadable: string[] = [];
  for (const f of FIELDS) {
    const text = out.value.fields.filter(([label]) => label === f.label)[f.nth ?? 0]?.[1];
    if (text === undefined) {
      for (const p of f.parts) gaps.push({ fieldPath: p.path, reason: `Finviz's page has no "${f.label}"` });
      continue;
    }
    const pieces = split(text, f.parts.length);
    if (pieces.length !== f.parts.length) {
      unreadable.push(`${f.label}: ${JSON.stringify(text)}`);
      for (const p of f.parts) gaps.push({ fieldPath: p.path, reason: `Finviz's "${f.label}" was not in the expected form` });
      continue;
    }
    f.parts.forEach((p, i) => {
      let value: number | string | null;
      try { value = read(pieces[i]!, p.parse); } catch {
        unreadable.push(`${f.label}: ${JSON.stringify(text)}`);
        gaps.push({ fieldPath: p.path, reason: `Finviz's "${f.label}" was not in the expected form` });
        return;
      }
      if (value === null) { gaps.push({ fieldPath: p.path, reason: `Finviz shows no ${p.name.toLowerCase()} for ${t}` }); return; }
      // Declared ahead, it is the next one (Walmart's 11 Dec 2026, read in October).
      if (p.path === 'calendar.last_ex_dividend') { facts.push(exDividendFact(value as string, asOf, 'finviz', `finviz "${f.label}"`)); return; }
      facts.push({
        fieldPath: p.path, period: null, periodEnd: null, value, unit: p.unit,
        currency: p.unit === 'USD' || p.unit === 'USD/share' ? 'USD' : null,
        kind: p.kind ?? 'actual', source: 'finviz', tier: 2, asOf, detail: `finviz "${f.label}"`,
      });
    });
  }
  if (unreadable.length > MAX_UNREADABLE) {
    return { kind: 'suspect', reason: `Finviz: ${unreadable.length} values not in the expected form, e.g. ${unreadable.slice(0, 3).join('; ')}` };
  }
  return { kind: 'ok', figures: { source: 'finviz', facts, gaps } };
}
