<script lang="ts">
  /**
   * Every dividend paid, newest first, with a total for each ISA year
   * (§11.10 step 5.2). Only what has been paid: nothing announced or expected.
   */
  import type { DividendHistory } from '../portfolio/income.ts';
  import { paymentType } from '../portfolio/income.ts';
  import { pounds, price, day, when, shareCurrency, num } from './format.ts';

  let { history, showHolding = true, compact = false }: { history: DividendHistory; showHolding?: boolean; compact?: boolean } = $props();
  const refused = $derived(history.last?.kind === 'unavailable' && /refused/.test(history.last.detail ?? ''));
</script>

{#if !history.last}
  <p class="muted small">Not fetched yet — press Refresh on the portfolio.</p>
{:else if history.last.kind !== 'ok'}
  <p class="warn small">
    {#if refused}
      Trading 212 refused the request on {day(history.last.at)}: your key may not have the <strong>dividends history</strong> permission.
      In Trading 212, Settings → API: make a read-only key with <em>History: dividends</em> and <em>History: orders</em> ticked
      (never placing orders), then use “Replace Trading 212 key” here.
    {:else}
      Trading 212 {history.last.kind === 'unavailable' ? 'did not answer' : 'gave something that did not pass a check'} on {day(history.last.at)}
      ({history.last.detail}).
    {/if}
    {#if history.payments.length}Showing what was stored before.{/if}
  </p>
{:else if !compact}
  <p class="muted small">From Trading 212, updated {when(history.last.at)}. Only what has been paid — nothing announced or expected.</p>
{/if}

{#if history.payments.length === 0}
  {#if history.last?.kind === 'ok'}<p class="muted">No dividends paid{showHolding ? '' : ' by this holding'} — a fund that reinvests (“Acc”) pays none.</p>{/if}
{:else}
  <table class="years">
    <thead><tr><th>ISA year</th><th class="num">Payments</th><th class="num">Total</th></tr></thead>
    <tbody>
      {#each history.years as y (y.label)}
        <tr><td>{y.label} <span class="muted small">{y.span}</span></td><td class="num">{y.payments}</td><td class="num">{pounds(y.pounds)}</td></tr>
      {/each}
      <tr class="all"><td>All years</td><td class="num">{history.payments.length}</td><td class="num">{pounds(history.total)}</td></tr>
    </tbody>
  </table>

  <table>
    <thead><tr><th>Paid</th>{#if showHolding}<th>Holding</th>{/if}<th class="num">Amount</th><th class="num">Units held</th><th class="num">Per unit</th><th>Type</th></tr></thead>
    <tbody>
      {#each history.payments as p (p.reference)}
        <tr>
          <td>{day(p.paidOn)}</td>
          {#if showHolding}<td>{p.name}</td>{/if}
          <td class="num">{pounds(p.pounds)}</td>
          <td class="num">{num(p.quantity, p.quantity % 1 ? 4 : 0)}</td>
          <td class="num">{p.perUnit === null ? '—' : price(p.perUnit, shareCurrency(p.perUnitCurrency ?? ''), 4)}</td>
          <td>{paymentType(p.type)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
  table.years { max-width: 520px; }
  th { text-align: left; font-weight: 500; color: var(--muted); font-size: 12px; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  td { padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.all td { font-weight: 500; }
  .warn { background: var(--bad-soft); color: var(--bad); padding: 8px 12px; border-radius: 6px; }
</style>
