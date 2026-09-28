import { describe, expect, it } from 'vitest';
import { EventTimeline } from '../src/model/events';
import { ScenarioSchema, type ScenarioInput } from '../src/schema';

function make(events: unknown[], extra: Record<string, unknown> = {}) {
  const sc = ScenarioSchema.parse({ ...extra, events } as ScenarioInput);
  return new EventTimeline(sc);
}
const at = (tl: EventTimeline, t: number, dt = 1) =>
  tl.effectsAt({ tick: Math.round(t / dt), dtSec: dt, timeSec: t });
const frac = (e: ReturnType<typeof at>, layer: string) =>
  e.purges.find((p) => p.layer === layer)?.fraction ?? 0;

describe('EventTimeline', () => {
  it('returns defaults with no events', () => {
    const e = at(make([]), 5);
    expect(e).toEqual({
      trafficMultiplier: 1,
      crawlerRps: 0,
      crawlerRandomQueryFraction: 0,
      crawlerNotFoundFraction: 0,
      loadTestRps: 0,
      loadTestCacheBusting: false,
      otherTrafficRps: 0,
      purges: [],
      coldReset: false,
      primingRps: 0,
      primingPaths: 0,
      revalidations: 0,
    });
  });

  it('ramps, holds and decays a spike', () => {
    const tl = make([{ kind: 'spike', atSec: 100, durationSec: 60, multiplier: 5, rampSec: 10 }]);
    expect(at(tl, 99).trafficMultiplier).toBe(1);
    expect(at(tl, 100).trafficMultiplier).toBe(1);
    expect(at(tl, 105).trafficMultiplier).toBeCloseTo(3);
    expect(at(tl, 110).trafficMultiplier).toBeCloseTo(5);
    expect(at(tl, 130).trafficMultiplier).toBeCloseTo(5);
    expect(at(tl, 155).trafficMultiplier).toBeCloseTo(3);
    expect(at(tl, 160).trafficMultiplier).toBe(1);
  });

  it('multiplies overlapping spikes', () => {
    const tl = make([
      { kind: 'spike', atSec: 0, durationSec: 100, multiplier: 2, rampSec: 0 },
      { kind: 'spike', atSec: 50, durationSec: 100, multiplier: 3, rampSec: 0 },
    ]);
    expect(at(tl, 10).trafficMultiplier).toBe(2);
    expect(at(tl, 60).trafficMultiplier).toBe(6);
    expect(at(tl, 120).trafficMultiplier).toBe(3);
  });

  it('sums crawlers with rps-weighted fractions', () => {
    const tl = make([
      { kind: 'crawler', atSec: 0, durationSec: 100, rps: 10, randomQueryFraction: 1, notFoundFraction: 0 },
      { kind: 'crawler', atSec: 50, durationSec: 100, rps: 30, randomQueryFraction: 0, notFoundFraction: 0.4 },
    ]);
    expect(at(tl, 10).crawlerRps).toBe(10);
    const e = at(tl, 60);
    expect(e.crawlerRps).toBe(40);
    expect(e.crawlerRandomQueryFraction).toBeCloseTo(0.25);
    expect(e.crawlerNotFoundFraction).toBeCloseTo(0.3);
    expect(at(tl, 200).crawlerRps).toBe(0);
  });

  it('handles loadTest and otherTraffic', () => {
    const tl = make([
      { kind: 'loadTest', atSec: 10, durationSec: 10, rps: 100, cacheBusting: true },
      { kind: 'loadTest', atSec: 15, durationSec: 10, rps: 50, cacheBusting: false },
      { kind: 'otherTraffic', atSec: 0, durationSec: 5, rps: 7 },
      { kind: 'otherTraffic', atSec: 3, durationSec: 5, rps: 3 },
    ]);
    expect(at(tl, 12).loadTestRps).toBe(100);
    expect(at(tl, 12).loadTestCacheBusting).toBe(true);
    expect(at(tl, 22).loadTestRps).toBe(50);
    expect(at(tl, 22).loadTestCacheBusting).toBe(false);
    expect(at(tl, 4).otherTrafficRps).toBe(10);
    expect(at(tl, 9).otherTrafficRps).toBe(0);
  });

  it('goLive fires once with a full purge', () => {
    const tl = make([{ kind: 'goLive', atSec: 100 }]);
    const fired = [99, 100, 101].map((t) => at(tl, t));
    expect(fired.map((e) => e.coldReset)).toEqual([false, true, false]);
    expect(fired[1]!.purges.map((p) => p.layer).sort()).toEqual(
      ['cmsGlobal', 'cmsList', 'cmsPage', 'launch'],
    );
    expect(fired[1]!.purges.every((p) => p.fraction === 1)).toBe(true);
  });

  it('goLive at fractional time fires on the containing tick only', () => {
    const tl = make([{ kind: 'goLive', atSec: 100.4 }]);
    expect(at(tl, 100).coldReset).toBe(true);
    expect(at(tl, 101).coldReset).toBe(false);
  });

  it('deploy purges launch at build end and primes for paths/rps seconds', () => {
    const tl = make([
      { kind: 'deploy', atSec: 100, buildSec: 50, priming: { paths: 100, rps: 20 } },
    ]);
    expect(at(tl, 149).coldReset).toBe(false);
    const e = at(tl, 150);
    expect(e.coldReset).toBe(true);
    expect(e.purges).toEqual([{ layer: 'launch', fraction: 1 }]);
    expect(e.primingRps).toBe(20);
    expect(e.primingPaths).toBe(100);
    expect(at(tl, 151).coldReset).toBe(false);
    expect(at(tl, 154).primingRps).toBe(20);
    expect(at(tl, 155).primingRps).toBe(0); // 100/20 = 5 s window
  });

  it('deploy without priming has no priming', () => {
    const tl = make([{ kind: 'deploy', atSec: 0, buildSec: 10 }]);
    expect(at(tl, 10).primingRps).toBe(0);
  });

  describe('publish', () => {
    const site = { site: { pages: 100, locales: 2 }, cms: { contentTypes: 10, entriesPerType: 50 } };
    it('single-tick publish gives page-query fractions', () => {
      const tl = make(
        [{ kind: 'publish', atSec: 10, entries: 10, spreadSec: 0, locales: 'all',
           purge: { pageQueries: true, contentTypeLists: false, referencingFraction: 0, globals: false } }],
        site,
      );
      const e = at(tl, 10);
      expect(frac(e, 'cmsPage')).toBeCloseTo((10 * 2) / 200);
      expect(frac(e, 'cmsList')).toBe(0);
      expect(frac(e, 'cmsGlobal')).toBe(0);
      expect(frac(e, 'launch')).toBe(0);
      expect(at(tl, 11).purges).toEqual([]);
    });

    it('spreads entries uniformly and adds up to the total', () => {
      const tl = make(
        [{ kind: 'publish', atSec: 10, entries: 20, spreadSec: 10, locales: 1,
           purge: { pageQueries: true, contentTypeLists: false, referencingFraction: 0, globals: false } }],
        site,
      );
      let total = 0;
      for (let t = 8; t < 25; t++) total += frac(at(tl, t), 'cmsPage');
      expect(total).toBeCloseTo(20 / 200); // localesFactor 1
      expect(frac(at(tl, 10), 'cmsPage')).toBeCloseTo(2 / 200);
      expect(frac(at(tl, 20), 'cmsPage')).toBe(0);
    });

    it('list, global and referencing purges', () => {
      const tl = make(
        [{ kind: 'publish', atSec: 0, entries: 120, spreadSec: 0, locales: 'all',
           purge: { pageQueries: false, contentTypeLists: true, referencingFraction: 0.1, globals: true } }],
        site,
      );
      const e = at(tl, 0);
      // ceil(120/50)=3 of 10 content types, all locales -> 0.3
      expect(frac(e, 'cmsList')).toBeCloseTo(0.3);
      expect(frac(e, 'cmsGlobal')).toBe(1);
      expect(frac(e, 'cmsPage')).toBeCloseTo(0.1);
    });

    it('onPublish variants', () => {
      const base = { kind: 'publish', atSec: 5, entries: 10, spreadSec: 0, locales: 'all',
        purge: { pageQueries: true, contentTypeLists: true, referencingFraction: 0.2, globals: false } };
      const paths = at(make([{ ...base, onPublish: 'revalidatePaths' }], site), 5);
      expect(frac(paths, 'launch')).toBeCloseTo(0.1);
      expect(paths.revalidations).toBe(10);
      const tags = at(make([{ ...base, onPublish: 'revalidateTags' }], site), 5);
      expect(frac(tags, 'launch')).toBeCloseTo(0.3);
      expect(tags.revalidations).toBe(1);
      const none = at(make([{ ...base, onPublish: 'none' }], site), 5);
      expect(frac(none, 'launch')).toBe(0);
      expect(none.revalidations).toBe(0);
    });

    it('revalidateTags counts one call per publish even when spread', () => {
      const tl = make(
        [{ kind: 'publish', atSec: 5, entries: 10, spreadSec: 5, locales: 'all', onPublish: 'revalidateTags' }],
        site,
      );
      let n = 0;
      for (let t = 0; t < 20; t++) n += at(tl, t).revalidations;
      expect(n).toBe(1);
    });

    it('redeploy purges launch 60 s after publish end', () => {
      const tl = make(
        [{ kind: 'publish', atSec: 100, entries: 5, spreadSec: 10, locales: 'all', onPublish: 'redeploy' }],
        site,
      );
      expect(at(tl, 170).coldReset).toBe(true);
      expect(frac(at(tl, 170), 'launch')).toBe(1);
      expect(at(tl, 110).coldReset).toBe(false);
      expect(at(tl, 171).coldReset).toBe(false);
    });

    it('merges same-layer purges as 1 - prod(1 - f)', () => {
      const p = { pageQueries: true, contentTypeLists: false, referencingFraction: 0, globals: false };
      const tl = make(
        [
          { kind: 'publish', atSec: 0, entries: 20, spreadSec: 0, locales: 'all', purge: p },
          { kind: 'publish', atSec: 0, entries: 20, spreadSec: 0, locales: 'all', purge: p },
        ],
        site,
      );
      expect(frac(at(tl, 0), 'cmsPage')).toBeCloseTo(1 - 0.8 * 0.8);
    });

    it('clamps fractions to 1', () => {
      const tl = make(
        [{ kind: 'publish', atSec: 0, entries: 5000, spreadSec: 0, locales: 'all' }],
        site,
      );
      expect(frac(at(tl, 0), 'cmsPage')).toBe(1);
    });
  });

  it('works at sub-second dt', () => {
    const tl = make([{ kind: 'goLive', atSec: 1 }]);
    const hits = [];
    for (let i = 0; i < 40; i++) if (at(tl, i * 0.1, 0.1).coldReset) hits.push(i);
    expect(hits).toHaveLength(1);
  });
});

describe('EventTimeline tick alignment', () => {
  it('fires an instant event on the tick that starts at atSec, not one tick early', () => {
    const scenario = ScenarioSchema.parse({ events: [{ kind: 'goLive', atSec: 300 }] });
    const tl = new EventTimeline(scenario);
    const dt = 0.1;
    const fired = [2999, 3000, 3001].map(
      (tick) => tl.effectsAt({ tick, dtSec: dt, timeSec: tick * dt }).coldReset,
    );
    expect(fired).toEqual([false, true, false]);
  });
});
