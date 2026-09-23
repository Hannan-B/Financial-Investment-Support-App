/**
 * The funds the app knows how to open up.  PROJECT-PLAN.md §4.1
 *
 * A held fund that is NOT listed here cannot be looked through, so the
 * portfolio breakdowns refuse to render rather than silently leave it out
 * (§10.1). Adding a fund from a known issuer is one line.
 */
import type { Source } from '../fetch/types.ts';
import type { FundHoldings } from './holdings.ts';
import { ishares } from './ishares.ts';
import { invesco } from './invesco.ts';
import { hsbc } from './hsbc.ts';
import { waystone } from './waystone.ts';

export type Issuer = 'ishares' | 'invesco' | 'hsbc' | 'waystone';

export interface Fund {
  readonly isin: string;
  readonly ticker: string;
  readonly name: string;
  readonly issuer: Issuer;
  /** What the issuer's endpoint is keyed by: portfolioId, ISIN or page name. */
  readonly key: string;
  /**
   * Fetched even when not held: the only fund source with company sectors,
   * used to classify the others (§4.2).
   */
  readonly reference: boolean;
}

export const FUNDS: readonly Fund[] = [
  { isin: 'IE00B27YCP72', ticker: 'ISDE', name: 'iShares MSCI EM Islamic UCITS ETF', issuer: 'ishares', key: '251392', reference: true },
  { isin: 'IE00B296QM64', ticker: 'ISUS', name: 'iShares MSCI USA Islamic UCITS ETF', issuer: 'ishares', key: '251393', reference: true },
  // The design notes call this ISDW; iShares' own page says ISWD.
  { isin: 'IE00B27YCN58', ticker: 'ISWD', name: 'iShares MSCI World Islamic UCITS ETF', issuer: 'ishares', key: '251394', reference: true },
  { isin: 'IE000UOXRAM8', ticker: 'IGDA', name: 'Invesco Dow Jones Islamic Global Developed Markets UCITS ETF', issuer: 'invesco', key: 'IE000UOXRAM8', reference: false },
  { isin: 'IE000LFC57H7', ticker: 'MWIM', name: 'Invesco MSCI ACWI Islamic M-Series UCITS ETF', issuer: 'invesco', key: 'IE000LFC57H7', reference: false },
  { isin: 'IE000AGFZM58', ticker: 'HIPS', name: 'HSBC MSCI Europe Islamic Screened UCITS ETF', issuer: 'hsbc', key: 'IE000AGFZM58', reference: false },
  { isin: 'IE0009BC6K22', ticker: 'HIES', name: 'HSBC MSCI Emerging Markets Islamic Screened Capped UCITS ETF', issuer: 'hsbc', key: 'IE0009BC6K22', reference: false },
  { isin: 'IE0001XCFC82', ticker: 'HIJS', name: 'HSBC MSCI Japan Islamic Screened UCITS ETF', issuer: 'hsbc', key: 'IE0001XCFC82', reference: false },
  { isin: 'IE00073MUWT4', ticker: 'DJIW', name: 'Wahed Dow Jones Islamic World UCITS ETF', issuer: 'waystone', key: 'wahed-dow-jones-islamic-world-ucits-etf', reference: false },
];

export const SOURCES: Readonly<Record<Issuer, Source<FundHoldings>>> = { ishares, invesco, hsbc, waystone };

export function fundByIsin(isin: string): Fund | undefined {
  return FUNDS.find((f) => f.isin === isin);
}
