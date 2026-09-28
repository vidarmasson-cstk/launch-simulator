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
          if (e.priming.paths > 0 && e.priming.rps > 0) {
            this.primings.push({
              startSec: done,
              endSec: done + e.priming.paths / e.priming.rps,
              rps: e.priming.rps,
              paths: e.priming.paths,
            });
          }
          break;
        }
      }
    }
    this.hasEvents = scenario.events.length > 0;
  }

  private localesFactor(p: Publish): number {
    return p.locales === 'all' ? this.site.locales : Math.min(p.locales, this.site.locales);
  }

  effectsAt(ctx: TickContext): EventEffects {
    const t = ctx.timeSec;
    const dt = ctx.dtSec;
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
      revalidations: 0,
    };
    if (!this.hasEvents) return out;

    for (const s of this.spikes) out.trafficMultiplier *= spikeMultiplier(s, t);

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
      if (t <= at && at < t + dt) {
        out.coldReset = true;
        for (let i = 0; i < 4; i++) apply(i, 1);
      }
    }
    for (const at of this.deployCompletions) {
      if (t <= at && at < t + dt) {
        out.coldReset = true;
        apply(LAYER_IDX.launch, 1);
      }
    }

    for (const p of this.publishes) {
      const end = p.atSec + p.spreadSec;
      let entries: number;
      if (p.spreadSec <= 0) {
        entries = t <= p.atSec && p.atSec < t + dt ? p.entries : 0;
      } else {
        const overlap = Math.min(t + dt, end) - Math.max(t, p.atSec);
        entries = overlap > 0 ? (p.entries * overlap) / p.spreadSec : 0;
      }
      if (!(entries > 1e-12)) continue;
      const lf = this.localesFactor(p);
      const pageKeyFrac = (entries * lf) / this.pagesTotalKeys;
      const refs = p.purge.referencingFraction;

      if (p.purge.pageQueries) apply(LAYER_IDX.cmsPage, pageKeyFrac + refs);
      else if (refs > 0) apply(LAYER_IDX.cmsPage, refs);
      if (p.purge.contentTypeLists) {
        const affected = Math.min(
          this.cms.contentTypes,
          Math.max(1, Math.ceil(entries / this.cms.entriesPerType)),
        );
        apply(LAYER_IDX.cmsList, (affected / this.cms.contentTypes) * (lf / this.site.locales));
      }
      if (p.purge.globals) apply(LAYER_IDX.cmsGlobal, 1);

      const firstTick = t <= p.atSec && p.atSec < t + dt;
      switch (p.onPublish) {
        case 'revalidatePaths':
          apply(LAYER_IDX.launch, pageKeyFrac);
          out.revalidations += entries;
          break;
        case 'revalidateTags':
          apply(LAYER_IDX.launch, pageKeyFrac + refs);
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
