import type { Scenario } from '../schema';
import type { PopularityBin, SummaryKpis } from '../model/types';
import { buildPopularityBins, topKeysShare } from '../model/popularity';
import { STATIC_ASSETS_PER_VIEW } from '../model/traffic';
import { cpuMsForMachine, resolveFramework } from '../params/frameworks';

/**
 * Instant analytic steady-state model (DESIGN 6.9): no events, base traffic, warm caches.
 * Runs on every UI edit, so everything here is O(bins + locales) plus one Erlang-B recursion.
 *
 * Modelling notes (all approximations are documented in the About panel):
 * - Per key: Poisson arrivals at rate r, fixed TTL T set at fill, stale-while-revalidate S.
 *   Origin fetch rate f = r / (1 + rT); blocking-miss fraction = e^{-rS} / (1 + rT).
 *   T = Infinity means "cached until purged": warm, only purge-driven misses count.
 * - Purge-driven fetches from `steady.*`: added rate per average key = publishRate * phi *
 *   (1 - e^{-r * delta}) * P(key is cached), phi = purged fraction (same formulas as events.ts).
 * - Requests rejected by the Launch origin limiter never render (scale a = min(1, limit / offered)).
 * - The 1-second count of origin requests is Poisson (or negative binomial when sim.burstiness is set).
 */

export type HopId = 'edge' | 'launchCdn' | 'launchOrigin' | 'compute' | 'cmsCdn' | 'cmsOrigin';

export interface Hop {
  id: HopId;
  label: string;
  rps: number;
  limit?: number;
  utilPct?: number;
  hitRatio?: number;
  note?: string;
}

export interface SteadyStateKpis {
  edgeRps: number;
  launchHitRatio: number;
  launchOriginRps: number;
  launchLimitRps: number;
  launchUtilPct: number;
  renderRps: number;
  serviceMs: number;
  inFlight: number;
  instancesNeeded: number;
  computeUtilPct: number;
  erlangCWait: number;
  cmsCallsRps: number;
  cmsCallsPerPageView: number;
  cmsCdnHitRatio: number;
  cmsOriginRps: number;
  cmsLimitRps: number;
  cmsUtilPct: number;
  pLaunch429Second: number;
  pCms429Second: number;
  expectedCms429SecondsPerHour: number;
  expectedLaunch429SecondsPerHour: number;
  /** Smallest L with P(N > L) < 1/3600 (at most one bad second per hour), times 1.2, rounded up. */
  suggestedCmsLimitRps: number;
  projectedMonthlyApiCalls: { cached: number; uncached: number };
  bottleneck: SummaryKpis['bottleneck'];
  // ---- breakdowns used by findings ----
  /** Launch origin rps by source (offered, before the limiter). */
  origin404Rps: number;
  originBotUniqueRps: number;
  originPageRps: number;
  originDataRps: number;
  /** CMS origin rps by source. */
  cmsPurgeOriginRps: number;
  cmsNotFoundOriginRps: number;
  cmsOtherOrgRps: number;
  /** Renders per second hitting each CMS class (before server cache), for reference. */
  cmsGlobalHitRatio: number;
  /** Number of top paths covering 80% of page traffic (priming candidate). */
  primeTopPaths: number;
  /** Page views per second (humans). */
  pageViewsRps: number;
}

export interface SteadyStateResult {
  hops: Hop[];
  kpis: SteadyStateKpis;
}

// ---------------------------------------------------------------------------------------------
// Numerics
// ---------------------------------------------------------------------------------------------

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Gamma(x) for x > 0 (Lanczos, g = 7). */
export function lgamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  const xm = x - 1;
  let a = 0.99999999999980993;
  const t = xm + 7.5;
  for (let i = 0; i < 8; i++) a += LANCZOS[i]! / (xm + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (xm + 0.5) * Math.log(t) - t + Math.log(a);
}

function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const ans =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? ans : 2 - ans;
}

/** Upper tail of the standard normal, Q(z) = P(Z > z). */
function normalQ(z: number): number {
  return 0.5 * erfc(z / Math.SQRT2);
}

/**
 * P(N > limit) for a per-second count N with mean `mu`: Poisson, or negative binomial with
 * dispersion `k` (variance mu + mu^2/k) when k is a finite positive number. Sums the smaller side
 * of the pmf in a numerically stable way; normal approximation with continuity correction for
 * mu > 1000.
 */
export function countTail(mu: number, limit: number, k: number | null = null): number {
  if (!(mu > 0)) return 0;
  const L = Math.floor(limit + 1e-9);
  if (L < 0) return 1;
  const nb = typeof k === 'number' && Number.isFinite(k) && k > 0;
  const variance = nb ? mu + (mu * mu) / (k as number) : mu;
  if (mu > 1000) return Math.min(1, Math.max(0, normalQ((L + 0.5 - mu) / Math.sqrt(variance))));

  const q = nb ? mu / ((k as number) + mu) : 0; // NB: pmf(n+1)/pmf(n) = (n+k)/(n+1) * q
  const logPmf = (n: number): number =>
    nb
      ? lgamma(n + (k as number)) -
        lgamma(k as number) -
        lgamma(n + 1) +
        (k as number) * Math.log(1 - q) +
        n * Math.log(q)
      : n * Math.log(mu) - mu - lgamma(n + 1);

  if (L + 1 > mu) {
    // Upper side decays: sum upward from L + 1.
    let term = Math.exp(logPmf(L + 1));
    let sum = 0;
    for (let n = L + 1; n < L + 200000; n++) {
      sum += term;
      const ratio = nb ? ((n + (k as number)) / (n + 1)) * q : mu / (n + 1);
      term *= ratio;
      if (term < 1e-18 * sum && ratio < 1) break;
    }
    return Math.min(1, sum);
  }
  // Lower side: sum downward from L to 0 and subtract from 1.
  let term = Math.exp(logPmf(L));
  let sum = 0;
  for (let n = L; n >= 0; n--) {
    sum += term;
    const ratio = nb ? n / ((n - 1 + (k as number)) * q) : n / mu; // pmf(n-1) / pmf(n)
    term *= ratio;
    if (term < 1e-18 * sum) break;
  }
  return Math.min(1, Math.max(0, 1 - sum));
}

/** Smallest integer L with P(N > L) < target. */
export function smallestLimit(mu: number, target: number, k: number | null = null): number {
  if (!(mu > 0)) return 0;
  let lo = Math.floor(mu);
  let hi = Math.ceil(mu + 10 * Math.sqrt(mu + (typeof k === 'number' && k > 0 ? (mu * mu) / k : 0)) + 10);
  while (countTail(mu, hi, k) >= target) hi *= 2;
  if (countTail(mu, lo, k) < target) return lo;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (countTail(mu, mid, k) < target) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Erlang C probability that an arriving request has to wait, offered load `a` erlangs, c servers. */
export function erlangC(a: number, c: number): number {
  if (!(a > 0)) return 0;
  if (a >= c) return 1;
  let b = 1;
  for (let i = 1; i <= c; i++) b = (a * b) / (i + a * b);
  const rho = a / c;
  return Math.min(1, b / (1 - rho * (1 - b)));
}

// ---------------------------------------------------------------------------------------------
// Cache formulas
// ---------------------------------------------------------------------------------------------

/** Per-key origin fetch rate and blocking-miss fraction (of requests) for TTL T, SWR S. */
function perKey(r: number, T: number, S: number): { f: number; block: number } {
  if (!(r > 0)) return { f: 0, block: 0 };
  if (T === Infinity) return { f: 0, block: 0 };
  if (!(T > 0)) return { f: r, block: 1 };
  const denom = 1 + r * T;
  return { f: r / denom, block: Math.exp(-r * S) / denom };
}

/** P(key is cached and fresh at a random instant) under fixed TTL from fill. */
function freshProb(r: number, T: number): number {
  if (T === Infinity) return 1;
  if (!(r > 0) || !(T > 0)) return 0;
  return (r * T) / (1 + r * T);
}

interface Group {
  /** Number of keys. */
  n: number;
  /** Total request rate to those keys. */
  rate: number;
}

const binMemo = new Map<string, PopularityBin[]>();
function bins(pages: number, locales: number, variants: number, zipf: number, lzipf: number) {
  const key = `${pages}|${locales}|${variants}|${zipf}|${lzipf}`;
  let b = binMemo.get(key);
  if (!b) {
    b = buildPopularityBins({
      pages,
      locales,
      variants,
      zipfAlpha: zipf,
      localeZipfAlpha: lzipf,
    });
    if (binMemo.size > 64) binMemo.clear();
    binMemo.set(key, b);
  }
  return b;
}

function localeWeights(locales: number, alpha: number): number[] {
  const w: number[] = [];
  let total = 0;
  for (let i = 0; i < locales; i++) {
    const v = alpha === 0 ? 1 : Math.pow(i + 1, -alpha);
    w.push(v);
    total += v;
  }
  return w.map((v) => v / total);
}

const SECONDS_PER_MONTH = 30 * 86400;

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

export function computeSteadyState(scenario: Scenario): SteadyStateResult {
  const { traffic, site, launch, cms, sim, steady } = scenario;
  const fw = resolveFramework(scenario);
  const dConfig = launch.cdn.domains;

  // ---- Traffic split (mirrors model/traffic.ts, profile factor 1, no events) ----
  const V = traffic.baseEdgeRps;
  const share = Math.min(0.999, Math.max(0, traffic.bots.share));
  const botRate = V * (share / (1 - share));
  const rq = traffic.bots.randomQueryFraction;
  const nf = traffic.bots.notFoundFraction;
  const restBot = Math.max(0, 1 - rq - nf);
  const humanPage = V * (1 - fw.clientNavFraction);
  const navs = V * fw.clientNavFraction;
  const dataReq = navs * fw.dataRequestsPerNav + V * fw.prefetchPerView;
  const pageReq = humanPage + botRate * restBot;
  const botUnique = botRate * rq;
  const notFound = botRate * nf;
  const staticRps = (humanPage + navs) * STATIC_ASSETS_PER_VIEW;
  const edgeRps = pageReq + dataReq + botUnique + notFound + staticRps;
  const cdnRequests = pageReq + dataReq + botUnique + notFound;

  // ---- Launch layer ----
  const pageBins = bins(
    site.pages,
    site.locales,
    site.personalizeVariants,
    site.zipfAlpha,
    site.localeZipfAlpha,
  );
  const uf = site.uncacheableFraction;
  const pagePol = site.cacheHeaders.page;
  const dataPol = site.cacheHeaders.data;
  const pageCacheable = pagePol.cacheable && pagePol.sMaxAgeSec > 0;
  const dataCacheable = fw.dataCacheable && dataPol.cacheable && dataPol.sMaxAgeSec > 0;
  const ext = launch.externalCdn;
  const extOn = ext.enabled && ext.ttlSec > 0;

  const nBins = pageBins.length;
  const pageOriginBin = new Float64Array(nBins);
  const dataOriginBin = new Float64Array(nBins);
  let pageBlocking = 0;
  let dataBlocking = 0;

  const launchClass = (
    lambda: number,
    cacheable: boolean,
    pol: { sMaxAgeSec: number; swrSec: number },
    outBin: Float64Array,
  ): number => {
    // returns blocking-miss request rate; fills outBin with origin fetch rate per bin
    let blocking = 0;
    const lamCache = cacheable ? lambda * (1 - uf) : 0;
    const lamBypass = lambda - lamCache;
    for (let i = 0; i < nBins; i++) {
      const b = pageBins[i]!;
      const mass = b.n * b.p;
      let fetch = lamBypass * mass;
      blocking += lamBypass * mass;
      if (lamCache > 0) {
        let n = b.n;
        let rBin = lamCache * mass; // total rate to the bin
        if (extOn && ext.ttlSec > 0) {
          // External CDN: D = 1, no SWR; its fetch stream is what reaches Launch.
          const rExt = rBin / n;
          const e = perKey(rExt, ext.ttlSec, 0);
          rBin = e.f * n;
        }
        const r = rBin / (n * dConfig);
        const pk = perKey(r, pol.sMaxAgeSec, pol.swrSec);
        fetch += n * dConfig * pk.f;
        blocking += rBin * pk.block;
        n = 0;
      }
      outBin[i] = fetch;
    }
    return blocking;
  };

  pageBlocking = launchClass(pageReq, pageCacheable, pagePol, pageOriginBin);
  dataBlocking = launchClass(dataReq, dataCacheable, dataPol, dataOriginBin);
  const originPage = sum(pageOriginBin);
  const originData = sum(dataOriginBin);
  const launchOffered = originPage + originData + botUnique + notFound;
  const launchLimit = launch.originLimitRps;
  const accept = launchOffered > 0 ? Math.min(1, launchLimit / launchOffered) : 1;
  const launchBlocking = pageBlocking + dataBlocking + botUnique + notFound;
  const launchHitRatio = cdnRequests > 0 ? Math.max(0, 1 - launchBlocking / cdnRequests) : 1;

  // ---- Renders and CMS call generation ----
  const phi = fw.navRenderCallFraction;
  const runtime = fw.runtimeCms && fw.renderMode !== 'static';
  const rendersPageLike = accept * (originPage + botUnique);
  const rendersData = accept * originData;
  const rendersNotFound = accept * notFound;
  const renderRps = rendersPageLike + rendersData + rendersNotFound;
  /** Full-render equivalents that make the class calls. */
  const fre = rendersPageLike + phi * rendersData;

  // Page key stream per bin (renders that fetch the page entry).
  const pageRenderBin = new Float64Array(nBins);
  for (let i = 0; i < nBins; i++) {
    const b = pageBins[i]!;
    pageRenderBin[i] =
      accept * (pageOriginBin[i]! + botUnique * b.n * b.p + phi * dataOriginBin[i]!);
  }

  // Purge fractions (same formulas as model/events.ts, 'all' locales).
  const pph = steady.publishesPerHour;
  const E = steady.entriesPerPublish;
  const publishRate = pph > 0 && E > 0 ? pph / 3600 : 0;
  const delta = publishRate > 0 ? 1 / publishRate : Infinity;
  const pur = steady.purge;
  const phiPage =
    publishRate > 0
      ? Math.min(1, (pur.pageQueries ? E / site.pages : 0) + pur.referencingFraction)
      : 0;
  const phiList =
    publishRate > 0 && pur.contentTypeLists
      ? Math.min(cms.contentTypes, Math.max(1, Math.ceil(E / cms.entriesPerType))) /
        cms.contentTypes
      : 0;
  const phiGlobal = publishRate > 0 && pur.globals ? 1 : 0;

  const cmsTtl = cms.cdn.ttlSec === null ? Infinity : cms.cdn.ttlSec;
  const Dc = cms.cdn.domains;
  const lw = localeWeights(site.locales, site.localeZipfAlpha);

  const groupsFor = (): {
    global: Group[];
    list: Group[];
    page: Group[];
    n1: Group[];
    client: Group[];
  } => {
    const g: Group[] = [];
    const l: Group[] = [];
    for (let j = 0; j < site.locales; j++) {
      g.push({ n: site.globalKeys, rate: fre * fw.globalCalls * lw[j]! });
      l.push({ n: cms.contentTypes, rate: fre * fw.listCalls * lw[j]! });
    }
    const p: Group[] = [];
    const c: Group[] = [];
    const clientRate = navs * fw.clientCmsCallsPerNav;
    for (let i = 0; i < nBins; i++) {
      const b = pageBins[i]!;
      p.push({ n: b.n, rate: pageRenderBin[i]! * fw.pageCalls });
      if (clientRate > 0) c.push({ n: b.n, rate: clientRate * b.n * b.p });
    }
    let n1: Group[] = [];
    if (fw.n1Calls > 0 && fre > 0) {
      const eb = bins(
        cms.contentTypes * cms.entriesPerType,
        site.locales,
        1,
        site.zipfAlpha,
        site.localeZipfAlpha,
      );
      n1 = eb.map((b) => ({ n: b.n, rate: fre * fw.n1Calls * b.n * b.p }));
    }
    return { global: g, list: l, page: p, n1, client: c };
  };

  interface ClassAgg {
    calls: number;
    fetch: number;
    purgeFetch: number;
  }
  const sc = fw.serverCache;

  const cmsPass = (instances: number) => {
    const groups = runtime
      ? groupsFor()
      : { global: [], list: [], page: [], n1: [], client: [] as Group[] };
    const agg = (
      gs: Group[],
      cls: 'global' | 'list' | 'page' | 'n1' | 'client',
      phiPurge: number,
    ): ClassAgg => {
      const serverCached =
        sc.scope !== 'none' && (cls === 'global' || cls === 'list' || cls === 'page') && sc.appliesTo.includes(cls);
      let calls = 0;
      let fetch = 0;
      let purgeFetch = 0;
      for (const g of gs) {
        if (!(g.rate > 0)) continue;
        let rate = g.rate;
        if (serverCached && sc.ttlSec > 0) {
          const lk = rate / g.n;
          const div = sc.scope === 'perInstance' ? Math.max(1, instances) : 1;
          rate = g.n * (lk / (1 + (lk * sc.ttlSec) / div));
        }
        calls += rate;
        const r = rate / (g.n * Dc);
        const pk = perKey(r, cmsTtl, 0);
        fetch += g.n * Dc * pk.f;
        if (phiPurge > 0 && cls !== 'client') {
          const add =
            g.n *
            Dc *
            publishRate *
            phiPurge *
            (1 - Math.exp(-r * delta)) *
            freshProb(r, cmsTtl);
          purgeFetch += add;
        }
      }
      return { calls, fetch: fetch + purgeFetch, purgeFetch };
    };
    const global = agg(groups.global, 'global', phiGlobal);
    const list = agg(groups.list, 'list', phiList);
    const page = agg(groups.page, 'page', phiPage);
    const n1 = agg(groups.n1, 'n1', 0);
    const client = agg(groups.client, 'client', 0);
    const nfCalls = runtime ? rendersNotFound * site.cmsCallsPerNotFound : 0;
    const renderCalls = global.calls + list.calls + page.calls + n1.calls;
    const renderFetch = global.fetch + list.fetch + page.fetch + n1.fetch;
    return { global, list, page, n1, client, nfCalls, renderCalls, renderFetch };
  };

  const serviceFor = (pass: ReturnType<typeof cmsPass>): { serviceMs: number; h: number } => {
    const h = pass.renderCalls > 0 ? Math.max(0, 1 - pass.renderFetch / pass.renderCalls) : 1;
    const cpu = cpuMsForMachine(fw.cpuRenderMsL1, launch.compute.machine);
    const cmsMs = runtime
      ? fw.sequentialWaves * (h * cms.cdn.hitLatencyMs + (1 - h) * cms.cdn.originLatencyMs)
      : 0;
    return { serviceMs: cpu + cmsMs, h };
  };

  const comp = launch.compute;
  let pass = cmsPass(1);
  let svc = serviceFor(pass);
  if (sc.scope === 'perInstance' && sc.appliesTo.length > 0 && renderRps > 0) {
    const inflight0 = (renderRps * svc.serviceMs) / 1000;
    const inst = Math.min(comp.maxInstances, Math.max(1, Math.ceil(inflight0 / comp.concurrencyPerInstance)));
    pass = cmsPass(inst);
    svc = serviceFor(pass);
  }

  const cmsCallsRps = pass.renderCalls + pass.client.calls + pass.nfCalls;
  const cmsFetchRps = pass.renderFetch + pass.client.fetch + pass.nfCalls;
  const cmsPurgeRps =
    pass.global.purgeFetch + pass.list.purgeFetch + pass.page.purgeFetch;
  const cmsHit = cmsCallsRps > 0 ? Math.max(0, 1 - cmsFetchRps / cmsCallsRps) : 1;
  const cmsOther = cms.otherOrgTrafficRps;
  const cmsOffered = cmsFetchRps + cmsOther;
  const cmsLim = cms.api === 'graphql' ? cms.graphql : cms.cda;
  const cmsLimit = cmsLim.limitRps;

  // ---- Compute ----
  const serviceSec = svc.serviceMs / 1000;
  const inFlight = renderRps * serviceSec;
  const slots = comp.maxInstances * comp.concurrencyPerInstance;
  const instancesNeeded = Math.ceil(inFlight / comp.concurrencyPerInstance - 1e-9);
  const computeUtil = slots > 0 ? inFlight / slots : 0;
  const c = Math.min(slots, 10000);
  const pWait = computeUtil >= 1 ? 1 : erlangC(inFlight * (c / slots), c);

  // ---- 429 risk ----
  const k = typeof sim.burstiness === 'number' && sim.burstiness > 0 ? sim.burstiness : null;
  const pLaunch = countTail(launchOffered, launchLimit, k);
  let cmsThreshold = cmsLimit;
  if (cmsLim.algorithm === 'gcra') {
    cmsThreshold = cmsLimit * (cmsLim.burstMultiplierPct / 100) + (cmsLimit * cmsLim.maxWaitMs) / 1000;
  }
  const pCms = countTail(cmsOffered, cmsThreshold, k);
  const suggested = Math.max(1, Math.ceil(smallestLimit(cmsOffered, 1 / 3600, k) * 1.2));

  // ---- Bottleneck ----
  const util = (x: number, lim: number) => (lim > 0 ? x / lim : x > 0 ? Infinity : 0);
  const launchUtil = util(launchOffered, launchLimit);
  const cmsUtil = util(cmsOffered, cmsLimit);
  let bottleneck: SummaryKpis['bottleneck'] = 'none';
  if (launchUtil >= 1) bottleneck = 'launchOrigin';
  else if (computeUtil >= 1) bottleneck = 'compute';
  else if (serviceSec > comp.timeoutSec) bottleneck = 'timeout';
  else if (cmsUtil >= 1) bottleneck = 'cmsOrigin';
  else if (3600 * pLaunch > 1 || 3600 * pCms > 1) {
    bottleneck = 3600 * pCms >= 3600 * pLaunch ? 'cmsOrigin' : 'launchOrigin';
  }

  const kpis: SteadyStateKpis = {
    edgeRps,
    launchHitRatio,
    launchOriginRps: launchOffered,
    launchLimitRps: launchLimit,
    launchUtilPct: launchUtil * 100,
    renderRps,
    serviceMs: svc.serviceMs,
    inFlight,
    instancesNeeded,
    computeUtilPct: computeUtil * 100,
    erlangCWait: pWait,
    cmsCallsRps,
    cmsCallsPerPageView: V > 0 ? cmsCallsRps / V : 0,
    cmsCdnHitRatio: cmsHit,
    cmsOriginRps: cmsOffered,
    cmsLimitRps: cmsLimit,
    cmsUtilPct: cmsUtil * 100,
    pLaunch429Second: pLaunch,
    pCms429Second: pCms,
    expectedCms429SecondsPerHour: 3600 * pCms,
    expectedLaunch429SecondsPerHour: 3600 * pLaunch,
    suggestedCmsLimitRps: suggested,
    projectedMonthlyApiCalls: {
      cached: Math.max(0, cmsCallsRps - cmsFetchRps) * SECONDS_PER_MONTH,
      uncached: cmsFetchRps * SECONDS_PER_MONTH,
    },
    bottleneck,
    origin404Rps: notFound,
    originBotUniqueRps: botUnique,
    originPageRps: originPage,
    originDataRps: originData,
    cmsPurgeOriginRps: cmsPurgeRps,
    cmsNotFoundOriginRps: pass.nfCalls,
    cmsOtherOrgRps: cmsOther,
    cmsGlobalHitRatio: pass.global.calls > 0 ? Math.max(0, 1 - pass.global.fetch / pass.global.calls) : 1,
    primeTopPaths: topKeysShare(pageBins, 0.8),
    pageViewsRps: V,
  };

  const hops: Hop[] = [
    {
      id: 'edge',
      label: 'Visitors / edge',
      rps: edgeRps,
      note: `${fmt(V)} page views/s from humans, ${fmt(botRate)} bot req/s`,
    },
    {
      id: 'launchCdn',
      label: 'Launch CDN',
      rps: cdnRequests,
      hitRatio: launchHitRatio,
      note: `${fmt(staticRps)} static req/s are always hits`,
    },
    {
      id: 'launchOrigin',
      label: 'Launch origin',
      rps: launchOffered,
      limit: launchLimit,
      utilPct: kpis.launchUtilPct,
      note: `page ${fmt(originPage)}, data ${fmt(originData)}, bot-unique ${fmt(botUnique)}, 404 ${fmt(notFound)} req/s`,
    },
    {
      id: 'compute',
      label: 'Launch compute',
      rps: renderRps,
      limit: slots,
      utilPct: kpis.computeUtilPct,
      note: `${fmt(inFlight)} in flight, ${instancesNeeded} instances, ${fmt(svc.serviceMs)} ms per render`,
    },
    {
      id: 'cmsCdn',
      label: 'CMS CDN',
      rps: cmsCallsRps,
      hitRatio: cmsHit,
      note: `${fmt(kpis.cmsCallsPerPageView)} calls per page view`,
    },
    {
      id: 'cmsOrigin',
      label: cms.api === 'graphql' ? 'CMS origin (GraphQL)' : 'CMS origin (CDA)',
      rps: cmsOffered,
      limit: cmsLimit,
      utilPct: kpis.cmsUtilPct,
      note: `${fmt(cmsOther)} req/s from other org traffic; purge-driven ${fmt(cmsPurgeRps)} req/s`,
    },
  ];

  return { hops, kpis };
}

function sum(a: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]!;
  return s;
}

function fmt(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  if (Math.abs(x) >= 100) return String(Math.round(x));
  if (Math.abs(x) >= 10) return x.toFixed(1);
  return x.toFixed(2);
}

/** Legacy shape: the timeline SummaryKpis fields that the analytic model can fill. */
export function steadyState(scenario: Scenario): SummaryKpis {
  const { kpis: k } = computeSteadyState(scenario);
  return {
    peakLaunchOriginRps: k.launchOriginRps,
    peakLaunchOriginPctOfLimit: k.launchUtilPct,
    secondsOverLaunchLimit: k.expectedLaunch429SecondsPerHour / 3600,
    peakCmsOriginOfferedRps: k.cmsOriginRps,
    peakCmsOriginPctOfLimit: k.cmsUtilPct,
    secondsWithCms429: k.expectedCms429SecondsPerHour / 3600,
    totalLaunch429: 0,
    totalCms429: 0,
    total504: 0,
    total503: 0,
    errorPagesServed: 0,
    visitorErrorRate: 0,
    worstSecondVisitorP95Ms: 0,
    cmsCallsPerPageView: k.cmsCallsPerPageView,
    suggestedCmsLimitRps: k.suggestedCmsLimitRps,
    projectedMonthlyApiCalls: k.projectedMonthlyApiCalls,
    bottleneck: k.bottleneck,
  };
}
