import { describe, expect, it } from 'vitest';
import { Rng } from '../src/rng';

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const variance = (xs: number[]) => {
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
};

describe('Rng', () => {
  it('is deterministic by seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const c = new Rng(43);
    const sa = Array.from({ length: 20 }, () => a.uniform());
    const sb = Array.from({ length: 20 }, () => b.uniform());
    const sc = Array.from({ length: 20 }, () => c.uniform());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
  });

  it('uniform stays in [0,1) with mean ~0.5', () => {
    const r = new Rng(1);
    const xs = Array.from({ length: 50000 }, () => r.uniform());
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(mean(xs)).toBeCloseTo(0.5, 1);
  });

  it.each([0.5, 5, 29, 30, 100, 2000])('poisson(%d) returns integers with the right mean', (m) => {
    const r = new Rng(7);
    const xs = Array.from({ length: 40000 }, () => r.poisson(m));
    expect(xs.every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
    expect(Math.abs(mean(xs) - m) / m).toBeLessThan(0.03);
    expect(Math.abs(variance(xs) - m) / m).toBeLessThan(0.1);
  });

  it('poisson of non-positive mean is 0', () => {
    const r = new Rng(1);
    expect(r.poisson(0)).toBe(0);
    expect(r.poisson(-3)).toBe(0);
  });

  it.each([
    [0.5, 2],
    [2, 3],
    [9, 0.5],
  ])('gamma(%d, %d) has mean shape*scale and variance shape*scale^2', (shape, scale) => {
    const r = new Rng(11);
    const xs = Array.from({ length: 60000 }, () => r.gamma(shape, scale));
    expect(Math.abs(mean(xs) - shape * scale) / (shape * scale)).toBeLessThan(0.03);
    expect(Math.abs(variance(xs) - shape * scale * scale) / (shape * scale * scale)).toBeLessThan(
      0.1,
    );
  });

  it('negBinomial has the requested mean and over-dispersion', () => {
    const r = new Rng(5);
    const m = 20;
    const k = 2;
    const xs = Array.from({ length: 60000 }, () => r.negBinomial(m, k));
    expect(Math.abs(mean(xs) - m) / m).toBeLessThan(0.03);
    const expectedVar = m + (m * m) / k;
    expect(Math.abs(variance(xs) - expectedVar) / expectedVar).toBeLessThan(0.1);
  });

  it('negBinomial with k = null is Poisson', () => {
    const r = new Rng(5);
    const xs = Array.from({ length: 40000 }, () => r.negBinomial(10, null));
    expect(Math.abs(variance(xs) - 10) / 10).toBeLessThan(0.1);
  });
});
