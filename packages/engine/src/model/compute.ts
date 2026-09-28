import type { ComputeConfig, ComputeStepResult, IComputeModel } from './types';

/** Launch compute: instances, concurrency, queue, cold start, timeout, autoscaling (DESIGN 6.5). */
export class ComputeModel implements IComputeModel {
  constructor(_config: ComputeConfig) {
    throw new Error('not implemented');
  }
  step(_tick: number, _acceptedArrivals: number, _serviceMs: number): ComputeStepResult {
    throw new Error('not implemented');
  }
  reset(): void {
    throw new Error('not implemented');
  }
}
