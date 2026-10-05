<script lang="ts">
  /**
   * One company: the Study view (§6.1). Notes keep ~30% of the width from
   * the start — they arrive in Phase 3 — and the tabs hold the panels.
   * Every panel is shown or collapsed with its reason; none is left blank.
   */
  import type { Backend } from './backend.ts';
  import type { ReportData } from '../research/report.ts';
  import type { CompanyRefresh } from '../research/company.ts';
  import type { Fact } from '../research/figures.ts';
  import { sma, indicators } from '../research/technicals.ts';
  import { price, big, num, day, when, exchangeName } from './format.ts';
  import Panel from './Panel.svelte';
  import PriceChart from './PriceChart.svelte';
  import FiguresTable from './FiguresTable.svelte';
  import TechnicalsView from './TechnicalsView.svelte';
  import NewsView from './NewsView.svelte';
  import { FINVIZ_NAMES } from '../research/finviz.ts';

  let { backend, listingId, onBack }: { backend: Backend; listingId: number; onBack: () => void } = $props();

  type Tab = 'overview' | 'financials' | 'technicals' | 'news' | 'calendar' | 'history';
  const TABS: [Tab, string][] = [['overview', 'Overview'], ['financials', 'Financials'], ['technicals', 'Technicals'],
    ['news', 'News & Filings'], ['calendar', 'Calendar'], ['history', 'History']];
  let tab = $state<Tab>('overview');
  let report = $state<ReportData | null>(null);
  let failed = $state('');
  let refreshing = $state(false);
  let outcome = $state<CompanyRefresh | null>(null);

  async function load() {
    try { report = await backend.loadReport(listingId); } catch (e) { failed = String(e); }
  }
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

  const LABELS: Record<string, string> = {
    ...FINVIZ_NAMES,
    'calendar.next_earnings': 'Next results',
    'calendar.last_ex_dividend': 'Last ex-dividend date',
  };
  /** Percentages that are a change, so a rise shows its sign: growth, surprises, price performance. */
  const CHANGES = /^(performance\.|analyst\.eps_growth|ttm\..*(growth|surprise)|dividend\.growth|trading\.(below|above)_|ownership\..*_change_pct$)/;
  function value(f: Fact): string {
    const v = f.value;
    if (typeof v === 'string') return f.unit === 'date' ? day(v) : v;
    switch (f.unit) {
      case 'percent': return `${v > 0 && CHANGES.test(f.fieldPath) ? '+' : ''}${num(v, 2)}%`;
      case 'ratio': return num(v, 2);
      case 'days': return `${num(v, 1)} days`;
      case 'rating': return `${num(v, 2)} — 1 is strong buy, 5 strong sell`;
      case 'count': return v.toLocaleString('en-GB');
      case 'shares': return `${big(v, null)} shares`;
      default:
        if (!f.currency) return num(v);
        return f.unit.endsWith('/share') ? price(v, f.currency) : big(v, f.currency);
    }
  }
  const SOURCE_NAMES: Record<string, string> = {
    'yahoo-prices': 'Prices (Yahoo)', edgar: 'Figures (SEC filings)', stockanalysis: 'Figures (stockanalysis)', finviz: 'Finviz',
    'sec-filings': 'Filings (SEC)', investegate: 'Announcements (Investegate)', 'google-news': 'Press (Google News)',
    'official-announcements': 'Official announcements', news: 'News',
  };
  const latestOf = (f: ReportData['figures'], concept: string) => {
    if (f.kind !== 'ok') return null;
    const row = f.data.rows.find((r) => r.concept === concept);
    return [...(row?.cells ?? [])].reverse().find((c) => c !== null) ?? null;
  };
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
      <h1>{s.name}</h1>
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
    </div>
    <div class="actions">
      <button class="primary" onclick={refresh} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>
      {#if refreshing}
        <span class="small muted">Prices, figures, then news. Up to about a minute — the first time collects 180 days of headlines.</span>
      {/if}
      {#if report.snapshot}
        <span class="small muted">
          {#each report.snapshot.sources as o, i (o.source)}{i ? ' · ' : ''}{SOURCE_NAMES[o.source] ?? o.source}: {o.outcome === 'ok' ? 'ok' : o.outcome.replace('-', ' ')}{/each}
        </span>
      {/if}
    </div>
  </header>

  {#if outcome?.kind === 'refused'}
    <div class="banner bad"><strong>Nothing saved.</strong> {outcome.reason}. The report shows the last good refresh.</div>
  {:else if problems.length}
    <div class="banner warn">
      {#each problems as p (p.source)}<div><strong>{SOURCE_NAMES[p.source] ?? p.source}</strong> — {p.outcome === 'suspect' ? 'data rejected' : 'did not answer'}: {p.detail}</div>{/each}
    </div>
  {/if}

  <div class="study">
    <aside class="notes">
      <h3>Notes</h3>
      <p class="small muted">Your notes on {s.name} will live here, newest first, each tied to the figures it was written against. They arrive in Phase 3; the space is kept so the layout does not change when they do.</p>
    </aside>

    <div class="main">
      <nav>
        {#each TABS as [k, label] (k)}<button class:active={tab === k} onclick={() => (tab = k)}>{label}</button>{/each}
      </nav>

      {#if tab === 'overview'}
        <section class="box">
          {#if bars.length}
            <PriceChart dates={bars.map((b) => b.date)} closes={bars.map((b) => b.close)} {currency} {overlays} />
          {:else}<p class="muted">No prices stored yet.</p>{/if}
        </section>

        {#if key}
          <section class="tiles">
            {#each [key.rsi, key.sma[1], key.sma[2], key.atr] as r (r?.kind === 'ok' ? r.working.indicator : r?.indicator)}
              {#if r}
                <div>
                  <span class="small muted">{r.kind === 'ok' ? r.working.indicator : r.indicator}</span>
                  {#if r.kind === 'ok'}
                    {@const v = r.working.result.at(-1)!.value}
                    <strong>{r.working.unit === currency ? price(v, currency) : num(v)}</strong>
                  {:else}<span class="muted small">needs {r.needed} days</span>{/if}
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
                <dt>{f.rows.find((r) => r.concept === concept)?.name} {#if c}<span class="muted small">{c.period}</span>{/if}</dt>
                <dd class="num">{c ? value(c) : '—'}</dd>
              {/each}
            </dl>
            <button class="link small" onclick={() => (tab = 'financials')}>All figures →</button>
          {/snippet}
        </Panel>

        <Panel title="Analyst predictions" label="Other people's forecasts — not facts" panel={report.predictions}>
          {#snippet children(list)}
            <dl class="pairs">{#each list as f (f.fieldPath)}<dt>{LABELS[f.fieldPath] ?? f.fieldPath}</dt><dd class="num">{value(f)}</dd>{/each}</dl>
            <p class="small muted">Kept with each refresh, so later they can be set against what actually happened.</p>
          {/snippet}
        </Panel>

        <Panel title="Key statistics" panel={report.keyStats}>
          {#snippet children(groups)}
            <p class="small muted">From Finviz, as of the last refresh. Twelve-month figures are kept apart from the fiscal years in Financials.</p>
            <div class="groups">
              {#each groups as g (g.title)}
                <section>
                  <h4>{g.title}</h4>
                  <dl class="pairs small">{#each g.facts as f (f.fieldPath)}<dt>{LABELS[f.fieldPath] ?? f.fieldPath}</dt><dd class="num">{value(f)}</dd>{/each}</dl>
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

      {:else if tab === 'calendar'}
        <Panel title="Dates" panel={report.calendar}>
          {#snippet children(c)}
            <dl class="pairs">
              {#each c.facts as f (f.fieldPath)}
                <dt>{LABELS[f.fieldPath] ?? f.fieldPath}{#if f.kind === 'estimate'} <span class="muted small">scheduled — can move</span>{/if}</dt>
                <dd class="num">{value(f)}</dd>
              {/each}
              {#each c.gaps as g (g.fieldPath)}<dt>{LABELS[g.fieldPath] ?? g.fieldPath}</dt><dd class="muted">{g.reason}</dd>{/each}
            </dl>
          {/snippet}
        </Panel>

      {:else}
        <Panel title="History" panel={{ kind: 'collapsed', reason: 'Arrives in Phase 4 — every refresh is already being kept for it' }}>
          {#snippet children()}{/snippet}
        </Panel>
      {/if}
    </div>
  </div>
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
  .error { color: var(--bad); }
  .study { display: grid; grid-template-columns: minmax(220px, 30%) 1fr; gap: 16px; align-items: start; }
  .main { min-width: 0; }
  .notes { background: var(--surface); border: 1px dashed var(--line); border-radius: 8px; padding: 14px; position: sticky; top: 12px; }
  .notes h3 { font-size: 14px; margin-bottom: 6px; }
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
  .groups { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px 24px; }
  .groups h4 { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 6px; }
  .groups .pairs { border-top: 1px solid var(--line); padding-top: 6px; }
</style>
