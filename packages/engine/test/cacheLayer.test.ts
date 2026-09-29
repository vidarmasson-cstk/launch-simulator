import { describe, expect, it } from 'vitest';
import { analyticHitRatio, CacheLayer } from '../src/model/cacheLayer';
import type { CacheLayerConfig, CacheStepResult } from '../src/model/types';

const DT = 0.1;

function cfg(over: Partial<CacheLayerConfig> = {}): CacheLayerConfig {
  return {
    ttlSec: 10,
    swrSec: 0,
    staleIfErrorSec: 0,
    collapse: true,
    domains: 1,
    maxLatencySec: 6,
    durationSec: 100000,
    dtSec: DT,
    ...over,
  };
}

/** Runs one tick and schedules all fetches with a fixed latency and success fraction. */
function tickOnce(
  layer: CacheLayer,
  tick: number,
  lambda: Float64Array,
  latencySec: number,
  success = 1,
): CacheStepResult {
  const r = layer.step(tick, lambda);
  layer.scheduleCompletions(
    tick,
    r.originFetchesPerBin,
    tick + Math.round(latencySec / DT),
    success,
  );
  return r;
}

function expectConserved(layer: CacheLayer, bins: number): void {
  for (let b = 0; b < bins; b++) {
    const s = layer.binState(b);
    const sum = s.fresh + s.stale + s.empty + s.pending + s.errorCached + s.pendingStale;
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
    for (const v of Object.values(s)) expect(v).toBeGreaterThan(-1e-9);
  }
  const a = layer.state();
  expect(Math.abs(a.fresh + a.stale + a.empty + a.pending + a.errorCached - 1)).toBeLessThan(1e-9);
}

describe('analyticHitRatio', () => {
  it('matches rT/(1+rT)', () => {
    expect(analyticHitRatio(2, 10)).toBeCloseTo(20 / 21, 12);
    expect(analyticHitRatio(0, 10)).toBe(0);
    expect(analyticHitRatio(1, Infinity)).toBe(1);
  });
});

describe('CacheLayer.prime', () => {
  const bins = [
    { n: 10, p: 0.05 },
    { n: 40, p: 0.01 },
    { n: 100, p: 0.001 },
  ];
  const lambda = Float64Array.of(500, 400, 100);

  it('makes the top bins fresh (partial last bin) and conserves fractions', () => {
    const layer = new CacheLayer(cfg({ ttlSec: 60, swrSec: 30, domains: 2 }), bins);
    layer.purge(1);
    layer.prime(30); // bin 0 fully, bin 1 by 20/40
    expect(layer.binState(0).fresh).toBeCloseTo(1, 9);
    expect(layer.binState(1).fresh).toBeCloseTo(0.5, 9);
    expect(layer.binState(2).fresh).toBe(0);
    expectConserved(layer, 3);
    const st = layer.state();
    expect(st.fresh).toBeCloseTo((10 + 20) / 150, 9);
  });

  it('moves stale and error-cached keys into fresh too', () => {
    const layer = new CacheLayer(
      cfg({ ttlSec: 5, swrSec: 60, cacheErrors: { ttlSec: 30 } }),
      bins,
    );
    layer.warm(lambda, 3600);
    for (let t = 1; t < 80; t++) tickOnce(layer, t, new Float64Array(3), 0.1, 0.5); // ages into stale
    expect(layer.binState(0).stale).toBeGreaterThan(0.1);
    layer.prime(10);
    const s0 = layer.binState(0);
    expect(s0.fresh + s0.pending + s0.pendingStale).toBeCloseTo(1, 9);
    expect(layer.binState(0).stale).toBeLessThan(1e-9);
    expect(layer.binState(2).stale).toBeGreaterThan(0.1);
    expectConserved(layer, 3);
  });

  it('primed keys are hits right away and expire after the ttl', () => {
    const layer = new CacheLayer(cfg({ ttlSec: 5 }), bins);
    layer.purge(1);
    layer.prime(150);
    const r = layer.step(1, lambda);
    expect(r.hits / r.requests).toBeGreaterThan(0.99);
    for (let t = 2; t < 5 / DT + 5; t++) layer.step(t, new Float64Array(3));
    expect(layer.binState(0).fresh).toBeLessThan(1e-9);
  });

  it('prime(0) is a no-op', () => {
    const layer = new CacheLayer(cfg(), bins);
    layer.prime(0);
    expect(layer.state().fresh).toBe(0);
  });
});

describe('CacheLayer', () => {
  it('conserves fractions under random steps, purges and completions', () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const bins = Array.from({ length: 6 }, (_, i) => ({ n: 1 + i * 50, p: 1 / 6 / (1 + i * 50) }));
    for (const variant of [
      { swrSec: 0, collapse: true },
      { swrSec: 20, collapse: true, staleIfErrorSec: 30 },
      { swrSec: 20, collapse: false, cacheErrors: { ttlSec: 5 } },
      { ttlSec: Infinity, swrSec: 5, collapse: true },
    ]) {
      const layer = new CacheLayer(cfg({ ttlSec: 8, domains: 3, ...variant }), bins);
      const lambda = new Float64Array(6);
      for (let t = 0; t < 3000; t++) {
        for (let b = 0; b < 6; b++) lambda[b] = rnd() * 200 * (b === 0 ? 5 : 1);
        const r = layer.step(t, lambda);
        // split fetches across several completion ticks and success fractions
        const part = new Float64Array(6);
        for (let b = 0; b < 6; b++) part[b] = r.originFetchesPerBin[b]! * 0.4;
        layer.scheduleCompletions(t, part, t + Math.floor(rnd() * 40), rnd());
        if (rnd() < 0.5) layer.scheduleCompletions(t, part, t - 3, 1); // <= tick -> tick+1
        if (rnd() < 0.3) layer.scheduleCompletions(t, part, t + 10_000, 0.5); // clamped
        // remainder intentionally left to the auto-schedule default
        if (rnd() < 0.01) layer.purge(rnd());
        if (rnd() < 0.005) layer.purge(Float64Array.from({ length: 6 }, () => rnd()));
        if (rnd() < 0.002) layer.purge(1);
        if (t % 50 === 0) expectConserved(layer, 6);
      }
      expectConserved(layer, 6);
    }
  });

  it('total requests equal lambda*dt', () => {
    const layer = new CacheLayer(cfg(), [{ n: 10, p: 0.1 }]);
    const r = tickOnce(layer, 0, Float64Array.of(50), 0.1);
    expect(r.requests).toBeCloseTo(5, 12);
    expect(r.hits + r.staleHits + r.blockingMisses + r.errorsServed).toBeCloseTo(5, 12);
  });

  it.each([0.5, 2, 10])('converges to the analytic hit ratio (r = %d/s)', (rate) => {
    const layer = new CacheLayer(cfg({ ttlSec: 10 }), [{ n: 1, p: 1 }]);
    const lambda = Float64Array.of(rate);
    const latency = 0.1;
    let req = 0;
    let hit = 0;
    const ticks = 3000 / DT;
    for (let t = 0; t < ticks; t++) {
      const r = tickOnce(layer, t, lambda, latency);
      if (t * DT >= 500) {
        req += r.requests;
        hit += r.hits + r.staleHits;
      }
    }
    const measured = hit / req;
    const analytic = analyticHitRatio(rate, 10);
    // requests during the fetch latency also miss: account for it in the reference
    const withLatency = (rate * 10) / (rate * 10 + 1 + rate * latency);
    expect(Math.abs(measured - analytic) / analytic).toBeLessThan(0.02);
    expect(Math.abs(measured - withLatency) / withLatency).toBeLessThan(0.02);
  });

  it('infinite TTL: hit ratio -> 1, purge causes blocking misses, then recovers', () => {
    const layer = new CacheLayer(cfg({ ttlSec: Infinity }), [{ n: 20, p: 0.05 }]);
    const lambda = Float64Array.of(200);
    let t = 0;
    let last!: CacheStepResult;
    for (; t < 600; t++) last = tickOnce(layer, t, lambda, 0.2);
    expect(last.hits / last.requests).toBeGreaterThan(0.999);
    layer.purge(1);
    const after = tickOnce(layer, t++, lambda, 0.2);
    expect(after.blockingMisses).toBeCloseTo(after.requests, 9);
    expect(after.hits).toBeLessThan(1e-9);
    for (let k = 0; k < 300; k++) last = tickOnce(layer, t++, lambda, 0.2);
    expect(last.hits / last.requests).toBeGreaterThan(0.999);
  });

  it('SWR removes blocking misses in steady state; origin rate ~ r/(1+rT) per key', () => {
    const rate = 2;
    const ttl = 10;
    const layer = new CacheLayer(cfg({ ttlSec: ttl, swrSec: 3600 }), [{ n: 1, p: 1 }]);
    const lambda = Float64Array.of(rate);
    let blocking = 0;
    let fetches = 0;
    let secs = 0;
    for (let t = 0; t < 4000 / DT; t++) {
      const r = tickOnce(layer, t, lambda, 0.1);
      if (t * DT >= 1000) {
        blocking += r.blockingMisses;
        fetches += r.originFetchesPerBin[0]!;
        secs += DT;
      }
    }
    expect(blocking).toBeLessThan(1e-6);
    const expected = rate / (1 + rate * ttl);
    expect(Math.abs(fetches / secs - expected) / expected).toBeLessThan(0.08);
  });

  it('no-collapse issues far more origin fetches than collapse under long latency', () => {
    const run = (collapse: boolean) => {
      const layer = new CacheLayer(cfg({ ttlSec: 30, collapse }), [{ n: 5, p: 0.2 }]);
      const lambda = Float64Array.of(500);
      let fetches = 0;
      let waits = 0;
      for (let t = 0; t < 600 / DT; t++) {
        const r = tickOnce(layer, t, lambda, 5);
        fetches += r.originFetchesPerBin[0]!;
        waits += r.collapsedWaits;
      }
      return { fetches, waits };
    };
    const c = run(true);
    const n = run(false);
    expect(n.fetches).toBeGreaterThan(20 * c.fetches);
    expect(c.waits).toBeGreaterThan(0);
    expect(n.waits).toBe(0);
  });

  it('caches errors for errorTtl then clears', () => {
    const layer = new CacheLayer(cfg({ ttlSec: 30, cacheErrors: { ttlSec: 2 } }), [{ n: 1, p: 1 }]);
    const lambda = Float64Array.of(20);
    let t = 0;
    tickOnce(layer, t++, lambda, 0.1, 0); // fetch fails
    let servedTicks = 0;
    let errs = 0;
    let sawEmptyAfter = false;
    for (let k = 0; k < 40; k++) {
      const r = tickOnce(layer, t++, lambda, 0.1, 1); // later fetches succeed
      errs += r.errorsServed;
      if (r.errorsServed > 0.5 * r.requests) servedTicks++;
      if (k > 30 && layer.state().errorCached === 0) sawEmptyAfter = true;
    }
    expect(errs).toBeGreaterThan(0);
    expect(servedTicks).toBeGreaterThanOrEqual(15);
    expect(servedTicks).toBeLessThanOrEqual(21);
    expect(sawEmptyAfter).toBe(true);
    expectConserved(layer, 1);
    // after a successful fetch the error is gone
    const ok = new CacheLayer(cfg({ cacheErrors: { ttlSec: 2 } }), [{ n: 1, p: 1 }]);
    tickOnce(ok, 0, lambda, 0.1, 1);
    expect(tickOnce(ok, 1, lambda, 0.1, 1).errorsServed).toBe(0);
  });

  it('unscheduled fetches auto-complete next tick with success', () => {
    const layer = new CacheLayer(cfg(), [{ n: 1, p: 1 }]);
    const lambda = Float64Array.of(50);
    layer.step(0, lambda); // never scheduled
    expect(layer.state().pending).toBeGreaterThan(0);
    layer.step(1, lambda);
    expect(layer.state().fresh).toBeGreaterThan(0.5);
    expectConserved(layer, 1);
  });

  it('staleIfError returns failed refreshes to stale', () => {
    const layer = new CacheLayer(cfg({ ttlSec: 2, swrSec: 100, staleIfErrorSec: 100 }), [
      { n: 1, p: 1 },
    ]);
    const lambda = Float64Array.of(30);
    let t = 0;
    for (; t < 100; t++) tickOnce(layer, t, lambda, 0.1, 1);
    for (; t < 400; t++) tickOnce(layer, t, lambda, 0.1, 0); // all refreshes fail
    const s = layer.state();
    expect(s.empty).toBeLessThan(0.01);
    expect(s.stale).toBeGreaterThan(0.9);
    expectConserved(layer, 1);
  });

  it('performance: 64 bins, 36000 steps', () => {
    const bins = Array.from({ length: 64 }, (_, i) => ({
      n: 1 + i * 100,
      p: 1 / 64 / (1 + i * 100),
    }));
    const layer = new CacheLayer(cfg({ ttlSec: 300, swrSec: 600, maxLatencySec: 2 }), bins);
    const lambda = new Float64Array(64);
    for (let b = 0; b < 64; b++) lambda[b] = 2000 / 64;
    const t0 = Date.now();
    for (let t = 0; t < 36000; t++) {
      const r = layer.step(t, lambda);
      layer.scheduleCompletions(t, r.originFetchesPerBin, t + 3, 1);
    }
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(1500);
    expectConserved(layer, 64);
  });
});
