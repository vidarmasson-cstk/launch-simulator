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

  // Observed (deploy-during-peak, priming {paths: 2000, rps: 200} vs none): priming does not lower
  // the peak Launch origin rps (1556 vs 1366; the priming requests themselves add origin load right
  // at cutover) nor the worst-second visitor p95 (26.7 s vs 23.5 s). It only lifts the hit ratio
  // slightly from about 430 s on (0.57 vs 0.54 at 430 s). Kept as a todo instead of tuning the model.
  it.todo('How much does cache priming help on a deploy at peak? (lower peak origin or worst p95)');

  // Observed (strict-window-spiky, exponentialJitter base 200 ms cap 5000 vs sdkDefault): jitter
  // gives MORE CMS 429s (9819 vs 5903) and more error pages (2648 vs 932). Its first retries come
  // sooner than the SDK default's delay, so more attempts land in the still-saturated fixed window.
  // Kept as a todo instead of tuning the model.
  it.todo('Does exponential backoff with jitter help versus the SDK default? (fewer or equal CMS 429s)');
});
