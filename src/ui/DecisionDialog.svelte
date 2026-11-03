<script lang="ts">
  /**
   * "Where do you stand now?" (§11.8 step 3.4). One click: his current label
   * is already chosen. The comment is optional but asked for. A sale must say
   * whether it was chosen or forced — that alone changes what looking back
   * shows (§8.4) — so it is the one choice from a list.
   */
  import { LABELS, type Label, type Sold } from '../notes/document.ts';
  import type { Decision } from '../notes/store.ts';

  let { label, sale = 'ask', onConfirm, onCancel }: {
    /** His label now — chosen to begin with. */
    label: Label;
    /** 'had_to': Confirm sold on an ineligible holding, the sale already decided. */
    sale?: 'ask' | 'had_to';
    /** Resolves to the reason when refused, or null. */
    onConfirm: (d: Decision) => Promise<string | null>;
    onCancel: () => void;
  } = $props();

  // The label he has when the dialog opens.
  // svelte-ignore state_referenced_locally
  let stance = $state<Label>(label);
  let soldIt = $state(false);
  let how = $state<Sold | null>(null);
  let comment = $state('');
  let error = $state('');
  let saving = $state(false);

  async function confirm(e: SubmitEvent) {
    e.preventDefault();
    error = '';
    const sold: Sold | null = sale === 'had_to' ? 'had_to' : soldIt ? how : null;
    if (sale === 'ask' && soldIt && !how) {
      error = 'Say whether you chose to sell or had to — it decides what looking back shows.';
      return;
    }
    saving = true;
    try {
      error = (await onConfirm({ stance, sold, comment })) ?? '';
    } catch (err) {
      error = String(err);
    } finally {
      saving = false;
    }
  }
</script>

<form class="decision" onsubmit={confirm}>
  <h4>Where do you stand now?</h4>
  <div class="labels" role="radiogroup">
    {#each LABELS as [value, name] (value)}
      <label class:chosen={stance === value}><input type="radio" bind:group={stance} {value} />{name}</label>
    {/each}
  </div>

  {#if sale === 'had_to'}
    <p class="small">Sold — had to: no longer eligible to hold.</p>
  {:else}
    <label class="small"><input type="checkbox" bind:checked={soldIt} onchange={() => (error = '')} /> I sold it</label>
    {#if soldIt}
      <div class="how small">
        <label><input type="radio" bind:group={how} value="chose" onchange={() => (error = '')} /> I chose to</label>
        <label><input type="radio" bind:group={how} value="had_to" onchange={() => (error = '')} /> I had to — no longer eligible to hold</label>
      </div>
    {/if}
  {/if}

  <label class="why small"><span>Why? <span class="muted">(optional, recommended)</span></span>
    <textarea bind:value={comment} rows="3"
      onkeydown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}></textarea>
  </label>
  {#if error}<p class="error small">{error}</p>{/if}
  <div class="buttons">
    <button type="submit" class="primary" disabled={saving}>{saving ? 'Saving…' : 'Confirm'}</button>
    <button type="button" class="link" onclick={onCancel}>Cancel</button>
    <span class="key">or ⌘ Enter</span>
  </div>
</form>

<style>
  .decision { border: 1px solid var(--accent); border-radius: 8px; padding: 10px 12px; display: grid; gap: 8px; background: var(--surface); }
  h4 { margin: 0; font-size: 13px; }
  .labels { display: flex; flex-wrap: wrap; gap: 4px; }
  .labels label { border: 1px solid var(--line); border-radius: 6px; padding: 3px 8px; font-size: 12px; cursor: pointer; }
  .labels label.chosen { background: var(--accent-soft); color: var(--accent); border-color: transparent; font-weight: 500; }
  .labels input { position: absolute; opacity: 0; pointer-events: none; }
  .how { display: grid; gap: 2px; padding-left: 20px; }
  .why { display: grid; gap: 4px; color: var(--text); }
  textarea { width: 100%; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--text); font: inherit; resize: vertical; }
  .error { color: var(--bad); margin: 0; }
  .buttons { display: flex; gap: 12px; align-items: center; }
  .primary { padding: 5px 14px; border: 0; border-radius: 6px; background: var(--accent); color: var(--surface); }
  .primary:disabled { opacity: 0.6; }
  .key { color: var(--muted); font-size: 11px; }
  .link { border: 0; background: none; color: var(--muted); text-decoration: underline; padding: 0; }
  p { margin: 0; }
</style>
