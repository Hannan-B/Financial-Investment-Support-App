import type { Backend, PersistentFailure } from './backend.ts';
import { TauriDb } from '../db/tauri.ts';
import { migrate } from '../db/migrate.ts';
import { MIGRATIONS } from '../db/migrations.ts';
import { TauriTransport, TauriDiagnostics, T212Transport, tauriTools, t212Key } from '../fetch/tauri.ts';
import { refresh, loadPortfolio } from '../portfolio/refresh.ts';
import { classifyMissing, type Company } from '../classify/lookup.ts';

export function tauriBackend(): Backend {
  const db = new TauriDb();
  const diagnostics = new TauriDiagnostics();
  const web = new TauriTransport();

  return {
    demo: false,
    async start() { await migrate(db, MIGRATIONS); },
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
  };
}
