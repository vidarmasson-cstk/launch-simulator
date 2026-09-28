import { describe, expect, it } from 'vitest';
import { MetricsCollector } from '../src/model/metrics';
import type { TickSample } from '../src/model/metrics';
import { ScenarioSchema } from '../src/schema';

const blank = (): TickSample => ({
  edgePage: 0,
  edgeData: 0,
  edgeBot: 0,
  edgeStatic: 0,
  edgeTotal: 0,
  launchReq: 0,
  launchHits: 0,
  launchOffered: 0,
  launchAccepted: 0,
  launch429: 0,
  instances: 0,
  inFlight: 0,
  queue: 0,
  queueWaitMs: 0,
  c503: 0,
  c504: 0,
  cmsCalls: 0,
  cmsReq: 0,
  cmsHits: 0,
  cmsOfferedNew: 0,
  cmsOfferedOther: 0,
  cmsTotal: 0,
  cmsAccepted: 0,
  cmsQueued: 0,
  cms429: 0,
  cmsRetries: 0,
  cmsFinal: 0,
  gcraDelayMs: 0,
  otherOrg: 0,
  visitorErrors5xx: 0,
  visitorErrors404: 0,
  visitorErrors429: 0,
  visitorRequests: 0,
  humanViews: 0,
  revalidationsUsed: 0,
  revalidationsRejected: 0,
});

const scenario = (extra: Record<string, unknown> = {}) =>
  ScenarioSchema.parse({ sim: { durationSec: 6, dtSec: 0.5 }, ...extra });

/** Feed `fn(second, tickInSecond)` for every tick of the run. */
function feed(
  m: MetricsCollector,
  seconds: number,
  dt: number,
  fn: (s: TickSample, second: number, k: number) => void,
) {
  const per = Math.round(1 / dt);
  for (let sec = 0; sec < seconds; sec++) {
    for (let k = 0; k < per; k++) {
      const s = blank();
      m.begin(sec + k * dt);
      fn(s, sec, k);
      m.record(s);
    }
  }
}

describe('MetricsCollector', () => {
  it('aggregates ticks into per-second rates, means, maxima and last values', () => {
    const m = new MetricsCollector(scenario());
    feed(m, 6, 0.5, (s, sec, k) => {
      s.launchOffered = 50; // per 0.5 s tick -> 100 rps
      s.launchReq = 200;
      s.launchHits = 150;
      s.instances = k === 0 ? 10 : 20;
      s.gcraDelayMs = k === 0 ? 300 : 100;
      s.revalidationsUsed = sec * 2 + k;
      s.cmsOfferedNew = 3;
      s.cmsOfferedOther = 1;
    });
    const { series } = { series: m.series() };
    expect(series.length).toBe(6);
    expect(series.columns.launchOriginOffered![2]).toBeCloseTo(100, 4);
    expect(series.columns.launchHitRatio![2]).toBeCloseTo(0.75, 5);
    expect(series.columns.instances![2]).toBeCloseTo(15, 5);
    expect(series.columns.gcraDelayMs![2]).toBe(300);
    expect(series.columns.revalidationsUsed![3]).toBe(7);
    expect(series.columns.cmsOriginOffered![1]).toBeCloseTo(8, 5);
    expect(series.columns.launchLimit![0]).toBe(200);
    expect(series.columns.cmsLimit![0]).toBe(100);
  });

  it('computes latency quantiles per second from the histograms', () => {
    const m = new MetricsCollector(scenario());
    feed(m, 6, 0.5, (_s, sec) => {
      m.addRender(200, 10);
      m.addVisitor(30, 90);
      m.addVisitor(sec === 2 ? 5000 : 800, 10);
    });
    const c = m.series().columns;
    expect(c.renderP50![0]).toBeGreaterThan(180);
    expect(c.renderP50![0]).toBeLessThan(225);
    expect(c.visitorP50![0]).toBeLessThan(40);
    expect(c.visitorP95![0]).toBeGreaterThan(700);
    expect(c.visitorP95![2]).toBeGreaterThan(4000);
    expect(m.summary().worstSecondVisitorP95Ms).toBeGreaterThan(4000);
  });

  it('summarises peaks, limits, error rate and monthly projections', () => {
    const m = new MetricsCollector(scenario());
    feed(m, 6, 0.5, (s, sec) => {
      const over = sec >= 3;
      s.launchOffered = over ? 150 : 50; // 300 / 100 rps
      s.launchAccepted = 50;
      s.launch429 = over ? 100 : 0;
      s.cmsCalls = 100; // 200 rps
      s.cmsOfferedNew = over ? 50 : 10; // 100 / 20 rps
      s.cmsAccepted = 40;
      s.cms429 = 0;
      s.visitorRequests = 100;
      s.visitorErrors429 = over ? 10 : 0;
      s.humanViews = 50;
      s.edgeTotal = 100;
    });
    const k = m.summary();
    expect(k.peakLaunchOriginRps).toBeCloseTo(300, 3);
    expect(k.peakLaunchOriginPctOfLimit).toBeCloseTo(150, 3);
    expect(k.secondsOverLaunchLimit).toBe(3);
    expect(k.peakCmsOriginOfferedRps).toBeCloseTo(100, 3);
    expect(k.peakCmsOriginPctOfLimit).toBeCloseTo(100, 3);
    expect(k.suggestedCmsLimitRps).toBe(120);
    expect(k.secondsWithCms429).toBe(0);
    expect(k.totalLaunch429).toBeCloseTo(600, 6);
    expect(k.visitorErrorRate).toBeCloseTo(60 / 1200, 6);
    expect(k.errorPagesServed).toBeCloseTo(60, 6);
    expect(k.cmsCallsPerPageView).toBeCloseTo(2, 6);
    // uncached = mean accepted (80 rps) x month; cached = mean(200 - new) = 200 - 60
    expect(k.projectedMonthlyApiCalls.uncached).toBeCloseTo(80 * 2_592_000, -3);
    expect(k.projectedMonthlyApiCalls.cached).toBeCloseTo(140 * 2_592_000, -3);
    expect(k.bottleneck).toBe('launchOrigin');
  });

  it('picks the bottleneck with the earliest failure second', () => {
    const run = (cmsAt: number, launchAt: number, timeoutAt: number) => {
      const m = new MetricsCollector(scenario());
      feed(m, 6, 0.5, (s, sec) => {
        if (sec >= cmsAt) s.cms429 = 20;
        if (sec >= launchAt) s.launch429 = 20;
        if (sec >= timeoutAt) s.c504 = 20;
      });
      return m.summary();
    };
    expect(run(2, 4, 5).bottleneck).toBe('cmsOrigin');
    expect(run(4, 1, 5).bottleneck).toBe('launchOrigin');
    expect(run(4, 5, 3).bottleneck).toBe('timeout');
    expect(run(9, 9, 9).bottleneck).toBe('none');
    expect(run(3, 9, 9).secondsWithCms429).toBe(3);
    const m = new MetricsCollector(scenario());
    feed(m, 6, 0.5, (s, sec) => {
      if (sec >= 2) s.c503 = 5;
    });
    expect(m.summary().bottleneck).toBe('compute');
  });

  it('detects compute saturation from a queue wait above the timeout', () => {
    const m = new MetricsCollector(scenario());
    feed(m, 6, 0.5, (s, sec) => {
      if (sec === 4) s.queueWaitMs = 31_000;
    });
    expect(m.summary().bottleneck).toBe('compute');
  });

  it('handles a dt that does not divide one second', () => {
    const sc = ScenarioSchema.parse({ sim: { durationSec: 3, dtSec: 0.4 } });
    const m = new MetricsCollector(sc);
    for (let i = 0; i < Math.round(3 / 0.4); i++) {
      const s = blank();
      s.launchOffered = 40; // 100 rps
      m.begin(i * 0.4);
      m.record(s);
    }
    const c = m.series().columns.launchOriginOffered!;
    for (let i = 0; i < 2; i++) expect(c[i]).toBeCloseTo(100, 3);
  });
});
