/**
 * News: official announcements and approved press, headlines and links only.
 * PROJECT-PLAN.md §6.6, §11.7 step 2.6
 *
 * Fetching adds headlines to what is kept; showing reads what is kept. A
 * refresh asks only for what is new since the last one (the first asks for
 * 180 days), so a review months later still has its quarter even if a
 * source has gone. Nothing is summarised, and no snippet is stored.
 */
import type { Db, Statement } from '../db/types.ts';
import { fetchSource } from '../fetch/record.ts';
import { edgarFilings, type Filing } from '../sources/edgar.ts';
import { investegate } from '../sources/investegate.ts';
import { googleNews, PAGE_LIMIT, type NewsHit } from '../sources/google-news.ts';
import { classifications } from '../portfolio/master.ts';
import { mapSector, type Sector } from '../categories/sectors.ts';
import { secExchange, type FiguresDeps } from './edgar.ts';
import { DISPLAY_NAME } from './report.ts';
import type { SourceOutcome } from './snapshot.ts';
import { PUBLISHERS, publisherOf, searched, isShown, type Publisher } from './publishers.ts';

const FIRST_DAYS = 180;
/** Re-asked on each refresh, for stories indexed late. */
const OVERLAP_DAYS = 3;
const SITES_PER_QUERY = 12;
const PACE_MS = 1000;
/**
 * Searches per refresh. A heavily covered company (Apple) fills Google's 100
 * stories for nearly every month and publisher group; splitting each until
 * it does not ran to hundreds of searches and many minutes. Past this, the
 * oldest weeks are thinned rather than the refresh dragging on — and the
 * news panel says so.
 */
const MAX_SEARCHES = 30;
const DAY = 86_400_000;

// ── names ────────────────────────────────────────────────────────────────

/** 'Shell plc' → 'Shell'; 'Alphabet (Class A)' → 'Alphabet'. What headlines actually say. */
export function plainName(name: string): string {
  return name
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(plc|p\.l\.c\.|inc\.?|incorporated|corp\.?|corporation|ltd\.?|limited|holdings?|group|co\.?|company|s\.?a\.?|n\.?v\.?|ag|se|asa|oyj)\b\.?/gi, ' ')
    .replace(/[,&]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The name as a word of its own — 'Shell's' yes, 'Shell-shocked' and 'Shellfish' no. */
export function mentions(title: string, names: readonly string[]): boolean {
  return names.some((n) => new RegExp(`(?<![\\p{L}\\p{N}-])${escape(n)}(?![\\p{L}\\p{N}-])`, 'iu').test(title));
}

/** A press release is the company's own only if it leads with the company's name (§6.6). */
export function leadsWith(title: string, names: readonly string[]): boolean {
  return names.some((n) => new RegExp(`^${escape(n)}(?![\\p{L}\\p{N}-])`, 'iu').test(title.trim()));
}

export async function namesFor(db: Db, isin: string): Promise<{ plain: string; aliases: string[] }> {
  const [row] = await db.query(`SELECT ${DISPLAY_NAME} AS name FROM security s WHERE s.isin = ?`, [isin]);
  const aliases = (await db.query('SELECT alias FROM company_alias WHERE isin = ? ORDER BY alias', [isin])).map((r) => String(r['alias']));
  return { plain: plainName(String(row?.['name'] ?? '')), aliases };
}

// ── official announcements: what each means ──────────────────────────────

const ITEMS: Readonly<Record<string, string>> = {
  '1.01': 'Material agreement', '1.02': 'Agreement ended', '1.03': 'Bankruptcy', '1.05': 'Cybersecurity incident',
  '2.01': 'Acquisition or sale completed', '2.02': 'Results', '2.03': 'New debt', '2.04': 'Debt accelerated',
  '2.05': 'Restructuring costs', '2.06': 'Impairment', '3.01': 'Listing notice', '3.02': 'Shares sold privately',
  '3.03': 'Shareholder rights changed', '4.01': 'Auditor changed', '4.02': 'Past accounts no longer reliable',
  '5.01': 'Change of control', '5.02': 'Director or officer change', '5.03': 'Articles or bylaws amended',
  '5.07': 'Shareholder vote', '7.01': 'Statement to investors', '8.01': 'Other event',
};

const FORMS: Readonly<Record<string, { title: string; results?: true }>> = {
  '10-K': { title: 'Annual report', results: true },
  '10-Q': { title: 'Quarterly report', results: true },
  '20-F': { title: 'Annual report (foreign company)', results: true },
  '40-F': { title: 'Annual report (Canadian company)', results: true },
  '6-K': { title: 'Report from a foreign company' },
  '4': { title: 'Director or officer dealing in shares' },
  'DEF 14A': { title: 'Notice of annual meeting' },
};

/** A filing as a headline. Forms not listed — 144, S-8, 13G and the like — are routine. */
export function filingHeadline(f: Filing): { title: string; routine: boolean; results: boolean } {
  const base = f.form.replace(/\/A$/, '');
  const amended = f.form.endsWith('/A') ? ' (amended)' : '';
  if (base === '8-K') {
    const what = f.items.filter((i) => i !== '9.01').map((i) => ITEMS[i] ?? `item ${i}`);
    return { title: `${what.length ? what.join('; ') : 'Current report'}${amended} — 8-K`, routine: false, results: f.items.includes('2.02') };
  }
  const known = FORMS[base];
  if (known) return { title: `${known.title}${amended} — ${f.form}`, routine: false, results: !!known.results && !amended };
  return { title: `${f.description || 'Filing'} — ${f.form}`, routine: true, results: false };
}

/** London's routine notices: daily buybacks, voting rights, block listings, takeover-panel forms (§6.6). */
const RNS_ROUTINE = /^(transaction in own shares|total voting rights|voting rights and capital|block listing|form 8(\.3)?\b|form 8 \(dd\))/i;
/**
 * Results announcements — not every headline that says "quarter". Seen on
 * Shell's page: a dividend-currency notice ("SECOND QUARTER 2026 EURO AND GBP
 * EQUIVALENT DIVIDEND…"), a debt exchange offer ("Final Results of Exchange
 * Offer") and a pre-results note ("second quarter update note") are none of them.
 */
const RNS_RESULTS = /\b(results|unaudited|half[- ]year|interim report|annual report|quarterly report|trading (statement|update))\b/i;
const RNS_NOT_RESULTS = /\b(dividend|exchange offer|tender offer|offer|result of (agm|annual general meeting|general meeting|meeting)|update note|notice of)\b/i;

export function announcementKind(title: string): { routine: boolean; results: boolean } {
  return { routine: RNS_ROUTINE.test(title.trim()), results: RNS_RESULTS.test(title) && !RNS_NOT_RESULTS.test(title) };
}

// ── fetching ─────────────────────────────────────────────────────────────

interface Item {
  readonly url: string; readonly title: string; readonly publisher: string; readonly host: string | null;
  readonly published: string; readonly section: 'official' | 'press';
  readonly label: 'official' | 'regulator' | 'press-release' | null;
  readonly routine: boolean; readonly results: boolean;
  readonly source: 'sec' | 'investegate' | 'google-news'; readonly detail: string | null;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

async function since(db: Db, isin: string, source: string, now: Date): Promise<Date> {
  const [row] = await db.query('SELECT fetched_to FROM news_fetch WHERE isin = ? AND source = ?', [isin, source]);
  return row ? new Date(Date.parse(String(row['fetched_to'])) - OVERLAP_DAYS * DAY) : new Date(now.getTime() - FIRST_DAYS * DAY);
}

/** Fetches what is new and keeps it. Optional throughout: each source reports how it went. */
export async function fetchNews(listingId: number, deps: FiguresDeps): Promise<SourceOutcome[]> {
  const db = deps.db;
  const now = (deps.now ?? (() => new Date()))();
  const pause = deps.pause ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const [l] = await db.query('SELECT isin, ticker, exchange FROM listing WHERE id = ?', [listingId]);
  if (!l) throw new Error(`no listing ${listingId}`);
  const isin = String(l['isin']);
  const ticker = String(l['ticker']);
  const exchange = String(l['exchange']);
  const keys = Object.fromEntries((await db.query('SELECT source, source_key FROM listing_source_key WHERE listing_id = ?', [listingId]))
    .map((r) => [String(r['source']), String(r['source_key'])]));

  const outcomes: SourceOutcome[] = [];
  const items: Item[] = [];
  const done: string[] = [];

  // 1 ── official announcements ──
  if (secExchange(exchange)) {
    const cik = keys['edgar'];
    if (!cik) {
      outcomes.push({ source: 'sec-filings', outcome: 'unavailable', detail: 'the SEC number is not known yet; it is found with the figures' });
    } else {
      const from = isoDay(await since(db, isin, 'sec', now));
      const out = await fetchSource(edgarFilings, cik, deps);
      if (out.kind === 'ok') {
        for (const f of out.value.filter((x) => x.filed >= from)) {
          const h = filingHeadline(f);
          items.push({ url: f.url, title: h.title, publisher: 'SEC filing', host: null, published: f.filed, section: 'official',
            label: 'official', routine: h.routine, results: h.results, source: 'sec', detail: f.items.length ? `items ${f.items.join(', ')}` : f.form });
        }
        outcomes.push({ source: 'sec-filings', outcome: 'ok', detail: null });
        done.push('sec');
      } else {
        outcomes.push({ source: 'sec-filings', outcome: out.kind, detail: out.kind === 'unavailable' ? out.reason : out.failure.observed });
      }
    }
  } else if (exchange === 'LSE') {
    const from = (await since(db, isin, 'investegate', now)).toISOString();
    const tidm = ticker.replace(/\.$/, '');
    let failed: SourceOutcome | null = null;
    for (let page = 1; page <= 6; page++) {
      if (page > 1) await pause(PACE_MS);
      const out = await fetchSource(investegate, `${tidm}|${page}`, deps);
      if (page > 1 && out.kind === 'unavailable' && out.response?.status === 404) break; // past the last page
      if (out.kind !== 'ok') {
        failed = { source: 'investegate', outcome: out.kind, detail: out.kind === 'unavailable' ? out.reason : out.failure.observed };
        break;
      }
      if (out.value.ticker.replace(/\.$/, '') !== tidm) {
        failed = { source: 'investegate', outcome: 'suspect', detail: `asked for ${tidm}, the page is ${out.value.company} (${out.value.ticker})` };
        break;
      }
      const list = out.value.announcements;
      for (const a of list.filter((x) => x.published >= from.slice(0, 19))) {
        items.push({ url: a.url, title: a.title, publisher: a.supplier ? `RNS · ${a.supplier.replace(/ \(Regulatory\)$/, '')}` : 'RNS',
          host: null, published: a.published, section: 'official', label: 'official', ...announcementKind(a.title),
          source: 'investegate', detail: null });
      }
      if (list.length === 0 || list[list.length - 1]!.published < from.slice(0, 19)) break;
    }
    if (failed) outcomes.push(failed);
    else { outcomes.push({ source: 'investegate', outcome: 'ok', detail: null }); done.push('investegate'); }
  } else {
    outcomes.push({ source: 'official-announcements', outcome: 'not-covered', detail: 'no free official channel was found for this market; press coverage only' });
  }

  // 2 ── press coverage ──
  const { plain, aliases } = await namesFor(db, isin);
  const names = [plain, ...aliases].filter(Boolean);
  if (names.length === 0) {
    outcomes.push({ source: 'google-news', outcome: 'not-covered', detail: 'no name to search for' });
  } else {
    const sector = await sectorOf(db, isin);
    const choices = await publisherChoices(db);
    const pubs = searched(sector, choices);
    const intitle = names.length === 1 ? `intitle:"${names[0]}"` : `(${names.map((n) => `intitle:"${n}"`).join(' OR ')})`;
    const start = await since(db, isin, 'google-news', now);
    const end = new Date(now.getTime() + DAY);
    let failure: SourceOutcome | null = null;
    let searches = 0;
    let full = 0;

    // Months newest first, so if the searches run out it is the oldest weeks that are thinned.
    const months: [Date, Date][] = [];
    for (let to = end; to > start; to = new Date(to.getTime() - 31 * DAY)) {
      months.push([new Date(Math.max(to.getTime() - 31 * DAY, start.getTime())), to]);
    }
    const groups: Publisher[][] = [];
    for (let i = 0; i < pubs.length; i += SITES_PER_QUERY) groups.push(pubs.slice(i, i + SITES_PER_QUERY));
    // Every month and group is asked once before any is split.
    const spare = () => MAX_SEARCHES - searches - (months.length * groups.length - asked);
    let asked = 0;

    const ask = async (sites: readonly Publisher[], from: Date, to: Date, depth: number): Promise<NewsHit[] | null> => {
      const query = `${intitle} (${sites.map((p) => `site:${p.hosts[0]}`).join(' OR ')}) after:${isoDay(from)} before:${isoDay(to)}`;
      await pause(PACE_MS);
      searches++;
      const out = await fetchSource(googleNews, query, deps);
      if (out.kind !== 'ok') {
        failure = { source: 'google-news', outcome: out.kind, detail: out.kind === 'unavailable' ? out.reason : out.failure.observed };
        return null;
      }
      if (out.value.length < PAGE_LIMIT) return out.value;
      // A full answer means more exist: halve the window and ask again (§6.6), while searches last.
      if (depth < 4 && to.getTime() - from.getTime() > 4 * DAY && spare() >= 2) {
        const mid = new Date((from.getTime() + to.getTime()) / 2);
        const b = await ask(sites, mid, to, depth + 1);
        const a = b && await ask(sites, from, mid, depth + 1);
        return a && b ? [...b, ...a] : null;
      }
      full++;
      return out.value;
    };

    outer:
    for (const [from, to] of months) {
      for (const sites of groups) {
        if (searches >= MAX_SEARCHES) { full++; continue; }
        asked++;
        const hits = await ask(sites, from, to, 0);
        if (!hits) break outer;
        for (const h of hits) {
          // Google does not strictly keep to the dates asked for (Shell's answer reached back to 2010).
          if (h.published < from.toISOString().slice(0, 10)) continue;
          // The publisher is checked again from the answer, never trusted from the query (§6.6).
          const pub = publisherOf(h.publisherUrl);
          if (!pub || !mentions(h.title, names)) continue;
          if (pub.group === 'press-release' && !leadsWith(h.title, names)) continue;
          items.push({ url: h.link, title: h.title, publisher: pub.name, host: pub.hosts[0]!, published: h.published,
            section: 'press', label: pub.group === 'regulator' ? 'regulator' : pub.group === 'press-release' ? 'press-release' : null,
            routine: false, results: false, source: 'google-news', detail: null });
        }
      }
    }
    if (failure) outcomes.push(failure);
    else {
      outcomes.push({
        source: 'google-news', outcome: 'ok',
        detail: full ? `heavily covered: ${full} of the searches reached Google's limit of 100 stories, so some stories from the busiest weeks are not listed` : null,
      });
      done.push('google-news');
    }
  }

  const at = now.toISOString();
  const writes: Statement[] = items.map((i) => ({
    sql: `INSERT INTO news_item (isin, url, title, publisher, host, published_at, section, label, routine, results, source, detail, first_seen)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (isin, url) DO NOTHING`,
    params: [isin, i.url, i.title, i.publisher, i.host, i.published, i.section, i.label, i.routine ? 1 : 0, i.results ? 1 : 0, i.source, i.detail, at],
  }));
  // Only a source that answered fully moves its marker on: a failed one is asked for the same days again.
  for (const source of done) {
    writes.push({
      sql: `INSERT INTO news_fetch (isin, source, fetched_to, fetched_at) VALUES (?, ?, ?, ?)
            ON CONFLICT (isin, source) DO UPDATE SET fetched_to = excluded.fetched_to, fetched_at = excluded.fetched_at`,
      params: [isin, source, isoDay(now), at],
    });
  }
  await db.batch(writes);
  return outcomes;
}

// ── showing ──────────────────────────────────────────────────────────────

export interface NewsLine {
  readonly url: string;
  readonly title: string;
  readonly publisher: string;
  readonly published: string;
  readonly label: 'official' | 'regulator' | 'press-release' | null;
  readonly isNew: boolean;
  readonly opened: boolean;
  /** For official announcements: the Internet Archive's copy, should the page go (§6.6). */
  readonly archive: string | null;
  readonly detail: string | null;
}

export interface NewsGroup {
  readonly lead: NewsLine;
  /** The same story from other outlets (§6.6). */
  readonly others: readonly NewsLine[];
}

export interface PublisherRow {
  readonly host: string;
  readonly name: string;
  readonly group: Publisher['group'];
  readonly access: Publisher['access'];
  readonly shown: boolean;
  readonly note: string | null;
  /** Stories from it in the window, shown or not. */
  readonly count: number;
}

/** Where official announcements come from for a listing — or that none were found (§6.6). */
export type OfficialChannel = 'sec' | 'investegate' | 'none';

export interface NewsView {
  readonly channel: OfficialChannel;
  /** Set when the last press search could not list everything — said plainly, never silent. */
  readonly limited: string | null;
  /** Where the window starts, and why. */
  readonly from: string;
  readonly window: 'since-results' | 'last-180-days';
  readonly resultsDate: string | null;
  readonly official: readonly NewsLine[];
  readonly routineHidden: readonly NewsLine[];
  readonly press: readonly NewsGroup[];
  readonly publishers: readonly PublisherRow[];
  readonly names: { readonly plain: string; readonly aliases: readonly string[] };
  readonly fetched: boolean;
}

/** The company's level-1 sector, for its trade press — none when not known (§6.6). */
async function sectorOf(db: Db, isin: string): Promise<Sector | null> {
  const label = (await classifications(db)).get(isin)?.sector;
  return label ? mapSector(label.source, label.label) ?? null : null;
}

export async function publisherChoices(db: Db): Promise<Map<string, boolean>> {
  return new Map((await db.query('SELECT host, shown FROM publisher_choice')).map((r) => [String(r['host']), Number(r['shown']) === 1]));
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'its', 'are', 'has', 'have', 'after', 'over', 'into', 'new', 'says', 'said', 'will', 'more', 'than', 'about']);
function words(title: string, names: readonly string[]): Set<string> {
  const skip = new Set(names.flatMap((n) => n.toLowerCase().split(/\s+/)));
  return new Set(title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w) && !skip.has(w)));
}

/** The same event from several outlets within two days, by shared headline words — arithmetic, not AI. */
export function groupDuplicates(lines: readonly NewsLine[], names: readonly string[]): NewsGroup[] {
  const groups: { lead: NewsLine; others: NewsLine[]; words: Set<string> }[] = [];
  for (const line of [...lines].sort((a, b) => b.published.localeCompare(a.published))) {
    const w = words(line.title, names);
    const match = groups.find((g) => {
      if (Math.abs(Date.parse(g.lead.published) - Date.parse(line.published)) > 2 * DAY) return false;
      const shared = [...w].filter((x) => g.words.has(x)).length;
      return shared >= 3 && shared / Math.min(w.size, g.words.size) >= 0.5;
    });
    if (match) match.others.push(line);
    else groups.push({ lead: line, others: [], words: w });
  }
  return groups.map(({ lead, others }) => ({ lead, others }));
}

export async function loadNews(db: Db, isin: string, now: Date, window: 'default' | 'last-180-days' = 'default'): Promise<NewsView> {
  const names = await namesFor(db, isin);
  const [view] = await db.query('SELECT last_viewed_at FROM news_view WHERE isin = ?', [isin]);
  const [results] = await db.query(
    "SELECT max(published_at) AS at FROM news_item WHERE isin = ? AND results = 1 AND published_at <= ?", [isin, now.toISOString()],
  );
  const resultsDate = (results?.['at'] as string | null) ?? null;
  // The first look is 180 days, for context; after that, since the last results (§6.6).
  const sinceResults = window === 'default' && resultsDate !== null && view !== undefined;
  const from = sinceResults ? resultsDate!.slice(0, 10) : isoDay(new Date(now.getTime() - FIRST_DAYS * DAY));
  // "New" is what arrived after the last look; the screen records this look once it has shown the list.
  const previous = (view?.['last_viewed_at'] as string | null) ?? null;

  const rows = await db.query(
    `SELECT n.*, o.opened_at FROM news_item n
     LEFT JOIN news_opened o ON o.isin = n.isin AND o.url = n.url
     WHERE n.isin = ? AND n.published_at >= ? AND n.url NOT IN (SELECT url FROM news_hidden WHERE isin = ?)
     ORDER BY n.published_at DESC`,
    [isin, from, isin],
  );
  const line = (r: Readonly<Record<string, unknown>>): NewsLine => ({
    url: String(r['url']), title: String(r['title']), publisher: String(r['publisher']), published: String(r['published_at']),
    label: (r['label'] as NewsLine['label']) ?? null,
    isNew: previous !== null && String(r['first_seen']) > previous,
    opened: r['opened_at'] != null,
    archive: r['section'] === 'official' ? `https://web.archive.org/web/${String(r['published_at']).slice(0, 10).replace(/-/g, '')}/${String(r['url'])}` : null,
    detail: (r['detail'] as string | null) ?? null,
  });

  const choices = await publisherChoices(db);
  const sector = await sectorOf(db, isin);
  const official = rows.filter((r) => r['section'] === 'official');
  const press = rows.filter((r) => r['section'] === 'press');
  const counts = new Map<string, number>();
  for (const r of press) counts.set(String(r['host']), (counts.get(String(r['host'])) ?? 0) + 1);
  const shownPress = press.filter((r) => {
    const pub = PUBLISHERS.find((p) => p.hosts[0] === r['host']);
    return pub ? isShown(pub, choices) : false;
  });

  const [fetched] = await db.query('SELECT count(*) AS n FROM news_fetch WHERE isin = ?', [isin]);
  const exchanges = (await db.query('SELECT exchange FROM listing WHERE isin = ?', [isin])).map((r) => String(r['exchange']));
  const [lastSearch] = await db.query(
    `SELECT x.detail FROM snapshot_source x JOIN snapshot s ON s.id = x.snapshot_id JOIN report r ON r.id = s.report_id
     WHERE r.isin = ? AND x.source = 'google-news' ORDER BY s.captured_at DESC LIMIT 1`, [isin],
  );
  return {
    limited: (lastSearch?.['detail'] as string | null) ?? null,
    channel: exchanges.some((e) => secExchange(e)) ? 'sec' : exchanges.includes('LSE') ? 'investegate' : 'none',
    from,
    window: sinceResults ? 'since-results' : 'last-180-days',
    resultsDate,
    official: official.filter((r) => Number(r['routine']) !== 1).map(line),
    routineHidden: official.filter((r) => Number(r['routine']) === 1).map(line),
    press: groupDuplicates(shownPress.map(line), [names.plain, ...names.aliases]),
    // This company's publishers: trade press only for its own sector.
    publishers: PUBLISHERS.filter((p) => p.group !== 'trade' || (sector !== null && p.sectors?.includes(sector))).map((p) => ({
      host: p.hosts[0]!, name: p.name, group: p.group, access: p.access, shown: isShown(p, choices),
      note: p.note ?? null, count: counts.get(p.hosts[0]!) ?? 0,
    })),
    names,
    fetched: Number(fetched?.['n'] ?? 0) > 0,
  };
}

// ── what the user does ───────────────────────────────────────────────────

/** Looking at the news: what arrived since the time before is "new". */
export async function markViewed(db: Db, isin: string, now: Date): Promise<void> {
  await db.query(
    `INSERT INTO news_view (isin, last_viewed_at, previous_viewed_at) VALUES (?, ?, NULL)
     ON CONFLICT (isin) DO UPDATE SET previous_viewed_at = news_view.last_viewed_at, last_viewed_at = excluded.last_viewed_at`,
    [isin, now.toISOString()],
  );
}

export async function markOpened(db: Db, isin: string, url: string, now: Date): Promise<void> {
  await db.query('INSERT INTO news_opened (isin, url, opened_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [isin, url, now.toISOString()]);
}

export async function hideStory(db: Db, isin: string, url: string, now: Date): Promise<void> {
  await db.query('INSERT INTO news_hidden (isin, url, hidden_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [isin, url, now.toISOString()]);
}

export async function choosePublisher(db: Db, host: string, shown: boolean): Promise<void> {
  if (!PUBLISHERS.some((p) => p.hosts[0] === host)) throw new Error(`not a known publisher: ${host}`);
  await db.query('INSERT INTO publisher_choice (host, shown) VALUES (?, ?) ON CONFLICT (host) DO UPDATE SET shown = excluded.shown', [host, shown ? 1 : 0]);
}

/** Other names a company's headlines use. Takes effect from the next refresh, for 180 days back. */
export async function setAliases(db: Db, isin: string, aliases: readonly string[]): Promise<void> {
  const clean = [...new Set(aliases.map((a) => a.trim()).filter((a) => a.length >= 2 && a.length <= 60))];
  await db.batch([
    { sql: 'DELETE FROM company_alias WHERE isin = ?', params: [isin] },
    ...clean.map((a) => ({ sql: 'INSERT INTO company_alias (isin, alias) VALUES (?, ?)', params: [isin, a] })),
    // New names reach back: the press search starts again from 180 days.
    { sql: "DELETE FROM news_fetch WHERE isin = ? AND source = 'google-news'", params: [isin] },
  ]);
}
