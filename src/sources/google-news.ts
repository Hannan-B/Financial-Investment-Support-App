/**
 * Google News search, as an RSS feed.  PROJECT-PLAN.md §6.6
 *
 * Keyed by the whole query: `intitle:"Shell" (site:bbc.co.uk OR …) after:… before:…`.
 * At most 100 stories per answer — a full answer means the window must be
 * split (the caller does that). Each story's link goes through Google; the
 * publisher's own address is given separately and is what the approved list
 * is checked against. The source's snippet is ignored entirely.
 *
 * ⚠️ No documented terms for apps: optional, and treated like any website.
 */
import type { Source } from '../fetch/types.ts';
import { decodeEntities } from './holdings.ts';

export interface NewsHit {
  /** The headline, without the " - Publisher" Google appends. */
  readonly title: string;
  readonly link: string;
  readonly published: string;
  readonly publisher: string;
  /** The publisher's own web address, e.g. 'https://www.theguardian.com'. */
  readonly publisherUrl: string;
}

/** Google never answers more than this; a full answer means more exist. */
export const PAGE_LIMIT = 100;

const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeEntities(m[1]!.replace(/^<!\[CDATA\[|\]\]>$/g, '')).trim() : null;
};

export const googleNews: Source<NewsHit[]> = {
  id: 'google-news',
  core: false,
  request: (query) => ({
    url: `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-GB&gl=GB&ceid=GB:en`,
  }),
  parse(res) {
    const xml = new TextDecoder().decode(res.body);
    if (!xml.includes('<rss')) throw new Error('not an RSS feed');
    const hits: NewsHit[] = [];
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const item = m[1]!;
      const title = tag(item, 'title');
      const link = tag(item, 'link');
      const pub = tag(item, 'pubDate');
      const source = /<source url="([^"]+)">([\s\S]*?)<\/source>/.exec(item);
      if (!title || !link || !pub || !source) throw new Error(`story without title, link, date or publisher: ${item.slice(0, 120)}`);
      const published = new Date(pub);
      if (Number.isNaN(published.getTime())) throw new Error(`unreadable date: ${pub}`);
      const publisher = decodeEntities(source[2]!).trim();
      const suffix = ` - ${publisher}`;
      hits.push({
        title: title.endsWith(suffix) ? title.slice(0, -suffix.length) : title,
        link, published: published.toISOString(), publisher, publisherUrl: decodeEntities(source[1]!),
      });
    }
    return hits;
  },
  checks: [],
};
