import { describe, expect, it } from 'vitest';
import { ScenarioSchema, type ScenarioInput } from '../src/schema';
import { getTemplate } from '../src/scenarios';
import { runSimulation } from '../src/model/pipeline';
import { computeSteadyState } from '../src/analytic/steadyState';
import { setByPath } from '../src/params/registry';

/**
 * Architect questions from docs/RESEARCH.md section 4, encoded as acceptance tests: the simulator
 * should answer each of them sensibly using the shipped templates.
 */

function template(id: string): ScenarioInput {
  const t = getTemplate(id);
  if (!t) throw new Error(`unknown template ${id}`);
  return JSON.parse(JSON.stringify(t.scenario)) as ScenarioInput;
}

function simulate(input: ScenarioInput) {
  return runSimulation(ScenarioSchema.parse(input));
}

describe('acceptance: architect questions (RESEARCH section 4)', () => {
  it('What rate limit should we request? Following the suggestion removes most CMS 429s', () => {
    const input = template('bulk-publish-at-peak');
    const before = simulate(input);
    const current = ScenarioSchema.parse(input).cms.cda.limitRps;
    const suggested = before.summary.suggestedCmsLimitRps;
    expect(suggested).toBeGreaterThan(current);
    expect(before.summary.totalCms429).toBeGreaterThan(0);

    const after = simulate(setByPath(input, 'cms.cda.limitRps', suggested));
    expect(after.summary.totalCms429).toBeLessThan(0.1 * before.summary.totalCms429);
  });

  it('Do error responses count toward the limit? More 404s raise the CMS origin load', () => {
    const base = template('healthy-retail-peak');
    const rpsAt = (f: number) =>
      computeSteadyState(ScenarioSchema.parse(setByPath(base, 'traffic.bots.notFoundFraction', f)))
        .kpis.cmsOriginRps;
    const low = rpsAt(0.001);
    const high = rpsAt(0.2);
    expect(high).toBeGreaterThan(low);
  });

  // Priming runs before cutover (origin renders of the new deployment) and warms the top keys in
  // the Launch cache at cutover. Observed (deploy-during-peak, priming {paths: 2000, rps: 200} vs
  // none): peak Launch origin rps after cutover 643 vs 1366; worst-second visitor p95 7.1 s vs 23.5 s.
  it('How much does cache priming help on a deploy at peak? Lower peak origin and worst p95', () => {
    const base = template('deploy-during-peak');
    const primed = template('deploy-during-peak');
    const ev = primed.events?.[0];
    if (!ev || ev.kind !== 'deploy') throw new Error('deploy event expected');
    ev.priming = { paths: 2000, rps: 200 };
    const cutover = 420;
    const peakAfter = (r: ReturnType<typeof simulate>) => {
      const col = r.series.columns.launchOriginOffered!;
      let m = 0;
      for (let i = cutover; i < col.length; i++) m = Math.max(m, col[i]!);
      return m;
    };
    const without = simulate(base);
    const withPrime = simulate(primed);
    expect(peakAfter(withPrime)).toBeLessThan(0.75 * peakAfter(without));
    expect(withPrime.summary.worstSecondVisitorP95Ms).toBeLessThan(
      without.summary.worstSecondVisitorP95Ms,
    );
  });

  // Which retry policy helps? Under a strict 1 s window, retries that return within the window are
  // rejected again. Observed: jittered backoff from 200 ms or 1 s gives MORE error pages than the SDK
  // default on these templates (e.g. 2648 vs 932), while few retries starting at >= 1 s never do
  // worse. Retry comparisons are approximate in v1 (render failure uses same-tick p429).
  it('Which retry policy helps? Few retries starting after one window beat the SDK default', () => {
    const retry = { kind: 'exponential', retries: 2, baseDelayMs: 1000, capDelayMs: 4000 } as const;
    for (const id of ['strict-window-spiky', 'bulk-publish-at-peak']) {
      const base = template(id);
      const tuned = template(id);
      tuned.sdk = { ...(tuned.sdk ?? {}), retry };
      expect(simulate(tuned).summary.errorPagesServed).toBeLessThanOrEqual(
        simulate(base).summary.errorPagesServed,
      );
    }
  });
});
