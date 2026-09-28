import type {
  CacheLayerConfig,
  CacheLayerState,
  CacheStepResult,
  ICacheLayer,
  PopularityBin,
} from './types';

/** Generic fluid TTL cache (DESIGN 6.2): SWR, request collapsing, purge, error caching. */
export class CacheLayer implements ICacheLayer {
  constructor(_config: CacheLayerConfig, _bins: PopularityBin[]) {
    throw new Error('not implemented');
  }
  step(_tick: number, _lambdaPerBin: Float64Array): CacheStepResult {
    throw new Error('not implemented');
  }
  scheduleCompletions(
    _tick: number,
    _perBinAmounts: Float64Array,
    _completionTick: number,
    _successFraction: number,
  ): void {
    throw new Error('not implemented');
  }
  purge(_fraction: number | Float64Array): void {
    throw new Error('not implemented');
  }
  hitRatio(): number {
    throw new Error('not implemented');
  }
  state(): CacheLayerState {
    throw new Error('not implemented');
  }
}
