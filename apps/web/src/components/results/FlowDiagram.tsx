import { useEffect, useRef, useState } from 'react';
import type { Hop } from '@launch-sim/engine';
import { STATUS_GLYPH, STATUS_LABEL, statusOf, type Status } from './colors';
import { fmtPct, fmtRatio, fmtRps } from './format';

export interface FlowDiagramProps {
  hops: Hop[];
  /** e.g. "Second 03:20" when showing simulated values instead of steady state. */
  caption?: string;
}

const FILL: Record<Status, string> = {
  good: 'fill-emerald-600 dark:fill-emerald-500',
  warn: 'fill-amber-500 dark:fill-amber-500',
  crit: 'fill-red-600 dark:fill-red-500',
};

function splitLabel(label: string): [string, string?] {
  if (label.length <= 14) return [label];
  const mid = label.length / 2;
  let best = -1;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  }
  return best < 0 ? [label] : [label.slice(0, best), label.slice(best + 1)];
}

function ariaFor(h: Hop): string {
  const parts = [`${h.label}: ${fmtRps(h.rps)} requests per second`];
  if (h.hitRatio !== undefined) parts.push(`hit ratio ${fmtRatio(h.hitRatio)}`);
  if (h.utilPct !== undefined) {
    const s = statusOf(h.utilPct);
    parts.push(`${fmtPct(h.utilPct)} of limit${s ? `, ${STATUS_LABEL[s]}` : ''}`);
  }
  return parts.join(', ');
}

interface NodeProps {
  hop: Hop;
  x: number;
  y: number;
  w: number;
  h: number;
  wide: boolean;
}

function Node({ hop, x, y, w, h, wide }: NodeProps) {
  const status = statusOf(hop.utilPct);
  const pad = 10;
  const [l1, l2] = splitLabel(hop.label);
  const label = wide ? hop.label : l1;
  const gaugeW = w - pad * 2;
  const gy = y + h - 30;
  const pct = hop.utilPct ?? 0;
  const fillW = Math.max(0, Math.min(1, pct / 100)) * gaugeW;
  return (
    <g role="group" aria-label={ariaFor(hop)}>
      <title>{hop.note ? `${ariaFor(hop)}. ${hop.note}` : ariaFor(hop)}</title>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={8}
        className="fill-white stroke-slate-300 dark:fill-slate-900 dark:stroke-slate-700"
        strokeWidth={1}
      />
      <text x={x + pad} y={y + 20} className="fill-slate-600 text-[12px] font-medium dark:fill-slate-300">
        {wide ? label : l1}
      </text>
      {!wide && l2 && (
        <text x={x + pad} y={y + 34} className="fill-slate-600 text-[12px] font-medium dark:fill-slate-300">
          {l2}
        </text>
      )}
      <text
        x={x + pad}
        y={wide ? y + 46 : y + 58}
        className="fill-slate-900 text-[20px] font-semibold dark:fill-slate-50"
      >
        {fmtRps(hop.rps)}
        <tspan className="fill-slate-500 text-[11px] font-normal dark:fill-slate-400"> req/s</tspan>
      </text>
      {hop.hitRatio !== undefined && (
        <text
          x={x + pad}
          y={wide ? y + 64 : y + 78}
          className="fill-slate-600 text-[12px] dark:fill-slate-300"
        >
          {fmtRatio(hop.hitRatio)} hit ratio
        </text>
      )}
      {hop.utilPct !== undefined && status ? (
        <>
          <rect x={x + pad} y={gy} width={gaugeW} height={8} rx={4} className="fill-slate-200 dark:fill-slate-700" />
          <rect x={x + pad} y={gy} width={fillW} height={8} rx={4} className={FILL[status]} />
          {/* 70% headroom threshold tick */}
          <rect x={x + pad + gaugeW * 0.7 - 0.5} y={gy - 2} width={1} height={12} className="fill-slate-500 dark:fill-slate-400" />
          <text x={x + pad} y={gy + 22} className="fill-slate-900 text-[12px] font-medium dark:fill-slate-50">
            {STATUS_GLYPH[status]} {fmtPct(pct)} of limit
          </text>
        </>
      ) : (
        <text x={x + pad} y={gy + 22} className="fill-slate-500 text-[12px] dark:fill-slate-400">
          {hop.limit === undefined ? 'no limit' : ''}
        </text>
      )}
    </g>
  );
}

/** Request path as a chain of hop nodes; horizontal when wide, vertical when narrow. */
export function FlowDiagram({ hops, caption }: FlowDiagramProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || 960);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 960));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const horizontal = width >= 720;
  const n = hops.length;
  const nodeW = horizontal ? 124 : 300;
  const nodeH = horizontal ? 118 : 100;
  const gap = horizontal ? 54 : 40;
  const vbW = horizontal ? n * nodeW + (n - 1) * gap : nodeW;
  const vbH = horizontal ? nodeH + 24 : n * nodeH + (n - 1) * gap;
  const top = horizontal ? 24 : 0;

  return (
    <section
      ref={ref}
      aria-label="Request flow diagram"
      className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="mb-1 flex items-baseline justify-between gap-2 px-1">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Request path</h2>
        <span className="text-xs text-slate-500 dark:text-slate-400">{caption ?? 'Steady state'}</span>
      </div>
      <svg
        viewBox={`0 0 ${vbW} ${vbH}`}
        className="mx-auto block h-auto w-full"
        style={{ maxWidth: horizontal ? undefined : 340 }}
        role="group"
        aria-label={`Request path with ${n} hops`}
      >
        <defs>
          <marker id="flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" className="fill-slate-400 dark:fill-slate-500" />
          </marker>
        </defs>
        {hops.map((hop, i) => {
          const x = horizontal ? i * (nodeW + gap) : 0;
          const y = horizontal ? top : i * (nodeH + gap);
          const next = hops[i + 1];
          return (
            <g key={hop.id}>
              <Node hop={hop} x={x} y={y} w={nodeW} h={nodeH} wide={!horizontal} />
              {next &&
                (horizontal ? (
                  <g aria-hidden="true">
                    <line
                      x1={x + nodeW + 4}
                      x2={x + nodeW + gap - 4}
                      y1={top + nodeH / 2}
                      y2={top + nodeH / 2}
                      className="stroke-slate-400 dark:stroke-slate-500"
                      strokeWidth={2}
                      markerEnd="url(#flow-arrow)"
                    />
                    <text
                      x={x + nodeW + gap / 2}
                      y={top + nodeH / 2 - 8}
                      textAnchor="middle"
                      className="fill-slate-600 text-[11px] dark:fill-slate-300"
                    >
                      {fmtRps(next.rps)}/s
                    </text>
                  </g>
                ) : (
                  <g aria-hidden="true">
                    <line
                      x1={nodeW / 2}
                      x2={nodeW / 2}
                      y1={y + nodeH + 4}
                      y2={y + nodeH + gap - 4}
                      className="stroke-slate-400 dark:stroke-slate-500"
                      strokeWidth={2}
                      markerEnd="url(#flow-arrow)"
                    />
                    <text
                      x={nodeW / 2 + 10}
                      y={y + nodeH + gap / 2 + 4}
                      className="fill-slate-600 text-[11px] dark:fill-slate-300"
                    >
                      {fmtRps(next.rps)}/s
                    </text>
                  </g>
                ))}
            </g>
          );
        })}
      </svg>
      <p className="px-1 pt-1 text-[11px] text-slate-500 dark:text-slate-400">
        Gauge = load vs limit. ✓ under 70% · ! 70–99% · ✕ at or over 100%.
      </p>
    </section>
  );
}
