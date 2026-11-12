/**
 * Refresh all Watching: one company after another.  PROJECT-PLAN.md §11.9 step 4.5
 *
 * Only when he presses the button — nothing refreshes on its own. One at a
 * time, so each site keeps its usual pace. A company that fails is reported
 * and the rest still refresh: one site down must not cost him the others.
 */
import type { CompanyRefresh, OnStep } from './company.ts';
import type { ReportSummary } from './report.ts';

export interface Target { readonly listingId: number; readonly name: string; }

/** The companies he has labelled Watching, in the list's order. */
export const watching = (reports: readonly ReportSummary[]): Target[] =>
  reports.filter((r) => r.label === 'watching').map((r) => ({ listingId: r.listingId, name: r.name }));

export interface Result {
  readonly listingId: number;
  readonly name: string;
  /** saved: a snapshot was kept (complete or not) · refused: a source answered wrongly · failed: it could not run. */
  readonly kind: 'saved' | 'refused' | 'failed';
  readonly complete: boolean;
  /** What went wrong, or which sources did not answer. */
  readonly detail: string | null;
}

export interface Progress {
  /** Before each company: how many are done, of how many. */
  company(done: number, total: number, now: Target): void;
  step: OnStep;
  finished(result: Result): void;
}

export async function refreshEach(
  targets: readonly Target[],
  refreshOne: (listingId: number, onStep: OnStep) => Promise<CompanyRefresh>,
  progress: Progress,
): Promise<Result[]> {
  const results: Result[] = [];
  for (const [i, t] of targets.entries()) {
    progress.company(i, targets.length, t);
    let result: Result;
    try {
      const r = await refreshOne(t.listingId, progress.step);
      const missing = r.sources.filter((s) => s.outcome === 'unavailable' || s.outcome === 'suspect').map((s) => s.source);
      result = r.kind === 'saved'
        ? { ...t, kind: 'saved', complete: r.complete, detail: missing.length ? `did not answer: ${missing.join(', ')}` : null }
        : { ...t, kind: 'refused', complete: false, detail: r.reason };
    } catch (e) {
      result = { ...t, kind: 'failed', complete: false, detail: e instanceof Error ? e.message : String(e) };
    }
    results.push(result);
    progress.finished(result);
  }
  return results;
}
