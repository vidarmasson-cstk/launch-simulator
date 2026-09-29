import { getByPath, getParamMeta } from '@launch-sim/engine';
import { useAppStore } from '../../state/store';
import { NumInput, SelectInput, Toggle } from './inputs';
import { ProvenanceBadge } from './ProvenanceBadge';
import { FRAMEWORK_OPTIONS } from './options';

const ENUMS: Record<string, { value: string; label: string }[]> = {
  'traffic.profile': [
    { value: 'flat', label: 'Flat' },
    { value: 'diurnal', label: 'Diurnal' },
  ],
  'cms.api': [
    { value: 'rest', label: 'REST (CDA)' },
    { value: 'graphql', label: 'GraphQL' },
  ],
  'launch.compute.machine': [
    { value: 'L1', label: 'L1 (0.5 vCPU)' },
    { value: 'L2', label: 'L2 (1 vCPU)' },
    { value: 'L3', label: 'L3 (2 vCPU)' },
  ],
  'sdk.retry.kind': [
    { value: 'none', label: 'None' },
    { value: 'fixed', label: 'Fixed delay' },
    { value: 'exponential', label: 'Exponential' },
    { value: 'exponentialJitter', label: 'Exponential + jitter' },
    { value: 'sdkDefault', label: 'SDK default' },
  ],
  'sdk.onFinalFailure': [
    { value: 'error500', label: 'Serve 500' },
    { value: 'render404', label: 'Render 404' },
    { value: 'renderStale', label: 'Render stale' },
  ],
  'site.framework': FRAMEWORK_OPTIONS,
};
const ALGO = [
  { value: 'fixedWindow', label: 'Fixed window' },
  { value: 'slidingWindow', label: 'Sliding window' },
  { value: 'tokenBucket', label: 'Token bucket' },
  { value: 'gcra', label: 'GCRA' },
];
ENUMS['cms.cda.algorithm'] = ALGO;
ENUMS['cms.graphql.algorithm'] = ALGO;

/** Paths whose value may be null, with the label of the null state. */
const NULLABLE: Record<string, string> = {
  'sim.burstiness': 'Poisson',
  'cms.cdn.ttlSec': 'Until purged',
};

export function Field({ path, labelOverride }: { path: string; labelOverride?: string }) {
  const meta = getParamMeta(path);
  const value = useAppStore((s) => getByPath(s.scenario, path));
  const isPrivate = useAppStore((s) => s.privatePaths.includes(path));
  const err = useAppStore((s) => (s.paramError?.path === path ? s.paramError.message : null));
  const setParam = useAppStore((s) => s.setParam);
  if (!meta) return null;
  const label = labelOverride ?? meta.label;
  const enumOpts = ENUMS[path];
  const nullLabel = NULLABLE[path];

  let control;
  if (typeof value === 'boolean') {
    control = <Toggle checked={value} onChange={(v) => setParam(path, v)} label={label} />;
  } else if (enumOpts) {
    control = (
      <SelectInput
        value={String(value)}
        options={enumOpts}
        onChange={(v) => setParam(path, v)}
        label={label}
        className="w-44"
      />
    );
  } else if (nullLabel) {
    const isNull = value === null;
    control = (
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
          <input
            type="checkbox"
            checked={isNull}
            onChange={(e) => setParam(path, e.target.checked ? null : (meta.min ?? 1))}
          />
          {nullLabel}
        </label>
        <NumInput
          value={isNull ? 0 : (value as number)}
          disabled={isNull}
          onCommit={(n) => setParam(path, n)}
          min={meta.min}
          max={meta.max}
          step={meta.step}
          label={label}
          invalid={!!err}
          className="w-20"
        />
      </div>
    );
  } else {
    control = (
      <NumInput
        value={value as number}
        onCommit={(n) => setParam(path, n)}
        min={meta.min}
        max={meta.max}
        step={meta.step}
        label={label}
        invalid={!!err}
      />
    );
  }

  const showUnit = meta.unit && !['bool', 'enum'].includes(meta.unit) && !nullLabel;
  return (
    <div className="py-1">
      <div className="flex items-center gap-1">
        <ProvenanceBadge meta={meta} provenance={isPrivate ? 'private' : meta.provenance} />
        <span className="min-w-0 flex-1 text-xs leading-tight text-slate-700 dark:text-slate-300">{label}</span>
        {control}
        {showUnit && (
          <span className="w-12 shrink-0 truncate text-[10px] text-slate-400" title={meta.unit}>
            {meta.unit}
          </span>
        )}
      </div>
      {err && (
        <div role="alert" className="pl-6 text-[11px] text-red-600 dark:text-red-400">
          Rejected: {err}
        </div>
      )}
    </div>
  );
}
