/** Shared interfaces for the model components (DESIGN 6.1-6.9). Implemented in Waves 2 and 3. */
import type { RetryPolicy, Scenario, ScenarioEvent } from '../schema';

/** Position of the simulation loop. */
export interface TickContext {
  tick: number;
  dtSec: number;
  /** tick * dtSec */
  timeSec: number;
}

// ---- 6.1 Popularity ----

/** A group of keys with equal request probability. Sum over bins of n*p is 1. */
export interface PopularityBin {
  /** Number of keys in the bin. */
  n: number;
  /** Mean per-key request probability. */
  p: number;
}

export interface PopularityConfig {
  pages: number;
  locales: number;
  variants: number;
  zipfAlpha: number;
  localeZipfAlpha: number;
  /** Top ranks that get their own bin (default 16). */
  topRanks?: number;
  /** Maximum bins after merging (default 64). */
  maxBins?: number;
}

// ---- 6.2 Cache layer ----

export interface CacheLayerConfig {
  /** Infinity = cached until purged. */
  ttlSec: number;
  swrSec: number;
  staleIfErrorSec: number;
  collapse: boolean;
  /** Independent cache domains; each key is replicated across D domains. */
  domains: number;
  /** Only the external customer CDN (and never Launch) caches errors. */
  cacheErrors?: { ttlSec: number };
  /** Longest expected fetch latency, sizes the pending ring. */
  maxLatencySec: number;
  /** Total simulated duration; TTLs beyond it use the scalar no-expiry state. */
  durationSec: number;
  dtSec: number;
}

export interface CacheStepResult {
  requests: number;
  hits: number;
  staleHits: number;
  blockingMisses: number;
  collapsedWaits: number;
  errorsServed: number;
  /** New origin requests started this tick, by bin. */
  originFetchesPerBin: Float64Array;
}

export interface CacheLayerState {
  /** Fraction of keys currently fresh, stale, empty, pending (blocking) and error-cached. */
  fresh: number;
  stale: number;
  empty: number;
  pending: number;
  errorCached: number;
}

export interface ICacheLayer {
  /** lambdaPerBin: req/s per bin. */
  step(tick: number, lambdaPerBin: Float64Array): CacheStepResult;
  /** Called by the pipeline once downstream latency is known. */
  scheduleCompletions(
    tick: number,
    perBinAmounts: Float64Array,
    completionTick: number,
    successFraction: number,
  ): void;
  /** Fraction of fresh/stale/pendingStale keys moved to empty (per bin or scalar). */
  purge(fraction: number | Float64Array): void;
  /** Instantaneous (fresh + stale) / requests, for display. */
  hitRatio(): number;
  state(): CacheLayerState;
}

// ---- 6.3 Limiters ----

export interface LimiterResult {
  accepted: number;
  rejected: number;
  queued: number;
  avgQueueDelayMs: number;
}

export interface Limiter {
  step(tick: number, arrivals: number): LimiterResult;
}

export type LimiterConfig =
  | { algorithm: 'fixedWindow'; limitRps: number; dtSec: number }
  | { algorithm: 'slidingWindow'; limitRps: number; dtSec: number }
  | { algorithm: 'tokenBucket'; limitRps: number; capacity: number; dtSec: number }
  | {
      algorithm: 'gcra';
      limitRps: number;
      burstMultiplierPct: number;
      maxWaitMs: number;
      dtSec: number;
    };

// ---- 6.4 Retries ----

export interface RetryPolicyConfig {
  policy: RetryPolicy;
  dtSec: number;
  /** sdkDefault: wait when the 429 carries remaining = 0. */
  sdkRateLimitWaitMs: number;
  sdkAssumeRemainingHeader: boolean;
}

/** Cohort of retried requests due in a tick. */
export interface RetryDue {
  attempt: number;
  amount: number;
}

export interface IRetryRing {
  /**
   * Schedule `amount` rejected requests (which failed at `attempt`). Those with attempt < retries
   * are re-queued with attempt + 1; the rest are returned as final failures.
   */
  scheduleRejected(tick: number, attempt: number, amount: number): { finalFailures: number };
  /** Retries due at this tick (attempt >= 1). */
  due(tick: number): RetryDue[];
  /** Total amount currently waiting in the ring, for conservation checks. */
  pending(): number;
  /** Delay in ms before the retry following failed attempt k (expected value for jitter). */
  delayMs(attempt: number): number;
}

// ---- 6.5 Compute ----

export interface ComputeConfig {
  vcpu: number;
  concurrencyPerInstance: number;
  maxInstances: number;
  minInstances: number;
  scaleOutPerSec: number;
  coldStartMs: number;
  idleScaleToZeroSec: number;
  timeoutSec: number;
  maxQueue: number;
  dtSec: number;
}

export interface ComputeStepResult {
  /** Renders started this tick. */
  started: number;
  queue: number;
  inFlight: number;
  readyInstances: number;
  /** Shed because queue > maxQueue. */
  rejected503: number;
  /** Renders that exceeded the timeout. */
  timeouts504: number;
  /** Estimated queue wait for a newly admitted request, ms. */
  queueWaitMs: number;
}

export interface IComputeModel {
  /**
   * @param acceptedArrivals renders admitted by the origin limiter this tick
   * @param serviceMs service time of a started render (cpu + CMS path + queue delay + retry wait)
   */
  step(tick: number, acceptedArrivals: number, serviceMs: number): ComputeStepResult;
  /** All instances cold (go-live / deploy). */
  reset(): void;
}

// ---- 6.7 Traffic and events ----

export type TrafficClass = 'page' | 'data' | 'botUnique' | 'notFound';

/** Edge arrivals this tick, by class, as request counts (not rates). */
export interface ArrivalsByClass {
  page: number;
  data: number;
  botUnique: number;
  notFound: number;
  /** Static assets: counted at the edge only, always hits. */
  staticAssets: number;
}

/** Per-tick effects derived from the event timeline. */
export interface EventEffects {
  trafficMultiplier: number;
  /** Extra edge rps by source. */
  crawlerRps: number;
  crawlerRandomQueryFraction: number;
  crawlerNotFoundFraction: number;
  loadTestRps: number;
  loadTestCacheBusting: boolean;
  /** Extra org-budget rps on the CMS limiter. */
  otherTrafficRps: number;
  /** Purges to apply this tick. */
  purges: { layer: 'launch' | 'cmsPage' | 'cmsList' | 'cmsGlobal'; fraction: number }[];
  /** Cold reset of Launch caches and compute (goLive, deploy). */
  coldReset: boolean;
  /** Priming requests per second for paths, during a deploy. */
  primingRps: number;
  primingPaths: number;
  /** Revalidation calls made this tick (counts against dailyQuota). */
  revalidations: number;
}

export interface IEventTimeline {
  effectsAt(ctx: TickContext): EventEffects;
}

export interface ITrafficGenerator {
  arrivals(ctx: TickContext, effects: EventEffects): ArrivalsByClass;
}

// ---- 6.7 Latency ----

export interface ILatencyHistogram {
  add(valueMs: number, weight: number): void;
  quantile(q: number): number;
  reset(): void;
}

// ---- 6.7-6.8 Pipeline and metrics ----

export interface PipelineInput {
  scenario: Scenario;
}

export interface MetricsSeries {
  /** Seconds covered. */
  length: number;
  columns: Record<string, Float32Array>;
}

export interface SummaryKpis {
  peakLaunchOriginRps: number;
  peakLaunchOriginPctOfLimit: number;
  secondsOverLaunchLimit: number;
  peakCmsOriginOfferedRps: number;
  peakCmsOriginPctOfLimit: number;
  secondsWithCms429: number;
  totalLaunch429: number;
  totalCms429: number;
  total504: number;
  total503: number;
  errorPagesServed: number;
  visitorErrorRate: number;
  worstSecondVisitorP95Ms: number;
  cmsCallsPerPageView: number;
  suggestedCmsLimitRps: number;
  projectedMonthlyApiCalls: { cached: number; uncached: number };
  bottleneck: 'none' | 'launchOrigin' | 'compute' | 'cmsOrigin' | 'timeout';
}

export interface SimulationResult {
  series: MetricsSeries;
  summary: SummaryKpis;
}

// ---- Findings ----

export type FindingSeverity = 'info' | 'warning' | 'critical';

export interface ScenarioPatch {
  /** dot-path -> new value, applied with setByPath. */
  set: Record<string, unknown>;
  /** Optional events to append. */
  addEvents?: ScenarioEvent[];
}

export interface Finding {
  severity: FindingSeverity;
  title: string;
  detail: string;
  suggestion?: ScenarioPatch;
}
