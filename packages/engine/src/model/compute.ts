import type { ComputeConfig, ComputeStepResult, IComputeModel } from './types';

const EPS = 1e-9;

/**
 * Launch compute: instances, concurrency, queue, cold start, timeout, autoscaling (DESIGN 6.5).
 *
 * Approximations (v1):
 * - A cohort's completion is split across the two neighbouring ticks (S/dt = 2.5 -> half at +2,
 *   half at +3), so mean occupancy equals S; renders shorter than dt still hold a slot for 1 tick.
 * - Queue age is not tracked per request. For FIFO starts, the wait of started renders is taken as
 *   uniform on [0, queueWaitMs]; the share with wait + S > timeout counts as 504 (still rendered,
 *   so it still occupies its slot and consumes CMS calls).
 * - Renders with S > timeout occupy a slot until the timeout and all count as 504.
 * - No gradual scale-in: instances stay until idleScaleToZeroSec of continuous idleness, then drop
 *   straight to minInstances.
 * - Instance counts are fluid (fractional).
 */
export class ComputeModel implements IComputeModel {
  private readonly cfg: ComputeConfig;
  private readonly coldTicks: number;
  private readonly ringSize: number;
  private readonly inFlightRing: Float64Array;
  private readonly provRing: Float64Array;
  private readonly provSize: number;

  private ready: number;
  private provisioning = 0;
  private inFlight = 0;
  private queue = 0;
  private idleSec = 0;
  private lastTick = -1;

  constructor(config: ComputeConfig) {
    this.cfg = config;
    const dt = config.dtSec;
    this.coldTicks = Math.max(1, Math.ceil((config.coldStartMs / 1000) / dt - EPS));
    this.provSize = this.coldTicks + 2;
    this.provRing = new Float64Array(this.provSize);
    this.ringSize = Math.ceil(config.timeoutSec / dt - EPS) + 3;
    this.inFlightRing = new Float64Array(this.ringSize);
    this.ready = config.minInstances;
  }

  /** Set the ready instance count at t = 0 (clamped to maxInstances). */
  warmStart(instances: number): void {
    this.ready = Math.min(this.cfg.maxInstances, Math.max(0, instances));
  }

  /** Extra state accessors for the pipeline / tests. */
  get provisioningInstances(): number {
    return this.provisioning;
  }

  private provIdx(tick: number): number {
    return ((tick % this.provSize) + this.provSize) % this.provSize;
  }

  private flightIdx(tick: number): number {
    return ((tick % this.ringSize) + this.ringSize) % this.ringSize;
  }

  /** Ms until the earliest pending provisioning completes (only valid if provisioning > 0). */
  private msToNextReady(tick: number): number {
    for (let k = 1; k <= this.coldTicks + 1; k++) {
      if ((this.provRing[this.provIdx(tick + k)] ?? 0) > EPS) return Math.max(0, k * this.cfg.dtSec * 1000);
    }
    return this.cfg.coldStartMs;
  }

  step(tick: number, acceptedArrivals: number, serviceMs: number): ComputeStepResult {
    const c = this.cfg;
    const dt = c.dtSec;
    this.lastTick = tick;
    const timeoutMs = c.timeoutSec * 1000;

    // 1. Completions due this tick.
    const fi = this.flightIdx(tick);
    this.inFlight = Math.max(0, this.inFlight - (this.inFlightRing[fi] ?? 0));
    this.inFlightRing[fi] = 0;
    if (this.inFlight < EPS) this.inFlight = 0;

    // 2. Promote instances whose cold start finished.
    const pi = this.provIdx(tick);
    const promoted = this.provRing[pi] ?? 0;
    if (promoted > 0) {
      this.ready += promoted;
      this.provisioning = Math.max(0, this.provisioning - promoted);
      this.provRing[pi] = 0;
      if (this.provisioning < EPS) this.provisioning = 0;
    }

    // 3. Start renders FIFO (queue first).
    const cap = this.ready * c.concurrencyPerInstance;
    const demand = this.queue + acceptedArrivals;
    const started = Math.min(demand, Math.max(0, cap - this.inFlight));
    this.queue = demand - started;
    let rejected503 = 0;
    if (this.queue > c.maxQueue) {
      rejected503 = this.queue - c.maxQueue;
      this.queue = c.maxQueue;
    }

    // 4. Queue wait estimate for a newly admitted request.
    let queueWaitMs: number;
    if (cap <= 0) {
      queueWaitMs = this.provisioning > 0 ? this.msToNextReady(tick) : c.coldStartMs;
    } else {
      const throughput = cap / (Math.max(serviceMs, 1) / 1000);
      queueWaitMs = (this.queue / Math.max(throughput, EPS)) * 1000;
    }

    // 5. Completions and timeouts.
    let timeouts504 = 0;
    if (started > 0) {
      const effService = Math.min(serviceMs, timeoutMs);
      // Split the cohort's completion across the two neighbouring ticks so mean occupancy equals
      // the service time exactly (minimum 1 tick).
      const kExact = Math.max(1, effService / (dt * 1000));
      const lo = Math.floor(kExact + EPS);
      const wHi = Math.max(0, kExact - lo);
      const iLo = this.flightIdx(tick + lo);
      this.inFlightRing[iLo] = (this.inFlightRing[iLo] ?? 0) + started * (1 - wHi);
      if (wHi > EPS) {
        const iHi = this.flightIdx(tick + lo + 1);
        this.inFlightRing[iHi] = (this.inFlightRing[iHi] ?? 0) + started * wHi;
      }
      this.inFlight += started;
      if (serviceMs > timeoutMs) {
        timeouts504 = started;
      } else if (queueWaitMs + serviceMs > timeoutMs) {
        const over = queueWaitMs + serviceMs - timeoutMs;
        timeouts504 = started * Math.min(1, over / Math.max(queueWaitMs, EPS));
      }
    }

    // 6. Autoscale.
    const desiredRaw = Math.ceil((this.inFlight + this.queue) / c.concurrencyPerInstance - EPS);
    const desired = Math.min(c.maxInstances, Math.max(c.minInstances, desiredRaw));
    const have = this.ready + this.provisioning;
    if (desired > have + EPS) {
      const add = Math.min(desired - have, c.scaleOutPerSec * dt);
      if (add > 0) {
        const pk = this.provIdx(tick + this.coldTicks);
        this.provRing[pk] = (this.provRing[pk] ?? 0) + add;
        this.provisioning += add;
      }
    }
    if (acceptedArrivals > 0 || this.inFlight > 0 || this.queue > 0) {
      this.idleSec = 0;
    } else {
      this.idleSec += dt;
      if (this.idleSec >= c.idleScaleToZeroSec && this.ready > c.minInstances) {
        this.ready = c.minInstances;
      }
    }

    return {
      started,
      queue: this.queue,
      inFlight: this.inFlight,
      readyInstances: this.ready,
      rejected503,
      timeouts504,
      queueWaitMs,
    };
  }

  /** Cold reset (goLive / deploy): all instances gone, in-flight renders and queue are lost. */
  reset(): void {
    this.inFlightRing.fill(0);
    this.provRing.fill(0);
    this.inFlight = 0;
    this.queue = 0;
    this.idleSec = 0;
    this.ready = 0;
    this.provisioning = 0;
    if (this.cfg.minInstances > 0) {
      this.provRing[this.provIdx(this.lastTick + this.coldTicks)] = this.cfg.minInstances;
      this.provisioning = this.cfg.minInstances;
    }
  }
}
