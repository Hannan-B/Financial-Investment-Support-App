/**
 * Who the press search asks, and what is shown by default.  PROJECT-PLAN.md §6.6
 *
 * The approved list agreed on 2026-10-05. Every entry can be switched on or
 * off on the news panel, and the choice is remembered; these are only the
 * starting points. Paywall status is general knowledge, not tested — the
 * sites refuse automated checks.
 */
import type { Sector } from '../categories/sectors.ts';

export type Access = 'free' | 'partial' | 'paywalled' | 'not-approved';
export type Group = 'general' | 'business' | 'press-release' | 'regulator' | 'trade' | 'other';

export interface Publisher {
  readonly name: string;
  /** The web addresses it publishes from; the first is used in the search. */
  readonly hosts: readonly string[];
  readonly group: Group;
  readonly access: Access;
  /** Trade press: searched only for companies in these sectors. */
  readonly sectors?: readonly Sector[];
  readonly note?: string;
}

const p = (name: string, hosts: string | string[], group: Group, access: Access = 'free', extra: Partial<Publisher> = {}): Publisher =>
  ({ name, hosts: typeof hosts === 'string' ? [hosts] : hosts, group, access, ...extra });
const trade = (sectors: Sector[], name: string, host: string, access: Access = 'free') => p(name, host, 'trade', access, { sectors });

export const PUBLISHERS: readonly Publisher[] = [
  // ── general news ──
  p('BBC', ['bbc.co.uk', 'bbc.com'], 'general'),
  p('Sky News', 'news.sky.com', 'general'),
  p('The Guardian', 'theguardian.com', 'general'),
  p('The Independent', 'independent.co.uk', 'general'),
  p('AP News', 'apnews.com', 'general'),
  p('Al Jazeera', 'aljazeera.com', 'general'),
  p('Deutsche Welle', 'dw.com', 'general'),
  p('France 24', 'france24.com', 'general'),
  p('Euronews', 'euronews.com', 'general'),
  p('NPR', 'npr.org', 'general'),
  // ── business and financial ──
  p('CNBC', 'cnbc.com', 'business'),
  p('Yahoo Finance', ['finance.yahoo.com', 'uk.finance.yahoo.com'], 'business'),
  p('City A.M.', 'cityam.com', 'business'),
  p('Sharecast', 'sharecast.com', 'business'),
  p('Axios', 'axios.com', 'business'),
  p('Semafor', 'semafor.com', 'business'),
  p('Quartz', 'qz.com', 'business'),
  p('Fortune', 'fortune.com', 'business', 'partial'),
  p('MarketWatch', 'marketwatch.com', 'business', 'partial'),
  // ── paywalled: hidden until ticked as subscribed ──
  p('Financial Times', 'ft.com', 'business', 'paywalled'),
  p('Wall Street Journal', 'wsj.com', 'business', 'paywalled'),
  p('Bloomberg', 'bloomberg.com', 'business', 'paywalled'),
  p('The Economist', 'economist.com', 'business', 'paywalled'),
  p("Barron's", 'barrons.com', 'business', 'paywalled'),
  p('The Times', ['thetimes.com', 'thetimes.co.uk'], 'business', 'paywalled'),
  p('The Telegraph', 'telegraph.co.uk', 'business', 'paywalled'),
  p('Business Insider', 'businessinsider.com', 'business', 'paywalled'),
  // ── press releases: written by the company ──
  p('PR Newswire', 'prnewswire.com', 'press-release'),
  p('Business Wire', 'businesswire.com', 'press-release'),
  p('GlobeNewswire', 'globenewswire.com', 'press-release'),
  p('ACCESS Newswire', 'accessnewswire.com', 'press-release'),
  // ── regulators ──
  p('US Food and Drug Administration', 'fda.gov', 'regulator'),
  p('UK government (CMA, MHRA, Ofcom, FCA)', 'gov.uk', 'regulator'),
  p('European Commission', 'ec.europa.eu', 'regulator'),
  // ── trade press, by sector ──
  trade(['Technology'], 'TechCrunch', 'techcrunch.com'),
  trade(['Technology'], 'The Verge', 'theverge.com', 'partial'),
  trade(['Technology'], 'Ars Technica', 'arstechnica.com'),
  trade(['Technology'], 'The Register', 'theregister.com'),
  trade(['Technology'], "Tom's Hardware", 'tomshardware.com'),
  trade(['Technology'], 'EE Times', 'eetimes.com'),
  trade(['Technology'], 'Computer Weekly', 'computerweekly.com'),
  trade(['Technology'], 'ZDNet', 'zdnet.com'),
  trade(['Health Care'], 'Fierce Pharma', 'fiercepharma.com'),
  trade(['Health Care'], 'Fierce Biotech', 'fiercebiotech.com'),
  trade(['Health Care'], 'BioPharma Dive', 'biopharmadive.com'),
  trade(['Health Care'], 'MedTech Dive', 'medtechdive.com'),
  trade(['Health Care'], 'Pharmaceutical Technology', 'pharmaceutical-technology.com'),
  trade(['Health Care'], 'Medical Device Network', 'medicaldevice-network.com'),
  trade(['Health Care'], 'STAT', 'statnews.com', 'partial'),
  trade(['Health Care'], 'Endpoints News', 'endpoints.news', 'partial'),
  trade(['Industrials'], 'Defense News', 'defensenews.com'),
  trade(['Industrials'], 'Breaking Defense', 'breakingdefense.com'),
  trade(['Industrials'], 'Simple Flying', 'simpleflying.com'),
  trade(['Industrials'], 'Railway Gazette', 'railwaygazette.com'),
  trade(['Industrials'], 'Air Cargo News', 'aircargonews.net'),
  trade(['Industrials'], 'Supply Chain Dive', 'supplychaindive.com'),
  trade(['Industrials'], 'Construction Dive', 'constructiondive.com'),
  trade(['Industrials'], 'Manufacturing Dive', 'manufacturingdive.com'),
  trade(['Consumer Discretionary'], 'Retail Dive', 'retaildive.com'),
  trade(['Consumer Discretionary'], 'Retail Gazette', 'retailgazette.co.uk'),
  trade(['Consumer Discretionary'], 'Electrek', 'electrek.co'),
  trade(['Consumer Discretionary'], 'InsideEVs', 'insideevs.com'),
  trade(['Consumer Discretionary'], 'Autocar', 'autocar.co.uk'),
  trade(['Consumer Discretionary'], 'Just Auto', 'just-auto.com'),
  trade(['Consumer Discretionary'], 'Skift', 'skift.com', 'partial'),
  trade(['Consumer Staples'], 'Food Dive', 'fooddive.com'),
  trade(['Consumer Staples'], 'Grocery Dive', 'grocerydive.com'),
  trade(['Consumer Staples'], 'Just Food', 'just-food.com'),
  trade(['Consumer Staples'], 'FoodNavigator', 'foodnavigator.com'),
  trade(['Consumer Staples'], 'The Drinks Business', 'thedrinksbusiness.com'),
  trade(['Materials'], 'Mining.com', 'mining.com'),
  trade(['Materials'], 'Mining Weekly', 'miningweekly.com'),
  trade(['Materials'], 'Mining Technology', 'mining-technology.com'),
  trade(['Materials'], 'Packaging Dive', 'packagingdive.com'),
  trade(['Materials'], 'Kitco', 'kitco.com'),
  trade(['Materials'], 'C&EN', 'cen.acs.org', 'partial'),
  trade(['Energy'], 'Oil & Gas Journal', 'ogj.com'),
  trade(['Energy'], 'Rigzone', 'rigzone.com'),
  trade(['Energy'], 'World Oil', 'worldoil.com'),
  trade(['Energy'], 'Offshore Technology', 'offshore-technology.com'),
  trade(['Energy', 'Utilities'], 'Energy Voice', 'energyvoice.com'),
  trade(['Communication'], 'Light Reading', 'lightreading.com'),
  trade(['Communication'], 'Mobile World Live', 'mobileworldlive.com'),
  trade(['Communication'], 'Fierce Network', 'fierce-network.com'),
  trade(['Communication'], 'Deadline', 'deadline.com'),
  trade(['Communication'], 'The Hollywood Reporter', 'hollywoodreporter.com'),
  trade(['Communication'], 'Variety', 'variety.com'),
  trade(['Communication'], 'Press Gazette', 'pressgazette.co.uk'),
  trade(['Utilities'], 'Utility Dive', 'utilitydive.com'),
  trade(['Utilities'], 'Power Technology', 'power-technology.com'),
  trade(['Real Estate'], 'Bisnow', 'bisnow.com'),
  trade(['Real Estate'], 'Commercial Observer', 'commercialobserver.com', 'partial'),
  trade(['Financials'], 'Finextra', 'finextra.com'),
  trade(['Financials'], 'Insurance Journal', 'insurancejournal.com'),
  // ── named but not approved: hidden, and not searched, unless switched on ──
  p('Motley Fool', 'fool.com', 'other', 'not-approved', { note: 'stock tips' }),
  p('Zacks', 'zacks.com', 'other', 'not-approved', { note: 'stock tips' }),
  p('GuruFocus', 'gurufocus.com', 'other', 'not-approved', { note: 'stock tips' }),
  p('MarketBeat', 'marketbeat.com', 'other', 'not-approved', { note: 'stock tips' }),
  p('TipRanks', 'tipranks.com', 'other', 'not-approved', { note: 'stock tips' }),
  p('Seeking Alpha', 'seekingalpha.com', 'other', 'not-approved', { note: 'stock tips' }),
  p('Simply Wall St', 'simplywall.st', 'other', 'not-approved', { note: 'stock tips' }),
  p('Kalkine', 'kalkinemedia.com', 'other', 'not-approved', { note: 'stock tips' }),
  p('Stock Titan', 'stocktitan.net', 'other', 'not-approved', { note: 'stock tips' }),
  p('Invezz', 'invezz.com', 'other', 'not-approved', { note: 'stock tips' }),
  p('AskTraders', 'asktraders.com', 'other', 'not-approved', { note: 'stock tips' }),
  p('Trefis', 'trefis.com', 'other', 'not-approved', { note: 'stock tips' }),
  p('TIKR', 'tikr.com', 'other', 'not-approved', { note: 'stock tips' }),
  p('24/7 Wall St', '247wallst.com', 'other', 'not-approved', { note: 'stock tips' }),
  p('Proactive Investors', ['proactiveinvestors.co.uk', 'proactiveinvestors.com'], 'other', 'not-approved', { note: 'often paid for by the company' }),
  p('TradingView', 'tradingview.com', 'other', 'not-approved', { note: 'republishes other outlets' }),
  p('Investing.com', 'investing.com', 'other', 'not-approved', { note: 'republishes other outlets' }),
  p('MarketScreener', 'marketscreener.com', 'other', 'not-approved', { note: 'republishes other outlets' }),
  p('OilPrice.com', 'oilprice.com', 'other', 'not-approved', { note: 'mostly opinion' }),
  p('royaldutchshellplc.com', 'royaldutchshellplc.com', 'other', 'not-approved', { note: 'a critics’ site, not Shell' }),
];

/** Shown unless switched off: free and partly-paywalled approved publishers. */
export const shownByDefault = (pub: Publisher) => pub.access === 'free' || pub.access === 'partial';

/** The publisher a web address belongs to — 'https://www.bbc.co.uk' → BBC; unknown → undefined. */
export function publisherOf(url: string): Publisher | undefined {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return undefined; }
  // Job adverts carry the paper's name but are not its news (jobs.theguardian.com).
  if (host.startsWith('jobs.')) return undefined;
  return PUBLISHERS.find((pub) => pub.hosts.some((h) => host === h || host.endsWith(`.${h}`)));
}

/**
 * Which publishers to search for a company: exactly the ones shown — the
 * defaults, minus any switched off, plus any switched on (a paywalled one
 * once ticked as subscribed). Searching a publisher only to hide it costs
 * searches a busy company needs (Apple, 2026-10-05). Trade press only for the
 * company's own sector; none when the sector is not known.
 */
export function searched(sector: Sector | null, choices: ReadonlyMap<string, boolean>): Publisher[] {
  return PUBLISHERS.filter((pub) => {
    if (pub.group === 'trade' && !(sector && pub.sectors?.includes(sector))) return false;
    return isShown(pub, choices);
  });
}

/** Whether a publisher's stories are shown, after the user's choices. */
export function isShown(pub: Publisher, choices: ReadonlyMap<string, boolean>): boolean {
  return choices.get(pub.hosts[0]!) ?? shownByDefault(pub);
}
