import { describe, expect, it } from 'vitest';
import { binsFromUniform, buildPopularityBins, topKeysShare } from '../src/model/popularity';

const mass = (bins: { n: number; p: number }[]) => bins.reduce((s, b) => s + b.n * b.p, 0);
const keys = (bins: { n: number; p: number }[]) => bins.reduce((s, b) => s + b.n, 0);

describe('buildPopularityBins', () => {
  const cfg = {
    pages: 5000,
    locales: 12,
    variants: 3,
    zipfAlpha: 0.8,
    localeZipfAlpha: 1.1,
  };

  it('conserves probability mass and key count', () => {
    const bins = buildPopularityBins(cfg);
    expect(Math.abs(mass(bins) - 1)).toBeLessThan(1e-9);
    expect(keys(bins)).toBeCloseTo(5000 * 12 * 3, 6);
  });

  it('top bin equals the exact rank-1 probability and bins are sorted', () => {
    const bins = buildPopularityBins(cfg);
    let zp = 0;
    for (let i = 1; i <= cfg.pages; i++) zp += Math.pow(i, -cfg.zipfAlpha);
    let zl = 0;
    for (let j = 1; j <= cfg.locales; j++) zl += Math.pow(j, -cfg.localeZipfAlpha);
    expect(bins[0]!.n).toBe(1);
    expect(bins[0]!.p).toBeCloseTo(1 / zp / zl / cfg.variants, 14);
    for (let i = 1; i < bins.length; i++) expect(bins[i]!.p).toBeLessThanOrEqual(bins[i - 1]!.p);
  });

  it('respects maxBins and topRanks', () => {
    const bins = buildPopularityBins({ ...cfg, maxBins: 20, topRanks: 8 });
    expect(bins.length).toBeLessThanOrEqual(20);
    expect(bins.filter((b) => b.n === 1).length).toBeGreaterThanOrEqual(8);
    expect(Math.abs(mass(bins) - 1)).toBeLessThan(1e-9);
    expect(buildPopularityBins(cfg).length).toBeLessThanOrEqual(64);
    expect(buildPopularityBins({ ...cfg, maxBins: 1 })).toHaveLength(1);
  });

  it('alpha 0 gives equal probabilities', () => {
    const bins = buildPopularityBins({
      pages: 1000,
      locales: 5,
      variants: 2,
      zipfAlpha: 0,
      localeZipfAlpha: 0,
    });
    for (const b of bins) expect(b.p).toBeCloseTo(1 / 10000, 14);
    expect(bins.filter((b) => b.n > 1)).toHaveLength(1);
    expect(Math.abs(mass(bins) - 1)).toBeLessThan(1e-9);
  });

  it('handles tiny key spaces', () => {
    const bins = buildPopularityBins({
      pages: 1,
      locales: 1,
      variants: 1,
      zipfAlpha: 0.8,
      localeZipfAlpha: 0,
    });
    expect(bins).toEqual([{ n: 1, p: 1 }]);
    const b2 = buildPopularityBins({
      pages: 3,
      locales: 2,
      variants: 1,
      zipfAlpha: 1,
      localeZipfAlpha: 1,
    });
    expect(keys(b2)).toBe(6);
    expect(Math.abs(mass(b2) - 1)).toBeLessThan(1e-9);
  });

  it('is fast for 1e6 pages x 150 locales', () => {
    const t0 = Date.now();
    const bins = buildPopularityBins({
      pages: 1_000_000,
      locales: 150,
      variants: 1,
      zipfAlpha: 0.8,
      localeZipfAlpha: 1,
    });
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(500);
    expect(bins.length).toBeLessThanOrEqual(64);
    expect(Math.abs(mass(bins) - 1)).toBeLessThan(1e-9);
    expect(keys(bins)).toBeCloseTo(1.5e8, 0);
  });
});

describe('helpers', () => {
  it('binsFromUniform', () => {
    expect(binsFromUniform(200)).toEqual([{ n: 200, p: 1 / 200 }]);
  });
  it('topKeysShare', () => {
    expect(topKeysShare(binsFromUniform(100), 0.5)).toBe(50);
    const bins = buildPopularityBins({
      pages: 10000,
      locales: 1,
      variants: 1,
      zipfAlpha: 1,
      localeZipfAlpha: 0,
    });
    const k50 = topKeysShare(bins, 0.5);
    const k90 = topKeysShare(bins, 0.9);
    expect(k50).toBeGreaterThan(0);
    expect(k90).toBeGreaterThan(k50);
    expect(topKeysShare(bins, 1)).toBeCloseTo(10000, -1);
    expect(topKeysShare(bins, 0)).toBe(0);
  });
});
