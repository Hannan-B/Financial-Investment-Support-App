/**
 * Everything the screens can ask for. Two implementations: the real app
 * (Rust, network, keychain) and a demo that replays a saved portfolio, so the
 * screens can be looked at in an ordinary browser.
 */
import type { Portfolio, SourceReport } from '../portfolio/refresh.ts';
import type { ClassifySummary } from '../classify/lookup.ts';

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
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
