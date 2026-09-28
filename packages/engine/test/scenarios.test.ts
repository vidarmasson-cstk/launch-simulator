import { describe, expect, it } from 'vitest';
import { ScenarioSchema } from '../src/schema';
import { TEMPLATES, getTemplate } from '../src/scenarios';
import { computeSteadyState } from '../src/analytic/steadyState';

describe('scenario templates', () => {
  it('has the ten templates of DESIGN 8 (9 as a compare pair) with unique ids', () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'healthy-retail-peak',
      'missing-s-maxage',
      'bulk-publish-at-peak',
      'deploy-during-peak',
      'multi-market-go-live',
      'ai-crawler-random-query',
      'nextjs-prefetch-amplification',
      '429-cached-as-404',
      'strict-window-spiky',
      'gcra-burst-spiky',
      'staging-job-shares-budget',
    ]);
  });

  it.each(TEMPLATES.map((t) => [t.id, t] as const))('%s parses with ScenarioSchema', (_id, t) => {
    const r = ScenarioSchema.safeParse(t.scenario);
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true);
    expect(t.name.length).toBeGreaterThan(3);
    expect(t.description.length).toBeGreaterThan(200);
    expect(t.description).not.toContain('\n');
    // Steady state works for every template.
    const k = computeSteadyState(ScenarioSchema.parse(t.scenario)).kpis;
    expect(Number.isFinite(k.cmsOriginRps)).toBe(true);
  });

  it('the compare pair share a workload and differ only in the limiter', () => {
    const a = getTemplate('strict-window-spiky')!;
    const b = getTemplate('gcra-burst-spiky')!;
    expect(a.comparesWith).toBe(b.id);
    expect(b.comparesWith).toBe(a.id);
    const pa = ScenarioSchema.parse(a.scenario);
    const pb = ScenarioSchema.parse(b.scenario);
    expect(pa.cms.cda.algorithm).toBe('fixedWindow');
    expect(pb.cms.cda.algorithm).toBe('gcra');
    expect(pb.cms.cda.burstMultiplierPct).toBe(200);
    expect(pb.cms.cda.maxWaitMs).toBe(3000);
    const strip = (s: typeof pa) => ({ ...s, name: '', cms: { ...s.cms, cda: null } });
    expect(strip(pb)).toEqual(strip(pa));
  });

  it('matches the DESIGN 8 specifics', () => {
    const p = (id: string) => ScenarioSchema.parse(getTemplate(id)!.scenario);
    const healthy = p('healthy-retail-peak');
    expect(healthy.traffic.baseEdgeRps).toBe(8200);
    expect(healthy.site.cacheHeaders.page).toMatchObject({ cacheable: true, sMaxAgeSec: 3600, swrSec: 86400 });
    expect(healthy.launch.originLimitRps).toBe(1200);
    expect(healthy.launch.revalidation.dailyQuota).toBe(2000);
    expect(healthy.events[0]).toMatchObject({ kind: 'spike', atSec: 300, durationSec: 300, multiplier: 1.5 });
    expect(p('missing-s-maxage').site.cacheHeaders.page.cacheable).toBe(false);
    expect(p('bulk-publish-at-peak').events[0]).toMatchObject({ kind: 'publish', entries: 500, spreadSec: 0, onPublish: 'revalidatePaths' });
    expect(p('deploy-during-peak').events[0]).toMatchObject({ kind: 'deploy', atSec: 300, buildSec: 120 });
    expect(p('multi-market-go-live').site.locales).toBe(20);
    expect(p('ai-crawler-random-query').events[0]).toMatchObject({ kind: 'crawler', rps: 150, randomQueryFraction: 0.8, notFoundFraction: 0.1 });
    expect(p('nextjs-prefetch-amplification').site.frameworkOverrides).toMatchObject({ prefetchPerView: 5, clientNavFraction: 0.7, dataCacheable: false });
    expect(p('429-cached-as-404').launch.externalCdn).toMatchObject({ enabled: true, cachesErrors: true, errorTtlSec: 300 });
    expect(p('staging-job-shares-budget').events[0]).toMatchObject({ kind: 'otherTraffic', atSec: 300, durationSec: 300, rps: 60 });
  });

  it('analytic sanity: healthy is quiet, missing s-maxage and prefetch blow the Launch limit', () => {
    const k = (id: string) => computeSteadyState(ScenarioSchema.parse(getTemplate(id)!.scenario)).kpis;
    expect(k('healthy-retail-peak').launchHitRatio).toBeGreaterThan(0.999);
    expect(k('healthy-retail-peak').cmsOriginRps).toBeLessThan(10);
    expect(k('missing-s-maxage').launchUtilPct).toBeGreaterThan(100);
    expect(k('nextjs-prefetch-amplification').launchUtilPct).toBeGreaterThan(100);
    // Spiky pair: comfortable in steady state, over the limit at a 3x spike.
    const spiky = k('strict-window-spiky');
    expect(spiky.cmsUtilPct).toBeLessThan(70);
    expect(spiky.cmsOriginRps * 3).toBeGreaterThan(spiky.cmsLimitRps);
  });
});
