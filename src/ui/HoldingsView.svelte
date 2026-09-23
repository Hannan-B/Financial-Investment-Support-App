<script lang="ts">
  /** What you own, as the broker sees it (§6A.3). */
  import type { HoldingRow } from '../portfolio/refresh.ts';
  import { gbp, pct, day } from './format.ts';

  let { holdings, fundDates }: { holdings: readonly HoldingRow[]; fundDates: ReadonlyMap<string, string> } = $props();
  const kind = { etf: 'Fund', equity: 'Share', unknown: 'Not yet known' } as const;
</script>

<table>
  <thead><tr><th>Holding</th><th>Type</th><th>Contents as of</th><th class="num">Value</th><th class="num">Share</th></tr></thead>
  <tbody>
    {#each holdings as h (h.isin)}
      <tr>
        <td>{h.name}<div class="small muted">{h.ticker ?? ''}{h.ticker ? ' · ' : ''}{h.isin}</div></td>
        <td>{kind[h.kind]}</td>
        <td class="muted">
          {#if h.kind === 'equity'}—
          {:else if h.ticker && fundDates.get(h.ticker)}{day(fundDates.get(h.ticker)!)}
          {:else}<span class="bad">cannot be opened</span>{/if}
        </td>
        <td class="num">{gbp(h.value)}</td>
        <td class="num">{pct(h.share)}</td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-weight: 500; color: var(--muted); font-size: 12px; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  td { padding: 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .bad { color: var(--bad); }
</style>
