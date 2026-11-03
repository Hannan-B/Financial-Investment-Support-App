/**
 * The notes document, labels, decisions, the ineligible marker and export.
 * PROJECT-PLAN.md §11.8, steps 3.1–3.6, as gone through step by step on 2026-11-02.
 * Every date comes from a fixed clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NodeDb, migrationsFromDisk } from '../db/node.ts';
import { migrate } from '../db/migrate.ts';
import {
  inOrder, filtered, openingFilter, reviewState, bodyOf, type Entry,
} from './document.ts';
import {
  loadEntries, addEntry, editEntry, deleteEntry, completeReview, labelOf, labelHistory, setLabel,
  markIneligible, clearIneligible, confirmSold, marksFor, currentMarks, nextResults,
} from './store.ts';
import { buildExport } from './export.ts';

const SHELL = 'GB00BP6MXD84';
const IGDA = 'IE000UOXRAM8';

/** 2 November 2026 at 09:00, plus the given minutes. */
const at = (minutes: number, day = 2) => new Date(Date.UTC(2026, 10, day, 9, minutes));

async function setup() {
  const db = new NodeDb();
  await migrate(db, await migrationsFromDisk());
  await db.batch([
    { sql: "INSERT INTO security (isin, name, kind, created_at) VALUES (?, 'Shell plc', 'equity', '2026-10-05')", params: [SHELL] },
    { sql: "INSERT INTO security (isin, name, kind, created_at) VALUES (?, 'Invesco Dow Jones Islamic Global Developed Markets', 'etf', '2026-10-05')", params: [IGDA] },
    { sql: "INSERT INTO listing (isin, ticker, exchange, currency) VALUES (?, 'SHEL', 'LSE', 'GBp')", params: [SHELL] },
  ]);
  return db;
}

/** A refresh of Shell whose dates say the next results are on `next`. */
async function refreshedWithResults(db: NodeDb, capturedAt: string, next: string) {
  await db.batch([
    { sql: 'INSERT INTO report (isin, created_at) VALUES (?, ?) ON CONFLICT (isin) DO NOTHING', params: [SHELL, capturedAt] },
    { sql: 'INSERT INTO snapshot (report_id, captured_at) SELECT id, ? FROM report WHERE isin = ?', params: [capturedAt, SHELL] },
    {
      sql: `INSERT INTO fact (snapshot_id, field_path, value_text, unit, kind, source, tier, as_of)
            SELECT max(id), 'calendar.next_earnings', ?, 'date', 'estimate', 'stockanalysis', 2, ? FROM snapshot`,
      params: [next, capturedAt.slice(0, 10)],
    },
  ]);
}

const REVENUE = { key: 'fact:income.revenue:FY2025', label: 'Revenue · FY2025', value: '$284.3B' };
const DEBT = { key: 'fact:balance.total_debt:FY2025', label: 'Total debt · FY2025', value: '$69.0B' };
const describe = (e: Entry) => `${e.round} ${e.kind}${e.tab ? ` ${e.tab}` : ''}${e.target ? ` ${e.target.label}` : ''}: ${bodyOf(e)}`;
const ok = (r: { kind: string; reason?: string }) => assert.equal(r.kind, 'done', r.reason);
const why = (r: { kind: string; reason?: string }) => r.reason ?? '';

// ── 3.1 notes ────────────────────────────────────────────────────────────

test('3.1 ACCEPTANCE — Shell: opening thoughts, a revenue comment, a conclusion and Review complete; reopening shows only the conclusion; a later debt comment and conclusion come after it; correcting the revenue comment keeps the original', async () => {
  const db = await setup();
  ok(await addEntry(db, SHELL, { kind: 'opening', body: 'Looking at Shell as a cash-flow story.' }, at(0)));
  ok(await addEntry(db, SHELL, { kind: 'comment', tab: 'financials', target: REVENUE, snapshotId: null, body: 'Revenue fell agian.' }, at(1)));
  ok(await addEntry(db, SHELL, { kind: 'concluding', body: 'Solid, but not cheap.' }, at(2)));
  ok(await completeReview(db, SHELL, { stance: 'watching', sold: null, comment: 'Waiting for the next results' }, at(3)));

  // Reopening: only the latest conclusion and where he stood.
  let entries = await loadEntries(db, SHELL);
  assert.deepEqual(openingFilter(entries), { kind: 'latest' });
  assert.deepEqual(filtered(entries, openingFilter(entries)).map(describe), [
    '1 concluding: Solid, but not cheap.',
    '1 decision: Waiting for the next results',
  ]);

  // A later visit: a comment and a new conclusion, after the first conclusion.
  ok(await addEntry(db, SHELL, { kind: 'comment', tab: 'financials', target: DEBT, snapshotId: null, body: 'Debt down again.' }, at(0, 14)));
  ok(await addEntry(db, SHELL, { kind: 'concluding', body: 'Still watching; debt is the thing.' }, at(1, 14)));
  ok(await completeReview(db, SHELL, { stance: 'watching', sold: null, comment: '' }, at(2, 14)));

  // Correcting a mistype after Review complete: marked edited, the original still readable.
  const revenue = (await loadEntries(db, SHELL)).find((e) => e.target?.key === REVENUE.key)!;
  ok(await editEntry(db, revenue.id, 'Revenue fell again.', at(5, 15)));

  entries = await loadEntries(db, SHELL);
  assert.deepEqual(inOrder(entries).map(describe), [
    '1 opening: Looking at Shell as a cash-flow story.',
    '1 comment financials Revenue · FY2025: Revenue fell again.',
    '1 concluding: Solid, but not cheap.',
    '1 decision: Waiting for the next results',
    '2 comment financials Total debt · FY2025: Debt down again.',
    '2 concluding: Still watching; debt is the thing.',
    '2 decision: ',
  ]);
  const edited = entries.find((e) => e.id === revenue.id)!;
  assert.deepEqual(edited.versions.map((v) => v.body), ['Revenue fell agian.', 'Revenue fell again.']);
  assert.equal(edited.versions[1]!.writtenAt, '2026-11-15T09:05:00.000Z');
  // What the comment was about stays as written, whatever the figure becomes later (§6.2).
  assert.deepEqual(edited.target, REVENUE);
});

test('within a review, comments follow the tabs’ order, not the order written; a comment on a tab as a whole sits with its tab', async () => {
  const db = await setup();
  ok(await addEntry(db, SHELL, { kind: 'comment', tab: 'news', target: { key: 'news:https://example.com/a', label: 'Headline · 1 Nov 2026', value: 'Shell beats forecasts' }, snapshotId: null, body: 'Worth a read.' }, at(0)));
  ok(await addEntry(db, SHELL, { kind: 'comment', tab: 'financials', target: REVENUE, snapshotId: null, body: 'Down.' }, at(1)));
  ok(await addEntry(db, SHELL, { kind: 'comment', tab: 'overview', target: null, snapshotId: null, body: 'The overview is calm.' }, at(2)));
  ok(await addEntry(db, SHELL, { kind: 'comment', tab: 'financials', target: DEBT, snapshotId: null, body: 'Lower.' }, at(3)));
  const entries = await loadEntries(db, SHELL);
  assert.deepEqual(inOrder(entries).map(describe), [
    '1 comment overview: The overview is calm.',
    '1 comment financials Revenue · FY2025: Down.',
    '1 comment financials Total debt · FY2025: Lower.',
    '1 comment news Headline · 1 Nov 2026: Worth a read.',
  ]);
  assert.deepEqual(filtered(entries, { kind: 'tab', tab: 'financials' }).map((e) => bodyOf(e)), ['Down.', 'Lower.']);
  assert.deepEqual(openingFilter(entries), { kind: 'all' }, 'an unfinished review carries on where he left off');
});

test('the "thoughts only" filter shows opening and concluding thoughts and where he stood, across every review', async () => {
  const db = await setup();
  ok(await addEntry(db, SHELL, { kind: 'opening', body: 'Opening.' }, at(0)));
  ok(await addEntry(db, SHELL, { kind: 'comment', tab: 'financials', target: REVENUE, snapshotId: null, body: 'A comment.' }, at(1)));
  ok(await addEntry(db, SHELL, { kind: 'concluding', body: 'First conclusion.' }, at(2)));
  ok(await completeReview(db, SHELL, { stance: 'reviewing', sold: null, comment: '' }, at(3)));
  ok(await addEntry(db, SHELL, { kind: 'concluding', body: 'Second conclusion.' }, at(4)));
  ok(await completeReview(db, SHELL, { stance: 'passed', sold: null, comment: 'Too expensive.' }, at(5)));
  assert.deepEqual(filtered(await loadEntries(db, SHELL), { kind: 'thoughts' }).map(describe), [
    '1 opening: Opening.', '1 concluding: First conclusion.', '1 decision: ',
    '2 concluding: Second conclusion.', '2 decision: Too expensive.',
  ]);
});

test('opening thoughts are written once, in the first review; one conclusion per review — the rest are edits', async () => {
  const db = await setup();
  ok(await addEntry(db, SHELL, { kind: 'opening', body: 'First.' }, at(0)));
  assert.match(why(await addEntry(db, SHELL, { kind: 'opening', body: 'Again.' }, at(1))), /already written — edit them/);
  ok(await addEntry(db, SHELL, { kind: 'concluding', body: 'Done.' }, at(2)));
  assert.match(why(await addEntry(db, SHELL, { kind: 'concluding', body: 'Again.' }, at(3))), /already written — edit them/);
  assert.match(why(await addEntry(db, SHELL, { kind: 'comment', tab: 'overview', target: null, snapshotId: null, body: '   ' }, at(4))), /nothing written/);
  ok(await completeReview(db, SHELL, { stance: 'watching', sold: null, comment: '' }, at(5)));
  assert.match(why(await addEntry(db, SHELL, { kind: 'opening', body: 'New opening?' }, at(6))), /belong to the first review/);
});

test('a deleted comment is hidden from the review but its wording is kept; a decision line cannot be deleted', async () => {
  const db = await setup();
  ok(await addEntry(db, SHELL, { kind: 'comment', tab: 'financials', target: REVENUE, snapshotId: null, body: 'Hasty thought.' }, at(0)));
  const [c] = await loadEntries(db, SHELL);
  ok(await deleteEntry(db, c!.id, at(1)));
  const [gone] = await loadEntries(db, SHELL);
  assert.equal(gone!.deletedAt, '2026-11-02T09:01:00.000Z');
  assert.equal(bodyOf(gone!), 'Hasty thought.');
  assert.equal(reviewState(await loadEntries(db, SHELL)).inProgress, false, 'nothing left in this review');

  ok(await addEntry(db, SHELL, { kind: 'concluding', body: 'Done.' }, at(2)));
  ok(await completeReview(db, SHELL, { stance: 'passed', sold: null, comment: '' }, at(3)));
  const decision = (await loadEntries(db, SHELL)).find((e) => e.kind === 'decision')!;
  assert.match(why(await deleteEntry(db, decision.id, at(4))), /decision line .* stays/);
  ok(await editEntry(db, decision.id, 'Valuation too rich.', at(5)));
  assert.equal(bodyOf((await loadEntries(db, SHELL)).find((e) => e.id === decision.id)!), 'Valuation too rich.');
});

// ── 3.3 labels ───────────────────────────────────────────────────────────

test('a label changes only when he changes it, and each change is dated; setting the same label records nothing', async () => {
  const db = await setup();
  assert.equal(await labelOf(db, SHELL), 'none');
  await setLabel(db, SHELL, 'to_review', at(0, 1));
  await setLabel(db, SHELL, 'to_review', at(1, 1));
  await setLabel(db, SHELL, 'reviewing', at(0, 2));
  ok(await addEntry(db, SHELL, { kind: 'comment', tab: 'overview', target: null, snapshotId: null, body: 'A comment does not move the label.' }, at(1)));
  assert.equal(await labelOf(db, SHELL), 'reviewing');
  assert.deepEqual(await labelHistory(db, SHELL), [
    { at: '2026-11-01T09:00:00.000Z', label: 'to_review' },
    { at: '2026-11-02T09:00:00.000Z', label: 'reviewing' },
  ]);
});

// ── 3.4 decisions ────────────────────────────────────────────────────────

test('3.4 ACCEPTANCE — Review complete is refused, saying why, until the concluding thoughts are written; then one decision line goes under the conclusion, with or without a comment, and shows in "thoughts only"', async () => {
  const db = await setup();
  await setLabel(db, SHELL, 'reviewing', at(0));
  ok(await addEntry(db, SHELL, { kind: 'opening', body: 'Opening.' }, at(1)));
  assert.deepEqual(await completeReview(db, SHELL, { stance: 'watching', sold: null, comment: '' }, at(2)),
    { kind: 'refused', reason: 'Write your concluding thoughts first — a completed review always has them' });

  ok(await addEntry(db, SHELL, { kind: 'concluding', body: 'Not now.' }, at(3)));
  ok(await completeReview(db, SHELL, { stance: 'watching', sold: null, comment: '' }, at(4)));
  const thoughts = filtered(await loadEntries(db, SHELL), { kind: 'thoughts' });
  assert.deepEqual(thoughts.map((e) => [e.kind, e.stance, e.versions.length]), [
    ['opening', null, 1], ['concluding', null, 1], ['decision', 'watching', 0],
  ]);
  assert.equal(await labelOf(db, SHELL), 'watching', 'where he stands becomes the label');

  // A sale, chosen: the decision line records it.
  ok(await addEntry(db, SHELL, { kind: 'concluding', body: 'Taking profits.' }, at(0, 20)));
  ok(await completeReview(db, SHELL, { stance: 'none', sold: 'chose', comment: 'Needed the money for a flat.' }, at(1, 20)));
  const last = reviewState(await loadEntries(db, SHELL)).lastDecision!;
  assert.deepEqual([last.stance, last.sold, bodyOf(last)], ['none', 'chose', 'Needed the money for a flat.']);
});

test('the database refuses a sale that is neither chosen nor forced, and a decision line without a stance', async () => {
  const db = await setup();
  await assert.rejects(db.query("INSERT INTO note_entry (isin, round, kind, created_at, stance, sold) VALUES (?, 1, 'decision', 'x', 'none', 'maybe')", [SHELL]));
  await assert.rejects(db.query("INSERT INTO note_entry (isin, round, kind, created_at) VALUES (?, 1, 'decision', 'x')", [SHELL]));
});

// ── 3.5 the ineligible marker ────────────────────────────────────────────

test('3.5 ACCEPTANCE — marking a holding ineligible "by the next results" takes the Calendar date, marked expected; clearing without a reason is refused; after clearing both entries and dates remain; Confirm sold adds the line to the notes', async () => {
  const db = await setup();
  await refreshedWithResults(db, '2026-11-01T18:00:00Z', '2027-02-05');
  ok(await markIneligible(db, SHELL, { sellBy: { basis: 'next_results' }, note: 'Zoya: not compliant' }, at(0)));
  let mark = (await currentMarks(db)).get(SHELL)!;
  assert.deepEqual([mark.sellBy, mark.sellByBasis, mark.sellByExpected, mark.note], ['2027-02-05', 'next_results', true, 'Zoya: not compliant']);

  // A later refresh moving the results date does not move the sell-by date (decided 2026-11-02).
  await refreshedWithResults(db, '2026-11-20T18:00:00Z', '2027-02-12');
  assert.equal((await currentMarks(db)).get(SHELL)!.sellBy, '2027-02-05');

  assert.deepEqual(await clearIneligible(db, SHELL, '  ', at(1)),
    { kind: 'refused', reason: 'Clearing the marker needs a short written reason' });
  ok(await clearIneligible(db, SHELL, 'Zoya re-rated it compliant', at(0, 10)));
  assert.equal((await currentMarks(db)).get(SHELL), undefined);
  const history = await marksFor(db, SHELL);
  assert.deepEqual(history.map((m) => [m.markedAt, m.clearedAt, m.clearedReason]), [
    ['2026-11-02T09:00:00.000Z', '2026-11-10T09:00:00.000Z', 'Zoya re-rated it compliant'],
  ]);

  // Marked again, then sold: the decision line says "had to", and the marker keeps both dates.
  ok(await markIneligible(db, SHELL, { sellBy: null, note: '' }, at(0, 12)));
  ok(await confirmSold(db, SHELL, { stance: 'none', comment: '' }, at(0, 13)));
  mark = (await currentMarks(db)).get(SHELL)!;
  assert.deepEqual([mark.markedAt, mark.soldAt], ['2026-11-12T09:00:00.000Z', '2026-11-13T09:00:00.000Z']);
  const line = reviewState(await loadEntries(db, SHELL)).lastDecision!;
  assert.deepEqual([line.kind, line.sold, line.createdAt], ['decision', 'had_to', '2026-11-13T09:00:00.000Z']);
  assert.match(why(await confirmSold(db, SHELL, { stance: 'none', comment: '' }, at(1, 13))), /already recorded/);
});

test('"by the next results" is refused, with the reason, when no date is known or the known one has passed; a fund has none', async () => {
  const db = await setup();
  assert.match(why(await markIneligible(db, IGDA, { sellBy: { basis: 'next_results' }, note: '' }, at(0))), /No results date is known/);
  await refreshedWithResults(db, '2026-08-01T18:00:00Z', '2026-10-30');
  assert.deepEqual(await nextResults(db, SHELL, '2026-11-02'),
    { reason: 'The results date from the last refresh, 2026-10-30, has passed — refresh the company, or choose a date' });
  ok(await markIneligible(db, IGDA, { sellBy: { basis: 'date', date: '2026-11-09' }, note: '' }, at(0)));
  assert.match(why(await markIneligible(db, IGDA, { sellBy: null, note: '' }, at(1))), /already marked/);
});

// ── 3.6 export ───────────────────────────────────────────────────────────

test('3.6 ACCEPTANCE — export: a contents file and one Markdown file per company, in the panel’s order, with decision lines, label changes, the marker and earlier wording, all dated', async () => {
  const db = await setup();
  await setLabel(db, SHELL, 'to_review', at(0, 1));
  ok(await addEntry(db, SHELL, { kind: 'opening', body: 'Opening thoughts.' }, at(0)));
  ok(await addEntry(db, SHELL, { kind: 'comment', tab: 'financials', target: REVENUE, snapshotId: null, body: 'Revenue fell agian.' }, at(1)));
  ok(await addEntry(db, SHELL, { kind: 'comment', tab: 'overview', target: null, snapshotId: null, body: 'Calm.' }, at(2)));
  ok(await addEntry(db, SHELL, { kind: 'concluding', body: 'Watch it.' }, at(3)));
  ok(await completeReview(db, SHELL, { stance: 'watching', sold: null, comment: 'Waiting for results' }, at(4)));
  const revenue = (await loadEntries(db, SHELL)).find((e) => e.target?.key === REVENUE.key)!;
  ok(await editEntry(db, revenue.id, 'Revenue fell again.', at(0, 3)));
  ok(await markIneligible(db, IGDA, { sellBy: { basis: 'date', date: '2026-11-09' }, note: '' }, at(5)));

  const out = await buildExport(db, at(0, 4));
  assert.equal(out.folder, 'Investment Tracker notes 2026-11-04');
  assert.deepEqual(out.files.map((f) => f.name), [
    'Contents.md', 'Invesco Dow Jones Islamic Global Developed Markets.md', 'Shell plc (SHEL).md',
  ]);
  assert.match(out.files[0]!.text, /\| Shell plc \(SHEL\) \| Watching \| Shell plc \(SHEL\)\.md \|/);
  assert.equal(out.files[2]!.text, [
    '# Shell plc (SHEL)', '',
    'ISIN GB00BP6MXD84. Exported 4 Nov 2026.', '',
    '### Opening thoughts — 2 Nov 2026', '', '> Opening thoughts.', '',
    '**Overview** · the tab as a whole — 2 Nov 2026', '', '> Calm.', '',
    '**Financials** · Revenue · FY2025: $284.3B — 2 Nov 2026', '', '> Revenue fell again.',
    '_Edited 3 Nov 2026. Earlier wording:_', '', '_2 Nov 2026:_', '> Revenue fell agian.', '',
    '### Concluding thoughts — 2 Nov 2026', '', '> Watch it.', '',
    '**Where I stand: Watching** — 2 Nov 2026', '', '> Waiting for results', '',
    '## Labels', '', '- 1 Nov 2026: To review', '- 2 Nov 2026: Watching',
  ].join('\n') + '\n');
  assert.match(out.files[1]!.text, /- Marked ineligible 2 Nov 2026 · sell by 9 Nov 2026\n/);
});

test('export with nothing written says so, and file names never carry a slash or colon', async () => {
  const db = await setup();
  const empty = await buildExport(db, at(0));
  assert.deepEqual(empty.files.map((f) => f.name), ['Contents.md']);
  assert.match(empty.files[0]!.text, /Nothing written yet/);

  await db.query("UPDATE security SET name = 'A/B: Holdings' WHERE isin = ?", [SHELL]);
  await setLabel(db, SHELL, 'watching', at(0));
  assert.equal((await buildExport(db, at(1))).files[1]!.name, 'A B Holdings (SHEL).md');
});
