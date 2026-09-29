import type { FrameworkId, FrameworkProfile, Scenario } from '../schema';

/**
 * Framework presets (DESIGN 6.6). All values are `assumption` provenance unless a profile's
 * `notes` says otherwise. They are editable per scenario through `site.frameworkOverrides`.
 */

const NONE = { scope: 'none', ttlSec: 0, appliesTo: [] } as const;

function ssr(
  id: FrameworkId,
  label: string,
  v: Omit<FrameworkProfile, 'id' | 'label' | 'renderMode' | 'serverCache' | 'runtimeCms'> &
    Partial<Pick<FrameworkProfile, 'serverCache' | 'runtimeCms'>>,
): FrameworkProfile {
  return {
    id,
    label,
    renderMode: 'ssr',
    serverCache: { ...NONE, appliesTo: [] },
    runtimeCms: true,
    ...v,
  };
}

function staticSite(id: FrameworkId, label: string, notes: string): FrameworkProfile {
  return {
    id,
    label,
    renderMode: 'static',
    globalCalls: 0,
    pageCalls: 0,
    listCalls: 0,
    n1Calls: 0,
    sequentialWaves: 0,
    cpuRenderMsL1: 0,
    clientNavFraction: 0,
    dataRequestsPerNav: 0,
    navRenderCallFraction: 0,
    prefetchPerView: 0,
    dataCacheable: false,
    clientCmsCallsPerNav: 0,
    serverCache: { ...NONE, appliesTo: [] },
    runtimeCms: false,
    notes,
  };
}

const NEXTJS_APP = ssr('nextjs-app', 'Next.js App Router', {
  globalCalls: 3,
  pageCalls: 1,
  listCalls: 1,
  n1Calls: 0,
  sequentialWaves: 2,
  cpuRenderMsL1: 40,
  clientNavFraction: 0.6,
  dataRequestsPerNav: 1,
  navRenderCallFraction: 0.6,
  prefetchPerView: 3,
  dataCacheable: false,
  clientCmsCallsPerNav: 0,
  notes:
    'Documented: Launch does not support the App Router Data Cache or revalidateTag, so SDK calls are not memoized across requests; RSC requests bypass the CDN. Call counts, waves, CPU and client-nav shape are assumptions.',
});

export const FRAMEWORKS: Record<FrameworkId, FrameworkProfile> = {
  'nextjs-app': NEXTJS_APP,
  'nextjs-pages': ssr('nextjs-pages', 'Next.js Pages Router (getServerSideProps)', {
    globalCalls: 3,
    pageCalls: 1,
    listCalls: 1,
    n1Calls: 0,
    sequentialWaves: 2,
    cpuRenderMsL1: 20,
    clientNavFraction: 0.6,
    dataRequestsPerNav: 1,
    navRenderCallFraction: 1,
    prefetchPerView: 0,
    dataCacheable: false,
    clientCmsCallsPerNav: 0,
    notes: 'getServerSideProps runs on every view and on every client navigation (_next/data).',
  }),
  nuxt: ssr('nuxt', 'Nuxt 3/4 (SSR)', {
    globalCalls: 3,
    pageCalls: 1,
    listCalls: 1,
    n1Calls: 0,
    sequentialWaves: 1,
    cpuRenderMsL1: 15,
    clientNavFraction: 0.6,
    dataRequestsPerNav: 0,
    navRenderCallFraction: 0,
    prefetchPerView: 0,
    dataCacheable: false,
    clientCmsCallsPerNav: 2,
    notes: 'Client navigation fetches from the browser (CMS CDN), not via Launch.',
  }),
  'astro-ssr': ssr('astro-ssr', 'Astro (on-demand SSR)', {
    globalCalls: 2,
    pageCalls: 1,
    listCalls: 1,
    n1Calls: 0,
    sequentialWaves: 1,
    cpuRenderMsL1: 10,
    clientNavFraction: 0,
    dataRequestsPerNav: 0,
    navRenderCallFraction: 0,
    prefetchPerView: 0,
    dataCacheable: false,
    clientCmsCallsPerNav: 0,
  }),
  'astro-static': staticSite(
    'astro-static',
    'Astro (static)',
    'CMS is called at build time only; no runtime CMS calls.',
  ),
  remix: ssr('remix', 'Remix / React Router 7 (framework mode)', {
    globalCalls: 2,
    pageCalls: 1,
    listCalls: 1,
    n1Calls: 0,
    sequentialWaves: 1,
    cpuRenderMsL1: 5,
    clientNavFraction: 0.6,
    dataRequestsPerNav: 1,
    navRenderCallFraction: 1,
    prefetchPerView: 0,
    dataCacheable: false,
    clientCmsCallsPerNav: 0,
    notes: 'Loaders re-run on every navigation.',
  }),
  sveltekit: ssr('sveltekit', 'SvelteKit (SSR)', {
    globalCalls: 2,
    pageCalls: 1,
    listCalls: 1,
    n1Calls: 0,
    sequentialWaves: 1,
    cpuRenderMsL1: 5,
    clientNavFraction: 0.6,
    dataRequestsPerNav: 1,
    navRenderCallFraction: 0.5,
    prefetchPerView: 0,
    dataCacheable: false,
    clientCmsCallsPerNav: 0,
    notes: 'Only changed load dependencies re-run on navigation.',
  }),
  'angular-ssr': ssr('angular-ssr', 'Angular SSR', {
    globalCalls: 2,
    pageCalls: 1,
    listCalls: 1,
    n1Calls: 0,
    sequentialWaves: 2,
    cpuRenderMsL1: 30,
    clientNavFraction: 0.6,
    dataRequestsPerNav: 0,
    navRenderCallFraction: 0,
    prefetchPerView: 0,
    dataCacheable: false,
    clientCmsCallsPerNav: 2,
    notes: 'Client navigation fetches from the browser (CMS CDN), not via Launch.',
  }),
  'gatsby-ssg': staticSite(
    'gatsby-ssg',
    'Gatsby / pure SSG',
    'CMS is called at build time only; no runtime CMS calls.',
  ),
  custom: {
    ...NEXTJS_APP,
    id: 'custom',
    label: 'Custom',
    serverCache: { ...NEXTJS_APP.serverCache, appliesTo: [] },
    notes: 'Starts as a copy of the Next.js App Router values; edit via frameworkOverrides.',
  },
};

export const FRAMEWORK_LIST: FrameworkProfile[] = Object.values(FRAMEWORKS);

/** Preset merged with `site.frameworkOverrides` (shallow merge; undefined overrides ignored). */
export function resolveFramework(scenario: Pick<Scenario, 'site'>): FrameworkProfile {
  const base = FRAMEWORKS[scenario.site.framework];
  const merged: FrameworkProfile = { ...base, serverCache: { ...base.serverCache } };
  const overrides = scenario.site.frameworkOverrides as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
  }
  return merged;
}

/** Launch server machine vCPU counts (documented: L1 0.5, L2 1, L3 2). */
export const MACHINE_VCPU = { L1: 0.5, L2: 1, L3: 2 } as const;

/** cpuMs(machine) = cpuRenderMsL1 x (0.5 / vCPU(machine)); linear scaling is an assumption. */
export function cpuMsForMachine(cpuRenderMsL1: number, machine: keyof typeof MACHINE_VCPU): number {
  return cpuRenderMsL1 * (0.5 / MACHINE_VCPU[machine]);
}
