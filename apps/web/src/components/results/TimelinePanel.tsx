import { useMemo, useState } from 'react';
import { Area, Line } from 'recharts';
import type { SimulationResult } from '@launch-sim/engine';
import type { RunStatus } from '../../state/types';
import { usePalette, statusOf } from './colors';
import { downsample } from './downsample';
import { fmtBig, fmtClock, fmtMs, fmtNum, fmtPct, fmtRatio, fmtRps } from './format';
import { Kpi, KpiGrid } from './Kpi';
import { TimeChart } from './TimeChart';
import { BOTTLENECK_LABEL } from './verdict';

export interface TimelinePanelProps {
  result: SimulationResult | null;
  stale: boolean;
  runStatus: RunStatus;
  onRun: () => void;
}

const COLUMNS = [
  'edgeRps',
  'edgePageRps',
  'edgeDataRps',
  'edgeBotRps',
  'launchHitRatio',
  'cmsCdnHitRatio',
  'launchOriginOffered',
  'launchOriginAccepted',
  'launch429',
  'launchLimit',
  'instances',
  'inFlight',
  'queue',
  'c504',
  'cmsOriginOffered',
  'cmsOriginAccepted',
  'cms429',
  'cmsRetries',
  'cmsLimit',
  'visitorP50',
  'visitorP95',
  'renderP95',
  'visitorErrors5xx',
  'visitorErrors404',
  'visitorErrors429',
];

function RunButton({ onRun, runStatus, label }: { onRun: () => void; runStatus: RunStatus; label: string }) {
  const running = runStatus.state === 'running';
  return (
    <button
      type="button"
      onClick={onRun}
      disabled={running}
      className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-60"
    >
      {running ? 'Running…' : label}
    </button>
  );
}

function Progress({ status }: { status: RunStatus }) {
  if (status.state === 'running') {
    const pct = Math.round(Math.max(0, Math.min(1, status.progress)) * 100);
    return (
      <div className="space-y-1" role="status">
        <div className="text-xs text-slate-600 dark:text-slate-300">Simulating… {pct}%</div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label="Simulation progress"
          className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
        >
          <div className="h-full bg-indigo-600 dark:bg-indigo-400" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }
  if (status.state === 'error') {
    return (
      <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
        ✕ Simulation failed: {status.message}
      </p>
    );
  }
  return null;
}

export function TimelinePanel({ result, stale, runStatus, onRun }: TimelinePanelProps) {
  const p = usePalette();
  const [logScale, setLogScale] = useState(false);
  const data = useMemo(() => (result ? downsample(result.series, COLUMNS) : []), [result]);

  if (!result) {
    return (
      <div className="space-y-3" role="tabpanel" aria-label="Timeline">
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center dark:border-slate-700">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">No timeline yet</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-600 dark:text-slate-300">
            Run the second-by-second simulation to see how events, cache misses and rate limits play out over time.
          </p>
          <div className="mt-4 flex justify-center">
            <RunButton onRun={onRun} runStatus={runStatus} label="Run simulation" />
          </div>
        </div>
        <Progress status={runStatus} />
      </div>
    );
  }

  const s = result.summary;
  const dur = result.series.length;
  const common = { data, durationSec: dur, markers: result.markers };
  const line = (key: string, name: string, color: string, extra: Record<string, unknown> = {}) => (
    <Line key={key} dataKey={key} name={name} type="monotone" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} {...extra} />
  );
  const rpsFmt = (v: number) => fmtRps(v);
  const dash = { strokeDasharray: '6 4', type: 'stepAfter' as const };
  const latData = logScale
    ? data.map((r) => ({
        ...r,
        visitorP50: r.visitorP50! >= 1 ? r.visitorP50! : (null as unknown as number),
        visitorP95: r.visitorP95! >= 1 ? r.visitorP95! : (null as unknown as number),
        renderP95: r.renderP95! >= 1 ? r.renderP95! : (null as unknown as number),
      }))
    : data;

  return (
    <div className="space-y-3" role="tabpanel" aria-label="Timeline">
      {stale && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
        >
          <span>
            <span aria-hidden="true">! </span>These results are stale: the scenario changed since the last run.
          </span>
          <RunButton onRun={onRun} runStatus={runStatus} label="Re-run" />
        </div>
      )}
      {!stale && (
        <div className="flex justify-end">
          <RunButton onRun={onRun} runStatus={runStatus} label="Run again" />
        </div>
      )}
      <Progress status={runStatus} />

      <KpiGrid label="Timeline summary">
        <Kpi
          label="Peak Launch origin"
          value={fmtPct(s.peakLaunchOriginPctOfLimit)}
          status={statusOf(s.peakLaunchOriginPctOfLimit)}
          sub={`${fmtRps(s.peakLaunchOriginRps)}/s of limit`}
        />
        <Kpi
          label="Seconds over Launch limit"
          value={fmtBig(s.secondsOverLaunchLimit)}
          status={s.secondsOverLaunchLimit > 0 ? 'crit' : 'good'}
        />
        <Kpi
          label="Total CMS 429s"
          value={fmtBig(s.totalCms429)}
          status={s.totalCms429 > 0 ? 'crit' : 'good'}
          sub={`${fmtBig(s.secondsWithCms429)} seconds affected`}
        />
        <Kpi
          label="Peak CMS origin"
          value={fmtPct(s.peakCmsOriginPctOfLimit)}
          status={statusOf(s.peakCmsOriginPctOfLimit)}
          sub={`${fmtRps(s.peakCmsOriginOfferedRps)}/s offered`}
        />
        <Kpi label="Suggested CMS limit" value={`${fmtBig(s.suggestedCmsLimitRps)}/s`} sub="peak + 20%" />
        <Kpi label="Visitor error rate" value={fmtNum(s.visitorErrorRate * 100, 2) + '%'} sub={`${fmtBig(s.errorPagesServed)} errors served`} />
        <Kpi label="Worst-second p95" value={fmtMs(s.worstSecondVisitorP95Ms)} sub="visitor latency" />
        <Kpi label="Bottleneck" value={BOTTLENECK_LABEL[s.bottleneck]} status={s.bottleneck === 'none' ? undefined : 'crit'} />
      </KpiGrid>

      {result.markers.length > 0 && (
        <p className="text-xs text-slate-600 dark:text-slate-300">
          <span className="font-medium">Events (dotted lines):</span>{' '}
          {result.markers.map((m) => `${fmtClock(m.timeSec)} ${m.label}`).join(' · ')}
        </p>
      )}

      <TimeChart
        {...common}
        title="Edge traffic"
        subtitle="Requests per second reaching the edge"
        legend={[
          { label: 'Total', color: p.blue },
          { label: 'Page', color: p.orange },
          { label: 'Data', color: p.aqua },
          { label: 'Bot (of which)', color: p.magenta },
        ]}
        yFormat={rpsFmt}
      >
        {line('edgeRps', 'Total', p.blue)}
        {line('edgePageRps', 'Page', p.orange)}
        {line('edgeDataRps', 'Data', p.aqua)}
        {line('edgeBotRps', 'Bot (of which)', p.magenta)}
      </TimeChart>

      <TimeChart
        {...common}
        title="Cache hit ratios"
        subtitle="Launch page CDN and CMS CDN"
        legend={[
          { label: 'Launch hit ratio', color: p.blue },
          { label: 'CMS CDN hit ratio', color: p.violet },
        ]}
        yFormat={(v) => fmtRatio(v)}
        yDomain={[0, 1]}
        height={160}
      >
        {line('launchHitRatio', 'Launch hit ratio', p.blue)}
        {line('cmsCdnHitRatio', 'CMS CDN hit ratio', p.violet)}
      </TimeChart>

      <TimeChart
        {...common}
        title="Launch origin"
        subtitle="Offered vs accepted against the limit"
        legend={[
          { label: 'Offered', color: p.blue },
          { label: 'Accepted', color: p.aqua },
          { label: 'Limit', color: p.ink, dashed: true },
          { label: '429 rejected', color: p.red },
        ]}
        yFormat={rpsFmt}
      >
        {line('launchOriginOffered', 'Offered', p.blue)}
        {line('launchOriginAccepted', 'Accepted', p.aqua)}
        {line('launchLimit', 'Limit', p.ink, { ...dash, strokeWidth: 1.5 })}
        {line('launch429', '429 rejected', p.red)}
      </TimeChart>

      <TimeChart
        {...common}
        title="Launch compute"
        subtitle="Instances, in-flight renders, queue and 504s"
        legend={[
          { label: 'Instances', color: p.violet },
          { label: 'In flight', color: p.blue },
          { label: 'Queue', color: p.orange },
          { label: '504/s', color: p.red },
        ]}
        yFormat={rpsFmt}
      >
        {line('instances', 'Instances', p.violet, { type: 'stepAfter' })}
        {line('inFlight', 'In flight', p.blue)}
        {line('queue', 'Queue', p.orange)}
        {line('c504', '504/s', p.red)}
      </TimeChart>

      <TimeChart
        {...common}
        title="CMS origin"
        subtitle="Offered vs accepted against the org limit, with 429s and retries"
        legend={[
          { label: 'Offered', color: p.blue },
          { label: 'Accepted', color: p.aqua },
          { label: 'Limit', color: p.ink, dashed: true },
          { label: '429 rejected', color: p.red },
          { label: 'Retries', color: p.orange },
        ]}
        yFormat={rpsFmt}
      >
        {line('cmsOriginOffered', 'Offered', p.blue)}
        {line('cmsOriginAccepted', 'Accepted', p.aqua)}
        {line('cmsLimit', 'Limit', p.ink, { ...dash, strokeWidth: 1.5 })}
        {line('cms429', '429 rejected', p.red)}
        {line('cmsRetries', 'Retries', p.orange)}
      </TimeChart>

      <TimeChart
        {...common}
        data={latData}
        title="Latency"
        subtitle="Visitor-perceived p50 and p95, and render p95"
        legend={[
          { label: 'Visitor p50', color: p.blue },
          { label: 'Visitor p95', color: p.orange },
          { label: 'Render p95', color: p.violet },
        ]}
        yFormat={fmtMs}
        yWidth={62}
        yScale={logScale ? 'log' : 'linear'}
        yDomain={logScale ? [1, 'auto'] : undefined}
        actions={
          <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={logScale} onChange={(e) => setLogScale(e.target.checked)} />
            Log scale
          </label>
        }
      >
        {line('visitorP50', 'Visitor p50', p.blue, { connectNulls: true })}
        {line('visitorP95', 'Visitor p95', p.orange, { connectNulls: true })}
        {line('renderP95', 'Render p95', p.violet, { connectNulls: true })}
      </TimeChart>

      <TimeChart
        {...common}
        title="Visitor errors"
        subtitle="Errors served to visitors per second, by type"
        legend={[
          { label: '5xx', color: p.red },
          { label: '404', color: p.yellow },
          { label: '429', color: p.orange },
        ]}
        yFormat={rpsFmt}
      >
        {(
          [
            ['visitorErrors5xx', '5xx', p.red],
            ['visitorErrors404', '404', p.yellow],
            ['visitorErrors429', '429', p.orange],
          ] as const
        ).map(([k, name, color]) => (
          <Area
            key={k}
            dataKey={k}
            name={name}
            stackId="errors"
            type="monotone"
            stroke={p.surface}
            strokeWidth={1}
            fill={color}
            fillOpacity={0.85}
            isAnimationActive={false}
          />
        ))}
      </TimeChart>

      <DataTable data={data} />
    </div>
  );
}

function DataTable({ data }: { data: ReturnType<typeof downsample> }) {
  const rows = useMemo(() => {
    const step = Math.max(1, Math.ceil(data.length / 40));
    return data.filter((_, i) => i % step === 0);
  }, [data]);
  return (
    <details className="rounded-xl border border-slate-200 bg-white p-3 text-sm dark:border-slate-800 dark:bg-slate-900">
      <summary className="cursor-pointer font-medium text-slate-800 dark:text-slate-100">Data table (sampled)</summary>
      <div className="mt-2 max-h-72 overflow-auto">
        <table className="w-full text-xs tabular-nums">
          <thead className="sticky top-0 bg-white text-left text-slate-500 dark:bg-slate-900 dark:text-slate-400">
            <tr>
              {['Time', 'Edge/s', 'Launch hit', 'Launch origin/s', 'CMS origin/s', 'CMS 429/s', 'Visitor p95'].map((h) => (
                <th key={h} className="px-2 py-1 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-slate-800 dark:text-slate-200">
            {rows.map((r) => (
              <tr key={r.t} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-2 py-1">{fmtClock(r.t)}</td>
                <td className="px-2 py-1">{fmtRps(r.edgeRps!)}</td>
                <td className="px-2 py-1">{fmtRatio(r.launchHitRatio!)}</td>
                <td className="px-2 py-1">{fmtRps(r.launchOriginOffered!)}</td>
                <td className="px-2 py-1">{fmtRps(r.cmsOriginOffered!)}</td>
                <td className="px-2 py-1">{fmtRps(r.cms429!)}</td>
                <td className="px-2 py-1">{fmtMs(r.visitorP95!)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
