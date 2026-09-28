import { useMemo } from 'react';
import { Line } from 'recharts';
import type { SteadyStateResult, SummaryKpis } from '@launch-sim/engine';
import type { SavedScenario } from '../../state/types';
import { SCENARIO_SLOTS, usePalette } from './colors';
import { bucketSize, downsample, type Row } from './downsample';
import { fmtBig, fmtMs, fmtNum, fmtPct, fmtProb, fmtRatio, fmtRps, fmtSecPerHour } from './format';
import { TimeChart } from './TimeChart';
import { BOTTLENECK_LABEL } from './verdict';

export const MAX_COMPARE = 3;

interface RowDef {
  label: string;
  group: 'Steady state' | 'Timeline';
  /** Which direction is better; undefined = informational only. */
  better?: 'lower' | 'higher';
  get: (s: SavedScenario) => number | string | undefined;
  fmt: (v: number) => string;
}

const st = (f: (k: SteadyStateResult['kpis']) => number) => (s: SavedScenario) => f(s.steady.kpis);
const tl = (f: (k: SummaryKpis) => number) => (s: SavedScenario) => (s.result ? f(s.result.summary) : undefined);

export const COMPARE_ROWS: RowDef[] = [
  { group: 'Steady state', label: 'Edge requests/s', get: st((k) => k.edgeRps), fmt: fmtRps },
  { group: 'Steady state', label: 'Launch hit ratio', better: 'higher', get: st((k) => k.launchHitRatio), fmt: (v) => fmtRatio(v) },
  { group: 'Steady state', label: 'Launch origin % of limit', better: 'lower', get: st((k) => k.launchUtilPct), fmt: (v) => fmtPct(v) },
  { group: 'Steady state', label: 'Instances needed', better: 'lower', get: st((k) => k.instancesNeeded), fmt: (v) => fmtNum(v, 0) },
  { group: 'Steady state', label: 'CMS calls per page view', better: 'lower', get: st((k) => k.cmsCallsPerPageView), fmt: (v) => fmtNum(v, 1) },
  { group: 'Steady state', label: 'CMS CDN hit ratio', better: 'higher', get: st((k) => k.cmsCdnHitRatio), fmt: (v) => fmtRatio(v) },
  { group: 'Steady state', label: 'CMS origin % of limit', better: 'lower', get: st((k) => k.cmsUtilPct), fmt: (v) => fmtPct(v) },
  { group: 'Steady state', label: 'P(429 second), CMS', better: 'lower', get: st((k) => k.pCms429Second), fmt: fmtProb },
  { group: 'Steady state', label: 'CMS 429 seconds/hour', better: 'lower', get: st((k) => k.expectedCms429SecondsPerHour), fmt: fmtSecPerHour },
  { group: 'Steady state', label: 'Suggested CMS limit (req/s)', better: 'lower', get: st((k) => k.suggestedCmsLimitRps), fmt: fmtBig },
  { group: 'Steady state', label: 'Monthly API calls (uncached)', better: 'lower', get: st((k) => k.projectedMonthlyApiCalls.uncached), fmt: fmtBig },
  { group: 'Steady state', label: 'Bottleneck', get: (s) => BOTTLENECK_LABEL[s.steady.kpis.bottleneck], fmt: String },
  { group: 'Timeline', label: 'Peak Launch origin % of limit', better: 'lower', get: tl((k) => k.peakLaunchOriginPctOfLimit), fmt: (v) => fmtPct(v) },
  { group: 'Timeline', label: 'Seconds over Launch limit', better: 'lower', get: tl((k) => k.secondsOverLaunchLimit), fmt: fmtBig },
  { group: 'Timeline', label: 'Total CMS 429s', better: 'lower', get: tl((k) => k.totalCms429), fmt: fmtBig },
  { group: 'Timeline', label: 'Peak CMS origin % of limit', better: 'lower', get: tl((k) => k.peakCmsOriginPctOfLimit), fmt: (v) => fmtPct(v) },
  { group: 'Timeline', label: 'Suggested CMS limit (req/s)', better: 'lower', get: tl((k) => k.suggestedCmsLimitRps), fmt: fmtBig },
  { group: 'Timeline', label: 'Visitor error rate', better: 'lower', get: tl((k) => k.visitorErrorRate * 100), fmt: (v) => `${fmtNum(v, 2)}%` },
  { group: 'Timeline', label: 'Worst-second p95', better: 'lower', get: tl((k) => k.worstSecondVisitorP95Ms), fmt: fmtMs },
  { group: 'Timeline', label: 'Bottleneck', get: (s) => (s.result ? BOTTLENECK_LABEL[s.result.summary.bottleneck] : undefined), fmt: String },
];

/** Indices of best and worst values in a row (empty when not comparable). */
export function bestWorst(values: Array<number | string | undefined>, better?: 'lower' | 'higher') {
  const nums = values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined));
  const defined = nums.filter((v): v is number => v !== undefined);
  const out = { best: new Set<number>(), worst: new Set<number>() };
  if (!better || defined.length < 2) return out;
  const lo = Math.min(...defined);
  const hi = Math.max(...defined);
  if (lo === hi) return out;
  const bestV = better === 'lower' ? lo : hi;
  const worstV = better === 'lower' ? hi : lo;
  nums.forEach((v, i) => {
    if (v === bestV) out.best.add(i);
    if (v === worstV) out.worst.add(i);
  });
  return out;
}

export interface ComparePanelProps {
  saved: SavedScenario[];
  compareIds: string[];
  onChangeIds: (ids: string[]) => void;
  onSave: () => void;
}

export function ComparePanel({ saved, compareIds, onChangeIds, onSave }: ComparePanelProps) {
  const p = usePalette();
  const selected = compareIds
    .map((id) => saved.find((s) => s.id === id))
    .filter((s): s is SavedScenario => !!s)
    .slice(0, MAX_COMPARE);

  const toggle = (id: string) => {
    if (compareIds.includes(id)) onChangeIds(compareIds.filter((x) => x !== id));
    else if (compareIds.length < MAX_COMPARE) onChangeIds([...compareIds, id]);
  };

  const colorOf = (i: number) => p[SCENARIO_SLOTS[i % SCENARIO_SLOTS.length]!];

  const withResult = selected.filter((s) => s.result);
  const { rows, duration } = useMemo(() => {
    const maxLen = Math.max(1, ...withResult.map((s) => s.result!.series.length));
    const bucket = bucketSize(maxLen);
    const byT = new Map<number, Row>();
    selected.forEach((s, i) => {
      if (!s.result) return;
      for (const r of downsample(s.result.series, ['cmsOriginOffered', 'launchOriginOffered'], 1200, bucket)) {
        const row = byT.get(r.t) ?? ({ t: r.t } as Row);
        row[`cms${i}`] = r.cmsOriginOffered!;
        row[`launch${i}`] = r.launchOriginOffered!;
        byT.set(r.t, row);
      }
    });
    return { rows: [...byT.values()].sort((a, b) => a.t - b.t), duration: maxLen };
  }, [compareIds, saved]);

  const legend = selected.map((s, i) => ({ label: s.name, color: colorOf(i) }));
  const lines = (prefix: 'cms' | 'launch') =>
    selected.map((s, i) =>
      s.result ? (
        <Line
          key={s.id}
          dataKey={`${prefix}${i}`}
          name={s.name}
          type="monotone"
          stroke={colorOf(i)}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      ) : null,
    );
  const missing = selected.filter((s) => !s.result);

  return (
    <div className="space-y-3" role="tabpanel" aria-label="Compare">
      <section className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            Saved scenarios{' '}
            <span className="font-normal text-slate-500 dark:text-slate-400">
              (pick up to {MAX_COMPARE}; {compareIds.length} selected)
            </span>
          </h2>
          <button
            type="button"
            onClick={onSave}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm font-medium text-slate-800 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
          >
            Save current
          </button>
        </div>
        {saved.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            Nothing saved yet. Use “Save current” to snapshot this scenario, change something, then save again to compare.
          </p>
        ) : (
          <ul className="mt-2 grid gap-1 sm:grid-cols-2">
            {saved.map((s) => {
              const checked = compareIds.includes(s.id);
              const disabled = !checked && compareIds.length >= MAX_COMPARE;
              return (
                <li key={s.id}>
                  <label
                    className={`flex items-center gap-2 rounded-md px-2 py-1 text-sm ${disabled ? 'opacity-50' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}
                  >
                    <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggle(s.id)} />
                    <span className="min-w-0 flex-1 truncate text-slate-800 dark:text-slate-100">{s.name}</span>
                    <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                      {s.result ? 'timeline run' : 'not run'}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {selected.length < 2 ? (
        <p className="text-sm text-slate-600 dark:text-slate-300">Select at least two scenarios to compare them.</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <table className="w-full min-w-[480px] text-sm">
              <caption className="sr-only">KPI comparison between selected scenarios</caption>
              <thead>
                <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                  <th scope="col" className="px-3 py-2 font-medium">
                    KPI
                  </th>
                  {selected.map((s, i) => (
                    <th key={s.id} scope="col" className="px-3 py-2 font-semibold text-slate-800 dark:text-slate-100">
                      <span
                        aria-hidden="true"
                        className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                        style={{ background: colorOf(i) }}
                      />
                      {s.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(['Steady state', 'Timeline'] as const).map((group) => {
                  const defs = COMPARE_ROWS.filter((r) => r.group === group);
                  return [
                    <tr key={group} className="bg-slate-50 dark:bg-slate-800/60">
                      <th
                        scope="colgroup"
                        colSpan={selected.length + 1}
                        className="px-3 py-1 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
                      >
                        {group}
                      </th>
                    </tr>,
                    ...defs.map((def) => {
                      const values = selected.map((s) => def.get(s));
                      const { best, worst } = bestWorst(values, def.better);
                      return (
                        <tr key={`${group}-${def.label}`} className="border-t border-slate-100 dark:border-slate-800">
                          <th scope="row" className="px-3 py-1.5 text-left font-normal text-slate-600 dark:text-slate-300">
                            {def.label}
                          </th>
                          {values.map((v, i) => (
                            <td
                              key={selected[i]!.id}
                              className={`px-3 py-1.5 tabular-nums ${
                                best.has(i)
                                  ? 'bg-emerald-50 font-semibold text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200'
                                  : worst.has(i)
                                    ? 'bg-red-50 font-semibold text-red-900 dark:bg-red-950 dark:text-red-200'
                                    : 'text-slate-900 dark:text-slate-100'
                              }`}
                            >
                              {v === undefined ? (
                                <span className="text-slate-400 dark:text-slate-500">not run</span>
                              ) : typeof v === 'number' ? (
                                def.fmt(v)
                              ) : (
                                v
                              )}
                              {best.has(i) && <span className="ml-1 text-xs font-medium">▲ best</span>}
                              {worst.has(i) && <span className="ml-1 text-xs font-medium">▼ worst</span>}
                            </td>
                          ))}
                        </tr>
                      );
                    }),
                  ];
                })}
              </tbody>
            </table>
          </div>

          {missing.length > 0 && (
            <p className="text-xs text-slate-600 dark:text-slate-300">
              No timeline for {missing.map((m) => m.name).join(', ')}. Load and run a scenario, then save it again to
              include its timeline.
            </p>
          )}

          {withResult.length > 0 && (
            <>
              <TimeChart
                title="CMS origin offered"
                subtitle="Requests per second by scenario"
                data={rows}
                durationSec={duration}
                legend={legend}
                yFormat={fmtRps}
                syncId="compare"
              >
                {lines('cms')}
              </TimeChart>
              <TimeChart
                title="Launch origin offered"
                subtitle="Requests per second by scenario"
                data={rows}
                durationSec={duration}
                legend={legend}
                yFormat={fmtRps}
                syncId="compare"
              >
                {lines('launch')}
              </TimeChart>
            </>
          )}
        </>
      )}
    </div>
  );
}
