import type { Backend, PersistentFailure, DailyCopy } from './backend.ts';
import { TauriDb } from '../db/tauri.ts';
import { migrate } from '../db/migrate.ts';
import { MIGRATIONS } from '../db/migrations.ts';
import { TauriTransport, TauriDiagnostics, T212Transport, tauriTools, t212Key } from '../fetch/tauri.ts';
import { refresh, loadPortfolio } from '../portfolio/refresh.ts';
import { classifyMissing, type Company } from '../classify/lookup.ts';
import { ensureCatalogue, searchCatalogue } from '../research/catalogue.ts';
import { openCompany, openToReview } from '../research/open.ts';
import { refreshCompany } from '../research/company.ts';
import { loadReport, listReports } from '../research/report.ts';
import { loadHistoryFacts, loadChoices, saveChoices, knownFigures } from '../research/history.ts';
import { loadNews, markViewed, markOpened, hideStory, choosePublisher, setAliases } from '../research/news.ts';
import * as notes from '../notes/store.ts';
import { buildExport } from '../notes/export.ts';
import { invoke } from '@tauri-apps/api/core';

/** The Mac's own date, '2026-11-02': a day of use is a local day, not a UTC one. */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function tauriBackend(): Backend {
  const db = new TauriDb();
  const diagnostics = new TauriDiagnostics();
  const web = new TauriTransport();
  const research = { db, diagnostics, transport: web };
  const catalogue = (force = false) => ensureCatalogue({ db, diagnostics, t212: new T212Transport() }, force);
  const isinOf = async (listingId: number) => {
    const [row] = await db.query('SELECT isin FROM listing WHERE id = ?', [listingId]);
    if (!row) throw new Error(`no listing ${listingId}`);
    return String(row['isin']);
  };

  return {
    demo: false,
    async start() {
      // The day's copy first, as the data stood before anything changes (§11.8 step 3.6).
      await invoke('db_daily_backup', { today: localDay(new Date()) });
      await migrate(db, MIGRATIONS);
    },
    keySaved: t212Key.saved,
    saveKey: t212Key.save,
    removeKey: t212Key.remove,
    load: () => loadPortfolio(db),
    refresh: () => refresh({ db, diagnostics, web, t212: new T212Transport(), tools: tauriTools }),

    async classify(onProgress) {
      const p = await loadPortfolio(db);
      if (p.result.breakdowns.kind !== 'ok') return { found: 0, notFound: 0 };
      const companies: Company[] = p.result.breakdowns.companies.flatMap((c) =>
        c.isins.map((isin) => ({ isin, name: c.name, weight: c.total.amount })));
      return classifyMissing(companies, { db, diagnostics, transport: web }, { onProgress });
    },

    async persistentFailures(): Promise<PersistentFailure[]> {
      const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const rows = await db.query(
        `SELECT source, failing_since, consecutive_failures, last_failure FROM source_health
         WHERE failing_since IS NOT NULL AND failing_since < ? ORDER BY failing_since`,
        [weekAgo],
      );
      return rows.map((r) => ({
        source: String(r['source']),
        since: String(r['failing_since']),
        failures: Number(r['consecutive_failures']),
        last: String(r['last_failure'] ?? ''),
      }));
    },

    reports: () => listReports(db),
    async searchCompanies(query) {
      const ready = await catalogue();
      return { hits: await searchCatalogue(db, query), note: ready.ok ? null : ready.reason };
    },
    async openCompany(t212Ticker) {
      return openCompany(t212Ticker, research);
    },
    async openHolding(isin) {
      const find = async () => (await db.query("SELECT t212_ticker FROM instrument WHERE isin = ? AND type = 'STOCK'", [isin]))[0];
      let row = await find();
      if (!row) {
        const ready = await catalogue(true);
        if (!ready.ok) return { kind: 'refused', reason: ready.reason };
        row = await find();
      }
      return row ? openCompany(String(row['t212_ticker']), research) : { kind: 'refused', reason: `${isin} is not a share in Trading 212's list` };
    },
    refreshCompany: (listingId, onStep) => refreshCompany(listingId, research, onStep),
    loadReport: (listingId) => loadReport(db, listingId),

    history: (isin) => loadHistoryFacts(db, isin),
    historyChoices: (isin) => loadChoices(db, isin),
    saveHistoryChoices: (isin, c) => saveChoices(db, isin, c),
    knownFigures: () => knownFigures(db),

    news: async (listingId, window) => loadNews(db, await isinOf(listingId), new Date(), window),
    newsSeen: async (listingId) => markViewed(db, await isinOf(listingId), new Date()),
    async openLink(url, listingId) {
      await invoke('open_link', { url });
      if (listingId !== undefined) await markOpened(db, await isinOf(listingId), url, new Date());
    },
    hideStory: async (listingId, url) => hideStory(db, await isinOf(listingId), url, new Date()),
    choosePublisher: (host, shown) => choosePublisher(db, host, shown),
    setAliases: async (listingId, aliases) => setAliases(db, await isinOf(listingId), aliases),

    async notes(isin) {
      return { entries: await notes.loadEntries(db, isin), label: await notes.labelOf(db, isin), mark: (await notes.currentMarks(db)).get(isin) ?? null };
    },
    addNote: (isin, entry) => notes.addEntry(db, isin, entry, new Date()),
    editNote: (id, body) => notes.editEntry(db, id, body, new Date()),
    deleteNote: (id) => notes.deleteEntry(db, id, new Date()),
    completeReview: (isin, d) => notes.completeReview(db, isin, d, new Date()),
    setLabel: (isin, label) => notes.setLabel(db, isin, label, new Date()),
    openToReview: (t212Ticker) => openToReview(t212Ticker, research),
    marks: () => notes.currentMarks(db),
    nextResults: (isin) => notes.nextResults(db, isin, new Date().toISOString().slice(0, 10)),
    markIneligible: (isin, m) => notes.markIneligible(db, isin, m, new Date()),
    clearIneligible: (isin, reason) => notes.clearIneligible(db, isin, reason, new Date()),
    confirmSold: (isin, d) => notes.confirmSold(db, isin, d, new Date()),

    async exportNotes() {
      const out = await buildExport(db, new Date());
      const where = await invoke<string>('export_save', { folder: out.folder, files: out.files });
      return { where, files: out.files.length };
    },
    backups: () => invoke<DailyCopy[]>('db_backups'),
    async restore(day) { await invoke('db_restore', { day }); },
  };
}
