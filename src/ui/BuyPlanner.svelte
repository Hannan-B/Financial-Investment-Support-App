<script lang="ts">
  /**
   * "If I put £500 into this" (§11.10 step 5.5): one company, one or more
   * amounts in pounds, each beside "now", his funds counted in. Never another
   * company to compare with — he buys a share on its own merits. Nothing here
   * can place an order; the app proposes no amount.
   */
  import type { Backend } from './backend.ts';
  import type { BuyPlan, BuyOption, SavedPlan, Row } from '../portfolio/plan.ts';
  import { pounds, pct, day, price, rateText, num, countryName } from './format.ts';

  let { backend, isin, name }: { backend: Backend; isin: string; name: string } = $props();

  let amountsIn = $state('500, 750');
  let plan = $state<BuyPlan | null>(null);
  let saved = $state<readonly SavedPlan[]>([]);
  let message = $state('');

  const amounts = () => amountsIn.split(/[,;\s]+/).map((s) => Number(s.replace(/[£,]/g, ''))).filter((n) => Number.isFinite(n) && n > 0);
  async function work() { message = ''; plan = await backend.planBuy(isin, amounts()); }
  async function loadSaved() { saved = (await backend.plans(isin)).filter((p) => p.kind === 'buy'); }
  async function keep() {
    if (plan?.kind !== 'ok') return;
    await backend.savePlan({ kind: 'buy', isin, name, inputs: { amounts: plan.options.map((o) => o.pounds) }, outcome: plan });
    message = 'Kept, with today’s date.';
    await loadSaved();
  }
  /** A change in a share of the portfolio, in percentage points — between the two figures as shown, so they agree. */
  const points = (r: Row) => {
    const shown = (s: number) => Math.round(s * 1000) / 10;
    const d = Math.round((shown(r.after.share) - shown(r.before.share)) * 10) / 10;
    return d === 0 ? '—' : `${d > 0 ? '+' : ''}${d.toFixed(1)} pts`;
  };
  const label = (key: string, kind: 'sector' | 'country' | 'company') => (kind === 'country' ? countryName(key) : key);
  const GROUPS: readonly (readonly ['Sectors' | 'Countries' | 'Largest companies', 'sector' | 'country' | 'company', (o: BuyOption) => readonly Row[]])[] = [
    ['Sectors', 'sector', (o) => o.sectors], ['Countries', 'country', (o) => o.countries], ['Largest companies', 'company', (o) => o.largest],
  ];
  $effect(() => { void isin; void loadSaved(); });
</script>

<section class="buy">
  <h4>If I bought {name}…</h4>
  <form onsubmit={(e) => { e.preventDefault(); void work(); }}>
    <label class="small">amounts in pounds <input bind:value={amountsIn} placeholder="e.g. 500, 750" /></label>
    <button>Work it out</button>
  </form>
  <p class="small muted">Each amount is shown beside your portfolio now, your funds counted in. The app suggests no amount and places nothing.</p>

  {#if plan?.kind === 'refused'}
    <p class="error small">{plan.reason}</p>
  {:else if plan?.kind === 'ok'}
    <table>
      <thead><tr><th></th><th class="num">Now</th>{#each plan.options as o (o.pounds)}<th class="num">+ {pounds(o.pounds)}</th>{/each}</tr></thead>
      <tbody>
        <tr class="lead"><td>{name} in your portfolio</td><td class="num">{pounds(plan.now.total)}<div class="small muted">{pct(plan.now.share)}</div></td>
          {#each plan.options as o (o.pounds)}<td class="num">{pounds(o.company.total)}<div class="small muted">{pct(o.company.share)}</div></td>{/each}</tr>
        <tr><td class="sub">bought directly</td><td class="num">{pounds(plan.now.direct)}</td>{#each plan.options as o (o.pounds)}<td class="num">{pounds(o.company.direct)}</td>{/each}</tr>
        {#each plan.now.viaFunds as v (v.fund)}
          <tr><td class="sub">through {v.fund}</td><td class="num">{pounds(v.value)}</td>{#each plan.options as o (o.pounds)}<td class="num">{pounds(o.company.viaFunds.find((x) => x.fund === v.fund)?.value ?? 0)}</td>{/each}</tr>
        {/each}
        <tr><td>Portfolio total</td><td class="num">{pounds(plan.total)}</td>{#each plan.options as o (o.pounds)}<td class="num">{pounds(plan.total + o.pounds)}</td>{/each}</tr>
        <tr><td>What the pounds buy</td><td></td>
          {#each plan.options as o (o.pounds)}
            <td class="num small">
              {#if 'reason' in o.units}<span class="muted">{o.units.reason}</span>
              {:else}
                {num(o.units.units, 4)} shares
                <div class="muted">or {o.units.whole} whole, {pounds(o.units.leftover)} left</div>
              {/if}
            </td>
          {/each}
        </tr>
      </tbody>
    </table>
    {#each plan.options.slice(0, 1) as first (first.pounds)}
      {@const u = first.units}
      {#if !('reason' in u)}
        <p class="small muted">At {price(u.price.amount, u.price.currency)} a share (close on {day(u.price.date)}){#if u.rate}, converted at {rateText(u.rate, u.price.currency)}{:else if u.price.currency === 'GBp'}: pence ÷ 100, no exchange rate{/if}. Trading 212’s own price on the day will differ.</p>
      {/if}
    {/each}

    {#each GROUPS as [title, kind, pick] (title)}
      <h5>{title}</h5>
      <table class="shares">
        <thead><tr><th></th><th class="num">Now</th>{#each plan.options as o (o.pounds)}<th class="num">+ {pounds(o.pounds)}</th>{/each}</tr></thead>
        <tbody>
          {#each pick(plan.options[plan.options.length - 1]!) as r (r.key)}
            <tr>
              <td>{label(r.key, kind)}</td>
              <td class="num">{pct(r.before.share)}</td>
              {#each plan.options as o (o.pounds)}
                {@const row = pick(o).find((x) => x.key === r.key)}
                <td class="num">{row ? pct(row.after.share) : '—'} <span class="small muted">{row ? points(row) : ''}</span></td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    {/each}
    <div class="actions"><button onclick={keep}>Keep this plan</button>{#if message}<span class="small">{message}</span>{/if}</div>
  {/if}

  {#if saved.length}
    <h5>Kept</h5>
    <ul class="small">
      {#each saved as s (s.id)}
        {@const o = s.outcome as Extract<BuyPlan, { kind: 'ok' }>}
        <li>{day(s.createdAt)}: {o.options.map((x) => `${pounds(x.pounds)} → ${pct(x.company.share)} of the portfolio`).join('; ')} (was {pct(o.now.share)})</li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  h4 { margin: 0 0 6px; }
  h5 { margin: 14px 0 4px; }
  form { display: flex; gap: 10px; align-items: end; }
  form label { display: grid; gap: 2px; }
  form input { width: 14em; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { text-align: left; font-weight: 500; color: var(--muted); font-size: 12px; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  td { padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.sub { padding-left: 22px; color: var(--muted); }
  tr.lead td { font-weight: 500; }
  .actions { margin-top: 12px; display: flex; gap: 12px; align-items: center; }
  .error { color: var(--bad); }
  ul { margin: 0; padding-left: 18px; }
</style>
