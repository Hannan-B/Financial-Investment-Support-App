/**
 * Insider dealings: what a company's directors and officers bought and sold.
 * PROJECT-PLAN.md §11.7 step 2.8 (decided 2026-11-02)
 *
 * US listings: Finviz's insider table, on the page already read for the key
 * statistics — no extra request. London: the Director/PDMR notices found in
 * the announcements list, each read once. Nowhere else yet: another country
 * is explored when a company there is researched.
 *
 * Facts only, each in the source's own words, labelled one of four ways:
 *   bought · sold — in the market: the wording says purchase or acquisition,
 *                   sale or disposal, and nothing in it points to a plan,
 *                   award, dividend or option (decided 2026-11-02: Shell
 *                   writes its directors' sales as "Disposal of ordinary
 *                   shares", Lloyds a director's purchase as "Acquisition")
 *   intends to sell — a US advance notice (Form 144): not a dealing, can change
 *   other — pay and share plans, dividend shares, options, gifts, anything else
 *
 * Checks, each leaving the line out with its reason (kept and shown, §10.1):
 *   · a market dealing's price must be within a quarter of that day's close —
 *     catches Finviz's Apple line at $15.27 (Apple ~$333) and pence written
 *     as pounds
 *   · Finviz: value = price × shares
 *   · London: the ISIN on the form must be this share's (Shell's New York
 *     shares are a different security); the currency must be stated and
 *     agree with the price's own symbol; the date must fall in the month
 *     before the notice
 * Amounts stay in the currency the source states; nothing is converted.
 */
import type { Db, Statement } from '../db/types.ts';
import { fetchSource } from '../fetch/record.ts';
import { investegateNotice, type PdmrDealing } from '../sources/investegate.ts';
import type { FinvizPage } from '../sources/finviz.ts';
import { secExchange, type FiguresDeps } from './edgar.ts';
import type { FiguresOutcome } from './figures.ts';
import type { SourceOutcome } from './snapshot.ts';

export type DealingKind = 'bought' | 'sold' | 'intends-to-sell' | 'other';

export interface Dealing {
  readonly source: 'finviz' | 'investegate';
  readonly key: string;
  /** The SEC filing or the London notice. */
  readonly url: string;
  readonly filedOn: string | null;
  readonly tradedOn: string | null;
  readonly person: string | null;
  readonly role: string | null;
  readonly kind: DealingKind;
  /** The source's own words for it. */
  readonly wording: string;
  readonly shares: number | null;
  readonly price: number | null;
  readonly value: number | null;
  readonly currency: string | null;
  /** True when the value is price × shares, worked out by the app. */
  readonly valueWorkedOut: boolean;
  readonly sharesAfter: number | null;
  readonly place: string | null;
  /** Why the line is not shown as a dealing; null when it is. */
  readonly leftOut: string | null;
}

const DAY = 86_400_000;
const PACE_MS = 1000;
/** London notices read per refresh; the rest wait for the next. */
const MAX_NOTICES = 40;
/** A market dealing's price may differ this much from the day's close before it is doubted. */
const PRICE_BAND = 0.25;
export const WINDOW_DAYS = 365;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// ── what a dealing is ────────────────────────────────────────────────────

/** Anything to do with pay, plans, dividends or options is not a market dealing, whatever its verb. */
const NOT_MARKET = /\b(plans?|schemes?|sip|ltip|psp|drip|dividends?|reinvest\w*|awards?|awarded|grants?|granted|vest\w*|exercis\w*|options?|transfer\w*|gifts?|bonus|matching|partnership|sharesave|saye|deferred|restricted|nil[- ]cost|tax|withh\w*|trustees?)\b/i;
const BUY = /\b(purchases?|purchased|bought|buy|buying|acquisitions?|acquired?)\b/i;
const SELL = /\b(sales?|sold|sell|selling|disposals?|disposed?)\b/i;

/** A London notice's "nature of the transaction" → a label. Bought or sold only in the market, never a plan's. */
export function londonKind(nature: string): DealingKind {
  if (NOT_MARKET.test(nature)) return 'other';
  const buy = BUY.test(nature);
  const sell = SELL.test(nature);
  return buy && !sell ? 'bought' : sell && !buy ? 'sold' : 'other';
}

const FINVIZ_KINDS: Readonly<Record<string, DealingKind>> = { Buy: 'bought', Sale: 'sold', 'Proposed Sale': 'intends-to-sell' };

// ── reading numbers, money and dates ─────────────────────────────────────

/** '31,786' · '2,211.85048' · '00.95744' → a number; anything else null. */
export function amount(text: string): number | null {
  const t = text.replace(/\s/g, '');
  return /^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(t) ? Number(t.replace(/,/g, '')) : null;
}

const CODES: Readonly<Record<string, string>> = { GBP: 'GBP', GBX: 'GBp', GBp: 'GBp', EUR: 'EUR', USD: 'USD', CHF: 'CHF' };

/** The form's currency field → a currency; 'pence' and GBX are pence. Unknown → null, never a guess. */
function currencyField(text: string | null): string | null | undefined {
  if (!text) return null;
  const t = text.trim();
  if (/^(pence|penny|gbx)$/i.test(t)) return 'GBp';
  return CODES[t] ?? CODES[t.toUpperCase()] ?? undefined;
}

/** '£33.41' · '€39.115' · 'GBP00.95744' · '£ 1.26725' · '125.5p' · '5.86' → value and the currency it writes, if any. */
export function writtenPrice(text: string): { value: number; currency: string | null } | null {
  const t = text.trim();
  const patterns: [RegExp, string | null][] = [
    [/^£\s*(.+)$/, 'GBP'], [/^€\s*(.+)$/, 'EUR'], [/^(?:US)?\$\s*(.+)$/, 'USD'],
    [/^(GBP|GBX|EUR|USD|CHF)\s*(.+)$/i, ''], [/^(.+?)\s*(p|pence)$/i, 'GBp'], [/^(.+?)\s+(GBP|EUR|USD)$/i, ''],
    [/^(.+)$/, null],
  ];
  for (const [re, cur] of patterns) {
    const m = re.exec(t);
    if (!m) continue;
    if (cur === '') {
      const code = /^[A-Z]{3}$/i.test(m[1]!) ? m[1]! : m[2]!;
      const number = code === m[1] ? m[2]! : m[1]!;
      const value = amount(number);
      return value === null ? null : { value, currency: CODES[code.toUpperCase()] ?? null };
    }
    const value = amount(m[1]!);
    return value === null ? null : { value, currency: cur };
  }
  return null;
}

/**
 * '2026-10-15' · 'July 31, 2026' · '28 August 2026' · '24/09/2026' → ISO date.
 * The slashed form is a UK regulatory form, so day first; the check against
 * the notice's own date catches a form written month first.
 */
export function writtenDate(text: string): string | null {
  const t = text.trim().replace(/(\d)(st|nd|rd|th)\b/, '$1');
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return +m[2]! >= 1 && +m[2]! <= 12 && +m[1]! <= 31 ? iso(+m[3]!, +m[2]!, +m[1]!) : null;
  m = /^([A-Za-z]+) (\d{1,2}),? (\d{4})$/.exec(t);
  if (m && MONTHS.indexOf(m[1]!.toLowerCase()) >= 0) return iso(+m[3]!, MONTHS.indexOf(m[1]!.toLowerCase()) + 1, +m[2]!);
  m = /^(\d{1,2}) ([A-Za-z]+),? (\d{4})$/.exec(t);
  if (m && MONTHS.indexOf(m[2]!.toLowerCase()) >= 0) return iso(+m[3]!, MONTHS.indexOf(m[2]!.toLowerCase()) + 1, +m[1]!);
  return null;
}

/** Finviz's "Oct 02 '26" → '2026-10-02'. */
function finvizDate(text: string): string | null {
  const m = /^([A-Z][a-z]{2}) (\d{2}) '(\d{2})$/.exec(text.trim());
  const month = m ? MONTHS.findIndex((x) => x.startsWith(m[1]!.toLowerCase())) : -1;
  return m && month >= 0 ? iso(2000 + +m[3]!, month + 1, +m[2]!) : null;
}

/** Finviz's filing time "Oct 02 05:17 PM" has no year: the first such date on or after the dealing. */
function finvizFiled(text: string, traded: string): string | null {
  const m = /^([A-Z][a-z]{2}) (\d{2}) /.exec(text.trim());
  const month = m ? MONTHS.findIndex((x) => x.startsWith(m[1]!.toLowerCase())) : -1;
  if (!m || month < 0) return null;
  const year = +traded.slice(0, 4);
  const same = iso(year, month + 1, +m[2]!);
  return same >= traded ? same : iso(year + 1, month + 1, +m[2]!);
}

// ── checks ───────────────────────────────────────────────────────────────

type Close = (date: string) => Promise<{ close: number; currency: string; date: string } | null>;

/** The close on the day, or the trading day before it (a week at most). */
function closes(db: Db, listingId: number): Close {
  return async (date) => {
    const from = new Date(Date.parse(date) - 7 * DAY).toISOString().slice(0, 10);
    const [row] = await db.query(
      'SELECT date, close, currency FROM price WHERE listing_id = ? AND date <= ? AND date >= ? AND close IS NOT NULL ORDER BY date DESC LIMIT 1',
      [listingId, date, from],
    );
    return row ? { close: Number(row['close']), currency: String(row['currency']), date: String(row['date']) } : null;
  };
}

/** '2025-10-16' → '16 October 2025', for a line the report shows as written. */
const written = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** A price for a reason line, to four places at most: $333.69, not Yahoo's stored $333.69000244140625. */
const show = (value: number, currency: string) => {
  const v = Math.round(value * 1e4) / 1e4;
  return currency === 'GBp' ? `${v}p` : `${({ GBP: '£', USD: '$', EUR: '€' } as Record<string, string>)[currency] ?? `${currency} `}${v}`;
};

/**
 * A market dealing's price against that day's close, in the listing's own
 * currency. Pounds against a pence listing are multiplied by 100 — that is
 * the trap this catches. Another currency (Shell's euros in Amsterdam)
 * cannot be compared until exchange rates arrive (Phase 5), so it is not.
 */
async function priceCheck(close: Close, d: Dealing): Promise<string | null> {
  if (d.kind === 'other' || d.price === null || d.currency === null || d.tradedOn === null) return null;
  const day = await close(d.tradedOn);
  if (!day) return null;
  const inListing = d.currency === day.currency ? d.price
    : d.currency === 'GBP' && day.currency === 'GBp' ? d.price * 100
    : d.currency === 'GBp' && day.currency === 'GBP' ? d.price / 100 : null;
  if (inListing === null) return null;
  if (Math.abs(inListing - day.close) <= PRICE_BAND * day.close) return null;
  return `the price, ${show(d.price, d.currency)}, is far from the close of ${show(day.close, day.currency)} on ${written(day.date)}`;
}

// ── Finviz (US) ──────────────────────────────────────────────────────────

/** Seen live 2026-11-02 on Apple's and Walmart's pages. Anything else means the table has changed. */
const FINVIZ_HEADINGS = ['Insider Trading', 'Relationship', 'Date', 'Transaction', 'Cost', '#Shares', 'Value ($)', '#Shares Total', 'SEC Form 4'];

export async function finvizDealings(insiders: NonNullable<FinvizPage['insiders']>, close: Close): Promise<Dealing[] | { suspect: string }> {
  if (insiders.headings.join('|') !== FINVIZ_HEADINGS.join('|')) {
    return { suspect: `Finviz's insider table has changed: columns ${JSON.stringify(insiders.headings)}` };
  }
  const out: Dealing[] = [];
  for (const row of insiders.rows) {
    const [person, role, date, wording, cost, shares, value, after, filed] = row.cells;
    if (row.cells.length !== FINVIZ_HEADINGS.length) return { suspect: `Finviz's insider row has ${row.cells.length} cells: ${row.cells.join(' | ')}` };
    const tradedOn = finvizDate(date!);
    if (!tradedOn) return { suspect: `Finviz's insider date ${JSON.stringify(date)} is not in the expected form` };
    const d: Dealing = {
      // Finviz links to the SEC over http; the SEC serves the same address over https.
      source: 'finviz', url: row.filing?.replace(/^http:\/\//, 'https://') ?? 'https://finviz.com/', key: '',
      filedOn: finvizFiled(filed!, tradedOn), tradedOn, person: person || null, role: role || null,
      kind: FINVIZ_KINDS[wording!] ?? 'other', wording: wording!,
      shares: amount(shares!), price: amount(cost!), value: amount(value!), currency: 'USD', valueWorkedOut: false,
      sharesAfter: after ? amount(after) : null, place: null, leftOut: null,
    };
    let leftOut: string | null = null;
    if (!row.filing) leftOut = 'Finviz gives no link to the filing';
    else if (d.shares === null || d.price === null || d.value === null) leftOut = `Finviz's figures are not in the expected form: ${cost} × ${shares} = ${value}`;
    else if (Math.abs(d.price * d.shares - d.value) > Math.max(2, 0.01 * d.value)) {
      leftOut = `the value, $${value}, is not the price × shares (${cost} × ${shares})`;
    } else leftOut = await priceCheck(close, d);
    out.push({ ...d, leftOut, key: ['finviz', d.url, d.person, d.tradedOn, d.wording, shares, cost].join('|') });
  }
  return out;
}

// ── London notices ───────────────────────────────────────────────────────

/** What makes a headline a Director/PDMR notice — RNS's own category title. */
export const PDMR_TITLE = /^Director\/PDMR Shareholding\b/i;

export async function noticeDealings(
  people: readonly { name: string | null; position: string | null; dealings: readonly PdmrDealing[] }[],
  notice: { url: string; published: string; isin: string }, close: Close,
): Promise<Dealing[]> {
  const out: Dealing[] = [];
  const filedOn = notice.published.slice(0, 10);
  const earliest = new Date(Date.parse(filedOn) - 31 * DAY).toISOString().slice(0, 10);
  let n = 0;
  const add = (d: Omit<Dealing, 'key' | 'source' | 'url' | 'filedOn'>) =>
    out.push({ ...d, source: 'investegate', url: notice.url, filedOn, key: `${notice.url}#${n++}` });

  for (const p of people) {
    const base = { person: p.name, role: p.position, sharesAfter: null };
    if (p.dealings.length === 0) {
      add({ ...base, tradedOn: null, kind: 'other', wording: '', shares: null, price: null, value: null, currency: null,
        valueWorkedOut: false, place: null, leftOut: 'the notice lists no dealing that could be read for this person' });
      continue;
    }
    for (const t of p.dealings) {
      const nature = t.nature ?? '';
      const kind = londonKind(nature);
      const tradedOn = t.date ? writtenDate(t.date) : null;
      const stated = currencyField(t.currency);
      const general = (() => {
        if (!p.name) return 'the notice does not name the person';
        if (!t.nature) return 'the notice does not say what kind of dealing it was';
        if (!t.isin) return `the notice gives no ISIN for the shares (${t.instrument ?? 'not described'})`;
        if (t.isin !== notice.isin) return `a different security, ${t.isin}: ${t.instrument ?? ''}`.trim();
        if (!tradedOn) return `the date ${JSON.stringify(t.date)} could not be read`;
        if (tradedOn > filedOn || tradedOn < earliest) return `the date, ${tradedOn}, is not in the month before the notice (${filedOn})`;
        if (stated === undefined) return `the currency ${JSON.stringify(t.currency)} is not one the app knows`;
        if (t.problem) return `the prices could not be read: ${t.problem}`;
        if (t.lines.length === 0) return 'the notice gives no price and volume';
        return null;
      })();
      // One line for each price and volume the form gives (Lloyds: partnership and matching shares).
      for (const line of t.lines.length ? t.lines : [null]) {
        const written = line ? writtenPrice(line.price) : null;
        const shares = line ? amount(line.volume) : null;
        const currency = written?.currency ?? stated ?? null;
        let leftOut = general;
        if (!leftOut && line) {
          if (!written || shares === null) leftOut = `the price or volume could not be read: ${line.price} × ${line.volume}`;
          else if (!currency) leftOut = 'the notice states no currency for the price';
          else if (stated && written.currency && stated !== written.currency) {
            leftOut = `the price is written in ${written.currency} but the notice says ${t.currency}`;
          }
        }
        const price = written?.value ?? null;
        const d: Omit<Dealing, 'key' | 'source' | 'url' | 'filedOn'> = {
          ...base, tradedOn, kind, wording: line?.label ? `${nature} — ${line.label}` : nature,
          shares, price, value: price !== null && shares !== null ? Math.round(price * shares * 100) / 100 : null,
          currency, valueWorkedOut: true, place: t.place, leftOut,
        };
        add({ ...d, leftOut: leftOut ?? await priceCheck(close, { ...d, key: '', source: 'investegate', url: notice.url, filedOn }) });
      }
    }
  }
  return out;
}

// ── who they are ─────────────────────────────────────────────────────────

/**
 * How senior a person is, worked out from the title as filed by fixed rules
 * (added 2026-11-02). A tag beside the title, never a ranking:
 * the list stays in date order and nothing is hidden. Titles are free text
 * and differ by company, so the rules are deliberately plain:
 *   executive   — a chief officer, a CEO (a division's too: "UK CEO"), a
 *                 president who is not a vice-president, an executive chair
 *   board       — a director (Finviz's "Director" is a board member), a
 *                 non-executive or independent director, a chair
 *   shareholder — a 10% owner or other shareholder who files: Walmart's
 *                 Walton family, not employees
 *   other       — any other title: senior and executive vice-presidents,
 *                 general counsel, accounting officers, anyone "former",
 *                 a person closely associated (a relative)
 *   not-stated  — no title, or only "Officer": US advance notices of a
 *                 planned sale (Form 144) record none
 */
export type RoleLevel = 'executive' | 'board' | 'shareholder' | 'other' | 'not-stated';

export function roleLevel(role: string | null): RoleLevel {
  const r = (role ?? '').trim();
  if (r === '' || /^officer$/i.test(r)) return 'not-stated';
  if (/\bformer\b|closely associated|\bpca\b/i.test(r)) return 'other';
  if (/\b10% owner\b|\b(share|stock)holder\b/i.test(r)) return 'shareholder';
  // Before the executive rule: "Non-Executive Director" contains "Executive Director".
  if (/\bnon[- ]executive\b|\bindependent\b[^,]*\bdirector\b/i.test(r)) return 'board';
  if (/\bchief\b[^,/]*\bofficer\b|\bchief executive\b|\b(ceo|cfo|coo|cto|cio)\b|\bexecutive (chair|chairman|chairwoman|director)\b|\bmanaging director\b/i.test(r)) return 'executive';
  if (/\bpresident\b/i.test(r) && !/\bvice[- ]president\b/i.test(r)) return 'executive';
  if (/^director$|\bchair(man|woman|person)?\b|\bboard\b/i.test(r)) return 'board';
  return 'other';
}

// ── fetching ─────────────────────────────────────────────────────────────

const OUTCOME = 'insider-dealings';

function save(isin: string, dealings: readonly Dealing[], at: string): Statement[] {
  return dealings.map((d) => ({
    sql: `INSERT INTO insider_dealing (isin, source, key, url, filed_on, traded_on, person, role, kind, wording, shares, price, value,
            currency, value_worked_out, shares_after, place, left_out, first_seen)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (isin, key) DO NOTHING`,
    params: [isin, d.source, d.key, d.url, d.filedOn, d.tradedOn, d.person, d.role, d.kind, d.wording, d.shares, d.price, d.value,
      d.currency, d.valueWorkedOut ? 1 : 0, d.sharesAfter, d.place, d.leftOut, at],
  }));
}

/**
 * Reads what is new and keeps it. Runs after the key statistics (US: Finviz's
 * page, passed in) and the news (London: the announcements list).
 */
export async function fetchInsiders(
  listingId: number, deps: FiguresDeps,
  us: { readonly outcome: FiguresOutcome; readonly page: FinvizPage | null } | null,
  londonList: SourceOutcome | null,
): Promise<SourceOutcome> {
  const db = deps.db;
  const now = (deps.now ?? (() => new Date()))();
  const pause = deps.pause ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const [l] = await db.query('SELECT isin, ticker, exchange FROM listing WHERE id = ?', [listingId]);
  if (!l) throw new Error(`no listing ${listingId}`);
  const isin = String(l['isin']);
  const close = closes(db, listingId);
  const at = now.toISOString();

  if (secExchange(String(l['exchange']))) {
    if (!us || us.outcome.kind !== 'ok' || !us.page) {
      const o = us?.outcome;
      return o && o.kind !== 'ok' ? { source: OUTCOME, outcome: o.kind, detail: o.reason }
        : { source: OUTCOME, outcome: 'unavailable', detail: 'Finviz was not read' };
    }
    if (!us.page.insiders) return { source: OUTCOME, outcome: 'ok', detail: `Finviz lists no insider dealings for ${String(l['ticker'])}` };
    const read = await finvizDealings(us.page.insiders, close);
    if ('suspect' in read) return { source: OUTCOME, outcome: 'suspect', detail: read.suspect };
    await db.batch(save(isin, read, at));
    const oldest = read.map((d) => d.tradedOn!).sort()[0]!;
    // Finviz shows its latest 100 (Walmart's reached back only to January): say how far this one went.
    return { source: OUTCOME, outcome: 'ok',
      detail: read.length ? `Finviz listed ${read.length} dealings, back to ${written(oldest)}${read.length >= 100 ? ' — the most it shows' : ''}` : null };
  }

  if (String(l['exchange']) !== 'LSE') {
    return { source: OUTCOME, outcome: 'not-covered', detail: 'Insider dealings are read for US and London shares only so far' };
  }

  const from = new Date(now.getTime() - WINDOW_DAYS * DAY).toISOString().slice(0, 10);
  const unread = (await db.query(
    `SELECT url, title, published_at FROM news_item
     WHERE isin = ? AND source = 'investegate' AND published_at >= ?
       AND url NOT IN (SELECT url FROM insider_dealing WHERE isin = ?)
     ORDER BY published_at DESC`, [isin, from, isin],
  )).filter((r) => PDMR_TITLE.test(String(r['title'])));
  let read = 0;
  let unanswered: string | null = null;
  for (const r of unread.slice(0, MAX_NOTICES)) {
    if (read > 0) await pause(PACE_MS);
    const url = String(r['url']);
    const notice = { url, published: String(r['published_at']), isin };
    const out = await fetchSource(investegateNotice, url, deps);
    if (out.kind === 'unavailable') {
      // Not marked as read, so asked for again next time. The notices already read still show.
      unanswered = out.reason;
      break;
    }
    read++;
    const dealings = out.kind === 'ok' ? await noticeDealings(out.value.people, notice, close)
      : [{ source: 'investegate', key: `${url}#form`, url, filedOn: notice.published.slice(0, 10), tradedOn: null, person: null, role: null,
          kind: 'other', wording: '', shares: null, price: null, value: null, currency: null, valueWorkedOut: false,
          sharesAfter: null, place: null, leftOut: `the notice's form could not be read: ${out.failure.observed}` } as Dealing];
    await db.batch(save(isin, dealings, at));
  }
  const waiting = unread.length - read;
  const notes = [
    unanswered ? `a notice did not answer (${unanswered})` : null,
    waiting > 0 ? `${waiting} more ${waiting === 1 ? 'notice is' : 'notices are'} read at the next refresh` : null,
    londonList && londonList.outcome !== 'ok' ? `the announcements list could not be read (${londonList.detail ?? londonList.outcome})` : londonList?.detail ?? null,
  ].filter(Boolean);
  return { source: OUTCOME, outcome: londonList && londonList.outcome !== 'ok' ? 'unavailable' : 'ok', detail: notes.length ? notes.join('; ') : null };
}

// ── showing ──────────────────────────────────────────────────────────────

/** A stored dealing as the report shows it: with the person's level, worked out from the title. */
export type ShownDealing = Dealing & { readonly level: RoleLevel };

export interface DealingsView {
  readonly source: 'finviz' | 'investegate';
  /** The year shown: from, to the last refresh. */
  readonly from: string;
  readonly to: string;
  readonly dealings: readonly ShownDealing[];
  readonly leftOut: readonly ShownDealing[];
  /** How far the source reached, or what it could not do, at the last refresh. */
  readonly note: string | null;
}

function dealingOf(r: Readonly<Record<string, unknown>>): ShownDealing {
  const n = (k: string) => (r[k] == null ? null : Number(r[k]));
  const s = (k: string) => (r[k] == null ? null : String(r[k]));
  return {
    source: r['source'] as Dealing['source'], key: String(r['key']), url: String(r['url']),
    filedOn: s('filed_on'), tradedOn: s('traded_on'), person: s('person'), role: s('role'),
    kind: r['kind'] as DealingKind, wording: String(r['wording']),
    shares: n('shares'), price: n('price'), value: n('value'), currency: s('currency'),
    valueWorkedOut: Number(r['value_worked_out']) === 1, sharesAfter: n('shares_after'), place: s('place'), leftOut: s('left_out'),
    level: roleLevel(s('role')),
  };
}

/** The last year's dealings, newest first, and what was left out. Null when there are none to show. */
export async function loadDealings(db: Db, isin: string, now: Date, note: string | null): Promise<DealingsView | null> {
  const from = new Date(now.getTime() - WINDOW_DAYS * DAY).toISOString().slice(0, 10);
  const rows = (await db.query(
    `SELECT * FROM insider_dealing WHERE isin = ? AND (traded_on >= ? OR (traded_on IS NULL AND filed_on >= ?))
     ORDER BY coalesce(traded_on, filed_on) DESC, id`, [isin, from, from],
  )).map(dealingOf);
  if (rows.length === 0) return null;
  return {
    source: rows[0]!.source, from, to: now.toISOString().slice(0, 10),
    dealings: rows.filter((d) => d.leftOut === null),
    leftOut: rows.filter((d) => d.leftOut !== null),
    note,
  };
}
