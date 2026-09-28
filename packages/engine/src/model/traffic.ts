import type { Rng } from '../rng';
import type { Scenario } from '../schema';
import type { ArrivalsByClass, EventEffects, ITrafficGenerator, TickContext } from './types';

/** Arrival generation: profile, spikes, bots (DESIGN 6.7 step 2). */
export class TrafficGenerator implements ITrafficGenerator {
  constructor(_scenario: Scenario, _rng: Rng) {
    throw new Error('not implemented');
  }
  arrivals(_ctx: TickContext, _effects: EventEffects): ArrivalsByClass {
    throw new Error('not implemented');
  }
}
