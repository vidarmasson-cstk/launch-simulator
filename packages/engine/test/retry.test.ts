import { describe, expect, it } from 'vitest';
import type { RetryPolicy } from '../src/schema';
import {
  RetryRing,
  expectedRetryWaitMs,
  finalFailureProbability,
  retryDelayMs,
} from '../src/model/retry';
import type { RetryPolicyConfig } from '../src/model/types';

const pol = (p: Partial<RetryPolicy>): RetryPolicy => ({
  kind: 'fixed',
  retries: 3,
  baseDelayMs: 300,
  capDelayMs: 5000,
  ...p,
});
const cfg = (
  p: Partial<RetryPolicy>,
  extra: Partial<RetryPolicyConfig> = {},
): RetryPolicyConfig => ({
  policy: pol(p),
  dtSec: 0.1,
  sdkRateLimitWaitMs: 1000,
  sdkAssumeRemainingHeader: true,
  ...extra,
});

/** Tick at which the (single) cohort scheduled at `tick` is returned. */
function landing(ring: RetryRing, from: number, upTo: number) {
  const hits: { tick: number; attempt: number; amount: number }[] = [];
  for (let t = from; t <= upTo; t++) for (const d of ring.due(t)) hits.push({ tick: t, ...d });
  return hits;
}

describe('RetryRing', () => {
  it('fixed delays land on exact ticks and attempts increment', () => {
    const ring = new RetryRing(cfg({ kind: 'fixed', baseDelayMs: 300 }));
    expect(ring.scheduleRejected(10, 0, 50).finalFailures).toBe(0);
    expect(ring.pending()).toBe(50);
    const hits = landing(ring, 11, 40);
    expect(hits).toEqual([{ tick: 13, attempt: 1, amount: 50 }]);
    expect(ring.pending()).toBe(0);
  });
  it('exponential with cap', () => {
    const c = cfg({ kind: 'exponential', retries: 5, baseDelayMs: 500, capDelayMs: 2000 });
    const ring = new RetryRing(c);
    expect([0, 1, 2, 3, 4].map((k) => ring.delayMs(k))).toEqual([500, 1000, 2000, 2000, 2000]);
    ring.scheduleRejected(0, 2, 10);
    expect(landing(ring, 1, 50)).toEqual([{ tick: 20, attempt: 3, amount: 10 }]);
  });
  it('jitter spreads evenly over the interval with correct total', () => {
    const ring = new RetryRing(
      cfg({ kind: 'exponentialJitter', retries: 3, baseDelayMs: 200, capDelayMs: 5000 }),
    );
    ring.scheduleRejected(0, 1, 100); // interval = 400 ms = 4 ticks
    const hits = landing(ring, 1, 30);
    expect(hits.map((h) => h.tick)).toEqual([1, 2, 3, 4]);
    for (const h of hits) {
      expect(h.attempt).toBe(2);
      expect(h.amount).toBeCloseTo(25, 9);
    }
    expect(ring.delayMs(1)).toBe(200);
    expect(ring.pending()).toBeCloseTo(0, 9);
  });
  it('jitter with tiny interval still schedules at least 1 tick ahead', () => {
    const ring = new RetryRing(cfg({ kind: 'exponentialJitter', baseDelayMs: 10 }));
    ring.scheduleRejected(5, 0, 8);
    expect(landing(ring, 6, 20)).toEqual([{ tick: 6, attempt: 1, amount: 8 }]);
  });
  it('sdkDefault with and without the remaining header', () => {
    const withH = new RetryRing(
      cfg({ kind: 'sdkDefault', retries: 5, baseDelayMs: 300 }, { sdkAssumeRemainingHeader: true }),
    );
    withH.scheduleRejected(0, 0, 1);
    expect(landing(withH, 1, 30)[0]?.tick).toBe(10);
    const without = new RetryRing(
      cfg(
        { kind: 'sdkDefault', retries: 5, baseDelayMs: 300 },
        { sdkAssumeRemainingHeader: false },
      ),
    );
    without.scheduleRejected(0, 0, 1);
    expect(landing(without, 1, 30)[0]?.tick).toBe(3);
    expect(without.delayMs(4)).toBe(300);
    expect(without.scheduleRejected(0, 5, 2).finalFailures).toBe(2);
  });
  it('none => immediate final failure', () => {
    const ring = new RetryRing(cfg({ kind: 'none', retries: 5 }));
    expect(ring.scheduleRejected(0, 0, 7).finalFailures).toBe(7);
    expect(ring.pending()).toBe(0);
    expect(ring.due(1)).toEqual([]);
  });
  it('conservation: scheduled = final failures + due + pending', () => {
    const ring = new RetryRing(
      cfg({ kind: 'exponentialJitter', retries: 4, baseDelayMs: 100, capDelayMs: 1000 }),
    );
    let scheduled = 0;
    let finals = 0;
    let returned = 0;
    for (let t = 0; t < 100; t++) {
      for (const d of ring.due(t)) returned += d.amount;
      const attempt = t % 6; // includes attempts >= retries (final failures)
      finals += ring.scheduleRejected(t, attempt, 13.7).finalFailures;
      scheduled += 13.7;
      if (t === 50) expect(scheduled).toBeCloseTo(finals + returned + ring.pending(), 6);
    }
    expect(scheduled).toBeCloseTo(finals + returned + ring.pending(), 6);
    for (let t = 100; t < 130; t++) for (const d of ring.due(t)) returned += d.amount;
    expect(ring.pending()).toBeCloseTo(0, 6);
    expect(scheduled).toBeCloseTo(finals + returned, 6);
  });
});

describe('helpers', () => {
  it('finalFailureProbability', () => {
    expect(finalFailureProbability(0.5, 3)).toBeCloseTo(0.0625, 12);
    expect(finalFailureProbability(0.3, 0)).toBeCloseTo(0.3, 12);
  });
  it('expectedRetryWaitMs', () => {
    const c = cfg({ kind: 'exponential', retries: 3, baseDelayMs: 100, capDelayMs: 10000 });
    const p = 0.5;
    const expected = 0.5 * 100 + 0.25 * 200 + 0.125 * 400;
    expect(expectedRetryWaitMs(p, c.policy, c)).toBeCloseTo(expected, 9);
    expect(expectedRetryWaitMs(p, pol({ kind: 'none' }), c)).toBe(0);
    expect(retryDelayMs(pol({ kind: 'exponentialJitter', baseDelayMs: 100 }), 1, c)).toBe(100);
  });
});
