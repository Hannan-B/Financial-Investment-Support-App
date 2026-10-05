/**
 * News.  §11.7 step 2.6: a quarter of Shell news shows no artillery shells,
 * no royaldutchshellplc.com, no daily buyback notices — and every line opens
 * the original article.
 *
 * Against what the sites returned on 2026-10-05: Investegate's two pages for
 * SHEL, Apple's SEC filings, and Google News answers for Shell and Apple —
 * served by a stand-in that, like Google, returns only the stories inside the
 * query's dates and never more than 100.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Transport, HttpRequest, HttpResponse } from '../fetch/types.ts';
import { MemoryDiagnostics, FakeGoogleNews as FakeGoogle } from '../fetch/fixture.ts';
import { NodeDb, migrationsFromDisk } from '../db/node.ts';
import { migrate } from '../db/migrate.ts';
import { securityStatement, fieldStatement, ensureListing } from '../portfolio/master.ts';
import { investegate } from '../sources/investegate.ts';
import { edgarFilings } from '../sources/edgar.ts';
import {
  plainName, mentions, leadsWith, filingHeadline, announcementKind, groupDuplicates,
  fetchNews, loadNews, markViewed, markOpened, hideStory, choosePublisher, setAliases, type NewsLine,
} from './news.ts';
import { PUBLISHERS } from './publishers.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fetch/fixtures/${name}`, import.meta.url));
const NOW = new Date('2026-10-05T18:00:00Z');

class Web implements Transport {
  readonly asked: string[] = [];
  readonly #routes = new Map<string, string | number>();
  readonly #google: FakeGoogle | null;
  constructor(google: FakeGoogle | null) { this.#google = google; }
  route(url: string, fileOrStatus: string | number): this { this.#routes.set(url, fileOrStatus); return this; }
  async get(req: HttpRequest): Promise<HttpResponse> {
    this.asked.push(req.url);
    if (req.url.startsWith('https://news.google.com/') && this.#google) return this.#google.answer(req.url);
    const route = this.#routes.get(req.url);
    if (route === undefined) throw new Error(`nothing served at ${req.url}`);
    if (typeof route === 'number') return { status: route, body: new Uint8Array(), contentType: 'text/plain' };
    return { status: 200, body: new Uint8Array(await readFile(route)), contentType: 'text/html' };
  }
}

async function setup(transport: Transport) {
  const db = new NodeDb();
  await migrate(db, await migrationsFromDisk());
  await db.batch([
    securityStatement('GB00BP6MXD84', 'Shell plc', 'equity', '2026-10-05'),
    fieldStatement('GB00BP6MXD84', 'sector', 'Energy', 'stockanalysis', 2, '2026-10-05'),
    securityStatement('US0378331005', 'Apple Inc.', 'equity', '2026-10-05'),
    fieldStatement('US0378331005', 'sector', 'Technology', 'stockanalysis', 2, '2026-10-05'),
  ]);
  const shell = await ensureListing(db, { isin: 'GB00BP6MXD84', ticker: 'SHEL', exchange: 'LSE', currency: 'GBp', sourceKeys: { yahoo: 'SHEL.L' } });
  const apple = await ensureListing(db, { isin: 'US0378331005', ticker: 'AAPL', exchange: 'NMS', currency: 'USD', sourceKeys: { yahoo: 'AAPL', edgar: '0000320193' } });
  let clock = NOW.getTime();
  const deps = { db, diagnostics: new MemoryDiagnostics(), transport, pause: async () => {}, now: () => new Date(clock) };
  return { db, deps, shell, apple, later: (days: number) => { clock += days * 86_400_000; } };
}

async function shellWeb() {
  const google = new FakeGoogle(await readFile(fixture('google-news-shell.xml'), 'utf8'));
  const web = new Web(google)
    .route(investegate.request('SHEL|1').url, fixture('investegate-shel-1.html'))
    .route(investegate.request('SHEL|2').url, fixture('investegate-shel-2.html'))
    .route(investegate.request('SHEL|3').url, 404);
  return { web, google };
}

async function appleWeb() {
  const google = new FakeGoogle(await readFile(fixture('google-news-apple.xml'), 'utf8'));
  return { web: new Web(google).route(edgarFilings.request('0000320193').url, fixture('edgar-submissions-aapl.json')), google };
}

// ── names ────────────────────────────────────────────────────────────────

test('the name headlines actually use', () => {
  assert.equal(plainName('Shell plc'), 'Shell');
  assert.equal(plainName('Apple Inc.'), 'Apple');
  assert.equal(plainName('Alphabet (Class A)'), 'Alphabet');
  assert.equal(plainName('Rolls-Royce Holdings plc'), 'Rolls-Royce');
});

test('a story about Shell, not about a shell', () => {
  assert.equal(mentions("Shell's profits rise 70%", ['Shell']), true);
  assert.equal(mentions('Shell and BP pull out of Russia', ['Shell']), true);
  assert.equal(mentions('Shell-shocked, haunted photo of Andrew', ['Shell']), false);
  assert.equal(mentions('Shellfish farmers warn of losses', ['Shell']), false);
  assert.equal(mentions('Bomb team detonates artillery shell on beach', ['Shell']), true, 'a headline match cannot tell — the "not about this company" button is for this');
  assert.equal(mentions('Google rolls out Gemini', ['Alphabet', 'Google']), true);
});

test('a press release counts only when the company leads it', () => {
  assert.equal(leadsWith('Shell completes sale of interest in Gulf of America platform', ['Shell']), true);
  assert.equal(leadsWith("Spigen unveils protection for Apple's iPhone 18", ['Apple']), false);
});

// ── what announcements mean ──────────────────────────────────────────────

test('SEC filings in plain words; routine forms set aside', () => {
  const f = (form: string, items: string[] = []) => ({ form, filed: '2026-07-30', items, url: 'https://www.sec.gov/x', description: '' });
  assert.deepEqual(filingHeadline(f('8-K', ['2.02', '9.01'])), { title: 'Results — 8-K', routine: false, results: true });
  assert.deepEqual(filingHeadline(f('8-K', ['5.02'])), { title: 'Director or officer change — 8-K', routine: false, results: false });
  assert.deepEqual(filingHeadline(f('10-Q')), { title: 'Quarterly report — 10-Q', routine: false, results: true });
  assert.equal(filingHeadline(f('4')).routine, false, 'director dealings stay visible');
  assert.equal(filingHeadline(f('144')).routine, true);
  assert.equal(filingHeadline(f('10-K/A')).results, false, 'an amendment is not new results');
});

test('London announcements: buybacks routine, results recognised, director dealings visible', () => {
  assert.deepEqual(announcementKind('Transaction in Own Shares'), { routine: true, results: false });
  assert.deepEqual(announcementKind('Total Voting Rights'), { routine: true, results: false });
  assert.deepEqual(announcementKind('Shell Plc 2nd and half year Quarter 2026 Unaudited Results'), { routine: false, results: true });
  // Seen on Shell's page, and none of them results:
  assert.equal(announcementKind('SHELL PLC SECOND QUARTER 2026 EURO AND GBP EQUIVALENT DIVIDEND PAYMENTS').results, false);
  assert.equal(announcementKind('Shell plc Announces Final Results of Exchange Offer').results, false);
  assert.equal(announcementKind('Shell second quarter 2026 update note').results, false);
  assert.deepEqual(announcementKind('Result of AGM'), { routine: false, results: false });
  assert.deepEqual(announcementKind('Director/PDMR Shareholding'), { routine: false, results: false });
});

// ── fetching and showing ─────────────────────────────────────────────────

test('2.6 ACCEPTANCE — a quarter of Shell news: no artillery shells, no critics’ site, no buyback notices, every line a link', async () => {
  const { web } = await shellWeb();
  const { db, deps, shell } = await setup(web);
  const outcomes = await fetchNews(shell, deps);
  assert.deepEqual(outcomes.map((o) => [o.source, o.outcome]), [['investegate', 'ok'], ['google-news', 'ok']]);

  const view = await loadNews(db, 'GB00BP6MXD84', NOW);
  assert.equal(view.channel, 'investegate');
  const press = view.press.flatMap((g) => [g.lead, ...g.others]);
  const all = [...view.official, ...press];
  assert.ok(view.official.length > 0 && press.length > 0);
  assert.ok(!all.some((l) => /artillery|shell-shocked/i.test(l.title)), 'no stories about the word');
  assert.ok(!all.some((l) => /royaldutchshellplc|jobs\./i.test(l.url + l.publisher)));
  assert.ok(!view.official.some((l) => l.title === 'Transaction in Own Shares'), 'buybacks are set aside…');
  assert.ok(view.routineHidden.some((l) => l.title === 'Transaction in Own Shares'), '…one click away');
  assert.ok(view.official.some((l) => l.title === 'Director/PDMR Shareholding'));
  for (const l of all) assert.match(l.url, /^https:\/\//, `${l.title} opens at its source`);
  const approved = new Set(PUBLISHERS.filter((p) => p.access !== 'not-approved').map((p) => p.name));
  for (const l of press) assert.ok(approved.has(l.publisher), `${l.publisher} is approved`);
  assert.ok(view.official.every((l) => l.archive?.startsWith('https://web.archive.org/web/')), 'official links have an archived copy');
});

test('the window: 180 days the first time; after that, since the last results', async () => {
  const { web } = await shellWeb();
  const { db, deps, shell } = await setup(web);
  await fetchNews(shell, deps);
  const first = await loadNews(db, 'GB00BP6MXD84', NOW);
  assert.equal(first.window, 'last-180-days');
  assert.equal(first.from, '2026-04-08');
  assert.equal(first.resultsDate?.slice(0, 10), '2026-07-30', 'second-quarter results');

  await markViewed(db, 'GB00BP6MXD84', NOW);
  const next = await loadNews(db, 'GB00BP6MXD84', NOW);
  assert.equal(next.window, 'since-results');
  assert.equal(next.from, '2026-07-30');
  assert.equal((await loadNews(db, 'GB00BP6MXD84', NOW, 'last-180-days')).from, '2026-04-08', 'and 180 days on request');
});

test('Apple’s official news is its SEC filings, in plain words', async () => {
  const { web } = await appleWeb();
  const { db, deps, apple } = await setup(web);
  const outcomes = await fetchNews(apple, deps);
  assert.deepEqual(outcomes.map((o) => [o.source, o.outcome]), [['sec-filings', 'ok'], ['google-news', 'ok']]);
  const view = await loadNews(db, 'US0378331005', NOW);
  assert.ok(view.official.some((l) => l.title === 'Results — 8-K' && l.published === '2026-07-30'));
  assert.ok(view.official.some((l) => l.title.startsWith('Director or officer dealing')));
  assert.ok(view.routineHidden.some((l) => / — 144$/.test(l.title)));
  assert.equal(view.resultsDate?.slice(0, 10), '2026-07-31', 'the quarterly report, a day after the results');
  assert.match(view.official[0]!.url, /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/320193\//);
});

test('a busy month is split until Google’s 100-story limit is no longer reached', async () => {
  const { web, google } = await appleWeb();
  const { deps, apple } = await setup(web);
  await fetchNews(apple, deps);
  const full = google.asked.filter((a) => (Date.parse(a.before) - Date.parse(a.after)) / 86_400_000 < 31);
  assert.ok(full.length > 0, 'narrower windows were asked for');
});

test('a heavily covered company stops at 30 searches, newest weeks first — and says what it could not list', async () => {
  // Every search answers with a full 100 stories: as busy as a company can be.
  const busy = (await readFile(fixture('google-news-apple.xml'), 'utf8')).replace(/<pubDate>[^<]+<\/pubDate>/g, '<pubDate>Mon, 05 Oct 2026 08:00:00 GMT</pubDate>');
  class Busy extends Web {
    override async get(req: HttpRequest): Promise<HttpResponse> {
      if (!req.url.startsWith('https://news.google.com/')) return super.get(req);
      this.asked.push(req.url);
      return { status: 200, body: new TextEncoder().encode(busy), contentType: 'application/xml' };
    }
  }
  const web = new Busy(null).route(edgarFilings.request('0000320193').url, fixture('edgar-submissions-aapl.json'));
  const { deps, apple } = await setup(web);
  const outcomes = await fetchNews(apple, deps);
  const searches = web.asked.filter((u) => u.startsWith('https://news.google.com/'));
  assert.equal(searches.length, 30);
  assert.match(decodeURIComponent(searches[0]!), /before:2026-10-06/, 'the newest month is asked first');
  const press = outcomes.find((o) => o.source === 'google-news')!;
  assert.equal(press.outcome, 'ok');
  assert.match(press.detail!, /heavily covered: \d+ of the searches reached Google's limit of 100 stories/);
});

test('a paywalled publisher is searched only once ticked as subscribed', async () => {
  const { web, google } = await appleWeb();
  const { db, deps, apple } = await setup(web);
  await fetchNews(apple, deps);
  assert.ok(!google.asked.some((a) => a.query.includes('site:ft.com')));
  await choosePublisher(db, 'ft.com', true);
  google.asked.length = 0;
  await fetchNews(apple, deps);
  assert.ok(google.asked.some((a) => a.query.includes('site:ft.com')));
});

test('stories older than the dates asked for are dropped, whatever Google returns', async () => {
  const { web } = await shellWeb();
  const { db, deps, shell } = await setup(web);
  await fetchNews(shell, deps);
  const [oldest] = await db.query("SELECT min(published_at) AS at FROM news_item WHERE source = 'google-news'");
  assert.ok(String(oldest!['at']) >= '2026-04-08', `oldest kept: ${oldest!['at']}`);
});

test('a refresh asks only for what is new, with a three-day overlap', async () => {
  const { web, google } = await shellWeb();
  const { deps, shell, later } = await setup(web);
  await fetchNews(shell, deps);
  google.asked.length = 0;
  later(7);
  await fetchNews(shell, deps);
  assert.ok(google.asked.length > 0);
  assert.ok(google.asked.every((a) => a.after >= '2026-10-02'), `asked from ${google.asked[0]?.after}`);
});

test('the user’s marks: not about this company, opened, new since last time', async () => {
  const { web } = await shellWeb();
  const { db, deps, shell, later } = await setup(web);
  await fetchNews(shell, deps);
  await markViewed(db, 'GB00BP6MXD84', NOW);
  const before = await loadNews(db, 'GB00BP6MXD84', NOW, 'last-180-days');
  const story = before.press[0]!.lead;
  await hideStory(db, 'GB00BP6MXD84', story.url, NOW);
  const opened = before.official[0]!;
  await markOpened(db, 'GB00BP6MXD84', opened.url, NOW);
  const after = await loadNews(db, 'GB00BP6MXD84', NOW, 'last-180-days');
  assert.ok(!after.press.some((g) => g.lead.url === story.url || g.others.some((o) => o.url === story.url)), 'hidden for good');
  assert.equal(after.official.find((l) => l.url === opened.url)?.opened, true);
  assert.ok(after.official.every((l) => !l.isNew), 'nothing is new until a later refresh brings it');

  // A story that arrives after the last look is new, until the next look.
  later(1);
  await db.query("UPDATE news_item SET first_seen = ? WHERE url = ?", [new Date(NOW.getTime() + 86_400_000).toISOString(), opened.url]);
  assert.equal((await loadNews(db, 'GB00BP6MXD84', NOW, 'last-180-days')).official.find((l) => l.url === opened.url)?.isNew, true);
  await markViewed(db, 'GB00BP6MXD84', new Date(NOW.getTime() + 2 * 86_400_000));
  assert.equal((await loadNews(db, 'GB00BP6MXD84', NOW, 'last-180-days')).official.find((l) => l.url === opened.url)?.isNew, false);
});

test('publishers: paywalled ones hidden until ticked; any can be switched off', async () => {
  const { web } = await shellWeb();
  const { db, deps, shell } = await setup(web);
  await fetchNews(shell, deps);
  const view = await loadNews(db, 'GB00BP6MXD84', NOW);
  const ft = view.publishers.find((p) => p.host === 'ft.com')!;
  assert.deepEqual([ft.access, ft.shown], ['paywalled', false]);
  const busy = view.publishers.find((p) => p.shown && p.count > 0)!;
  assert.ok(busy, 'some approved publisher has Shell stories in the window');

  await choosePublisher(db, busy.host, false);
  const without = await loadNews(db, 'GB00BP6MXD84', NOW);
  assert.ok(!without.press.some((g) => [g.lead, ...g.others].some((l) => l.publisher === busy.name)));
  await choosePublisher(db, 'ft.com', true);
  assert.equal((await loadNews(db, 'GB00BP6MXD84', NOW)).publishers.find((p) => p.host === 'ft.com')!.shown, true);
  await assert.rejects(choosePublisher(db, 'example.com', true));
});

test('other names widen the search, and reach back 180 days', async () => {
  const { web, google } = await shellWeb();
  const { db, deps, shell } = await setup(web);
  await fetchNews(shell, deps);
  await setAliases(db, 'GB00BP6MXD84', ['Royal Dutch Shell', '  ']);
  google.asked.length = 0;
  await fetchNews(shell, deps);
  assert.ok(google.asked.some((a) => a.query.includes('intitle:"Royal Dutch Shell"')));
  assert.equal(google.asked.map((a) => a.after).sort()[0], '2026-04-08');
  assert.deepEqual((await loadNews(db, 'GB00BP6MXD84', NOW)).names, { plain: 'Shell', aliases: ['Royal Dutch Shell'] });
});

test('the same story from several outlets is one line, “+2 more”', () => {
  const line = (title: string, publisher: string, published: string): NewsLine =>
    ({ url: `https://x/${publisher}`, title, publisher, published, label: null, isNew: false, opened: false, archive: null, detail: null });
  const groups = groupDuplicates([
    line('Shell completes $840 million sale of Gulf of America platform stake', 'BBC', '2026-09-23T10:00:00Z'),
    line('Shell finalises $840m sale of Gulf of America platform interests', 'Offshore Technology', '2026-09-23T14:00:00Z'),
    line('Shell completes sale of interest in Gulf of America platform', 'PR Newswire', '2026-09-22T09:00:00Z'),
    line('Shell faces backlash as profits rise 70% on back of war', 'Sky News', '2026-09-22T09:00:00Z'),
  ], ['Shell']);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((g) => g.lead.publisher === 'Offshore Technology')?.others.length, 2);
});

test('the publisher list is this company’s: trade press for its own sector only', async () => {
  const { web } = await shellWeb();
  const { db, deps, shell } = await setup(web);
  await fetchNews(shell, deps);
  const trade = (await loadNews(db, 'GB00BP6MXD84', NOW)).publishers.filter((p) => p.group === 'trade').map((p) => p.name);
  assert.ok(trade.includes('Energy Voice') && trade.includes('Rigzone'));
  assert.ok(!trade.includes('TechCrunch') && !trade.includes('Fierce Pharma'));
});
