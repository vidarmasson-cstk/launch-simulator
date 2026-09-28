import { z } from 'zod';
import { DEFAULTS as D } from './params/defaults';

/**
 * Scenario schema (schemaVersion 1). Every field has a default, so `ScenarioSchema.parse({})`
 * yields the full public default scenario.
 * JSON cannot hold Infinity: `null` means "infinite / until purged" for TTLs and
 * `null` burstiness means Poisson arrivals.
 */

export const FRAMEWORK_IDS = [
  'nextjs-app',
  'nextjs-pages',
  'nuxt',
  'astro-ssr',
  'astro-static',
  'remix',
  'sveltekit',
  'angular-ssr',
  'gatsby-ssg',
  'custom',
] as const;
export const FrameworkIdSchema = z.enum(FRAMEWORK_IDS);
export type FrameworkId = z.infer<typeof FrameworkIdSchema>;

export const LimiterAlgoSchema = z.enum(['fixedWindow', 'slidingWindow', 'tokenBucket', 'gcra']);
export type LimiterAlgo = z.infer<typeof LimiterAlgoSchema>;

export const RetryPolicySchema = z.object({
  kind: z
    .enum(['none', 'fixed', 'exponential', 'exponentialJitter', 'sdkDefault'])
    .default(D.sdk.retry.kind),
  retries: z.number().int().min(0).default(D.sdk.retry.retries),
  baseDelayMs: z.number().min(0).default(D.sdk.retry.baseDelayMs),
  capDelayMs: z.number().min(0).default(D.sdk.retry.capDelayMs),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const CachePolicySchema = z.object({
  cacheable: z.boolean().default(false),
  sMaxAgeSec: z.number().min(0).default(0),
  swrSec: z.number().min(0).default(0),
  staleIfErrorSec: z.number().min(0).default(0),
});
export type CachePolicy = z.infer<typeof CachePolicySchema>;

const cachePolicyWith = (d: CachePolicy) =>
  z.object({
    cacheable: z.boolean().default(d.cacheable),
    sMaxAgeSec: z.number().min(0).default(d.sMaxAgeSec),
    swrSec: z.number().min(0).default(d.swrSec),
    staleIfErrorSec: z.number().min(0).default(d.staleIfErrorSec),
  });

export const PurgeScopeSchema = z.object({
  pageQueries: z.boolean().default(true),
  contentTypeLists: z.boolean().default(true),
  referencingFraction: z.number().min(0).max(1).default(0),
  globals: z.boolean().default(false),
});
export type PurgeScope = z.infer<typeof PurgeScopeSchema>;

export const FrameworkProfileSchema = z.object({
  id: FrameworkIdSchema,
  label: z.string(),
  renderMode: z.enum(['ssr', 'static', 'hybrid']),
  // CMS calls per uncached server render
  globalCalls: z.number().min(0),
  pageCalls: z.number().min(0),
  listCalls: z.number().min(0),
  n1Calls: z.number().min(0),
  sequentialWaves: z.number().min(0),
  cpuRenderMsL1: z.number().min(0),
  // client behaviour per human page view
  clientNavFraction: z.number().min(0).max(1),
  dataRequestsPerNav: z.number().min(0),
  /** Fraction of a full render's CMS calls incurred by one client-nav data request. */
  navRenderCallFraction: z.number().min(0).max(1),
  prefetchPerView: z.number().min(0),
  dataCacheable: z.boolean(),
  /** CMS calls made directly from the browser per client nav (hit the CMS CDN, not Launch). */
  clientCmsCallsPerNav: z.number().min(0),
  serverCache: z.object({
    scope: z.enum(['none', 'perInstance', 'shared']),
    ttlSec: z.number().min(0),
    appliesTo: z.array(z.enum(['global', 'list', 'page'])),
  }),
  runtimeCms: z.boolean(),
  notes: z.string().optional(),
});
export type FrameworkProfile = z.infer<typeof FrameworkProfileSchema>;

const FrameworkOverridesSchema = FrameworkProfileSchema.omit({ id: true, label: true }).partial();

const limiterWith = (d: {
  limitRps: number;
  algorithm: LimiterAlgo;
  burstMultiplierPct: number;
  maxWaitMs: number;
}) =>
  z.object({
    limitRps: z.number().min(0).default(d.limitRps),
    algorithm: LimiterAlgoSchema.default(d.algorithm),
    burstMultiplierPct: z.number().min(100).default(d.burstMultiplierPct),
    maxWaitMs: z.number().min(0).default(d.maxWaitMs),
  });

const SimSchema = z.object({
  durationSec: z.number().positive().default(D.sim.durationSec),
  dtSec: z.number().positive().default(D.sim.dtSec),
  seed: z.number().int().default(D.sim.seed),
  stochastic: z.boolean().default(D.sim.stochastic),
  /** NegBin dispersion k; null = Poisson. */
  burstiness: z.number().positive().nullable().default(D.sim.burstiness),
});

const TrafficSchema = z.object({
  /** Page views per second from humans. */
  baseEdgeRps: z.number().min(0).default(D.traffic.baseEdgeRps),
  profile: z.enum(['flat', 'diurnal']).default(D.traffic.profile),
  bots: z
    .object({
      share: z.number().min(0).max(1).default(D.traffic.bots.share),
      randomQueryFraction: z.number().min(0).max(1).default(D.traffic.bots.randomQueryFraction),
      notFoundFraction: z.number().min(0).max(1).default(D.traffic.bots.notFoundFraction),
      zipfAlpha: z.number().min(0).default(D.traffic.bots.zipfAlpha),
    })
    .default({}),
});

const SiteSchema = z.object({
  pages: z.number().int().min(1).default(D.site.pages),
  locales: z.number().int().min(1).default(D.site.locales),
  localeZipfAlpha: z.number().min(0).default(D.site.localeZipfAlpha),
  zipfAlpha: z.number().min(0).default(D.site.zipfAlpha),
  personalizeVariants: z.number().int().min(1).default(D.site.personalizeVariants),
  framework: FrameworkIdSchema.default(D.site.framework),
  frameworkOverrides: FrameworkOverridesSchema.default({}),
  cacheHeaders: z
    .object({
      page: cachePolicyWith(D.site.cacheHeaders.page).default({}),
      data: cachePolicyWith(D.site.cacheHeaders.data).default({}),
      fn: cachePolicyWith(D.site.cacheHeaders.fn).default({}),
    })
    .default({}),
  uncacheableFraction: z.number().min(0).max(1).default(D.site.uncacheableFraction),
  globalKeys: z.number().int().min(1).default(D.site.globalKeys),
  cmsCallsPerNotFound: z.number().min(0).default(D.site.cmsCallsPerNotFound),
});

const LaunchSchema = z.object({
  plan: z.enum(['standard', 'enterprise']).default(D.launch.plan),
  originLimitRps: z.number().min(0).default(D.launch.originLimitRps),
  originBurstSec: z.number().min(0).default(D.launch.originBurstSec),
  cdn: z
    .object({
      domains: z.number().int().min(1).default(D.launch.cdn.domains),
      collapse: z.boolean().default(D.launch.cdn.collapse),
      hitLatencyMs: z.number().min(0).default(D.launch.cdn.hitLatencyMs),
    })
    .default({}),
  externalCdn: z
    .object({
      enabled: z.boolean().default(D.launch.externalCdn.enabled),
      ttlSec: z.number().min(0).default(D.launch.externalCdn.ttlSec),
      cachesErrors: z.boolean().default(D.launch.externalCdn.cachesErrors),
      errorTtlSec: z.number().min(0).default(D.launch.externalCdn.errorTtlSec),
    })
    .default({}),
  compute: z
    .object({
      machine: z.enum(['L1', 'L2', 'L3']).default(D.launch.compute.machine),
      concurrencyPerInstance: z
        .number()
        .int()
        .min(1)
        .default(D.launch.compute.concurrencyPerInstance),
      maxInstances: z.number().int().min(1).default(D.launch.compute.maxInstances),
      minInstances: z.number().int().min(0).default(D.launch.compute.minInstances),
      scaleOutPerSec: z.number().min(0).default(D.launch.compute.scaleOutPerSec),
      coldStartMs: z.number().min(0).default(D.launch.compute.coldStartMs),
      idleScaleToZeroSec: z.number().min(0).default(D.launch.compute.idleScaleToZeroSec),
      timeoutSec: z.number().positive().default(D.launch.compute.timeoutSec),
      maxQueue: z.number().min(0).default(D.launch.compute.maxQueue),
    })
    .default({}),
  revalidation: z
    .object({ dailyQuota: z.number().min(0).default(D.launch.revalidation.dailyQuota) })
    .default({}),
});

const CmsSchema = z.object({
  api: z.enum(['rest', 'graphql']).default(D.cms.api),
  cda: limiterWith(D.cms.cda).default({}),
  graphql: limiterWith(D.cms.graphql).default({}),
  cdn: z
    .object({
      domains: z.number().int().min(1).default(D.cms.cdn.domains),
      collapse: z.boolean().default(D.cms.cdn.collapse),
      /** null = cached until purged. */
      ttlSec: z.number().min(0).nullable().default(D.cms.cdn.ttlSec),
      hitLatencyMs: z.number().min(0).default(D.cms.cdn.hitLatencyMs),
      originLatencyMs: z.number().min(0).default(D.cms.cdn.originLatencyMs),
    })
    .default({}),
  otherOrgTrafficRps: z.number().min(0).default(D.cms.otherOrgTrafficRps),
  contentTypes: z.number().int().min(1).default(D.cms.contentTypes),
  entriesPerType: z.number().int().min(1).default(D.cms.entriesPerType),
});

const SdkSchema = z.object({
  retry: RetryPolicySchema.default({}),
  sdkRateLimitWaitMs: z.number().min(0).default(D.sdk.sdkRateLimitWaitMs),
  sdkAssumeRemainingHeader: z.boolean().default(D.sdk.sdkAssumeRemainingHeader),
  onFinalFailure: z.enum(['error500', 'render404', 'renderStale']).default(D.sdk.onFinalFailure),
});

/** Steady-state-only inputs (used by the analytic model, not the timeline). */
const SteadySchema = z.object({
  publishesPerHour: z.number().min(0).default(D.steady.publishesPerHour),
  entriesPerPublish: z.number().min(0).default(D.steady.entriesPerPublish),
  purge: PurgeScopeSchema.default(D.steady.purge),
});

const at = (n: number) => z.number().min(0).default(n);

export const EventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('spike'),
    atSec: at(600),
    durationSec: z.number().positive().default(60),
    multiplier: z.number().min(0).default(3),
    rampSec: z.number().min(0).default(10),
  }),
  z.object({
    kind: z.literal('publish'),
    atSec: at(600),
    entries: z.number().int().min(1).default(50),
    spreadSec: z.number().min(0).default(10),
    locales: z.union([z.literal('all'), z.number().int().min(1)]).default('all'),
    purge: PurgeScopeSchema.default({}),
    onPublish: z.enum(['none', 'revalidatePaths', 'revalidateTags', 'redeploy']).default('none'),
  }),
  z.object({
    kind: z.literal('deploy'),
    atSec: at(600),
    buildSec: z.number().min(0).default(300),
    priming: z
      .object({ paths: z.number().int().min(0).default(0), rps: z.number().min(0).default(0) })
      .default({}),
  }),
  z.object({ kind: z.literal('goLive'), atSec: at(600) }),
  z.object({
    kind: z.literal('crawler'),
    atSec: at(600),
    durationSec: z.number().positive().default(300),
    rps: z.number().min(0).default(20),
    randomQueryFraction: z.number().min(0).max(1).default(0.5),
    notFoundFraction: z.number().min(0).max(1).default(0.05),
  }),
  z.object({
    kind: z.literal('loadTest'),
    atSec: at(600),
    durationSec: z.number().positive().default(300),
    rps: z.number().min(0).default(200),
    cacheBusting: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('otherTraffic'),
    atSec: at(600),
    durationSec: z.number().positive().default(300),
    rps: z.number().min(0).default(10),
  }),
]);
export type ScenarioEvent = z.infer<typeof EventSchema>;

export const ScenarioSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  name: z.string().default(D.name),
  description: z.string().optional(),
  sim: SimSchema.default({}),
  traffic: TrafficSchema.default({}),
  site: SiteSchema.default({}),
  launch: LaunchSchema.default({}),
  cms: CmsSchema.default({}),
  sdk: SdkSchema.default({}),
  steady: SteadySchema.default({}),
  events: z.array(EventSchema).default([]),
});

export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioInput = z.input<typeof ScenarioSchema>;
