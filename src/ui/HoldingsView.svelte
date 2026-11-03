<script lang="ts">
  /**
   * What you own, as the broker sees it (§6A.3). A holding marked ineligible
   * says so, plainly, wherever it appears (§8.4); right-click a holding to
   * mark it (§11.8 step 3.5).
   */
  import type { Backend } from './backend.ts';
  import type { HoldingRow } from '../portfolio/refresh.ts';
  import type { Mark } from '../notes/store.ts';
  import type { Label } from '../notes/document.ts';
  import { gbp, pct, day } from './format.ts';
  import ContextMenu from './ContextMenu.svelte';
  import IneligibleMarker from './IneligibleMarker.svelte';

  let { backend, holdings, fundDates, onOpen }: {
    backend: Backend;
    holdings: readonly HoldingRow[];
    fundDates: ReadonlyMap<string, string>;
    /** Opens a held share's research report. */
    onOpen?: (isin: string) => void;
  } = $props();
  const kind = { etf: 'Fund', equity: 'Share', unknown: 'Not yet known' } as const;

  let marks = $state<ReadonlyMap<string, Mark>>(new Map());
  let labels = $state<ReadonlyMap<string, Label>>(new Map());
  let marking = $state<string | null>(null);
  let menu = $state<{ x: number; y: number; isin: string; name: string } | null>(null);
  async function load() {
    marks = await backend.marks();
    labels = new Map(await Promise.all([...marks.keys()].map(async (isin) => [isin, (await backend.notes(isin)).label] as const)));
  }
  $effect(() => { void holdings; void load(); });
  const menuItems = (isin: string, name: string) => [{ label: `Mark ${name} as ineligible…`, run: () => (marking = isin) }];
</script>

<table>
  <thead><tr><th>Holding</th><th>Type</th><th>Contents as of</th><th class="num">Value</th><th class="num">Share</th></tr></thead>
  <tbody>
    {#each holdings as h (h.isin)}
      <tr oncontextmenu={(e) => { if (marks.get(h.isin)?.soldAt === null) return; e.preventDefault(); menu = { x: e.clientX, y: e.clientY, isin: h.isin, name: h.name }; }}>
        <td>
          {h.name}<div class="small muted">{h.ticker ?? ''}{h.ticker ? ' · ' : ''}{h.isin}{#if h.kind === 'equity' && onOpen} · <button class="link" onclick={() => onOpen(h.isin)}>Open report</button>{/if}</div>
          {#if marks.has(h.isin) || marking === h.isin}
            <IneligibleMarker {backend} isin={h.isin} mark={marks.get(h.isin) ?? null} label={labels.get(h.isin) ?? 'none'}
              bind:marking={() => marking === h.isin, (v) => (marking = v ? h.isin : null)} onChanged={load} />
          {/if}
        </td>
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
<p class="small muted hint">Right-click a holding to mark it as no longer eligible to hold.</p>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} onClose={() => (menu = null)} items={menuItems(menu.isin, menu.name)} />
{/if}

<style>
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-weight: 500; color: var(--muted); font-size: 12px; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  td { padding: 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .bad { color: var(--bad); }
  .hint { margin: 8px 0 0; }
  .link { border: 0; background: none; color: var(--accent); text-decoration: underline; padding: 0; font: inherit; }
</style>
