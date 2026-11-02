<script lang="ts">
  /**
   * Insider dealings (§11.7 step 2.8): what directors and officers bought and
   * sold over the year, as filed. Each line in the source's own words, with a
   * link to the filing or notice; lines that failed a check are listed apart,
   * with the reason. Facts only — no totals, no signal.
   */
  import type { Backend } from './backend.ts';
  import type { DealingsView, Dealing, DealingKind, RoleLevel } from '../research/insiders.ts';
  import { day, price } from './format.ts';

  let { backend, view }: { backend: Backend; view: DealingsView } = $props();

  const LABEL: Record<DealingKind, string> = { bought: 'Bought', sold: 'Sold', 'intends-to-sell': 'Intends to sell', other: 'Other' };
  /** The source's words are shown when they say more than the label does. */
  const SAME: Record<string, string> = { Sale: 'sold', Buy: 'bought', 'Proposed Sale': 'intends-to-sell' };
  const LEVEL: Record<RoleLevel, string> = { executive: 'Executive', board: 'Board', shareholder: 'Shareholder', other: 'Other', 'not-stated': 'Not stated' };
  const shares = (n: number) => n.toLocaleString('en-GB', { maximumFractionDigits: 5 });
  const amount = (d: Dealing, v: number, digits: number) => (d.currency ? price(v, d.currency, digits) : v.toLocaleString('en-GB'));
  /** A price to the places it was written with — €42.2073, £36.17998, $336.18 — at least two, at most six. */
  const places = (v: number) => Math.min(6, Math.max(2, (String(v).split('.')[1] ?? '').length));
  const worked = $derived(view.dealings.some((d) => d.valueWorkedOut));
  const us = $derived(view.source === 'finviz');
</script>

<p class="small muted">
  {#if us}
    From Finviz: sales and purchases filed with the SEC (Form 4), and intended sales (Form 144). The year to {day(view.to)}.
  {:else}
    From the Director/PDMR notices published in London. Shown as Bought or Sold when the notice says purchase or sale (or acquisition or disposal) and nothing points to a share plan, award or dividend; anything else is Other, in the notice's own words. The year to {day(view.to)}.
  {/if}
  Amounts are in the currency the {us ? 'filing' : 'notice'} states.
</p>
{#if view.note}<p class="note small">{view.note}</p>{/if}

{#if view.dealings.length === 0}
  <p class="muted">No dealings to show in the year — {view.leftOut.length} left out, listed below.</p>
{:else}
  <div class="scroll">
    <table>
      <thead>
        <tr><th>Date</th><th>Who</th><th>Dealing</th><th class="num">Shares</th><th class="num">Price</th><th class="num">Value</th></tr>
      </thead>
      <tbody>
        {#each view.dealings as d (d.key)}
          <tr>
            <td class="date">
              <span class="nowrap">{d.tradedOn ? day(d.tradedOn) : '—'}</span>
              {#if d.place}<span class="sub">{d.place}</span>{/if}
              <span class="sub">
                <button class="link" onclick={() => backend.openLink(d.url)}>{us ? 'Filing' : 'Notice'} ↗</button>{#if d.filedOn}, filed {day(d.filedOn)}{/if}
              </span>
            </td>
            <td>
              {d.person}
              <span class="sub"><span class="level level-{d.level}" title="Worked out from the title — see below">{LEVEL[d.level]}</span>{#if d.role} {d.role}{/if}</span>
            </td>
            <td class="dealing">
              <span class="tag tag-{d.kind}">{LABEL[d.kind]}</span>
              {#if SAME[d.wording] !== d.kind && d.wording}<span class="sub clamp" title={d.wording}>{d.wording}</span>{/if}
            </td>
            <td class="num">{d.shares !== null ? shares(d.shares) : '—'}</td>
            <td class="num">{d.price !== null ? amount(d, d.price, places(d.price)) : '—'}</td>
            <td class="num">
              {d.value !== null ? amount(d, d.value, d.value < 100 ? 2 : 0) : '—'}{#if d.valueWorkedOut}<span class="mark" title="Price × shares, worked out by the app">*</span>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <p class="small muted">
    {#if view.dealings.some((d) => d.kind === 'intends-to-sell')}<strong>Intends to sell</strong> is a notice filed before a planned sale; it may not happen, or may happen at a different size.{/if}
    {#if worked}<span class="mark">*</span> Value worked out by the app as price × shares; the notice gives each separately.{/if}
  </p>
  <p class="small muted">
    The level beside each title is worked out from the title by fixed rules, not from the company:
    <strong>Executive</strong> — a chief officer, a CEO (a division's too), a president, an executive chair;
    <strong>Board</strong> — a director or non-executive director, a chair;
    <strong>Shareholder</strong> — a 10% owner or other shareholder, not an employee;
    <strong>Other</strong> — any other title, such as vice-presidents, general counsel, anyone former, or a relative;
    <strong>Not stated</strong> — no title given{#if us}: an advance notice of a planned sale says only "Officer"{/if}.
  </p>
{/if}

{#if view.leftOut.length}
  <details class="left-out">
    <summary>{view.leftOut.length} {view.leftOut.length === 1 ? 'line' : 'lines'} left out, with the reason</summary>
    <ul>
      {#each view.leftOut as d (d.key)}
        <li>
          <span class="nowrap">{d.tradedOn ? day(d.tradedOn) : d.filedOn ? `filed ${day(d.filedOn)}` : ''}</span>
          {d.person ?? 'A notice'}{d.wording ? ` — ${d.wording.replace(/\.$/, '')}` : ''}:
          <span class="reason">{d.leftOut}</span>
          <button class="link" onclick={() => backend.openLink(d.url)}>{us ? 'Filing' : 'Notice'} ↗</button>
        </li>
      {/each}
    </ul>
  </details>
{/if}

<style>
  .note { color: var(--muted); background: var(--bg); padding: 4px 8px; border-radius: 4px; margin: 0 0 10px; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-weight: 500; color: var(--muted); font-size: 12px; padding: 4px 8px; border-bottom: 1px solid var(--line); }
  td { padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .nowrap { white-space: nowrap; }
  .sub { display: block; color: var(--muted); font-size: 12px; max-width: 360px; }
  .date { min-width: 96px; }
  .dealing { min-width: 150px; }
  /* A notice's wording can run to forty words: two lines here, the whole of it on hover and in the notice. */
  .clamp { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .tag { font-size: 11px; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--line); white-space: nowrap; color: var(--text); }
  .tag-intends-to-sell { color: var(--warn); background: var(--warn-soft); border-color: transparent; }
  .tag-other { color: var(--muted); background: var(--bg); }
  .mark { color: var(--muted); margin-left: 1px; }
  .level { font-size: 11px; padding: 0 5px; border-radius: 4px; border: 1px solid var(--line); white-space: nowrap; color: var(--muted); }
  .level-executive, .level-board, .level-shareholder { color: var(--accent); background: var(--accent-soft); border-color: transparent; }
  .link { border: 0; background: none; color: var(--accent); text-decoration: underline; padding: 0; font: inherit; }
  .left-out { margin-top: 10px; }
  .left-out summary { cursor: pointer; color: var(--accent); }
  .left-out ul { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 4px; }
  .reason { color: var(--warn); }
</style>
