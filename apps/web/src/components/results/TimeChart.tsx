import type { ReactNode } from 'react';
import { ComposedChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { SimulationMarker } from '@launch-sim/engine';
import { usePalette } from './colors';
import { fmtClock } from './format';
import { useHoverStore } from './hover';
import type { Row } from './downsample';

export interface LegendItem {
  label: string;
  color: string;
  dashed?: boolean;
}

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300" aria-label="Legend">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5">
          <svg width="18" height="8" aria-hidden="true">
            <line
              x1="0"
              x2="18"
              y1="4"
              y2="4"
              stroke={it.color}
              strokeWidth={2}
              strokeDasharray={it.dashed ? '5 3' : undefined}
              strokeLinecap="round"
            />
          </svg>
          {it.label}
        </li>
      ))}
    </ul>
  );
}

export interface TimeChartProps {
  title: string;
  subtitle?: string;
  data: Row[];
  durationSec: number;
  markers?: SimulationMarker[];
  legend: LegendItem[];
  yFormat: (v: number) => string;
  yWidth?: number;
  yDomain?: [number | string, number | string];
  yScale?: 'linear' | 'log';
  syncId?: string;
  height?: number;
  /** Extra controls in the card header. */
  actions?: ReactNode;
  children: ReactNode;
}

/** Card with a synced time-series chart: mm:ss axis, event markers, hover shared with the flow diagram. */
export function TimeChart({
  title,
  subtitle,
  data,
  durationSec,
  markers = [],
  legend,
  yFormat,
  yWidth = 48,
  yDomain,
  yScale = 'linear',
  syncId = 'timeline',
  height = 210,
  actions,
  children,
}: TimeChartProps) {
  const p = usePalette();
  const setSecond = useHoverStore((s) => s.setSecond);
  return (
    <figure
      className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900"
      aria-label={title}
    >
      <figcaption className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</h3>
          {subtitle && <p className="text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>}
        </div>
        {actions}
      </figcaption>
      <Legend items={legend} />
      <div className="mt-2" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            syncId={syncId}
            margin={{ top: 14, right: 12, bottom: 0, left: 0 }}
            onMouseMove={(st) => {
              const label = (st as { activeLabel?: number | string } | undefined)?.activeLabel;
              if (label !== undefined && label !== null) setSecond(Number(label));
            }}
            onMouseLeave={() => setSecond(null)}
          >
            <CartesianGrid stroke={p.grid} vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              domain={[0, Math.max(1, durationSec - 1)]}
              tickFormatter={fmtClock}
              tick={{ fill: p.muted, fontSize: 11 }}
              stroke={p.grid}
              tickLine={false}
              minTickGap={32}
            />
            <YAxis
              tickFormatter={yFormat}
              width={yWidth}
              tick={{ fill: p.muted, fontSize: 11 }}
              stroke={p.grid}
              tickLine={false}
              axisLine={false}
              scale={yScale}
              domain={yDomain ?? [0, 'auto']}
              allowDataOverflow={yScale === 'log'}
            />
            <Tooltip
              isAnimationActive={false}
              labelFormatter={(l) => `Time ${fmtClock(Number(l))}`}
              formatter={(v, name) => [typeof v === 'number' ? yFormat(v) : String(v), String(name)]}
              contentStyle={{
                background: p.surface,
                border: `1px solid ${p.grid}`,
                borderRadius: 8,
                fontSize: 12,
                color: p.ink,
              }}
              labelStyle={{ color: p.ink, fontWeight: 600 }}
              itemStyle={{ color: p.ink, padding: 0 }}
              cursor={{ stroke: p.muted, strokeWidth: 1 }}
            />
            {markers.map((m, i) => (
              <ReferenceLine
                key={`${m.timeSec}-${i}`}
                x={m.timeSec}
                stroke={p.muted}
                strokeDasharray="2 3"
                ifOverflow="hidden"
                label={{
                  value: m.label.length > 16 ? `${m.label.slice(0, 15)}…` : m.label,
                  position: 'insideTopRight',
                  fill: p.muted,
                  fontSize: 10,
                }}
              />
            ))}
            {children}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
