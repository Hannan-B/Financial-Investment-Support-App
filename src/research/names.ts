/**
 * What the screens call each stored figure, by its field path (§7②).
 * One list for the report's tabs and the History tab, so a figure reads the
 * same everywhere. Finviz's name wins where two sites share a path.
 */
import { CONCEPTS, CONCEPT_NAMES, type Concept } from './figures.ts';
import { FINVIZ_NAMES } from './finviz.ts';
import { STATISTICS_NAMES } from './statistics.ts';

/** The indicators worked out from stored prices, as `company.ts` names their paths. */
const TECHNICAL_NAMES: Readonly<Record<string, string>> = {
  'technical.sma_20': '20-day average',
  'technical.sma_50': '50-day average',
  'technical.sma_200': '200-day average',
  'technical.ema_12': '12-day weighted average',
  'technical.ema_26': '26-day weighted average',
  'technical.rsi_14': 'RSI (14 days)',
  'technical.atr_14': 'ATR (14 days)',
  'technical.macd_12_26_9.line': 'MACD line',
  'technical.macd_12_26_9.signal': 'MACD signal',
  'technical.macd_12_26_9.histogram': 'MACD histogram',
  'technical.bollinger_20_2.upper': 'Bollinger band, upper',
  'technical.bollinger_20_2.middle': 'Bollinger band, middle',
  'technical.bollinger_20_2.lower': 'Bollinger band, lower',
};

export const FIGURE_NAMES: Readonly<Record<string, string>> = {
  ...Object.fromEntries((Object.keys(CONCEPTS) as Concept[]).map((c) => [CONCEPTS[c], CONCEPT_NAMES[c]])),
  ...STATISTICS_NAMES,
  ...FINVIZ_NAMES,
  ...TECHNICAL_NAMES,
  'price.close': 'Share price',
  'calendar.next_earnings': 'Next results',
  'calendar.last_ex_dividend': 'Last ex-dividend date',
  'calendar.next_ex_dividend': 'Next ex-dividend date',
};

export const figureName = (path: string): string => FIGURE_NAMES[path] ?? path;
