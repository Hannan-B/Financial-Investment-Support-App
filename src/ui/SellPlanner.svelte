<script lang="ts">
  /**
   * "If I sold at this price" (§11.10 step 5.5). He types the price; the app
   * works out what follows — in pounds at the Bank of England rate less
   * Trading 212's fee, what those units cost, the profit, purification at his
   * usual rate on the profit and on dividends not yet counted, what is left.
   * It proposes no price and places nothing.
   */
  import type { Backend } from './backend.ts';
  import type { SellPlan, SavedPlan } from '../portfolio/plan.ts';
  import { pounds, price as priceText, day, rateText, num } from './format.ts';

  let { backend, isin, name }: { backend: Backend; isin: string; name: string } = $props();

  let priceIn = $state('');
  let unitsIn = $state('');
  let plan = $state<SellPlan | null>(null);
  let saved = $state<readonly SavedPlan[]>([]);
  let message = $state('');
  let aimNote = $state('');
  let askingNote = $state(false);

  const toNumber = (s: string) => (s.trim() === '' ? null : Number(s.replace(/[£$€p,\s]/g, '')));
  async function work() {
    message = '';
    const p = toNumber(priceIn);
    plan = p === null ? null : await backend.planSell(isin, p, toNumber(unitsIn));
  }
  async function loadSaved() { saved = (await backend.plans(isin)).filter((p) => p.kind === 'sell'); }
  async function keep() {
    if (plan?.kind !== 'ok') return;
    await backend.savePlan({ kind: 'sell', isin, name, inputs: { price: plan.price, units: plan.units }, outcome: plan });
    message = 'Kept, with today’s date.';
    await loadSaved();
  }
  async function aim() {
    if (plan?.kind !== 'ok') return;
    const value = `${priceText(plan.price.amount, plan.price.currency)} — ${day(new Date().toISOString())}`;
    const r = await backend.saveAim(isin, value, aimNote.trim() || `My aim: ${value}`);
    message = r.kind === 'done' ? 'Saved as your note on this holding.' : r.reason;
    if (r.kind === 'done') { askingNote = false; aimNote = ''; }
  }
  $effect(() => { void isin; void loadSaved(); });
</script>

<div class="sell">
  <h4>If I sold…</h4>
  <form onsubmit={(e) => { e.preventDefault(); void work(); }}>
    <label class="small">at a price of <input bind:value={priceIn} inputmode="decimal" placeholder="your price" /></label>
    <label class="small">units <input bind:value={unitsIn} inputmode="decimal" placeholder="all" /></label>
    <button>Work it out</button>
  </form>
  <p class="small muted">Type the price in the share’s own currency, as Trading 212 shows it. The app works out what follows; it suggests no price and places nothing.</p>

  {#if plan?.kind === 'refused'}
    <p class="error small">{plan.reason}</p>
  {:else if plan?.kind === 'ok'}
    <dl>
      <dt>Worth now</dt><dd>{pounds(plan.nowPerUnit)} a unit, at the last refresh</dd>
      <dt>The sale</dt><dd>{num(plan.units, plan.units % 1 ? 4 : 0)} × {priceText(plan.price.amount, plan.price.currency)} = {priceText(plan.proceeds.amount, plan.proceeds.currency)}</dd>
      <dt>In pounds</dt>
      <dd>
        {#if 'reason' in plan.pounds}<span class="muted">{plan.pounds.reason}</span>
        {:else}
          <strong>{pounds(plan.pounds.pounds)}</strong>
          {#if plan.pounds.rate}<div class="small muted">at {rateText(plan.pounds.rate, plan.proceeds.currency)} — the rate on the day you sell will differ</div>
          {:else if plan.proceeds.currency === 'GBp'}<div class="small muted">pence ÷ 100: no exchange rate</div>{/if}
        {/if}
      </dd>
      <dt>What it cost you</dt><dd>{plan.cost === null ? plan.costReason : `${pounds(plan.cost)} (Trading 212)`}</dd>
      <dt>{plan.profit !== null && plan.profit < 0 ? 'Loss' : 'Profit'}</dt>
      <dd>{plan.profit === null ? '—' : pounds(Math.abs(plan.profit))}{plan.profit !== null && plan.profit < 0 ? ' — nothing to purify on the sale' : ''}</dd>
      <dt>Purification</dt>
      <dd>
        {#if plan.ratePct === null}<span class="muted">set your usual rate on the Purification tab</span>
        {:else if plan.purification === null}—
        {:else}
          <strong>{pounds(plan.purification)}</strong>
          <div class="small muted">
            {num(plan.ratePct, 2)}% × ({pounds(Math.max(plan.profit ?? 0, 0))} profit + {pounds(plan.dividends.reduce((n, d) => n + d.pounds, 0))} in
            {plan.dividends.length} {plan.dividends.length === 1 ? 'dividend' : 'dividends'} not yet counted)
          </div>
        {/if}
      </dd>
      {#if plan.left !== null}
        <dt>Left after purification</dt><dd><strong>{pounds(plan.left)}</strong>{#if plan.profitAfter !== null}<span class="small muted">&nbsp;· profit after purification {pounds(plan.profitAfter)}</span>{/if}</dd>
      {/if}
    </dl>
    <div class="actions">
      <button onclick={keep}>Keep this plan</button>
      {#if askingNote}
        <input bind:value={aimNote} placeholder="why this price (optional)" />
        <button onclick={aim}>Save as my note</button>
        <button class="link small" onclick={() => (askingNote = false)}>Cancel</button>
      {:else}
        <button onclick={() => (askingNote = true)}>Save the price as my aim…</button>
      {/if}
    </div>
  {/if}
  {#if message}<p class="small">{message}</p>{/if}

  {#if saved.length}
    <h5>Kept</h5>
    <ul class="small">
      {#each saved as s (s.id)}
        {@const o = s.outcome as Extract<SellPlan, { kind: 'ok' }>}
        <li>{day(s.createdAt)}: {num(o.units, o.units % 1 ? 4 : 0)} at {priceText(o.price.amount, o.price.currency)}
          {#if !('reason' in o.pounds)} → {pounds(o.pounds.pounds)}{/if}{#if o.left !== null}, {pounds(o.left)} after purification{/if}</li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .sell { margin-top: 10px; }
  h4 { margin: 0 0 6px; }
  h5 { margin: 12px 0 4px; }
  form { display: flex; gap: 10px; align-items: end; flex-wrap: wrap; }
  form label { display: grid; gap: 2px; }
  form input { width: 9em; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 10px 0; }
  dt { color: var(--muted); }
  dd { margin: 0; font-variant-numeric: tabular-nums; }
  .actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .error { color: var(--bad); }
  .link { border: 0; background: none; color: var(--accent); text-decoration: underline; padding: 0; font: inherit; }
  ul { margin: 0; padding-left: 18px; }
</style>
