import type { Scenario } from '../schema';
import type { EventEffects, IEventTimeline, TickContext } from './types';

/** Event timeline to per-tick effects (DESIGN 6.7 step 1). */
export class EventTimeline implements IEventTimeline {
  constructor(_scenario: Scenario) {
    throw new Error('not implemented');
  }
  effectsAt(_ctx: TickContext): EventEffects {
    throw new Error('not implemented');
  }
}
