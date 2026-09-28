import type { ILatencyHistogram } from './types';

/**
 * Log-bucket latency histogram (DESIGN 6.8). Buckets are log-spaced from minMs to maxMs with
 * `bucketsPerDecade` buckets per factor of 10. Weights are fluid (fractional counts).
 * Quantiles interpolate log-linearly inside the bucket that contains the target rank, so a point
 * mass is reported within one bucket width of its true value.
 */
export class LatencyHistogram implements ILatencyHistogram {
  readonly minMs: number;
  readonly maxMs: number;
  readonly bucketsPerDecade: number;
  private readonly logMin: number;
  private readonly nBuckets: number;
  private counts: Float64Array;
  private total = 0;

  constructor(minMs = 1, maxMs = 900000, bucketsPerDecade = 20) {
    this.minMs = minMs;
    this.maxMs = maxMs;
    this.bucketsPerDecade = bucketsPerDecade;
    this.logMin = Math.log10(minMs);
    this.nBuckets = Math.max(1, Math.ceil((Math.log10(maxMs) - this.logMin) * bucketsPerDecade));
    this.counts = new Float64Array(this.nBuckets);
  }

  private bucketOf(valueMs: number): number {
    const v = Math.min(this.maxMs, Math.max(this.minMs, valueMs));
    const i = Math.floor((Math.log10(v) - this.logMin) * this.bucketsPerDecade);
    return Math.min(this.nBuckets - 1, Math.max(0, i));
  }

  add(valueMs: number, weight: number): void {
    if (!(weight > 0) || Number.isNaN(valueMs)) return;
    const b = this.bucketOf(valueMs);
    this.counts[b] = (this.counts[b] ?? 0) + weight;
    this.total += weight;
  }

  quantile(q: number): number {
    if (!(this.total > 0)) return 0;
    const target = Math.min(1, Math.max(0, q)) * this.total;
    let cum = 0;
    for (let i = 0; i < this.nBuckets; i++) {
      const c = this.counts[i] ?? 0;
      if (c > 0 && cum + c >= target) {
        const frac = Math.min(1, Math.max(0, (target - cum) / c));
        // Interpolate in log space between the bucket edges (frac = 0.5 is the geometric midpoint).
        return Math.min(
          this.maxMs,
          Math.pow(10, this.logMin + (i + frac) / this.bucketsPerDecade),
        );
      }
      cum += c;
    }
    return this.maxMs;
  }

  totalWeight(): number {
    return this.total;
  }

  /** Add another histogram's mass. Both must share the same bucket layout. */
  merge(other: LatencyHistogram): void {
    if (other.nBuckets !== this.nBuckets || other.logMin !== this.logMin) {
      throw new Error('LatencyHistogram.merge: incompatible bucket layouts');
    }
    for (let i = 0; i < this.nBuckets; i++) this.counts[i] = (this.counts[i] ?? 0) + (other.counts[i] ?? 0);
    this.total += other.total;
  }

  reset(): void {
    this.counts.fill(0);
    this.total = 0;
  }
}
