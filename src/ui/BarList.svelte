<script lang="ts">
  /** Industries and countries: label, bar, share, value. Facts only — no judgement (§6A.1). */
  import type { Money } from '../lib/money.ts';
  import { gbp, pct } from './format.ts';

  interface Item { readonly label: string; readonly value: Money<'GBP'>; readonly share: number; readonly muted?: boolean; readonly note?: string; }
  let { items }: { items: readonly Item[] } = $props();
  const max = $derived(Math.max(...items.map((i) => i.share), 0.0001));
</script>

<table>
  <tbody>
    {#each items as item (item.label)}
      <tr class:muted={item.muted}>
        <td class="label">
          {item.label}
          {#if item.note}<div class="small muted">{item.note}</div>{/if}
        </td>
        <td class="bar"><span style:width="{(item.share / max) * 100}%" class:grey={item.muted}></span></td>
        <td class="num">{pct(item.share)}</td>
        <td class="num muted">{gbp(item.value, true)}</td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
  table { width: 100%; border-collapse: collapse; }
  td { padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  .label { width: 34%; }
  .bar { width: 46%; }
  .bar span { display: block; height: 10px; border-radius: 3px; background: var(--bar); min-width: 1px; }
  .bar span.grey { background: var(--bar-muted); }
  tr.muted .label { color: var(--muted); font-style: italic; }
</style>
