import { describe, expect, it } from 'vitest';
import { ScenarioSchema, type ScenarioInput } from '../src/schema';
import type { SimulationResult, SummaryKpis } from '../src/model/types';
import { computeSteadyState } from '../src/analytic/steadyState';
import { applyPatch, generateFindings, type RuleFinding } from '../src/findings';
import { setByPath } from '../src/params/registry';
import { TEMPLATES } from '../src/scenarios';

function run(input: ScenarioInput, sim?: SimulationResult): RuleFinding[] {
  const sc = ScenarioSchema.parse(input);
  return generateFindings(sc, computeSteadyState(sc), sim);
}

function fakeSim(
  length: number,
  columns: Record<string, (t: number) => number>,
  markers: { timeSec: number; kind: string; label: string }[] = [],
  summary: Partial<SummaryKpis> = {},
): SimulationResult {
  const cols: Record<string, Float32Array> = {};
  for (const [name, fn] of Object.entries(columns)) {
    const a = new Float32Array(length);
    for (let i = 0; i < length; i++) a[i] = fn(i);
    cols[name] = a;
  }
  const sim = {
    series: { length, columns: cols },
    summary: {
      peakLaunchOriginRps: 0,
      peakLaunchOriginPctOfLimit: 0,
      secondsOverLaunchLimit: 0,
      peakCmsOriginOfferedRps: 0,
      peakCmsOriginPctOfLimit: 0,
      secondsWithCms429: 0,
      totalLaunch429: 0,
      totalCms429: 0,
      total504: 0,
      total503: 0,
      errorPagesServed: 0,
      visitorErrorRate: 0,
      worstSecondVisitorP95Ms: 0,
      cmsCallsPerPageView: 0,
      suggestedCmsLimitRps: 0,
      projectedMonthlyApiCalls: { cached: 0, uncached: 0 },
      bottleneck: 'none',
      ...summary,
    },
    markers,
  };
  return sim as unknown as SimulationResult;
}

function find(fs: RuleFinding[], id: string): RuleFinding {
  const f = fs.find((x) => x.id === id);
  if (!f) throw new Error(`rule ${id} did not fire; got ${fs.map((x) => x.id).join(', ')}`);
  return f;
}

/** Apply every suggestion with setByPath and check the scenario still parses. */
function expectPatchesValid(input: ScenarioInput, fs: RuleFinding[]) {
  for (const f of fs) {
    if (!f.suggestion) continue;
    let patched: ScenarioInput = input;
    for (const [path, value] of Object.entries(f.suggestion.set)) {
      patched = setByPath(patched, path, value);
    }
    const r = ScenarioSchema.safeParse(patched);
    expect(r.success, `${f.id}: ${r.success ? '' : JSON.stringify(r.error.issues)}`).toBe(true);
    // applyPatch is equivalent
    expect(ScenarioSchema.safeParse(applyPatch(input, f.suggestion)).success).toBe(true);
  }
}

const QUIET: ScenarioInput = {
  traffic: { baseEdgeRps: 100, bots: { share: 0.01, randomQueryFraction: 0, notFoundFraction: 0.001 } },
  site: {
    frameworkOverrides: { clientNavFraction: 0, prefetchPerView: 0 },
    cacheHeaders: { page: { cacheable: true, sMaxAgeSec: 3600, swrSec: 86400 } },
  },
  launch: { plan: 'enterprise', originLimitRps: 1200 },
};

describe('generateFindings', () => {
  it('reports a single info finding for a healthy scenario', () => {
    const fs = run(QUIET);
    expect(fs.map((f) => f.id)).toEqual(['healthy']);
    expect(fs[0]!.severity).toBe('info');
  });

  it('healthy retail template is healthy', () => {
    const t = TEMPLATES.find((x) => x.id === 'healthy-retail-peak')!;
    expect(run(t.scenario).map((f) => f.id)).toEqual(['healthy']);
  });

  it('uncacheable pages -> set s-maxage and SWR', () => {
    const input: ScenarioInput = {
      ...QUIET,
      traffic: { baseEdgeRps: 3000 },
      site: { ...QUIET.site, cacheHeaders: { page: { cacheable: false } } },
    };
    const fs = run(input);
    const f = find(fs, 'uncacheable-pages');
    expect(f.severity).toBe('critical');
    expect(f.suggestion!.set['site.cacheHeaders.page.cacheable']).toBe(true);
    expect(f.suggestion!.set['site.cacheHeaders.page.sMaxAgeSec']).toBe(300);
    expect(f.detail).toMatch(/req\/s/);
    expectPatchesValid(input, fs);
    // Applying it removes the finding.
    const after = run(applyPatch(input, f.suggestion!));
    expect(after.some((x) => x.id === 'uncacheable-pages')).toBe(false);
  });

  it('sMaxAge 0 counts as uncacheable; a low-traffic site is only a warning', () => {
    const fs = run({
      ...QUIET,
      traffic: { baseEdgeRps: 2 },
      site: { ...QUIET.site, cacheHeaders: { page: { cacheable: true, sMaxAgeSec: 0 } } },
    });
    expect(find(fs, 'uncacheable-pages').severity).toBe('warning');
  });

  it('CMS 429s concentrated after a publish (timeline)', () => {
    const input: ScenarioInput = {
      ...QUIET,
      events: [
        {
          kind: 'publish',
          atSec: 300,
          entries: 500,
          spreadSec: 0,
          purge: { pageQueries: true, contentTypeLists: true, referencingFraction: 0.3, globals: true },
          onPublish: 'revalidatePaths',
        },
      ],
    };
    const sim = fakeSim(
      900,
      { cms429: (t) => (t >= 300 && t < 340 ? 50 : t === 700 ? 1 : 0) },
      [{ timeSec: 300, kind: 'publish', label: 'Publish 500' }],
    );
    const fs = run(input, sim);
    const f = find(fs, 'cms-429-after-publish');
    expect(f.severity).toBe('critical');
    expect(f.detail).toMatch(/60 s after/);
    expect(f.suggestion!.set['cms.cda.algorithm']).toBe('gcra');
    expectPatchesValid(input, fs);
    const patched = ScenarioSchema.parse(applyPatch(input, f.suggestion!));
    const ev = patched.events[0]!;
    expect(ev.kind === 'publish' && ev.spreadSec).toBeGreaterThan(0);
    expect(ev.kind === 'publish' && ev.purge.globals).toBe(false);
  });

  it('does not blame the publish when 429s are spread evenly', () => {
    const input: ScenarioInput = {
      ...QUIET,
      events: [{ kind: 'publish', atSec: 300, entries: 1, spreadSec: 0 }],
    };
    const sim = fakeSim(900, { cms429: () => 5 }, [{ timeSec: 300, kind: 'publish', label: 'p' }]);
    expect(run(input, sim).some((f) => f.id === 'cms-429-after-publish')).toBe(false);
  });

  it('purge-driven misses share a busy CMS budget (steady state)', () => {
    const input: ScenarioInput = {
      traffic: { baseEdgeRps: 1000, bots: { share: 0, randomQueryFraction: 0, notFoundFraction: 0 } },
      site: {
        pages: 100,
        locales: 1,
        frameworkOverrides: { clientNavFraction: 0, prefetchPerView: 0 },
        cacheHeaders: { page: { cacheable: false } },
      },
      launch: { originLimitRps: 5000 },
      steady: {
        publishesPerHour: 3600,
        entriesPerPublish: 50,
        purge: { pageQueries: true, contentTypeLists: true, referencingFraction: 0.5, globals: true },
      },
    };
    const fs = run(input);
    const f = find(fs, 'cms-429-after-publish');
    expect(f.suggestion!.set['steady.purge.globals']).toBe(false);
    expectPatchesValid(input, fs);
  });

  it('deploy at peak without priming -> priming patch', () => {
    const input: ScenarioInput = {
      ...QUIET,
      traffic: { baseEdgeRps: 4000, bots: { share: 0.01, randomQueryFraction: 0, notFoundFraction: 0 } },
      events: [{ kind: 'deploy', atSec: 300, buildSec: 120 }],
    };
    const fs = run(input);
    const f = find(fs, 'deploy-at-peak');
    expect(f.suggestion).toBeDefined();
    const patched = ScenarioSchema.parse(applyPatch(input, f.suggestion!));
    const d = patched.events[0]!;
    expect(d.kind === 'deploy' && d.priming.paths).toBeGreaterThan(0);
    expectPatchesValid(input, fs);
  });

  it('deploy with 429s after it (timeline)', () => {
    const input: ScenarioInput = { ...QUIET, events: [{ kind: 'goLive', atSec: 0 }] };
    const sim = fakeSim(600, { launch429: (t) => (t < 30 ? 10 : 0) }, [
      { timeSec: 0, kind: 'goLive', label: 'go-live' },
    ]);
    const f = find(run(input, sim), 'deploy-at-peak');
    expect(f.severity).toBe('critical');
    expect(f.suggestion).toBeUndefined(); // nothing to patch for a bare go-live
  });

  it('fixed / sdkDefault retries with CMS 429s -> exponential jitter', () => {
    for (const kind of ['fixed', 'sdkDefault'] as const) {
      const input: ScenarioInput = {
        ...QUIET,
        cms: { otherOrgTrafficRps: 150 },
        sdk: { retry: { kind } },
      };
      const fs = run(input);
      const f = find(fs, 'retry-without-jitter');
      expect(f.suggestion!.set['sdk.retry.kind']).toBe('exponentialJitter');
      expect(f.suggestion!.set['sdk.retry.baseDelayMs']).toBe(200);
      expectPatchesValid(input, fs);
    }
    // Jittered retries are fine.
    const ok = run({ ...QUIET, cms: { otherOrgTrafficRps: 150 }, sdk: { retry: { kind: 'exponentialJitter' } } });
    expect(ok.some((f) => f.id === 'retry-without-jitter')).toBe(false);
  });

  it('many global calls with a low CMS hit ratio', () => {
    const input: ScenarioInput = { ...QUIET, cms: { cdn: { ttlSec: 5 } } };
    const fs = run(input);
    const f = find(fs, 'global-calls-uncached');
    expect(f.suggestion!.set['site.frameworkOverrides.globalCalls']).toBe(1);
    expectPatchesValid(input, fs);
  });

  it('bot-unique and 404 traffic above 20% of origin load', () => {
    const input: ScenarioInput = {
      ...QUIET,
      traffic: { baseEdgeRps: 300, bots: { share: 0.5, randomQueryFraction: 0.6, notFoundFraction: 0.2 } },
    };
    const fs = run(input);
    const f = find(fs, 'bot-unique-origin-load');
    expect(f.detail).toMatch(/%/);
    expectPatchesValid(input, fs);
  });

  it('crawler event counts towards the bot origin share', () => {
    const input: ScenarioInput = {
      ...QUIET,
      events: [{ kind: 'crawler', atSec: 300, durationSec: 600, rps: 150, randomQueryFraction: 0.8, notFoundFraction: 0.1 }],
    };
    const fs = run(input);
    const f = find(fs, 'bot-unique-origin-load');
    expect(f.detail).toMatch(/crawler event/);
    expectPatchesValid(input, fs);
  });

  it('render404 with a caching external CDN', () => {
    const input: ScenarioInput = {
      ...QUIET,
      launch: {
        ...QUIET.launch,
        externalCdn: { enabled: true, ttlSec: 60, cachesErrors: true, errorTtlSec: 300 },
      },
      sdk: { onFinalFailure: 'render404' },
    };
    const fs = run(input);
    const quiet = find(fs, 'cached-429-as-404');
    expect(quiet.severity).toBe('warning');
    expect(quiet.suggestion!.set['launch.externalCdn.cachesErrors']).toBe(false);
    expectPatchesValid(input, fs);
    // With 429s in the timeline it is critical.
    const sim = fakeSim(100, { cms429: () => 3 });
    expect(find(run(input, sim), 'cached-429-as-404').severity).toBe('critical');
  });

  it('compute saturation from steady state and from 504s', () => {
    const input: ScenarioInput = {
      ...QUIET,
      launch: { ...QUIET.launch, compute: { maxInstances: 2 } },
      traffic: { baseEdgeRps: 3000 },
      site: { ...QUIET.site, cacheHeaders: { page: { cacheable: false } } },
    };
    const fs = run(input);
    const f = find(fs, 'compute-saturation');
    expect(f.severity).toBe('critical');
    expect(f.suggestion!.set['launch.compute.machine']).toBe('L2');
    expectPatchesValid(input, fs);

    const sim = fakeSim(100, { queue: () => 50 }, [], { total504: 120 });
    const g = find(run(QUIET, sim), 'compute-saturation');
    expect(g.detail).toMatch(/120 timeouts/);
  });

  it('revalidation calls over the daily quota', () => {
    const input: ScenarioInput = {
      ...QUIET,
      launch: { ...QUIET.launch, revalidation: { dailyQuota: 500 } },
      events: [{ kind: 'publish', atSec: 10, entries: 600, spreadSec: 0, onPublish: 'revalidatePaths' }],
    };
    const fs = run(input);
    const f = find(fs, 'revalidation-quota');
    expect(f.severity).toBe('critical');
    expectPatchesValid(input, fs);
    const patched = ScenarioSchema.parse(applyPatch(input, f.suggestion!));
    const ev = patched.events[0]!;
    expect(ev.kind === 'publish' && ev.onPublish).toBe('revalidateTags');
    expect(run(patched).some((x) => x.id === 'revalidation-quota')).toBe(false);
  });

  it('other org traffic above 30% of the CMS limit', () => {
    const input: ScenarioInput = {
      ...QUIET,
      cms: { otherOrgTrafficRps: 20 },
      events: [{ kind: 'otherTraffic', atSec: 300, durationSec: 300, rps: 90 }],
    };
    const fs = run(input);
    const f = find(fs, 'other-org-traffic');
    expect(f.severity).toBe('critical');
    expectPatchesValid(input, fs);
    const patched = ScenarioSchema.parse(applyPatch(input, f.suggestion!));
    expect(patched.events).toHaveLength(0);
    expect(patched.cms.otherOrgTrafficRps).toBe(0);
    expect(run({ ...QUIET, cms: { otherOrgTrafficRps: 10 } }).some((x) => x.id === 'other-org-traffic')).toBe(false);
  });

  it('CMS limit: suggests a limit above the offered load', () => {
    const input: ScenarioInput = { ...QUIET, cms: { otherOrgTrafficRps: 95 } };
    const fs = run(input);
    const f = find(fs, 'cms-origin-limit');
    const suggested = f.suggestion!.set['cms.cda.limitRps'] as number;
    expect(suggested).toBeGreaterThanOrEqual(95);
    expectPatchesValid(input, fs);
    expect(run(applyPatch(input, f.suggestion!)).some((x) => x.id === 'cms-origin-limit')).toBe(false);
  });

  it('graphql scenarios patch the graphql limiter', () => {
    const fs = run({ ...QUIET, cms: { api: 'graphql', otherOrgTrafficRps: 95 } });
    expect(Object.keys(find(fs, 'cms-origin-limit').suggestion!.set)[0]).toBe('cms.graphql.limitRps');
  });

  it('Launch origin limit and data request amplification', () => {
    const input: ScenarioInput = {
      ...QUIET,
      traffic: { baseEdgeRps: 300 },
      site: {
        ...QUIET.site,
        frameworkOverrides: { prefetchPerView: 5, clientNavFraction: 0.7, dataCacheable: false },
      },
      launch: { plan: 'standard', originLimitRps: 200 },
    };
    const fs = run(input);
    expect(find(fs, 'launch-origin-limit').severity).toBe('critical');
    const d = find(fs, 'data-request-amplification');
    expect(d.suggestion!.set['site.frameworkOverrides.prefetchPerView']).toBe(0);
    expectPatchesValid(input, fs);
  });

  it('sorts critical before warning before info and tolerates missing columns', () => {
    const fs = run(
      { ...QUIET, cms: { otherOrgTrafficRps: 60, cdn: { ttlSec: 5 } } },
      fakeSim(10, {}),
    );
    const order = { critical: 0, warning: 1, info: 2 } as const;
    for (let i = 1; i < fs.length; i++) {
      expect(order[fs[i]!.severity]).toBeGreaterThanOrEqual(order[fs[i - 1]!.severity]);
    }
    expect(fs.length).toBeGreaterThan(1);
  });

  it('every template produces findings with valid patches', () => {
    for (const t of TEMPLATES) {
      const fs = run(t.scenario);
      expect(fs.length).toBeGreaterThan(0);
      expectPatchesValid(t.scenario, fs);
    }
  });
});
