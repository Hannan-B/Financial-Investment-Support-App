<script lang="ts">
  /**
   * The notes document, on the right of the report (§11.8 step 3.1, as
   * set out on 2026-11-02): opening thoughts, comments on things on
   * screen in the tabs' order, concluding thoughts, Review complete — and on
   * later visits, more comments and a new conclusion after the last.
   *
   * It opens on the latest conclusion once a review is complete; an
   * unfinished one carries on where he left off. Edits and deletions keep the
   * earlier wording, one click away.
   */
  import type { Backend, NotesData } from './backend.ts';
  import type { Done, Refused } from '../notes/store.ts';
  import {
    filtered, openingFilter, reviewState, cannotCompleteReview, bodyOf,
    TABS, TAB_NAMES, LABEL_NAMES, SOLD_NAMES, type Entry, type Filter, type Tab, type Target,
  } from '../notes/document.ts';
  import { day } from './format.ts';
  import DecisionDialog from './DecisionDialog.svelte';
  import { tick } from 'svelte';

  let { backend, isin, company, data, snapshotId, draft = $bindable(), focus, review = null, wide = false, onGo, onSaved }: {
    backend: Backend;
    isin: string;
    company: string;
    data: NotesData;
    snapshotId: number | null;
    /** A comment being written, asked for by a right-click. */
    draft: { readonly tab: Tab; readonly target: Target | null } | null;
    /** Show the comment on this item. A new object each time. */
    focus: { readonly key: string } | null;
    /** Show this review, from a check's date on the History tab. A new object each time. */
    review?: { readonly round: number } | null;
    /** The tab needs the width (History): start folded, without changing what is remembered. */
    wide?: boolean;
    /** Takes him to what a comment is about. */
    onGo: (e: Entry) => void;
    onSaved: () => Promise<void>;
  } = $props();

  const filterKey = (f: Filter) => (f.kind === 'tab' ? `tab:${f.tab}` : f.kind);
  // svelte-ignore state_referenced_locally
  let chosen = $state(filterKey(openingFilter(data.entries)));
  const filter = $derived<Filter>(chosen.startsWith('tab:') ? { kind: 'tab', tab: chosen.slice(4) as Tab } : { kind: chosen as 'all' | 'latest' | 'thoughts' });
  const s = $derived(reviewState(data.entries));
  const shown = $derived(filtered(data.entries, filter));
  const rounds = $derived(new Set(data.entries.map((e) => e.round)).size);

  let folded = $state(readFolded());
  $effect(() => { folded = wide ? true : readFolded(); });
  function readFolded(): boolean {
    try { return localStorage.getItem('notes-folded') === '1'; } catch { return false; }
  }
  function fold(v: boolean) {
    folded = v;
    try { localStorage.setItem('notes-folded', v ? '1' : '0'); } catch { /* remembered for this session only */ }
  }

  let text = $state('');
  let opening = $state('');
  let concluding = $state('');
  let newConclusion = $state(false);
  let deciding = $state(false);
  let error = $state('');
  let saving = $state(false);
  let editing = $state<{ id: number; text: string } | null>(null);
  let deleting = $state<number | null>(null);
  let earlier = $state(new Set<number>());
  let doc = $state<HTMLElement>();

  async function save(write: () => Promise<Done | Refused>, after: () => void = () => {}) {
    error = '';
    saving = true;
    try {
      const r = await write();
      if (r.kind === 'refused') { error = r.reason; return; }
      after();
      await onSaved();
    } catch (e) {
      error = String(e);
    } finally {
      saving = false;
    }
  }

  // A right-click asked for a comment: the whole document, so he sees where it goes.
  $effect(() => {
    if (draft) { chosen = 'all'; text = ''; error = ''; fold(false); }
  });

  // "Show my comment" from the report: the whole document, scrolled to it.
  $effect(() => {
    if (!focus) return;
    const key = focus.key;
    chosen = 'all';
    fold(false);
    // Folded, the document is not on screen yet: wait for it to be drawn.
    void tick().then(() => {
      if (!doc) return;
      const el = [...doc!.querySelectorAll('[data-entry-key]')].find((x) => x.getAttribute('data-entry-key') === key);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el?.classList.add('flash');
      setTimeout(() => el?.classList.remove('flash'), 2200);
    });
  });

  // A check's date on the History tab: the whole document, scrolled to that review.
  $effect(() => {
    if (!review) return;
    const round = String(review.round);
    chosen = 'all';
    fold(false);
    void tick().then(() => {
      const el = doc?.querySelector(`[data-round="${round}"]`);
      el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      el?.classList.add('flash');
      setTimeout(() => el?.classList.remove('flash'), 2200);
    });
  });

  const saveComment = () => save(
    () => backend.addNote(isin, { kind: 'comment', tab: draft!.tab, target: draft!.target, snapshotId, body: text }),
    () => { draft = null; text = ''; },
  );
  /** ⌘ Enter (Ctrl Enter elsewhere) saves the box being written in, as its Save button would. */
  const saveOnCmdEnter = (save: () => unknown) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
  };
  const saveOpening = () => opening.trim() && save(() => backend.addNote(isin, { kind: 'opening', body: opening }), () => (opening = ''));
  const saveConcluding = () => concluding.trim() && save(() => backend.addNote(isin, { kind: 'concluding', body: concluding }), () => { concluding = ''; newConclusion = false; });
  const saveEdit = (id: number) => save(() => backend.editNote(id, editing!.text), () => (editing = null));
  const about = (e: Entry) => (e.target ? `${e.target.label} — ${e.target.value}` : `${TAB_NAMES[e.tab!]}, as a whole`);
  const sameSection = (a: Entry | undefined, b: Entry) => a && a.round === b.round && a.kind === 'comment' && a.tab === b.tab;
</script>

<aside class="notes" class:folded>
  {#if folded}
    <button class="unfold" onclick={() => fold(false)} title="Show the notes">Notes ‹</button>
  {:else}
    <div class="head">
      <h3>Notes</h3>
      <select bind:value={chosen} aria-label="Show">
        <option value="all">Whole document</option>
        {#if s.lastDecision}<option value="latest">Latest conclusion</option>{/if}
        <option value="thoughts">Opening and concluding thoughts</option>
        {#each TABS as [t, name] (t)}<option value="tab:{t}">Comments on {name}</option>{/each}
      </select>
      <button class="link small" onclick={() => fold(true)} title="Fold the notes away">Fold ›</button>
    </div>

    <div class="doc" bind:this={doc}>
      {#if shown.length === 0}
        <p class="small muted">
          {#if data.entries.length === 0}
            Nothing written about {company} yet. Start with your opening thoughts below, then right-click anything on the report to comment on it.
          {:else}Nothing here for this choice.{/if}
        </p>
      {/if}

      {#each shown as e, i (e.id)}
        {#if filter.kind === 'all' && rounds > 1 && shown[i - 1]?.round !== e.round}
          <h4 class="round" data-round={e.round}>Review {e.round}</h4>
        {:else if shown[i - 1]?.round !== e.round}
          <span data-round={e.round}></span>
        {/if}
        {#if e.kind === 'comment' && !sameSection(shown[i - 1], e)}
          <h5>{TAB_NAMES[e.tab!]}</h5>
        {/if}

        <article class="entry {e.kind}" class:deleted={e.deletedAt} data-entry-key={e.target?.key ?? ''}>
          {#if e.kind === 'opening' || e.kind === 'concluding'}
            <div class="title">{e.kind === 'opening' ? 'Opening thoughts' : 'Concluding thoughts'} <span class="muted small">{day(e.createdAt)}</span></div>
          {:else if e.kind === 'comment'}
            <button class="about small" onclick={() => onGo(e)} title="Go to it">{about(e)}</button>
            <span class="muted small date">{day(e.createdAt)}</span>
          {:else}
            <div class="stand">▸ Where I stand: <strong>{LABEL_NAMES[e.stance!]}</strong>{#if e.sold} · sold — {SOLD_NAMES[e.sold]}{/if} <span class="muted small">{day(e.createdAt)}</span></div>
          {/if}

          {#if e.deletedAt}
            <p class="small muted">Deleted {day(e.deletedAt)}. <button class="link" onclick={() => (earlier = new Set(earlier.has(e.id) ? [...earlier].filter((x) => x !== e.id) : [...earlier, e.id]))}>{earlier.has(e.id) ? 'Hide' : 'Show'} its wording</button></p>
          {:else if editing?.id === e.id}
            <textarea bind:value={editing.text} rows="4" onkeydown={saveOnCmdEnter(() => saveEdit(e.id))}></textarea>
            <div class="buttons small">
              <button class="primary" disabled={saving} onclick={() => saveEdit(e.id)}>Save</button><span class="key">or ⌘ Enter</span>
              <button class="link" onclick={() => (editing = null)}>Cancel</button>
            </div>
          {:else if bodyOf(e)}
            <p class="body">{bodyOf(e)}</p>
          {/if}

          {#if e.versions.length > 1 && !e.deletedAt}
            <p class="small muted">Edited {day(e.versions.at(-1)!.writtenAt)}. <button class="link" onclick={() => (earlier = new Set(earlier.has(e.id) ? [...earlier].filter((x) => x !== e.id) : [...earlier, e.id]))}>{earlier.has(e.id) ? 'Hide' : 'Show'} earlier wording</button></p>
          {/if}
          {#if earlier.has(e.id)}
            <ol class="versions small">
              {#each e.deletedAt ? e.versions : e.versions.slice(0, -1) as v, i (i)}<li><span class="muted">{day(v.writtenAt)}</span> {v.body}</li>{/each}
            </ol>
          {/if}

          {#if !e.deletedAt && editing?.id !== e.id}
            {#if deleting === e.id}
              <div class="buttons small">
                <span>Delete this? It is hidden from your notes; its wording is kept.</span>
                <button class="link danger" onclick={() => save(() => backend.deleteNote(e.id), () => (deleting = null))}>Delete</button>
                <button class="link" onclick={() => (deleting = null)}>Keep</button>
              </div>
            {:else}
              <div class="actions small">
                <button class="link" onclick={() => (editing = { id: e.id, text: bodyOf(e) })}>{e.kind === 'decision' && !bodyOf(e) ? 'Add a comment' : 'Edit'}</button>
                {#if e.kind !== 'decision'}<button class="link" onclick={() => (deleting = e.id)}>Delete</button>{/if}
              </div>
            {/if}
          {/if}
        </article>
      {/each}

      {#if filter.kind === 'latest'}
        <button class="link small" onclick={() => (chosen = 'all')}>Show the whole document</button>
      {/if}
    </div>

    <div class="write">
      {#if draft}
        <label class="small">
          <span>Comment on <strong>{draft.target ? `${draft.target.label} — ${draft.target.value}` : `${TAB_NAMES[draft.tab]}, as a whole`}</strong> <span class="muted">({TAB_NAMES[draft.tab]})</span></span>
          <!-- svelte-ignore a11y_autofocus -->
          <textarea bind:value={text} rows="4" autofocus onkeydown={saveOnCmdEnter(saveComment)}></textarea>
        </label>
        <div class="buttons small">
          <button class="primary" disabled={saving} onclick={saveComment}>Save comment</button><span class="key">or ⌘ Enter</span>
          <button class="link" onclick={() => (draft = null)}>Cancel</button>
        </div>
      {:else if deciding}
        <DecisionDialog label={data.label}
          onConfirm={async (d) => { const r = await backend.completeReview(isin, d); if (r.kind === 'refused') return r.reason; deciding = false; chosen = 'latest'; await onSaved(); return null; }}
          onCancel={() => (deciding = false)} />
      {:else}
        {#if s.round === 1 && !s.opening}
          <label class="small">Opening thoughts<textarea bind:value={opening} rows="3" placeholder="What draws you to {company}, and what you want to find out" onkeydown={saveOnCmdEnter(saveOpening)}></textarea></label>
          <div class="buttons small"><button class="primary" disabled={saving || !opening.trim()} onclick={saveOpening}>Save</button><span class="key">or ⌘ Enter</span></div>
        {/if}
        {#if !s.concluding}
          {#if s.round === 1 || s.inProgress || newConclusion}
            <label class="small">Concluding thoughts<textarea bind:value={concluding} rows="3" placeholder="Once you have been through the tabs: where you have got to" onkeydown={saveOnCmdEnter(saveConcluding)}></textarea></label>
            <div class="buttons small"><button class="primary" disabled={saving || !concluding.trim()} onclick={saveConcluding}>Save</button><span class="key">or ⌘ Enter</span></div>
          {:else}
            <p class="small muted">Right-click anything on the report to add a comment; this visit's comments go after your last conclusion.</p>
            <button class="complete" onclick={() => (newConclusion = true)}>Write new concluding thoughts</button>
          {/if}
        {/if}
        {#if s.round === 1 || s.inProgress || s.concluding}
          <button class="complete" onclick={() => { error = cannotCompleteReview(data.entries) ?? ''; deciding = !error; }}>Review complete</button>
        {/if}
      {/if}
      {#if error}<p class="error small">{error}</p>{/if}
    </div>
  {/if}
</aside>

<style>
  .notes { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; position: sticky; top: 12px;
    max-height: calc(100vh - 24px); display: flex; flex-direction: column; gap: 10px; }
  .notes.folded { padding: 6px; }
  .unfold { border: 0; background: none; color: var(--accent); writing-mode: vertical-rl; padding: 8px 2px; font-size: 13px; }
  .head { display: flex; gap: 8px; align-items: center; }
  .head h3 { font-size: 14px; margin-right: auto; }
  select { font: inherit; font-size: 12px; padding: 2px 4px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); color: var(--text); max-width: 60%; }
  .doc { overflow-y: auto; display: grid; gap: 8px; align-content: start; min-height: 40px; }
  .round { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; margin: 8px 0 0; border-top: 1px solid var(--line); padding-top: 8px; }
  h5 { font-size: 12px; font-weight: 600; color: var(--accent); margin: 4px 0 -2px; }
  .entry { display: grid; gap: 3px; padding: 6px 8px; border-radius: 6px; border: 1px solid transparent; }
  .entry.comment { border-color: var(--line); }
  .entry.concluding, .entry.opening { background: var(--bg); }
  .entry.decision { border-left: 3px solid var(--accent); border-radius: 0 6px 6px 0; }
  .entry.deleted { opacity: 0.65; }
  .title { font-weight: 600; font-size: 13px; }
  .about { border: 0; background: none; padding: 0; text-align: left; color: var(--accent); font: inherit; font-size: 12px; text-decoration: underline; text-decoration-color: var(--line); }
  .about:hover { text-decoration-color: var(--accent); }
  .date { font-size: 11px; }
  .body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .versions { margin: 0; padding-left: 18px; display: grid; gap: 2px; white-space: pre-wrap; }
  .actions, .buttons { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .actions { opacity: 0.75; }
  .write { display: grid; gap: 8px; border-top: 1px solid var(--line); padding-top: 10px; }
  .write label { display: grid; gap: 4px; }
  textarea { width: 100%; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--text); font: inherit; resize: vertical; }
  .primary { padding: 4px 12px; border: 0; border-radius: 6px; background: var(--accent); color: var(--surface); }
  .primary:disabled { opacity: 0.5; cursor: default; }
  .complete { justify-self: start; padding: 6px 14px; border: 1px solid var(--accent); border-radius: 6px; background: none; color: var(--accent); font-weight: 500; }
  .link { border: 0; background: none; color: var(--muted); text-decoration: underline; padding: 0; font: inherit; }
  .link.danger { color: var(--bad); }
  .key { color: var(--muted); font-size: 11px; }
  .error { color: var(--bad); margin: 0; }
  p { margin: 0; }
</style>
