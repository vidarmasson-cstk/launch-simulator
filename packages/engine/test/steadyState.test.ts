import { describe, expect, it } from 'vitest';
import { ScenarioSchema, type ScenarioInput } from '../src/schema';
import {
  computeSteadyState,
  countTail,
  erlangC,
  smallestLimit,
} from '../src/analytic/steadyState';

/** One page, one locale, one global key: hand-computable. */
function tiny(over: ScenarioInput = {}) {
  const base: ScenarioInput = {
    traffic: { baseEdgeRps: 10, bots: { share: 0, randomQueryFraction: 0, notFoundFraction: 0 } },
    site: {
      pages: 1,
      locales: 1,
      globalKeys: 1,
      framework: 'custom',
      frameworkOverrides: {
        globalCalls: 2,
        pageCalls: 1,
        listCalls: 0,
        n1Calls: 0,
        clientNavFraction: 0,
        prefetchPerView: 0,
        dataRequestsPerNav: 0,
        cpuRenderMsL1: 0,
      },
      cacheHeaders: { page: { cacheable: false } },
    },
    launch: { originLimitRps: 1000, cdn: { domains: 1 } },
    cms: { cdn: { domains: 1, ttlSec: 0 } },
    steady: { publishesPerHour: 0 },
  };
  const merged = { ...base } as Record<string, Record<string, unknown>>;
  for (const [k, v] of Object.entries(over as Record<string, Record<string, unknown>>)) {
    merged[k] = { ...(merged[k] ?? {}), ...v };
  }
  return ScenarioSchema.parse(merged);
}

declare const performance: { now(): number };

describe('computeSteadyState', () => {
  it('Launch page layer follows h = rT/(1+rT)', () => {
    const s = tiny({
      site: {
        cacheHeaders: { page: { cacheable: true, sMaxAgeSec: 10, swrSec: 0 } },
      },
    });
    const { kpis } = computeSteadyState(s);
    // r = 10/s, T = 10 s: fetch rate 10/101, miss fraction 1/101.
    expect(kpis.launchOriginRps).toBeCloseTo(10 / 101, 6);
    expect(kpis.launchHitRatio).toBeCloseTo(100 / 101, 6);
  });

  it('SWR lowers the blocking miss fraction but not the origin fetch rate', () => {
    const s = tiny({
      site: { cacheHeaders: { page: { cacheable: true, sMaxAgeSec: 10, swrSec: 1 } } },
    });
    const { kpis } = computeSteadyState(s);
    expect(kpis.launchOriginRps).toBeCloseTo(10 / 101, 6);
    expect(kpis.launchHitRatio).toBeCloseTo(1 - Math.exp(-10) / 101, 8);
  });

  it('uncached pages: CMS origin = renders x calls when the CMS CDN does not cache', () => {
    const { kpis } = computeSteadyState(tiny());
    expect(kpis.renderRps).toBeCloseTo(10, 9);
    expect(kpis.launchHitRatio).toBeCloseTo(0, 9);
    expect(kpis.cmsCallsRps).toBeCloseTo(30, 9); // (2 global + 1 page) per render
    expect(kpis.cmsOriginRps).toBeCloseTo(30, 9);
    expect(kpis.cmsCallsPerPageView).toBeCloseTo(3, 9);
  });

  it('CMS CDN per-key formula with finite TTL (hand computation)', () => {
    const s = tiny({ cms: { cdn: { domains: 1, ttlSec: 10 } } });
    const { kpis } = computeSteadyState(s);
    // global key r = 20/s -> 20/201; page key r = 10/s -> 10/101.
    expect(kpis.cmsOriginRps).toBeCloseTo(20 / 201 + 10 / 101, 9);
  });

  it('uncached pages with a warm infinite-TTL CMS CDN: origin ~ 0 and only purges miss', () => {
    const warm = computeSteadyState(tiny({ cms: { cdn: { domains: 1, ttlSec: null } } })).kpis;
    expect(warm.cmsOriginRps).toBe(0);
    expect(warm.cmsCdnHitRatio).toBe(1);
    // 3600 publishes/h of 1 entry, page purge fraction = 1/pages = 1, key r = 10/s, delta = 1 s.
    const purged = computeSteadyState(
      tiny({
        cms: { cdn: { domains: 1, ttlSec: null } },
        steady: { publishesPerHour: 3600, entriesPerPublish: 1, purge: { pageQueries: true, contentTypeLists: false, referencingFraction: 0, globals: false } },
      }),
    ).kpis;
    expect(purged.cmsOriginRps).toBeCloseTo(1 - Math.exp(-10), 9);
    expect(purged.cmsPurgeOriginRps).toBeCloseTo(1 - Math.exp(-10), 9);
  });

  it('adds notFound calls and other org traffic to CMS origin', () => {
    const s = tiny({
      traffic: { baseEdgeRps: 10, bots: { share: 0.5, randomQueryFraction: 0, notFoundFraction: 1 } },
      cms: { cdn: { domains: 1, ttlSec: null }, otherOrgTrafficRps: 7 },
    });
    const { kpis } = computeSteadyState(s);
    // bots = 10 rps, all 404: each render makes 1 uncacheable CMS call.
    expect(kpis.origin404Rps).toBeCloseTo(10, 9);
    expect(kpis.cmsNotFoundOriginRps).toBeCloseTo(10, 9);
    expect(kpis.cmsOriginRps).toBeGreaterThanOrEqual(17);
  });

  it('caps renders at the Launch origin limit', () => {
    const s = tiny({ launch: { originLimitRps: 4, cdn: { domains: 1 } } });
    const { kpis } = computeSteadyState(s);
    expect(kpis.launchOriginRps).toBeCloseTo(10, 9);
    expect(kpis.renderRps).toBeCloseTo(4, 9);
    expect(kpis.launchUtilPct).toBeCloseTo(250, 6);
    expect(kpis.bottleneck).toBe('launchOrigin');
  });

  it('little law and instances', () => {
    const s = tiny({
      site: {
        pages: 1,
        locales: 1,
        globalKeys: 1,
        framework: 'custom',
        cacheHeaders: { page: { cacheable: false } },
        frameworkOverrides: {
          globalCalls: 0,
          pageCalls: 0,
          listCalls: 0,
          n1Calls: 0,
          clientNavFraction: 0,
          prefetchPerView: 0,
          dataRequestsPerNav: 0,
          cpuRenderMsL1: 100,
          sequentialWaves: 0,
        },
      },
      launch: { originLimitRps: 1000, cdn: { domains: 1 }, compute: { concurrencyPerInstance: 2, maxInstances: 100 } },
    });
    const { kpis } = computeSteadyState(s);
    expect(kpis.serviceMs).toBeCloseTo(100, 9); // L1 keeps cpuRenderMsL1
    expect(kpis.inFlight).toBeCloseTo(1, 9); // 10 rps x 0.1 s
    expect(kpis.instancesNeeded).toBe(1);
    expect(kpis.computeUtilPct).toBeCloseTo(0.5, 9);
  });

  it('hops describe the flow diagram in order', () => {
    const { hops } = computeSteadyState(ScenarioSchema.parse({}));
    expect(hops.map((h) => h.id)).toEqual([
      'edge',
      'launchCdn',
      'launchOrigin',
      'compute',
      'cmsCdn',
      'cmsOrigin',
    ]);
    expect(hops[2]!.limit).toBe(200);
  });

  it('healthy retail calibration: CMS origin under 10 rps at 8.2K page views/s', () => {
    const s = ScenarioSchema.parse({
      traffic: { baseEdgeRps: 8200, bots: { share: 0.01, randomQueryFraction: 0, notFoundFraction: 0.001 } },
      site: {
        pages: 5000,
        locales: 3,
        frameworkOverrides: { clientNavFraction: 0, prefetchPerView: 0 },
        cacheHeaders: { page: { cacheable: true, sMaxAgeSec: 3600, swrSec: 86400 } },
      },
      launch: { originLimitRps: 1200 },
    });
    const { kpis } = computeSteadyState(s);
    expect(kpis.launchHitRatio).toBeGreaterThan(0.999);
    expect(kpis.cmsOriginRps).toBeLessThan(10);
  });

  it('suggestedCmsLimit is at least the CMS origin rps and bounds the tail', () => {
    const s = tiny({ cms: { cdn: { domains: 1, ttlSec: 0 }, cda: { limitRps: 100 } } });
    const { kpis } = computeSteadyState(s);
    expect(kpis.suggestedCmsLimitRps).toBeGreaterThanOrEqual(kpis.cmsOriginRps);
    const L = smallestLimit(kpis.cmsOriginRps, 1 / 3600);
    expect(kpis.suggestedCmsLimitRps).toBe(Math.ceil(L * 1.2));
    expect(countTail(kpis.cmsOriginRps, L)).toBeLessThan(1 / 3600);
  });

  it('runs in < 20 ms on the default scenario (mean of 50 runs)', () => {
    const s = ScenarioSchema.parse({});
    computeSteadyState(s); // warm up JIT and bin memo
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) computeSteadyState(s);
    expect((performance.now() - t0) / 50).toBeLessThan(20);
  });
});

describe('tail and queueing numerics', () => {
  it('Poisson tail sanity: mu = 80, limit 100', () => {
    // Exact P(N > 100) = 0.01317 (P(N >= 100) = 0.0171).
    expect(countTail(80, 100)).toBeCloseTo(0.0132, 3);
    expect(Math.abs(countTail(80, 99) - 0.0165)).toBeLessThan(0.004);
  });

  it('is monotone, bounded and stable for large mu', () => {
    expect(countTail(0, 10)).toBe(0);
    expect(countTail(50, 10)).toBeGreaterThan(0.999999);
    expect(countTail(5000, 5000)).toBeGreaterThan(0.45);
    expect(countTail(5000, 5000)).toBeLessThan(0.55);
    expect(countTail(5000, 5500)).toBeLessThan(1e-6);
    expect(countTail(900, 1000)).toBeLessThan(countTail(900, 950));
  });

  it('negative binomial has a heavier tail than Poisson', () => {
    expect(countTail(80, 120, 5)).toBeGreaterThan(countTail(80, 120));
    // Large k converges to Poisson.
    expect(countTail(80, 100, 1e7)).toBeCloseTo(countTail(80, 100), 3);
  });

  it('smallestLimit is the boundary', () => {
    const L = smallestLimit(80, 1 / 3600);
    expect(countTail(80, L)).toBeLessThan(1 / 3600);
    expect(countTail(80, L - 1)).toBeGreaterThanOrEqual(1 / 3600);
  });

  it('erlangC matches closed forms', () => {
    expect(erlangC(1, 2)).toBeCloseTo(1 / 3, 9);
    expect(erlangC(0.5, 1)).toBeCloseTo(0.5, 9);
    expect(erlangC(5, 5)).toBe(1);
    expect(erlangC(0, 5)).toBe(0);
    const big = erlangC(9000, 10000);
    expect(big).toBeGreaterThanOrEqual(0);
    expect(big).toBeLessThan(1e-6);
  });
});
