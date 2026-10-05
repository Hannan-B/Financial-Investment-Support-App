<script lang="ts" generics="T">
  /**
   * One panel of a report (§6.1). Shown, or collapsed to a single line with
   * the reason — never left blank, never hidden. Data from an earlier refresh
   * says so, with its date and what went wrong since.
   */
  import type { Snippet } from 'svelte';
  import type { Panel } from '../research/report.ts';
  import { when } from './format.ts';

  let { title, panel, label, children }: {
    title: string;
    panel: Panel<T>;
    /** A tag beside the title — "Other people's forecasts". */
    label?: string;
    children: Snippet<[T]>;
  } = $props();
</script>

{#if panel.kind === 'collapsed'}
  <section class="panel collapsed">
    <h3>{title}</h3>
    <span class="muted">— {panel.reason}</span>
  </section>
{:else}
  <section class="panel">
    <h3>{title}{#if label}<span class="label">{label}</span>{/if}</h3>
    {#if panel.stale}
      <p class="stale small">From the refresh of {when(panel.stale.capturedAt)}. The latest one could not read it ({panel.stale.why}).</p>
    {/if}
    {@render children(panel.data)}
  </section>
{/if}

<style>
  .panel { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; margin-bottom: 14px; }
  .collapsed { display: flex; gap: 8px; align-items: baseline; padding: 10px 16px; }
  h3 { font-size: 14px; margin-bottom: 8px; display: flex; gap: 8px; align-items: baseline; }
  .collapsed h3 { margin: 0; }
  .label { font-size: 11px; font-weight: 500; color: var(--warn); background: var(--warn-soft); padding: 1px 6px; border-radius: 4px; }
  .stale { color: var(--warn); background: var(--warn-soft); padding: 4px 8px; border-radius: 4px; margin: 0 0 8px; }
</style>
