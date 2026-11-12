<script lang="ts">
  /**
   * Industries: the twelve sectors, each opening to its industries in pounds
   * (§11.9 step 4.4). Two levels, stockanalysis's own words for the second.
   * A sector's industries add up to it; the sector totals never move.
   */
  import type { Bucket, IndustryBucket, SectorKey } from '../portfolio/lookthrough.ts';
  import { UNCLASSIFIED } from '../portfolio/lookthrough.ts';
  import { NOT_FOUND, NOT_LOOKED_UP } from '../categories/industries.ts';
  import { gbp, pct } from './format.ts';

  let { sectors, industries }: {
    sectors: readonly Bucket<SectorKey>[];
    industries: Readonly<Record<string, readonly IndustryBucket[]>>;
  } = $props();

  let open = $state(new Set<string>());
  const toggle = (k: string) => (open = new Set(open.has(k) ? [...open].filter((x) => x !== k) : [...open, k]));
  const max = $derived(Math.max(...sectors.map((s) => s.share), 0.0001));
  const waiting = (k: string) => k === NOT_LOOKED_UP || k === NOT_FOUND;
  /** Industries largest first; the companies still without one at the end, however large. */
  const ordered = (list: readonly IndustryBucket[]) => [...list.filter((i) => !waiting(i.key)), ...list.filter((i) => waiting(i.key))];
  const elsewhere = (i: IndustryBucket) => i.elsewhere.length === 1
    ? `stockanalysis puts ${i.elsewhere[0]!.name} under ${i.elsewhere[0]!.sector}; it is counted where its fund puts it`
    : `stockanalysis puts ${i.elsewhere.length} of these under another sector (${[...new Set(i.elsewhere.map((e) => e.sector))].join(', ')}); they are counted where their funds put them`;
</script>

<table>
  <tbody>
    {#each sectors as s (s.key)}
      {@const inside = industries[s.key]}
      {@const muted = s.key === UNCLASSIFIED || s.key === 'Cash / Other'}
      <tr class:muted class="sector">
        <td class="label">
          {#if inside?.length}
            <button class="open" onclick={() => toggle(s.key)} aria-expanded={open.has(s.key)}>
              <span class="caret">{open.has(s.key) ? '▾' : '▸'}</span>{s.key}
            </button>
            {@const n = inside.filter((i) => !waiting(i.key)).length}
            <span class="small muted">{n === 0 ? 'no industries known yet' : n === 1 ? '1 industry' : `${n} industries`}</span>
          {:else}<span class="pad">{s.key}</span>{/if}
        </td>
        <td class="bar"><span style:width="{(s.share / max) * 100}%" class:grey={muted}></span></td>
        <td class="num">{pct(s.share)}</td>
        <td class="num muted">{gbp(s.value, true)}</td>
      </tr>
      {#if inside && open.has(s.key)}
        {@const top = Math.max(...inside.map((i) => i.value.amount), 0.0001)}
        {#each ordered(inside) as i (i.key)}
          <tr class="industry" class:muted={waiting(i.key)}>
            <td class="label">
              {i.key}
              <span class="small muted">{i.companies.toLocaleString('en-GB')} {i.companies === 1 ? 'company' : 'companies'}</span>
              {#if i.elsewhere.length}<div class="small note">{elsewhere(i)}</div>{/if}
            </td>
            <td class="bar"><span style:width="{(i.value.amount / top) * 100}%" class:grey={waiting(i.key)}></span></td>
            <td class="num">{pct(s.value.amount ? i.value.amount / s.value.amount : 0)} <span class="small muted">of {s.key}</span></td>
            <td class="num muted">{gbp(i.value, true)}</td>
          </tr>
        {/each}
      {/if}
    {/each}
  </tbody>
</table>

<style>
  table { width: 100%; border-collapse: collapse; }
  td { padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  .label { width: 40%; }
  .bar { width: 36%; }
  .bar span { display: block; height: 10px; border-radius: 3px; background: var(--bar); min-width: 1px; }
  .bar span.grey { background: var(--bar-muted); }
  tr.muted .label { color: var(--muted); font-style: italic; }
  .open { border: 0; background: none; padding: 0; color: var(--text); font: inherit; text-align: left; margin-right: 6px; }
  .caret { display: inline-block; width: 16px; color: var(--muted); }
  .pad { padding-left: 16px; }
  tr.industry td { background: var(--bg); padding-top: 5px; padding-bottom: 5px; }
  tr.industry .label { padding-left: 32px; }
  tr.industry .bar span { height: 8px; }
  .note { color: var(--warn); }
</style>
