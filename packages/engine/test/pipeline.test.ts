import { describe, expect, it } from 'vitest';
import { CacheLayer } from '../src/model/cacheLayer';
import { runSimulation } from '../src/model/pipeline';
import { ScenarioSchema } from '../src/schema';
import type { ScenarioInput } from '../src/schema';
import type { SimulationResult } from '../src/model/types';

declare const console: { log: (...args: unknown[]) => void };

const run = (input: ScenarioInput, onProgress?: (f: number) => void): SimulationResult =>
  runSimulation(ScenarioSchema.parse(input), onProgress ? { onProgress } : {});

const mean = (a: Float32Array, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i]!;
  return s / (to - from);
};
const max = (a: Float32Array, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s = Math.max(s, a[i]!);
  return s;
};
const sum = (a: Float32Array) => mean(a) * a.length;

const PURE_HTML = { clientNavFraction: 0, prefetchPerView: 0 };

/** Healthy retail peak: ~8.2K edge rps (about 490K req/min), s-maxage 3600 + SWR, pure HTML. */
const healthy = (over: { cacheable?: boolean } = {}): ScenarioInput => ({
  sim: { durationSec: 600 },
  traffic: {
    baseEdgeRps: 8200,
    bots: { share: 0.01, randomQueryFraction: 0, notFoundFraction: 0.001 },
  },
  site: {
    pages: 5000,
    locales: 3,
    framework: 'nextjs-app',
    frameworkOverrides: PURE_HTML,
    cacheHeaders: {
      page: { cacheable: over.cacheable ?? true, sMaxAgeSec: 3600, swrSec: 86400 },
    },
  },
});

describe('CacheLayer.warm', () => {
  const cfg = (ttlSec: number) => ({
    ttlSec,
    swrSec: 0,
    staleIfErrorSec: 0,
    collapse: true,
    domains: 1,
    maxLatencySec: 5,
    durationSec: 100,
    dtSec: 0.1,
  });
  it('sets fresh = rT/(1+rT) for a finite ttl, spread over ages, and expires it over time', () => {
    const layer = new CacheLayer(cfg(20), [{ n: 100, p: 0.01 }]);
    layer.warm(new Float64Array([100 * 0.5]), 3600); // r = 0.5 per key, T = 20 -> 10/11
    expect(layer.state().fresh).toBeCloseTo(10 / 11, 9);
    expect(layer.state().empty).toBeCloseTo(1 / 11, 9);
    const res = layer.step(0, new Float64Array([0]));
    expect(res.requests).toBe(0);
    for (let t = 1; t <= 100; t++) layer.step(t, new Float64Array([0])); // 10 s of ageing
    expect(layer.state().fresh).toBeCloseTo((10 / 11) * 0.5, 1);
  });
  it('sets fresh = 1 - exp(-r * history) for an infinite ttl', () => {
    const layer = new CacheLayer(cfg(Infinity), [{ n: 10, p: 0.1 }]);
    layer.warm(new Float64Array([10 * 0.001]), 1000); // r = 0.001, history 1000 s
    expect(layer.state().fresh).toBeCloseTo(1 - Math.exp(-1), 9);
    const res = layer.step(0, new Float64Array([10 * 0.001]));
    expect(res.hits / res.requests).toBeCloseTo(1 - Math.exp(-1), 6);
  });
});

describe('runSimulation', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const base: ScenarioInput = { sim: { durationSec: 120, seed: 7, stochastic: true } };
    const a = run(base);
    const b = run(base);
    expect(b.summary).toEqual(a.summary);
    expect(Array.from(b.series.columns.launchOriginOffered!)).toEqual(
      Array.from(a.series.columns.launchOriginOffered!),
    );
    const c = run({ sim: { durationSec: 120, seed: 8, stochastic: true } });
    expect(Array.from(c.series.columns.launchOriginOffered!)).not.toEqual(
      Array.from(a.series.columns.launchOriginOffered!),
    );
  });

  it('reports progress and one marker per event', () => {
    const fracs: number[] = [];
    const r = run(
      {
        sim: { durationSec: 60 },
        events: [
          { kind: 'publish', atSec: 10, entries: 500 },
          { kind: 'goLive', atSec: 30 },
        ],
      },
      (f) => fracs.push(f),
    );
    expect(fracs.length).toBeGreaterThan(5);
    expect(fracs[fracs.length - 1]).toBe(1);
    expect(fracs.every((f, i) => i === 0 || f >= fracs[i - 1]!)).toBe(true);
    expect(r.markers).toEqual([
      { timeSec: 10, kind: 'publish', label: 'publish 500 entries' },
      { timeSec: 30, kind: 'goLive', label: expect.any(String) },
    ]);
  });

  it('healthy calibration: hit ratio >= 0.99 and CMS origin mean < 10 rps', () => {
    const r = run(healthy());
    const c = r.series.columns;
    const hit = mean(c.launchHitRatio!);
    const cmsOff = mean(c.cmsOriginOffered!);
    console.log(
      `calibration: edge ${mean(c.edgeRps!).toFixed(0)} rps, launch hit ${hit.toFixed(5)}, ` +
        `launch origin ${mean(c.launchOriginOffered!).toFixed(2)} rps, cms origin ${cmsOff.toFixed(3)} rps`,
    );
    expect(mean(c.edgePageRps!)).toBeGreaterThan(8000);
    expect(hit).toBeGreaterThanOrEqual(0.99);
    expect(cmsOff).toBeLessThan(10);
    expect(r.summary.totalCms429).toBe(0);
    expect(r.summary.totalLaunch429).toBe(0);
    expect(r.summary.bottleneck).toBe('none');
  });

  it('missing s-maxage: Launch origin is saturated and rejects requests', () => {
    const r = run(healthy({ cacheable: false }));
    const c = r.series.columns;
    expect(mean(c.launchOriginOffered!)).toBeGreaterThanOrEqual(200);
    expect(r.summary.totalLaunch429).toBeGreaterThan(0);
    expect(mean(c.launch429!)).toBeGreaterThan(200);
    expect(r.summary.bottleneck).toBe('launchOrigin');
    expect(r.summary.visitorErrorRate).toBeGreaterThan(0.5);
    // Note: with the default CMS CDN (cached until purged) the CMS origin stays quiet even though
    // the origin-bound renders are uncached: the CDN absorbs their calls.
    expect(mean(c.cmsOriginOffered!)).toBeLessThan(c.cmsLimit![0]!);
  });

  it('missing s-maxage with a short CMS CDN TTL and a high Launch limit: CMS origin far above limit', () => {
    const scenario = healthy({ cacheable: false });
    const r = run({
      ...scenario,
      launch: { originLimitRps: 20000 },
      cms: { cdn: { ttlSec: 60 } },
    });
    const c = r.series.columns;
    expect(mean(c.cmsOriginOffered!, 60)).toBeGreaterThan(3 * c.cmsLimit![0]!);
    expect(r.summary.totalCms429).toBeGreaterThan(0);
    expect(r.summary.secondsWithCms429).toBeGreaterThan(0);
  });

  it('bulk publish: CMS origin peak after t=300 is >= 3x the peak before it', () => {
    const r = run({
      sim: { durationSec: 600 },
      events: [
        {
          kind: 'publish',
          atSec: 300,
          entries: 500,
          spreadSec: 0,
          purge: {
            pageQueries: true,
            contentTypeLists: true,
            referencingFraction: 0.3,
            globals: true,
          },
          onPublish: 'revalidateTags',
        },
      ],
    });
    const off = r.series.columns.cmsOriginOffered!;
    // The purge fires on the tick containing t = 300; exclude the second that contains it.
    const before = max(off, 30, 299);
    const after = max(off, 300, 330);
    console.log(`bulk publish: cms origin peak before ${before}, after ${after} rps`);
    expect(after).toBeGreaterThan(20);
    expect(after).toBeGreaterThanOrEqual(3 * Math.max(before, 1));
  });

  it('deploy: Launch hit ratio drops after 300+buildSec and then recovers', () => {
    const r = run({
      sim: { durationSec: 900 },
      traffic: { baseEdgeRps: 100 },
      site: { frameworkOverrides: PURE_HTML },
      events: [{ kind: 'deploy', atSec: 300, buildSec: 60 }],
    });
    const hit = r.series.columns.launchHitRatio!;
    const pre = mean(hit, 340, 358);
    const dip = mean(hit, 360, 363);
    const end = mean(hit, 880, 900);
    console.log(
      `deploy: hit before ${pre.toFixed(3)}, right after ${dip.toFixed(3)}, end ${end.toFixed(3)}`,
    );
    expect(pre).toBeGreaterThan(0.5);
    expect(dip).toBeLessThan(0.3 * pre);
    expect(end).toBeGreaterThan(0.8 * pre);
    expect(mean(hit, 330, 358)).toBeGreaterThan(0.5); // nothing happens at deploy start (build phase)
  });

  it('GCRA (burst 200%, maxWait 3 s) gives fewer CMS 429s and higher render p95 than a fixed window', () => {
    const spiky = (cda: Record<string, unknown>): ScenarioInput => ({
      sim: { durationSec: 600 },
      traffic: { baseEdgeRps: 300 },
      launch: { originLimitRps: 5000 },
      site: { cacheHeaders: { page: { cacheable: true, sMaxAgeSec: 60, swrSec: 0 } } },
      cms: { cdn: { ttlSec: 60 }, cda },
      events: [{ kind: 'spike', atSec: 200, durationSec: 60, multiplier: 5, rampSec: 2 }],
    });
    const fixed = run(spiky({ algorithm: 'fixedWindow' }));
    const gcra = run(spiky({ algorithm: 'gcra', burstMultiplierPct: 200, maxWaitMs: 3000 }));
    console.log(
      `cms429 fixed ${fixed.summary.totalCms429.toFixed(0)} vs gcra ${gcra.summary.totalCms429.toFixed(0)}; ` +
        `renderP95 max fixed ${max(fixed.series.columns.renderP95!).toFixed(0)} vs gcra ${max(gcra.series.columns.renderP95!).toFixed(0)}`,
    );
    expect(fixed.summary.totalCms429).toBeGreaterThan(0);
    expect(gcra.summary.totalCms429).toBeLessThan(fixed.summary.totalCms429);
    expect(max(gcra.series.columns.renderP95!)).toBeGreaterThan(
      max(fixed.series.columns.renderP95!),
    );
    expect(max(gcra.series.columns.gcraDelayMs!)).toBeGreaterThan(0);
  });

  it('static framework makes no CMS calls', () => {
    const r = run({ sim: { durationSec: 120 }, site: { framework: 'astro-static' } });
    const c = r.series.columns;
    expect(mean(c.cmsCalls!)).toBeCloseTo(0, 6);
    expect(r.summary.cmsCallsPerPageView).toBe(0);
    expect(max(c.instances!)).toBe(0);
    expect(mean(c.edgeRps!)).toBeGreaterThan(0);
  });

  it('conserves Launch origin requests: accepted + 429 = offered', () => {
    const r = run({
      sim: { durationSec: 300 },
      events: [{ kind: 'crawler', atSec: 60, durationSec: 120, rps: 300 }],
    });
    const c = r.series.columns;
    const offered = sum(c.launchOriginOffered!);
    expect(offered).toBeGreaterThan(1000);
    expect(sum(c.launchOriginAccepted!) + sum(c.launch429!)).toBeCloseTo(offered, -1);
    expect(sum(c.launch429!)).toBeGreaterThan(0);
    // relative check
    const rel = Math.abs(sum(c.launchOriginAccepted!) + sum(c.launch429!) - offered) / offered;
    expect(rel).toBeLessThan(1e-4);
  });

  it('cold go-live starts with empty caches and cold compute', () => {
    const r = run({
      sim: { durationSec: 60 },
      traffic: { baseEdgeRps: 100 },
      site: { frameworkOverrides: PURE_HTML },
      events: [{ kind: 'goLive', atSec: 0 }],
    });
    const c = r.series.columns;
    expect(c.launchHitRatio![0]).toBeLessThan(0.2);
    expect(c.instances![0]).toBe(0);
    const warm = run({
      sim: { durationSec: 60 },
      traffic: { baseEdgeRps: 100 },
      site: { frameworkOverrides: PURE_HTML },
    });
    expect(warm.series.columns.launchHitRatio![0]).toBeGreaterThan(c.launchHitRatio![0]! + 0.2);
    expect(warm.series.columns.instances![0]).toBeGreaterThan(0);
  });

  it('revalidation quota: revalidations beyond dailyQuota are rejected', () => {
    const r = run({
      sim: { durationSec: 60 },
      launch: { revalidation: { dailyQuota: 100 } },
      events: [
        { kind: 'publish', atSec: 10, entries: 500, spreadSec: 0, onPublish: 'revalidatePaths' },
      ],
    });
    const c = r.series.columns;
    expect(c.revalidationsRejected![59]).toBe(500);
    expect(c.revalidationsUsed![59]).toBe(0);
  });

  it('external CDN that caches errors keeps serving errors after a Launch failure', () => {
    const r = run({
      sim: { durationSec: 300 },
      traffic: { baseEdgeRps: 300 },
      launch: { externalCdn: { enabled: true, ttlSec: 30, cachesErrors: true, errorTtlSec: 60 } },
      site: {
        frameworkOverrides: PURE_HTML,
        cacheHeaders: { page: { cacheable: true, sMaxAgeSec: 30, swrSec: 0 } },
      },
      sdk: { onFinalFailure: 'render404' },
      events: [{ kind: 'otherTraffic', atSec: 100, durationSec: 60, rps: 5000 }],
    });
    expect(r.summary.totalCms429).toBeGreaterThan(0);
    expect(sum(r.series.columns.visitorErrors404!)).toBeGreaterThan(0);
  });

  it('performance: a 1 h run at dt 0.1 finishes in under 3 s', () => {
    const t0 = Date.now();
    const r = run({ sim: { durationSec: 3600, dtSec: 0.1 } });
    const ms = Date.now() - t0;
    console.log(`perf: 3600 s at dt 0.1 -> ${ms} ms`);
    expect(r.series.length).toBe(3600);
    expect(ms).toBeLessThan(3000);
  });
});
