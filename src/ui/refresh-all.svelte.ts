/**
 * Refresh all Watching, as the screens see it (§11.9 step 4.5). It lives
 * outside any one screen, so it carries on while he opens other companies,
 * and the progress shows wherever he is.
 */
import type { Backend } from './backend.ts';
import { refreshEach, watching, type Result, type Target } from '../research/refresh-all.ts';

class RefreshAll {
  running = $state(false);
  /** Companies done, of how many, and which is being refreshed. */
  done = $state(0);
  total = $state(0);
  current = $state<string | null>(null);
  /** Stages done within the current company, of how many, and which. */
  step = $state<{ done: number; total: number; what: string } | null>(null);
  results = $state<Result[]>([]);
  /** When each company's refresh finished: an open report offers the newer figures, never swaps them in. */
  finished = $state<Record<number, string>>({});

  async start(backend: Backend): Promise<void> {
    if (this.running) return;
    const targets: Target[] = watching(await backend.reports());
    if (!targets.length) return;
    this.running = true;
    this.results = [];
    this.done = 0;
    this.total = targets.length;
    try {
      await refreshEach(targets, (id, onStep) => backend.refreshCompany(id, onStep), {
        company: (done, _total, t) => { this.done = done; this.current = t.name; this.step = null; },
        step: (done, total, what) => { this.step = { done, total, what }; },
        finished: (r) => {
          this.results = [...this.results, r];
          this.done = this.results.length;
          if (r.kind === 'saved') this.finished = { ...this.finished, [r.listingId]: new Date().toISOString() };
        },
      });
    } finally {
      this.running = false;
      this.current = null;
      this.step = null;
    }
  }

  dismiss(): void {
    if (!this.running) this.results = [];
  }
}

export const refreshAll = new RefreshAll();
