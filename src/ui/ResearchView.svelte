<script lang="ts">
  /**
   * Research: find a company in Trading 212's list and open it (§7.2), or
   * return to one already opened. Opening confirms the company's identity
   * by ISIN before anything is shown; if anything disagrees, it says why.
   */
  import type { Backend } from './backend.ts';
  import type { CatalogueHit } from '../research/catalogue.ts';
  import type { ReportSummary } from '../research/report.ts';
  import { when, exchangeName } from './format.ts';
  import ReportView from './ReportView.svelte';

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

  async function loadOpened() { opened = await backend.reports(); }
  $effect(() => { if (listingId === null) void loadOpened(); });

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
                <button onclick={() => open(h)} disabled={opening !== null}>{opening === h.t212Ticker ? 'Confirming identity…' : 'Open'}</button>
              </td>
            </tr>
            {#if refusal?.ticker === h.t212Ticker}
              <tr><td></td><td colspan="3" class="small bad">Not opened: {refusal.reason}.</td></tr>
            {/if}
          {/each}
        </tbody>
      </table>
    {:else if query.trim() && answered === query && !searching}
      <p class="small muted">No share in Trading 212's list matches “{query}”.</p>
    {/if}
  </section>

  <section>
    <h3>Opened for research</h3>
    {#if opened.length}
      <table>
        <tbody>
          {#each opened as r (r.listingId)}
            <tr class="row">
              <td class="ticker">{r.ticker}</td>
              <td><button class="name" onclick={() => (listingId = r.listingId)}>{r.name}</button></td>
              <td class="muted">{exchangeName(r.exchange)}</td>
              <td class="muted small num">{r.refreshedAt ? `refreshed ${when(r.refreshedAt)}` : 'not refreshed yet'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <p class="small muted">None yet. A company appears here once opened, and stays.</p>
    {/if}
  </section>
{/if}

<style>
  section { margin-bottom: 24px; }
  h2 { font-size: 20px; margin-bottom: 4px; }
  h3 { font-size: 14px; margin-bottom: 8px; }
  input[type='search'] { width: 100%; max-width: 480px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--text); margin: 6px 0 10px; }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  td { padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .ticker { font-weight: 600; white-space: nowrap; width: 80px; }
  .row:hover td { background: var(--accent-soft); }
  .name { background: none; color: var(--text); padding: 0; text-decoration: underline; text-decoration-color: var(--line); }
  button { padding: 4px 12px; border: 0; border-radius: 6px; background: var(--accent); color: var(--surface); white-space: nowrap; }
  button:disabled { opacity: 0.6; cursor: default; }
  .warn { color: var(--warn); }
  .bad { color: var(--bad); }
</style>
