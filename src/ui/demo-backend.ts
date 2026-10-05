/**
 * The screens without the app: a portfolio computed by `npm run demo` from
 * INVENTED Trading 212 holdings and real public fund contents, replayed in an
 * ordinary browser. Never used inside the app.
 *
 * Research: Apple and Shell, opened and refreshed by the app's own code from
 * responses the sites gave on 2026-10-05.
 */
import type { Backend } from './backend.ts';
import type { Portfolio, SourceReport } from '../portfolio/refresh.ts';
import type { ReportData, ReportSummary } from '../research/report.ts';
import type { NewsView } from '../research/news.ts';
import type { Instrument } from '../sources/t212.ts';
import { marketOf } from '../research/catalogue.ts';

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
}

const DEMO_ONLY = 'the demo can open Apple and Shell only, the companies whose responses it has saved';

export function demoBackend(): Backend {
  let key = true;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const research = () => fixture<Research>('research');
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

    reports: async () => (await research()).summaries,
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
    async refreshCompany(listingId) {
      await wait(600);
      const report = (await research()).reports[listingId];
      if (!report?.snapshot) return { kind: 'refused', reason: 'nothing saved for this company in the demo', sources: [] };
      return { kind: 'saved', snapshotId: report.snapshot.id, complete: report.snapshot.complete, sources: report.snapshot.sources, newPayloads: 0 };
    },
    loadReport: async (listingId) => (await research()).reports[listingId] ?? null,

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
  };
}
