<script lang="ts">
  /**
   * The ineligible marker on a holding (§8.4, §11.8 step 3.5): a plain
   * statement of his own record — no badge, no count, no urgency. Optional
   * sell-by date, "by the next results" filled in once from the Calendar.
   * Confirm sold records the sale as "had to" in his notes; clearing the
   * marker needs a written reason, and both dates are kept.
   */
  import type { Backend } from './backend.ts';
  import type { Mark, SellBy, Done, Refused } from '../notes/store.ts';
  import type { Label } from '../notes/document.ts';
  import { day } from './format.ts';
  import DecisionDialog from './DecisionDialog.svelte';

  let { backend, isin, mark, label, marking = $bindable(false), onChanged }: {
    backend: Backend;
    isin: string;
    mark: Mark | null;
    label: Label;
    /** The marking form is open — a right-click on the holding asked for it. */
    marking?: boolean;
    onChanged: () => Promise<void>;
  } = $props();

  let basis = $state<'none' | 'date' | 'next_results'>('none');
  let date = $state('');
  let note = $state('');
  let next = $state<{ date: string } | { reason: string } | null>(null);
  let confirming = $state(false);
  let clearing = $state(false);
  let reason = $state('');
  let error = $state('');
  /** Today, the Mac's own day: a sell-by date that has gone by is said plainly, nothing more. */
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

  $effect(() => {
    if (marking && next === null) void backend.nextResults(isin).then((n) => (next = n)).catch((e) => (next = { reason: String(e) }));
  });

  async function act(write: () => Promise<Done | Refused>, after: () => void) {
    error = '';
    try {
      const r = await write();
      if (r.kind === 'refused') { error = r.reason; return; }
      after();
      await onChanged();
    } catch (e) {
      error = String(e);
    }
  }
  function markIt() {
    const sellBy: SellBy | null = basis === 'date' ? { basis: 'date', date } : basis === 'next_results' ? { basis: 'next_results' } : null;
    return act(() => backend.markIneligible(isin, { sellBy, note }), () => { marking = false; note = ''; basis = 'none'; });
  }
</script>

{#if mark}
  <div class="marker small">
    <span>⚑ Ineligible since {day(mark.markedAt)}{#if mark.sellBy} · sell by {day(mark.sellBy)}{#if mark.sellByBasis === 'next_results'} (next results{mark.sellByExpected ? ', expected' : ''}){/if}{#if !mark.soldAt && mark.sellBy < today} — passed{/if}{/if}{mark.soldAt ? ` · sold ${day(mark.soldAt)}` : ' · still held'}</span>
    {#if mark.note}<span class="muted">— {mark.note}</span>{/if}
    {#if !confirming && !clearing}
      <span class="actions">
        {#if !mark.soldAt}<button class="link" onclick={() => (confirming = true)}>Confirm sold</button>{/if}
        <button class="link" onclick={() => (clearing = true)}>Clear the marker</button>
      </span>
    {/if}
  </div>
  {#if confirming}
    <DecisionDialog {label} sale="had_to"
      onConfirm={async (d) => { const r = await backend.confirmSold(isin, { stance: d.stance, comment: d.comment }); if (r.kind === 'refused') return r.reason; confirming = false; await onChanged(); return null; }}
      onCancel={() => (confirming = false)} />
  {/if}
  {#if clearing}
    <form class="form small" onsubmit={(e) => { e.preventDefault(); void act(() => backend.clearIneligible(isin, reason), () => { clearing = false; reason = ''; }); }}>
      <label><span>Why clear it? <span class="muted">(required — the marker and its dates are kept)</span></span><input bind:value={reason} /></label>
      <div class="buttons"><button type="submit" class="primary">Clear the marker</button><button type="button" class="link" onclick={() => (clearing = false)}>Keep it</button></div>
    </form>
  {/if}
{:else if marking}
  <form class="form small" onsubmit={(e) => { e.preventDefault(); void markIt(); }}>
    <strong>Mark as no longer eligible to hold</strong>
    <fieldset>
      <legend>Sell by <span class="muted">(optional)</span></legend>
      <label><input type="radio" bind:group={basis} value="none" /> No date</label>
      <label><input type="radio" bind:group={basis} value="date" /> A date <input type="date" bind:value={date} onfocus={() => (basis = 'date')} /></label>
      <label>
        <input type="radio" bind:group={basis} value="next_results" disabled={next !== null && 'reason' in next} /> By the next results
        <span class="muted">— {next === null ? 'looking…' : 'date' in next ? `${day(next.date)}, expected; set once, it does not follow later changes` : next.reason}</span>
      </label>
    </fieldset>
    <label><span>Note <span class="muted">(optional)</span></span><input bind:value={note} placeholder="e.g. Zoya: no longer compliant" /></label>
    <div class="buttons"><button type="submit" class="primary">Mark ineligible</button><button type="button" class="link" onclick={() => (marking = false)}>Cancel</button></div>
  </form>
{/if}
{#if error}<p class="error small">{error}</p>{/if}

<style>
  .marker { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; color: var(--warn); }
  .actions { display: inline-flex; gap: 10px; }
  .form { display: grid; gap: 8px; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin-top: 6px; background: var(--surface); max-width: 520px; }
  fieldset { border: 0; padding: 0; margin: 0; display: grid; gap: 4px; }
  legend { padding: 0; margin-bottom: 2px; }
  label { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; }
  .form > label { display: grid; gap: 3px; }
  input:not([type='radio']) { font: inherit; padding: 3px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); color: var(--text); }
  .buttons { display: flex; gap: 12px; align-items: center; }
  .primary { padding: 4px 12px; border: 0; border-radius: 6px; background: var(--accent); color: var(--surface); }
  .link { border: 0; background: none; color: var(--accent); text-decoration: underline; padding: 0; font: inherit; }
  .error { color: var(--bad); margin: 4px 0 0; }
</style>
