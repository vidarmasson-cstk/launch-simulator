import { describe, expect, it } from 'vitest';
import { bucketSize, downsample } from './downsample';

describe('downsample', () => {
  it('keeps short series untouched', () => {
    const s = { length: 3, columns: { cms429: new Float32Array([1, 2, 3]) } };
    expect(downsample(s, ['cms429']).map((r) => r.cms429)).toEqual([1, 2, 3]);
  });
  it('keeps spikes for peak columns and averages ratios', () => {
    const n = 4800;
    const spike = new Float32Array(n);
    spike[1234] = 500;
    const hit = new Float32Array(n).fill(0.5);
    const rows = downsample({ length: n, columns: { cms429: spike, launchHitRatio: hit } }, [
      'cms429',
      'launchHitRatio',
    ]);
    expect(bucketSize(n)).toBe(4);
    expect(rows.length).toBeLessThanOrEqual(1200);
    expect(Math.max(...rows.map((r) => r.cms429!))).toBe(500);
    expect(rows[0]!.launchHitRatio).toBeCloseTo(0.5);
  });
});
