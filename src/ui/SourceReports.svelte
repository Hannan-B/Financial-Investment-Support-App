<script lang="ts">
  /**
   * What the last refresh did, source by source (§10.1). Problems first and
   * in words; the rest folded away.
   */
  import type { SourceReport } from '../portfolio/refresh.ts';
  import type { PersistentFailure } from './backend.ts';
  import { day } from './format.ts';

  let { reports, persistent }: { reports: readonly SourceReport[]; persistent: readonly PersistentFailure[] } = $props();
  const problems = $derived(reports.filter((r) => r.kind === 'unavailable' || r.kind === 'suspect'));
  const fine = $derived(reports.filter((r) => r.kind === 'ok' || r.kind === 'fresh'));
</script>

{#each persistent as p (p.source)}
  <div class="banner bad">
    <strong>{p.source} has been failing since {day(p.since)}</strong> — {p.failures} refreshes in a row.
    Nothing from it is being recorded. <span class="small">Last: {p.last}</span>
  </div>
{/each}

{#if problems.length > 0}
  <div class="banner warn">
    {#each problems as r (r.label)}
      <div>
        <strong>{r.label}</strong> —
        {r.kind === 'suspect' ? 'data rejected' : 'not available'}{r.detail ? `: ${r.detail}` : ''}.
        {r.kind === 'suspect' ? 'Showing the last good data.' : ''}
      </div>
    {/each}
  </div>
{/if}

{#if fine.length > 0}
  <details class="small muted">
    <summary>{fine.length} sources refreshed{problems.length ? '' : ' without problems'}</summary>
    <ul>
      {#each fine as r (r.label)}<li>{r.label}: {r.kind === 'fresh' ? 'already fetched today' : r.detail ?? 'ok'}</li>{/each}
    </ul>
  </details>
{/if}

<style>
  .banner { border-radius: 8px; padding: 10px 14px; margin-bottom: 10px; }
  .warn { background: var(--warn-soft); color: var(--warn); }
  .bad { background: var(--bad-soft); color: var(--bad); }
  details { margin-bottom: 10px; }
  ul { margin: 6px 0 0; padding-left: 18px; }
</style>
