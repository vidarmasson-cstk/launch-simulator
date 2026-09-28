/** Seeded PRNG (sfc32, seeded via a splitmix32 hash) with Poisson / Gamma / NegBinomial samplers. */

function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private spareNormal: number | null = null;

  constructor(seed: number) {
    const sm = splitmix32(Math.floor(seed));
    this.a = sm();
    this.b = sm();
    this.c = sm();
    this.d = sm();
    // Warm up to decorrelate from the seed.
    for (let i = 0; i < 12; i++) this.nextUint32();
  }

  /** sfc32 step; returns an unsigned 32-bit integer. */
  nextUint32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform in [0, 1). */
  uniform(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Standard normal (Box-Muller, with the spare value cached). */
  normal(): number {
    if (this.spareNormal !== null) {
      const v = this.spareNormal;
      this.spareNormal = null;
      return v;
    }
    let u = 0;
    while (u === 0) u = this.uniform();
    const v = this.uniform();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spareNormal = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  /** Poisson integer sample. Knuth for mean < 30, rounded normal approximation above. */
  poisson(mean: number): number {
    if (!(mean > 0)) return 0;
    if (mean < 30) {
      const limit = Math.exp(-mean);
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= this.uniform();
      } while (p > limit);
      return k - 1;
    }
    // Continuity correction: P(N = k) ~ Phi((k + 0.5 - mean)/sd) - Phi((k - 0.5 - mean)/sd)
    // is sampled by rounding mean + sd * Z to the nearest integer.
    const x = Math.round(mean + Math.sqrt(mean) * this.normal());
    return Math.max(0, x);
  }

  /** Gamma(shape, scale) via Marsaglia-Tsang. */
  gamma(shape: number, scale = 1): number {
    if (!(shape > 0) || !(scale > 0)) return 0;
    if (shape < 1) {
      // Boost: Gamma(a) = Gamma(a + 1) * U^(1/a)
      let u = 0;
      while (u === 0) u = this.uniform();
      return this.gamma(shape + 1, scale) * Math.pow(u, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        x = this.normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.uniform();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
      if (u > 0 && Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
    }
  }

  /**
   * Negative binomial with the given mean and dispersion k via Gamma-Poisson
   * (variance = mean + mean^2 / k). k = null (or non-finite) means plain Poisson.
   */
  negBinomial(mean: number, k: number | null): number {
    if (!(mean > 0)) return 0;
    if (k === null || !Number.isFinite(k) || k <= 0) return this.poisson(mean);
    const lambda = this.gamma(k, mean / k);
    return this.poisson(lambda);
  }
}

export function createRng(seed: number): Rng {
  return new Rng(seed);
}

// Free-function forms bound to an Rng instance, for call-site convenience.
export const uniform = (rng: Rng): number => rng.uniform();
export const poisson = (rng: Rng, mean: number): number => rng.poisson(mean);
export const gamma = (rng: Rng, shape: number, scale = 1): number => rng.gamma(shape, scale);
export const negBinomial = (rng: Rng, mean: number, k: number | null): number =>
  rng.negBinomial(mean, k);
