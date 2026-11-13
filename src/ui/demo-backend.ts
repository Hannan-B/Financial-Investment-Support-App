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
import type { DividendHistory, Payment } from '../portfolio/income.ts';
import { isaYear } from '../portfolio/income.ts';
import { owedOn, type Purification, type Item, type Change, type Counted } from '../portfolio/purify.ts';
import type { RatesOutcome } from '../portfolio/fx.ts';
import type { LookthroughInput } from '../portfolio/lookthrough.ts';
import { buyPlanFrom, sellPlanFrom, type PlanCompany, type PlanHolding, type PlanIncome, type SavedPlan } from '../portfolio/plan.ts';

/** Income and planning, built by `npm run demo` with the app's own code from INVENTED Trading 212 history. */
interface Income {
  readonly dividends: DividendHistory;
  readonly purification: Omit<Purification, 'notYetCounted'> & { readonly notYetCounted: [string, Counted[]][] };
  readonly rates: RatesOutcome | (Omit<Extract<RatesOutcome, { kind: 'ok' }>, 'perPound'> & { perPound: [string, number][] });
  readonly planning: {
    readonly input: { positions: LookthroughInput['positions']; contents: [string, any][]; classifications: [string, any][] };
    readonly companies: Readonly<Record<string, PlanCompany>>;
    readonly holdings: readonly PlanHolding[];
    readonly incomes: Readonly<Record<string, PlanIncome>>;
  };
}

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
  // ── income and planning, in memory ──
  let income: Promise<{ data: Income; items: Item[]; usual: number | null; plans: SavedPlan[] }> | null = null;
  const incomeState = () => (income ??= fixture<Income>('income').then((data) => ({
    data, items: structuredClone([...data.purification.items]) as Item[], usual: data.purification.usualRate, plans: [] as SavedPlan[],
  })));
  const ratesOf = (r: Income['rates']): RatesOutcome => (r.kind === 'ok' ? { ...r, perPound: new Map(r.perPound as [string, number][]) } : r);
  const inputOf = (i: Income['planning']['input']): LookthroughInput => ({ positions: i.positions, contents: new Map(i.contents), classifications: new Map(i.classifications) });
  const OK: Change = { kind: 'done' };
  const refuse = (reason: string): Change => ({ kind: 'refused', reason });
  async function purificationNow(): Promise<Purification> {
    const s = await incomeState();
    s.items = s.items.map((i) => (i.settled ? i : { ...i, owed: owedOn(i.ratePct, { profit: i.profit, dividends: i.dividends, amount: i.amount }) }));
    const open = s.items.filter((i) => !i.settled);
    return {
      usualRate: s.usual, items: [...s.items].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id),
      outstanding: Math.round(open.reduce((n, i) => n + (i.owed ?? 0), 0) * 100) / 100,
      incomplete: open.filter((i) => i.owed === null).length,
      notYetCounted: new Map(s.data.purification.notYetCounted),
    };
  }
  async function item(id: number, edit: (i: Item) => Item | Change): Promise<Change> {
    const s = await incomeState();
    const at = s.items.findIndex((i) => i.id === id);
    if (at < 0) return refuse('That item no longer exists');
    if (s.items[at]!.settled) return refuse('It is settled: what was owed is kept as it was');
    const next = edit(s.items[at]!);
    if ('kind' in next && (next.kind === 'done' || next.kind === 'refused') && !('id' in next)) return next as Change;
    s.items[at] = next as Item;
    return OK;
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

    async dividends(isin) {
      const all = (await incomeState()).data.dividends;
      if (!isin) return all;
      const payments: Payment[] = all.payments.filter((p) => p.isin === isin);
      const years = new Map<string, { label: string; span: string; start: string; pounds: number; payments: number }>();
      for (const p of payments) {
        const y = isaYear(p.paidOn);
        const acc = years.get(y.label) ?? { ...y, pounds: 0, payments: 0 };
        acc.pounds += p.pounds; acc.payments++;
        years.set(y.label, acc);
      }
      return { payments, years: [...years.values()].sort((a, b) => b.start.localeCompare(a.start)), total: payments.reduce((n, p) => n + p.pounds, 0), last: all.last };
    },
    purification: purificationNow,
    async setUsualRate(pct) { (await incomeState()).usual = pct; },
    setItemRate: (id, pct) => item(id, (i) => (pct !== null && !(pct >= 0 && pct <= 100) ? refuse('A rate is a percentage from 0 to 100') : { ...i, ratePct: pct })),
    async fillMissingRates() {
      const s = await incomeState();
      if (s.usual === null) return refuse('Set your usual rate first');
      s.items = s.items.map((i) => (i.ratePct === null && !i.settled ? { ...i, ratePct: s.usual } : i));
      return OK;
    },
    setTypedProfit: (id, pounds) => item(id, (i) => (i.kind !== 'sale' ? refuse('Only a sale has a profit')
      : { ...i, profit: pounds === null ? { kind: 'unknown', reason: 'typed profit taken back' } : { kind: 'typed', pounds } })),
    async addPurificationItem(m) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date)) return refuse('Choose the date it was paid');
      if (!m.description.trim()) return refuse('Say what it was, e.g. "Interest on cash"');
      if (!(m.pounds > 0)) return refuse('Type the amount in pounds');
      (await incomeState()).items.push({ id: nextId++, kind: 'manual', isin: null, date: m.date, description: m.description.trim(), ratePct: m.ratePct,
        profit: null, sold: null, amount: m.pounds, dividends: [], owed: null, settled: null });
      return OK;
    },
    async deletePurificationItem(id) {
      const s = await incomeState();
      const i = s.items.find((x) => x.id === id);
      if (!i || i.kind !== 'manual' || i.settled) return refuse('Only an unsettled item typed by hand can be taken back');
      s.items = s.items.filter((x) => x.id !== id);
      return OK;
    },
    async settle(ids, paidOn) {
      if (!ids.length) return refuse('Tick the items you have paid');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) return refuse('Choose the date you paid');
      const p = await purificationNow();
      const chosen = p.items.filter((i) => ids.includes(i.id));
      const bad = chosen.find((i) => i.settled || i.owed === null);
      if (bad) return refuse(`“${bad.description}” ${bad.settled ? 'is already settled' : 'has no amount yet — give it a rate first'}`);
      const s = await incomeState();
      s.items = s.items.map((i) => (ids.includes(i.id) ? { ...i, settled: { on: paidOn, amount: i.owed! } } : i));
      return OK;
    },
    poundRates: async () => ratesOf((await incomeState()).data.rates),
    async planBuy(isin, amounts) {
      const { data } = await incomeState();
      const company = data.planning.companies[isin];
      if (!company) return { kind: 'refused', reason: DEMO_ONLY };
      return buyPlanFrom(inputOf(data.planning.input), company, amounts, ratesOf(data.rates));
    },
    async planSell(isin, price, units) {
      const s = await incomeState();
      const h = s.data.planning.holdings.find((x) => x.isin === isin);
      if (!h) return { kind: 'refused', reason: 'Not held at the last refresh' };
      const inc = s.data.planning.incomes[isin] ?? { ratePct: null, dividends: [] };
      return sellPlanFrom(h, price, units, ratesOf(s.data.rates), { ...inc, ratePct: s.usual });
    },
    async savePlan(p) { (await incomeState()).plans.unshift({ id: nextId++, createdAt: now(), ...p }); },
    async plans(isin) { return (await incomeState()).plans.filter((p) => !isin || p.isin === isin); },
    async saveAim(isin, value, body) {
      return this.addNote(isin, { kind: 'comment', tab: 'plan', target: { key: 'plan:aim', label: 'My aim', value }, snapshotId: null, body });
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
