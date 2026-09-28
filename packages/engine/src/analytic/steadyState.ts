import type { Scenario } from '../schema';
import type { SummaryKpis } from '../model/types';

/** Instant analytic steady-state model (DESIGN 6.9). Returns the same KPI shape as a timeline. */
export function steadyState(_scenario: Scenario): SummaryKpis {
  throw new Error('not implemented');
}
