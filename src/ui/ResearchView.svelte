<script lang="ts">
  /**
   * Research: find a company in Trading 212's list and open it (§7.2), or
   * return to one already opened. Opening confirms the company's identity
   * by ISIN before anything is shown; if anything disagrees, it says why.
   * "To review" does the same checks and puts it on his list without
   * opening it; the list filters by his labels (§11.8 step 3.3). A row opens
   * from anywhere on it; right-click it to change its label.
   */
  import type { Backend } from './backend.ts';
  import type { CatalogueHit } from '../research/catalogue.ts';
  import type { ReportSummary } from '../research/report.ts';
  import { when, exchangeName } from './format.ts';
  import ReportView from './ReportView.svelte';
  import ContextMenu from './ContextMenu.svelte';
  import { LABELS, LABEL_NAMES, type Label } from '../notes/document.ts';
  import { refreshAll } from './refresh-all.svelte.ts';

  let { backend, listingId = $bindable(null) }: { backend: Backend; listingId: number | null } = $props();

  let query = $state('');
  let hits = $state<readonly CatalogueHit[]>([]);
  let note = $state<string | null>(null);
  let searching = $state(false);
  /** The query the current results answer — "no match" is said only for that. */
  let answered = $state('');
  let opening = $state<string | null>(null);
  let refusal = $state<{ ticker: string; reason: string } | null>(null);
  let opened = $state<readonly ReportSummary[]>([]);
  let only = $state<Label | 'all'>('all');
  let queued = $state<string | null>(null);
  const listed = $derived(only === 'all' ? opened : opened.filter((r) => r.label === only));
  let menu = $state<{ x: number; y: number; row: ReportSummary } | null>(null);
  const labelItems = (r: ReportSummary) => LABELS.map(([v, name]) => ({
    label: `${r.label === v ? '✓ ' : ''}${name}`,
    run: async () => { await backend.setLabel(r.isin, v); await loadOpened(); },
  }));

  async function loadOpened() { opened = await backend.reports(); }
  $effect(() => { if (listingId === null) void loadOpened(); });
  // The dates in the list move as Refresh all Watching gets through them.
  $effect(() => { void refreshAll.results.length; if (listingId === null) void loadOpened(); });
  const watchingCount = $derived(opened.filter((r) => r.label === 'watching').length);

  let timer: ReturnType<typeof setTimeout> | undefined;
  function onInput() {
    clearTimeout(timer);
    refusal = null;
    timer = setTimeout(async () => {
      const q = query;
      if (!q.trim()) { hits = []; note = null; return; }
      searching = true;
      try {
        const r = await backend.searchCompanies(q);
        if (q === query) { hits = r.hits; note = r.note; answered = q; }
      } catch (e) {
        note = String(e);
      } finally {
        searching = false;
      }
    }, 250);
  }

  async function open(hit: CatalogueHit) {
    opening = hit.t212Ticker;
    refusal = null;
    try {
      const r = await backend.openCompany(hit.t212Ticker);
      if (r.kind === 'opened') listingId = r.listingId;
      else refusal = { ticker: hit.t212Ticker, reason: r.reason };
    } catch (e) {
      refusal = { ticker: hit.t212Ticker, reason: String(e) };
    } finally {
      opening = null;
    }
  }

  async function toReview(hit: CatalogueHit) {
    opening = hit.t212Ticker;
    refusal = null;
    queued = null;
    try {
      const r = await backend.openToReview(hit.t212Ticker);
      if (r.kind === 'opened') { queued = hit.t212Ticker; await loadOpened(); }
      else refusal = { ticker: hit.t212Ticker, reason: r.reason };
    } catch (e) {
      refusal = { ticker: hit.t212Ticker, reason: String(e) };
    } finally {
      opening = null;
    }
  }

  const market = (h: CatalogueHit) => h.market ?? 'Other market';
  const priced = (c: string) => (c === 'GBX' ? 'pence' : c);
</script>

{#if listingId !== null}
  <ReportView {backend} {listingId} onBack={() => (listingId = null)} />
{:else}
  <section class="find">
    <h2>Research a company</h2>
    <p class="small muted">From Trading 212's list of shares, so only what the ISA can buy. Search by ticker or name.</p>
    <!-- svelte-ignore a11y_autofocus -->
    <input type="search" bind:value={query} oninput={onInput} placeholder="e.g. AAPL, Shell, Unilever" autofocus />
    {#if searching}<p class="small muted">Searching… the first search of the month also fetches Trading 212's list, which takes a few seconds.</p>{/if}
    {#if note}<p class="small warn">{note}</p>{/if}

    {#if hits.length}
      <table>
        <tbody>
          {#each hits as h (h.t212Ticker)}
            <tr>
              <td class="ticker">{h.shortName}</td>
              <td>{h.name}<div class="small muted">{h.isin}</div></td>
              <td class="muted">{market(h)} · {priced(h.currency)}</td>
              <td class="num">
                {#if opening === h.t212Ticker}<span class="small muted">Confirming identity…</span>
                {:else}
                  <button class="quiet" onclick={() => toReview(h)} disabled={opening !== null} title="Add it to your list, labelled To review, without opening it">To review</button>
                  <button onclick={() => open(h)} disabled={opening !== null}>Open</button>
                {/if}
              </td>
            </tr>
            {#if refusal?.ticker === h.t212Ticker}
              <tr><td></td><td colspan="3" class="small bad">Not added: {refusal.reason}.</td></tr>
            {:else if queued === h.t212Ticker}
              <tr><td></td><td colspan="3" class="small ok">Added to your list below, labelled To review.</td></tr>
            {/if}
          {/each}
        </tbody>
      </table>
    {:else if query.trim() && answered === query && !searching}
      <p class="small muted">No share in Trading 212's list matches “{query}”.</p>
    {/if}
  </section>

  <section>
    <div class="heading">
      <h3>Opened for research</h3>
      {#if watchingCount}
        <button onclick={() => refreshAll.start(backend)} disabled={refreshAll.running}
          title="Refreshes each company labelled Watching, one after another, at the sites' usual pace — about 40 seconds each">
          {refreshAll.running ? 'Refreshing Watching…' : `Refresh all Watching (${watchingCount})`}
        </button>
      {/if}
    </div>
    {#if opened.length}
      <div class="filter small" role="radiogroup" aria-label="Show">
        {#each [['all', 'All'] as const, ...LABELS] as [v, name] (v)}
          {@const n = v === 'all' ? opened.length : opened.filter((r) => r.label === v).length}
          <button class:active={only === v} onclick={() => (only = v)} disabled={n === 0 && only !== v}>{name} <span class="count">{n}</span></button>
        {/each}
      </div>
      <table>
        <tbody>
          {#each listed as r (r.listingId)}
            <!-- The whole row opens the company, by mouse; the name stays the button for the keyboard. -->
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <tr class="row" onclick={() => (listingId = r.listingId)}
              oncontextmenu={(e) => { e.preventDefault(); menu = { x: e.clientX, y: e.clientY, row: r }; }}>
              <td class="ticker">{r.ticker}</td>
              <td><button class="name" onclick={() => (listingId = r.listingId)}>{r.name}</button></td>
              <td>{#if r.label !== 'none'}<span class="tag tag-{r.label}">{LABEL_NAMES[r.label]}</span>{/if}</td>
              <td class="muted">{exchangeName(r.exchange)}</td>
              <td class="muted small num">{r.refreshedAt ? `refreshed ${when(r.refreshedAt)}` : 'not refreshed yet'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      <p class="small muted hint">Right-click a company to change its label.</p>
    {:else}
      <p class="small muted">None yet. A company appears here once opened, and stays.</p>
    {/if}
  </section>
  {#if menu}<ContextMenu x={menu.x} y={menu.y} items={labelItems(menu.row)} onClose={() => (menu = null)} />{/if}
{/if}

<style>
  .heading { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  section { margin-bottom: 24px; }
  h2 { font-size: 20px; margin-bottom: 4px; }
  h3 { font-size: 14px; margin-bottom: 8px; }
  input[type='search'] { width: 100%; max-width: 480px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--text); margin: 6px 0 10px; }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  td { padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .ticker { font-weight: 600; white-space: nowrap; width: 80px; }
  .row { cursor: pointer; }
  .row:hover td { background: var(--accent-soft); }
  .row:hover .name { font-weight: 600; }
  .hint { margin: 6px 0 0; }
  .name { background: none; color: var(--text); padding: 0; text-decoration: underline; text-decoration-color: var(--line); }
  button { padding: 4px 12px; border: 0; border-radius: 6px; background: var(--accent); color: var(--surface); white-space: nowrap; }
  button:disabled { opacity: 0.6; cursor: default; }
  .warn { color: var(--warn); }
  .ok { color: var(--accent); }
  button.quiet { background: none; color: var(--accent); border: 1px solid var(--accent); padding: 3px 10px; margin-right: 4px; }
  .filter { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
  .filter button { background: none; color: var(--muted); border: 1px solid var(--line); padding: 2px 10px; }
  .filter button.active { background: var(--accent-soft); color: var(--accent); border-color: transparent; font-weight: 500; }
  .filter button:disabled { opacity: 0.45; }
  .count { opacity: 0.7; margin-left: 2px; }
  .tag { font-size: 11px; padding: 1px 6px; border-radius: 4px; white-space: nowrap; color: var(--accent); background: var(--accent-soft); }
  .tag-passed { color: var(--muted); background: var(--bg); border: 1px solid var(--line); }
  .bad { color: var(--bad); }
</style>
