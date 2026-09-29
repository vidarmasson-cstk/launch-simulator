import { describe, expect, it } from 'vitest';
import {
  FixedWindowLimiter,
  GcraLimiter,
  SlidingWindowLimiter,
  TokenBucketLimiter,
  createLimiter,
} from '../src/model/limiters';

const DT = 0.1;

describe('FixedWindowLimiter', () => {
  it('accepts 100 of 683 in one tick, then nothing for the rest of the window', () => {
    const l = new FixedWindowLimiter(100, DT);
    const r = l.step(0, 683);
    expect(r.accepted).toBe(100);
    expect(r.rejected).toBe(583);
    for (let t = 1; t < 10; t++) expect(l.step(t, 10).accepted).toBe(0);
    expect(l.step(10, 50).accepted).toBe(50);
  });
  it('anchors the window to the first arrival', () => {
    const l = new FixedWindowLimiter(100, DT);
    for (let t = 0; t < 5; t++) expect(l.step(t, 0).accepted).toBe(0);
    expect(l.step(5, 100).accepted).toBe(100);
    for (let t = 6; t <= 14; t++) expect(l.step(t, 10).accepted).toBe(0);
    expect(l.step(15, 10).accepted).toBe(10);
  });
});

describe('SlidingWindowLimiter', () => {
  it('long-run accepted ~ limit under steady overload', () => {
    const l = createLimiter({ algorithm: 'slidingWindow', limitRps: 100, dtSec: DT });
    let acc = 0;
    for (let t = 0; t < 600; t++) acc += l.step(t, 15).accepted;
    expect(acc / 60).toBeGreaterThan(98);
    expect(acc / 60).toBeLessThanOrEqual(100.5);
  });
  it('never exceeds the limit in any 10-tick window', () => {
    const l = new SlidingWindowLimiter(100, DT);
    const a: number[] = [];
    for (let t = 0; t < 200; t++) a.push(l.step(t, t % 7 === 0 ? 80 : 5).accepted);
    for (let i = 0; i + 10 <= a.length; i++) {
      expect(a.slice(i, i + 10).reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(100 + 1e-9);
    }
  });
});

describe('TokenBucketLimiter', () => {
  it('accepts a full bucket on a burst', () => {
    const l = new TokenBucketLimiter(200, 200, DT);
    expect(l.step(0, 300).accepted).toBe(200);
  });
  it('steady 250 rps -> ~200/s', () => {
    const l = new TokenBucketLimiter(200, 200, DT);
    let acc = 0;
    for (let t = 0; t < 1200; t++) acc += l.step(t, 25).accepted;
    expect(acc / 120).toBeGreaterThan(199);
    expect(acc / 120).toBeLessThan(203);
  });
});

describe('GcraLimiter', () => {
  it('150% burst absorbs a 1 s spike of 145 rps when idle before', () => {
    const l = new GcraLimiter(100, 150, 0, DT);
    for (let t = 0; t < 50; t++) l.step(t, 0);
    let rej = 0;
    let acc = 0;
    for (let t = 50; t < 60; t++) {
      const r = l.step(t, 14.5);
      rej += r.rejected;
      acc += r.accepted;
    }
    expect(rej).toBeCloseTo(0, 9);
    expect(acc).toBeCloseTo(145, 9);
  });
  it('100% burst, no wait: smooth rate*dt per tick', () => {
    const l = new GcraLimiter(100, 100, 0, DT);
    const r = l.step(0, 100);
    expect(r.accepted).toBeCloseTo(10, 9);
    expect(r.rejected).toBeCloseTo(90, 9);
  });
  it('maxWaitMs turns rejections into queue delay; rejects start once wait > 5 s', () => {
    const l = new GcraLimiter(100, 100, 5000, DT);
    let firstReject = -1;
    let maxDelay = 0;
    let acc = 0;
    let rej = 0;
    const N = 1200;
    let last = { queued: 0 } as { queued: number };
    for (let t = 0; t < N; t++) {
      const r = l.step(t, 12);
      acc += r.accepted;
      rej += r.rejected;
      last = r;
      maxDelay = Math.max(maxDelay, r.avgQueueDelayMs);
      if (r.rejected > 1e-9 && firstReject < 0) firstReject = t;
    }
    expect(firstReject * DT).toBeGreaterThanOrEqual(24);
    expect(firstReject * DT).toBeLessThanOrEqual(26);
    expect(maxDelay).toBeLessThanOrEqual(5000 + 1e-6);
    expect(acc + rej + last.queued).toBeCloseTo(12 * N, 6);
  });
  it('295 in one second: fixed window ~100, GCRA 250%/2000ms >= 240', () => {
    const fw = new FixedWindowLimiter(100, DT);
    const g = new GcraLimiter(100, 250, 2000, DT);
    let a1 = 0;
    let a2 = 0;
    for (let t = 0; t < 10; t++) {
      a1 += fw.step(t, 29.5).accepted;
      a2 += g.step(t, 29.5).accepted;
    }
    expect(a1).toBeCloseTo(100, 9);
    expect(a2).toBeGreaterThanOrEqual(240);
  });
  it('conservation with burst and queue under a varying load', () => {
    const l = createLimiter({
      algorithm: 'gcra',
      limitRps: 100,
      burstMultiplierPct: 200,
      maxWaitMs: 1000,
      dtSec: DT,
    });
    let arr = 0;
    let acc = 0;
    let rej = 0;
    let q = 0;
    for (let t = 0; t < 500; t++) {
      const a = t % 50 < 10 ? 40 : 3;
      const r = l.step(t, a);
      arr += a;
      acc += r.accepted;
      rej += r.rejected;
      q = r.queued;
    }
    expect(acc + rej + q).toBeCloseTo(arr, 6);
  });
});
