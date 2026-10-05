<script lang="ts">
  /**
   * Closing prices, with optional moving averages. One axis, thin lines,
   * recessive grid; a crosshair reads every series at the pointer's day.
   * Colours are the validated chart series (style.css); text stays in text
   * colours, identity comes from the line keys beside it.
   */
  import { price } from './format.ts';

  interface Overlay { readonly label: string; readonly values: readonly (number | null)[]; readonly color: string }
  let { dates, closes, currency, overlays = [] }: {
    dates: readonly string[];
    closes: readonly number[];
    currency: string;
    /** Aligned with `closes`. */
    overlays?: readonly Overlay[];
  } = $props();

  const RANGES = [['6M', 126], ['1Y', 252], ['5Y', 1260], ['10Y', Infinity]] as const;
  let range = $state<(typeof RANGES)[number][0]>('1Y');
  let hover = $state<number | null>(null);

  const W = 720, H = 240, PAD_L = 8, PAD_R = 70, PAD_T = 12, PAD_B = 24;

  const view = $derived.by(() => {
    const n = Math.min(closes.length, RANGES.find(([r]) => r === range)![1]);
    const from = closes.length - n;
    const series = [{ label: 'Close', color: 'var(--series-1)', values: closes.slice(from) as (number | null)[] },
      ...overlays.map((o) => ({ ...o, values: o.values.slice(from) }))];
    const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
    const lo = Math.min(...all), hi = Math.max(...all);
    const step = niceStep((hi - lo) / 4 || hi / 10 || 1);
    const yMin = Math.floor(lo / step) * step, yMax = Math.ceil(hi / step) * step;
    const x = (i: number) => PAD_L + (n === 1 ? 0 : (i * (W - PAD_L - PAD_R)) / (n - 1));
    const y = (v: number) => PAD_T + ((yMax - v) / (yMax - yMin || 1)) * (H - PAD_T - PAD_B);
    const path = (values: readonly (number | null)[]) => {
      let d = '', pen = false;
      values.forEach((v, i) => {
        if (v === null) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      return d;
    };
    const ticks: number[] = [];
    for (let v = yMin; v <= yMax + step / 2; v += step) ticks.push(v);
    const dayList = dates.slice(from);
    const xTicks = [0.02, 0.26, 0.5, 0.74, 0.98].map((f) => Math.round(f * (n - 1)));
    return { n, series, ticks, x, y, path, dayList, xTicks, long: n > 300, tickDigits: step >= 1 ? 0 : 2 };
  });

  function niceStep(raw: number): number {
    const p = 10 ** Math.floor(Math.log10(raw));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  function label(iso: string, long: boolean): string {
    const d = new Date(`${iso}T12:00:00Z`);
    return d.toLocaleDateString('en-GB', long ? { month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
  }

  function move(e: PointerEvent) {
    const box = (e.currentTarget as SVGElement).getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const i = Math.round(((px - PAD_L) / (W - PAD_L - PAD_R)) * (view.n - 1));
    hover = Math.max(0, Math.min(view.n - 1, i));
  }
</script>

<div class="chart">
  <div class="top">
    <div class="legend small">
      {#each view.series as s (s.label)}
        <span><i style:background={s.color}></i>{s.label}</span>
      {/each}
    </div>
    <div class="ranges">
      {#each RANGES as [r] (r)}<button class:active={range === r} onclick={() => (range = r)}>{r}</button>{/each}
    </div>
  </div>

  <div class="plot">
    <svg viewBox="0 0 {W} {H}" role="img" aria-label="Closing prices, {range}"
      onpointermove={move} onpointerleave={() => (hover = null)}>
      {#each view.ticks as t (t)}
        <line class="grid" x1={PAD_L} x2={W - PAD_R} y1={view.y(t)} y2={view.y(t)} />
        <text class="axis" x={W - PAD_R + 6} y={view.y(t) + 4}>{price(t, currency, view.tickDigits)}</text>
      {/each}
      {#each view.xTicks as i (i)}
        <text class="axis" x={view.x(i)} y={H - 6} text-anchor="middle">{label(view.dayList[i]!, view.long)}</text>
      {/each}
      {#each [...view.series].reverse() as s (s.label)}
        <path d={view.path(s.values)} stroke={s.color} />
      {/each}
      {#if hover !== null}
        <line class="cross" x1={view.x(hover)} x2={view.x(hover)} y1={PAD_T} y2={H - PAD_B} />
        {#each view.series as s (s.label)}
          {#if s.values[hover] != null}
            <circle cx={view.x(hover)} cy={view.y(s.values[hover]!)} r="4" fill={s.color} />
          {/if}
        {/each}
      {:else}
        {@const last = view.series[0]!.values[view.n - 1]!}
        <circle cx={view.x(view.n - 1)} cy={view.y(last)} r="4" fill="var(--series-1)" />
      {/if}
    </svg>
    {#if hover !== null}
      <div class="tip small" style:left="{(view.x(hover) / W) * 100}%" class:flip={view.x(hover) > W * 0.6}>
        <div class="muted">{view.dayList[hover]}</div>
        {#each view.series as s (s.label)}
          {#if s.values[hover] != null}
            <div><i style:background={s.color}></i><strong>{price(s.values[hover]!, currency)}</strong> {s.label}</div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
  .legend { display: flex; gap: 14px; color: var(--muted); }
  .legend i, .tip i { display: inline-block; width: 12px; height: 2px; border-radius: 1px; vertical-align: middle; margin-right: 5px; }
  .ranges { display: flex; gap: 2px; }
  .ranges button { border: 1px solid var(--line); background: none; color: var(--muted); padding: 2px 8px; border-radius: 4px; font-size: 12px; }
  .ranges button.active { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
  .plot { position: relative; }
  svg { width: 100%; height: auto; display: block; touch-action: none; }
  path { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
  circle { stroke: var(--surface); stroke-width: 2; }
  .grid { stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .cross { stroke: var(--muted); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .axis { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .tip { position: absolute; top: 6px; transform: translateX(10px); background: var(--surface); border: 1px solid var(--line);
    border-radius: 6px; padding: 6px 8px; pointer-events: none; white-space: nowrap; box-shadow: 0 2px 8px rgb(0 0 0 / 0.08); }
  .tip.flip { transform: translateX(calc(-100% - 10px)); }
  .tip strong { font-variant-numeric: tabular-nums; }
</style>
