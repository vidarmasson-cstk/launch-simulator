import type { Limiter, LimiterConfig, LimiterResult } from './types';

/** Fixed/sliding window, token bucket and GCRA-with-queue limiters (DESIGN 6.3). */
export function createLimiter(_config: LimiterConfig): Limiter {
  throw new Error('not implemented');
}

export class FixedWindowLimiter implements Limiter {
  constructor(_limitRps: number, _dtSec: number) {
    throw new Error('not implemented');
  }
  step(_tick: number, _arrivals: number): LimiterResult {
    throw new Error('not implemented');
  }
}

export class SlidingWindowLimiter implements Limiter {
  constructor(_limitRps: number, _dtSec: number) {
    throw new Error('not implemented');
  }
  step(_tick: number, _arrivals: number): LimiterResult {
    throw new Error('not implemented');
  }
}

export class TokenBucketLimiter implements Limiter {
  constructor(_rate: number, _capacity: number, _dtSec: number) {
    throw new Error('not implemented');
  }
  step(_tick: number, _arrivals: number): LimiterResult {
    throw new Error('not implemented');
  }
}

export class GcraLimiter implements Limiter {
  constructor(_rate: number, _burstMultiplierPct: number, _maxWaitMs: number, _dtSec: number) {
    throw new Error('not implemented');
  }
  step(_tick: number, _arrivals: number): LimiterResult {
    throw new Error('not implemented');
  }
}
