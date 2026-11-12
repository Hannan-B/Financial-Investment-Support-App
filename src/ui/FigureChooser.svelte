<script lang="ts">
  /**
   * Which figures the History tab shows (§11.9 step 4.1, as asked on
   * 2026-11-12): every figure, each with its own tick, in groups and
   * sub-groups whose ticks cover everything under them. Two views — what every
   * company shows, and what this company adds back. Hidden, never deleted.
   */
  import type { Backend } from './backend.ts';
  import type { Choices } from '../research/history.ts';
  import { figureName } from '../research/names.ts';
  import { grouped } from './history.ts';

  let { backend, isin, company, known, choices, onClose, onApplied }: {
    backend: Backend;
    isin: string;
    company: string;
    /** Every figure any refresh has saved. */
    known: readonly string[];
    choices: Choices;
    onClose: () => void;
    onApplied: (c: Choices) => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let hidden = $state(new Set(choices.hidden));
  // svelte-ignore state_referenced_locally
  let extra = $state(new Set(choices.extra));
  let scope = $state<'all' | 'one'>('all');
  let query = $state('');
  let open = $state(new Set<string>());
  let saving = $state(false);
  let error = $state('');

  const tree = $derived(grouped(known, (p) => p));
  const all = $derived(tree.flatMap((g) => g.subs.flatMap((s) => s.items)));
  const ticked = (p: string) => (scope === 'all' ? !hidden.has(p) : !hidden.has(p) || extra.has(p));
  /** In "this company" view, a figure every company already shows cannot be changed here. */
  const locked = (p: string) => scope === 'one' && !hidden.has(p);
  const matches = (p: string) => !query.trim() || figureName(p).toLowerCase().includes(query.trim().toLowerCase());
  const count = (paths: readonly string[]) => paths.filter(ticked).length;

  function set(paths: readonly string[], on: boolean) {
    const h = new Set(hidden);
    const x = new Set(extra);
    for (const p of paths) {
      if (locked(p)) continue;
      if (scope === 'all') { if (on) h.delete(p); else h.add(p); }
      else if (on) x.add(p); else x.delete(p);
    }
    hidden = h;
    extra = x;
  }
  const toggleOpen = (k: string) => (open = new Set(open.has(k) ? [...open].filter((x) => x !== k) : [...open, k]));

  /** Ticked, unticked, or a dash when only some below are ticked. */
  function tri(el: HTMLInputElement, paths: () => readonly string[]) {
    $effect(() => {
      const n = count(paths());
      el.checked = n === paths().length;
      el.indeterminate = n > 0 && n < paths().length;
    });
  }

  async function apply() {
    saving = true;
    error = '';
    try {
      const c = { hidden: [...hidden], extra: [...extra].filter((p) => hidden.has(p)) };
      await backend.saveHistoryChoices(isin, c);
      onApplied(c);
    } catch (e) {
      error = String(e);
    } finally {
      saving = false;
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="back" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
  <div class="dialog" role="dialog" aria-label="Choose figures for History">
    <h2>Choose figures for History</h2>
    <p class="small muted">Hidden figures are still saved at every refresh. Show one again at any time and its full history is there.</p>

    <div class="scope">
      <button class:on={scope === 'all'} onclick={() => (scope = 'all')}>All companies</button>
      <button class:on={scope === 'one'} onclick={() => (scope = 'one')}>Extra for {company} only</button>
    </div>
    <p class="small muted">
      {scope === 'all' ? 'What every company shows.' : `Figures hidden for every company that you want back for ${company}. Those every company shows are greyed out here.`}
    </p>

    <div class="tools">
      <input type="search" bind:value={query} placeholder="Find a figure" />
      <button class="link small" onclick={() => set(all, true)}>Tick all</button>
      <button class="link small" onclick={() => set(all, false)}>Untick all</button>
      <span class="small muted">{count(all)} of {all.length} figures shown{scope === 'one' ? ` for ${company}` : ''}</span>
    </div>

    <ul class="tree">
      {#each tree as g (g.title)}
        {@const paths = g.subs.flatMap((s) => s.items)}
        {#if paths.some(matches) || !query.trim()}
          {@const isOpen = open.has(g.title) || !!query.trim()}
          <li>
            <div class="row">
              <button class="fold" onclick={() => toggleOpen(g.title)} aria-label={isOpen ? 'Close' : 'Open'}>{isOpen ? '▾' : '▸'}</button>
              <label class="group"><input type="checkbox" use:tri={() => paths} disabled={paths.every(locked)} onchange={(e) => set(paths, e.currentTarget.checked)} /> {g.title}</label>
              <span class="small muted">{count(paths)} of {paths.length}{g.note ? ` · ${g.note}` : ''}</span>
            </div>
            {#if isOpen}
              <ul>
                {#each g.subs as s (s.title)}
                  {#if s.title === null}
                    {#each s.items.filter(matches) as p (p)}
                      <li class="row figure">
                        <label class:locked={locked(p)}><input type="checkbox" checked={ticked(p)} disabled={locked(p)} onchange={(e) => set([p], e.currentTarget.checked)} /> {figureName(p)}</label>
                        {#if locked(p)}<span class="small muted">shown for all</span>{/if}
                      </li>
                    {/each}
                  {:else if s.items.some(matches)}
                    {@const key = `${g.title}/${s.title}`}
                    {@const subOpen = open.has(key) || !!query.trim()}
                    <li>
                      <div class="row">
                        <button class="fold" onclick={() => toggleOpen(key)} aria-label={subOpen ? 'Close' : 'Open'}>{subOpen ? '▾' : '▸'}</button>
                        <label><input type="checkbox" use:tri={() => s.items} disabled={s.items.every(locked)} onchange={(e) => set(s.items, e.currentTarget.checked)} /> {s.title}</label>
                        <span class="small muted">{count(s.items)} of {s.items.length}</span>
                      </div>
                      {#if subOpen}
                        <ul>
                          {#each s.items.filter(matches) as p (p)}
                            <li class="row figure">
                              <label class:locked={locked(p)}><input type="checkbox" checked={ticked(p)} disabled={locked(p)} onchange={(e) => set([p], e.currentTarget.checked)} /> {figureName(p)}</label>
                              {#if locked(p)}<span class="small muted">shown for all</span>{/if}
                            </li>
                          {/each}
                        </ul>
                      {/if}
                    </li>
                  {/if}
                {/each}
              </ul>
            {/if}
          </li>
        {/if}
      {/each}
    </ul>

    {#if error}<p class="small error">{error}</p>{/if}
    <footer>
      <button class="secondary" onclick={onClose}>Cancel</button>
      <button class="primary" onclick={apply} disabled={saving}>{saving ? 'Saving…' : 'Apply'}</button>
    </footer>
  </div>
</div>

<style>
  .back { position: fixed; inset: 0; background: rgb(0 0 0 / 0.3); display: flex; align-items: flex-start; justify-content: center; padding-top: 60px; z-index: 20; }
  .dialog { background: var(--surface); color: var(--text); border: 1px solid var(--line); border-radius: 10px; width: min(580px, calc(100vw - 32px)); max-height: calc(100vh - 100px); overflow: auto; padding: 16px 18px; }
  h2 { font-size: 16px; margin-bottom: 4px; }
  p { margin: 0 0 8px; }
  .scope { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; padding: 3px; margin: 8px 0 6px; }
  .scope button { border: 0; background: none; padding: 4px 10px; border-radius: 6px; color: var(--muted); }
  .scope button.on { background: var(--accent-soft); color: var(--text); }
  .tools { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
  .tools input { flex: 1; min-width: 160px; padding: 5px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--text); }
  .link { border: 0; background: none; color: var(--muted); text-decoration: underline; padding: 0; }
  .tree, .tree ul { list-style: none; padding: 0; margin: 0; }
  .tree ul { padding-left: 24px; margin: 2px 0 4px; }
  .tree li { padding: 2px 0; }
  .row { display: flex; gap: 6px; align-items: baseline; }
  .figure { padding-left: 22px; }
  .fold { width: 16px; border: 0; background: none; color: var(--muted); padding: 0; }
  label { display: inline-flex; gap: 8px; align-items: baseline; }
  label.group { font-weight: 600; }
  label.locked { color: var(--muted); }
  footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  .primary { padding: 6px 16px; border: 0; border-radius: 6px; background: var(--accent); color: var(--surface); }
  .primary:disabled { opacity: 0.6; }
  .secondary { padding: 5px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--text); }
  .error { color: var(--bad); }
</style>
