import type { Scenario } from '../schema';

/**
 * Public default values (no events). Only publicly documented values or explicitly flagged assumptions
 * appear here (see registry.ts for provenance). Private presets override these at load time.
 */
export const DEFAULTS = {
  schemaVersion: 1,
  name: 'Untitled scenario',
  sim: { durationSec: 1800, dtSec: 0.1, seed: 1, stochastic: true, burstiness: null, warmHistorySec: 3600 },
  traffic: {
    baseEdgeRps: 40,
    profile: 'flat',
    bots: { share: 0.1, randomQueryFraction: 0.1, notFoundFraction: 0.05, zipfAlpha: 0.2 },
  },
  site: {
    pages: 5000,
    locales: 3,
    localeZipfAlpha: 0.5,
    zipfAlpha: 0.8,
    personalizeVariants: 1,
    framework: 'nextjs-app',
    frameworkOverrides: {},
    cacheHeaders: {
      page: { cacheable: true, sMaxAgeSec: 300, swrSec: 600, staleIfErrorSec: 0 },
      data: { cacheable: false, sMaxAgeSec: 0, swrSec: 0, staleIfErrorSec: 0 },
      fn: { cacheable: false, sMaxAgeSec: 0, swrSec: 0, staleIfErrorSec: 0 },
    },
    uncacheableFraction: 0,
    globalKeys: 4,
    cmsCallsPerNotFound: 1,
  },
  launch: {
    plan: 'standard',
    originLimitRps: 200,
    originBurstSec: 1,
    cdn: { domains: 3, collapse: true, hitLatencyMs: 30 },
    externalCdn: { enabled: false, ttlSec: 60, cachesErrors: false, errorTtlSec: 60 },
    compute: {
      machine: 'L1',
      concurrencyPerInstance: 1,
      maxInstances: 1000,
      minInstances: 0,
      scaleOutPerSec: 100,
      coldStartMs: 1500,
      idleScaleToZeroSec: 900,
      scaleInDelaySec: 60,
      timeoutSec: 30,
      maxQueue: 10000,
    },
    revalidation: { dailyQuota: 500 },
  },
  cms: {
    api: 'rest',
    cda: { limitRps: 100, algorithm: 'fixedWindow', burstMultiplierPct: 100, maxWaitMs: 0 },
    graphql: { limitRps: 80, algorithm: 'fixedWindow', burstMultiplierPct: 100, maxWaitMs: 0 },
    cdn: { domains: 3, collapse: true, ttlSec: null, hitLatencyMs: 40, originLatencyMs: 150 },
    otherOrgTrafficRps: 0,
    contentTypes: 20,
    entriesPerType: 500,
  },
  sdk: {
    retry: { kind: 'sdkDefault', retries: 5, baseDelayMs: 300, capDelayMs: 10000 },
    sdkRateLimitWaitMs: 1000,
    sdkAssumeRemainingHeader: true,
    onFinalFailure: 'error500',
  },
  steady: {
    publishesPerHour: 2,
    entriesPerPublish: 1,
    inTimeline: true,
    purge: { pageQueries: true, contentTypeLists: true, referencingFraction: 0, globals: false },
  },
} as const;

/** The public default Scenario (mutable copy of DEFAULTS). Schema defaults read DEFAULTS. */
export const DEFAULT_SCENARIO: Scenario = { ...JSON.parse(JSON.stringify(DEFAULTS)), events: [] };

/** Plan-dependent public values: origin limit (req/s) and daily revalidation quota. */
export const PLAN_LIMITS = {
  standard: { originLimitRps: 200, dailyQuota: 500 },
  enterprise: { originLimitRps: 1200, dailyQuota: 2000 },
} as const;

/**
 * Returns a copy of the scenario switched to `plan`. Documented public values:
 * standard (non-Enterprise) = 200 origin req/s + 500 revalidations/day;
 * enterprise = 1200 origin req/s + 2000 revalidations/day.
 * Note: this overwrites any custom originLimitRps / dailyQuota.
 */
export function applyPlan(scenario: Scenario, plan: 'standard' | 'enterprise'): Scenario {
  const limits = PLAN_LIMITS[plan];
  return {
    ...scenario,
    launch: {
      ...scenario.launch,
      plan,
      originLimitRps: limits.originLimitRps,
      revalidation: { ...scenario.launch.revalidation, dailyQuota: limits.dailyQuota },
    },
  };
}
