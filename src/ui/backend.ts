/**
 * Everything the screens can ask for. Two implementations: the real app
 * (Rust, network, keychain) and a demo that replays a saved portfolio, so the
 * screens can be looked at in an ordinary browser.
 */
import type { Portfolio, SourceReport } from '../portfolio/refresh.ts';
import type { ClassifySummary } from '../classify/lookup.ts';
import type { CatalogueHit } from '../research/catalogue.ts';
import type { Opened } from '../research/open.ts';
import type { CompanyRefresh, OnStep } from '../research/company.ts';
import type { HistoryFacts, Choices } from '../research/history.ts';
import type { ReportData, ReportSummary } from '../research/report.ts';
import type { NewsView } from '../research/news.ts';
import type { Entry, Label } from '../notes/document.ts';
import type { NewEntry, Decision, Mark, SellBy, Done, Refused } from '../notes/store.ts';

export interface PersistentFailure {
  readonly source: string;
  readonly since: string;
  readonly failures: number;
  readonly last: string;
}

/** One company's notes document, its label and its ineligible marker (§11.8). */
export interface NotesData {
  readonly entries: readonly Entry[];
  readonly label: Label;
  readonly mark: Mark | null;
}

/** A daily copy of the app's data (§11.8 step 3.6). */
export interface DailyCopy { readonly day: string; readonly bytes: number; }

export interface Backend {
  readonly demo: boolean;
  /** Brings the database up to date. Fails loudly if it cannot. */
  start(): Promise<void>;
  keySaved(): Promise<boolean>;
  saveKey(key: string, secret: string): Promise<void>;
  removeKey(): Promise<void>;
  load(): Promise<Portfolio>;
  refresh(): Promise<readonly SourceReport[]>;
  /** Looks up unclassified companies, largest first. Minutes, not seconds. */
  classify(onProgress: (done: number, total: number) => void): Promise<ClassifySummary>;
  /** Sources failing for a week or more — a hole in the history (§10.1). */
  persistentFailures(): Promise<readonly PersistentFailure[]>;

  // ── research (§6.1, §7.2) ──
  /** Companies opened for research, most recently refreshed first. */
  reports(): Promise<readonly ReportSummary[]>;
  /** Searches Trading 212's list of shares, fetching it first if missing or a month old. */
  searchCompanies(query: string): Promise<{ readonly hits: readonly CatalogueHit[]; readonly note: string | null }>;
  /** Opens a company chosen from the list: confirms its identity and fetches its prices. */
  openCompany(t212Ticker: string): Promise<Opened>;
  /** Opens a share already held, by its ISIN. */
  openHolding(isin: string): Promise<Opened>;
  /** `onStep` follows the refresh through its stages, for a progress bar. */
  refreshCompany(listingId: number, onStep?: OnStep): Promise<CompanyRefresh>;
  loadReport(listingId: number): Promise<ReportData | null>;

  // ── the History tab (§11.9 steps 4.1–4.3) ──
  /** Every refresh of the company and every figure each one saved. */
  history(isin: string): Promise<HistoryFacts>;
  historyChoices(isin: string): Promise<Choices>;
  saveHistoryChoices(isin: string, choices: Choices): Promise<void>;
  /** Every figure any refresh has saved, for any company: what the figures window offers. */
  knownFigures(): Promise<readonly string[]>;

  // ── news (§6.6) ──
  news(listingId: number, window: 'default' | 'last-180-days'): Promise<NewsView>;
  /** The news has been looked at: what arrives after now will be "new". */
  newsSeen(listingId: number): Promise<void>;
  /** Opens a link in the user's own browser; a headline is also marked as opened. */
  openLink(url: string, listingId?: number): Promise<void>;
  hideStory(listingId: number, url: string): Promise<void>;
  choosePublisher(host: string, shown: boolean): Promise<void>;
  setAliases(listingId: number, aliases: readonly string[]): Promise<void>;

  // ── notes, labels, decisions, the ineligible marker (§11.8) ──
  notes(isin: string): Promise<NotesData>;
  addNote(isin: string, entry: NewEntry): Promise<Done | Refused>;
  editNote(id: number, body: string): Promise<Done | Refused>;
  deleteNote(id: number): Promise<Done | Refused>;
  completeReview(isin: string, decision: Decision): Promise<Done | Refused>;
  setLabel(isin: string, label: Label): Promise<void>;
  /** "To review" on a search result: Open's identity checks, then the label; the page is not opened. */
  openToReview(t212Ticker: string): Promise<Opened>;
  /** The current marker on each holding that has one. */
  marks(): Promise<ReadonlyMap<string, Mark>>;
  nextResults(isin: string): Promise<{ readonly date: string } | { readonly reason: string }>;
  markIneligible(isin: string, mark: { readonly sellBy: SellBy | null; readonly note: string }): Promise<Done | Refused>;
  clearIneligible(isin: string, reason: string): Promise<Done | Refused>;
  confirmSold(isin: string, decision: Omit<Decision, 'sold'>): Promise<Done | Refused>;

  // ── export and backups (§12.2, §11.8 step 3.6) ──
  /** Writes every note to Markdown files in a new folder in Downloads; says where. */
  exportNotes(): Promise<{ readonly where: string; readonly files: number }>;
  /** The daily copies, newest first. */
  backups(): Promise<readonly DailyCopy[]>;
  /** Puts a day's copy back, setting the current data aside first. The screens reload after. */
  restore(day: string): Promise<void>;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
