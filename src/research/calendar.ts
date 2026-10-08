/**
 * Results and ex-dividend dates — which are still to come, and which are past.
 * PROJECT-PLAN.md §6.1 (A10), §7.1, §11.7 (US next-earnings dates)
 *
 * A date is only "next" when the source says so, or the calendar does:
 *   · stockanalysis's earnings date field holds the LAST results between
 *     announcements (Oracle, October 2026: "Sep 10, 2026"). Its sentence says
 *     which — "The next confirmed earnings date is …" or "The last earnings
 *     date was …" — so the sentence is read, and anything else is a gap.
 *   · an ex-dividend date can be declared ahead (Walmart's 11 Dec 2026, read
 *     on 8 Oct), so it is next or last by the calendar.
 * A date still to come is held as an estimate: it can move (§7.1).
 *
 * Why not Nasdaq's calendar, as §3 planned: api.nasdaq.com's robots.txt
 * refuses all automated access, and its date for Apple was a vendor's
 * guess (29 Oct) after Apple had announced 2 Nov.
 */
import { fetchSource } from '../fetch/record.ts';
import { statistics, siteUid, type StatisticsPage } from '../sources/stockanalysis.ts';
import { monthDayYear } from '../lib/dates.ts';
import type { Fact, Gap, FiguresOutcome } from './figures.ts';
import type { FiguresDeps } from './edgar.ts';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY = String.raw`(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (${MONTHS.join('|')}) (\d{1,2}), (\d{4})`;
const NEXT = new RegExp(String.raw`^The next confirmed earnings date is ${DAY}(?:, (before market open|after market close))?\.$`);
const LAST = new RegExp(String.raw`^The last earnings date was ${DAY}(?:, (?:before market open|after market close))?\.$`);

/** 'September', '10', '2026' → '2026-09-10'. */
const iso = (month: string, day: string, year: string) => monthDayYear(`${month.slice(0, 3)} ${day}, ${year}`)!;

/** Last if on or before the day of the refresh; next — and an estimate — if after. */
export function exDividendFact(date: string, today: string, source: string, detail: string): Fact {
  const next = date > today;
  return {
    fieldPath: next ? 'calendar.next_ex_dividend' : 'calendar.last_ex_dividend', period: null, periodEnd: null,
    value: date, unit: 'date', currency: null, kind: next ? 'estimate' : 'actual',
    source, tier: 2, asOf: today, detail,
  };
}

/**
 * The dates on a statistics page. `today` is the refresh's day; `exDividend`
 * is false where another source (Finviz, for US listings) already gives it.
 */
export function statisticsDates(page: StatisticsPage, today: string, exDividend: boolean): { facts: Fact[]; gaps: Gap[] } {
  const facts: Fact[] = [];
  const gaps: Gap[] = [];
  const text = page.datesText?.trim() ?? '';
  const shown = page.items.get('earningsdate')?.value ?? null;
  const next = NEXT.exec(text);
  const last = LAST.exec(text);
  if (next) {
    const date = iso(next[1]!, next[2]!, next[3]!);
    let field: string | null;
    try { field = monthDayYear(shown ?? undefined); } catch { field = null; }
    if (field !== date) {
      gaps.push({ fieldPath: 'calendar.next_earnings', reason: `stockanalysis's sentence (${date}) and its date field (${shown}) disagree` });
    } else if (date < today) {
      gaps.push({ fieldPath: 'calendar.next_earnings', reason: `stockanalysis's "next" date, ${date}, has already passed` });
    } else {
      facts.push({
        fieldPath: 'calendar.next_earnings', period: null, periodEnd: null, value: date, unit: 'date', currency: null,
        kind: 'estimate', source: 'stockanalysis', tier: 2, asOf: today,
        detail: `stockanalysis: confirmed${next[4] ? `, ${next[4]}` : ''}`,
      });
    }
  } else if (last) {
    gaps.push({ fieldPath: 'calendar.next_earnings', reason: `no date announced yet — the last results were on ${iso(last[1]!, last[2]!, last[3]!)}` });
  } else {
    gaps.push({ fieldPath: 'calendar.next_earnings', reason: `stockanalysis's wording was not recognised: ${JSON.stringify(text || null)}` });
  }

  if (exDividend) {
    const raw = page.items.get('exdivdate')?.value ?? null;
    let date: string | null = null;
    try { date = monthDayYear(raw ?? undefined); } catch { /* unrecognised: a gap below */ }
    if (date) facts.push(exDividendFact(date, today, 'stockanalysis', 'stockanalysis statistics "Ex-Dividend Date"'));
    else gaps.push({ fieldPath: 'calendar.last_ex_dividend', reason: raw === null || raw === 'n/a' ? 'stockanalysis shows no ex-dividend date' : `stockanalysis's ex-dividend date was not in the expected form: ${JSON.stringify(raw)}` });
  }
  return { facts, gaps };
}

/** It follows other requests to the site in a refresh: paced like them. */
const PACE_MS = 1000;

/** A US listing's next results date, from its statistics page (`symbol` as the site writes it: 'aapl'). */
export async function usEarningsDate(symbol: string, deps: FiguresDeps): Promise<FiguresOutcome> {
  const pause = deps.pause ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  await pause(PACE_MS);
  const out = await fetchSource(statistics, symbol, deps);
  if (out.kind === 'unavailable' && out.response?.status === 404) {
    return { kind: 'not-covered', reason: `stockanalysis has no statistics page for ${symbol}` };
  }
  if (out.kind !== 'ok') {
    return { kind: out.kind, reason: `stockanalysis dates: ${out.kind === 'unavailable' ? out.reason : `${out.failure.check}: ${out.failure.observed}`}` };
  }
  // Never a date from a different company than the one asked for (§7.2).
  if (out.value.uid !== siteUid(symbol)) return { kind: 'suspect', reason: `asked stockanalysis for ${siteUid(symbol)}, got ${out.value.uid}` };
  const today = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);
  return { kind: 'ok', figures: { source: 'stockanalysis', ...statisticsDates(out.value, today, false) } };
}
