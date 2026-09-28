import type { Limiter, LimiterConfig, LimiterResult } from './types';

/**
 * Rate limiters (DESIGN 6.3). All counts are fluid (non-negative reals) and `step(tick, arrivals)`
 * must be called once per tick with consecutive tick numbers (time = tick * dtSec).
 *
 * Result semantics: `accepted` is everything let through this tick, INCLUDING previously queued
 * items released this tick. `rejected` is the part of THIS tick's arrivals that was refused (queued
 * items are never rejected once admitted). `queued` is the amount waiting after this tick.
 * Per tick: accepted + rejected + (queued_after - queued_before) = arrivals, so over a whole run
 * total accepted + total rejected + final queued = total arrivals.
 */
export function createLimiter(config: LimiterConfig): Limiter {
  switch (config.algorithm) {
    case 'fixedWindow':
      return new FixedWindowLimiter(config.limitRps, config.dtSec);
    case 'slidingWindow':
      return new SlidingWindowLimiter(config.limitRps, config.dtSec);
    case 'tokenBucket':
      return new TokenBucketLimiter(config.limitRps, config.capacity, config.dtSec);
    case 'gcra':
      return new GcraLimiter(
        config.limitRps,
        config.burstMultiplierPct,
        config.maxWaitMs,
        config.dtSec,
      );
  }
}

const windowTicks = (dtSec: number) => Math.max(1, Math.round(1 / dtSec));

const result = (accepted: number, rejected: number, queued = 0, delay = 0): LimiterResult => ({
  accepted,
  rejected,
  queued,
  avgQueueDelayMs: delay,
});

/**
 * 1 s window opened by the first tick with arrivals > 0 after the previous window ended (not
 * aligned to clock seconds). Accepts up to `limitRps` within the window, rejects the rest.
 * No carry-over and no queue.
 */
export class FixedWindowLimiter implements Limiter {
  private readonly w: number;
  private start = -Infinity;
  private count = 0;
  constructor(
    private readonly limitRps: number,
    dtSec: number,
  ) {
    this.w = windowTicks(dtSec);
  }
  step(tick: number, arrivals: number): LimiterResult {
    if (tick >= this.start + this.w) {
      if (arrivals <= 0) return result(0, 0);
      this.start = tick;
      this.count = 0;
    }
    const accepted = Math.max(0, Math.min(arrivals, this.limitRps - this.count));
    this.count += accepted;
    return result(accepted, arrivals - accepted);
  }
}

/**
 * Sliding window: accepts while (accepted in the previous round(1/dt)-1 ticks + accepted this
 * tick) <= limitRps. Ring buffer of accepted amounts.
 */
export class SlidingWindowLimiter implements Limiter {
  private readonly ring: Float64Array;
  private idx = 0;
  private total = 0;
  constructor(
    private readonly limitRps: number,
    dtSec: number,
  ) {
    this.ring = new Float64Array(windowTicks(dtSec));
  }
  step(_tick: number, arrivals: number): LimiterResult {
    const old = this.ring[this.idx] ?? 0; // accepted W ticks ago: outside the window
    const prev = Math.max(0, this.total - old);
    const accepted = Math.max(0, Math.min(arrivals, this.limitRps - prev));
    this.ring[this.idx] = accepted;
    this.total = Math.max(0, prev + accepted);
    this.idx = (this.idx + 1) % this.ring.length;
    return result(accepted, arrivals - accepted);
  }
}

/** Token bucket: starts full, refills rate*dt per tick up to capacity, accepts min(arrivals, tokens). */
export class TokenBucketLimiter implements Limiter {
  private tokens: number;
  constructor(
    private readonly rate: number,
    private readonly capacity: number,
    private readonly dtSec: number,
  ) {
    this.tokens = capacity;
  }
  step(_tick: number, arrivals: number): LimiterResult {
    this.tokens = Math.min(this.capacity, this.tokens + this.rate * this.dtSec);
    const accepted = Math.min(arrivals, this.tokens);
    this.tokens -= accepted;
    return result(accepted, arrivals - accepted);
  }
}

/**
 * Fluid GCRA with burst credit and optional FIFO queue.
 *
 * Burst credit B starts at burstCap = rate * tau, tau = max(0, burstMultiplierPct/100 - 1) s.
 * Per tick: demand = Q + arrivals; served = min(demand, rate*dt + B); B -= max(0, served - rate*dt);
 * unused base capacity refills B up to burstCap. The unserved remainder is taken from the old queue
 * first (FIFO). With maxWaitMs = 0 the remaining new arrivals are rejected; otherwise they join the
 * queue while Q/rate <= maxWaitMs/1000 and the overflow is rejected. avgQueueDelayMs = Q/rate * 1000.
 *
 * With burstMultiplierPct = 100 and maxWaitMs = 0 this is a smooth limit of rate*dt per tick,
 * intentionally smoother than FixedWindow (which lets a whole window's quota through in one tick).
 */
export class GcraLimiter implements Limiter {
  private readonly base: number;
  private readonly burstCap: number;
  private readonly maxQueue: number;
  private burst: number;
  private q = 0;
  constructor(
    private readonly rate: number,
    burstMultiplierPct: number,
    maxWaitMs: number,
    dtSec: number,
  ) {
    this.base = rate * dtSec;
    this.burstCap = rate * Math.max(0, burstMultiplierPct / 100 - 1);
    this.maxQueue = maxWaitMs > 0 ? (rate * maxWaitMs) / 1000 : 0;
    this.burst = this.burstCap;
  }
  step(_tick: number, arrivals: number): LimiterResult {
    const demand = this.q + arrivals;
    const served = Math.min(demand, this.base + this.burst);
    if (served > this.base) this.burst -= served - this.base;
    else this.burst = Math.min(this.burstCap, this.burst + (this.base - served));
    if (this.burst < 0) this.burst = 0;

    const oldRemaining = Math.max(0, this.q - served);
    const newRemaining = Math.max(0, demand - served - oldRemaining);
    const admitted = Math.min(newRemaining, Math.max(0, this.maxQueue - oldRemaining));
    this.q = oldRemaining + admitted;
    const delay = this.q > 0 && this.rate > 0 ? (this.q / this.rate) * 1000 : 0;
    return result(served, newRemaining - admitted, this.q, delay);
  }
}
