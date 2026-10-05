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
