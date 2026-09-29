import type { Scenario, ScenarioEvent } from '../schema';
import type { EventEffects, IEventTimeline, TickContext } from './types';

type Layer = 'launch' | 'cmsPage' | 'cmsList' | 'cmsGlobal';
const LAYERS: Layer[] = ['launch', 'cmsPage', 'cmsList', 'cmsGlobal'];
const LAYER_IDX: Record<Layer, number> = { launch: 0, cmsPage: 1, cmsList: 2, cmsGlobal: 3 };

/** Assumed build time of a Launch redeploy triggered by a publish with onPublish 'redeploy'. */
export const REDEPLOY_ON_PUBLISH_BUILD_SEC = 60;

type Spike = Extract<ScenarioEvent, { kind: 'spike' }>;
type Crawler = Extract<ScenarioEvent, { kind: 'crawler' }>;
type LoadTest = Extract<ScenarioEvent, { kind: 'loadTest' }>;
type Other = Extract<ScenarioEvent, { kind: 'otherTraffic' }>;
type Publish = Extract<ScenarioEvent, { kind: 'publish' }>;

/** Priming window of one deploy: [startSec, endSec = cutover). `paths` = keys primed by cutover. */
interface Priming {
  startSec: number;
  endSec: number;
  rps: number;
  paths: number;
}

function spikeMultiplier(e: Spike, t: number): number {
  const start = e.atSec;
  const end = e.atSec + e.durationSec;
  if (t < start || t >= end) return 1;
  // Ramp cannot exceed half the duration (up and down must both fit).
  const ramp = Math.min(e.rampSec, e.durationSec / 2);
  let f = 1;
  if (ramp > 0) {
    if (t < start + ramp) f = (t - start) / ramp;
    else if (t > end - ramp) f = (end - t) / ramp;
  }
  return 1 + (e.multiplier - 1) * f;
}

/**
 * Event timeline to per-tick effects (DESIGN 6.7 step 1).
 *
 * Instant effects (goLive, deploy completion, publish first tick) fire on the single tick whose
 * window [t, t + dt) contains the event time. Continuous events are evaluated at the tick start.
 * Everything that is small (event lists) is precomputed; `effectsAt` loops over a handful of items.
 */
export class EventTimeline implements IEventTimeline {
  private readonly spikes: Spike[] = [];
  private readonly crawlers: Crawler[] = [];
  private readonly loadTests: LoadTest[] = [];
  private readonly others: Other[] = [];
  private readonly publishes: Publish[] = [];
  /** goLive: cold reset + purge all. */
  private readonly goLives: number[] = [];
  /** Instants that cold-reset and purge launch (deploy completion, redeploy-on-publish). */
  private readonly deployCompletions: number[] = [];
  private readonly primings: Priming[] = [];
  /** Keys warm in the Launch page cache at the cutover instant (priming of the new deployment). */
  private readonly primeAtCutover: { at: number; keys: number }[] = [];
  private readonly site: Scenario['site'];
  private readonly cms: Scenario['cms'];
  private readonly pagesTotalKeys: number;
  private readonly hasEvents: boolean;

  constructor(scenario: Scenario) {
    this.site = scenario.site;
    this.cms = scenario.cms;
    this.pagesTotalKeys = Math.max(1, scenario.site.pages * scenario.site.locales);
    for (const e of scenario.events) {
      switch (e.kind) {
        case 'spike':
          this.spikes.push(e);
          break;
        case 'crawler':
          this.crawlers.push(e);
          break;
        case 'loadTest':
          this.loadTests.push(e);
          break;
        case 'otherTraffic':
          this.others.push(e);
          break;
        case 'publish':
          this.publishes.push(e);
          if (e.onPublish === 'redeploy') {
            this.deployCompletions.push(e.atSec + e.spreadSec + REDEPLOY_ON_PUBLISH_BUILD_SEC);
          }
          break;
        case 'goLive':
          this.goLives.push(e.atSec);
          break;
        case 'deploy': {
          const done = e.atSec + e.buildSec;
          this.deployCompletions.push(done);
          // Launch primes the listed URLs before the new deployment receives traffic: the window
          // ends at cutover. If paths/rps exceeds the build time, priming starts at atSec and only
          // rps * buildSec paths are warm at cutover.
          if (e.priming.paths > 0 && e.priming.rps > 0 && e.buildSec > 0) {
            const startSec = Math.max(e.atSec, done - e.priming.paths / e.priming.rps);
            const primed = Math.min(e.priming.paths, e.priming.rps * e.buildSec);
            this.primings.push({
              startSec,
              endSec: done,
              rps: e.priming.rps,
              paths: primed,
            });
            this.primeAtCutover.push({ at: done, keys: primed });
          }
          break;
        }
      }
    }
    // Background publishing: evenly spaced publishes that purge CMS caches only (no Launch
    // revalidation), first one at half an interval.
    const bg = scenario.steady;
    if (bg.inTimeline && bg.publishesPerHour > 0 && bg.entriesPerPublish > 0) {
      const interval = 3600 / bg.publishesPerHour;
      for (let at = interval / 2; at < scenario.sim.durationSec; at += interval) {
        this.publishes.push({
          kind: 'publish',
          atSec: at,
          entries: bg.entriesPerPublish,
          spreadSec: 0,
          locales: 'all',
          purge: bg.purge,
          onPublish: 'none',
        });
      }
    }
    this.hasEvents = scenario.events.length > 0 || this.publishes.length > 0;
  }

  private localesFactor(p: Publish): number {
    return p.locales === 'all' ? this.site.locales : Math.min(p.locales, this.site.locales);
  }

  effectsAt(ctx: TickContext): EventEffects {
    const dt = ctx.dtSec;
    // Shift by a tiny epsilon so float error in tick * dt never fires an instant event one tick early
    // (e.g. 2999 * 0.1 = 299.90000000000003 must not own the window containing t = 300).
    const t = ctx.timeSec + dt * 1e-6;
    const out: EventEffects = {
      trafficMultiplier: 1,
      crawlerRps: 0,
      crawlerRandomQueryFraction: 0,
      crawlerNotFoundFraction: 0,
      loadTestRps: 0,
      loadTestCacheBusting: false,
      otherTrafficRps: 0,
      purges: [],
      coldReset: false,
      primingRps: 0,
      primingPaths: 0,
      primeKeysAtCutover: 0,
      revalidations: 0,
    };
    if (!this.hasEvents) return out;

    for (const s of this.spikes) out.trafficMultiplier *= spikeMultiplier(s, ctx.timeSec);

    let cw = 0;
    let rq = 0;
    let nf = 0;
    for (const c of this.crawlers) {
      if (t >= c.atSec && t < c.atSec + c.durationSec) {
        cw += c.rps;
        rq += c.rps * c.randomQueryFraction;
        nf += c.rps * c.notFoundFraction;
      }
    }
    if (cw > 0) {
      out.crawlerRps = cw;
      out.crawlerRandomQueryFraction = rq / cw;
      out.crawlerNotFoundFraction = nf / cw;
    }

    for (const l of this.loadTests) {
      if (t >= l.atSec && t < l.atSec + l.durationSec) {
        out.loadTestRps += l.rps;
        if (l.cacheBusting) out.loadTestCacheBusting = true;
      }
    }
    for (const o of this.others) {
      if (t >= o.atSec && t < o.atSec + o.durationSec) out.otherTrafficRps += o.rps;
    }
    for (const p of this.primings) {
      if (t >= p.startSec && t < p.endSec) {
        out.primingRps += p.rps;
        out.primingPaths = Math.max(out.primingPaths, p.paths);
      }
    }

    // Purges accumulate as survival products per layer: keep = Π(1 - f).
    let keep0 = 1;
    let keep1 = 1;
    let keep2 = 1;
    let keep3 = 1;
    let anyPurge = false;
    const apply = (layer: number, f: number) => {
      if (!(f > 0)) return;
      const g = 1 - Math.min(1, f);
      anyPurge = true;
      if (layer === 0) keep0 *= g;
      else if (layer === 1) keep1 *= g;
      else if (layer === 2) keep2 *= g;
      else keep3 *= g;
    };

    for (const at of this.goLives) {
      if (at >= t - 2e-6 * dt && at < t + dt - 2e-6 * dt) {
        out.coldReset = true;
        for (let i = 0; i < 4; i++) apply(i, 1);
      }
    }
    for (const at of this.deployCompletions) {
      if (at >= t - 2e-6 * dt && at < t + dt - 2e-6 * dt) {
        out.coldReset = true;
        apply(LAYER_IDX.launch, 1);
      }
    }

    for (const pc of this.primeAtCutover) {
      if (pc.at >= t - 2e-6 * dt && pc.at < t + dt - 2e-6 * dt) {
        out.primeKeysAtCutover = Math.max(out.primeKeysAtCutover, pc.keys);
      }
    }

    for (const p of this.publishes) {
      const end = p.atSec + p.spreadSec;
      let entries: number;
      if (p.spreadSec <= 0) {
        entries = p.atSec >= t - 2e-6 * dt && p.atSec < t + dt - 2e-6 * dt ? p.entries : 0;
      } else {
        const overlap = Math.min(t + dt, end) - Math.max(t, p.atSec);
        entries = overlap > 0 ? (p.entries * overlap) / p.spreadSec : 0;
      }
      if (!(entries > 1e-12)) continue;
      const lf = this.localesFactor(p);
      const pageKeyFrac = (entries * lf) / this.pagesTotalKeys;
      const refs = p.purge.referencingFraction;

      // Referencing queries: a share `refs` of all page queries over the whole publish, spread across
      // its ticks so a long spread doesn't compound refs once per tick.
      const refsTick = refs > 0 ? 1 - Math.pow(1 - Math.min(refs, 1), entries / p.entries) : 0;
      if (p.purge.pageQueries) apply(LAYER_IDX.cmsPage, pageKeyFrac + refsTick);
      else if (refsTick > 0) apply(LAYER_IDX.cmsPage, refsTick);
      if (p.purge.contentTypeLists) {
        const affected = Math.min(
          this.cms.contentTypes,
          Math.max(1, Math.ceil(entries / this.cms.entriesPerType)),
        );
        apply(LAYER_IDX.cmsList, (affected / this.cms.contentTypes) * (lf / this.site.locales));
      }
      if (p.purge.globals) apply(LAYER_IDX.cmsGlobal, 1);

      const firstTick = p.atSec >= t - 2e-6 * dt && p.atSec < t + dt - 2e-6 * dt;
      switch (p.onPublish) {
        case 'revalidatePaths':
          apply(LAYER_IDX.launch, pageKeyFrac);
          out.revalidations += entries;
          break;
        case 'revalidateTags':
          apply(LAYER_IDX.launch, pageKeyFrac + refsTick);
          if (firstTick) out.revalidations += 1;
          break;
        default:
          break; // 'none'; 'redeploy' is handled through deployCompletions.
      }
    }

    if (anyPurge) {
      const keeps = [keep0, keep1, keep2, keep3];
      for (let i = 0; i < 4; i++) {
        const f = 1 - (keeps[i] ?? 1);
        const layer = LAYERS[i];
        if (f > 0 && layer) out.purges.push({ layer, fraction: f });
      }
    }
    return out;
  }
}
