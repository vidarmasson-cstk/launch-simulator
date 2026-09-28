import type { SteadyStateResult, SummaryKpis } from '@launch-sim/engine';
import { fmtPct, fmtRps, fmtSecPerHour } from './format';

export const BOTTLENECK_LABEL: Record<SummaryKpis['bottleneck'], string> = {
  none: 'None',
  launchOrigin: 'Launch origin limit',
  compute: 'Launch compute',
  cmsOrigin: 'CMS origin limit',
  timeout: 'Render timeouts',
};

function limitSentence(name: string, util: number, rps: number, limit: number, secPerHour: number): string {
  const risk =
    secPerHour < 0.05
      ? '~0 seconds/hour with 429s expected'
      : `~${fmtSecPerHour(secPerHour)} seconds/hour with 429s expected`;
  return `${name} at ${fmtPct(util)} of the limit (${fmtRps(rps)} of ${fmtRps(limit)} req/s); ${risk}.`;
}

/** Plain-language verdict for the steady-state tab. */
export function steadyVerdict(steady: SteadyStateResult): string {
  const k = steady.kpis;
  const parts = [
    limitSentence('CMS origin', k.cmsUtilPct, k.cmsOriginRps, k.cmsLimitRps, k.expectedCms429SecondsPerHour),
    limitSentence(
      'Launch origin',
      k.launchUtilPct,
      k.launchOriginRps,
      k.launchLimitRps,
      k.expectedLaunch429SecondsPerHour,
    ),
  ];
  parts.push(
    k.computeUtilPct >= 100
      ? `Compute is saturated (${fmtPct(k.computeUtilPct)} of capacity); expect queueing and timeouts.`
      : `Compute needs about ${k.instancesNeeded} instances (${fmtPct(k.computeUtilPct)} of capacity).`,
  );
  if (k.bottleneck !== 'none') parts.push(`First bottleneck: ${BOTTLENECK_LABEL[k.bottleneck]}.`);
  return parts.join(' ');
}
