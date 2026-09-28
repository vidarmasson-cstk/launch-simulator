import type { IRetryRing, RetryDue, RetryPolicyConfig } from './types';

/** Retry policies + retry scheduling ring indexed by future tick and attempt (DESIGN 6.4). */
export class RetryRing implements IRetryRing {
  constructor(_config: RetryPolicyConfig) {
    throw new Error('not implemented');
  }
  scheduleRejected(_tick: number, _attempt: number, _amount: number): { finalFailures: number } {
    throw new Error('not implemented');
  }
  due(_tick: number): RetryDue[] {
    throw new Error('not implemented');
  }
  pending(): number {
    throw new Error('not implemented');
  }
  delayMs(_attempt: number): number {
    throw new Error('not implemented');
  }
}
