/**
 * Single-series vertical bar chart (plain HTML): thin bars with rounded tops anchored
 * to the baseline, a recessive grid, sparse x labels and a tooltip per bar.
 */
import { useState } from 'react';

export interface Bar {
  label: string; // x tick
  value: number;
  tooltip: string;
  emphasis?: boolean; // the bar the caption talks about
  pending?: boolean; // e.g. a year still being measured
}

interface BarChartProps {
  bars: Bar[];
  height?: number;
  color?: string;
  mutedColor?: string;
  labelEvery?: number;
  ariaLabel: string;
  bands?: Array<{ from: number; to: number; label: string }>; // shaded index ranges
}

export function BarChart({
  bars,
  height = 150,
  color = '#2a78d6',
  mutedColor,
  labelEvery = 1,
  ariaLabel,
  bands = [],
}: BarChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...bars.map((b) => b.value));
  const niceMax = (() => {
    const p = 10 ** Math.floor(Math.log10(max));
    return Math.ceil(max / p) * p;
  })();
  const anyEmphasis = bars.some((b) => b.emphasis);

  return (
    <figure className="relative" aria-label={ariaLabel}>
      <div className="relative" style={{ height }}>
        {/* grid */}
        {[0, 0.5, 1].map((f) => (
          <div
            key={f}
            className="pointer-events-none absolute inset-x-0 flex items-center"
            style={{ bottom: `${f * 100}%` }}
          >
            <div className={`w-full border-t ${f === 0 ? 'border-slate-300' : 'border-dashed border-slate-200'}`} />
            <span className="absolute -top-2 left-0 bg-white pr-1 text-[10px] tabular-nums text-slate-400">
              {f === 0 ? '' : Math.round(niceMax * f).toLocaleString('fi-FI')}
            </span>
          </div>
        ))}
        {/* bands */}
        {bands.map((b) => (
          <div
            key={b.label}
            className="pointer-events-none absolute bottom-0 top-0 rounded-md bg-amber-100/60"
            style={{ left: `${(b.from / bars.length) * 100}%`, width: `${((b.to - b.from + 1) / bars.length) * 100}%` }}
          >
            <span className="absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-medium text-amber-800">
              {b.label}
            </span>
          </div>
        ))}
        {/* bars */}
        <div className="absolute inset-0 flex items-end gap-[2px] pl-6">
          {bars.map((b, i) => {
            const h = (b.value / niceMax) * 100;
            const fill = b.pending
              ? 'transparent'
              : anyEmphasis && !b.emphasis
                ? mutedColor ?? `${color}73`
                : color;
            return (
              <div
                key={i}
                className="relative flex h-full flex-1 items-end justify-center"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                <div
                  className={`w-full max-w-[22px] rounded-t-[4px] transition-opacity ${
                    b.pending ? 'border-2 border-dashed border-slate-400' : ''
                  } ${hover !== null && hover !== i ? 'opacity-60' : ''}`}
                  style={{ height: `${b.pending ? 100 : Math.max(h, b.value > 0 ? 1.5 : 0)}%`, background: fill }}
                />
                {hover === i && (
                  <div className="pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[11px] font-medium text-white shadow-lg">
                    {b.tooltip}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-1 flex gap-[2px] pl-6">
        {bars.map((b, i) => (
          <div key={i} className="flex-1 text-center text-[10px] tabular-nums text-slate-500">
            {i % labelEvery === 0 ? b.label : ''}
          </div>
        ))}
      </div>
    </figure>
  );
}

/** Horizontal bars for a few named categories (one series). */
export function HBarList({
  rows,
  color = '#2a78d6',
}: {
  rows: Array<{ label: string; value: number; note?: string }>;
  color?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const total = rows.reduce((a, r) => a + r.value, 0) || 1;
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.label} className="text-xs">
          <div className="mb-1 flex justify-between">
            <span className="font-medium text-slate-800">{r.label}</span>
            <span className="tabular-nums text-slate-500">
              {r.value.toLocaleString('fi-FI')} · {Math.round((r.value / total) * 100)}%
            </span>
          </div>
          <div className="h-2 rounded-full bg-slate-100">
            <div className="h-2 rounded-full" style={{ width: `${(r.value / max) * 100}%`, background: color }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
