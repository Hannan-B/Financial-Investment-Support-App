/** Dates as websites write them. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * 'Oct 29, 2026' → '2026-10-29', as stockanalysis and Finviz write dates.
 * 'n/a', '-' and blank → null; anything else unrecognised is an error, never a guess.
 */
export function monthDayYear(text: string | undefined): string | null {
  if (!text) return null;
  const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(text.trim());
  if (!m) {
    if (/^(n\/a|-|)$/i.test(text.trim())) return null;
    throw new Error(`unrecognised date: ${JSON.stringify(text)}`);
  }
  const month = MONTHS.indexOf(m[1]!);
  if (month < 0) throw new Error(`unrecognised month in ${JSON.stringify(text)}`);
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
}
