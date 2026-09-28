import type { ScenarioInput } from '../schema';

/**
 * Template scenarios for the presets gallery (DESIGN 8). Values come from RESEARCH.md section 5
 * (workload ranges) and the public limits in section 2; anything else is a flagged assumption in
 * the parameter registry. Every template parses with ScenarioSchema.
 */

export type TemplateCategory = 'baseline' | 'caching' | 'publishing' | 'traffic' | 'limits';

export interface ScenarioTemplate {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  scenario: ScenarioInput;
  /** Id of the template this one is meant to be compared against (Compare tab). */
  comparesWith?: string;
}

/** Enterprise plan: documented 1200 origin req/s and 2000 revalidations/day. */
const ENTERPRISE = {
  plan: 'enterprise',
  originLimitRps: 1200,
  revalidation: { dailyQuota: 2000 },
} as const;

/** The healthy calibration site, reused (with one change each) by templates 2 and 4-5. */
const HEALTHY_SITE = {
  pages: 5000,
  locales: 3,
  framework: 'nextjs-app',
  frameworkOverrides: { clientNavFraction: 0, prefetchPerView: 0 },
  cacheHeaders: {
    page: { cacheable: true, sMaxAgeSec: 3600, swrSec: 86400, staleIfErrorSec: 0 },
  },
} as const;

const HEALTHY_BOTS = { share: 0.01, randomQueryFraction: 0, notFoundFraction: 0.001 } as const;

/** Spiky workload shared by the strict-window / GCRA compare pair. */
const SPIKY = {
  sim: { durationSec: 900 },
  traffic: {
    baseEdgeRps: 400,
    bots: { share: 0.02, randomQueryFraction: 0.05, notFoundFraction: 0.01 },
  },
  site: {
    pages: 10000,
    locales: 4,
    framework: 'nextjs-app',
    frameworkOverrides: { clientNavFraction: 0, prefetchPerView: 0 },
    cacheHeaders: { page: { cacheable: true, sMaxAgeSec: 120, swrSec: 0, staleIfErrorSec: 0 } },
  },
  launch: ENTERPRISE,
  // An active editorial team: one background publish per minute keeps purging CMS keys.
  steady: {
    publishesPerHour: 60,
    entriesPerPublish: 5,
    purge: { pageQueries: true, contentTypeLists: true, referencingFraction: 0.05, globals: false },
  },
  sdk: { retry: { kind: 'sdkDefault', retries: 5, baseDelayMs: 300, capDelayMs: 10000 } },
  events: [
    { kind: 'spike', atSec: 200, durationSec: 20, multiplier: 3, rampSec: 2 },
    { kind: 'spike', atSec: 400, durationSec: 20, multiplier: 3, rampSec: 2 },
    { kind: 'spike', atSec: 600, durationSec: 20, multiplier: 3, rampSec: 2 },
  ],
} as const;

export const TEMPLATES: ScenarioTemplate[] = [
  {
    id: 'healthy-retail-peak',
    name: 'Healthy retail peak',
    category: 'baseline',
    description:
      'Calibration scenario: a well-cached retail site at about 8.2K page views/s with s-maxage 3600 and a day of stale-while-revalidate, an Enterprise Launch plan, and a 1.5x spike from 300 s to 600 s. It demonstrates what "healthy" looks like: a Launch hit ratio above 99.9%, a few tens of origin requests per second against a 1200 limit, and a CMS origin under a handful of requests per second against the 100 req/s CDA limit. Look at the flow diagram headroom and at how little the spike changes the origin load.',
    scenario: {
      name: 'Healthy retail peak',
      sim: { durationSec: 900 },
      traffic: { baseEdgeRps: 8200, bots: HEALTHY_BOTS },
      site: JSON.parse(JSON.stringify(HEALTHY_SITE)),
      launch: { ...ENTERPRISE },
      events: [{ kind: 'spike', atSec: 300, durationSec: 300, multiplier: 1.5, rampSec: 10 }],
    },
  },
  {
    id: 'missing-s-maxage',
    name: 'Missing s-maxage',
    category: 'caching',
    description:
      'The same traffic as the healthy retail peak, but the page response has no cache headers, so the Launch CDN cannot cache it. Every page view becomes an SSR render and several CMS calls: the Launch origin limit of 1200 req/s is exceeded many times over, visitors get 429s, and the renders that do run push the CMS origin toward its limit. Compare it with the healthy template: the only difference is Cache-Control. Look at the Launch origin gauge and the Findings tab.',
    scenario: {
      name: 'Missing s-maxage',
      sim: { durationSec: 900 },
      traffic: { baseEdgeRps: 8200, bots: HEALTHY_BOTS },
      site: {
        ...JSON.parse(JSON.stringify(HEALTHY_SITE)),
        cacheHeaders: { page: { cacheable: false, sMaxAgeSec: 0, swrSec: 0, staleIfErrorSec: 0 } },
      },
      launch: { ...ENTERPRISE },
      events: [{ kind: 'spike', atSec: 300, durationSec: 300, multiplier: 1.5, rampSec: 10 }],
    },
    comparesWith: 'healthy-retail-peak',
  },
  {
    id: 'bulk-publish-at-peak',
    name: 'Bulk publish at peak',
    category: 'publishing',
    description:
      'An editor publishes 500 entries at once (spread 0 s) while the site serves 800 page views/s. The purge scope is broad: page queries, content-type lists, 30% of referencing entries and the global header/footer queries. The publish also revalidates every path on Launch. The next requests miss at both layers in the same few seconds, so the CMS origin sees a burst far above the 100 req/s limit, and the SDK retries add to it. Look at the CMS origin chart just after 300 s, the 429 count, and the revalidation quota.',
    scenario: {
      name: 'Bulk publish at peak',
      sim: { durationSec: 900 },
      traffic: {
        baseEdgeRps: 800,
        bots: { share: 0.02, randomQueryFraction: 0.02, notFoundFraction: 0.005 },
      },
      site: {
        pages: 5000,
        locales: 3,
        framework: 'nextjs-app',
        // Per-card fetches (N+1): 12 calls per render, within the 5-140 range seen in cases.
        frameworkOverrides: { clientNavFraction: 0, prefetchPerView: 0, n1Calls: 6 },
        cacheHeaders: {
          page: { cacheable: true, sMaxAgeSec: 3600, swrSec: 86400, staleIfErrorSec: 0 },
        },
      },
      launch: { ...ENTERPRISE },
      events: [
        {
          kind: 'publish',
          atSec: 300,
          entries: 500,
          spreadSec: 0,
          locales: 'all',
          purge: {
            pageQueries: true,
            contentTypeLists: true,
            referencingFraction: 0.3,
            globals: true,
          },
          onPublish: 'revalidatePaths',
        },
      ],
    },
  },
  {
    id: 'deploy-during-peak',
    name: 'Deploy during peak',
    category: 'publishing',
    description:
      'A production redeploy finishes at 420 s (a 120 s build starting at 300 s) while the site serves 1500 page views/s. Launch purges the whole environment cache and compute restarts cold, with no cache priming. Every popular page misses at once: the Launch origin, the instance ramp-up and the CMS origin all take the hit together. Look at the hit ratio dip, queueing and 504s in the compute chart, and try adding priming for the top paths to the deploy event.',
    scenario: {
      name: 'Deploy during peak',
      sim: { durationSec: 900 },
      traffic: {
        baseEdgeRps: 1500,
        bots: { share: 0.02, randomQueryFraction: 0.02, notFoundFraction: 0.005 },
      },
      site: {
        pages: 5000,
        locales: 3,
        framework: 'nextjs-app',
        frameworkOverrides: { clientNavFraction: 0, prefetchPerView: 0 },
        cacheHeaders: {
          page: { cacheable: true, sMaxAgeSec: 600, swrSec: 3600, staleIfErrorSec: 0 },
        },
      },
      launch: { ...ENTERPRISE },
      events: [{ kind: 'deploy', atSec: 300, buildSec: 120, priming: { paths: 0, rps: 0 } }],
    },
  },
  {
    id: 'multi-market-go-live',
    name: 'Multi-market go-live',
    category: 'publishing',
    description:
      'A 20-locale site with 3000 pages launches with completely cold caches at 0 s, and traffic doubles from 60 s as markets come online. About 60K distinct URLs are all cold, so the cold-launch hit ratio starts near zero and takes minutes to climb toward 90-95% (RESEARCH section 5). Look at how long the Launch and CMS origins stay above their steady-state level, and how the locale count multiplies the number of cold keys.',
    scenario: {
      name: 'Multi-market go-live',
      sim: { durationSec: 900 },
      traffic: {
        baseEdgeRps: 600,
        bots: { share: 0.02, randomQueryFraction: 0.02, notFoundFraction: 0.005 },
      },
      site: {
        pages: 3000,
        locales: 20,
        localeZipfAlpha: 0.5,
        framework: 'nextjs-app',
        frameworkOverrides: { clientNavFraction: 0, prefetchPerView: 0 },
        cacheHeaders: {
          page: { cacheable: true, sMaxAgeSec: 3600, swrSec: 86400, staleIfErrorSec: 0 },
        },
      },
      launch: { ...ENTERPRISE },
      events: [
        { kind: 'goLive', atSec: 0 },
        { kind: 'spike', atSec: 60, durationSec: 840, multiplier: 2, rampSec: 120 },
      ],
    },
  },
  {
    id: 'ai-crawler-random-query',
    name: 'AI crawler with random query strings',
    category: 'traffic',
    description:
      'From 300 s to 900 s a crawler sends 150 req/s; 80% of its URLs carry random query strings (cache-busting, so always a Launch miss) and 10% are 404s (never cached). Each miss is a full SSR render plus CMS calls, and the 404s still query the CMS. The bot traffic is small at the edge but dominates the origin. Look at the origin share from bot-unique and 404 traffic, and try WAF-style reductions of the random-query fraction.',
    scenario: {
      name: 'AI crawler with random query strings',
      sim: { durationSec: 1200 },
      traffic: {
        baseEdgeRps: 300,
        bots: { share: 0.02, randomQueryFraction: 0.05, notFoundFraction: 0.01 },
      },
      site: {
        pages: 5000,
        locales: 3,
        framework: 'nextjs-app',
        frameworkOverrides: { clientNavFraction: 0, prefetchPerView: 0 },
        cacheHeaders: {
          page: { cacheable: true, sMaxAgeSec: 3600, swrSec: 86400, staleIfErrorSec: 0 },
        },
      },
      launch: { plan: 'standard', originLimitRps: 200 },
      events: [
        {
          kind: 'crawler',
          atSec: 300,
          durationSec: 600,
          rps: 150,
          randomQueryFraction: 0.8,
          notFoundFraction: 0.1,
        },
      ],
    },
  },
  {
    id: 'nextjs-prefetch-amplification',
    name: 'Next.js prefetch amplification',
    category: 'traffic',
    description:
      'Next.js App Router with default costs, but every page view fires 5 <Link> prefetches and 70% of views are client navigations. On Launch the RSC/data requests are not cached, so each is an origin render: 300 page views/s turn into well over a thousand origin requests/s. Look at the origin gauge and at CMS calls per page view; then set dataCacheable (with a data s-maxage) or lower prefetchPerView to see the amplification disappear.',
    scenario: {
      name: 'Next.js prefetch amplification',
      sim: { durationSec: 900 },
      traffic: {
        baseEdgeRps: 300,
        bots: { share: 0.02, randomQueryFraction: 0.02, notFoundFraction: 0.005 },
      },
      site: {
        pages: 5000,
        locales: 3,
        framework: 'nextjs-app',
        frameworkOverrides: { prefetchPerView: 5, clientNavFraction: 0.7, dataCacheable: false },
        cacheHeaders: {
          page: { cacheable: true, sMaxAgeSec: 3600, swrSec: 86400, staleIfErrorSec: 0 },
        },
      },
      launch: { ...ENTERPRISE },
    },
  },
  {
    id: '429-cached-as-404',
    name: '429 cached as 404 by a customer CDN',
    category: 'limits',
    description:
      'A 4x traffic spike at 300 s pushes the CMS origin over its limit. The app renders a 404 when a CMS call finally fails, and the customer-managed CDN in front of Launch caches that 404 for 5 minutes. A burst that would last seconds becomes minutes of visible "page not found". Look at visitor errors after the spike ends, and try switching onFinalFailure to error500 or turning off error caching on the external CDN.',
    scenario: {
      name: '429 cached as 404 by a customer CDN',
      sim: { durationSec: 1200 },
      traffic: {
        baseEdgeRps: 500,
        bots: { share: 0.02, randomQueryFraction: 0.02, notFoundFraction: 0.005 },
      },
      site: {
        pages: 20000,
        locales: 5,
        framework: 'nextjs-app',
        frameworkOverrides: { clientNavFraction: 0, prefetchPerView: 0 },
        cacheHeaders: { page: { cacheable: true, sMaxAgeSec: 60, swrSec: 0, staleIfErrorSec: 0 } },
      },
      launch: {
        ...ENTERPRISE,
        externalCdn: { enabled: true, ttlSec: 60, cachesErrors: true, errorTtlSec: 300 },
      },
      steady: {
        publishesPerHour: 60,
        entriesPerPublish: 5,
        purge: {
          pageQueries: true,
          contentTypeLists: true,
          referencingFraction: 0.05,
          globals: false,
        },
      },
      sdk: {
        retry: { kind: 'sdkDefault', retries: 5, baseDelayMs: 300, capDelayMs: 10000 },
        onFinalFailure: 'render404',
      },
      events: [{ kind: 'spike', atSec: 300, durationSec: 120, multiplier: 4, rampSec: 5 }],
    },
  },
  {
    id: 'strict-window-spiky',
    name: 'Strict window, spiky load',
    category: 'limits',
    description:
      'A steady 400 page views/s with three 20 s spikes of 3x, against the legacy strict rate limiter (fixed 1 s window, no burst allowance). The spikes lift CMS cache misses above the 100 req/s limit for a few seconds at a time, so requests are rejected outright and the fixed-delay SDK retries pulse back in. Compare with the GCRA twin: identical workload, only the limiter differs. Look at 429 counts and retries.',
    scenario: {
      name: 'Strict window, spiky load',
      ...JSON.parse(JSON.stringify(SPIKY)),
      cms: {
        cda: { limitRps: 100, algorithm: 'fixedWindow', burstMultiplierPct: 100, maxWaitMs: 0 },
      },
    },
    comparesWith: 'gcra-burst-spiky',
  },
  {
    id: 'gcra-burst-spiky',
    name: 'Burst-aware GCRA, spiky load',
    category: 'limits',
    description:
      'The same spiky workload as the strict-window twin, but the CMS limiter is burst-aware (GCRA): 200% burst tolerance and up to 3 s of queueing. Bursts above the limit are absorbed and delayed instead of rejected, so 429s and retries drop while render latency rises during the spikes. Only the existence of burst-aware limiting is public; the parameters here are assumptions. Compare 429s against latency and timeouts.',
    scenario: {
      name: 'Burst-aware GCRA, spiky load',
      ...JSON.parse(JSON.stringify(SPIKY)),
      cms: {
        cda: { limitRps: 100, algorithm: 'gcra', burstMultiplierPct: 200, maxWaitMs: 3000 },
      },
    },
    comparesWith: 'strict-window-spiky',
  },
  {
    id: 'staging-job-shares-budget',
    name: 'Staging job shares the budget',
    category: 'limits',
    description:
      'Production serves 800 page views/s and stays well inside the CMS limit on its own. From 300 s to 600 s a staging job or build in the same organization adds 60 req/s to the CMS origin. Rate limits are per organization, so the extra load is charged to the same 100 req/s budget and production sees 429s. Look at the CMS origin chart during the window and at the share of the budget taken by other traffic.',
    scenario: {
      name: 'Staging job shares the budget',
      sim: { durationSec: 900 },
      traffic: {
        baseEdgeRps: 800,
        bots: { share: 0.02, randomQueryFraction: 0.02, notFoundFraction: 0.005 },
      },
      site: {
        pages: 8000,
        locales: 4,
        framework: 'nextjs-app',
        frameworkOverrides: { clientNavFraction: 0, prefetchPerView: 0 },
        cacheHeaders: {
          page: { cacheable: true, sMaxAgeSec: 300, swrSec: 600, staleIfErrorSec: 0 },
        },
      },
      launch: { ...ENTERPRISE },
      cms: { otherOrgTrafficRps: 5 },
      steady: {
        publishesPerHour: 60,
        entriesPerPublish: 5,
        purge: {
          pageQueries: true,
          contentTypeLists: true,
          referencingFraction: 0.05,
          globals: false,
        },
      },
      events: [{ kind: 'otherTraffic', atSec: 300, durationSec: 300, rps: 60 }],
    },
  },
];

export function getTemplate(id: string): ScenarioTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
