/**
 * The screens without the app: a portfolio computed by `npm run demo` from
 * INVENTED Trading 212 holdings and real public fund contents, replayed in an
 * ordinary browser. Never used inside the app.
 */
import type { Backend } from './backend.ts';
import type { Portfolio, SourceReport } from '../portfolio/refresh.ts';

const files = import.meta.glob<{ default: unknown }>('./demo/*.json');

async function fixture<T>(name: string): Promise<T> {
  const load = files[`./demo/${name}.json`];
  if (!load) throw new Error('No demo data. Run `npm run demo` to generate it.');
  return (await load()).default as T;
}

export function demoBackend(): Backend {
  let key = true;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
  };
}
