<script lang="ts">
  /**
   * The seven figures by fiscal year. Every number names its source on hover;
   * a figure the company does not report is a dash with the reason below,
   * never a number from a nearby line (§3).
   */
  import type { FiguresPanel } from '../research/report.ts';
  import { big, price, day } from './format.ts';

  let { figures, company }: { figures: FiguresPanel; company: string } = $props();

  const SOURCES: Record<string, string> = {
    edgar: "From the company's own SEC filings — official figures.",
    stockanalysis: 'From stockanalysis.com — a third-party site, not the company\'s own filing.',
  };
  const currency = $derived(figures.rows.flatMap((r) => r.cells).find((c) => c?.currency)?.currency ?? null);

  // Ten years are kept; five are shown until asked (§3).
  const SHOWN = 5;
  let all = $state(false);
  const from = $derived(all ? 0 : Math.max(0, figures.periods.length - SHOWN));
</script>

<p class="small muted">
  {SOURCES[figures.source] ?? figures.source}
  {#if currency}{company} reports in {currency}.{/if}
  Hover over a figure for exactly where it came from.
</p>

<div class="scroll">
  <table>
    <thead>
      <tr><th></th>{#each figures.periods.slice(from) as p (p)}<th class="num">{p}</th>{/each}</tr>
    </thead>
    <tbody>
      {#each figures.rows as row (row.concept)}
        <tr>
          <th scope="row">{row.name}</th>
          {#each row.cells.slice(from) as cell, i (figures.periods[from + i])}
            <td class="num" title={cell ? `${cell.detail}${cell.periodEnd ? ` · year to ${day(cell.periodEnd)}` : ''}` : 'no figure for this year'}>
              {cell && typeof cell.value === 'number'
                ? (cell.unit.endsWith('/share') && cell.currency ? price(cell.value, cell.currency) : big(cell.value, cell.currency))
                : '—'}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

{#if figures.periods.length > SHOWN}
  <button class="link small" onclick={() => (all = !all)}>{all ? `Latest ${SHOWN} years` : `All ${figures.periods.length} years`}</button>
{/if}

{#if figures.gaps.length}
  <ul class="gaps small">
    {#each figures.gaps as g (g.fieldPath)}<li><strong>Not available:</strong> {g.reason}.</li>{/each}
  </ul>
{/if}

<style>
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 6px 8px; border-bottom: 1px solid var(--line); }
  thead th { font-weight: 500; color: var(--muted); font-size: 12px; }
  tbody th { text-align: left; font-weight: 500; white-space: nowrap; }
  td[title] { cursor: help; }
  .link { border: 0; background: none; color: var(--accent); text-decoration: underline; padding: 0; margin-top: 8px; }
  .gaps { margin: 10px 0 0; padding-left: 18px; color: var(--warn); }
</style>
