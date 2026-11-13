<script lang="ts">
  /**
   * Purification — arithmetic on his figures (§11.10 step 5.4, §8.5). One
   * item per sale: the profit and the dividends paid while held, each × his
   * rate. Items tick off in one go with the date paid. The app proposes no
   * rate and flags nothing as overdue.
   */
  import type { Backend } from './backend.ts';
  import type { Purification, Item, Change } from '../portfolio/purify.ts';
  import { pounds, price, day, shareCurrency, num } from './format.ts';

  let { backend }: { backend: Backend } = $props();

  let data = $state<Purification | null>(null);
  let error = $state('');
  let usual = $state('');
  let ticked = $state<Set<number>>(new Set());
  let paidOn = $state(new Date().toISOString().slice(0, 10));
  let adding = $state(false);
  let manual = $state({ date: '', description: 'Interest on cash', pounds: '', rate: '' });

  async function load() {
    data = await backend.purification();
    usual = data.usualRate === null ? '' : String(data.usualRate);
    ticked = new Set([...ticked].filter((id) => data!.items.some((i) => i.id === id && !i.settled && i.owed !== null)));
  }
  async function run(change: Promise<Change | void>) {
    error = '';
    const r = await change;
    if (r && r.kind === 'refused') error = r.reason;
    await load();
  }
  const toNumber = (s: string) => (s.trim() === '' ? null : Number(s.replace(/[£%,\s]/g, '')));
  function saveUsual() {
    const n = toNumber(usual);
    if (n === null || !(n >= 0 && n <= 100)) { error = 'Your usual rate is a percentage from 0 to 100'; return; }
    void run(backend.setUsualRate(n));
  }
  function tick(i: Item) {
    const next = new Set(ticked);
    if (next.has(i.id)) next.delete(i.id); else next.add(i.id);
    ticked = next;
  }
  const dividendTotal = (i: Item) => i.dividends.reduce((n, d) => n + d.pounds, 0);
  const blank = $derived(data ? data.items.filter((i) => !i.settled && i.ratePct === null).length : 0);
  const waiting = $derived(data ? [...data.notYetCounted.values()].flat() : []);
  const tickedTotal = $derived(data ? data.items.filter((i) => ticked.has(i.id)).reduce((n, i) => n + (i.owed ?? 0), 0) : 0);

  void load();
</script>

{#if !data}
  <p class="muted">Reading…</p>
{:else}
  <section class="head">
    <div>
      <label class="small">Your usual rate
        <input class="rate" bind:value={usual} inputmode="decimal" placeholder="—" /> %
      </label>
      <button class="small" onclick={saveUsual}>Save</button>
      <p class="small muted">Each new sale starts with it; change any sale’s rate on its line — “based on whatever Zoya says”. The app never suggests a rate.</p>
      {#if blank > 0 && data.usualRate !== null}
        <button class="small" onclick={() => run(backend.fillMissingRates())}>Use {num(data.usualRate, 2)}% on the {blank} {blank === 1 ? 'item' : 'items'} without a rate</button>
        <span class="small muted">— items with a rate of their own are left as they are</span>
      {/if}
    </div>
    <div class="owed">
      <span class="small muted">Still to give</span>
      <strong>{pounds(data.outstanding)}</strong>
      {#if data.incomplete}<span class="small muted">{data.incomplete} {data.incomplete === 1 ? 'item needs' : 'items need'} a rate or a profit first</span>{/if}
    </div>
  </section>

  {#if error}<p class="error small">{error}</p>{/if}

  {#if data.items.length === 0}
    <p class="muted">No sales yet. Each sale Trading 212 records appears here after a Refresh, with its dividends.</p>
  {:else}
    <table>
      <thead><tr><th></th><th>Date</th><th>What</th><th>Working</th><th class="num">Rate</th><th class="num">To give</th></tr></thead>
      <tbody>
        {#each data.items as i (i.id)}
          <tr class:settled={i.settled}>
            <td>{#if !i.settled}<input type="checkbox" checked={ticked.has(i.id)} disabled={i.owed === null} onchange={() => tick(i)} aria-label="Tick {i.description}" />{/if}</td>
            <td>{day(i.date)}</td>
            <td>
              {i.description}
              {#if i.sold}<div class="small muted">at {price(i.sold.price, shareCurrency(i.sold.currency))} a unit</div>{/if}
            </td>
            <td class="small">
              {#if i.kind === 'manual'}
                {pounds(i.amount ?? 0)} × {i.ratePct ?? '—'}%
              {:else if i.profit?.kind === 'unknown'}
                <span class="muted">{i.profit.reason}</span>
                {#if !i.settled}
                  <form onsubmit={(e) => { e.preventDefault(); const v = toNumber(new FormData(e.currentTarget).get('p') as string); void run(backend.setTypedProfit(i.id, v)); }}>
                    <input name="p" class="money" placeholder="profit £" inputmode="decimal" /> <button class="small">Save</button>
                  </form>
                {/if}
              {:else if i.profit}
                {#if i.profit.pounds >= 0}
                  Profit {pounds(i.profit.pounds)}{i.profit.kind === 'typed' ? ' (typed)' : ' (Trading 212)'}
                {:else}
                  A loss of {pounds(-i.profit.pounds)}{i.profit.kind === 'typed' ? ' (typed)' : ''} — nothing to purify on the sale
                {/if}
                {#if i.profit.kind === 'typed' && !i.settled}<button class="link small" onclick={() => run(backend.setTypedProfit(i.id, null))}>use Trading 212’s</button>{/if}
                <br />+ dividends while held: {i.dividends.length ? `${i.dividends.length} ${i.dividends.length === 1 ? 'payment' : 'payments'}, ${pounds(dividendTotal(i))}` : 'none'}
                {#if i.ratePct !== null}
                  <br />= ({pounds(Math.max(i.profit.pounds, 0))} + {pounds(dividendTotal(i))}) × {num(i.ratePct, 2)}%
                {/if}
              {/if}
            </td>
            <td class="num">
              {#if i.settled}{i.ratePct ?? '—'}%
              {:else}
                <input class="rate" value={i.ratePct ?? ''} placeholder="—" inputmode="decimal"
                  onchange={(e) => run(backend.setItemRate(i.id, toNumber(e.currentTarget.value)))} aria-label="Rate for {i.description}" />%
              {/if}
            </td>
            <td class="num">
              {#if i.settled}{pounds(i.settled.amount)}<div class="small muted">paid {day(i.settled.on)}</div>
              {:else if i.owed === null}<span class="muted small">{i.ratePct === null ? 'rate not entered' : 'profit needed'}</span>
              {:else}{pounds(i.owed)}{/if}
              {#if i.kind === 'manual' && !i.settled}<div><button class="link small" onclick={() => run(backend.deletePurificationItem(i.id))}>remove</button></div>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>

    <div class="settle">
      <span>{ticked.size ? `${ticked.size} ticked: ${pounds(tickedTotal)}` : 'Tick what you have paid'}</span>
      <label class="small">paid on <input type="date" bind:value={paidOn} /></label>
      <button disabled={ticked.size === 0} onclick={() => run(backend.settle([...ticked], paidOn)).then(() => (ticked = new Set()))}>Mark as paid</button>
    </div>
  {/if}

  {#if waiting.length}
    <p class="small muted">Dividends paid since a holding’s last sale — {waiting.length}, {pounds(waiting.reduce((n, d) => n + d.pounds, 0))} — are counted at its next sale.</p>
  {/if}

  {#if adding}
    <form class="manual" onsubmit={(e) => { e.preventDefault(); void run(backend.addPurificationItem({ date: manual.date, description: manual.description, pounds: toNumber(manual.pounds) ?? NaN, ratePct: toNumber(manual.rate) })).then(() => { if (!error) adding = false; }); }}>
      <label class="small">Paid on <input type="date" bind:value={manual.date} /></label>
      <label class="small">What <input bind:value={manual.description} /></label>
      <label class="small">Amount £ <input class="money" bind:value={manual.pounds} inputmode="decimal" /></label>
      <label class="small">Rate % <input class="rate" bind:value={manual.rate} inputmode="decimal" /></label>
      <button>Add</button> <button type="button" class="link small" onclick={() => (adding = false)}>Cancel</button>
    </form>
  {:else}
    <button class="link small" onclick={() => { adding = true; manual = { ...manual, rate: data?.usualRate === null ? '' : String(data?.usualRate ?? '') }; }}>Add an item by hand (e.g. the interest payment)…</button>
  {/if}
{/if}

<style>
  .head { display: flex; justify-content: space-between; gap: 24px; margin-bottom: 12px; }
  .head p { margin: 4px 0 0; max-width: 560px; }
  .owed { display: grid; justify-items: end; }
  .owed strong { font-size: 20px; font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0 12px; }
  th { text-align: left; font-weight: 500; color: var(--muted); font-size: 12px; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  td { padding: 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr.settled td { color: var(--muted); }
  input.rate { width: 4.5em; text-align: right; }
  input.money { width: 7em; text-align: right; }
  .settle { display: flex; gap: 14px; align-items: center; justify-content: flex-end; margin-bottom: 12px; }
  .manual { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; margin-top: 8px; }
  .manual label { display: grid; gap: 2px; }
  .error { color: var(--bad); }
  .link { border: 0; background: none; color: var(--accent); text-decoration: underline; padding: 0; font: inherit; }
  form { margin-top: 4px; }
</style>
