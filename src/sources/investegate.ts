/**
 * Investegate — every official London announcement (RNS and the other
 * regulatory wires), free.  PROJECT-PLAN.md §6.6
 *
 * Keyed '<TIDM>|<page>': 'SHEL|1'. Fifty announcements a page, newest first.
 * robots.txt permits company pages. The page names its company — "Shell
 * (SHEL) RNS Announcements" — which is checked against the ticker asked for.
 */
import type { Source } from '../fetch/types.ts';
import { decodeEntities } from './holdings.ts';

export interface Announcement {
  /** ISO timestamp, London time as published. */
  readonly published: string;
  /** The wire it came through: 'GlobeNewswire (Regulatory)', 'RNS'. */
  readonly supplier: string;
  readonly title: string;
  readonly url: string;
}

export interface AnnouncementPage {
  /** The ticker in the page's heading: 'SHEL'. */
  readonly ticker: string;
  readonly company: string;
  readonly announcements: readonly Announcement[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '05 Oct 2026' + '11:04 AM' → '2026-10-05T11:04:00'. */
function when(date: string, time: string): string {
  const d = /^(\d{2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(date.trim());
  const t = /^(\d{1,2}):(\d{2}) ([AP]M)$/.exec(time.trim());
  if (!d || MONTHS.indexOf(d[2]!) < 0) throw new Error(`unrecognised date: ${date}`);
  const hour = t ? Number(t[1]) % 12 + (t[3] === 'PM' ? 12 : 0) : 0;
  if (!t && time.trim()) throw new Error(`unrecognised time: ${time}`);
  return `${d[3]}-${String(MONTHS.indexOf(d[2]!) + 1).padStart(2, '0')}-${d[1]}T${String(hour).padStart(2, '0')}:${t ? t[2] : '00'}:00`;
}

export const investegate: Source<AnnouncementPage> = {
  id: 'investegate',
  core: false,
  request(key) {
    const [tidm, page] = key.split('|');
    if (!tidm || !/^[A-Z0-9.]{1,8}$/.test(tidm)) throw new Error(`not a London ticker: ${tidm}`);
    return { url: `https://www.investegate.co.uk/company/${encodeURIComponent(tidm)}${page && page !== '1' ? `?page=${page}` : ''}` };
  },
  parse(res) {
    const html = new TextDecoder().decode(res.body);
    const heading = /<h1[^>]*id="main-title"[^>]*>([^<]*)\(([^)]+)\)\s*RNS Announcements</.exec(html);
    if (!heading) throw new Error('no company heading on the page');
    if (!html.includes('table-investegate')) throw new Error('no announcements table on the page');
    const announcements: Announcement[] = [];
    const rows = html.matchAll(/<tr>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>([\s\S]*?)<\/tr>/g);
    for (const r of rows) {
      const link = /class="announcement-link" href="([^"]+)">([\s\S]*?)<\/a>/.exec(r[3]!);
      if (!link) continue;
      const supplier = /title="supplier: ([^"]*)"/.exec(r[3]!)?.[1] ?? '';
      announcements.push({
        published: when(r[1]!, r[2]!),
        supplier: decodeEntities(supplier),
        title: decodeEntities(link[2]!.replace(/<[^>]+>/g, '')).trim(),
        url: link[1]!,
      });
    }
    return { company: decodeEntities(heading[1]!).trim(), ticker: heading[2]!.trim(), announcements };
  },
  checks: [],
};

// ── Director/PDMR notices (§11.7 step 2.8) ──────────────────────────────

/**
 * One notice, as written: every person's dealings on the regulator's form
 * (UK MAR Article 19). Nothing is interpreted here — prices, dates and the
 * nature of each dealing stay the notice's own words, for the insider reader
 * to judge.
 *
 * Seen live 2026-11-02, the same form laid out at least four ways: Shell's
 * "First Name(s) | Last Name(s)" and "Price | £33.41 | Volume | 31,786";
 * Tesco's "Price(s) £5.40" in one cell; Lloyds' and BP's table of prices and
 * volumes, sometimes with a row label ("Partnership Shares"). The aggregated
 * line is not read: Vodafone's gives the total value under "Price(s)".
 */
export interface PdmrNotice {
  readonly people: readonly PdmrPerson[];
}

export interface PdmrPerson {
  readonly name: string | null;
  readonly position: string | null;
  readonly dealings: readonly PdmrDealing[];
}

export interface PdmrDealing {
  /** The instrument as described: 'Ordinary shares of €0.07 each'. */
  readonly instrument: string | null;
  /** The ISIN the form gives for it, if any. */
  readonly isin: string | null;
  readonly nature: string | null;
  /** The form's currency field, as written. */
  readonly currency: string | null;
  /** Each price and volume as written, with any row label. */
  readonly lines: readonly { readonly label: string | null; readonly price: string; readonly volume: string }[];
  readonly date: string | null;
  readonly place: string | null;
  /** Why the prices and volumes could not be read, if they could not. */
  readonly problem: string | null;
}

const PERSON = /Details of the person discharging managerial/i;
const INSTRUMENT = /^Description of the financial instrument/i;
const ISIN = /\b[A-Z]{2}[A-Z0-9]{9}\d\b/;

/** A cell's text. The forms pad empty cells with `&#160;` and write `&pound;`: neither may read as a value. */
function cellText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&pound;/g, '£').replace(/&euro;/g, '€')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16))))
    .replace(/\s+/g, ' ').trim();
}

/** The value after the first cell matching `label`, within `cells`. */
function after(cells: readonly string[], label: RegExp): string | null {
  const i = cells.findIndex((c) => label.test(c));
  return i >= 0 && i + 1 < cells.length ? cells[i + 1]! : null;
}

function lines(seg: readonly string[]): PdmrDealing['lines'] {
  const table = seg.findIndex((c) => /^Price\(s\) and volume\(s\)$/i.test(c));
  if (table < 0) {
    // Shell's layout: "Price | £33.41 | Volume | 31,786", then the same again as "Aggregated information".
    const end = seg.findIndex((c) => /^Aggregated/i.test(c));
    const head = end < 0 ? seg : seg.slice(0, end);
    const price = after(head, /^Price$/i);
    const volume = after(head, /^Volume$/i);
    return price && volume ? [{ label: null, price, volume }] : [];
  }
  const rest = seg.slice(table + 1);
  // Tesco's layout: "Price(s) £5.40 | Volume(s) 26".
  const p = /^Price\(s\)\s+(.+)$/i.exec(rest[0] ?? '');
  const v = /^Volume\(s\)\s+(.+)$/i.exec(rest[1] ?? '');
  if (p && v) return [{ label: null, price: p[1]!, volume: v[1]! }];
  // Lloyds' and BP's: a table of prices and volumes, up to the next lettered row.
  const out: { label: string | null; price: string; volume: string }[] = [];
  let label: string | null = null;
  let price: string | null = null;
  for (const c of rest) {
    if (/^[a-z]\)$/i.test(c) || /^Aggregated/i.test(c) || /^Date of/i.test(c)) break;
    if (/^(Price\(s\)|Volume\(s\))$/i.test(c)) continue;
    if (!/\d/.test(c)) { label = c; continue; }
    if (price === null) price = c;
    else { out.push({ label, price, volume: c }); price = null; }
  }
  if (price !== null) throw new Error(`a price without a volume: ${price}`);
  return out;
}

function dealing(seg: readonly string[]): PdmrDealing {
  const upToNature = seg.slice(0, Math.max(1, seg.findIndex((c) => /^Nature of the transaction$/i.test(c))));
  let read: PdmrDealing['lines'] = [];
  let problem: string | null = null;
  try { read = lines(seg); } catch (e) { problem = e instanceof Error ? e.message : String(e); }
  return {
    instrument: seg[1] ?? null,
    isin: upToNature.map((c) => ISIN.exec(c)?.[0]).find(Boolean) ?? null,
    nature: after(seg, /^Nature of the transaction$/i),
    currency: after(seg, /^Currency$/i),
    lines: read,
    date: after(seg, /^Date of (the )?transaction$/i),
    place: after(seg, /^Place of (the )?transaction$/i),
    problem,
  };
}

export const investegateNotice: Source<PdmrNotice> = {
  id: 'investegate-notice',
  core: false,
  request(url) {
    if (!/^https:\/\/www\.investegate\.co\.uk\/announcement\/[\w.\-/]+$/.test(url)) throw new Error(`not an Investegate announcement: ${url}`);
    return { url };
  },
  parse(res) {
    const html = new TextDecoder().decode(res.body);
    const cells = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map((m) => cellText(m[1]!))
      .filter((c) => c !== '');
    const starts = cells.flatMap((c, i) => (PERSON.test(c) ? [i] : []));
    if (starts.length === 0) throw new Error('no notification form on the page');
    const people = starts.map((start, k) => {
      const block = cells.slice(start, starts[k + 1] ?? cells.length);
      const issuer = block.findIndex((c) => /Details of the issuer/i.test(c));
      const own = issuer < 0 ? block : block.slice(0, issuer);
      const first = after(own, /^First Name\(s\)$/i);
      const last = after(own, /^Last Name\(s\)$/i);
      const name = first || last ? [first, last].filter(Boolean).join(' ') : after(own, /^Name$/i);
      const marks = block.flatMap((c, i) => (INSTRUMENT.test(c) ? [i] : []));
      const dealings = marks.map((m, j) => dealing(block.slice(m, marks[j + 1] ?? block.length)));
      return { name, position: after(own, /^Position\s*\/\s*status$/i), dealings };
    });
    return { people };
  },
  checks: [],
};
