<script lang="ts">
  /**
   * Refresh all Watching's two progress bars (§11.9 step 4.5): across the
   * companies, and within the one being refreshed. Shown on every screen
   * while it runs; afterwards, what happened to each, until dismissed.
   */
  import { refreshAll } from './refresh-all.svelte.ts';

  const r = refreshAll;
  const across = $derived(r.total ? (r.done + (r.step ? r.step.done / r.step.total : 0)) / r.total : 0);
  const within = $derived(r.step ? r.step.done / r.step.total : 0);
</script>

{#if r.running || r.results.length}
  <section class="progress" aria-live="polite">
    {#if r.running}
      <div class="line">
        <strong>Refreshing your Watching companies</strong>
        <span class="small muted">{r.done} of {r.total} done — you can keep using the app</span>
      </div>
      <div class="bar" title="All companies"><span style:width="{across * 100}%"></span></div>
      {#if r.current}
        <div class="line small">
          <span>{r.current}</span>
          <span class="muted">{r.step ? `${r.step.what} (${r.step.done + 1} of ${r.step.total})` : 'starting'}</span>
        </div>
        <div class="bar thin" title={r.current}><span style:width="{within * 100}%"></span></div>
      {/if}
    {:else}
      <div class="line">
        <strong>Watching companies refreshed</strong>
        <button class="link small" onclick={() => r.dismiss()}>Close</button>
      </div>
    {/if}
    {#if r.results.length}
      <ul class="small">
        {#each r.results as x (x.listingId)}
          <li>
            {x.kind === 'saved' ? '✓' : '✗'} {x.name}
            {#if x.kind === 'saved' && !x.detail}<span class="muted">— done</span>
            {:else if x.kind === 'saved'}<span class="muted">— saved; {x.detail}</span>
            {:else}<span class="bad">— {x.kind === 'refused' ? 'nothing saved' : 'could not refresh'}: {x.detail}</span>{/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .progress { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; display: grid; gap: 6px; }
  .line { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
  .bar { height: 8px; background: var(--bg); border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
  .bar.thin { height: 5px; }
  .bar span { display: block; height: 100%; background: var(--accent); transition: width 0.3s; }
  ul { margin: 2px 0 0; padding-left: 0; list-style: none; display: grid; gap: 2px; }
  .bad { color: var(--bad); }
  .link { border: 0; background: none; color: var(--muted); text-decoration: underline; padding: 0; }
</style>
