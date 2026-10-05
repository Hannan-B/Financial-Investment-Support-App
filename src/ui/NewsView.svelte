<script lang="ts">
  /**
   * News & Filings (§6.6): what was published, as headlines and links — the
   * reading happens at the source. Official announcements first, then press
   * coverage from approved publishers. Nothing summarised, nothing ranked.
   */
  import type { Backend } from './backend.ts';
  import type { NewsView, NewsLine, PublisherRow } from '../research/news.ts';
  import { day } from './format.ts';

  let { backend, listingId, company }: { backend: Backend; listingId: number; company: string } = $props();

  let windowChoice = $state<'default' | 'last-180-days'>('default');
  let view = $state<NewsView | null>(null);
  let failed = $state('');
  let showRoutine = $state(false);
  let expanded = $state<Set<string>>(new Set());
  let aliasDraft = $state('');
  let aliasSaved = $state(false);

  async function load() {
    try {
      view = await backend.news(listingId, windowChoice);
      aliasDraft = view.names.aliases.join(', ');
    } catch (e) { failed = String(e); }
  }

  // Shown first, then recorded as seen: "new" is what arrived since this look.
  let seen = false;
  $effect(() => {
    void windowChoice;
    void load().then(() => { if (!seen) { seen = true; void backend.newsSeen(listingId); } });
  });

  async function open(line: NewsLine) {
    await backend.openLink(line.url, listingId);
    line = { ...line, opened: true };
    if (view) view = { ...view, official: view.official.map((l) => (l.url === line.url ? line : l)),
      press: view.press.map((g) => ({ lead: g.lead.url === line.url ? line : g.lead, others: g.others.map((o) => (o.url === line.url ? line : o)) })) };
  }
  async function hide(line: NewsLine) {
    await backend.hideStory(listingId, line.url);
    if (view) view = { ...view, press: view.press.filter((g) => g.lead.url !== line.url)
      .map((g) => ({ ...g, others: g.others.filter((o) => o.url !== line.url) })) };
  }
  async function toggle(p: PublisherRow) {
    await backend.choosePublisher(p.host, !p.shown);
    await load();
  }
  async function saveAliases() {
    await backend.setAliases(listingId, aliasDraft.split(',').map((a) => a.trim()).filter(Boolean));
    aliasSaved = true;
  }

  const LABEL: Record<string, string> = { official: 'Official', regulator: 'Regulator', 'press-release': 'Press release — written by the company' };
  const GROUPS: [PublisherRow['group'], string][] = [['general', 'General news'], ['business', 'Business and financial'],
    ['press-release', 'Press releases'], ['regulator', 'Regulators'], ['trade', 'Trade press'], ['other', 'Not approved']];
  const ACCESS: Record<PublisherRow['access'], string> = { free: '', partial: 'some articles paywalled', paywalled: 'paywalled — tick if you subscribe', 'not-approved': '' };
  const newCount = $derived(view ? [...view.official, ...view.press.map((g) => g.lead)].filter((l) => l.isNew).length : 0);
  const toggleGroup = (url: string) => { const s = new Set(expanded); if (s.has(url)) s.delete(url); else s.add(url); expanded = s; };
</script>

{#snippet line(l: NewsLine, more: number, hideable: boolean)}
  <li class:opened={l.opened}>
    <span class="date num small">{day(l.published)}</span>
    <span class="who small muted">{l.publisher}</span>
    <span class="what">
      {#if l.label && l.label !== 'official'}<span class="tag tag-{l.label}">{LABEL[l.label]}</span>{/if}
      {#if l.isNew}<span class="tag new">New</span>{/if}
      <button class="headline" onclick={() => open(l)} title={l.url}>{l.title}</button>
      {#if l.opened}<span class="small muted">· opened</span>{/if}
      {#if more}<button class="link small" onclick={() => toggleGroup(l.url)}>{expanded.has(l.url) ? 'fewer' : `+${more} more`}</button>{/if}
      {#if l.archive}<button class="link small" onclick={() => backend.openLink(l.archive!)} title="The Internet Archive's copy, should the page go">archive</button>{/if}
      {#if hideable}<button class="link small" onclick={() => hide(l)} title="Hide this story for good">not about {company}</button>{/if}
    </span>
  </li>
{/snippet}

{#if failed}
  <p class="error">{failed}</p>
{:else if !view}
  <p class="muted">Loading…</p>
{:else}
  <div class="bar small muted">
    <span>
      {#if view.window === 'since-results'}
        Since the last results, {day(view.from)}. <button class="link" onclick={() => (windowChoice = 'last-180-days')}>Show 180 days</button>
      {:else}
        The last 180 days, from {day(view.from)}{view.resultsDate ? '' : ' — no results date known yet'}.
        {#if windowChoice === 'last-180-days'}<button class="link" onclick={() => (windowChoice = 'default')}>Since the last results</button>{/if}
      {/if}
    </span>
    {#if newCount}<span class="tag new">{newCount} new since you last looked</span>{/if}
  </div>

  {#if !view.fetched}
    <p class="muted">No news yet — press Refresh. The first refresh fetches 180 days of headlines, which takes about a minute.</p>
  {:else}
    <section>
      <h3>Official announcements</h3>
      {#if view.channel === 'none'}
        <p class="small muted">No free official channel was found for this market, so there is press coverage only.</p>
      {:else}
        <p class="small muted">{view.channel === 'sec' ? 'Filings with the SEC, from the company itself.' : 'Regulatory announcements (RNS and other wires), via Investegate.'}</p>
        {#if view.official.length}
          <ul>{#each view.official as l (l.url)}{@render line(l, 0, false)}{/each}</ul>
        {:else}<p class="small muted">None in this period.</p>{/if}
        {#if view.routineHidden.length}
          <button class="link small" onclick={() => (showRoutine = !showRoutine)}>
            {showRoutine ? 'Hide' : 'Show'} {view.routineHidden.length} routine notices{view.channel === 'investegate' ? ' (daily buybacks, voting rights)' : ' (forms such as 144 and S-8)'}
          </button>
          {#if showRoutine}<ul class="routine">{#each view.routineHidden as l (l.url)}{@render line(l, 0, false)}{/each}</ul>{/if}
        {/if}
      {/if}
    </section>

    <section>
      <h3>Press coverage</h3>
      <p class="small muted">Headlines naming {company}{view.names.aliases.length ? ` or ${view.names.aliases.join(', ')}` : ''}, from approved publishers only. Open one to read it at the source.</p>
      {#if view.limited}<p class="small limited">{company} is {view.limited}.</p>{/if}
      {#if view.press.length}
        <ul>
          {#each view.press as g (g.lead.url)}
            {@render line(g.lead, g.others.length, true)}
            {#if expanded.has(g.lead.url)}
              <ul class="others">{#each g.others as o (o.url)}{@render line(o, 0, true)}{/each}</ul>
            {/if}
          {/each}
        </ul>
      {:else}<p class="small muted">No stories in this period from the publishers shown.</p>{/if}
    </section>

    <details class="settings">
      <summary class="small">Publishers ({view.publishers.filter((p) => p.shown).length} shown) and other names for {company}</summary>
      <div class="names small">
        <label>Other names headlines use — brands, former names, separated by commas
          <input bind:value={aliasDraft} oninput={() => (aliasSaved = false)} placeholder="e.g. Google, YouTube" />
        </label>
        <button onclick={saveAliases}>Save</button>
        {#if aliasSaved}<span class="muted">Saved — searched from the next refresh, 180 days back.</span>{/if}
      </div>
      <div class="pubs">
        {#each GROUPS as [group, title] (group)}
          {@const rows = view.publishers.filter((p) => p.group === group)}
          {#if rows.length}
            <section>
              <h4>{title}</h4>
              {#each rows as p (p.host)}
                <label class="small">
                  <input type="checkbox" checked={p.shown} onchange={() => toggle(p)} />
                  {p.name}{#if p.count}<span class="muted">{` · ${p.count}`}</span>{/if}
                  {#if ACCESS[p.access] || p.note}<span class="muted"> — {p.note ?? ACCESS[p.access]}</span>{/if}
                </label>
              {/each}
            </section>
          {/if}
        {/each}
      </div>
      <p class="small muted">Only the publishers ticked are searched: one switched on — a subscription, say — is searched from the next refresh. Trade press is searched only for companies in its sector.</p>
    </details>
  {/if}
{/if}

<style>
  .bar { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
  section { margin-bottom: 18px; }
  h3 { font-size: 14px; margin-bottom: 2px; }
  ul { list-style: none; margin: 6px 0; padding: 0; }
  li { display: grid; grid-template-columns: 92px 150px 1fr; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--line); align-items: baseline; }
  li.opened .headline { color: var(--muted); }
  .others { margin: 0 0 0 24px; }
  .routine li { opacity: 0.8; }
  .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .what { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
  .headline { border: 0; background: none; padding: 0; color: var(--text); text-align: left; font: inherit; text-decoration: underline; text-decoration-color: var(--line); }
  .headline:hover { text-decoration-color: var(--accent); }
  .tag { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--bg); border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
  .tag-official { color: var(--accent); background: var(--accent-soft); border-color: transparent; }
  .tag-press-release { color: var(--warn); background: var(--warn-soft); border-color: transparent; }
  .tag.new { color: var(--surface); background: var(--accent); border-color: transparent; }
  .link { border: 0; background: none; color: var(--muted); text-decoration: underline; padding: 0; font: inherit; }
  .settings { margin-top: 10px; }
  .settings summary { cursor: pointer; color: var(--accent); }
  .names { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; margin: 10px 0; }
  .names label { display: grid; gap: 2px; flex: 1; min-width: 280px; color: var(--muted); }
  .names input { padding: 5px 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); color: var(--text); }
  .names button { padding: 5px 12px; border: 0; border-radius: 4px; background: var(--accent); color: var(--surface); }
  .pubs { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px 20px; }
  .pubs h4 { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 4px; }
  .pubs label { display: block; padding: 2px 0; }
  .error { color: var(--bad); }
  .limited { color: var(--warn); background: var(--warn-soft); padding: 4px 8px; border-radius: 4px; }
</style>
