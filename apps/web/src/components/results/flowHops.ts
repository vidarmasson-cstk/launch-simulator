import type { Hop, MetricsSeries } from '@launch-sim/engine';

/** Replace steady-state hop values with the values of one simulated second. */
export function hopsAtSecond(base: Hop[], series: MetricsSeries, second: number): Hop[] {
  const i = Math.min(series.length - 1, Math.max(0, Math.floor(second)));
  const v = (name: string) => series.columns[name]?.[i] ?? 0;
  const util = (rps: number, limit: number | undefined) =>
    limit && limit > 0 ? (100 * rps) / limit : undefined;
  return base.map((h): Hop => {
    switch (h.id) {
      case 'edge':
        return { ...h, rps: v('edgeRps') };
      case 'launchCdn':
        return { ...h, rps: Math.max(0, v('edgeRps') - v('staticRps')), hitRatio: v('launchHitRatio') };
      case 'launchOrigin':
        return { ...h, rps: v('launchOriginOffered'), utilPct: util(v('launchOriginOffered'), v('launchLimit') || h.limit), limit: v('launchLimit') || h.limit };
      case 'compute':
        return { ...h, rps: v('launchOriginAccepted'), utilPct: util(v('inFlight'), h.limit) };
      case 'cmsCdn':
        return { ...h, rps: v('cmsCalls'), hitRatio: v('cmsCdnHitRatio') };
      case 'cmsOrigin':
        return { ...h, rps: v('cmsOriginOffered'), utilPct: util(v('cmsOriginOffered'), v('cmsLimit') || h.limit), limit: v('cmsLimit') || h.limit };
      default:
        return h;
    }
  });
}
