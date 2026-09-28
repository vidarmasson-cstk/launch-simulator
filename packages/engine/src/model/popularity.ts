import type { PopularityBin, PopularityConfig } from './types';

const notImplemented = (): never => {
  throw new Error('not implemented');
};

/** Zipf key-space binning (DESIGN 6.1). Bins sum to 1 in n*p. */
export function buildPopularityBins(_config: PopularityConfig): PopularityBin[] {
  return notImplemented();
}
