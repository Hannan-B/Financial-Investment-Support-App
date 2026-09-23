/**
 * Frontend entry point.  Phase 0 — foundation only (§11.5).
 * No research screens, no portfolio: this exists to prove the shell works.
 */
import { migrate } from './db/migrate.ts';
import { MIGRATIONS, LATEST } from './db/migrations.ts';
import { TauriDb } from './db/tauri.ts';

const db = new TauriDb();
const app = document.querySelector<HTMLElement>('#app')!;

interface Check { readonly label: string; run(): Promise<string>; }

const checks: readonly Check[] = [
  {
    label: 'Migration',
    async run() {
      const { from, to } = await migrate(db, MIGRATIONS);
      return from === to ? `already at schema ${to}` : `applied ${from} → ${to}`;
    },
  },
  {
    label: 'Database',
    async run() {
      const rows = await db.query('SELECT sqlite_version() AS v');
      return `SQLite ${rows[0]?.['v']}`;
    },
  },
  {
    label: 'Schema',
    async run() {
      const rows = await db.query("SELECT count(*) AS n FROM sqlite_master WHERE type='table'");
      const n = Number(rows[0]?.['n'] ?? 0);
      return `${n} tables, schema v${LATEST}`;
    },
  },
];

async function render(): Promise<void> {
  app.innerHTML = `<h1>Investment Tracker</h1><p class="sub">Phase 0 — foundation</p><ul id="checks"></ul>`;
  const list = app.querySelector('#checks')!;
  for (const check of checks) {
    const li = document.createElement('li');
    li.textContent = `${check.label}: checking…`;
    list.append(li);
    try {
      li.innerHTML = `<span class="ok">✓</span> ${check.label}: ${await check.run()}`;
    } catch (e) {
      li.innerHTML = `<span class="bad">✗</span> ${check.label}: ${e}`;
    }
  }
}

void render();
