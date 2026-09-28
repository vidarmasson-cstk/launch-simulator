import type {
  CacheLayerConfig,
  CacheLayerState,
  CacheStepResult,
  ICacheLayer,
  PopularityBin,
} from './types';

/** Steady-state hit ratio of a fixed-from-fill TTL cache under Poisson arrivals at per-key rate r. */
export function analyticHitRatio(r: number, ttlSec: number): number {
  if (!(r > 0)) return 0;
  if (!Number.isFinite(ttlSec)) return 1;
  const rt = r * ttlSec;
  return rt / (1 + rt);
}

/** Per-bin fractions (of that bin's keys) for inspection and tests. Sums to 1. */
export interface CacheBinState extends CacheLayerState {
  pendingStale: number;
}

const RENORM_SCALE = 1e-4;
const EPS = 1e-13;

function ringLen(sec: number, dt: number): number {
  return Math.max(1, Math.ceil(sec / dt - 1e-9));
}

/**
 * Generic fluid TTL cache (DESIGN 6.2): SWR, request collapsing, purge, error caching.
 *
 * Rings are indexed by birth tick modulo length, so aging is O(1) per bin per tick: the slot
 * `tick % len` holds exactly the cohort that reaches its limit at this tick.
 *
 * Approximations / conventions:
 * - The stale ring is drained by requests (`q` per tick) and by purges through a lazy per-bin
 *   scale factor, renormalised over the dirty slot range only when it gets small.
 * - Provisional pending keys created by `step` that the pipeline does not schedule (fully) via
 *   `scheduleCompletions` are auto-completed at the start of the next step with success = 1.
 * - A failed refresh of a pendingStale key with `staleIfErrorSec > 0` returns to stale with its
 *   stale age restarted at 0 (simplification). Without a stale ring it is treated like a failed
 *   blocking fetch.
 * - `collapsedWaits` counts only requests arriving while a fetch for the key is already pending
 *   (they are also included in `blockingMisses`).
 * - The `originFetchesPerBin` array returned by `step` is freshly allocated on every call.
 */
export class CacheLayer implements ICacheLayer {
  private readonly cfg: CacheLayerConfig;
  private readonly B: number;
  private readonly N: Float64Array;
  private readonly dt: number;

  private readonly scalarFresh: boolean;
  private readonly Lf: number;
  private readonly Ls: number;
  private readonly Le: number;
  private readonly R: number;
  private readonly errorsOn: boolean;
  private readonly staleIfError: boolean;

  private readonly fresh: Float64Array;
  private readonly stale: Float64Array;
  private readonly err: Float64Array;
  private readonly pbAmt: Float64Array;
  private readonly pbOk: Float64Array;
  private readonly psAmt: Float64Array;
  private readonly psOk: Float64Array;

  // per-bin scalars
  private readonly empty: Float64Array;
  private readonly freshSum: Float64Array;
  private readonly staleSum: Float64Array;
  private readonly staleScale: Float64Array;
  private readonly staleDirty: Float64Array;
  private readonly errSum: Float64Array;
  private readonly pendB: Float64Array;
  private readonly pendS: Float64Array;
  // provisional (this tick) moves and scheduling bookkeeping
  private readonly prov0B: Float64Array;
  private readonly prov0S: Float64Array;
  private readonly sched: Float64Array;
  private fetchTot: Float64Array;

  private lastTick = 0;
  private lastRequests = 0;
  private lastHits = 0;

  constructor(config: CacheLayerConfig, bins: PopularityBin[]) {
    this.cfg = config;
    const dt = config.dtSec;
    this.dt = dt;
    const B = bins.length;
    this.B = B;
    this.N = new Float64Array(B);
    for (let b = 0; b < B; b++) this.N[b] = bins[b]!.n * Math.max(1, config.domains);

    const horizon = config.durationSec + 2 * dt;
    this.scalarFresh = !Number.isFinite(config.ttlSec) || config.ttlSec >= config.durationSec;
    this.Lf = this.scalarFresh ? 0 : ringLen(config.ttlSec, dt);
    this.Ls = config.swrSec > 0 ? ringLen(Math.min(config.swrSec, horizon), dt) : 0;
    this.errorsOn = !!config.cacheErrors && config.cacheErrors.ttlSec > 0;
    this.Le = this.errorsOn ? ringLen(Math.min(config.cacheErrors!.ttlSec, horizon), dt) : 0;
    this.staleIfError = config.staleIfErrorSec > 0 && this.Ls > 0;
    this.R = Math.ceil(config.maxLatencySec / dt - 1e-9) + 2;

    this.fresh = new Float64Array(B * this.Lf);
    this.stale = new Float64Array(B * this.Ls);
    this.err = new Float64Array(B * this.Le);
    const RB = B * this.R;
    this.pbAmt = new Float64Array(RB);
    this.pbOk = new Float64Array(RB);
    this.psAmt = new Float64Array(RB);
    this.psOk = new Float64Array(RB);

    this.empty = new Float64Array(B).fill(1);
    this.freshSum = new Float64Array(B);
    this.staleSum = new Float64Array(B);
    this.staleScale = new Float64Array(B).fill(1);
    this.staleDirty = new Float64Array(B).fill(-1);
    this.errSum = new Float64Array(B);
    this.pendB = new Float64Array(B);
    this.pendS = new Float64Array(B);
    this.prov0B = new Float64Array(B);
    this.prov0S = new Float64Array(B);
    this.sched = new Float64Array(B);
    this.fetchTot = new Float64Array(B);
  }

  // ---- helpers ----

  private addFresh(b: number, x: number, slotF: number): void {
    if (x === 0) return;
    if (!this.scalarFresh) this.fresh[b * this.Lf + slotF] = this.fresh[b * this.Lf + slotF]! + x;
    this.freshSum[b] = this.freshSum[b]! + x;
  }

  private addStale(b: number, x: number, slotS: number, tick: number): void {
    if (x === 0) return;
    this.stale[b * this.Ls + slotS] = this.stale[b * this.Ls + slotS]! + x / this.staleScale[b]!;
    this.staleSum[b] = this.staleSum[b]! + x;
    if (this.staleDirty[b]! < 0) this.staleDirty[b] = tick;
  }

  /** Multiply (or zero) the stale ring over the slots that may be non-zero. */
  private renormStale(b: number, clear: boolean): void {
    const Ls = this.Ls;
    const start = this.staleDirty[b]!;
    if (start >= 0) {
      const len = Math.min(Ls, this.lastTick - start + 1);
      const scale = this.staleScale[b]!;
      const base = b * Ls;
      for (let k = 0; k < len; k++) {
        const idx = base + ((this.lastTick - k) % Ls);
        this.stale[idx] = clear ? 0 : this.stale[idx]! * scale;
      }
    }
    this.staleScale[b] = 1;
    if (clear) {
      this.empty[b] = this.empty[b]! + this.staleSum[b]!;
      this.staleSum[b] = 0;
      this.staleDirty[b] = -1;
    }
  }

  private drainStale(b: number, fraction: number): void {
    // moves `fraction` of stale keys out (caller re-books them elsewhere)
    this.staleSum[b] = this.staleSum[b]! * (1 - fraction);
    this.staleScale[b] = this.staleScale[b]! * (1 - fraction);
    if (this.staleScale[b]! < RENORM_SCALE) {
      this.renormStale(b, this.staleSum[b]! < EPS);
    }
  }

  private addError(b: number, x: number, slotE: number): void {
    if (x === 0) return;
    this.err[b * this.Le + slotE] = this.err[b * this.Le + slotE]! + x;
    this.errSum[b] = this.errSum[b]! + x;
  }

  // ---- ICacheLayer ----

  step(tick: number, lambdaPerBin: Float64Array): CacheStepResult {
    const { B, N, dt, Lf, Ls, Le, R, cfg } = this;
    const sf = Lf > 0 ? tick % Lf : 0;
    const ss = Ls > 0 ? tick % Ls : 0;
    const se = Le > 0 ? tick % Le : 0;
    const sr = tick % R;
    this.lastTick = tick;
    const collapse = cfg.collapse;
    const fetches = new Float64Array(B);

    let requests = 0;
    let hits = 0;
    let staleHits = 0;
    let blocking = 0;
    let collapsed = 0;
    let errorsServed = 0;

    for (let b = 0; b < B; b++) {
      const rb = b * R + sr;

      // 0. auto-schedule leftovers from the previous tick (success = 1).
      const rem = 1 - this.sched[b]!;
      if (rem > 1e-15) {
        const kb = this.prov0B[b]! * rem;
        const ks = this.prov0S[b]! * rem;
        this.pbAmt[rb] = this.pbAmt[rb]! + kb;
        this.pbOk[rb] = this.pbOk[rb]! + kb;
        this.psAmt[rb] = this.psAmt[rb]! + ks;
        this.psOk[rb] = this.psOk[rb]! + ks;
      }
      this.prov0B[b] = 0;
      this.prov0S[b] = 0;
      this.sched[b] = 0;

      // 1. aging
      if (Ls > 0) {
        const si = b * Ls + ss;
        const x = this.stale[si]! * this.staleScale[b]!;
        if (this.stale[si] !== 0) {
          this.stale[si] = 0;
          this.staleSum[b] = this.staleSum[b]! - x;
          this.empty[b] = this.empty[b]! + x;
        }
      }
      if (Lf > 0) {
        const fi = b * Lf + sf;
        const y = this.fresh[fi]!;
        if (y !== 0) {
          this.fresh[fi] = 0;
          this.freshSum[b] = this.freshSum[b]! - y;
          if (Ls > 0) this.addStale(b, y, ss, tick);
          else this.empty[b] = this.empty[b]! + y;
        }
      }
      if (Le > 0) {
        const ei = b * Le + se;
        const z = this.err[ei]!;
        if (z !== 0) {
          this.err[ei] = 0;
          this.errSum[b] = this.errSum[b]! - z;
          this.empty[b] = this.empty[b]! + z;
        }
      }

      // 2. completions due now
      {
        const a = this.pbAmt[rb]!;
        if (a !== 0) {
          const ok = this.pbOk[rb]!;
          const fail = a - ok;
          this.pbAmt[rb] = 0;
          this.pbOk[rb] = 0;
          this.pendB[b] = this.pendB[b]! - a;
          this.addFresh(b, ok, sf);
          if (this.errorsOn) this.addError(b, fail, se);
          else this.empty[b] = this.empty[b]! + fail;
        }
        const a2 = this.psAmt[rb]!;
        if (a2 !== 0) {
          const ok = this.psOk[rb]!;
          const fail = a2 - ok;
          this.psAmt[rb] = 0;
          this.psOk[rb] = 0;
          this.pendS[b] = this.pendS[b]! - a2;
          this.addFresh(b, ok, sf);
          if (this.staleIfError) this.addStale(b, fail, ss, tick);
          else if (this.errorsOn) this.addError(b, fail, se);
          else this.empty[b] = this.empty[b]! + fail;
        }
      }

      // 3. classify requests
      const lambda = lambdaPerBin[b]!;
      const Nb = N[b]!;
      const mTot = lambda * dt; // N*m
      const m = mTot / Nb;
      const q = -Math.expm1(-m);
      requests += mTot;

      const F = this.freshSum[b]!;
      const S = this.staleSum[b]!;
      const PS = this.pendS[b]!;
      const PB = this.pendB[b]!;
      const E = this.empty[b]!;
      const EC = this.errSum[b]!;

      hits += mTot * F;
      staleHits += mTot * (S + PS);
      errorsServed += mTot * EC;
      const waits = mTot * PB;
      blocking += mTot * E + waits;
      if (collapse) collapsed += waits;

      const movedS = S * q;
      const movedE = E * q;
      let fetch = Nb * movedS;
      fetch += collapse ? Nb * movedE : mTot * E;
      if (!collapse) fetch += waits;
      fetches[b] = fetch;

      if (movedS > 0) this.drainStale(b, q);
      this.empty[b] = this.empty[b]! - movedE;
      this.pendB[b] = this.pendB[b]! + movedE;
      this.pendS[b] = this.pendS[b]! + movedS;
      this.prov0B[b] = movedE;
      this.prov0S[b] = movedS;
    }

    this.fetchTot = fetches;
    this.lastRequests = requests;
    this.lastHits = hits + staleHits;
    return {
      requests,
      hits,
      staleHits,
      blockingMisses: blocking,
      collapsedWaits: collapsed,
      errorsServed,
      originFetchesPerBin: fetches,
    };
  }

  scheduleCompletions(
    tick: number,
    perBinAmounts: Float64Array,
    completionTick: number,
    successFraction: number,
  ): void {
    const R = this.R;
    let c = completionTick <= tick ? tick + 1 : completionTick;
    if (c > tick + R - 1) c = tick + R - 1;
    const slot = ((c % R) + R) % R;
    const succ = Math.min(1, Math.max(0, successFraction));
    for (let b = 0; b < this.B; b++) {
      const a = perBinAmounts[b]!;
      const F = this.fetchTot[b]!;
      if (!(a > 0) || !(F > 0)) continue;
      const frac = Math.min(a / F, 1 - this.sched[b]!);
      if (frac <= 0) continue;
      this.sched[b] = this.sched[b]! + frac;
      const kb = this.prov0B[b]! * frac;
      const ks = this.prov0S[b]! * frac;
      const i = b * R + slot;
      this.pbAmt[i] = this.pbAmt[i]! + kb;
      this.pbOk[i] = this.pbOk[i]! + kb * succ;
      this.psAmt[i] = this.psAmt[i]! + ks;
      this.psOk[i] = this.psOk[i]! + ks * succ;
    }
  }

  /**
   * Initial warm state (call before the first `step`). `lambdaPerBin` is the layer's request rate
   * per bin (req/s, summed over domains), `historySec` the assumed time since the last full purge.
   * Finite TTL T: per-bin fresh fraction r*T/(1+r*T) (r = per-key rate), spread uniformly over ages
   * [0, T); the rest is empty (no stale). Infinite TTL: fresh = 1 - exp(-r * historySec).
   * With a TTL beyond the run duration (scalar state) the fresh fraction never expires.
   */
  warm(lambdaPerBin: Float64Array, historySec: number): void {
    const { B, Lf } = this;
    const ttl = this.cfg.ttlSec;
    for (let b = 0; b < B; b++) {
      const r = (lambdaPerBin[b] ?? 0) / this.N[b]!;
      let f = 0;
      if (r > 0) {
        if (!Number.isFinite(ttl)) f = -Math.expm1(-r * Math.max(0, historySec));
        else f = (r * ttl) / (1 + r * ttl);
      }
      f = Math.min(1, Math.max(0, f));
      if (Lf > 0) this.fresh.fill(f / Lf, b * Lf, (b + 1) * Lf);
      this.freshSum[b] = f;
      this.empty[b] = 1 - f;
    }
  }

  purge(fraction: number | Float64Array): void {
    const { B, Lf, Ls } = this;
    for (let b = 0; b < B; b++) {
      const phi = Math.min(
        1,
        Math.max(0, typeof fraction === 'number' ? fraction : (fraction[b] ?? 0)),
      );
      if (phi <= 0) continue;
      const keep = 1 - phi;
      // fresh
      this.empty[b] = this.empty[b]! + phi * this.freshSum[b]!;
      if (Lf > 0) {
        const base = b * Lf;
        if (phi >= 1) this.fresh.fill(0, base, base + Lf);
        else for (let k = 0; k < Lf; k++) this.fresh[base + k] = this.fresh[base + k]! * keep;
      }
      this.freshSum[b] = phi >= 1 ? 0 : this.freshSum[b]! * keep;
      // stale (pendingStale and errorCached are untouched)
      if (Ls > 0 && this.staleSum[b]! > 0) {
        if (phi >= 1) {
          this.renormStale(b, true); // books the whole stale sum into empty
        } else {
          this.empty[b] = this.empty[b]! + phi * this.staleSum[b]!;
          this.staleSum[b] = this.staleSum[b]! * keep;
          this.staleScale[b] = this.staleScale[b]! * keep;
          if (this.staleScale[b]! < RENORM_SCALE) this.renormStale(b, false);
        }
      }
    }
  }

  hitRatio(): number {
    return this.lastRequests > 0 ? this.lastHits / this.lastRequests : 0;
  }

  /** Fractions for one bin (sum to 1). Pending-stale keys are reported separately. */
  binState(b: number): CacheBinState {
    return {
      fresh: this.freshSum[b]!,
      stale: this.staleSum[b]!,
      empty: this.empty[b]!,
      pending: this.pendB[b]!,
      errorCached: this.errSum[b]!,
      pendingStale: this.pendS[b]!,
    };
  }

  /** Aggregate fractions weighted by keys per bin. pendingStale keys count as `stale`. */
  state(): CacheLayerState {
    let tot = 0;
    let fresh = 0;
    let stale = 0;
    let empty = 0;
    let pending = 0;
    let errorCached = 0;
    for (let b = 0; b < this.B; b++) {
      const w = this.N[b]!;
      tot += w;
      fresh += w * this.freshSum[b]!;
      stale += w * (this.staleSum[b]! + this.pendS[b]!);
      empty += w * this.empty[b]!;
      pending += w * this.pendB[b]!;
      errorCached += w * this.errSum[b]!;
    }
    if (tot === 0) return { fresh: 0, stale: 0, empty: 1, pending: 0, errorCached: 0 };
    return {
      fresh: fresh / tot,
      stale: stale / tot,
      empty: empty / tot,
      pending: pending / tot,
      errorCached: errorCached / tot,
    };
  }
}
