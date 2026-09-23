<script lang="ts">
  /**
   * The portfolio: summary first, each breakdown a click away (§6A.1).
   * Every figure comes from stored, validated data, with its date.
   */
  import type { Backend, PersistentFailure } from './backend.ts';
  import type { Portfolio, SourceReport } from '../portfolio/refresh.ts';
  import { UNCLASSIFIED } from '../portfolio/lookthrough.ts';
  import { gbp, pct, day, when, countryName } from './format.ts';
  import KeySetup from './KeySetup.svelte';
  import SourceReports from './SourceReports.svelte';
  import HoldingsView from './HoldingsView.svelte';
  import CompaniesView from './CompaniesView.svelte';
  import BarList from './BarList.svelte';

  let { backend }: { backend: Backend } = $props();

  type Tab = 'holdings' | 'companies' | 'industries' | 'countries';
  let phase = $state<'starting' | 'failed' | 'ready'>('starting');
  let startError = $state('');
  let keySaved = $state(false);
  let settingUp = $state(false);
  let portfolio = $state<Portfolio | null>(null);
  let reports = $state<readonly SourceReport[]>([]);
  let persistent = $state<readonly PersistentFailure[]>([]);
  let refreshing = $state(false);
  let classifying = $state<{ done: number; total: number } | null>(null);
  let tab = $state<Tab>('companies');

  const breakdowns = $derived(portfolio?.result.breakdowns.kind === 'ok' ? portfolio.result.breakdowns : null);
  const refused = $derived(portfolio?.result.breakdowns.kind === 'refused' ? portfolio.result.breakdowns.reasons : []);
  const fundDates = $derived(new Map((portfolio?.funds ?? []).map((f) => [f.ticker, f.asOf])));
  const heldFundDates = $derived([...new Set((portfolio?.funds ?? []).filter((f) => f.held).map((f) => f.asOf))].sort());
  const unclassified = $derived(breakdowns?.sectors.find((s) => s.key === UNCLASSIFIED));

  async function start() {
    try {
      await backend.start();
      keySaved = await backend.keySaved();
      portfolio = await backend.load();
      persistent = await backend.persistentFailures();
      phase = 'ready';
    } catch (e) {
      startError = String(e);
      phase = 'failed';
      return;
    }
    // Pick up lookups a closed app left unfinished. Each one is saved only
    // when complete, so one cut off midway is simply done again.
    if (portfolio?.holdingsAsOf) void classify();
  }

  async function saveKey(key: string, secret: string) {
    await backend.saveKey(key, secret);
    keySaved = true;
    settingUp = false;
    await doRefresh();
  }

  async function doRefresh() {
    refreshing = true;
    try {
      reports = await backend.refresh();
      portfolio = await backend.load();
      persistent = await backend.persistentFailures();
    } finally {
      refreshing = false;
    }
    void classify();
  }

  /** Company lookups run on after the screen is showing; it updates as they land. */
  async function classify() {
    if (classifying) return;
    classifying = { done: 0, total: 0 };
    try {
      await backend.classify(async (done, total) => {
        classifying = { done, total };
        if (done % 10 === 0 || done === total) portfolio = await backend.load();
      });
      portfolio = await backend.load();
    } finally {
      classifying = null;
    }
  }

  async function removeKey() {
    if (!confirm('Remove the Trading 212 key from the keychain? Stored data stays.')) return;
    await backend.removeKey();
    keySaved = false;
  }

  void start();
</script>

{#if phase === 'starting'}
  <p class="centre muted">Opening…</p>
{:else if phase === 'failed'}
  <section class="centre">
    <h2>The database could not be opened</h2>
    <p class="error">{startError}</p>
  </section>
{:else if settingUp || (!keySaved && !portfolio?.holdingsAsOf)}
  <KeySetup save={saveKey} cancel={portfolio?.holdingsAsOf ? () => (settingUp = false) : undefined} />
{:else}
  <main>
    {#if backend.demo}
      <p class="demo small">Demo — invented holdings, real fund contents. Nothing here is your portfolio.</p>
    {/if}

    <header>
      <div>
        <h1>{portfolio?.holdingsAsOf ? gbp(portfolio.result.total, true) : '—'}</h1>
        {#if portfolio?.holdingsAsOf}
          <p class="muted">Direct {gbp(portfolio.result.direct, true)} · via funds {gbp(portfolio.result.viaFunds, true)}</p>
          <p class="small muted">
            Holdings updated {when(portfolio.holdingsAsOf)}
            {#if heldFundDates.length} · fund contents as of {heldFundDates.map(day).join(', ')}{/if}
          </p>
        {:else}
          <p class="muted">No holdings yet — refresh to fetch them.</p>
        {/if}
      </div>
      <div class="actions">
        <button class="primary" onclick={doRefresh} disabled={refreshing || !keySaved} title={keySaved ? '' : 'Add a Trading 212 key first'}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>
        {#if keySaved}<button class="link small" onclick={removeKey}>Remove Trading 212 key</button>
        {:else}<button class="link small" onclick={() => (settingUp = true)}>Add Trading 212 key</button>{/if}
      </div>
    </header>

    <SourceReports {reports} {persistent} />

    {#if classifying && classifying.total > 0}
      <p class="small muted">Classifying companies {classifying.done} of {classifying.total} — largest first; figures update as they land.</p>
    {/if}

    {#if portfolio?.holdingsAsOf}
      {#if breakdowns}
        {@const top = breakdowns.companies[0]}
        {@const topSector = breakdowns.sectors.find((s) => s.key !== UNCLASSIFIED && s.key !== 'Cash / Other')}
        <section class="tiles">
          <div><span class="small muted">Largest company</span><strong>{top?.name ?? '—'}</strong><span>{top ? pct(top.share) : ''}</span></div>
          <div><span class="small muted">Largest industry</span><strong>{topSector?.key ?? '—'}</strong><span>{topSector ? pct(topSector.share) : ''}</span></div>
          <div><span class="small muted">Countries</span><strong>{breakdowns.countries.filter((c) => c.key !== 'cash' && c.key !== 'unclassified').length}</strong><span></span></div>
          <div><span class="small muted">Companies</span><strong>{breakdowns.companies.length.toLocaleString('en-GB')}</strong><span></span></div>
        </section>
      {:else}
        <section class="refused">
          <strong>Breakdowns withheld.</strong> Showing them without every fund would understate whole industries while looking plausible.
          <ul>{#each refused as r (r)}<li>{r}</li>{/each}</ul>
        </section>
      {/if}

      <nav>
        {#each [['companies', 'Companies'], ['industries', 'Industries'], ['countries', 'Countries'], ['holdings', 'Holdings']] as [key, label] (key)}
          <button class:active={tab === key} onclick={() => (tab = key as Tab)}>{label}</button>
        {/each}
      </nav>

      <section class="panel">
        {#if tab === 'holdings'}
          <HoldingsView holdings={portfolio.holdings} {fundDates} />
        {:else if !breakdowns}
          <p class="muted">Withheld — see above. The Holdings tab still shows what you own.</p>
        {:else if tab === 'companies'}
          <CompaniesView companies={breakdowns.companies} />
        {:else if tab === 'industries'}
          {#if unclassified}
            <p class="small muted">{pct(unclassified.share)} is not yet classified: companies no fund source classifies are looked up one by one, largest first.</p>
          {/if}
          <BarList items={breakdowns.sectors.map((s) => ({
            label: s.key, value: s.value, share: s.share, muted: s.key === UNCLASSIFIED || s.key === 'Cash / Other',
          }))} />
        {:else}
          <BarList items={breakdowns.countries.map((c) => ({
            label: countryName(c.key), value: c.value, share: c.share, muted: c.key === 'cash' || c.key === 'unclassified',
          }))} />
        {/if}
      </section>
    {/if}
  </main>
{/if}

<style>
  main { max-width: 1040px; margin: 0 auto; padding: 28px 32px 48px; }
  .centre { max-width: 560px; margin: 80px auto; text-align: center; }
  .error { color: var(--bad); white-space: pre-wrap; }
  .demo { background: var(--accent-soft); color: var(--accent); padding: 6px 12px; border-radius: 6px; margin: 0 0 16px; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin-bottom: 16px; }
  h1 { font-size: 30px; font-variant-numeric: tabular-nums; }
  header p { margin: 2px 0; }
  .actions { display: grid; justify-items: end; gap: 6px; }
  .primary { padding: 8px 18px; border: 0; border-radius: 6px; background: var(--accent); color: var(--surface); }
  .primary:disabled { opacity: 0.6; cursor: default; }
  .link { border: 0; background: none; color: var(--muted); text-decoration: underline; padding: 0; }
  .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 8px 0 20px; }
  .tiles div { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; display: grid; gap: 2px; }
  .tiles strong { font-size: 16px; }
  .refused { background: var(--bad-soft); color: var(--bad); border-radius: 8px; padding: 12px 16px; margin: 8px 0 20px; }
  .refused ul { margin: 6px 0 0; padding-left: 18px; }
  nav { display: flex; gap: 4px; border-bottom: 1px solid var(--line); }
  nav button { border: 0; background: none; padding: 8px 14px; color: var(--muted); border-bottom: 2px solid transparent; margin-bottom: -1px; }
  nav button.active { color: var(--text); border-bottom-color: var(--accent); font-weight: 500; }
  .panel { background: var(--surface); border: 1px solid var(--line); border-top: 0; border-radius: 0 0 8px 8px; padding: 12px 16px 16px; }
  @media (max-width: 720px) { .tiles { grid-template-columns: repeat(2, 1fr); } main { padding: 16px; } }
</style>
