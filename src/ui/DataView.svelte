<script lang="ts">
  /**
   * Your data (§12.1, §12.2, §11.8 step 3.6): export everything written, to
   * read anywhere, and the daily copies the app keeps of itself — the last
   * ten days it was used, on this Mac only — with a way to put one back.
   */
  import type { Backend, DailyCopy } from './backend.ts';
  import { day } from './format.ts';

  let { backend }: { backend: Backend } = $props();

  let exporting = $state(false);
  let exported = $state<{ where: string; files: number } | null>(null);
  let copies = $state<readonly DailyCopy[] | null>(null);
  let restoring = $state<string | null>(null);
  let error = $state('');

  $effect(() => { void backend.backups().then((c) => (copies = c)).catch((e) => (error = String(e))); });

  async function exportNotes() {
    exporting = true;
    error = '';
    try { exported = await backend.exportNotes(); } catch (e) { error = String(e); } finally { exporting = false; }
  }
  async function restore(d: string) {
    error = '';
    try {
      await backend.restore(d);
      location.reload();
    } catch (e) {
      error = String(e);
      restoring = null;
    }
  }
  const size = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
</script>

<section class="box">
  <h2>Export your notes</h2>
  <p class="small muted">Everything you have written — notes, decisions, labels and ineligible markers — as Markdown files: one per company and a contents page. They open in any text editor, on any computer, without the app. They are for reading; the daily copies below are what can be put back.</p>
  <button class="primary" onclick={exportNotes} disabled={exporting}>{exporting ? 'Exporting…' : 'Export my notes'}</button>
  {#if exported}<p class="small ok">Saved {exported.files} {exported.files === 1 ? 'file' : 'files'} to {exported.where}.</p>{/if}
</section>

<section class="box">
  <h2>Daily copies</h2>
  <p class="small muted">The first time the app opens each day, it copies all its data. The last ten days you used it are kept, on this Mac only. Putting one back sets today's data aside first, so choosing the wrong day loses nothing.</p>
  {#if copies === null}
    <p class="small muted">Looking…</p>
  {:else if copies.length === 0}
    <p class="small muted">None yet — the first is made the next time the app opens.</p>
  {:else}
    <table>
      <tbody>
        {#each copies as c (c.day)}
          <tr>
            <td>{day(c.day)}</td>
            <td class="num muted">{size(c.bytes)}</td>
            <td class="num">
              {#if restoring === c.day}
                <span class="small">Put back the data as it was on {day(c.day)}? Today's is set aside first.</span>
                <button class="link danger" onclick={() => restore(c.day)}>Put it back</button>
                <button class="link" onclick={() => (restoring = null)}>Cancel</button>
              {:else}
                <button class="link" onclick={() => (restoring = c.day)}>Put this back…</button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>
{#if error}<p class="error small">{error}</p>{/if}

<style>
  .box { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; margin-bottom: 14px; display: grid; gap: 8px; justify-items: start; }
  h2 { font-size: 16px; }
  p { margin: 0; max-width: 680px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 6px 8px; border-bottom: 1px solid var(--line); }
  td.num { text-align: right; }
  .primary { padding: 6px 16px; border: 0; border-radius: 6px; background: var(--accent); color: var(--surface); }
  .primary:disabled { opacity: 0.6; }
  .link { border: 0; background: none; color: var(--accent); text-decoration: underline; padding: 0; font: inherit; margin-left: 8px; }
  .link.danger { color: var(--bad); }
  .ok { color: var(--accent); }
  .error { color: var(--bad); }
</style>
