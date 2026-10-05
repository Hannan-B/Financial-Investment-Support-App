/**
 * Everything the screens can ask for. Two implementations: the real app
 * (Rust, network, keychain) and a demo that replays a saved portfolio, so the
 * screens can be looked at in an ordinary browser.
 */
import type { Portfolio, SourceReport } from '../portfolio/refresh.ts';
import type { ClassifySummary } from '../classify/lookup.ts';
import type { CatalogueHit } from '../research/catalogue.ts';
import type { Opened } from '../research/open.ts';
import type { CompanyRefresh } from '../research/company.ts';
import type { ReportData, ReportSummary } from '../research/report.ts';
import type { NewsView } from '../research/news.ts';

export interface PersistentFailure {
  readonly source: string;
  readonly since: string;
  readonly failures: number;
  readonly last: string;
}

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
  refreshCompany(listingId: number): Promise<CompanyRefresh>;
  loadReport(listingId: number): Promise<ReportData | null>;

  // ── news (§6.6) ──
  news(listingId: number, window: 'default' | 'last-180-days'): Promise<NewsView>;
  /** The news has been looked at: what arrives after now will be "new". */
  newsSeen(listingId: number): Promise<void>;
  /** Opens a link in the user's own browser; a headline is also marked as opened. */
  openLink(url: string, listingId?: number): Promise<void>;
  hideStory(listingId: number, url: string): Promise<void>;
  choosePublisher(host: string, shown: boolean): Promise<void>;
  setAliases(listingId: number, aliases: readonly string[]): Promise<void>;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
