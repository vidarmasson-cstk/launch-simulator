import { describe, expect, it } from 'vitest';
import { LatencyHistogram } from '../src/model/latency';

const width = (v: number, bpd = 20) => v * (Math.pow(10, 1 / bpd) - 1);

describe('LatencyHistogram', () => {
  it('returns 0 when empty', () => {
    const h = new LatencyHistogram();
    expect(h.quantile(0.5)).toBe(0);
    expect(h.totalWeight()).toBe(0);
  });

  it('recovers quantiles of a mixture', () => {
    const h = new LatencyHistogram();
    h.add(30, 99);
    h.add(2000, 1);
    expect(Math.abs(h.quantile(0.5) - 30)).toBeLessThanOrEqual(width(30));
    expect(Math.abs(h.quantile(0.995) - 2000)).toBeLessThanOrEqual(width(2000));
    expect(h.totalWeight()).toBeCloseTo(100);
  });

  it('clamps values into range and handles fractional weights', () => {
    const h = new LatencyHistogram();
    h.add(0.001, 0.25);
    h.add(1e9, 0.75);
    expect(h.quantile(0.1)).toBeLessThanOrEqual(1.2);
    expect(h.quantile(0.99)).toBeGreaterThan(700000);
    expect(h.quantile(0.99)).toBeLessThanOrEqual(900000);
  });

  it('is monotone in q', () => {
    const h = new LatencyHistogram();
    for (let v = 1; v < 5000; v *= 1.3) h.add(v, 1);
    let prev = 0;
    for (let q = 0.01; q <= 1; q += 0.01) {
      const x = h.quantile(q);
      expect(x).toBeGreaterThanOrEqual(prev);
      prev = x;
    }
  });

  it('merges and resets', () => {
    const a = new LatencyHistogram();
    const b = new LatencyHistogram();
    a.add(10, 1);
    b.add(1000, 3);
    a.merge(b);
    expect(a.totalWeight()).toBe(4);
    expect(Math.abs(a.quantile(0.5) - 1000)).toBeLessThanOrEqual(width(1000));
    a.reset();
    expect(a.totalWeight()).toBe(0);
    expect(a.quantile(0.5)).toBe(0);
  });
});
