import { describe, expect, it } from 'vitest';
import { ComputeModel } from '../src/model/compute';
import type { ComputeConfig } from '../src/model/types';

const base: ComputeConfig = {
  vcpu: 0.5,
  concurrencyPerInstance: 1,
  maxInstances: 1000,
  minInstances: 0,
  scaleOutPerSec: 100,
  coldStartMs: 1500,
  idleScaleToZeroSec: 900,
  timeoutSec: 30,
  maxQueue: 1000,
  dtSec: 1,
};

describe('ComputeModel', () => {
  it('obeys Little law in steady state', () => {
    const dt = 0.05;
    const m = new ComputeModel({ ...base, dtSec: dt, minInstances: 100, maxInstances: 1000 });
    const lambda = 100;
    const S = 200;
    let r = m.step(0, 0, S);
    for (let i = 0; i < 400; i++) r = m.step(i, lambda * dt, S);
    expect(r.inFlight).toBeGreaterThan(lambda * (S / 1000) * 0.98);
    expect(r.inFlight).toBeLessThan(lambda * (S / 1000) * 1.02);
    expect(r.queue).toBe(0);
    expect(r.timeouts504).toBe(0);
  });

  it('obeys Little law with fractional-tick service time', () => {
    const dt = 0.1;
    const m = new ComputeModel({ ...base, dtSec: dt, minInstances: 100 });
    const lambda = 100;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < 600; i++) {
      const r = m.step(i, lambda * dt, 250);
      if (i >= 300) {
        sum += r.inFlight;
        n++;
      }
    }
    expect(sum / n).toBeGreaterThan(lambda * 0.25 * 0.98);
    expect(sum / n).toBeLessThan(lambda * 0.25 * 1.02);
  });

  it('caps capacity, queues, then sheds 503 past maxQueue', () => {
    const m = new ComputeModel({
      ...base,
      minInstances: 10,
      maxInstances: 10,
      concurrencyPerInstance: 2,
      maxQueue: 100,
    });
    let total503 = 0;
    let r = m.step(0, 0, 5000);
    for (let t = 1; t <= 30; t++) {
      r = m.step(t, 50, 5000);
      total503 += r.rejected503;
      expect(r.inFlight).toBeLessThanOrEqual(20 + 1e-9);
    }
    expect(r.readyInstances).toBe(10);
    expect(r.queue).toBe(100);
    expect(total503).toBeGreaterThan(0);
    expect(r.queueWaitMs).toBeCloseTo((100 / (20 / 5)) * 1000);
  });

  it('delays first renders by the cold start from zero instances', () => {
    const m = new ComputeModel(base);
    const r0 = m.step(0, 10, 100);
    expect(r0.started).toBe(0);
    expect(r0.queue).toBe(10);
    expect(r0.queueWaitMs).toBe(1500);
    const r1 = m.step(1, 0, 100);
    expect(r1.started).toBe(0);
    const r2 = m.step(2, 0, 100);
    expect(r2.started).toBe(10);
    expect(r2.readyInstances).toBe(10);
  });

  it('counts renders longer than the timeout as 504', () => {
    const m = new ComputeModel({ ...base, minInstances: 5, timeoutSec: 10 });
    const r = m.step(0, 3, 20000);
    expect(r.started).toBe(3);
    expect(r.timeouts504).toBe(3);
    // Slot is held until the timeout (10 ticks), not 20.
    let last = r;
    for (let t = 1; t <= 9; t++) last = m.step(t, 0, 100);
    expect(last.inFlight).toBe(3);
    last = m.step(10, 0, 100);
    expect(last.inFlight).toBe(0);
  });

  it('counts long queue waits as 504', () => {
    const m = new ComputeModel({ ...base, minInstances: 1, maxInstances: 1, timeoutSec: 5, maxQueue: 1e6 });
    let t504 = 0;
    for (let t = 0; t < 60; t++) t504 += m.step(t, 3, 1000).timeouts504;
    expect(t504).toBeGreaterThan(0);
  });

  it('scales out under load with cold start delay', () => {
    const m = new ComputeModel({ ...base, scaleOutPerSec: 10 });
    let r = m.step(0, 30, 1000);
    for (let t = 1; t < 10; t++) r = m.step(t, 30, 1000);
    expect(r.readyInstances).toBeGreaterThan(20);
    expect(r.readyInstances).toBeLessThanOrEqual(1000);
  });

  it('scales to min after idleScaleToZeroSec', () => {
    const m = new ComputeModel({ ...base, idleScaleToZeroSec: 100, minInstances: 0 });
    m.warmStart(5);
    m.step(0, 2, 500);
    let r = m.step(1, 0, 500);
    for (let t = 2; t < 90; t++) r = m.step(t, 0, 500);
    expect(r.readyInstances).toBe(5);
    for (let t = 90; t < 105; t++) r = m.step(t, 0, 500);
    expect(r.readyInstances).toBe(0);
  });

  it('reset clears state and brings minInstances back cold', () => {
    const m = new ComputeModel({ ...base, minInstances: 3 });
    m.step(0, 2, 5000);
    m.reset();
    const r = m.step(1, 1, 100);
    expect(r.inFlight).toBe(0);
    expect(r.readyInstances).toBe(0);
    expect(r.started).toBe(0);
    const r2 = m.step(2, 0, 100);
    expect(r2.readyInstances).toBe(3);
    expect(r2.started).toBe(1);
  });
});
