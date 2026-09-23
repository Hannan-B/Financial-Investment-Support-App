/**
 * Company names as funds write them carry share-class and par-value noise:
 * 'ALPHABET INC-CL A USD0.001', 'ROCHE HOLDINGS AG CHF0.001 (BR)',
 * 'ELI LILLY &amp; CO NPV'. This strips it to the part that names the company.
 *
 * Used twice: as a search query, and to recognise the same company across
 * funds and share classes (Alphabet A and C; DJIW rows, which have no ISIN).
 */
import { decodeEntities } from '../sources/holdings.ts';

export function companyName(raw: string): string {
  const words = decodeEntities(raw).toUpperCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[-/](CL|CLASS)\b.*$/, ' ')
    .replace(/\/THE\b/, ' ')
    .split(/[\s,]+/)
    .filter((w) => w && !NOISE.has(w) && !/^[A-Z]{3}[0-9.]+$/.test(w) && !/^[0-9.]+$/.test(w))
    .map((w) => ABBREVIATIONS[w] ?? w);
  while (words.at(-1) === '&') words.pop();
  return words.join(' ');
}

/** Fund files abbreviate; search engines and other funds do not ('INTL BUSINESS MACHINES'). */
const ABBREVIATIONS: Readonly<Record<string, string>> = {
  INTL: 'INTERNATIONAL',
  MFG: 'MANUFACTURING',
};

const NOISE = new Set([
  'INC', 'INC.', 'CORP', 'CORP.', 'CORPORATION', 'CO', 'CO.', 'LTD', 'LTD.', 'LIMITED', 'PLC',
  'AG', 'SA', 'NV', 'SE', 'ASA', 'AB', 'OYJ', 'SPA', 'HOLDINGS', 'HOLDING', 'GROUP', 'NPV',
  'CL', 'CLASS', 'A', 'B', 'C', 'SHARES', 'SHS', 'ORD', 'REG', 'ADR', 'ADS', 'SPON', 'EACH', 'R',
]);
