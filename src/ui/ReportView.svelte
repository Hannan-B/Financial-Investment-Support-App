<script lang="ts">
  /**
   * One company: the Study view (§6.1). The tabs hold the panels; every panel
   * is shown or collapsed with its reason, none left blank. The notes sit on
   * the right (§11.8 step 3.1): right-click anything here to comment on it.
   */
  import { tick } from 'svelte';
  import type { Backend, NotesData } from './backend.ts';
  import type { ReportData } from '../research/report.ts';
  import type { CompanyRefresh } from '../research/company.ts';
  import type { Fact } from '../research/figures.ts';
  import { sma, indicators } from '../research/technicals.ts';
  import { price, num, day, when, exchangeName, factValue as value } from './format.ts';
  import Panel from './Panel.svelte';
  import PriceChart from './PriceChart.svelte';
  import FiguresTable from './FiguresTable.svelte';
  import TechnicalsView from './TechnicalsView.svelte';
  import NewsView from './NewsView.svelte';
  import InsiderView from './InsiderView.svelte';
  import { FIGURE_NAMES } from '../research/names.ts';
  import { TABS, TAB_NAMES, LABELS, type Entry, type Label, type Tab, type Target } from '../notes/document.ts';
  import { targetKey } from '../notes/targets.ts';
  import { about, commentable, reveal, type MenuRequest } from './commentable.ts';
  import NotesPanel from './NotesPanel.svelte';
  import ContextMenu from './ContextMenu.svelte';
  import IneligibleMarker from './IneligibleMarker.svelte';
  import HistoryView from './HistoryView.svelte';
  import { refreshAll } from './refresh-all.svelte.ts';

  let { backend, listingId, onBack }: { backend: Backend; listingId: number; onBack: () => void } = $props();

  let tab = $state<Tab>('overview');
  let report = $state<ReportData | null>(null);
  let failed = $state('');
  let refreshing = $state(false);
  let outcome = $state<CompanyRefresh | null>(null);

  /** When the figures on screen were read: a newer refresh from Refresh all Watching is offered, not swapped in. */
  let loadedAt = $state('');
  const newer = $derived((refreshAll.finished[listingId] ?? '') > loadedAt);
  async function load() {
    try {
      loadedAt = new Date().toISOString();
      report = await backend.loadReport(listingId);
      if (report) await loadNotes();
    } catch (e) { failed = String(e); }
  }

  // ── notes (§11.8) ──
  let notes = $state<NotesData | null>(null);
  let draft = $state<{ tab: Tab; target: Target | null } | null>(null);
  let focus = $state<{ key: string } | null>(null);
  /** A check's date clicked on the History tab: open that review in the notes. A new object each time. */
  let review = $state<{ round: number } | null>(null);
  let menu = $state<MenuRequest | null>(null);
  let chartFocus = $state<{ date: string } | null>(null);
  let notice = $state('');
  let main = $state<HTMLElement>();
  async function loadNotes() { notes = await backend.notes(report!.summary.isin); }
  const commented = $derived(new Set((notes?.entries ?? []).flatMap((e) => (e.kind === 'comment' && !e.deletedAt && e.target ? [e.target.key] : []))));

  /** From a comment to what it is about: its tab, then the item itself — or why it is not there. */
  async function goTo(e: Entry) {
    notice = '';
    if (e.tab && e.tab !== tab) tab = e.tab;
    await tick();
    if (!e.target) { main?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (e.target.key.startsWith('price:')) chartFocus = { date: e.target.key.slice('price:'.length) };
    if (!(await reveal(main!, e.target.key))) {
      notice = `${e.target.label} is no longer on the ${TAB_NAMES[e.tab!]} tab. The comment keeps what it showed then: ${e.target.value}.`;
    }
  }
  const menuItems = (m: MenuRequest) => [
    ...(m.target ? [{ label: `Comment on ${m.target.label}`, run: () => (draft = { tab, target: m.target }) }] : []),
    ...(m.target && commented.has(m.target.key) ? [{ label: 'Show my comment', run: () => (focus = { key: m.target!.key }) }] : []),
    { label: `Comment on ${TAB_NAMES[tab]} as a whole`, run: () => (draft = { tab, target: null }) },
  ];
  async function changeLabel(label: Label) {
    await backend.setLabel(report!.summary.isin, label);
    await loadNotes();
  }
  const fact = (f: Fact, name: string) => about({ key: targetKey.fact(f), label: f.period ? `${name} · ${f.period}` : name, value: value(f) });
  async function refresh() {
    refreshing = true;
    outcome = null;
    try {
      outcome = await backend.refreshCompany(listingId);
      await load();
    } catch (e) {
      outcome = { kind: 'refused', reason: String(e), sources: [] };
    } finally {
      refreshing = false;
    }
  }
  $effect(() => { void listingId; void load(); });

  const bars = $derived(report?.prices?.bars ?? []);
  const currency = $derived(report?.prices?.currency ?? report?.summary.currency ?? '');
  const last = $derived(bars.at(-1));
  const prev = $derived(bars.at(-2));
  const overlays = $derived.by(() => {
    if (!report?.prices) return [];
    const out = [];
    for (const [n, color] of [[50, 'var(--series-2)'], [200, 'var(--series-3)']] as const) {
      const r = sma(report.prices, n);
      if (r.kind === 'ok') out.push({ label: `${n}-day average`, values: r.series, color });
    }
    return out;
  });
  const key = $derived(report?.prices ? indicators(report.prices) : null);
  const problems = $derived(outcome?.sources.filter((s) => s.outcome === 'unavailable' || s.outcome === 'suspect') ?? []);

  const NAMES = FIGURE_NAMES;

  const SOURCE_NAMES: Record<string, string> = {
    'yahoo-prices': 'Prices (Yahoo)', edgar: 'Figures (SEC filings)', stockanalysis: 'Figures (stockanalysis)', finviz: 'Finviz',
    'stockanalysis-statistics': 'Key statistics (stockanalysis)', 'stockanalysis-calendar': 'Dates (stockanalysis)',
    'sec-filings': 'Filings (SEC)', investegate: 'Announcements (Investegate)', 'google-news': 'Press (Google News)',
    'official-announcements': 'Official announcements', news: 'News', 'insider-dealings': 'Insider dealings',
  };
  const latestOf = (f: ReportData['figures'], concept: string) => {
    if (f.kind !== 'ok') return null;
    const row = f.data.rows.find((r) => r.concept === concept);
    return [...(row?.cells ?? [])].reverse().find((c) => c !== null) ?? null;
  };
  const CURRENCY_NAMES: Record<string, string> = { GBP: 'pounds', USD: 'dollars', EUR: 'euros', CHF: 'Swiss francs', JPY: 'yen' };
  const currencyName = (c: string) => CURRENCY_NAMES[c] ?? c;
  /** The company's reporting currency, as the Financials tab shows it. */
  const reportsIn = $derived(report?.figures.kind === 'ok'
    ? report.figures.data.rows.flatMap((r) => r.cells).find((c) => c?.currency)?.currency ?? null : null);
</script>

{#if failed}
  <p class="error">{failed}</p>
{:else if !report}
  <p class="muted">Opening…</p>
{:else}
  {@const s = report.summary}
  <button class="link back" onclick={onBack}>← All companies</button>

  <header>
    <div>
      <div class="name">
        <h1>{s.name}</h1>
        {#if notes}
          <label class="label small">Label
            <select value={notes.label} onchange={(e) => changeLabel(e.currentTarget.value as Label)}>
              {#each LABELS as [v, n] (v)}<option value={v}>{n}</option>{/each}
            </select>
          </label>
        {/if}
      </div>
      <p class="muted">
        {[s.ticker, exchangeName(s.exchange), currency === 'GBp' ? 'priced in pence' : `priced in ${currency}`, report.sector, report.country]
          .filter(Boolean).join(' · ')}
      </p>
      {#if last}
        <p class="price">
          <strong>{price(last.close, currency)}</strong>
          {#if prev}
            {@const change = last.close - prev.close}
            <span class="muted">{change >= 0 ? '+' : '−'}{price(Math.abs(change), currency)} ({change >= 0 ? '+' : '−'}{num(Math.abs((change / prev.close) * 100), 2)}%) on {day(last.date)}</span>
          {/if}
        </p>
      {/if}
      <p class="small muted">
        {#if report.snapshot}
          Refreshed {when(report.snapshot.capturedAt)}{report.snapshot.complete ? '' : ' — incomplete: a core source did not answer'}
        {:else}Not refreshed yet{/if}
      </p>
      {#if notes?.mark}<IneligibleMarker {backend} isin={s.isin} mark={notes.mark} label={notes.label} onChanged={loadNotes} />{/if}
    </div>
    <div class="actions">
      <button class="primary" onclick={refresh} disabled={refreshing || refreshAll.running}
        title={refreshAll.running ? 'Refresh all Watching is running; this waits until it ends' : ''}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>
      {#if refreshing}
        <span class="small muted">Prices, figures, news, then insider dealings. Up to about a minute — the first time collects 180 days of headlines, and for a London share a year of directors' notices.</span>
      {/if}
      {#if report.snapshot}
        <span class="small muted">
          {#each report.snapshot.sources as o, i (o.source)}{i ? ' · ' : ''}{SOURCE_NAMES[o.source] ?? o.source}: {o.outcome === 'ok' ? 'ok' : o.outcome.replace('-', ' ')}{/each}
        </span>
      {/if}
    </div>
  </header>

  {#if newer}
    <div class="banner ready">Newer figures ready — Refresh all Watching has just refreshed {report.summary.name}. <button class="link" onclick={load}>Show them</button></div>
  {/if}
  {#if outcome?.kind === 'refused'}
    <div class="banner bad"><strong>Nothing saved.</strong> {outcome.reason}. The report shows the last good refresh.</div>
  {:else if problems.length}
    <div class="banner warn">
      {#each problems as p (p.source)}<div><strong>{SOURCE_NAMES[p.source] ?? p.source}</strong> — {p.outcome === 'suspect' ? 'data rejected' : 'did not answer'}: {p.detail}</div>{/each}
    </div>
  {/if}

  <div class="study">
    <div class="main" bind:this={main} use:commentable={{ commented, onMenu: (m) => (menu = m) }}>
      <nav>
        {#each TABS as [k, label] (k)}<button class:active={tab === k} onclick={() => { tab = k; notice = ''; }}>{label}</button>{/each}
      </nav>
      {#if notice}<p class="notice small">{notice} <button class="link" onclick={() => (notice = '')}>OK</button></p>{/if}

      {#if tab === 'overview'}
        <section class="box">
          {#if bars.length}
            <PriceChart dates={bars.map((b) => b.date)} closes={bars.map((b) => b.close)} {currency} {overlays} {commented} focus={chartFocus} />
          {:else}<p class="muted">No prices stored yet.</p>{/if}
        </section>

        {#if key}
          <section class="tiles">
            {#each [key.rsi, key.sma[1], key.sma[2], key.atr] as r (r?.kind === 'ok' ? r.working.indicator : r?.indicator)}
              {#if r?.kind === 'ok'}
                {@const v = r.working.result.at(-1)!.value}
                {@const shown = r.working.unit === currency ? price(v, currency) : num(v)}
                <div {...about({ key: targetKey.indicator(r.working.indicator), label: r.working.indicator, value: `${shown} on ${day(r.working.date)}` })}>
                  <span class="small muted">{r.working.indicator}</span>
                  <strong>{shown}</strong>
                </div>
              {:else if r}
                <div>
                  <span class="small muted">{r.indicator}</span>
                  <span class="muted small">needs {r.needed} days</span>
                </div>
              {/if}
            {/each}
          </section>
          <p class="small muted">Worked out from the stored prices; the Technicals tab shows each formula and its inputs.</p>
        {/if}

        <Panel title="Headline figures" panel={report.figures}>
          {#snippet children(f)}
            <dl class="pairs">
              {#each ['revenue', 'ebitda', 'net_income', 'eps', 'operating_cash_flow'] as concept (concept)}
                {@const c = latestOf(report!.figures, concept)}
                {@const name = f.rows.find((r) => r.concept === concept)?.name ?? concept}
                <dt {...c ? fact(c, name) : {}}>{name} {#if c}<span class="muted small">{c.period}</span>{/if}</dt>
                <dd class="num" {...c ? fact(c, name) : {}}>{c ? value(c) : '—'}</dd>
              {/each}
            </dl>
            <button class="link small" onclick={() => (tab = 'financials')}>All figures →</button>
          {/snippet}
        </Panel>

        <Panel title="Analyst predictions" label="Other people's forecasts — not facts" panel={report.predictions}>
          {#snippet children(list)}
            <dl class="pairs">{#each list as f (f.fieldPath)}<dt {...fact(f, `Analysts: ${NAMES[f.fieldPath] ?? f.fieldPath}`)}>{NAMES[f.fieldPath] ?? f.fieldPath}</dt><dd class="num" {...fact(f, `Analysts: ${NAMES[f.fieldPath] ?? f.fieldPath}`)}>{value(f)}</dd>{/each}</dl>
            <p class="small muted">Kept with each refresh, so later they can be set against what actually happened.</p>
          {/snippet}
        </Panel>

        <Panel title="Key statistics" panel={report.keyStats}>
          {#snippet children(k)}
            <p class="small muted">
              From {k.source === 'finviz' ? 'Finviz' : 'stockanalysis'}, as of the last refresh. Twelve-month figures are kept apart from the fiscal years in Financials.
              {#if k.amountsIn && reportsIn && k.amountsIn !== reportsIn}
                Company amounts here are in {currencyName(k.amountsIn)}, converted by stockanalysis — {s.name} reports in {currencyName(reportsIn)}, as Financials shows.
              {/if}
            </p>
            <div class="groups">
              {#each k.groups as g (g.title)}
                <section>
                  <h4>{g.title}</h4>
                  <dl class="pairs small">{#each g.facts as f (f.fieldPath)}<dt {...fact(f, NAMES[f.fieldPath] ?? f.fieldPath)}>{NAMES[f.fieldPath] ?? f.fieldPath}</dt><dd class="num" {...fact(f, NAMES[f.fieldPath] ?? f.fieldPath)}>{value(f)}</dd>{/each}</dl>
                </section>
              {/each}
            </div>
          {/snippet}
        </Panel>

      {:else if tab === 'financials'}
        <Panel title="Financial figures" panel={report.figures}>
          {#snippet children(f)}<FiguresTable figures={f} company={s.name} />{/snippet}
        </Panel>

      {:else if tab === 'technicals'}
        <section class="box">
          {#if report.prices}<TechnicalsView prices={report.prices} />{:else}<p class="muted">No prices stored yet.</p>{/if}
        </section>

      {:else if tab === 'news'}
        <section class="box">
          {#key report.snapshot?.capturedAt}<NewsView {backend} {listingId} company={s.name} />{/key}
        </section>

      {:else if tab === 'insiders'}
        <Panel title="Insider dealings" panel={report.dealings}>
          {#snippet children(v)}<InsiderView {backend} view={v} />{/snippet}
        </Panel>

      {:else if tab === 'calendar'}
        <Panel title="Dates" panel={report.calendar}>
          {#snippet children(c)}
            <dl class="pairs">
              {#each c.facts as f (f.fieldPath)}
                <dt {...fact(f, NAMES[f.fieldPath] ?? f.fieldPath)}>
                  {NAMES[f.fieldPath] ?? f.fieldPath}{#if f.kind === 'estimate'}<span class="muted small aside">scheduled — can move</span>{/if}
                  <span class="muted small source">{f.detail}</span>
                </dt>
                <dd class="num" {...fact(f, NAMES[f.fieldPath] ?? f.fieldPath)}>{value(f)}</dd>
              {/each}
              {#each c.gaps as g (g.fieldPath)}<dt>{NAMES[g.fieldPath] ?? g.fieldPath}</dt><dd class="muted">{g.reason}</dd>{/each}
            </dl>
          {/snippet}
        </Panel>

      {:else}
        {#if notes}
          <HistoryView {backend} isin={s.isin} company={s.name} entries={notes.entries} refreshedAt={report.snapshot?.capturedAt ?? null}
            onOpenReview={(round) => (review = { round })} />
        {:else}<p class="muted">Reading your notes…</p>{/if}
      {/if}
    </div>

    {#if notes}
      {#key s.isin}
        <NotesPanel {backend} isin={s.isin} company={s.name} data={notes} snapshotId={report.snapshot?.id ?? null}
          bind:draft {focus} {review} wide={tab === 'history'} onGo={goTo} onSaved={loadNotes} />
      {/key}
    {/if}
  </div>

  {#if menu}<ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => (menu = null)} />{/if}
{/if}

<style>
  .back { display: block; margin-bottom: 10px; }
  header { display: flex; justify-content: space-between; gap: 24px; margin-bottom: 14px; }
  h1 { font-size: 24px; }
  header p { margin: 2px 0; }
  .price strong { font-size: 22px; font-variant-numeric: tabular-nums; margin-right: 8px; }
  .actions { display: grid; justify-items: end; align-content: start; gap: 6px; text-align: right; max-width: 340px; }
  .primary { padding: 8px 18px; border: 0; border-radius: 6px; background: var(--accent); color: var(--surface); }
  .primary:disabled { opacity: 0.6; cursor: default; }
  .link { border: 0; background: none; color: var(--muted); text-decoration: underline; padding: 0; }
  .banner { border-radius: 8px; padding: 10px 14px; margin-bottom: 12px; }
  .warn { background: var(--warn-soft); color: var(--warn); }
  .bad { background: var(--bad-soft); color: var(--bad); }
  .ready { background: var(--accent-soft); color: var(--accent); }
  .ready .link { color: var(--accent); }
  .error { color: var(--bad); }
  .name { display: flex; gap: 14px; align-items: baseline; flex-wrap: wrap; }
  .label { display: inline-flex; gap: 6px; align-items: baseline; color: var(--muted); }
  .label select { font: inherit; padding: 2px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--text); }
  .study { display: grid; grid-template-columns: 1fr minmax(260px, 32%); gap: 16px; align-items: start; }
  .study:has(:global(.notes.folded)) { grid-template-columns: 1fr auto; }
  .main { min-width: 0; }
  .notice { background: var(--warn-soft); color: var(--warn); padding: 6px 10px; border-radius: 6px; margin: 0 0 12px; }
  nav { display: flex; gap: 2px; border-bottom: 1px solid var(--line); margin-bottom: 14px; flex-wrap: wrap; }
  nav button { border: 0; background: none; padding: 8px 12px; color: var(--muted); border-bottom: 2px solid transparent; margin-bottom: -1px; }
  nav button.active { color: var(--text); border-bottom-color: var(--accent); font-weight: 500; }
  .box { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; margin-bottom: 14px; }
  .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 4px; }
  .tiles div { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; display: grid; gap: 2px; }
  .tiles strong { font-size: 16px; font-variant-numeric: tabular-nums; }
  .tiles + p { margin: 0 0 14px; }
  .pairs { display: grid; grid-template-columns: 1fr auto; gap: 4px 16px; margin: 0 0 6px; }
  .pairs dt { color: var(--text); }
  .pairs dd { margin: 0; }
  .source { display: block; }
  .aside { margin-left: 8px; }
  .groups { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px 24px; }
  .groups h4 { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 6px; }
  .groups .pairs { border-top: 1px solid var(--line); padding-top: 6px; }
</style>
