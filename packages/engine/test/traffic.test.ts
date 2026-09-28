import { describe, expect, it } from 'vitest';
import { createRng } from '../src/rng';
import { ScenarioSchema } from '../src/schema';
import { EventTimeline } from '../src/model/events';
import { TrafficGenerator } from '../src/model/traffic';
import { resolveFramework } from '../src/params/frameworks';
import type { EventEffects } from '../src/model/types';

const noFx = new EventTimeline(ScenarioSchema.parse({})).effectsAt({ tick: 0, dtSec: 1, timeSec: 0 });
const ctx = (t: number, dt = 1) => ({ tick: Math.round(t / dt), dtSec: dt, timeSec: t });

function scen(over: Record<string, unknown> = {}) {
  return ScenarioSchema.parse({
    sim: { stochastic: false },
    traffic: { baseEdgeRps: 100, bots: { share: 0.2, randomQueryFraction: 0.3, notFoundFraction: 0.1 } },
    ...over,
  });
}

describe('TrafficGenerator', () => {
  it('matches formulas in deterministic mode', () => {
    const sc = scen({ site: { framework: 'nextjs-app' } });
    const fw = resolveFramework(sc);
    const g = new TrafficGenerator(sc, createRng(1));
    const a = g.arrivals(ctx(0, 2), noFx);
    const V = 100 * 2;
    const bots = (V * 0.2) / 0.8;
    const b = g.lastBreakdown();
    expect(b.humanPage).toBeCloseTo(V * (1 - fw.clientNavFraction));
    expect(b.data).toBeCloseTo(V * fw.clientNavFraction * fw.dataRequestsPerNav);
    expect(b.prefetch).toBeCloseTo(V * fw.prefetchPerView);
    expect(b.botUnique).toBeCloseTo(bots * 0.3);
    expect(b.notFound).toBeCloseTo(bots * 0.1);
    expect(b.botPage).toBeCloseTo(bots * 0.6);
    expect(a.page).toBeCloseTo(b.humanPage + b.botPage);
    expect(a.data).toBeCloseTo(b.data + b.prefetch);
    expect(a.staticAssets).toBeCloseTo(V * 10);
  });

  it('applies spike multiplier and diurnal profile', () => {
    const sc = scen({ traffic: { baseEdgeRps: 100, profile: 'diurnal', bots: { share: 0 } }, site: { framework: 'nextjs-pages' } });
    const g = new TrafficGenerator(sc, createRng(1));
    const fx: EventEffects = { ...noFx, trafficMultiplier: 2 };
    expect(g.profileFactor(0)).toBeCloseTo(0.5);
    expect(g.profileFactor(43200)).toBeCloseTo(1.5);
    let sum = 0;
    for (let t = 0; t < 86400; t += 60) sum += g.profileFactor(t);
    expect(sum / 1440).toBeCloseTo(1, 3);
    const a = g.arrivals(ctx(43200), fx);
    const fw = resolveFramework(sc);
    expect(g.lastBreakdown().humanPage).toBeCloseTo(100 * 1.5 * 2 * (1 - fw.clientNavFraction));
    expect(a.botUnique).toBe(0);
  });

  it('routes crawler, load test and priming', () => {
    const sc = scen({ traffic: { baseEdgeRps: 0, bots: { share: 0 } } });
    const g = new TrafficGenerator(sc, createRng(1));
    const fx: EventEffects = {
      ...noFx,
      crawlerRps: 20,
      crawlerRandomQueryFraction: 0.5,
      crawlerNotFoundFraction: 0.25,
      loadTestRps: 100,
      loadTestCacheBusting: true,
      primingRps: 7,
    };
    let a = g.arrivals(ctx(0), fx);
    let b = g.lastBreakdown();
    expect(b.crawler).toBeCloseTo(20);
    expect(b.botPage).toBeCloseTo(5);
    expect(a.botUnique).toBeCloseTo(10 + 100);
    expect(a.notFound).toBeCloseTo(5);
    expect(b.loadTest).toBe(100);
    expect(b.priming).toBe(7);
    a = g.arrivals(ctx(0), { ...fx, loadTestCacheBusting: false });
    b = g.lastBreakdown();
    expect(a.page).toBeCloseTo(5 + 100);
    expect(a.botUnique).toBeCloseTo(10);
  });

  it('stochastic mean is within 3% and seeds are deterministic', () => {
    const sc = scen({ sim: { stochastic: true, burstiness: 20 } });
    const run = (seed: number) => {
      const g = new TrafficGenerator(sc, createRng(seed));
      let page = 0;
      let data = 0;
      const seq: number[] = [];
      for (let t = 0; t < 4000; t++) {
        const a = g.arrivals(ctx(t), noFx);
        page += a.page;
        data += a.data;
        if (t < 5) seq.push(a.page);
      }
      return { page, data, seq };
    };
    const det = new TrafficGenerator(scen(), createRng(1));
    let ePage = 0;
    let eData = 0;
    for (let t = 0; t < 4000; t++) {
      const a = det.arrivals(ctx(t), noFx);
      ePage += a.page;
      eData += a.data;
    }
    const r = run(5);
    expect(Math.abs(r.page / ePage - 1)).toBeLessThan(0.03);
    expect(Math.abs(r.data / eData - 1)).toBeLessThan(0.03);
    expect(run(5).seq).toEqual(r.seq);
    expect(run(6).seq).not.toEqual(r.seq);
    for (const v of r.seq) expect(Number.isInteger(v)).toBe(true);
  });
});
