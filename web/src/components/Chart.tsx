import { useEffect, useRef } from 'react';
import uPlot, { type AlignedData, type Options } from 'uplot';
import 'uplot/dist/uPlot.min.css';

export interface ChartSeries {
  label: string;
  color: string;
  /** Format for the axis and legend values. */
  fmt?: (v: number) => string;
  fill?: boolean;
}

/** Thin uPlot wrapper: creates once, then only calls setData on updates. */
export function Chart({ data, series, height = 160, yMax, fmt }: { data: AlignedData; series: ChartSeries[]; height?: number; yMax?: number; fmt?: (v: number) => string }) {
  const el = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const key = series.map((s) => s.label).join('|') + String(yMax);

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const css = getComputedStyle(document.documentElement);
    const muted = css.getPropertyValue('--color-muted').trim() || '#6b7280';
    const grid = css.getPropertyValue('--color-line').trim() || '#e8edf5';
    const opts: Options = {
      width: node.clientWidth,
      height,
      cursor: { drag: { x: false, y: false }, points: { size: 6 } },
      legend: { show: false },
      scales: { x: { time: true }, y: { range: (_u, min, max) => [0, yMax ?? Math.max(max * 1.1, min + 1)] } },
      axes: [
        { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { show: false }, font: '10px system-ui' },
        { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { show: false }, size: 46, font: '10px system-ui', values: (_u, vals) => vals.map((v) => (fmt ? fmt(v) : String(v))) },
      ],
      series: [
        {},
        ...series.map((s) => ({
          label: s.label,
          stroke: s.color,
          width: 1.5,
          fill: s.fill ? `${s.color}22` : undefined,
          points: { show: false },
          value: (_u: uPlot, v: number | null) => (v === null ? '—' : s.fmt ? s.fmt(v) : v.toFixed(1)),
        })),
      ],
    };
    plot.current = new uPlot(opts, data, node);
    const ro = new ResizeObserver(() => plot.current?.setSize({ width: node.clientWidth, height }));
    ro.observe(node);
    return () => {
      ro.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
    // Recreate only when the series layout changes; data updates go through setData below.
  }, [key, height]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    plot.current?.setData(data);
  }, [data]);

  return (
    <div>
      {series.length > 1 && (
        <ul className="mb-2 flex flex-wrap gap-3 text-xs text-muted">
          {series.map((s) => (
            <li key={s.label} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full" style={{ background: s.color }} aria-hidden />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div ref={el} className="manar-chart w-full" />
    </div>
  );
}
