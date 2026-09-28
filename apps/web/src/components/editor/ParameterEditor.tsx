import { useState, type ReactNode } from 'react';
import { applyPlan } from '@launch-sim/engine';
import { useAppStore } from '../../state/store';
import { Icon, focusRing } from '../ui';
import { Field } from './Field';
import { FrameworkProfileEditor } from './FrameworkProfile';
import { EventsEditor } from './EventsEditor';
import { ProvenanceMark } from './ProvenanceBadge';

function Section({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-slate-200 dark:border-slate-800">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={`flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-semibold hover:bg-slate-100 dark:hover:bg-slate-900 ${focusRing}`}
        >
          <Icon name="chevron" className={`h-4 w-4 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`} />
          {title}
        </button>
      </h2>
      {open && <div className="px-3 pb-3">{children}</div>}
    </section>
  );
}

const Sub = ({ children }: { children: ReactNode }) => (
  <h3 className="mt-3 mb-0.5 border-b border-slate-100 pb-0.5 text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:border-slate-800 dark:text-slate-400">
    {children}
  </h3>
);

const Fields = ({ paths }: { paths: string[] }) => (
  <>
    {paths.map((p) => (
      <Field key={p} path={p} />
    ))}
  </>
);

function PlanControl() {
  const plan = useAppStore((s) => s.scenario.launch.plan);
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="flex-1 text-xs text-slate-700 dark:text-slate-300">
        Plan <span className="text-slate-400">(sets origin limit and revalidation quota)</span>
      </span>
      <div role="group" aria-label="Launch plan" className="flex overflow-hidden rounded border border-slate-300 dark:border-slate-600">
        {(['standard', 'enterprise'] as const).map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={plan === p}
            onClick={() => {
              const { scenario, setScenario } = useAppStore.getState();
              if (scenario.launch.plan !== p) setScenario(applyPlan(scenario, p));
            }}
            className={`px-2 py-1 text-xs capitalize ${plan === p ? 'bg-indigo-600 text-white' : 'bg-white hover:bg-slate-100 dark:bg-slate-900 dark:hover:bg-slate-800'} ${focusRing}`}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

const CACHE = (k: string) => [
  `site.cacheHeaders.${k}.cacheable`,
  `site.cacheHeaders.${k}.sMaxAgeSec`,
  `site.cacheHeaders.${k}.swrSec`,
  `site.cacheHeaders.${k}.staleIfErrorSec`,
];

function Legend() {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 border-b border-slate-200 px-3 py-2 text-[10px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
      {(
        [
          ['documented', 'documented'],
          ['conflicting', 'sources disagree'],
          ['observed', 'observed'],
          ['assumption', 'assumption / input'],
          ['private', 'private'],
        ] as const
      ).map(([k, l]) => (
        <span key={k} className="flex items-center gap-1">
          <ProvenanceMark kind={k} /> {l}
        </span>
      ))}
    </div>
  );
}

export function ParameterEditor() {
  const name = useAppStore((s) => s.scenario.name);
  const setParam = useAppStore((s) => s.setParam);
  return (
    <div aria-label="Parameter editor" className="bg-white dark:bg-slate-950">
      <div className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <label className="block text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
          Scenario name
          <input
            type="text"
            value={name}
            onChange={(e) => setParam('name', e.target.value)}
            className={`mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm font-normal tracking-normal text-slate-900 normal-case dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 ${focusRing}`}
          />
        </label>
      </div>
      <Legend />
      <Section title="Traffic" defaultOpen>
        <Fields
          paths={[
            'traffic.baseEdgeRps',
            'traffic.profile',
            'traffic.bots.share',
            'traffic.bots.randomQueryFraction',
            'traffic.bots.notFoundFraction',
            'traffic.bots.zipfAlpha',
          ]}
        />
      </Section>
      <Section title="Site & Framework" defaultOpen>
        <Field path="site.framework" />
        <FrameworkProfileEditor />
        <Sub>Content shape</Sub>
        <Fields
          paths={[
            'site.pages',
            'site.locales',
            'site.localeZipfAlpha',
            'site.zipfAlpha',
            'site.personalizeVariants',
            'site.uncacheableFraction',
            'site.globalKeys',
            'site.cmsCallsPerNotFound',
          ]}
        />
        <Sub>Cache headers: pages (HTML)</Sub>
        <Fields paths={CACHE('page')} />
        <Sub>Cache headers: data (RSC / JSON)</Sub>
        <Fields paths={CACHE('data')} />
        <Sub>Cache headers: functions / API routes</Sub>
        <Fields paths={CACHE('fn')} />
      </Section>
      <Section title="Launch Hosting">
        <PlanControl />
        <Fields paths={['launch.originLimitRps', 'launch.originBurstSec', 'launch.revalidation.dailyQuota']} />
        <Sub>Launch CDN</Sub>
        <Fields paths={['launch.cdn.domains', 'launch.cdn.collapse', 'launch.cdn.hitLatencyMs']} />
        <Sub>Customer CDN in front</Sub>
        <Fields
          paths={[
            'launch.externalCdn.enabled',
            'launch.externalCdn.ttlSec',
            'launch.externalCdn.cachesErrors',
            'launch.externalCdn.errorTtlSec',
          ]}
        />
        <Sub>Compute</Sub>
        <Fields
          paths={[
            'launch.compute.machine',
            'launch.compute.concurrencyPerInstance',
            'launch.compute.maxInstances',
            'launch.compute.minInstances',
            'launch.compute.scaleOutPerSec',
            'launch.compute.coldStartMs',
            'launch.compute.idleScaleToZeroSec',
            'launch.compute.scaleInDelaySec',
            'launch.compute.timeoutSec',
            'launch.compute.maxQueue',
          ]}
        />
      </Section>
      <Section title="Contentstack CMS">
        <Fields paths={['cms.api', 'cms.otherOrgTrafficRps', 'cms.contentTypes', 'cms.entriesPerType']} />
        <Sub>CDA (REST) limiter</Sub>
        <Fields paths={['cms.cda.limitRps', 'cms.cda.algorithm', 'cms.cda.burstMultiplierPct', 'cms.cda.maxWaitMs']} />
        <Sub>GraphQL limiter</Sub>
        <Fields
          paths={['cms.graphql.limitRps', 'cms.graphql.algorithm', 'cms.graphql.burstMultiplierPct', 'cms.graphql.maxWaitMs']}
        />
        <Sub>CMS CDN</Sub>
        <Fields
          paths={[
            'cms.cdn.domains',
            'cms.cdn.collapse',
            'cms.cdn.ttlSec',
            'cms.cdn.hitLatencyMs',
            'cms.cdn.originLatencyMs',
          ]}
        />
      </Section>
      <Section title="SDK & Retries">
        <Fields
          paths={[
            'sdk.retry.kind',
            'sdk.retry.retries',
            'sdk.retry.baseDelayMs',
            'sdk.retry.capDelayMs',
            'sdk.sdkRateLimitWaitMs',
            'sdk.sdkAssumeRemainingHeader',
            'sdk.onFinalFailure',
          ]}
        />
      </Section>
      <Section title="Events" defaultOpen>
        <EventsEditor />
        <Sub>Steady-state publishing (analytic view only)</Sub>
        <Fields
          paths={[
            'steady.publishesPerHour',
            'steady.entriesPerPublish',
            'steady.inTimeline',
            'steady.purge.pageQueries',
            'steady.purge.contentTypeLists',
            'steady.purge.referencingFraction',
            'steady.purge.globals',
          ]}
        />
      </Section>
      <Section title="Simulation">
        <Fields
          paths={[
            'sim.durationSec',
            'sim.dtSec',
            'sim.seed',
            'sim.stochastic',
            'sim.burstiness',
            'sim.warmHistorySec',
          ]}
        />
      </Section>
    </div>
  );
}
