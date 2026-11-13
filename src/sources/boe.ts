/**
 * Bank of England daily spot rates against sterling.  PROJECT-PLAN.md §11.10 step 5.1
 *
 * Chosen 2026-11-13 over the ECB: rates in pounds, the currency he
 * uses, with no conversion through the euro. Seen live that day (plan
 * appendix, *Phase 5*): `Rates.asp` is allowed by robots.txt (only the
 * database download and charts are disallowed); the data may be reused under
 * the Open Government Licence. The Bank calls these "not official rates" —
 * market rates it notes each working afternoon.
 *
 * The latest page only: the Bank publishes on working days, so on a weekend
 * or bank holiday it shows the last working day's rates, and the page's own
 * date says which day that is. Every use so far needs today's rate (planning,
 * 5.5); a past day would need the page's TD/TM/TY form, which carries no
 * 52-week range to check a rate against.
 *
 * Each row: "£1 = 1.3238 US Dollar", with the year's high and low beside it.
 * A rate outside its own stated range is refused: that would be a misread.
 */
import type { Check, Source } from '../fetch/types.ts';
import { asOfWithinDays } from '../fetch/checks.ts';

export interface PerPound {
  /** ISO code: 'USD'. */
  readonly currency: string;
  /** How many of that currency £1 buys. */
  readonly perPound: number;
  readonly high: number | null;
  readonly low: number | null;
}

export interface BoeRates {
  /** The day the rates are for, as the page states it: '2026-11-12'. */
  readonly date: string;
  readonly rates: readonly PerPound[];
  /** Rows on the page not taken, each with why. */
  readonly notTaken: readonly { readonly name: string; readonly reason: string }[];
}

/** The Bank's names, exactly as the page writes them (seen 2026-11-13: 27 rows). */
export const BOE_CURRENCIES: Readonly<Record<string, string>> = {
  'Australian Dollar': 'AUD', 'Bulgarian Lev': 'BGN', 'Canadian Dollar': 'CAD', 'Chinese Yuan': 'CNY',
  'Czech Koruna': 'CZK', 'Danish Krone': 'DKK', 'Euro': 'EUR', 'Hong Kong Dollar': 'HKD',
  'Hungarian Forint': 'HUF', 'Indian Rupee': 'INR', 'Israeli Shekel': 'ILS', 'Japanese Yen': 'JPY',
  'Malaysian ringgit': 'MYR', 'New Zealand Dollar': 'NZD', 'Norwegian Krone': 'NOK', 'Polish Zloty': 'PLN',
  'Romanian Leu': 'RON', 'Saudi Riyal': 'SAR', 'Singapore Dollar': 'SGD', 'South African Rand': 'ZAR',
  'South Korean Won': 'KRW', 'Swedish Krona': 'SEK', 'Swiss Franc': 'CHF', 'Taiwan Dollar': 'TWD',
  'Thai Baht': 'THB', 'Turkish Lira': 'TRY', 'US Dollar': 'USD',
};

const MONTHS: Readonly<Record<string, string>> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

/** '12 Nov 2026' → '2026-11-12'. */
function pageDate(text: string): string {
  const m = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(text.trim());
  const month = m ? MONTHS[m[2]!] : undefined;
  if (!m || !month) throw new Error(`unrecognised date on the page: "${text.trim()}"`);
  return `${m[3]}-${month}-${m[1]!.padStart(2, '0')}`;
}

/**
 * A figure as the page writes it: digits and one decimal point. Anything else
 * — a thousands or decimal comma above all — is refused, never guessed at.
 */
function figure(cell: string, what: string): number | null {
  const s = cell.trim();
  if (s === '') return null;
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`${what}: "${s}" is not a plain number`);
  return Number(s);
}

export function parseRates(body: Uint8Array): BoeRates {
  const html = new TextDecoder().decode(body);
  if (/No data found/i.test(html)) throw new Error('the page says "No data found"');
  const head = /&pound;1<br\s*\/?>\s*([^<]+?)\s*<\/th>/.exec(html);
  if (!head) throw new Error('no date in the table heading');
  const date = pageDate(head[1]!);

  const rates: PerPound[] = [];
  const notTaken: { name: string; reason: string }[] = [];
  // Each row: the currency's link, then three cells (the first left unclosed by the page).
  const row = /<a title="XUDL\w+ - Spot exchange rate,[^"]*"[^>]*>([^<]+)<\/a><\/td>\s*<td[^>]*>([^<]*)(?:<\/td>)?\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>/g;
  for (let m = row.exec(html); m; m = row.exec(html)) {
    const name = m[1]!.trim();
    const code = BOE_CURRENCIES[name];
    if (!code) { notTaken.push({ name, reason: 'a currency name the app does not know' }); continue; }
    const perPound = figure(m[2]!, name);
    if (perPound === null) { notTaken.push({ name, reason: 'no rate given that day' }); continue; }
    rates.push({ currency: code, perPound, high: figure(m[3]!, `${name} high`), low: figure(m[4]!, `${name} low`) });
  }
  if (rates.length === 0 && notTaken.length === 0) throw new Error('no rate rows found on the page');
  return { date, rates, notTaken };
}

// ── checks ───────────────────────────────────────────────────────────────

const needed: Check<BoeRates> = {
  name: 'needed-currencies',
  run(r) {
    const missing = ['USD', 'EUR'].filter((c) => !r.rates.some((x) => x.currency === c));
    return missing.length === 0 ? null
      : { check: 'needed-currencies', expected: 'the dollar and the euro', observed: `missing ${missing.join(', ')}` };
  },
};

/** The page states each currency's 52-week high and low: the day's rate must lie between them. */
const withinRange: Check<BoeRates> = {
  name: 'within-52-week-range',
  run(r) {
    const bad = r.rates.find((x) => x.high !== null && x.low !== null && (x.perPound > x.high || x.perPound < x.low));
    return bad ? {
      check: 'within-52-week-range',
      expected: 'each rate between the 52-week low and high the page states beside it',
      observed: `${bad.currency} ${bad.perPound} outside ${bad.low}–${bad.high}`,
    } : null;
  },
};

export function makeBoeRates(now?: () => Date): Source<BoeRates> {
  return {
    id: 'boe-rates',
    core: false,
    request: () => ({ url: 'https://www.bankofengland.co.uk/boeapps/database/Rates.asp?into=GBP' }),
    parse: (res) => parseRates(res.body),
    checks: [
      needed,
      withinRange,
      // Six days covers Easter (Thursday to Tuesday); older means the page has stopped moving.
      asOfWithinDays((r) => new Date(`${r.date}T16:00:00Z`), 6, now),
    ],
  };
}
