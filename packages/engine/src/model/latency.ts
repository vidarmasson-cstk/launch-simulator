import type { ILatencyHistogram } from './types';

/** Log-bucket latency histogram (DESIGN 6.8). */
export class LatencyHistogram implements ILatencyHistogram {
  constructor(_minMs?: number, _maxMs?: number, _bucketsPerDecade?: number) {
    throw new Error('not implemented');
  }
  add(_valueMs: number, _weight: number): void {
    throw new Error('not implemented');
  }
  quantile(_q: number): number {
    throw new Error('not implemented');
  }
  reset(): void {
    throw new Error('not implemented');
  }
}
