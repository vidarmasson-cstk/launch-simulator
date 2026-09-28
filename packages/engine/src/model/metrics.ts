import type { Scenario } from '../schema';
import type { MetricsSeries, SummaryKpis } from './types';

/** Per-second series and summary KPIs (DESIGN 6.8). */
export class MetricsCollector {
  constructor(_scenario: Scenario) {
    throw new Error('not implemented');
  }
  series(): MetricsSeries {
    throw new Error('not implemented');
  }
  summary(): SummaryKpis {
    throw new Error('not implemented');
  }
}
