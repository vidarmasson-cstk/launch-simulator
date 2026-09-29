import { resolveFramework } from '@launch-sim/engine';
import { useAppStore } from '../../state/store';
import { NumInput, SelectInput, Toggle } from './inputs';
import { focusRing } from '../ui';

type NumKey =
  | 'globalCalls'
  | 'pageCalls'
  | 'listCalls'
  | 'n1Calls'
  | 'sequentialWaves'
  | 'cpuRenderMsL1'
  | 'clientNavFraction'
  | 'dataRequestsPerNav'
  | 'navRenderCallFraction'
  | 'prefetchPerView'
  | 'clientCmsCallsPerNav';

const NUMS: { key: NumKey; label: string; unit: string; min: number; max?: number; step: number }[] = [
  { key: 'globalCalls', label: 'Global CMS calls / render', unit: 'calls', min: 0, step: 1 },
  { key: 'pageCalls', label: 'Page CMS calls / render', unit: 'calls', min: 0, step: 1 },
  { key: 'listCalls', label: 'List CMS calls / render', unit: 'calls', min: 0, step: 1 },
  { key: 'n1Calls', label: 'N+1 CMS calls / render', unit: 'calls', min: 0, step: 1 },
  { key: 'sequentialWaves', label: 'Sequential call waves', unit: 'waves', min: 0, step: 1 },
  { key: 'cpuRenderMsL1', label: 'Render CPU time (L1)', unit: 'ms', min: 0, step: 5 },
  { key: 'clientNavFraction', label: 'Client-nav fraction of views', unit: 'fraction', min: 0, max: 1, step: 0.05 },
  { key: 'dataRequestsPerNav', label: 'Data requests / client nav', unit: 'req', min: 0, step: 0.5 },
  { key: 'navRenderCallFraction', label: 'CMS call fraction / nav render', unit: 'fraction', min: 0, max: 1, step: 0.05 },
  { key: 'prefetchPerView', label: 'Prefetches / view', unit: 'req', min: 0, step: 1 },
  { key: 'clientCmsCallsPerNav', label: 'Browser CMS calls / nav', unit: 'calls', min: 0, step: 1 },
];

const OVR = 'site.frameworkOverrides';

/** Resolved framework profile with per-field overrides (written to site.frameworkOverrides.*). */
export function FrameworkProfileEditor() {
  const scenario = useAppStore((s) => s.scenario);
  const setParam = useAppStore((s) => s.setParam);
  const err = useAppStore((s) => s.paramError);
  const fw = resolveFramework(scenario);
  const ov = scenario.site.frameworkOverrides as Record<string, unknown>;
  const overridden = (k: string) => ov[k] !== undefined;
  const count = Object.values(ov).filter((v) => v !== undefined).length;

  const row = (key: string, label: string, control: React.ReactNode, unit?: string) => (
    <div key={key} className="flex items-center gap-1 py-1">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${overridden(key) ? 'bg-indigo-500' : 'bg-transparent'}`}
        title={overridden(key) ? 'Overridden' : undefined}
      />
      <span className="min-w-0 flex-1 text-xs leading-tight text-slate-700 dark:text-slate-300">{label}</span>
      {control}
      <span className="w-12 shrink-0 truncate text-[10px] text-slate-400">{unit}</span>
      <button
        type="button"
        aria-label={`Reset ${label} to framework default`}
        title="Reset to framework default"
        disabled={!overridden(key)}
        onClick={() => setParam(`${OVR}.${key}`, undefined)}
        className={`w-4 text-xs text-slate-400 hover:text-slate-700 disabled:invisible dark:hover:text-slate-200 ${focusRing}`}
      >
        ↺
      </button>
    </div>
  );

  return (
    <div className="mt-2 rounded-md border border-slate-200 p-2 dark:border-slate-700">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium">Framework profile ({fw.label})</span>
        {count > 0 && (
          <button
            type="button"
            onClick={() => setParam(OVR, {})}
            className={`text-[11px] text-indigo-600 hover:underline dark:text-indigo-400 ${focusRing}`}
          >
            Reset {count} override{count > 1 ? 's' : ''}
          </button>
        )}
      </div>
      {fw.notes && <p className="mb-1 text-[11px] text-slate-500 dark:text-slate-400">{fw.notes}</p>}
      {row(
        'renderMode',
        'Render mode',
        <SelectInput
          label="Render mode"
          value={fw.renderMode}
          options={[
            { value: 'ssr', label: 'SSR' },
            { value: 'static', label: 'Static' },
            { value: 'hybrid', label: 'Hybrid' },
          ]}
          onChange={(v) => setParam(`${OVR}.renderMode`, v)}
          className="w-24"
        />,
      )}
      {NUMS.map((n) =>
        row(
          n.key,
          n.label,
          <NumInput
            label={n.label}
            value={fw[n.key]}
            min={n.min}
            max={n.max}
            step={n.step}
            onCommit={(v) => setParam(`${OVR}.${n.key}`, v)}
            invalid={err?.path === `${OVR}.${n.key}`}
          />,
          n.unit,
        ),
      )}
      {row(
        'dataCacheable',
        'Data requests cacheable',
        <Toggle label="Data requests cacheable" checked={fw.dataCacheable} onChange={(v) => setParam(`${OVR}.dataCacheable`, v)} />,
      )}
      {row(
        'runtimeCms',
        'CMS calls at runtime',
        <Toggle label="CMS calls at runtime" checked={fw.runtimeCms} onChange={(v) => setParam(`${OVR}.runtimeCms`, v)} />,
      )}
      {row(
        'serverCache',
        'In-server cache scope',
        <SelectInput
          label="In-server cache scope"
          value={fw.serverCache.scope}
          options={[
            { value: 'none', label: 'None' },
            { value: 'perInstance', label: 'Per instance' },
            { value: 'shared', label: 'Shared' },
          ]}
          onChange={(v) => setParam(`${OVR}.serverCache`, { ...fw.serverCache, scope: v })}
          className="w-28"
        />,
      )}
      {fw.serverCache.scope !== 'none' &&
        row(
          'serverCacheTtl',
          'In-server cache TTL',
          <NumInput
            label="In-server cache TTL"
            value={fw.serverCache.ttlSec}
            min={0}
            step={1}
            onCommit={(v) => setParam(`${OVR}.serverCache`, { ...fw.serverCache, ttlSec: v })}
          />,
          's',
        )}
    </div>
  );
}
