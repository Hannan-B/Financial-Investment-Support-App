<script lang="ts">
  /**
   * Each indicator with its working: the formula, the numbers that went into
   * the last step, and what came out (§11.7 step 2.2). Periods are changed
   * here, in place, and remembered (§12.5).
   */
  import type { StoredPrices } from '../research/prices.ts';
  import { indicators, DEFAULT_SETTINGS, type IndicatorSettings, type Indicator, type Working } from '../research/technicals.ts';
  import { price, num } from './format.ts';

  let { prices }: { prices: StoredPrices } = $props();

  const KEY = 'indicator-settings';
  function remembered(): IndicatorSettings {
    try {
      const saved = localStorage.getItem(KEY);
      return saved ? { ...DEFAULT_SETTINGS, ...(JSON.parse(saved) as Partial<IndicatorSettings>) } : DEFAULT_SETTINGS;
    } catch { return DEFAULT_SETTINGS; }
  }
  let settings = $state<IndicatorSettings>(remembered());
  let editing = $state(false);
  let draft = $state<Record<string, string>>({});
  let error = $state('');

  const result = $derived.by(() => {
    try { return { ok: indicators(prices, settings) } as const; } catch (e) { return { error: String(e) } as const; }
  });
  const list = $derived('ok' in result && result.ok
    ? [...result.ok.sma, ...result.ok.ema, result.ok.rsi, result.ok.macd, result.ok.bollinger, result.ok.atr] as Indicator<unknown>[]
    : []);

  const FIELDS = [
    ['sma', 'Simple averages'], ['ema', 'Exponential averages'], ['rsi', 'RSI'], ['fast', 'MACD fast'], ['slow', 'MACD slow'],
    ['signal', 'MACD signal'], ['bbPeriod', 'Bollinger period'], ['bbWidth', 'Bollinger width'], ['atr', 'ATR'],
  ] as const;

  function startEditing() {
    const s = settings;
    draft = {
      sma: s.sma.join(', '), ema: s.ema.join(', '), rsi: String(s.rsi), fast: String(s.macd.fast), slow: String(s.macd.slow),
      signal: String(s.macd.signal), bbPeriod: String(s.bollinger.period), bbWidth: String(s.bollinger.width), atr: String(s.atr),
    };
    editing = true;
  }
  function apply() {
    error = '';
    const list = (t: string) => t.split(',').map((x) => Number(x.trim())).filter((x) => x !== 0 || t.trim() !== '');
    const n = (t: string | undefined) => Number(String(t ?? '').trim());
    const next: IndicatorSettings = {
      sma: list(draft['sma'] ?? ''), ema: list(draft['ema'] ?? ''), rsi: n(draft['rsi']),
      macd: { fast: n(draft['fast']), slow: n(draft['slow']), signal: n(draft['signal']) },
      bollinger: { period: n(draft['bbPeriod']), width: n(draft['bbWidth']) }, atr: n(draft['atr']),
    };
    try {
      indicators({ currency: prices.currency, bars: prices.bars.slice(-5) }, next); // refuses nonsense periods
    } catch (e) {
      error = String(e).replace(/^RangeError: /, '');
      return;
    }
    settings = next;
    editing = false;
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* remembered for this session only */ }
  }
  function reset() {
    settings = DEFAULT_SETTINGS;
    try { localStorage.removeItem(KEY); } catch { /* nothing to forget */ }
    editing = false;
  }

  const show = (w: Working, v: number) => (w.unit === prices.currency ? price(v, prices.currency) : num(v));
  const unitName = (u: string) => (u === 'GBp' ? 'pence' : u);
</script>

<div class="settings small">
  {#if editing}
    <form class="periods" onsubmit={(e) => { e.preventDefault(); apply(); }}>
      {#each FIELDS as [key, label] (key)}
        <label>{label}<input bind:value={draft[key]} inputmode="decimal" spellcheck="false" /></label>
      {/each}
      <div><button type="submit">Apply</button> <button type="button" class="link" onclick={() => (editing = false)}>Cancel</button></div>
    </form>
    {#if error}<div class="error">{error}</div>{/if}
  {:else}
    <span class="muted">Periods: SMA {settings.sma.join(', ')} · EMA {settings.ema.join(', ')} · RSI {settings.rsi} ·
      MACD {settings.macd.fast}/{settings.macd.slow}/{settings.macd.signal} · Bollinger {settings.bollinger.period}, {settings.bollinger.width} · ATR {settings.atr}</span>
    <button class="link" onclick={startEditing}>Change</button>
    {#if JSON.stringify(settings) !== JSON.stringify(DEFAULT_SETTINGS)}<button class="link" onclick={reset}>Back to the usual</button>{/if}
  {/if}
</div>

{#if 'error' in result}<p class="error">{result.error}</p>{/if}

<div class="cards">
  {#each list as r (r.kind === 'ok' ? r.working.indicator : r.indicator)}
    {#if r.kind === 'insufficient'}
      <article class="card">
        <h4>{r.indicator}</h4>
        <p class="muted small">Needs {r.needed} days of prices; {r.have} stored.</p>
      </article>
    {:else}
      {@const w = r.working}
      <article class="card">
        <h4>{w.indicator} <span class="muted small">· {w.date} · {unitName(w.unit)}</span></h4>
        <dl class="result">
          {#each w.result as l (l.label)}<dt>{l.label}</dt><dd class="num">{show(w, l.value)}</dd>{/each}
        </dl>
        <details>
          <summary class="small">Working</summary>
          <ol class="formula small">{#each w.formula as f (f)}<li>{f}</li>{/each}</ol>
          <table class="small"><tbody>
            {#each w.inputs.length > 6 ? [...w.inputs.slice(0, 2), null, ...w.inputs.slice(-2)] : w.inputs as l, i (l ? l.label : `gap-${i}`)}
              <tr>{#if l}<td>{l.label}</td><td class="num">{show(w, l.value)}</td>{:else}<td colspan="2" class="muted">… {w.inputs.length - 4} more, listed under “all inputs”</td>{/if}</tr>
            {/each}
          </tbody></table>
          {#if w.inputs.length > 6}
            <details class="all">
              <summary class="small">All {w.inputs.length} inputs</summary>
              <table class="small"><tbody>{#each w.inputs as l (l.label)}<tr><td>{l.label}</td><td class="num">{show(w, l.value)}</td></tr>{/each}</tbody></table>
            </details>
          {/if}
          {#each w.notes as n (n)}<p class="small muted">{n}</p>{/each}
        </details>
      </article>
    {/if}
  {/each}
</div>

<style>
  .settings { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
  .periods { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; width: 100%; align-items: end; }
  .periods label { display: grid; gap: 2px; color: var(--muted); }
  .periods input { padding: 4px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); color: var(--text); font-variant-numeric: tabular-nums; }
  .settings button:not(.link) { padding: 3px 10px; border: 0; border-radius: 4px; background: var(--accent); color: var(--surface); }
  .link { border: 0; background: none; color: var(--muted); text-decoration: underline; padding: 0; }
  .error { color: var(--bad); width: 100%; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; align-items: start; }
  .card { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  h4 { margin: 0 0 6px; font-size: 13px; }
  .result { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; margin: 0 0 6px; }
  .result dt { color: var(--muted); }
  .result dd { margin: 0; font-weight: 600; }
  summary { cursor: pointer; color: var(--accent); }
  .formula { margin: 6px 0; padding-left: 18px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2px 0; border-bottom: 1px solid var(--line); }
  .all { margin-top: 6px; }
</style>
