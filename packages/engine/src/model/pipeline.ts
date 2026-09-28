import type { Scenario } from '../schema';
import type { SimulationResult } from './types';

/** Tick loop wiring all components (DESIGN 6.7). */
export function runSimulation(_scenario: Scenario): SimulationResult {
  throw new Error('not implemented');
}
