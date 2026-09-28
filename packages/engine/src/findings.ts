import type { Scenario, ScenarioEvent, ScenarioInput } from './schema';
import type {
  Finding,
  FindingSeverity,
  ScenarioPatch,
  SimulationResult,
  SummaryKpis,
} from './model/types';
import { resolveFramework } from './params/frameworks';
import { setByPath } from './params/registry';
import {
  computeSteadyState,
  type SteadyStateKpis,
  type SteadyStateResult,
} from './analytic/steadyState';

/**
 * Rule-based diagnostics and recommendations (DESIGN 6.10).
 *
 * Every rule uses the analytic steady-state numbers and, when a timeline result is passed, the
 * measured numbers too (missing series columns are tolerated). Each suggestion is a ScenarioPatch
 * of dot-path `set` values that keeps the scenario valid for ScenarioSchema. Patches never use
 * array indexes; to change events a rule sets the whole `events` array.
 */

/** A Finding plus the id of the rule that produced it (stable, for the UI and tests). */
export interface RuleFinding extends Finding {
  id: string;
}

interface SimMarker {
  timeSec: number;
  kind: string;
  label?: string;
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** Apply a patch to a scenario input (dot-path sets, then appended events). */
export function applyPatch<T extends ScenarioInput>(scenario: T, patch: ScenarioPatch): T {
  let out: ScenarioInput = scenario;
  for (const [path, value] of Object.entries(patch.set)) out = setByPath(out, path, value);
  if (patch.addEvents?.length) {
    out = { ...out, events: [...(out.events ?? []), ...patch.addEvents] };
  }
  return out as T;
}

/** Legacy entry point: findings from the analytic model plus a timeline summary (unused). */
export function analyzeFindings(scenario: Scenario, _summary?: SummaryKpis): Finding[] {
  return generateFindings(scenario, computeSteadyState(scenario));
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const f0 = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : String(x));
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : String(x));
const pct = (x: number) => `${f0(x)}%`;
const rps = (x: number) => (x >= 100 ? `${f0(x)} req/s` : x >= 10 ? `${f1(x)} req/s` : `${x.toFixed(2)} req/s`);

function column(sim: SimulationResult | undefined, name: string): Float32Array | undefined {
  const c = sim?.series?.columns?.[name];
  return c && c.length > 0 ? c : undefined;
}

function sumOf(c: Float32Array | undefined): number {
  if (!c) return 0;
  let s = 0;
  for (let i = 0; i < c.length; i++) s += c[i]!;
  return s;
}

function maxOf(c: Float32Array | undefined): number {
  if (!c) return 0;
  let m = 0;
  for (let i = 0; i < c.length; i++) if (c[i]! > m) m = c[i]!;
  return m;
}

function markers(sim: SimulationResult | undefined): SimMarker[] {
  const m = (sim as unknown as { markers?: SimMarker[] } | undefined)?.markers;
  return Array.isArray(m) ? m : [];
}

/** Times (s) of events of the given kinds: timeline markers when present, else scenario events. */
function eventTimes(sc: Scenario, sim: SimulationResult | undefined, kinds: string[]): number[] {
  const fromMarkers = markers(sim)
    .filter((m) => kinds.includes(m.kind))
    .map((m) => m.timeSec);
  if (fromMarkers.length > 0) return fromMarkers;
  return sc.events.filter((e) => kinds.includes(e.kind)).map((e) => e.atSec);
}

interface WindowStats {
  inTotal: number;
  outTotal: number;
  inSeconds: number;
  outSeconds: number;
}

/** Sum a per-second column inside vs outside windows [t, t + lenSec) after each time. */
function windowStats(c: Float32Array, times: number[], lenSec: number): WindowStats {
  const mask = new Uint8Array(c.length);
  for (const t of times) {
    const a = Math.max(0, Math.floor(t));
    const b = Math.min(c.length, Math.ceil(t + lenSec));
    for (let i = a; i < b; i++) mask[i] = 1;
  }
  const s: WindowStats = { inTotal: 0, outTotal: 0, inSeconds: 0, outSeconds: 0 };
  for (let i = 0; i < c.length; i++) {
    if (mask[i]) {
      s.inTotal += c[i]!;
      s.inSeconds++;
    } else {
      s.outTotal += c[i]!;
      s.outSeconds++;
    }
  }
  return s;
}

const cmsLimitPath = (sc: Scenario) => (sc.cms.api === 'graphql' ? 'cms.graphql' : 'cms.cda');

function gcraPatch(sc: Scenario): Record<string, unknown> {
  const p = cmsLimitPath(sc);
  return {
    [`${p}.algorithm`]: 'gcra',
    [`${p}.burstMultiplierPct`]: 200,
    [`${p}.maxWaitMs`]: 3000,
  };
}

function hopRps(steady: SteadyStateResult, id: string): number {
  return steady.hops.find((h) => h.id === id)?.rps ?? 0;
}

interface Ctx {
  sc: Scenario;
  st: SteadyStateKpis;
  steady: SteadyStateResult;
  sim?: SimulationResult;
  fw: ReturnType<typeof resolveFramework>;
  cms429Total: number;
  launch429Total: number;
  out: RuleFinding[];
  fired: Set<string>;
}

function add(ctx: Ctx, f: RuleFinding): void {
  ctx.out.push(f);
  ctx.fired.add(f.id);
}

/** Evidence that the CMS limiter rejects requests: timeline totals or the analytic tail. */
function cms429Evidence(ctx: Ctx): boolean {
  return ctx.cms429Total > 0 || ctx.st.expectedCms429SecondsPerHour >= 1 || ctx.st.cmsUtilPct >= 100;
}

function launch429Evidence(ctx: Ctx): boolean {
  return (
    ctx.launch429Total > 0 || ctx.st.expectedLaunch429SecondsPerHour >= 1 || ctx.st.launchUtilPct >= 100
  );
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

function ruleUncacheablePages(ctx: Ctx): void {
  const { sc, st, fw } = ctx;
  const pol = sc.site.cacheHeaders.page;
  if (pol.cacheable && pol.sMaxAgeSec > 0) return;
  if (!fw.runtimeCms && fw.renderMode === 'static') return;
  const bad = launch429Evidence(ctx) || cms429Evidence(ctx);
  const why = !pol.cacheable ? 'the page response is not cacheable' : 's-maxage is 0';
  add(ctx, {
    id: 'uncacheable-pages',
    severity: bad ? 'critical' : 'warning',
    title: 'Pages are not cached by the Launch CDN',
    detail:
      `Because ${why}, every page view is an origin render: the Launch hit ratio is ${pct(st.launchHitRatio * 100)}, ` +
      `origin load is ${rps(st.launchOriginRps)} against a ${f0(st.launchLimitRps)} req/s limit (${pct(st.launchUtilPct)}) ` +
      `and each render makes about ${f1(ctx.fw.globalCalls + ctx.fw.pageCalls + ctx.fw.listCalls + ctx.fw.n1Calls)} CMS calls.`,
    suggestion: {
      set: {
        'site.cacheHeaders.page.cacheable': true,
        'site.cacheHeaders.page.sMaxAgeSec': 300,
        'site.cacheHeaders.page.swrSec': 600,
      },
    },
  });
}

function ruleDataAmplification(ctx: Ctx): void {
  const { st, sc } = ctx;
  const offered = st.launchOriginRps;
  if (st.originDataRps < 10 || offered <= 0) return;
  const share = st.originDataRps / offered;
  if (share < 0.3) return;
  const bad = launch429Evidence(ctx);
  add(ctx, {
    id: 'data-request-amplification',
    severity: bad ? 'critical' : st.launchUtilPct > 70 ? 'warning' : 'info',
    title: 'Prefetch and client-navigation data requests dominate origin load',
    detail:
      `Uncached data/RSC requests (${sc.site.frameworkOverrides.prefetchPerView ?? ctx.fw.prefetchPerView} prefetches per view, ` +
      `${pct((sc.site.frameworkOverrides.clientNavFraction ?? ctx.fw.clientNavFraction) * 100)} client navigations) ` +
      `reach the origin at ${rps(st.originDataRps)}, ${pct(share * 100)} of all origin traffic. ` +
      `Origin load is ${pct(st.launchUtilPct)} of the limit.`,
    suggestion: { set: { 'site.frameworkOverrides.prefetchPerView': 0 } },
  });
}

function publishEvents(sc: Scenario): Extract<ScenarioEvent, { kind: 'publish' }>[] {
  return sc.events.filter((e): e is Extract<ScenarioEvent, { kind: 'publish' }> => e.kind === 'publish');
}

function ruleCms429AfterPublish(ctx: Ctx): void {
  const { sc, st, sim } = ctx;
  const pubs = publishEvents(sc);
  const cms429 = column(sim, 'cms429');
  let measured = '';
  let fired = false;
  let critical = false;

  if (cms429 && sim) {
    const times = eventTimes(sc, sim, ['publish']);
    if (times.length > 0) {
      const w = windowStats(cms429, times, 60);
      const total = w.inTotal + w.outTotal;
      const inMean = w.inSeconds > 0 ? w.inTotal / w.inSeconds : 0;
      const outMean = w.outSeconds > 0 ? w.outTotal / w.outSeconds : 0;
      if (w.inTotal > 0 && inMean >= 3 * outMean) {
        fired = true;
        critical = true;
        measured =
          `${pct((w.inTotal / total) * 100)} of the ${f0(total)} CMS 429s fall in the 60 s after ` +
          `${times.length} publish event(s): ${inMean.toFixed(1)} per second there versus ${outMean.toFixed(2)} elsewhere.`;
      }
    }
  }

  // Steady state: purge-driven misses use a large share of an already busy budget.
  if (!fired && st.cmsPurgeOriginRps >= 0.3 * st.cmsOriginRps && st.cmsUtilPct >= 70 && st.cmsPurgeOriginRps > 0) {
    fired = true;
    critical = st.cmsUtilPct >= 100 || st.expectedCms429SecondsPerHour >= 1;
    measured =
      `Steady-state purge-driven misses add ${rps(st.cmsPurgeOriginRps)} to the CMS origin ` +
      `(${pct(st.cmsUtilPct)} of the ${f0(st.cmsLimitRps)} req/s limit).`;
  }

  // Event estimate: a publish that purges more keys than one second of budget.
  if (!fired) {
    for (const p of pubs) {
      const lf = p.locales === 'all' ? sc.site.locales : Math.min(p.locales, sc.site.locales);
      const purgedKeys =
        (p.purge.pageQueries ? p.entries * lf : 0) +
        p.purge.referencingFraction * sc.site.pages * sc.site.locales +
        (p.purge.globals ? sc.site.globalKeys * sc.site.locales : 0);
      const window = Math.max(1, p.spreadSec);
      if (purgedKeys / window >= 2 * st.cmsLimitRps) {
        fired = true;
        measured =
          `A publish of ${f0(p.entries)} entries at ${f0(p.atSec)} s purges about ${f0(purgedKeys)} CMS CDN keys ` +
          `over ${f0(window)} s, roughly ${rps(purgedKeys / window)} of potential refill against a ${f0(st.cmsLimitRps)} req/s limit. ` +
          'Run the timeline to see the actual burst.';
        break;
      }
    }
  }
  if (!fired) return;

  const set: Record<string, unknown> = { ...gcraPatch(sc) };
  if (pubs.length > 0) {
    set.events = sc.events.map((e) =>
      e.kind !== 'publish'
        ? e
        : {
            ...e,
            spreadSec: Math.max(e.spreadSec, Math.min(900, Math.ceil(e.entries / 5))),
            purge: { ...e.purge, globals: false, referencingFraction: Math.min(e.purge.referencingFraction, 0.1) },
            onPublish: e.onPublish === 'redeploy' ? 'revalidateTags' : e.onPublish,
          },
    );
  } else {
    set['steady.purge.globals'] = false;
    set['steady.purge.referencingFraction'] = 0;
  }
  add(ctx, {
    id: 'cms-429-after-publish',
    severity: critical ? 'critical' : 'warning',
    title: 'Publishing purges enough CMS cache to burst the origin limit',
    detail: `${measured} Stagger the publish, narrow the purge scope, prefer tag-based revalidation, prime the cache, or enable a burst-aware (GCRA) limiter.`,
    suggestion: { set },
  });
}

function ruleDeployAtPeak(ctx: Ctx): void {
  const { sc, st, sim, steady } = ctx;
  const deploys = sc.events.filter(
    (e): e is Extract<ScenarioEvent, { kind: 'deploy' }> => e.kind === 'deploy',
  );
  const goLives = sc.events.filter((e) => e.kind === 'goLive');
  const redeploys = publishEvents(sc).filter((p) => p.onPublish === 'redeploy');
  if (deploys.length + goLives.length + redeploys.length === 0) return;

  let measured = '';
  let critical = false;
  let fire = false;

  const c429 = column(sim, 'cms429');
  const l429 = column(sim, 'launch429');
  if (sim && (c429 || l429)) {
    const times = eventTimes(sc, sim, ['deploy', 'goLive', 'publish'])
      .concat(deploys.map((d) => d.atSec + d.buildSec))
      .filter((t) => t >= 0);
    let inC = 0;
    let inL = 0;
    if (c429) inC = windowStats(c429, times, 300).inTotal;
    if (l429) inL = windowStats(l429, times, 300).inTotal;
    if (inC + inL > 0) {
      fire = true;
      critical = true;
      measured = `In the 5 minutes after cold-cache events the timeline shows ${f0(inC)} CMS 429s and ${f0(inL)} Launch 429s.`;
    }
  }
  if (!fire) {
    // Cold caches start near a 60% hit ratio (RESEARCH section 5): about 40% of CDN traffic misses.
    const cdn = hopRps(steady, 'launchCdn');
    const cold = 0.4 * cdn;
    if (cold >= 0.5 * st.launchLimitRps) {
      fire = true;
      critical = cold >= st.launchLimitRps;
      measured = `A cold cache sends roughly ${rps(cold)} to the Launch origin (${pct((cold / st.launchLimitRps) * 100)} of the ${f0(st.launchLimitRps)} req/s limit) at ${rps(cdn)} of traffic.`;
    }
  }
  if (!fire) return;

  const paths = Math.max(1, Math.min(5000, st.primeTopPaths));
  const primeRps = Math.max(1, Math.floor(0.5 * st.launchLimitRps));
  const suggestion: ScenarioPatch | undefined =
    deploys.length > 0
      ? {
          set: {
            events: sc.events.map((e) =>
              e.kind === 'deploy' && e.priming.paths === 0
                ? { ...e, priming: { paths: paths, rps: primeRps } }
                : e,
            ),
          },
        }
      : undefined;
  add(ctx, {
    id: 'deploy-at-peak',
    severity: critical ? 'critical' : 'warning',
    title: 'Deploy or go-live at peak starts with cold caches',
    detail: `${measured} Deploy off-peak and prime the top ${f0(paths)} paths (they cover 80% of page traffic) before switching traffic.`,
    suggestion,
  });
}

function ruleRetry(ctx: Ctx): void {
  const { sc, st } = ctx;
  const kind = sc.sdk.retry.kind;
  if (kind !== 'fixed' && kind !== 'sdkDefault') return;
  if (!cms429Evidence(ctx)) return;
  const evidence =
    ctx.cms429Total > 0
      ? `${f0(ctx.cms429Total)} CMS 429s in the timeline`
      : `${f1(st.expectedCms429SecondsPerHour)} expected seconds per hour with 429s`;
  add(ctx, {
    id: 'retry-without-jitter',
    severity: 'warning',
    title: 'Fixed-delay retries synchronize into pulses',
    detail: `The SDK retries with a ${kind === 'sdkDefault' ? 'fixed 300 ms to 1 s' : 'fixed'} delay and no jitter while the CMS returns 429s (${evidence}). Clients that were rejected together retry together and hit the same one-second window again.`,
    suggestion: {
      set: {
        'sdk.retry.kind': 'exponentialJitter',
        'sdk.retry.baseDelayMs': 200,
        'sdk.retry.capDelayMs': 5000,
      },
    },
  });
}

function ruleGlobalCalls(ctx: Ctx): void {
  const { fw, st } = ctx;
  if (fw.globalCalls < 3) return;
  const low = Math.min(st.cmsCdnHitRatio, st.cmsGlobalHitRatio);
  if (low >= 0.9) return;
  add(ctx, {
    id: 'global-calls-uncached',
    severity: st.cmsUtilPct > 70 ? 'warning' : 'info',
    title: 'Several global CMS calls per render with a low CMS hit ratio',
    detail: `Each render makes ${f0(fw.globalCalls)} global calls (header, footer, navigation) and the CMS CDN hit ratio is ${pct(low * 100)}. Combine them into one query or cache them.`,
    suggestion: { set: { 'site.frameworkOverrides.globalCalls': 1 } },
  });
}

function ruleBotOrigin(ctx: Ctx): void {
  const { sc, st } = ctx;
  const base = st.originBotUniqueRps + st.origin404Rps;
  const offered = st.launchOriginRps;
  let bestShare = offered > 0 ? base / offered : 0;
  let botRps = base;
  let total = offered;
  let source = 'steady traffic';
  for (const e of sc.events) {
    if (e.kind !== 'crawler') continue;
    const extra = e.rps * (e.randomQueryFraction + e.notFoundFraction);
    const share = (base + extra) / Math.max(1e-9, offered + extra);
    if (share > bestShare) {
      bestShare = share;
      botRps = base + extra;
      total = offered + extra;
      source = `the crawler event at ${f0(e.atSec)} s`;
    }
  }
  if (bestShare <= 0.2 || botRps < 1) return;
  const bad = launch429Evidence(ctx) || total >= st.launchLimitRps;
  const set: Record<string, unknown> = {
    'traffic.bots.randomQueryFraction': Math.min(sc.traffic.bots.randomQueryFraction, 0.05),
    'traffic.bots.notFoundFraction': Math.min(sc.traffic.bots.notFoundFraction, 0.01),
    'site.cmsCallsPerNotFound': 0,
  };
  if (sc.events.some((e) => e.kind === 'crawler')) {
    set.events = sc.events.map((e) =>
      e.kind === 'crawler'
        ? {
            ...e,
            randomQueryFraction: Math.min(e.randomQueryFraction, 0.1),
            notFoundFraction: Math.min(e.notFoundFraction, 0.02),
          }
        : e,
    );
  }
  add(ctx, {
    id: 'bot-unique-origin-load',
    severity: bad ? 'critical' : 'warning',
    title: 'Random-query and 404 bot traffic drives origin load',
    detail: `Uncacheable bot requests (random query strings and unknown URLs) are ${rps(botRps)}, ${pct(bestShare * 100)} of the Launch origin load during ${source}. Add WAF or bot rules and avoid CMS lookups for unknown slugs.`,
    suggestion: { set },
  });
}

function ruleErrorCache(ctx: Ctx): void {
  const { sc } = ctx;
  if (sc.sdk.onFinalFailure !== 'render404') return;
  if (!(sc.launch.externalCdn.enabled && sc.launch.externalCdn.cachesErrors)) return;
  const bad = cms429Evidence(ctx);
  add(ctx, {
    id: 'cached-429-as-404',
    severity: bad ? 'critical' : 'warning',
    title: 'A CMS 429 can be rendered as a 404 and cached by your CDN',
    detail: `Failed CMS calls render a 404 and the external CDN caches errors for ${f0(sc.launch.externalCdn.errorTtlSec)} s, so a burst of a few seconds becomes minutes of "not found". Do not cache 404s produced by 429s: return a 503 with Retry-After instead.`,
    suggestion: {
      set: { 'sdk.onFinalFailure': 'error500', 'launch.externalCdn.cachesErrors': false },
    },
  });
}

function ruleCompute(ctx: Ctx): void {
  const { sc, st, sim, fw } = ctx;
  const comp = sc.launch.compute;
  const errors504 = sim?.summary?.total504 ?? 0;
  const errors503 = sim?.summary?.total503 ?? 0;
  const queueMax = maxOf(column(sim, 'queue'));
  const timeline = errors504 + errors503 > 0 || queueMax > 5 * comp.concurrencyPerInstance;
  const slow = st.serviceMs / 1000 > 0.5 * comp.timeoutSec;
  const saturated = st.computeUtilPct >= 100 || st.erlangCWait >= 0.5;
  const busy = st.computeUtilPct >= 70;
  if (!timeline && !slow && !saturated && !busy) return;
  const critical = timeline || saturated || st.serviceMs / 1000 > comp.timeoutSec;
  const parts: string[] = [];
  if (sim && timeline) {
    parts.push(`${f0(errors504)} timeouts (504), ${f0(errors503)} shed requests (503) and a peak queue of ${f0(queueMax)}`);
  }
  parts.push(
    `steady state needs ${f0(st.inFlight)} concurrent renders (${f0(st.instancesNeeded)} instances) at ${f0(st.serviceMs)} ms per render, ${pct(st.computeUtilPct)} of capacity`,
  );
  const set: Record<string, unknown> = {
    'launch.compute.maxInstances': Math.max(comp.maxInstances, Math.ceil(st.instancesNeeded / 0.6)),
  };
  if (comp.machine === 'L1') set['launch.compute.machine'] = 'L2';
  else if (comp.machine === 'L2') set['launch.compute.machine'] = 'L3';
  if (fw.sequentialWaves > 1) set['site.frameworkOverrides.sequentialWaves'] = 1;
  add(ctx, {
    id: 'compute-saturation',
    severity: critical ? 'critical' : 'warning',
    title: 'Launch compute is saturated or queueing',
    detail: `${parts.join('; ')}. Raise the machine tier or instance cap, cut sequential waves, or parallelize the CMS calls.`,
    suggestion: { set },
  });
}

function ruleRevalidation(ctx: Ctx): void {
  const { sc, sim } = ctx;
  const quota = sc.launch.revalidation.dailyQuota;
  let used = 0;
  for (const p of publishEvents(sc)) {
    if (p.onPublish === 'revalidatePaths') used += p.entries;
    else if (p.onPublish === 'revalidateTags') used += 1;
  }
  const measured = sumOf(column(sim, 'revalidations'));
  used = Math.max(used, measured);
  if (used <= 0.7 * quota) return;
  add(ctx, {
    id: 'revalidation-quota',
    severity: used > quota ? 'critical' : 'warning',
    title: 'On-demand revalidations approach or exceed the daily quota',
    detail: `The scenario makes about ${f0(used)} revalidation calls against a daily quota of ${f0(quota)} (${pct((used / quota) * 100)}). Use tag-based or prefix revalidation instead of one call per path.`,
    suggestion: {
      set: {
        events: sc.events.map((e) =>
          e.kind === 'publish' && e.onPublish === 'revalidatePaths'
            ? { ...e, onPublish: 'revalidateTags' }
            : e,
        ),
      },
    },
  });
}

function ruleOtherOrg(ctx: Ctx): void {
  const { sc, st } = ctx;
  const base = sc.cms.otherOrgTrafficRps;
  const eventRps = sc.events.reduce((s, e) => s + (e.kind === 'otherTraffic' ? e.rps : 0), 0);
  const other = base + eventRps;
  const limit = st.cmsLimitRps;
  if (limit <= 0 || other <= 0.3 * limit) return;
  const total = st.cmsOriginRps + eventRps;
  const critical = total >= limit || ctx.cms429Total > 0;
  const set: Record<string, unknown> = {};
  if (base > 0) set['cms.otherOrgTrafficRps'] = 0;
  if (eventRps > 0) set.events = sc.events.filter((e) => e.kind !== 'otherTraffic');
  add(ctx, {
    id: 'other-org-traffic',
    severity: critical ? 'critical' : 'warning',
    title: 'Other traffic in the organization uses the CMS rate-limit budget',
    detail: `Staging jobs, builds and other stacks add ${rps(other)}, ${pct((other / limit) * 100)} of the ${f0(limit)} req/s per-organization limit; with production misses the CMS origin peaks at ${rps(total)}. Move them to a separate org or schedule them off-peak.`,
    suggestion: { set },
  });
}

function ruleLaunchLimit(ctx: Ctx): void {
  const { st, sim } = ctx;
  if (ctx.fired.has('uncacheable-pages')) return;
  const simPeak = sim?.summary?.peakLaunchOriginRps ?? 0;
  const offered = Math.max(st.launchOriginRps, simPeak);
  const util = st.launchLimitRps > 0 ? (offered / st.launchLimitRps) * 100 : 0;
  const bad = launch429Evidence(ctx);
  if (util <= 70 && !bad) return;
  const evidence =
    ctx.launch429Total > 0
      ? ` The timeline returned ${f0(ctx.launch429Total)} Launch 429s.`
      : '';
  add(ctx, {
    id: 'launch-origin-limit',
    severity: bad ? 'critical' : 'warning',
    title: bad ? 'Launch origin limit is exceeded' : 'Launch origin is close to its rate limit',
    detail: `Origin load ${rps(offered)} is ${pct(util)} of the ${f0(st.launchLimitRps)} req/s limit.${evidence} Raise the cache hit ratio (longer s-maxage, SWR) or request a higher limit.`,
    suggestion: { set: { 'launch.originLimitRps': Math.ceil(offered * 1.2) } },
  });
}

function ruleCmsLimit(ctx: Ctx): void {
  const { sc, st, sim } = ctx;
  const simPeak = sim?.summary?.peakCmsOriginOfferedRps ?? 0;
  const offered = Math.max(st.cmsOriginRps, simPeak);
  const suggested = Math.max(
    st.suggestedCmsLimitRps,
    sim?.summary?.suggestedCmsLimitRps ?? 0,
    Math.ceil(simPeak * 1.2),
  );
  const util = st.cmsLimitRps > 0 ? (offered / st.cmsLimitRps) * 100 : 0;
  const bad = cms429Evidence(ctx);
  if (util <= 70 && !bad) return;
  const evidence =
    ctx.cms429Total > 0 ? ` The timeline returned ${f0(ctx.cms429Total)} CMS 429s.` : '';
  add(ctx, {
    id: 'cms-origin-limit',
    severity: bad ? 'critical' : 'warning',
    title: bad ? 'CMS origin limit is exceeded' : 'CMS origin is close to its rate limit',
    detail: `CMS origin load ${rps(offered)} is ${pct(util)} of the ${f0(st.cmsLimitRps)} req/s limit; ${f1(st.expectedCms429SecondsPerHour)} seconds per hour are expected to exceed it.${evidence} Request a limit of about ${f0(suggested)} req/s (the smallest with at most one bad second per hour, plus 20% headroom) or reduce misses.`,
    suggestion: { set: { [`${cmsLimitPath(sc)}.limitRps`]: suggested } },
  });
}

// ---------------------------------------------------------------------------------------------

/**
 * Diagnostics for a scenario. `steady` is the analytic result; `sim` (optional) adds measured
 * timeline numbers. Sorted by severity (critical first), then by rule order.
 */
export function generateFindings(
  scenario: Scenario,
  steady: SteadyStateResult,
  sim?: SimulationResult,
): RuleFinding[] {
  const ctx: Ctx = {
    sc: scenario,
    st: steady.kpis,
    steady,
    sim,
    fw: resolveFramework(scenario),
    cms429Total: Math.max(sumOf(column(sim, 'cms429')), sim?.summary?.totalCms429 ?? 0),
    launch429Total: Math.max(sumOf(column(sim, 'launch429')), sim?.summary?.totalLaunch429 ?? 0),
    out: [],
    fired: new Set(),
  };
  ruleUncacheablePages(ctx);
  ruleDataAmplification(ctx);
  ruleCms429AfterPublish(ctx);
  ruleDeployAtPeak(ctx);
  ruleRetry(ctx);
  ruleGlobalCalls(ctx);
  ruleBotOrigin(ctx);
  ruleErrorCache(ctx);
  ruleCompute(ctx);
  ruleRevalidation(ctx);
  ruleOtherOrg(ctx);
  ruleLaunchLimit(ctx);
  ruleCmsLimit(ctx);

  if (ctx.out.length === 0) {
    ctx.out.push({
      id: 'healthy',
      severity: 'info',
      title: 'No limit risks found',
      detail: `Launch origin runs at ${pct(ctx.st.launchUtilPct)} and the CMS origin at ${pct(ctx.st.cmsUtilPct)} of their limits, with a Launch hit ratio of ${pct(ctx.st.launchHitRatio * 100)}.`,
    });
  }
  return ctx.out
    .map((f, i) => ({ f, i }))
    .sort((a, b) => SEVERITY_ORDER[a.f.severity] - SEVERITY_ORDER[b.f.severity] || a.i - b.i)
    .map((x) => x.f);
}
