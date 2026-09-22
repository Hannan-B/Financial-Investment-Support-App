/**
 * Frontend entry point.  Phase 0 — foundation only (§11.5).
 * No research screens, no portfolio: this exists to prove the shell works.
 */
import { invoke } from '@tauri-apps/api/core';
import { migrate, LATEST } from './db/migrate.ts';

const app = document.querySelector<HTMLElement>('#app')!;

interface Check { readonly label: string; run(): Promise<string>; }

const checks: readonly Check[] = [
  {
    label: 'Migration',
    async run() {
      const { from, to } = await migrate();
      return from === to ? `already at schema ${to}` : `applied ${from} → ${to}`;
    },
  },
  {
    label: 'Database',
    async run() {
      const rows = await invoke<Array<Record<string, unknown>>>('db_query', {
        sql: 'SELECT sqlite_version() AS v', params: [],
      });
      return `SQLite ${rows[0]?.['v']}`;
    },
  },
  {
    label: 'Schema',
    async run() {
      const rows = await invoke<Array<Record<string, unknown>>>('db_query', {
        sql: "SELECT count(*) AS n FROM sqlite_master WHERE type='table'", params: [],
      });
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
