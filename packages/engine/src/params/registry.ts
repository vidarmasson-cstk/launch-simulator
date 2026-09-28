import { z } from 'zod';
import { ScenarioSchema, type Scenario } from '../schema';

export type Provenance = 'documented' | 'conflicting' | 'observed' | 'assumption' | 'private';

export interface ParamMeta {
  path: string; // dot-path into Scenario, e.g. "cms.cda.limitRps"
  label: string;
  unit: string;
  min?: number;
  max?: number;
  step?: number;
  provenance: Provenance;
  sources: string[]; // ids into sources.ts
  conflict?: { value: number | string; sourceId: string; note?: string }[];
  note?: string;
}

type Extra = Partial<Pick<ParamMeta, 'min' | 'max' | 'step' | 'conflict' | 'note'>>;

const INPUT = 'workload input';

function p(
  path: string,
  label: string,
  unit: string,
  provenance: Provenance,
  sources: string[],
  extra: Extra = {},
): ParamMeta {
  return { path, label, unit, provenance, sources, ...extra };
}

/** Workload / simulation input: user-supplied, not a platform fact. */
const input = (path: string, label: string, unit: string, extra: Extra = {}) =>
  p(path, label, unit, 'assumption', [], { note: INPUT, ...extra });

const assumed = (path: string, label: string, unit: string, note: string, extra: Extra = {}) =>
  p(path, label, unit, 'assumption', [], { note, ...extra });

const NOT_PUBLIC = 'Not publicly documented; editable assumption.';

const cachePolicyParams = (kind: 'page' | 'data' | 'fn'): ParamMeta[] => [
  input(`site.cacheHeaders.${kind}.cacheable`, `${kind}: cacheable`, 'bool'),
  input(`site.cacheHeaders.${kind}.sMaxAgeSec`, `${kind}: s-maxage`, 's', { min: 0, step: 1 }),
  input(`site.cacheHeaders.${kind}.swrSec`, `${kind}: stale-while-revalidate`, 's', {
    min: 0,
    step: 1,
  }),
  input(`site.cacheHeaders.${kind}.staleIfErrorSec`, `${kind}: stale-if-error`, 's', {
    min: 0,
    step: 1,
  }),
];

const cmsLimiterParams = (api: 'cda' | 'graphql'): ParamMeta[] => {
  const name = api === 'cda' ? 'CDA (REST)' : 'GraphQL';
  const limit =
    api === 'cda'
      ? p(
          'cms.cda.limitRps',
          'CDA origin limit',
          'req/s',
          'conflicting',
          ['cda-api', 'image-delivery-api'],
          {
            min: 0,
            step: 1,
            note: 'Uncached (origin) requests per org; cached CDN requests are not limited. Default is the current value; an older page says 80.',
            conflict: [
              {
                value: 80,
                sourceId: 'image-delivery-api',
                note: 'Older page: 80 requests per second per organization.',
              },
            ],
          },
        )
      : p('cms.graphql.limitRps', 'GraphQL origin limit', 'req/s', 'documented', ['graphql-api'], {
          min: 0,
          step: 1,
          note: 'Separate bucket from CDA/REST.',
        });
  return [
    limit,
    assumed(
      `cms.${api}.algorithm`,
      `${name} limiter algorithm`,
      'enum',
      'Exact window algorithm is not public. fixedWindow is the strict-window assumption; GCRA models the burst-tolerant limiter.',
    ),
    assumed(
      `cms.${api}.burstMultiplierPct`,
      `${name} burst multiplier`,
      '%',
      'Only the existence of burst-aware limiting is public. 100% means no burst.',
      { min: 100, step: 5 },
    ),
    assumed(
      `cms.${api}.maxWaitMs`,
      `${name} max queue wait`,
      'ms',
      'Only used by the GCRA algorithm; 0 rejects instead of queueing.',
      {
        min: 0,
        step: 50,
      },
    ),
  ];
};

export const PARAMS: ParamMeta[] = [
  // sim
  input('sim.durationSec', 'Simulation duration', 's', { min: 1, step: 60 }),
  input('sim.dtSec', 'Tick length', 's', { min: 0.01, max: 1, step: 0.01 }),
  input('sim.seed', 'Random seed', '', { step: 1 }),
  input('sim.stochastic', 'Stochastic arrivals', 'bool'),
  input('sim.burstiness', 'Burstiness (NegBin k; null = Poisson)', '', { min: 0.01, step: 0.1 }),
  input('sim.warmHistorySec', 'Warm-cache history (time since last purge/deploy)', 's', {
    min: 0,
    step: 600,
  }),

  // traffic
  input('traffic.baseEdgeRps', 'Human page views', 'req/s', { min: 0, step: 1 }),
  input('traffic.profile', 'Traffic profile', 'enum'),
  input('traffic.bots.share', 'Bot share of traffic', 'fraction', { min: 0, max: 1, step: 0.01 }),
  input('traffic.bots.randomQueryFraction', 'Bot random-query fraction', 'fraction', {
    min: 0,
    max: 1,
    step: 0.01,
  }),
  input('traffic.bots.notFoundFraction', 'Bot 404 fraction', 'fraction', {
    min: 0,
    max: 1,
    step: 0.01,
  }),
  input('traffic.bots.zipfAlpha', 'Bot Zipf alpha', '', { min: 0, max: 3, step: 0.05 }),

  // site
  input('site.pages', 'Pages', 'pages', { min: 1, step: 100 }),
  input('site.locales', 'Locales', 'count', { min: 1, step: 1 }),
  input('site.localeZipfAlpha', 'Locale Zipf alpha', '', { min: 0, max: 3, step: 0.05 }),
  input('site.zipfAlpha', 'Page Zipf alpha', '', { min: 0, max: 3, step: 0.05 }),
  input('site.personalizeVariants', 'Personalize variants', 'count', { min: 1, step: 1 }),
  input('site.framework', 'Framework', 'enum'),
  ...cachePolicyParams('page'),
  ...cachePolicyParams('data'),
  ...cachePolicyParams('fn'),
  input('site.uncacheableFraction', 'Uncacheable fraction (cookies/headers)', 'fraction', {
    min: 0,
    max: 1,
    step: 0.01,
  }),
  input('site.globalKeys', 'Global CMS keys (header/footer/nav/settings)', 'keys per locale', {
    min: 1,
    step: 1,
  }),
  input('site.cmsCallsPerNotFound', 'CMS calls per 404 render', 'calls', { min: 0, step: 1 }),

  // launch
  p('launch.plan', 'Launch plan', 'enum', 'documented', ['launch-platform-limits'], {
    note: 'Use applyPlan() to set the plan-dependent limits together.',
  }),
  p(
    'launch.originLimitRps',
    'Launch origin limit',
    'req/s',
    'documented',
    ['launch-platform-limits'],
    {
      min: 0,
      step: 10,
      note: 'Cache-miss delivery limit per org; 200 req/s Non-Enterprise, 1200 req/s Enterprise (raisable). Cache hits do not count.',
    },
  ),
  p(
    'launch.originBurstSec',
    'Launch origin burst capacity',
    's',
    'assumption',
    ['launch-invisible-shield'],
    {
      min: 0,
      step: 0.1,
      note: 'Documented as a tiered token bucket with brief overshoot possible; the bucket depth (rate x seconds) is an assumption.',
    },
  ),
  assumed(
    'launch.cdn.domains',
    'Launch CDN independent cache domains',
    'count',
    `${NOT_PUBLIC} Effective number of independent CDN cache domains per key.`,
    { min: 1, step: 1 },
  ),
  assumed(
    'launch.cdn.collapse',
    'Launch CDN request collapsing',
    'bool',
    `${NOT_PUBLIC} Whether concurrent misses for one key collapse into one origin fetch.`,
  ),
  assumed(
    'launch.cdn.hitLatencyMs',
    'Launch CDN hit latency',
    'ms',
    'Typical edge latency; editable assumption.',
    { min: 0, step: 5 },
  ),
  input('launch.externalCdn.enabled', 'Customer CDN in front of Launch', 'bool'),
  input('launch.externalCdn.ttlSec', 'Customer CDN TTL', 's', { min: 0, step: 1 }),
  input('launch.externalCdn.cachesErrors', 'Customer CDN caches error responses', 'bool'),
  input('launch.externalCdn.errorTtlSec', 'Customer CDN error TTL', 's', { min: 0, step: 1 }),
  p('launch.compute.machine', 'Server machine', 'enum', 'documented', ['launch-machines'], {
    note: 'L1 0.5 vCPU/1 GiB (default), L2 1/2, L3 2/4. Linear CPU-time scaling with vCPU is an assumption.',
  }),
  assumed(
    'launch.compute.concurrencyPerInstance',
    'Concurrency per instance',
    'renders',
    NOT_PUBLIC,
    { min: 1, step: 1 },
  ),
  assumed('launch.compute.maxInstances', 'Max instances', 'instances', NOT_PUBLIC, {
    min: 1,
    step: 10,
  }),
  assumed(
    'launch.compute.minInstances',
    'Min instances',
    'instances',
    `${NOT_PUBLIC} Launch has no documented minimum-instance setting.`,
    { min: 0, step: 1 },
  ),
  assumed('launch.compute.scaleOutPerSec', 'Scale-out rate', 'instances/s', NOT_PUBLIC, {
    min: 0,
    step: 5,
  }),
  assumed('launch.compute.coldStartMs', 'Cold start', 'ms', NOT_PUBLIC, { min: 0, step: 100 }),
  assumed('launch.compute.idleScaleToZeroSec', 'Idle scale-to-zero', 's', NOT_PUBLIC, {
    min: 0,
    step: 30,
  }),
  p('launch.compute.timeoutSec', 'Request timeout', 's', 'documented', ['launch-platform-limits'], {
    min: 1,
    step: 1,
    note: 'Default 30 s; up to 780 s on request.',
  }),
  assumed('launch.compute.maxQueue', 'Max compute queue', 'requests', NOT_PUBLIC, {
    min: 0,
    step: 100,
  }),
  p(
    'launch.revalidation.dailyQuota',
    'On-demand revalidations per day',
    'calls/day',
    'documented',
    ['launch-platform-limits', 'launch-revalidate'],
    {
      min: 0,
      step: 50,
      note: '500 Non-Enterprise, 2000 Enterprise. Reset semantics (fixed hour vs rolling 24 h) differ between sources.',
    },
  ),

  // cms
  input('cms.api', 'CMS API used by the site', 'enum'),
  ...cmsLimiterParams('cda'),
  ...cmsLimiterParams('graphql'),
  assumed(
    'cms.cdn.domains',
    'CMS CDN independent cache domains',
    'count',
    `${NOT_PUBLIC} Effective number of independent CDN cache domains per key.`,
    { min: 1, step: 1 },
  ),
  assumed(
    'cms.cdn.collapse',
    'CMS CDN request collapsing',
    'bool',
    `${NOT_PUBLIC} Whether concurrent misses collapse into one origin fetch.`,
  ),
  p('cms.cdn.ttlSec', 'CMS CDN TTL (null = until purged)', 's', 'assumption', ['cms-cdn-cache'], {
    min: 0,
    step: 60,
    note: 'Modelled as cached until purged; entry publish purges the entry, its content-type list queries and referencing content types.',
  }),
  assumed(
    'cms.cdn.hitLatencyMs',
    'CMS CDN hit latency',
    'ms',
    'Typical latency; editable assumption.',
    { min: 0, step: 5 },
  ),
  assumed(
    'cms.cdn.originLatencyMs',
    'CMS origin latency',
    'ms',
    'Typical latency; editable assumption.',
    { min: 0, step: 10 },
  ),
  input('cms.otherOrgTrafficRps', 'Other org traffic (staging, builds)', 'req/s', {
    min: 0,
    step: 1,
  }),
  input('cms.contentTypes', 'Content types', 'count', { min: 1, step: 1 }),
  input('cms.entriesPerType', 'Entries per content type', 'count', { min: 1, step: 10 }),

  // sdk
  p('sdk.retry.kind', 'Retry policy', 'enum', 'observed', ['sdk-js-core-source'], {
    note: 'sdkDefault mirrors the JS delivery SDK: fixed delay, no jitter, retries 429.',
  }),
  p('sdk.retry.retries', 'Retries', 'count', 'observed', ['sdk-js-core-source'], {
    min: 0,
    step: 1,
    note: 'Observed in SDK source: retryLimit 5 (the effective attempt count may be lower depending on the version).',
  }),
  p('sdk.retry.baseDelayMs', 'Retry base delay', 'ms', 'observed', ['sdk-js-core-source'], {
    min: 0,
    step: 50,
    note: 'Observed in SDK source: retryDelay 300 ms, fixed.',
  }),
  input('sdk.retry.capDelayMs', 'Retry delay cap', 'ms', { min: 0, step: 100 }),
  assumed(
    'sdk.sdkRateLimitWaitMs',
    'SDK wait on 429 with remaining=0',
    'ms',
    'Inferred from SDK source (retry-after / reset + 1 s, otherwise 1 s); the exact wait is an assumption.',
    { min: 0, step: 100 },
  ),
  assumed(
    'sdk.sdkAssumeRemainingHeader',
    'Assume 429s carry x-ratelimit-remaining: 0',
    'bool',
    'If false the SDK falls back to the base delay. Assumption.',
  ),
  input('sdk.onFinalFailure', 'Behaviour on final CMS failure', 'enum'),

  // steady (analytic-only)
  input('steady.publishesPerHour', 'Publishes per hour (steady state)', 'publishes/h', {
    min: 0,
    step: 1,
  }),
  input('steady.entriesPerPublish', 'Entries per publish (steady state)', 'entries', {
    min: 0,
    step: 1,
  }),
  input('steady.purge.pageQueries', 'Purge: page queries', 'bool'),
  input('steady.purge.contentTypeLists', 'Purge: content-type lists', 'bool'),
  input('steady.purge.referencingFraction', 'Purge: referencing fraction', 'fraction', {
    min: 0,
    max: 1,
    step: 0.05,
  }),
  input('steady.purge.globals', 'Purge: global keys', 'bool'),
];

const PARAM_BY_PATH = new Map(PARAMS.map((m) => [m.path, m]));

export function getParamMeta(path: string): ParamMeta | undefined {
  return PARAM_BY_PATH.get(path);
}

export function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Immutable dot-path set; returns a new object with intermediate objects copied. */
export function setByPath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.');
  const setAt = (cur: unknown, i: number): unknown => {
    const key = keys[i] as string;
    const base = cur !== null && typeof cur === 'object' ? (cur as Record<string, unknown>) : {};
    if (i === keys.length - 1) return { ...base, [key]: value };
    return { ...base, [key]: setAt(base[key], i + 1) };
  };
  return setAt(obj, 0) as T;
}

// ---- Private presets ----

export const PresetSchema = z.object({
  format: z.literal('launch-sim-preset/v1'),
  name: z.string(),
  overrides: z.record(z.string(), z.object({ value: z.unknown(), note: z.string().optional() })),
});
export type Preset = z.infer<typeof PresetSchema>;

/**
 * Applies a private preset. Every override path must exist in PARAMS (otherwise throws), and the
 * resulting scenario is re-validated with ScenarioSchema (throws on invalid values).
 */
export function applyPreset(
  scenario: Scenario,
  preset: Preset,
): { scenario: Scenario; overriddenPaths: string[] } {
  const overriddenPaths = Object.keys(preset.overrides);
  const unknown = overriddenPaths.filter((path) => !PARAM_BY_PATH.has(path));
  if (unknown.length > 0) {
    throw new Error(`Preset "${preset.name}" has unknown parameter paths: ${unknown.join(', ')}`);
  }
  let next: Scenario = scenario;
  for (const path of overriddenPaths) {
    next = setByPath(next, path, (preset.overrides[path] as { value: unknown }).value);
  }
  return { scenario: ScenarioSchema.parse(next), overriddenPaths };
}

export function provenanceFor(path: string, overriddenPaths: Iterable<string>): Provenance {
  for (const o of overriddenPaths) if (o === path) return 'private';
  return PARAM_BY_PATH.get(path)?.provenance ?? 'assumption';
}
