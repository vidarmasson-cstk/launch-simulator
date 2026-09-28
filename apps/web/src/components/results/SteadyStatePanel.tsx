import type { SteadyStateResult } from '@launch-sim/engine';
import { statusOf } from './colors';
import { fmtBig, fmtNum, fmtPct, fmtProb, fmtRatio, fmtRps, fmtSecPerHour } from './format';
import { Kpi, KpiGrid } from './Kpi';
import { BOTTLENECK_LABEL, steadyVerdict } from './verdict';

export function SteadyStatePanel({ steady }: { steady: SteadyStateResult }) {
  const k = steady.kpis;
  return (
    <div className="space-y-3" role="tabpanel" aria-label="Steady state">
      <p className="rounded-lg border border-slate-200 bg-white p-3 text-sm leading-relaxed text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100">
        {steadyVerdict(steady)}
      </p>
      <KpiGrid label="Steady-state KPIs">
        <Kpi label="Edge requests" value={`${fmtRps(k.edgeRps)}/s`} sub="all visitor requests" />
        <Kpi label="Launch CDN hit ratio" value={fmtRatio(k.launchHitRatio)} sub="pages and data" />
        <Kpi
          label="Launch origin"
          value={`${fmtRps(k.launchOriginRps)}/s`}
          status={statusOf(k.launchUtilPct)}
          sub={`${fmtPct(k.launchUtilPct)} of ${fmtRps(k.launchLimitRps)}/s limit`}
        />
        <Kpi
          label="Compute"
          value={`${fmtNum(k.inFlight)} in flight`}
          status={statusOf(k.computeUtilPct)}
          sub={`${k.instancesNeeded} instances needed, ${fmtPct(k.computeUtilPct)} of capacity`}
        />
        <Kpi
          label="CMS calls per page view"
          value={fmtNum(k.cmsCallsPerPageView, 1)}
          sub={`${fmtRps(k.cmsCallsRps)} calls/s`}
        />
        <Kpi label="CMS CDN hit ratio" value={fmtRatio(k.cmsCdnHitRatio)} />
        <Kpi
          label="CMS origin"
          value={`${fmtRps(k.cmsOriginRps)}/s`}
          status={statusOf(k.cmsUtilPct)}
          sub={`${fmtPct(k.cmsUtilPct)} of ${fmtRps(k.cmsLimitRps)}/s limit`}
        />
        <Kpi
          label="P(429 second), CMS"
          value={fmtProb(k.pCms429Second)}
          sub={`${fmtSecPerHour(k.expectedCms429SecondsPerHour)} s/hour with 429s`}
          title="Probability that a given second's CMS origin count exceeds the limit"
        />
        <Kpi
          label="P(429 second), Launch"
          value={fmtProb(k.pLaunch429Second)}
          sub={`${fmtSecPerHour(k.expectedLaunch429SecondsPerHour)} s/hour with 429s`}
        />
        <Kpi
          label="Suggested CMS limit"
          value={`${fmtBig(k.suggestedCmsLimitRps)}/s`}
          sub={`current ${fmtRps(k.cmsLimitRps)}/s`}
          title="Smallest limit with at most one 429 second per hour, plus 20% margin"
        />
        <Kpi
          label="Monthly API calls"
          value={`${fmtBig(k.projectedMonthlyApiCalls.cached + k.projectedMonthlyApiCalls.uncached)}`}
          sub={`${fmtBig(k.projectedMonthlyApiCalls.cached)} cached · ${fmtBig(k.projectedMonthlyApiCalls.uncached)} uncached`}
        />
        <Kpi
          label="Bottleneck"
          value={BOTTLENECK_LABEL[k.bottleneck]}
          status={bottleneckStatus(k)}
          sub={bottleneckSub(k)}
        />
      </KpiGrid>
    </div>
  );
}

/** Over a limit (or timing out) is critical; merely the layer with the most expected 429 seconds is a warning. */
function bottleneckUtil(k: SteadyStateResult['kpis']): number | null {
  switch (k.bottleneck) {
    case 'launchOrigin':
      return k.launchUtilPct;
    case 'cmsOrigin':
      return k.cmsUtilPct;
    case 'compute':
      return k.computeUtilPct;
    default:
      return null;
  }
}

function bottleneckStatus(k: SteadyStateResult['kpis']): 'warn' | 'crit' | undefined {
  if (k.bottleneck === 'none') return undefined;
  if (k.bottleneck === 'timeout') return 'crit';
  const util = bottleneckUtil(k);
  return util !== null && util >= 100 ? 'crit' : 'warn';
}

function bottleneckSub(k: SteadyStateResult['kpis']): string | undefined {
  const util = bottleneckUtil(k);
  if (util === null) return k.bottleneck === 'timeout' ? 'renders exceed the timeout' : undefined;
  return util >= 100
    ? `${fmtPct(util)} of limit`
    : `${fmtPct(util)} of limit; bursts cause occasional 429s`;
}
