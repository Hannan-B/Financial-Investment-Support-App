/**
 * The identity of each kind of thing a comment can be about (§6.2): the
 * concept, never its place on screen, so a comment finds its item again after
 * a refresh, and the same figure on two tabs is the same item.
 */
export const targetKey = {
  /** A stored figure: 'fact:income.revenue:FY2025', or 'fact:valuation.pe' for one with no period. */
  fact: (f: { readonly fieldPath: string; readonly period: string | null }) => `fact:${f.fieldPath}${f.period ? `:${f.period}` : ''}`,
  /** A worked-out indicator, by its name: 'indicator:RSI (14)'. */
  indicator: (name: string) => `indicator:${name}`,
  /** One day on the price chart. */
  price: (date: string) => `price:${date}`,
  /** A headline, by its address. */
  news: (url: string) => `news:${url}`,
  /** An insider dealing, by its line's own key. */
  dealing: (key: string) => `dealing:${key}`,
};
