import type { Scenario } from './schema';
import type { Finding, SummaryKpis } from './model/types';

/** Rule-based diagnostics and recommendations (DESIGN 6.10). */
export function analyzeFindings(_scenario: Scenario, _summary: SummaryKpis): Finding[] {
  throw new Error('not implemented');
}
