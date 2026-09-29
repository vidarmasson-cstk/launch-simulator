import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCENARIO,
  FRAMEWORKS,
  FRAMEWORK_IDS,
  ScenarioSchema,
  applyPlan,
  resolveFramework,
} from '../src';

describe('ScenarioSchema', () => {
  it('parses {} to the full default scenario', () => {
    const s = ScenarioSchema.parse({});
    expect(s).toEqual(DEFAULT_SCENARIO);
    expect(s.schemaVersion).toBe(1);
    expect(s.launch.originLimitRps).toBe(200);
    expect(s.cms.cda.limitRps).toBe(100);
    expect(s.cms.cdn.ttlSec).toBeNull();
    expect(s.sim.burstiness).toBeNull();
  });

  it('fills partial nested input with defaults', () => {
    const s = ScenarioSchema.parse({ cms: { cda: { limitRps: 50 } }, site: { pages: 10 } });
    expect(s.cms.cda.limitRps).toBe(50);
    expect(s.cms.cda.algorithm).toBe('fixedWindow');
    expect(s.site.pages).toBe(10);
    expect(s.site.cacheHeaders.page.sMaxAgeSec).toBe(300);
  });

  it('round-trips through JSON', () => {
    const s = ScenarioSchema.parse({});
    expect(ScenarioSchema.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('validates events as a discriminated union with defaults', () => {
    const s = ScenarioSchema.parse({ events: [{ kind: 'spike' }, { kind: 'goLive', atSec: 5 }] });
    expect(s.events[0]).toMatchObject({ kind: 'spike', multiplier: 3 });
    expect(s.events[1]).toEqual({ kind: 'goLive', atSec: 5 });
    expect(() => ScenarioSchema.parse({ events: [{ kind: 'nope' }] })).toThrow();
  });
});

describe('applyPlan', () => {
  it('sets enterprise limits without mutating the input', () => {
    const e = applyPlan(DEFAULT_SCENARIO, 'enterprise');
    expect(e.launch).toMatchObject({ plan: 'enterprise', originLimitRps: 1200 });
    expect(e.launch.revalidation.dailyQuota).toBe(2000);
    expect(DEFAULT_SCENARIO.launch.originLimitRps).toBe(200);
    expect(applyPlan(e, 'standard').launch.originLimitRps).toBe(200);
  });
});

describe('frameworks', () => {
  it('has a preset for every id with matching id', () => {
    for (const id of FRAMEWORK_IDS) expect(FRAMEWORKS[id].id).toBe(id);
  });

  it('resolveFramework merges overrides', () => {
    const s = ScenarioSchema.parse({
      site: { framework: 'nuxt', frameworkOverrides: { globalCalls: 7 } },
    });
    const f = resolveFramework(s);
    expect(f.globalCalls).toBe(7);
    expect(f.cpuRenderMsL1).toBe(15);
    expect(FRAMEWORKS.nuxt.globalCalls).toBe(3);
  });

  it('static frameworks make no runtime CMS calls', () => {
    expect(FRAMEWORKS['gatsby-ssg'].runtimeCms).toBe(false);
    expect(FRAMEWORKS['astro-static'].renderMode).toBe('static');
  });
});
