/**
 * The screens without the app: a portfolio computed by `npm run demo` from
 * INVENTED Trading 212 holdings and real public fund contents, replayed in an
 * ordinary browser. Never used inside the app.
 *
 * Research: Apple and Shell, opened and refreshed by the app's own code from
 * responses the sites gave on 2026-10-05.
 *
 * Notes: invented ones, written by the app's own code; what is written in the
 * demo is kept in memory until the page reloads. The rules come from
 * `notes/document.ts`, as the app's do.
 */
import type { Backend, NotesData } from './backend.ts';
import type { Portfolio, SourceReport } from '../portfolio/refresh.ts';
import type { ReportData, ReportSummary } from '../research/report.ts';
import type { NewsView } from '../research/news.ts';
import type { Instrument } from '../sources/t212.ts';
import { marketOf } from '../research/catalogue.ts';
import { cannotAdd, cannotCompleteReview, currentRound, bodyOf, type Entry, type Label } from '../notes/document.ts';
import type { Mark, LabelChange, Done, Refused, Decision } from '../notes/store.ts';
import type { HistoryFacts, Choices } from '../research/history.ts';
import { REFRESH_STEPS } from '../research/company.ts';

const files = import.meta.glob<{ default: unknown }>('./demo/*.json');

async function fixture<T>(name: string): Promise<T> {
  const load = files[`./demo/${name}.json`];
  if (!load) throw new Error('No demo data. Run `npm run demo` to generate it.');
  return (await load()).default as T;
}

interface Research {
  readonly catalogue: readonly Instrument[];
  readonly opened: Readonly<Record<string, number>>;
  readonly summaries: readonly ReportSummary[];
  readonly reports: Readonly<Record<string, ReportData>>;
  readonly news: Readonly<Record<string, Readonly<Record<'default' | 'last-180-days', NewsView>>>>;
  readonly notes: Readonly<Record<string, Book>>;
  /** Every refresh the demo made of each company, by ISIN (§11.9 step 4.1). */
  readonly history: Readonly<Record<string, HistoryFacts>>;
  readonly knownFigures: readonly string[];
}

/** One company's notes, labels and markers, as the demo keeps them. */
interface Book { entries: Entry[]; labels: LabelChange[]; marks: Mark[] }

const DEMO_ONLY = 'the demo can open Apple and Shell only, the companies whose responses it has saved';

export function demoBackend(): Backend {
  let key = true;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const research = () => fixture<Research>('research');

  // ── History tab choices, in memory ──
  let hidden: readonly string[] = [];
  const extra = new Map<string, readonly string[]>();

  // ── notes, in memory ──
  let books: Map<string, Book> | null = null;
  let nextId = 100_000;
  const now = () => new Date().toISOString();
  const DONE: Done = { kind: 'done' };
  const no = (reason: string): Refused => ({ kind: 'refused', reason });
  async function book(isin: string): Promise<Book> {
    books ??= new Map(Object.entries(structuredClone((await research()).notes ?? {})));
    if (!books.has(isin)) books.set(isin, { entries: [], labels: [], marks: [] });
    return books.get(isin)!;
  }
  const labelOf = (b: Book): Label => b.labels.at(-1)?.label ?? 'none';
  const markOf = (b: Book): Mark | null => { const m = b.marks.at(-1); return m && !m.clearedAt ? m : null; };
  function label(b: Book, l: Label) { if (labelOf(b) !== l) b.labels.push({ at: now(), label: l }); }
  function decide(b: Book, d: Decision) {
    b.entries.push({ id: nextId++, round: currentRound(b.entries), kind: 'decision', createdAt: now(), tab: null, target: null, snapshotId: null,
      stance: d.stance, sold: d.sold, versions: d.comment.trim() ? [{ writtenAt: now(), body: d.comment.trim() }] : [], deletedAt: null });
    label(b, d.stance);
  }
  async function find(id: number): Promise<{ b: Book; i: number } | null> {
    await book('');
    for (const b of books!.values()) { const i = b.entries.findIndex((e) => e.id === id); if (i >= 0) return { b, i }; }
    return null;
  }
  async function change(id: number, edit: (e: Entry) => Entry | Refused): Promise<Done | Refused> {
    const at = await find(id);
    if (!at) return no('That entry no longer exists');
    const next = edit(at.b.entries[at.i]!);
    if ('reason' in next) return next;
    at.b.entries[at.i] = next;
    return DONE;
  }
  return {
    demo: true,
    async start() {},
    async keySaved() { return key; },
    async saveKey() { key = true; },
    async removeKey() { key = false; },
    load: () => fixture<Portfolio>('portfolio'),
    async refresh() { await wait(600); return fixture<SourceReport[]>('reports'); },
    async classify(onProgress) {
      for (let i = 1; i <= 20; i++) { await wait(60); onProgress(i, 20); }
      return { found: 18, notFound: 2 };
    },
    async persistentFailures() { return []; },

    async reports() {
      const r = await research();
      return Promise.all(r.summaries.map(async (s) => ({ ...s, label: labelOf(await book(s.isin)) })));
    },
    async searchCompanies(query) {
      const q = query.trim().toLowerCase();
      const hits = q ? (await research()).catalogue
        .filter((i) => i.shortName.toLowerCase().startsWith(q) || i.name.toLowerCase().includes(q))
        .map((i) => ({ t212Ticker: i.ticker, isin: i.isin, name: i.name, shortName: i.shortName, currency: i.currency, type: i.type, market: marketOf(i.ticker) }))
        : [];
      return { hits, note: null };
    },
    async openCompany(t212Ticker) {
      await wait(400);
      const id = (await research()).opened[t212Ticker];
      return id === undefined ? { kind: 'refused', reason: DEMO_ONLY } : { kind: 'opened', listingId: id };
    },
    async openHolding(isin) {
      const r = await research();
      const entry = r.catalogue.find((i) => i.isin === isin);
      const id = entry ? r.opened[entry.ticker] : undefined;
      return id === undefined ? { kind: 'refused', reason: DEMO_ONLY } : { kind: 'opened', listingId: id };
    },
    async refreshCompany(listingId, onStep) {
      for (const [i, s] of REFRESH_STEPS.entries()) { onStep?.(i, REFRESH_STEPS.length, s); await wait(500); }
      const report = (await research()).reports[listingId];
      if (!report?.snapshot) return { kind: 'refused', reason: 'nothing saved for this company in the demo', sources: [] };
      return { kind: 'saved', snapshotId: report.snapshot.id, complete: report.snapshot.complete, sources: report.snapshot.sources, newPayloads: 0 };
    },
    loadReport: async (listingId) => (await research()).reports[listingId] ?? null,

    async history(isin) {
      return (await research()).history?.[isin] ?? { snapshots: [], facts: [], gaps: [] };
    },
    async historyChoices(isin): Promise<Choices> { return { hidden, extra: extra.get(isin) ?? [] }; },
    async saveHistoryChoices(isin, c) { hidden = [...c.hidden]; extra.set(isin, c.extra.filter((p) => c.hidden.includes(p))); },
    async knownFigures() { return (await research()).knownFigures ?? []; },

    async news(listingId, window) {
      const n = (await research()).news[listingId];
      if (!n) throw new Error(DEMO_ONLY);
      return n[window];
    },
    async newsSeen() {},
    async openLink(url) { window.open(url, '_blank', 'noopener'); },
    async hideStory() {},
    async choosePublisher() {},
    async setAliases() {},

    async notes(isin): Promise<NotesData> {
      const b = await book(isin);
      return { entries: [...b.entries], label: labelOf(b), mark: markOf(b) };
    },
    async addNote(isin, entry) {
      const b = await book(isin);
      const why = cannotAdd(b.entries, entry.kind, entry.body);
      if (why) return no(why);
      const c = entry.kind === 'comment' ? entry : null;
      b.entries.push({ id: nextId++, round: currentRound(b.entries), kind: entry.kind, createdAt: now(), tab: c?.tab ?? null, target: c?.target ?? null,
        snapshotId: c?.snapshotId ?? null, stance: null, sold: null, versions: [{ writtenAt: now(), body: entry.body.trim() }], deletedAt: null });
      return DONE;
    },
    editNote: (id, body) => change(id, (e) => {
      if (e.deletedAt) return no('That entry was deleted');
      if (!body.trim() && e.kind !== 'decision') return no('There is nothing written — to remove it, delete it');
      return body.trim() === bodyOf(e) ? e : { ...e, versions: [...e.versions, { writtenAt: now(), body: body.trim() }] };
    }),
    deleteNote: (id) => change(id, (e) => (e.kind === 'decision'
      ? no('A decision line marks the end of a review and stays; its comment can be edited') : { ...e, deletedAt: e.deletedAt ?? now() })),
    async completeReview(isin, d) {
      const b = await book(isin);
      const why = cannotCompleteReview(b.entries);
      if (why) return no(why);
      decide(b, d);
      return DONE;
    },
    async setLabel(isin, l) { label(await book(isin), l); },
    async openToReview(t212Ticker) {
      const r = await research();
      const id = r.opened[t212Ticker];
      if (id === undefined) return { kind: 'refused', reason: DEMO_ONLY };
      label(await book(r.catalogue.find((i) => i.ticker === t212Ticker)!.isin), 'to_review');
      return { kind: 'opened', listingId: id };
    },
    async marks() {
      await book('');
      return new Map([...books!].flatMap(([isin, b]) => { const m = markOf(b); return m ? [[isin, m] as const] : []; }));
    },
    async nextResults(isin) {
      const report = Object.values((await research()).reports).find((r) => r.summary.isin === isin);
      const next = report?.calendar.kind === 'ok' ? report.calendar.data.facts.find((f) => f.fieldPath === 'calendar.next_earnings') : undefined;
      if (typeof next?.value !== 'string') return { reason: 'No results date is known — refresh the company, or choose a date' };
      if (next.value < now().slice(0, 10)) return { reason: `The results date from the last refresh, ${next.value}, has passed — refresh the company, or choose a date` };
      return { date: next.value };
    },
    async markIneligible(isin, m) {
      const b = await book(isin);
      if (markOf(b) && !markOf(b)!.soldAt) return no('It is already marked ineligible');
      let sellBy: string | null = null;
      if (m.sellBy?.basis === 'date') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(m.sellBy.date)) return no('Choose a sell-by date');
        sellBy = m.sellBy.date;
      } else if (m.sellBy) {
        const next = await this.nextResults(isin);
        if ('reason' in next) return no(next.reason);
        sellBy = next.date;
      }
      b.marks.push({ id: nextId++, markedAt: now(), note: m.note.trim() || null, sellBy, sellByBasis: sellBy ? m.sellBy!.basis : null,
        sellByExpected: m.sellBy?.basis === 'next_results', soldAt: null, clearedAt: null, clearedReason: null });
      return DONE;
    },
    async clearIneligible(isin, reason) {
      const b = await book(isin);
      const m = markOf(b);
      if (!m) return no('It is not marked ineligible');
      if (!reason.trim()) return no('Clearing the marker needs a short written reason');
      b.marks[b.marks.length - 1] = { ...m, clearedAt: now(), clearedReason: reason.trim() };
      return DONE;
    },
    async confirmSold(isin, d) {
      const b = await book(isin);
      const m = markOf(b);
      if (!m) return no('It is not marked ineligible');
      if (m.soldAt) return no('The sale is already recorded');
      decide(b, { ...d, sold: 'had_to' });
      b.marks[b.marks.length - 1] = { ...m, soldAt: now() };
      return DONE;
    },

    async exportNotes() {
      await book('');
      return { where: 'Downloads in the app — the demo saves nothing', files: 1 + [...books!.values()].filter((b) => b.entries.length || b.labels.length || b.marks.length).length };
    },
    async backups() {
      return [{ day: '2026-11-02', bytes: 8_100_000 }, { day: '2026-10-30', bytes: 7_900_000 }, { day: '2026-10-21', bytes: 7_400_000 }];
    },
    async restore() { throw new Error('The demo has no backups to put back; in the app this restores that day’s copy.'); },
  };
}
