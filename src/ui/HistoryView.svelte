<script lang="ts">
  /**
   * The History tab (§11.9 steps 4.1–4.3, as settled 2026-11-12): every
   * figure at his last checks and now, with the change between each, since
   * the last check, and since the oldest shown. A check is each Review
   * complete; its date opens that review in the notes. A switch adds the
   * refreshes in between. Facts only — rises and falls are not coloured,
   * since a rise is not always good news.
   */
  import type { Backend } from './backend.ts';
  import type { HistoryFacts, Choices } from '../research/history.ts';
  import { shows } from '../research/history.ts';
  import type { Entry } from '../notes/document.ts';
  import { LABEL_NAMES, SOLD_NAMES } from '../notes/document.ts';
  import { checksOf, columns, rows, grouped, type Cell, type Change, type Column } from './history.ts';
  import { day, factValue } from './format.ts';
  import FigureChooser from './FigureChooser.svelte';

  let { backend, isin, company, entries, refreshedAt, onOpenReview }: {
    backend: Backend;
    isin: string;
    company: string;
    entries: readonly Entry[];
    /** The report's latest refresh: when it moves, the history is read again. */
    refreshedAt: string | null;
    onOpenReview: (round: number) => void;
  } = $props();

  let facts = $state<HistoryFacts | null>(null);
  let choices = $state<Choices>({ hidden: [], extra: [] });
  let known = $state<readonly string[]>([]);
  let error = $state('');
  let everyRefresh = $state(false);
  let checksShown = $state(5);
  let choosing = $state(false);
  let closed = $state(new Set<string>());

  async function load() {
    error = '';
    try {
      [facts, choices, known] = await Promise.all([backend.history(isin), backend.historyChoices(isin), backend.knownFigures()]);
    } catch (e) {
      error = String(e);
    }
  }
  $effect(() => { void isin; void refreshedAt; void load(); });

  const checks = $derived(checksOf(entries));
  const laid = $derived(facts ? columns(facts, checks, { everyRefresh, checks: checksShown }) : null);
  const cols = $derived(laid?.columns ?? []);
  const table = $derived(facts && laid ? grouped(rows(facts, cols, (p) => shows(choices, p)), (r) => r.path) : []);
  const hasNow = $derived(cols.some((c) => c.now));
  /** "Since last check" needs a refresh after it. */
  const hasLastCheck = $derived(hasNow && cols.some((c) => c.lastCheck));
  const oldest = $derived(cols[0]);
  const lastCheck = $derived(cols.find((c) => c.lastCheck));
  const newest = $derived(cols.at(-1));
  const span = $derived(cols.length + 1 + (hasLastCheck ? 1 : 0) + (cols.length > 1 ? 1 : 0));

  const when = (c: Column) => (c.check ? c.check.at : c.snapshot?.capturedAt ?? '');
  const what = (c: Column) => c.now ? 'now' : c.lastCheck ? 'last check' : c.check ? 'check' : 'refresh';
  const toggle = (k: string) => (closed = new Set(closed.has(k) ? [...closed].filter((x) => x !== k) : [...closed, k]));
  const changeText = (c: Change | null) => c ? c.text : '';
</script>

{#snippet value(cell: Cell, before: Cell | undefined)}
  {#if cell.fact}
    <span class="v">{factValue(cell.fact)}</span>
    {#if cell.fact.period}<span class="yr">{cell.fact.period}</span>{/if}
    {#if cell.fact.kind === 'estimate' && cell.fact.unit === 'date'}<span class="est">expected — can move</span>{/if}
  {:else}
    <!-- The reason once per run of the same reason; hovering any dash gives it again. -->
    <span class="v muted" title={cell.missing}>—</span>
    {#if before?.missing !== cell.missing}<span class="why">{cell.missing}</span>{/if}
  {/if}
  {#if cell.step}<span class="step">{cell.step.text}{#if cell.step.periods}<span class="yrs">{cell.step.periods}</span>{/if}</span>{/if}
  {#each cell.revised as r (r.period)}
    <span class="flag">↺ {r.period} revised: {factValue(r.from)} → {factValue(r.to)}</span>
  {/each}
{/snippet}

{#if error}
  <p class="error small">{error}</p>
{:else if !facts}
  <p class="muted">Reading the saved refreshes…</p>
{:else if facts.snapshots.length === 0}
  <p class="muted">Not refreshed yet — press Refresh. Every refresh is kept, so the history starts with the first.</p>
{:else}
  <div class="toolbar">
    <p>
      {#if checks.length === 0}
        No checks yet. <span class="muted small">A check is each time you press Review complete in your notes; until then this shows now{everyRefresh ? ' and every refresh' : ''}.</span>
      {:else}
        {@const n = Math.min(checksShown, checks.length)}
        {n === 1 ? 'Your last check' : `Your last ${n} checks`}{hasNow ? ' and now' : ''}.
        {#if !hasNow}<span class="small">No refresh since your last check — press Refresh to see what has changed.</span>{/if}
        <span class="muted small">A check is each time you pressed Review complete. Click its date to open that review.</span>
      {/if}
    </p>
    <div class="tools">
      {#if laid && laid.earlier > 0}
        <button class="secondary" onclick={() => (checksShown += 5)}>Show earlier checks ({laid.earlier})</button>
      {/if}
      <label class="small"><input type="checkbox" bind:checked={everyRefresh} /> Show every refresh, not only my checks</label>
      <button class="secondary" onclick={() => (choosing = true)}>Choose figures…</button>
    </div>
  </div>

  <div class="box scroll">
    <table>
      <thead>
        <tr>
          <th class="figure">Figure</th>
          {#each cols as c, i (i)}
            <th class:last={c.lastCheck} class="num">
              {#if c.check}
                <button class="date" onclick={() => onOpenReview(c.check!.round)} title="Open this review in your notes">{day(when(c))}</button>
              {:else}<span class="date">{day(when(c))}</span>{/if}
              <span class="what">{what(c)}</span>
              {#if c.check}<span class="stance">{LABEL_NAMES[c.check.stance]}{c.check.sold ? ` · sold, ${SOLD_NAMES[c.check.sold]}` : ''}</span>{/if}
            </th>
          {/each}
          {#if hasLastCheck}<th class="num change"><span class="date">Since last check</span><span class="what">{lastCheck ? day(when(lastCheck)) : ''} → now</span></th>{/if}
          {#if cols.length > 1}<th class="num change"><span class="date">Since oldest shown</span><span class="what">{oldest ? day(when(oldest)) : ''} → {hasNow ? 'now' : newest ? day(when(newest)) : ''}</span></th>{/if}
        </tr>
      </thead>
      <tbody>
        {#each table as g (g.title)}
          <tr class="group">
            <th colspan={span}>
              <button class="fold" onclick={() => toggle(g.title)}>{closed.has(g.title) ? '▸' : '▾'} {g.title}</button>
              {#if g.note}<span class="note">{g.note}</span>{/if}
            </th>
          </tr>
          {#if !closed.has(g.title)}
            {#each g.subs as s (s.title)}
              {#if s.title}<tr class="sub"><th colspan={span}>{s.title}</th></tr>{/if}
              {#each s.items as r (r.path)}
                <tr class:indent={!!s.title}>
                  <td class="figure">{r.name}</td>
                  {#each r.cells as cell, i (i)}<td class="num" class:last={cols[i]?.lastCheck}>{@render value(cell, r.cells[i - 1])}</td>{/each}
                  {#if hasLastCheck}<td class="num change">{changeText(r.sinceLastCheck)}{#if r.sinceLastCheck?.periods}<span class="yrs">{r.sinceLastCheck.periods}</span>{/if}</td>{/if}
                  {#if cols.length > 1}<td class="num change">{changeText(r.sinceOldest)}{#if r.sinceOldest?.periods}<span class="yrs">{r.sinceOldest.periods}</span>{/if}</td>{/if}
                </tr>
              {/each}
            {/each}
          {/if}
        {:else}
          <tr><td colspan={span} class="muted">Every figure is hidden — Choose figures to show some.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>

  <div class="box legend small">
    <div><strong>How to read it.</strong> The small line under a value is the change since the column before.</div>
    <div>Amounts and prices change in <strong>%</strong>. Figures already in % (margins, yields, returns) change in <strong>points</strong>, so 24% → 26% is "+2.00 pts", not "+8%". P/E and other ratios change as a plain difference; RSI in points.</div>
    <div>Results carry their year; "same year" means no new results came out in between. ↺ marks an earlier year the company has since changed.</div>
    <div>Rises and falls are not coloured: a rise is not always good news.</div>
  </div>
{/if}

{#if choosing}
  <FigureChooser {backend} {isin} {company} {known} {choices} onClose={() => (choosing = false)}
    onApplied={(c) => { choices = c; choosing = false; }} />
{/if}

<style>
  .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
  .toolbar p { margin: 0; }
  .tools { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .tools label { display: inline-flex; gap: 6px; align-items: center; }
  .secondary { padding: 5px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--text); }
  .box { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; margin-bottom: 14px; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  thead th { font-weight: 500; }
  td.figure, th.figure { text-align: left; min-width: 150px; }
  .date { display: block; white-space: nowrap; }
  button.date { border: 0; background: none; padding: 0; margin-left: auto; color: var(--accent); text-decoration: underline; font: inherit; font-weight: 500; }
  .what, .stance { display: block; font-weight: 400; font-size: 12px; color: var(--muted); white-space: nowrap; }
  .last { background: var(--accent-soft); }
  .change { border-left: 1px solid var(--line); white-space: normal; min-width: 100px; }
  /* Long words (a rating with its scale, a list of indices) wrap rather than widen the whole column. */
  .v { display: block; white-space: normal; max-width: 150px; margin-left: auto; }
  .yr, .yrs, .est, .why { display: block; font-size: 11px; color: var(--muted); }
  .why { white-space: normal; max-width: 160px; margin-left: auto; }
  .step { display: block; font-size: 12px; color: var(--muted); white-space: normal; }
  .flag { display: block; font-size: 11px; color: var(--warn); white-space: normal; max-width: 160px; margin-left: auto; }
  tr.group th { text-align: left; padding-top: 14px; }
  .fold { border: 0; background: none; padding: 0; font: inherit; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .note { font-size: 12px; color: var(--muted); margin-left: 8px; }
  tr.sub th { text-align: left; font-size: 12px; font-weight: 500; color: var(--muted); padding-left: 22px; }
  tr.indent td.figure { padding-left: 22px; }
  .legend { display: grid; gap: 4px; padding: 12px 16px; }
  .error { color: var(--bad); }
</style>
