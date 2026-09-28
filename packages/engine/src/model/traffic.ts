import type { Rng } from '../rng';
import type { Scenario } from '../schema';
import { resolveFramework } from '../params/frameworks';
import type { ArrivalsByClass, EventEffects, ITrafficGenerator, TickContext } from './types';

/** Assumption (edge-count only): static asset requests per human page load or client navigation. */
export const STATIC_ASSETS_PER_VIEW = 10;

/**
 * Request counts of the last `arrivals()` call, split by source. The class totals returned by
 * `arrivals()` are derived from these fields:
 *   page      = humanPage + botPage
 *   data      = data + prefetch
 *   botUnique = botUnique
 *   notFound  = notFound
 * `humanPage` includes non-cache-busting load-test requests, `botUnique` includes cache-busting
 * load-test requests, and `botPage` / `botUnique` / `notFound` include the crawler's share.
 * `crawler` and `loadTest` are informational "of which" totals so the pipeline can treat them
 * separately (e.g. uniform page popularity for load tests). `priming` is NOT part of any class:
 * it is origin traffic for the top paths.
 */
export interface TrafficBreakdown {
  humanPage: number;
  botPage: number;
  data: number;
  prefetch: number;
  botUnique: number;
  notFound: number;
  crawler: number;
  loadTest: number;
  loadTestCacheBusting: boolean;
  priming: number;
}

const emptyBreakdown = (): TrafficBreakdown => ({
  humanPage: 0,
  botPage: 0,
  data: 0,
  prefetch: 0,
  botUnique: 0,
  notFound: 0,
  crawler: 0,
  loadTest: 0,
  loadTestCacheBusting: false,
  priming: 0,
});

/**
 * Arrival generation: profile, spikes, bots (DESIGN 6.7 step 2).
 *
 * Diurnal profile: factor(t) = 1 + 0.5 sin(2 pi t / 86400 - pi / 2); the sine has zero mean over a
 * day, so the factor already averages 1 (trough 0.5 at t = 0, peak 1.5 at 12:00).
 */
export class TrafficGenerator implements ITrafficGenerator {
  private readonly scenario: Scenario;
  private readonly rng: Rng;
  private readonly fw: ReturnType<typeof resolveFramework>;
  private readonly botFactor: number;
  private last: TrafficBreakdown = emptyBreakdown();

  constructor(scenario: Scenario, rng: Rng) {
    this.scenario = scenario;
    this.rng = rng;
    this.fw = resolveFramework(scenario);
    const share = Math.min(0.999, Math.max(0, scenario.traffic.bots.share));
    this.botFactor = share / (1 - share);
  }

  profileFactor(timeSec: number): number {
    if (this.scenario.traffic.profile === 'diurnal') {
      return 1 + 0.5 * Math.sin((2 * Math.PI * timeSec) / 86400 - Math.PI / 2);
    }
    return 1;
  }

  lastBreakdown(): TrafficBreakdown {
    return this.last;
  }

  private sample(mean: number): number {
    if (!(mean > 0)) return 0;
    if (!this.scenario.sim.stochastic) return mean;
    const k = this.scenario.sim.burstiness;
    return this.rng.negBinomial(mean, typeof k === 'number' ? k : null);
  }

  arrivals(ctx: TickContext, fx: EventEffects): ArrivalsByClass {
    const dt = ctx.dtSec;
    const fw = this.fw;
    const bots = this.scenario.traffic.bots;
    const V = this.scenario.traffic.baseEdgeRps * this.profileFactor(ctx.timeSec) * fx.trafficMultiplier;

    const navRate = V * fw.clientNavFraction;
    const botRate = V * this.botFactor;
    const restBot = Math.max(0, 1 - bots.randomQueryFraction - bots.notFoundFraction);
    const crQ = fx.crawlerRps * fx.crawlerRandomQueryFraction;
    const crNf = fx.crawlerRps * fx.crawlerNotFoundFraction;
    const crPage = Math.max(0, fx.crawlerRps - crQ - crNf);

    const humanPageC = this.sample(V * (1 - fw.clientNavFraction) * dt);
    const navs = this.sample(navRate * dt);
    const prefetch = this.sample(V * fw.prefetchPerView * dt);
    const botPageC = this.sample(botRate * restBot * dt);
    const botUniqueC = this.sample(botRate * bots.randomQueryFraction * dt);
    const botNfC = this.sample(botRate * bots.notFoundFraction * dt);
    const crPageC = this.sample(crPage * dt);
    const crQC = this.sample(crQ * dt);
    const crNfC = this.sample(crNf * dt);
    const ltC = this.sample(fx.loadTestRps * dt);
    const primingC = this.sample(fx.primingRps * dt);

    const dataC = navs * fw.dataRequestsPerNav;
    const ltBust = fx.loadTestCacheBusting;

    const b = this.last;
    b.humanPage = humanPageC + (ltBust ? 0 : ltC);
    b.botPage = botPageC + crPageC;
    b.data = dataC;
    b.prefetch = prefetch;
    b.botUnique = botUniqueC + crQC + (ltBust ? ltC : 0);
    b.notFound = botNfC + crNfC;
    b.crawler = crPageC + crQC + crNfC;
    b.loadTest = ltC;
    b.loadTestCacheBusting = ltBust;
    b.priming = primingC;

    return {
      page: b.humanPage + b.botPage,
      data: b.data + b.prefetch,
      botUnique: b.botUnique,
      notFound: b.notFound,
      staticAssets: (humanPageC + navs) * STATIC_ASSETS_PER_VIEW,
    };
  }
}
