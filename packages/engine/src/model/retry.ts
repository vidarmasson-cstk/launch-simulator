import type { RetryPolicy } from '../schema';
import type { IRetryRing, RetryDue, RetryPolicyConfig } from './types';

/** Number of retries a policy allows (`none` = 0). */
function retryCount(policy: RetryPolicy): number {
  if (policy.kind === 'none') return 0;
  return Math.min(20, Math.max(0, Math.floor(policy.retries)));
}

/**
 * Delay in ms before the retry following failed attempt `attempt` (0 = original request).
 * Expected value for exponentialJitter (half of the Full Jitter interval).
 */
export function retryDelayMs(
  policy: RetryPolicy,
  attempt: number,
  cfg: Pick<RetryPolicyConfig, 'sdkRateLimitWaitMs' | 'sdkAssumeRemainingHeader'>,
): number {
  switch (policy.kind) {
    case 'none':
      return 0;
    case 'fixed':
      return policy.baseDelayMs;
    case 'exponential':
      return Math.min(policy.capDelayMs, policy.baseDelayMs * 2 ** attempt);
    case 'exponentialJitter':
      return Math.min(policy.capDelayMs, policy.baseDelayMs * 2 ** attempt) / 2;
    case 'sdkDefault':
      return cfg.sdkAssumeRemainingHeader ? cfg.sdkRateLimitWaitMs : policy.baseDelayMs;
  }
}

/** Full extent (ms) of the delay interval after failed attempt k (jitter: upper bound). */
function intervalMs(policy: RetryPolicy, attempt: number, cfg: RetryPolicyConfig): number {
  if (policy.kind === 'exponentialJitter') {
    return Math.min(policy.capDelayMs, policy.baseDelayMs * 2 ** attempt);
  }
  return retryDelayMs(policy, attempt, cfg);
}

/** Expected extra latency per call: sum_{k=0}^{retries-1} p429^(k+1) * delayMs(k). */
export function expectedRetryWaitMs(
  p429: number,
  policy: RetryPolicy,
  cfg: RetryPolicyConfig,
): number {
  const n = retryCount(policy);
  let sum = 0;
  for (let k = 0; k < n; k++) sum += p429 ** (k + 1) * retryDelayMs(policy, k, cfg);
  return sum;
}

/** Probability that a call still fails after all retries: p429^(retries+1). */
export function finalFailureProbability(p429: number, retries: number): number {
  return p429 ** (retries + 1);
}

/**
 * Retry scheduling ring indexed by future tick, with per-attempt amounts per slot.
 * The original request is attempt 0; retries are attempts 1..retries. Delays are converted to ticks
 * as max(1, round(delayMs / 1000 / dt)). exponentialJitter spreads the amount evenly across the
 * ticks covering [0, interval] (at least 1 tick ahead).
 */
export class RetryRing implements IRetryRing {
  private readonly policy: RetryPolicy;
  private readonly cfg: RetryPolicyConfig;
  private readonly retries: number;
  private readonly stride: number;
  private readonly size: number;
  private readonly slots: Float64Array;
  private total = 0;

  constructor(config: RetryPolicyConfig) {
    this.cfg = config;
    this.policy = config.policy;
    this.retries = retryCount(config.policy);
    this.stride = this.retries + 1;
    let maxMs = 0;
    for (let k = 0; k < this.retries; k++)
      maxMs = Math.max(maxMs, intervalMs(this.policy, k, config));
    this.size = this.ticks(maxMs) + 2;
    this.slots = new Float64Array(this.size * this.stride);
  }

  private ticks(ms: number): number {
    return Math.max(1, Math.round(ms / 1000 / this.cfg.dtSec));
  }

  scheduleRejected(tick: number, attempt: number, amount: number): { finalFailures: number } {
    if (!(amount > 0)) return { finalFailures: 0 };
    if (attempt >= this.retries) return { finalFailures: amount };
    const next = attempt + 1;
    if (this.policy.kind === 'exponentialJitter') {
      const n = this.ticks(intervalMs(this.policy, attempt, this.cfg));
      const share = amount / n;
      for (let i = 1; i <= n; i++) {
        const j = ((tick + i) % this.size) * this.stride + next;
        this.slots[j] = (this.slots[j] ?? 0) + share;
      }
    } else {
      const d = this.ticks(retryDelayMs(this.policy, attempt, this.cfg));
      const j = ((tick + d) % this.size) * this.stride + next;
      this.slots[j] = (this.slots[j] ?? 0) + amount;
    }
    this.total += amount;
    return { finalFailures: 0 };
  }

  due(tick: number): RetryDue[] {
    const base = (tick % this.size) * this.stride;
    const out: RetryDue[] = [];
    for (let a = 1; a < this.stride; a++) {
      const amt = this.slots[base + a] ?? 0;
      if (amt > 0) {
        out.push({ attempt: a, amount: amt });
        this.total -= amt;
      }
      this.slots[base + a] = 0;
    }
    if (out.length === 0 && this.total < 1e-9) this.total = 0;
    return out;
  }

  pending(): number {
    return Math.max(0, this.total);
  }

  delayMs(attempt: number): number {
    return retryDelayMs(this.policy, attempt, this.cfg);
  }
}
