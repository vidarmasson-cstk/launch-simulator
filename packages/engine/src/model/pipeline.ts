import { Rng } from '../rng';
import type { Scenario } from '../schema';
import { cpuMsForMachine, MACHINE_VCPU, resolveFramework } from '../params/frameworks';
import { CacheLayer } from './cacheLayer';
import { ComputeModel } from './compute';
import { EventTimeline } from './events';
import { createLimiter } from './limiters';
import { MetricsCollector } from './metrics';
import type { TickSample } from './metrics';
import { buildPopularityBins } from './popularity';
import { expectedRetryWaitMs, finalFailureProbability, RetryRing } from './retry';
import { TrafficGenerator } from './traffic';
import type {
  CacheLayerConfig,
  CacheStepResult,
  ComputeStepResult,
  Limiter,
  PopularityBin,
  RetryPolicyConfig,
  SimulationMarker,
  SimulationResult,
  TickContext,
} from './types';

export interface RunOptions {
  /** Called with a fraction in [0, 1] roughly every 1% of the ticks and once at the end. */
  onProgress?: (fraction: number) => void;
}

/** Time constant (s) of the exponential moving average of the accepted-render class mix. */
const MIX_TAU_SEC = 2;

interface CmsLayerEntry {
  layer: CacheLayer;
  lam: Float64Array;
  res: CacheStepResult | null;
}

/** Expected origin fetch rate of a fixed-TTL cache from a per-bin request rate (steady state). */
function steadyFetchRate(lambda: number, keys: number, ttlSec: number): number {
  if (!(lambda > 0)) return 0;
  if (!Number.isFinite(ttlSec)) return 0;
  const r = lambda / keys;
  return lambda / (1 + r * ttlSec);
}

function markerFor(e: Scenario['events'][number]): SimulationMarker {
  switch (e.kind) {
    case 'spike':
      return { timeSec: e.atSec, kind: e.kind, label: `traffic spike x${e.multiplier}` };
    case 'publish':
      return { timeSec: e.atSec, kind: e.kind, label: `publish ${e.entries} entries` };
    case 'deploy':
      return { timeSec: e.atSec, kind: e.kind, label: `deploy (build ${e.buildSec}s)` };
    case 'goLive':
      return { timeSec: e.atSec, kind: e.kind, label: 'go-live (cold caches)' };
    case 'crawler':
      return { timeSec: e.atSec, kind: e.kind, label: `crawler ${e.rps} rps` };
    case 'loadTest':
      return {
        timeSec: e.atSec,
        kind: e.kind,
        label: `load test ${e.rps} rps${e.cacheBusting ? ' (cache busting)' : ''}`,
      };
    case 'otherTraffic':
      return { timeSec: e.atSec, kind: e.kind, label: `other org traffic ${e.rps} rps` };
  }
}

/**
 * Tick loop wiring all components (DESIGN 6.7).
 *
 * Approximations and assumptions (beyond DESIGN 5 / 6.7):
 * - Bot, crawler and non-cache-busting load-test page traffic is spread uniformly over keys
 *   (mass n_b / K per bin); `traffic.bots.zipfAlpha` is not used for binning in v1.
 * - Static render mode: origin requests are served from static storage. They still count against
 *   the Launch origin limiter but use no compute and make no CMS calls (service time = 0).
 * - Compute and CMS service time use the previous tick's service estimate (one-tick lag).
 * - Server-side (per instance / shared) CMS caching uses the current tick's ready instances; the
 *   failure probability per render uses the nominal calls per render (server cache ignored).
 * - The external CDN's cohorts complete at hit latency when the miss is a Launch cache hit and at
 *   queue wait + service time + hit latency otherwise (success 1 for the former); failed fetches
 *   are error-cached when `cachesErrors` is on (any failure, not only 404).
 * - Launch success fraction also multiplies (1 - shed 503 fraction): shed renders never fill a cache.
 * - Visitor 429/5xx/404 are apportioned from origin-bound visitor requests (blocking misses,
 *   uncacheable, bot-unique, not-found and uncached data); not-found responses are not errors.
 * - CMS layers are only created for call classes with a positive call count.
 * - Client navs used for browser-direct CMS calls are the fluid expectation (not sampled).
 */
export function runSimulation(scenario: Scenario, opts: RunOptions = {}): SimulationResult {
  const fw = resolveFramework(scenario);
  const { sim, site, launch, cms, sdk } = scenario;
  const trf = scenario.traffic;
  const dt = sim.dtSec;
  const ticks = Math.max(1, Math.round(sim.durationSec / dt));
  const duration = sim.durationSec;
  const rng = new Rng(sim.seed);
  const timeline = new EventTimeline(scenario);
  const traffic = new TrafficGenerator(scenario, rng);
  const metrics = new MetricsCollector(scenario);

  const staticMode = fw.renderMode === 'static';
  const cmsActive = fw.runtimeCms && !staticMode;
  const cpuMs = cpuMsForMachine(fw.cpuRenderMsL1, launch.compute.machine);
  const timeoutMs = launch.compute.timeoutSec * 1000;
  const hitMs = launch.cdn.hitLatencyMs;
  const unc = site.uncacheableFraction;
  const navFrac = fw.navRenderCallFraction;

  // ---- popularity ----
  const pageBins: PopularityBin[] = buildPopularityBins({
    pages: site.pages,
    locales: site.locales,
    variants: site.personalizeVariants,
    zipfAlpha: site.zipfAlpha,
    localeZipfAlpha: site.localeZipfAlpha,
  });
  const B = pageBins.length;
  const nB = new Float64Array(B);
  const npB = new Float64Array(B);
  const uniB = new Float64Array(B);
  let K = 0;
  for (let b = 0; b < B; b++) K += pageBins[b]!.n;
  for (let b = 0; b < B; b++) {
    nB[b] = pageBins[b]!.n;
    npB[b] = pageBins[b]!.n * pageBins[b]!.p;
    uniB[b] = pageBins[b]!.n / K;
  }
  const n1Bins = buildPopularityBins({
    pages: cms.contentTypes * cms.entriesPerType,
    locales: site.locales,
    variants: 1,
    zipfAlpha: site.zipfAlpha,
    localeZipfAlpha: site.localeZipfAlpha,
  });
  const N1 = n1Bins.length;
  const n1np = new Float64Array(N1);
  for (let b = 0; b < N1; b++) n1np[b] = n1Bins[b]!.n * n1Bins[b]!.p;

  // ---- layers ----
  const launchLat = launch.compute.timeoutSec + 5;
  const mk = (
    ttlSec: number,
    swrSec: number,
    staleIfErrorSec: number,
    collapse: boolean,
    domains: number,
    maxLatencySec: number,
    errTtl?: number,
  ): CacheLayerConfig => {
    const cfg: CacheLayerConfig = {
      ttlSec,
      swrSec,
      staleIfErrorSec,
      collapse,
      domains,
      maxLatencySec,
      durationSec: duration,
      dtSec: dt,
    };
    if (errTtl !== undefined) cfg.cacheErrors = { ttlSec: errTtl };
    return cfg;
  };
  const hp = site.cacheHeaders.page;
  const hd = site.cacheHeaders.data;
  const pageCached = hp.cacheable && hp.sMaxAgeSec > 0;
  const dataCached = fw.dataCacheable && hd.cacheable && hd.sMaxAgeSec > 0;
  const pageLayer = pageCached
    ? new CacheLayer(
        mk(
          hp.sMaxAgeSec,
          hp.swrSec,
          hp.staleIfErrorSec,
          launch.cdn.collapse,
          launch.cdn.domains,
          launchLat,
        ),
        pageBins,
      )
    : null;
  const dataLayer = dataCached
    ? new CacheLayer(
        mk(
          hd.sMaxAgeSec,
          hd.swrSec,
          hd.staleIfErrorSec,
          launch.cdn.collapse,
          launch.cdn.domains,
          launchLat,
        ),
        pageBins,
      )
    : null;
  const ext = launch.externalCdn;
  const extLayer = ext.enabled
    ? new CacheLayer(
        mk(
          ext.ttlSec,
          0,
          0,
          true,
          launch.cdn.domains,
          launchLat,
          ext.cachesErrors ? ext.errorTtlSec : undefined,
        ),
        pageBins,
      )
    : null;

  const cdnTtl = cms.cdn.ttlSec ?? Infinity;
  const cmsCfg = () => mk(cdnTtl, 0, 0, cms.cdn.collapse, cms.cdn.domains, 30);
  const globalKeys = site.globalKeys * site.locales;
  const listKeys = cms.contentTypes * site.locales;
  const hasGlobal = cmsActive && fw.globalCalls > 0;
  const hasPage = cmsActive && (fw.pageCalls > 0 || fw.clientCmsCallsPerNav > 0);
  const hasList = cmsActive && fw.listCalls > 0;
  const hasN1 = cmsActive && fw.n1Calls > 0;
  const gE: CmsLayerEntry | null = hasGlobal
    ? {
        layer: new CacheLayer(cmsCfg(), [{ n: globalKeys, p: 1 / globalKeys }]),
        lam: new Float64Array(1),
        res: null,
      }
    : null;
  const pE: CmsLayerEntry | null = hasPage
    ? { layer: new CacheLayer(cmsCfg(), pageBins), lam: new Float64Array(B), res: null }
    : null;
  const lE: CmsLayerEntry | null = hasList
    ? {
        layer: new CacheLayer(cmsCfg(), [{ n: listKeys, p: 1 / listKeys }]),
        lam: new Float64Array(1),
        res: null,
      }
    : null;
  const nE: CmsLayerEntry | null = hasN1
    ? { layer: new CacheLayer(cmsCfg(), n1Bins), lam: new Float64Array(N1), res: null }
    : null;
  const cmsEntries = [gE, pE, lE, nE].filter((x): x is CmsLayerEntry => x !== null);

  // ---- limiters, retries, compute ----
  const launchLimiter: Limiter = createLimiter({
    algorithm: 'tokenBucket',
    limitRps: launch.originLimitRps,
    capacity: launch.originLimitRps * launch.originBurstSec,
    dtSec: dt,
  });
  const lim = cms.api === 'graphql' ? cms.graphql : cms.cda;
  const cmsLimiter: Limiter =
    lim.algorithm === 'tokenBucket'
      ? createLimiter({
          algorithm: 'tokenBucket',
          limitRps: lim.limitRps,
          capacity: lim.limitRps * Math.max(1, lim.burstMultiplierPct / 100),
          dtSec: dt,
        })
      : lim.algorithm === 'gcra'
        ? createLimiter({
            algorithm: 'gcra',
            limitRps: lim.limitRps,
            burstMultiplierPct: lim.burstMultiplierPct,
            maxWaitMs: lim.maxWaitMs,
            dtSec: dt,
          })
        : createLimiter({ algorithm: lim.algorithm, limitRps: lim.limitRps, dtSec: dt });
  const retryCfg: RetryPolicyConfig = {
    policy: sdk.retry,
    dtSec: dt,
    sdkRateLimitWaitMs: sdk.sdkRateLimitWaitMs,
    sdkAssumeRemainingHeader: sdk.sdkAssumeRemainingHeader,
  };
  const retryRing = new RetryRing(retryCfg);
  const nRetries =
    sdk.retry.kind === 'none' ? 0 : Math.min(20, Math.max(0, Math.floor(sdk.retry.retries)));
  const cc = launch.compute;
  const compute = new ComputeModel({
    vcpu: MACHINE_VCPU[cc.machine],
    concurrencyPerInstance: cc.concurrencyPerInstance,
    maxInstances: cc.maxInstances,
    minInstances: cc.minInstances,
    scaleOutPerSec: cc.scaleOutPerSec,
    coldStartMs: cc.coldStartMs,
    idleScaleToZeroSec: cc.idleScaleToZeroSec,
    timeoutSec: cc.timeoutSec,
    maxQueue: cc.maxQueue,
    dtSec: dt,
  });

  // ---- scratch arrays ----
  const lamPageUser = new Float64Array(B);
  const lamLaunchPage = new Float64Array(B);
  const lamData = new Float64Array(B);
  const pageFetch = new Float64Array(B);
  const dataFetch = new Float64Array(B);
  const pageShare = new Float64Array(B);
  const dataShare = new Float64Array(B);
  const binCalls = new Float64Array(B);
  const primingCache = new Map<number, Float64Array>();

  const primingShare = (paths: number): Float64Array => {
    const key = Math.max(0, Math.floor(paths));
    let s = primingCache.get(key);
    if (s) return s;
    s = new Float64Array(B);
    let rem = Math.min(key, K);
    const tot = rem;
    for (let b = 0; b < B && rem > 0; b++) {
      const take = Math.min(nB[b]!, rem);
      s[b] = take / tot;
      rem -= take;
    }
    primingCache.set(key, s);
    return s;
  };

  const fillShare = (dst: Float64Array, src: Float64Array): void => {
    let sum = 0;
    for (let b = 0; b < B; b++) sum += src[b]!;
    if (sum > 1e-12) for (let b = 0; b < B; b++) dst[b] = src[b]! / sum;
    else for (let b = 0; b < B; b++) dst[b] = npB[b]!;
  };

  // ---- CMS call generation (shared by the tick loop and the warm start) ----
  const sc = fw.serverCache;
  const scOn = sc.scope !== 'none' && sc.ttlSec > 0;
  const scGlobal = scOn && sc.appliesTo.includes('global');
  const scList = scOn && sc.appliesTo.includes('list');
  const scPage = scOn && sc.appliesTo.includes('page');
  const callsPerRender = fw.globalCalls + fw.pageCalls + fw.listCalls + fw.n1Calls;
  const gen = { global: 0, list: 0, n1: 0, notFound: 0 };
  const genCalls = (
    sPage: number,
    sData: number,
    sBotU: number,
    sUnc: number,
    sNf: number,
    navs: number,
    inst: number,
  ): void => {
    const eq = sPage + sBotU + sUnc + sData * navFrac;
    const I = sc.scope === 'shared' ? 1 : Math.max(1, inst);
    const T = sc.ttlSec;
    const cut = (calls: number, keys: number): number => {
      const x = calls / dt / Math.max(1, keys) / I;
      return calls * (1 - (x * T) / (1 + x * T));
    };
    let g = fw.globalCalls * eq;
    let l = fw.listCalls * eq;
    if (scGlobal && g > 0) g = cut(g, globalKeys);
    if (scList && l > 0) l = cut(l, listKeys);
    gen.global = g;
    gen.list = l;
    gen.n1 = fw.n1Calls * eq;
    gen.notFound = sNf * site.cmsCallsPerNotFound;
    const clientCalls = navs * fw.clientCmsCallsPerNav;
    for (let b = 0; b < B; b++) {
      let pc =
        fw.pageCalls *
        (sPage * pageShare[b]! +
          sData * navFrac * dataShare[b]! +
          sBotU * uniB[b]! +
          sUnc * npB[b]!);
      if (scPage && pc > 0) pc = cut(pc, nB[b]!);
      binCalls[b] = pc + clientCalls * npB[b]!;
    }
    if (gE) gE.lam[0] = gen.global / dt;
    if (lE) lE.lam[0] = gen.list / dt;
    if (pE) for (let b = 0; b < B; b++) pE.lam[b] = binCalls[b]! / dt;
    if (nE) for (let b = 0; b < N1; b++) nE.lam[b] = (gen.n1 / dt) * n1np[b]!;
  };

  // ---- initial state ----
  const serviceMs0 = cmsActive ? cpuMs + fw.sequentialWaves * cms.cdn.hitLatencyMs : cpuMs;
  let serviceMsPrev = serviceMs0;
  const coldStart = scenario.events.some((e) => e.kind === 'goLive' && e.atSec <= dt);
  if (!coldStart) {
    const hist = sim.warmHistorySec ?? 3600;
    const V0 = trf.baseEdgeRps * traffic.profileFactor(0);
    const share = Math.min(0.999, Math.max(0, trf.bots.share));
    const botRate = (V0 * share) / (1 - share);
    const restBot = Math.max(0, 1 - trf.bots.randomQueryFraction - trf.bots.notFoundFraction);
    const humanPageRate = V0 * (1 - fw.clientNavFraction);
    const navRate = V0 * fw.clientNavFraction;
    const dataRate = navRate * fw.dataRequestsPerNav + V0 * fw.prefetchPerView;
    const botPageRate = botRate * restBot;
    const botURate = botRate * trf.bots.randomQueryFraction;
    const nfRate = botRate * trf.bots.notFoundFraction;
    const uncRate = unc * (humanPageRate + botPageRate);
    const D = launch.cdn.domains;

    for (let b = 0; b < B; b++) {
      lamPageUser[b] = (humanPageRate * npB[b]! + botPageRate * uniB[b]!) * (1 - unc);
      lamData[b] = dataRate * npB[b]!;
    }
    if (extLayer) {
      extLayer.warm(lamPageUser, hist);
      for (let b = 0; b < B; b++)
        lamLaunchPage[b] = steadyFetchRate(lamPageUser[b]!, nB[b]! * D, ext.ttlSec);
    } else lamLaunchPage.set(lamPageUser);
    let renderRate = uncRate + botURate + nfRate;
    let pageFetchSum = 0;
    let dataFetchSum = 0;
    for (let b = 0; b < B; b++) {
      if (pageLayer) {
        pageFetch[b] = steadyFetchRate(lamLaunchPage[b]!, nB[b]! * D, hp.sMaxAgeSec);
      } else pageFetch[b] = lamLaunchPage[b]!;
      dataFetch[b] = dataLayer
        ? steadyFetchRate(lamData[b]!, nB[b]! * D, hd.sMaxAgeSec)
        : lamData[b]!;
      pageFetchSum += pageFetch[b]!;
      dataFetchSum += dataFetch[b]!;
    }
    pageLayer?.warm(lamLaunchPage, hist);
    dataLayer?.warm(lamData, hist);
    renderRate += pageFetchSum + dataFetchSum;

    if (!staticMode) {
      const inFlight = (renderRate * serviceMs0) / 1000;
      const instances = Math.max(cc.minInstances, Math.ceil(inFlight / cc.concurrencyPerInstance));
      compute.warmStart(instances);
      if (cmsActive) {
        fillShare(pageShare, pageFetch);
        fillShare(dataShare, dataFetch);
        genCalls(
          pageFetchSum * dt,
          dataFetchSum * dt,
          botURate * dt,
          uncRate * dt,
          nfRate * dt,
          navRate * dt,
          instances,
        );
        for (const e of cmsEntries) e.layer.warm(e.lam, hist);
      }
    }
  }

  // ---- per-tick state ----
  const mixAlpha = 1 - Math.exp(-dt / MIX_TAU_SEC);
  const ema = { page: 0, data: 0, botUnique: 0, unc: 0, notFound: 0 };
  let hCms = 1;
  let revUsed = 0;
  let revRejected = 0;
  const progressEvery = Math.max(1, Math.floor(ticks / 100));
  const zeroRes: ComputeStepResult = {
    started: 0,
    queue: 0,
    inFlight: 0,
    readyInstances: 0,
    rejected503: 0,
    timeouts504: 0,
    queueWaitMs: 0,
  };

  // Visitor outcome accumulators for the current tick (set by `fate`).
  let vE429 = 0;
  let vE5xx = 0;
  let vE404 = 0;
  let af = 1;
  let s503 = 0;
  let pTimeout = 0;
  let missLat = hitMs;
  const fate = (v: number, pFail: number): void => {
    if (!(v > 0)) return;
    const e429 = v * (1 - af);
    const acc = v * af;
    const e503 = acc * s503;
    const run = acc - e503;
    const e504 = run * pTimeout;
    const done = run - e504;
    const failed = done * pFail;
    const good = done - failed;
    vE429 += e429;
    vE5xx += e503 + e504;
    if (sdk.onFinalFailure === 'error500') vE5xx += failed;
    else if (sdk.onFinalFailure === 'render404') vE404 += failed;
    metrics.addVisitor(hitMs, e429 + e503);
    metrics.addVisitor(timeoutMs, e504);
    metrics.addVisitor(missLat, good + failed);
  };

  const sample: TickSample = {
    edgePage: 0,
    edgeData: 0,
    edgeBot: 0,
    edgeStatic: 0,
    edgeTotal: 0,
    launchReq: 0,
    launchHits: 0,
    launchOffered: 0,
    launchAccepted: 0,
    launch429: 0,
    instances: 0,
    inFlight: 0,
    queue: 0,
    queueWaitMs: 0,
    c503: 0,
    c504: 0,
    cmsCalls: 0,
    cmsReq: 0,
    cmsHits: 0,
    cmsOfferedNew: 0,
    cmsOfferedOther: 0,
    cmsTotal: 0,
    cmsAccepted: 0,
    cmsQueued: 0,
    cms429: 0,
    cmsRetries: 0,
    cmsFinal: 0,
    gcraDelayMs: 0,
    otherOrg: 0,
    visitorErrors5xx: 0,
    visitorErrors404: 0,
    visitorErrors429: 0,
    visitorRequests: 0,
    humanViews: 0,
    revalidationsUsed: 0,
    revalidationsRejected: 0,
  };

  for (let tick = 0; tick < ticks; tick++) {
    const timeSec = tick * dt;
    const ctx: TickContext = { tick, dtSec: dt, timeSec };
    metrics.begin(timeSec);

    // 1. events -> effects, purges, quota
    const fx = timeline.effectsAt(ctx);
    let skipLaunchPurge = false;
    if (fx.revalidations > 0) {
      if (revUsed + fx.revalidations > launch.revalidation.dailyQuota) {
        revRejected += fx.revalidations;
        skipLaunchPurge = !fx.coldReset;
      } else revUsed += fx.revalidations;
    }
    for (const p of fx.purges) {
      switch (p.layer) {
        case 'launch':
          if (!skipLaunchPurge) {
            pageLayer?.purge(p.fraction);
            dataLayer?.purge(p.fraction);
          }
          break;
        case 'cmsPage':
          pE?.layer.purge(p.fraction);
          nE?.layer.purge(p.fraction);
          break;
        case 'cmsList':
          lE?.layer.purge(p.fraction);
          break;
        case 'cmsGlobal':
          gE?.layer.purge(p.fraction);
          break;
      }
    }
    if (fx.coldReset && !staticMode) compute.reset();

    // 2. arrivals
    const arr = traffic.arrivals(ctx, fx);
    const tb = traffic.lastBreakdown();
    const ltNB = tb.loadTestCacheBusting ? 0 : tb.loadTest;
    const humanOnly = Math.max(0, tb.humanPage - ltNB);
    const uniformPage = tb.botPage + ltNB;
    const hr = humanOnly / dt;
    const ur = uniformPage / dt;
    const dataRate = (tb.data + tb.prefetch) / dt;
    const primRate = tb.priming / dt;
    const primShare = primRate > 0 ? primingShare(fx.primingPaths) : null;

    // 3. layers (external CDN -> Launch page layer, Launch data layer)
    for (let b = 0; b < B; b++) {
      lamPageUser[b] = (hr * npB[b]! + ur * uniB[b]!) * (1 - unc);
      lamData[b] = dataRate * npB[b]!;
    }
    const extRes = extLayer ? extLayer.step(tick, lamPageUser) : null;
    for (let b = 0; b < B; b++) {
      const base = extRes ? extRes.originFetchesPerBin[b]! / dt : lamPageUser[b]!;
      lamLaunchPage[b] = base + (primShare ? primRate * primShare[b]! : 0);
    }
    const pageRes = pageLayer ? pageLayer.step(tick, lamLaunchPage) : null;
    const dataRes = dataLayer ? dataLayer.step(tick, lamData) : null;
    let pageOrigin = 0;
    let dataOrigin = 0;
    for (let b = 0; b < B; b++) {
      pageFetch[b] = pageRes ? pageRes.originFetchesPerBin[b]! : lamLaunchPage[b]! * dt;
      dataFetch[b] = dataRes ? dataRes.originFetchesPerBin[b]! : lamData[b]! * dt;
      pageOrigin += pageFetch[b]!;
      dataOrigin += dataFetch[b]!;
    }
    const uncCount = unc * (tb.humanPage + tb.botPage);

    // 4. Launch origin limiter
    const offeredMean = pageOrigin + dataOrigin + uncCount + tb.botUnique + tb.notFound;
    const scale = sim.stochastic && offeredMean > 0 ? rng.poisson(offeredMean) / offeredMean : 1;
    const offered = offeredMean * scale;
    const ll = launchLimiter.step(tick, offered);
    af = offered > 0 ? Math.min(1, ll.accepted / offered) : 1;
    const accepted = ll.accepted;
    const aPage = pageOrigin * scale * af;
    const aData = dataOrigin * scale * af;
    const aUnc = uncCount * scale * af;
    const aBotU = tb.botUnique * scale * af;
    const aNf = tb.notFound * scale * af;

    // 5. compute
    let cr: ComputeStepResult;
    if (staticMode) {
      cr = { ...zeroRes, started: accepted };
    } else {
      cr = compute.step(tick, accepted, serviceMsPrev);
    }
    ema.page += mixAlpha * (aPage - ema.page);
    ema.data += mixAlpha * (aData - ema.data);
    ema.botUnique += mixAlpha * (aBotU - ema.botUnique);
    ema.unc += mixAlpha * (aUnc - ema.unc);
    ema.notFound += mixAlpha * (aNf - ema.notFound);
    const emaSum = ema.page + ema.data + ema.botUnique + ema.unc + ema.notFound;
    const kStart = emaSum > 1e-12 ? cr.started / emaSum : 0;
    const sPage = ema.page * kStart;
    const sData = ema.data * kStart;
    const sBotU = ema.botUnique * kStart;
    const sUnc = ema.unc * kStart;
    const sNf = ema.notFound * kStart;

    // 6. CMS call generation
    const navs =
      trf.baseEdgeRps *
      traffic.profileFactor(timeSec) *
      fx.trafficMultiplier *
      fw.clientNavFraction *
      dt;
    let cmsCalls = 0;
    let cmsReq = 0;
    let cmsHits = 0;
    let newMean = 0;
    if (cmsActive) {
      fillShare(pageShare, pageFetch);
      fillShare(dataShare, dataFetch);
      genCalls(sPage, sData, sBotU, sUnc, sNf, navs, cr.readyInstances);
      for (const e of cmsEntries) {
        const r = e.layer.step(tick, e.lam);
        e.res = r;
        cmsReq += r.requests;
        cmsHits += r.hits + r.staleHits;
        let f = 0;
        const arrf = r.originFetchesPerBin;
        for (let b = 0; b < arrf.length; b++) f += arrf[b]!;
        newMean += f;
      }
      cmsCalls = cmsReq + gen.notFound;
      newMean += gen.notFound;
    }

    // 7. CMS origin limiter with retries
    const otherMean = (cms.otherOrgTrafficRps + fx.otherTrafficRps) * dt;
    const newCnt = sim.stochastic ? rng.poisson(newMean) : newMean;
    const otherCnt = sim.stochastic ? rng.poisson(otherMean) : otherMean;
    const due = retryRing.due(tick);
    let retriesCnt = 0;
    for (const d of due) retriesCnt += d.amount;
    const totalCms = newCnt + retriesCnt + otherCnt;
    const cl = cmsLimiter.step(tick, totalCms);
    const rho = totalCms > 0 ? Math.min(1, cl.rejected / totalCms) : 0;
    let finalFail = retryRing.scheduleRejected(tick, 0, newCnt * rho).finalFailures;
    for (const d of due)
      finalFail += retryRing.scheduleRejected(tick, d.attempt, d.amount * rho).finalFailures;

    // 8. latency and outcomes
    if (cmsReq > 1e-9) hCms = cmsHits / cmsReq;
    const gcraDelay = cl.avgQueueDelayMs;
    let serviceMs = cpuMs;
    let pFailFull = 0;
    let pFailData = 0;
    let pFailNf = 0;
    if (cmsActive) {
      const L = hCms * cms.cdn.hitLatencyMs + (1 - hCms) * (cms.cdn.originLatencyMs + gcraDelay);
      const retryWait = (1 - hCms) * expectedRetryWaitMs(rho, sdk.retry, retryCfg);
      serviceMs = cpuMs + fw.sequentialWaves * (L + retryWait);
      const ff = finalFailureProbability(rho, nRetries);
      const pFailCall = (1 - hCms) * ff;
      pFailFull = 1 - Math.pow(1 - pFailCall, callsPerRender);
      pFailData = 1 - Math.pow(1 - pFailCall, callsPerRender * navFrac);
      pFailNf = 1 - Math.pow(1 - ff, site.cmsCallsPerNotFound);
    }
    serviceMsPrev = serviceMs;
    pTimeout = cr.started > 1e-9 ? Math.min(1, cr.timeouts504 / cr.started) : 0;
    s503 = accepted > 1e-9 ? Math.min(1, cr.rejected503 / accepted) : 0;

    // 9. completions
    const launchTicks = Math.max(1, Math.ceil((cr.queueWaitMs + serviceMs) / 1000 / dt - 1e-9));
    const okBase = af * (1 - s503) * (1 - pTimeout);
    const pageSuccess = okBase * (1 - pFailFull);
    const dataSuccess = okBase * (1 - pFailData);
    pageLayer?.scheduleCompletions(tick, pageFetch, tick + launchTicks, pageSuccess);
    dataLayer?.scheduleCompletions(tick, dataFetch, tick + launchTicks, dataSuccess);
    const launchHitFrac =
      pageRes && pageRes.requests > 1e-12
        ? (pageRes.hits + pageRes.staleHits) / pageRes.requests
        : 0;
    if (extLayer && extRes) {
      const hitTicks = Math.max(1, Math.ceil(hitMs / 1000 / dt - 1e-9));
      const f = extRes.originFetchesPerBin;
      if (launchHitFrac > 0) {
        const hitAmt = new Float64Array(f.length);
        for (let b = 0; b < f.length; b++) hitAmt[b] = f[b]! * launchHitFrac;
        extLayer.scheduleCompletions(tick, hitAmt, tick + hitTicks, 1);
      }
      if (launchHitFrac < 1) {
        const missAmt = new Float64Array(f.length);
        for (let b = 0; b < f.length; b++) missAmt[b] = f[b]! * (1 - launchHitFrac);
        extLayer.scheduleCompletions(tick, missAmt, tick + launchTicks + hitTicks, pageSuccess);
      }
    }
    if (cmsActive) {
      const cmsTicks = Math.max(
        1,
        Math.ceil((cms.cdn.originLatencyMs + gcraDelay) / 1000 / dt - 1e-9),
      );
      for (const e of cmsEntries) {
        if (e.res)
          e.layer.scheduleCompletions(tick, e.res.originFetchesPerBin, tick + cmsTicks, 1 - rho);
      }
    }

    // 10. visitor accounting and metrics
    vE429 = 0;
    vE5xx = 0;
    vE404 = 0;
    missLat = Math.min(timeoutMs, hitMs + cr.queueWaitMs + serviceMs);
    const pageVisitors = (tb.humanPage + tb.botPage) * (1 - unc);
    if (extRes) {
      metrics.addVisitor(hitMs, extRes.hits + extRes.staleHits);
      if (extRes.errorsServed > 0) {
        if (sdk.onFinalFailure === 'render404') vE404 += extRes.errorsServed;
        else vE5xx += extRes.errorsServed;
        metrics.addVisitor(hitMs, extRes.errorsServed);
      }
      metrics.addVisitor(hitMs, extRes.blockingMisses * launchHitFrac);
      fate(extRes.blockingMisses * (1 - launchHitFrac), pFailFull);
    } else if (pageRes) {
      const keep = pageRes.requests > 1e-12 ? Math.max(0, 1 - tb.priming / pageRes.requests) : 1;
      metrics.addVisitor(hitMs, (pageRes.hits + pageRes.staleHits) * keep);
      fate(pageRes.blockingMisses * keep, pFailFull);
    } else {
      fate(pageVisitors, pFailFull);
    }
    if (dataRes) {
      metrics.addVisitor(hitMs, dataRes.hits + dataRes.staleHits);
      fate(dataRes.blockingMisses, pFailData);
    } else fate(tb.data + tb.prefetch, pFailData);
    fate(uncCount, pFailFull);
    fate(tb.botUnique, pFailFull);
    fate(tb.notFound, pFailNf);
    if (cr.started > 0) metrics.addRender(serviceMs, cr.started);

    sample.edgePage = arr.page;
    sample.edgeData = arr.data;
    sample.edgeBot = tb.botPage + tb.botUnique + tb.notFound;
    sample.edgeStatic = arr.staticAssets;
    sample.edgeTotal = arr.page + arr.data + arr.botUnique + arr.notFound + arr.staticAssets;
    sample.launchReq = (pageRes?.requests ?? 0) + (dataRes?.requests ?? 0);
    sample.launchHits =
      (pageRes ? pageRes.hits + pageRes.staleHits : 0) +
      (dataRes ? dataRes.hits + dataRes.staleHits : 0);
    sample.launchOffered = offered;
    sample.launchAccepted = accepted;
    sample.launch429 = ll.rejected;
    sample.instances = cr.readyInstances;
    sample.inFlight = cr.inFlight;
    sample.queue = cr.queue;
    sample.queueWaitMs = cr.queueWaitMs;
    sample.c503 = cr.rejected503;
    sample.c504 = cr.timeouts504;
    sample.cmsCalls = cmsCalls;
    sample.cmsReq = cmsReq;
    sample.cmsHits = cmsHits;
    sample.cmsOfferedNew = newCnt;
    sample.cmsOfferedOther = otherCnt;
    sample.cmsTotal = totalCms;
    sample.cmsAccepted = cl.accepted;
    sample.cmsQueued = cl.queued;
    sample.cms429 = cl.rejected;
    sample.cmsRetries = retriesCnt;
    sample.cmsFinal = finalFail;
    sample.gcraDelayMs = gcraDelay;
    sample.otherOrg = otherCnt;
    sample.visitorErrors5xx = vE5xx;
    sample.visitorErrors404 = vE404;
    sample.visitorErrors429 = vE429;
    sample.visitorRequests = arr.page + arr.data + arr.botUnique + arr.notFound;
    sample.humanViews = humanOnly + navs;
    sample.revalidationsUsed = revUsed;
    sample.revalidationsRejected = revRejected;
    metrics.record(sample);

    if (opts.onProgress && (tick + 1) % progressEvery === 0) opts.onProgress((tick + 1) / ticks);
  }
  opts.onProgress?.(1);

  return {
    series: metrics.series(),
    summary: metrics.summary(),
    markers: scenario.events.map(markerFor),
  };
}
