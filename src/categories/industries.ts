/**
 * Industries: the second level under each sector.  PROJECT-PLAN.md §4.4b, §11.9 step 4.4
 *
 * Settled 2026-11-12: two levels — the fund's sector, then stockanalysis's
 * industry in the site's own words. No middle layer of the app's own, so
 * nothing here is an opinion about where an industry belongs.
 *
 * The one thing done to the words: stockanalysis names some industries two
 * ways (its company pages mix two naming schemes), and those are shown as one
 * line. Only spellings of the same industry are joined; the stored label stays
 * verbatim (§4.4b), so a join can be undone without looking anything up again.
 */

/** A company the lookup has not reached yet. */
export const NOT_LOOKED_UP = 'Not looked up yet';
/** A company stockanalysis has no page for, with its ISIN. */
export const NOT_FOUND = 'Not found on stockanalysis';

/** The second spelling → the one shown. Seen in the real lookups, 2026-11-12. */
const SAME_INDUSTRY: Readonly<Record<string, string>> = {
  'Apparel - Manufacturers': 'Apparel Manufacturing',
  'Auto - Dealerships': 'Auto & Truck Dealerships',
  'Food Confectioners': 'Confectioners',
  'Agricultural Farm Products': 'Farm Products',
  'Industrial - Pollution & Treatment Controls': 'Pollution & Treatment Controls',
  'Manufacturing - Metal Fabrication': 'Metal Fabrication',
  'Manufacturing - Tools & Accessories': 'Tools & Accessories',
  'Medical - Healthcare Information Services': 'Health Information Services',
  'Scientific & Technical Instrument': 'Scientific & Technical Instruments',
};

export function industryName(label: string): string {
  const t = label.trim();
  return SAME_INDUSTRY[t] ?? t;
}
