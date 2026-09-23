import type { HttpResponse } from './types.ts';

/**
 * What the app keeps so a broken source can be fixed.  PROJECT-PLAN.md §10.8
 *
 *   ① the last good response per source — the one thing that cannot be
 *      re-fetched once the website changes
 *   ② a failure log FILE, so an agent reads it directly
 *
 * Plus `last-failed`: the most recent response that failed validation, to
 * diff against the last good one.
 *
 * Both live in the app's data directory, outside the repository (§12.3) —
 * a Trading 212 response contains real holdings.
 */
export interface Diagnostics {
  /** Replaces the kept copy. Returns where it was written. */
  saveResponse(source: string, which: 'last-good' | 'last-failed', response: HttpResponse): Promise<string>;
  appendLog(entry: FailureLogEntry): Promise<void>;
}

/**
 * One line of the failure log.  §10.1: which source, which check, the actual
 * value, when — enough to be meaningful months later.
 *
 * ⚠️ Never includes request headers: they can carry API keys.
 */
export interface FailureLogEntry {
  readonly at: string;
  readonly source: string;
  readonly key: string;
  readonly url: string;
  readonly kind: 'unavailable' | 'suspect';
  readonly status?: number;
  readonly reason?: string;
  readonly check?: string;
  readonly expected?: string;
  readonly observed?: string;
  /** The saved response, when there was one worth keeping. */
  readonly response?: string;
}

/** File extension for a kept response, from what the server said it sent. */
export function extensionFor(contentType: string): string {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (type.endsWith('json')) return 'json';
  if (type === 'text/csv') return 'csv';
  if (type === 'text/html') return 'html';
  if (type.startsWith('text/')) return 'txt';
  if (type === 'application/vnd.ms-excel') return 'xls';
  if (type.includes('spreadsheetml')) return 'xlsx';
  return 'bin';
}
