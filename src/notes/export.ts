/**
 * Export: everything he has written, as Markdown files to read anywhere.
 * PROJECT-PLAN.md §12.2, §11.8 step 3.6
 *
 * One file per company — its notes document in the panel's order, every
 * edit and deletion with the earlier wording, the label history and the
 * ineligible marker — and a contents file listing each company with its
 * label. For reading, not for loading back: the daily backups do that.
 */
import type { Db } from '../db/types.ts';
import { DISPLAY_NAME } from '../research/report.ts';
import { inOrder, bodyOf, LABEL_NAMES, TAB_NAMES, SOLD_NAMES, type Entry } from './document.ts';
import { loadEntries, labelHistory, marksFor, labelOf, type Mark } from './store.ts';

export interface ExportFile { readonly name: string; readonly text: string; }
export interface Export { readonly folder: string; readonly files: readonly ExportFile[]; }

/** '2026-11-02T…' → '2 Nov 2026', in UTC so the same instant always reads the same. */
function date(iso: string): string {
  return new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso)
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Safe as a file name on any system: no slashes, colons or control characters. */
export function fileName(name: string): string {
  return name.replace(/[\u0000-\u001f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';
}

/** Each line of a body as a Markdown quote, so the writer's own formatting cannot break the file's. */
const quote = (text: string) => text.split('\n').map((l) => `> ${l}`).join('\n');

function earlier(e: Entry): string[] {
  const out: string[] = [];
  if (e.versions.length > 1) {
    out.push(`_Edited ${date(e.versions.at(-1)!.writtenAt)}. Earlier wording:_`);
    for (const v of e.versions.slice(0, -1)) out.push('', `_${date(v.writtenAt)}:_`, quote(v.body));
  }
  return out;
}

function entryText(e: Entry): string[] {
  const deleted = e.deletedAt ? ` — _deleted ${date(e.deletedAt)}_` : '';
  switch (e.kind) {
    case 'opening':
    case 'concluding':
      return [`### ${e.kind === 'opening' ? 'Opening' : 'Concluding'} thoughts — ${date(e.createdAt)}${deleted}`, '', quote(bodyOf(e)), ...earlier(e), ''];
    case 'comment': {
      const about = e.target ? `${e.target.label}: ${e.target.value}` : 'the tab as a whole';
      return [`**${TAB_NAMES[e.tab!]}** · ${about} — ${date(e.createdAt)}${deleted}`, '', quote(bodyOf(e)), ...earlier(e), ''];
    }
    case 'decision': {
      const sold = e.sold ? ` · sold — ${SOLD_NAMES[e.sold]}` : '';
      const body = bodyOf(e);
      return [`**Where I stand: ${LABEL_NAMES[e.stance!]}${sold}** — ${date(e.createdAt)}`, '', ...(body ? [quote(body), ''] : []), ...earlier(e), ...(e.versions.length > 1 ? [''] : [])];
    }
  }
}

function markText(m: Mark): string[] {
  const sellBy = m.sellBy
    ? ` · sell by ${date(m.sellBy)}${m.sellByBasis === 'next_results' ? ` (next results${m.sellByExpected ? ', expected' : ''})` : ''}` : '';
  return [
    `- Marked ineligible ${date(m.markedAt)}${sellBy}${m.note ? ` — ${m.note}` : ''}`,
    ...(m.soldAt ? [`- Sold ${date(m.soldAt)}`] : []),
    ...(m.clearedAt ? [`- Cleared ${date(m.clearedAt)} — ${m.clearedReason}`] : []),
  ];
}

export async function buildExport(db: Db, now: Date): Promise<Export> {
  const companies = await db.query(
    `SELECT s.isin, ${DISPLAY_NAME} AS name,
            (SELECT min(l.ticker) FROM listing l WHERE l.isin = s.isin) AS ticker
     FROM security s
     WHERE s.isin IN (SELECT isin FROM note_entry UNION SELECT isin FROM label_change UNION SELECT isin FROM ineligible_mark)
     ORDER BY name`,
  );
  const files: ExportFile[] = [];
  const contents: string[] = [`# Your notes — exported ${date(now.toISOString())}`, '',
    'One file per company, in the order the notes panel shows them. Earlier wording of anything edited or deleted is kept in each file.', '',
    '| Company | Label | File |', '|---|---|---|'];
  const used = new Set<string>();

  for (const c of companies) {
    const isin = String(c['isin']);
    const title = `${String(c['name'])}${c['ticker'] ? ` (${String(c['ticker'])})` : ''}`;
    let name = `${fileName(title)}.md`;
    if (used.has(name)) name = `${fileName(`${title} ${isin}`)}.md`;
    used.add(name);

    const entries = inOrder(await loadEntries(db, isin));
    const lines = [`# ${title}`, '', `ISIN ${isin}. Exported ${date(now.toISOString())}.`, ''];
    const rounds = [...new Set(entries.map((e) => e.round))];
    for (const r of rounds) {
      if (rounds.length > 1) lines.push(`## Review ${r}`, '');
      for (const e of entries.filter((x) => x.round === r)) lines.push(...entryText(e));
    }
    if (entries.length === 0) lines.push('_No notes written._', '');

    const labels = await labelHistory(db, isin);
    if (labels.length) lines.push('## Labels', '', ...labels.map((l) => `- ${date(l.at)}: ${LABEL_NAMES[l.label]}`), '');
    const marks = await marksFor(db, isin);
    if (marks.length) lines.push('## Ineligible', '', ...marks.flatMap(markText), '');

    files.push({ name, text: `${lines.join('\n').trimEnd()}\n` });
    contents.push(`| ${title.replace(/\|/g, '/')} | ${LABEL_NAMES[await labelOf(db, isin)]} | ${name} |`);
  }
  if (companies.length === 0) contents.push('| _Nothing written yet_ | | |');

  files.unshift({ name: 'Contents.md', text: `${contents.join('\n')}\n` });
  return { folder: `Investment Tracker notes ${now.toISOString().slice(0, 10)}`, files };
}
