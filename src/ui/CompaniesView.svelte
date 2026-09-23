<script lang="ts">
  /**
   * True company exposure — the centrepiece (§6A.2). What you own once funds
   * are opened up, and through which of them.
   */
  import type { CompanyExposure } from '../portfolio/lookthrough.ts';
  import { money } from '../lib/money.ts';
  import { gbp, pct } from './format.ts';

  let { companies }: { companies: readonly CompanyExposure[] } = $props();

  /** 'direct £1,146 · IGDA £642 · 2 share classes' */
  function routes(c: CompanyExposure): string {
    return [
      ...(c.direct.amount > 0 ? [`direct ${gbp(c.direct, true)}`] : []),
      ...c.viaFunds.map((v) => `${v.fund} ${gbp(v.value, true)}`),
      ...(c.isins.length > 1 ? [`${c.isins.length} share classes`] : []),
    ].join(' · ');
  }

  let filter = $state('');
  let limit = $state(50);
  const shown = $derived.by(() => {
    const f = filter.trim().toUpperCase();
    return f ? companies.filter((c) => c.name.toUpperCase().includes(f) || c.isins.some((i) => i.includes(f))) : companies;
  });
</script>

<div class="tools">
  <input placeholder="Find a company or ISIN" bind:value={filter} />
  <span class="muted small">{companies.length.toLocaleString('en-GB')} companies</span>
</div>

<table>
  <thead>
    <tr><th>Company</th><th class="num">Direct</th><th class="num">Via funds</th><th class="num">Total</th><th class="num">Share</th></tr>
  </thead>
  <tbody>
    {#each shown.slice(0, limit) as c (c.name + c.isins.join())}
      {@const via = c.viaFunds.reduce((n, v) => n + v.value.amount, 0)}
      <tr>
        <td>
          {c.name}
          {#if c.viaFunds.length > 0 || c.isins.length > 1}
            <div class="small muted" title={c.isins.join(', ')}>{routes(c)}</div>
          {/if}
        </td>
        <td class="num">{c.direct.amount > 0 ? gbp(c.direct) : '—'}</td>
        <td class="num">{via > 0 ? gbp(money(via, 'GBP')) : '—'}</td>
        <td class="num strong">{gbp(c.total)}</td>
        <td class="num">{pct(c.share)}</td>
      </tr>
    {/each}
  </tbody>
</table>

{#if shown.length > limit}
  <button class="more" onclick={() => (limit += 200)}>Show more ({(shown.length - limit).toLocaleString('en-GB')} left)</button>
{/if}

<style>
  .tools { display: flex; gap: 12px; align-items: center; margin-bottom: 10px; }
  input { flex: 0 1 320px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--text); }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-weight: 500; color: var(--muted); font-size: 12px; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  td { padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .strong { font-weight: 600; }
  .more { margin-top: 12px; padding: 6px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--text); }
</style>
