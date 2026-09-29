export interface Source {
  title: string;
  url: string;
  accessed: string;
}

const A = '2026-09-28';
const s = (title: string, url: string): Source => ({ title, url, accessed: A });
const D = 'https://www.contentstack.com/docs';

/** Public sources. Every URL appears in the public research notes. */
export const SOURCES: Record<string, Source> = {
  'launch-platform-limits': s('Launch platform limits', `${D}/launch/platform-limits-on-launch`),
  'launch-revalidate': s('Launch: revalidate CDN cache', `${D}/launch/revalidate-cdn-cache`),
  'launch-faqs': s('Launch FAQs', `${D}/launch/faqs`),
  'launch-machines': s('Launch server machines', `${D}/launch/server-machines-on-launch`),
  'launch-nextjs': s('Next.js on Launch', `${D}/launch/nextjs-on-launch`),
  'launch-caching-guide': s(
    'Launch caching guide',
    `${D}/launch/caching-guide-for-contentstack-launch`,
  ),
  'launch-cache-priming': s('Launch cache priming', `${D}/launch/cache-priming`),
  'launch-rsc': s(
    'Handling Next.js RSC issues on Launch',
    `${D}/launch/handling-nextjs-rsc-issues-on-launch`,
  ),
  'launch-concepts': s(
    'Launch definitions and core concepts',
    `${D}/launch/launch-definitions-and-core-concepts`,
  ),
  'launch-edge-functions': s('Launch Edge Functions', `${D}/launch/edge-functions`),
  'launch-framework-support': s('Launch framework support', `${D}/launch/launch-framework-support`),
  'launch-go-live': s('Launch go-live guide', `${D}/launch/go-live-guide`),
  'launch-load-testing': s('Launch load testing', `${D}/launch/load-testing`),
  'launch-invisible-shield': s(
    'The invisible shield: how Launch protects every customer at scale',
    'https://www.contentstack.com/blog/tech-talk/the-invisible-shield-how-contentstack-launch-protects-every-customer-at-scale',
  ),
  'cda-api': s('Content Delivery API reference', `${D}/developers/apis/content-delivery-api`),
  'graphql-api': s(
    'GraphQL Content Delivery API reference',
    `${D}/developers/apis/graphql-content-delivery-api`,
  ),
  'image-delivery-api': s(
    'Image Delivery API reference (older 80 rps wording)',
    `${D}/developers/apis/image-delivery-api`,
  ),
  'cma-api': s('Content Management API reference', `${D}/developers/apis/content-management-api`),
  'cms-cdn-cache': s(
    'Contentstack CDN cache management',
    `${D}/headless-cms/contentstack-cdn-cache-management`,
  ),
  'cms-cache-purging': s('Cache purging scenarios', `${D}/headless-cms/cache-purging-scenarios`),
  'cms-purge-best-practices': s(
    'Front-end CDN cache purging best practices',
    `${D}/headless-cms/front-end-cdn-cache-purging-best-practices`,
  ),
  'cms-webhook-retry': s('Webhook retry policy', `${D}/headless-cms/webhook-retry-policy`),
  'sdk-js-core-source': s(
    'contentstack-js-core: delivery SDK retry handler (source)',
    'https://github.com/contentstack/contentstack-js-core/blob/main/src/lib/retryPolicy/delivery-sdk-handlers.ts',
  ),
  'sdk-js-core-client': s(
    'contentstack-js-core: client (source)',
    'https://github.com/contentstack/contentstack-js-core/blob/main/src/lib/contentstack-core.ts',
  ),
  'sdk-typescript-repo': s(
    'contentstack-typescript SDK',
    'https://github.com/contentstack/contentstack-typescript',
  ),
  'nextjs-link': s(
    'Next.js Link component',
    'https://nextjs.org/docs/app/api-reference/components/link',
  ),
  'nextjs-gssp': s(
    'Next.js getServerSideProps',
    'https://nextjs.org/docs/pages/building-your-application/data-fetching/get-server-side-props',
  ),
  'nitro-cache': s('Nitro cache', 'https://nitro.build/docs/cache'),
  'nuxt-data-fetching': s(
    'Nuxt data fetching',
    'https://nuxt.com/docs/4.x/getting-started/data-fetching',
  ),
  'react-router-revalidation': s(
    'React Router: optimize revalidation',
    'https://github.com/remix-run/react-router/blob/main/docs/how-to/optimize-revalidation.md',
  ),
  'sveltekit-load': s('SvelteKit load', 'https://svelte.dev/docs/kit/load'),
  'angular-ssr': s('Angular SSR guide', 'https://angular.dev/guide/ssr'),
  'astro-on-demand': s(
    'Astro on-demand rendering',
    'https://docs.astro.build/en/guides/on-demand-rendering/',
  ),
  'aws-backoff-jitter': s(
    'AWS Architecture Blog: exponential backoff and jitter',
    'https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/',
  ),
  'sre-cascading-failures': s(
    'Google SRE Book: addressing cascading failures',
    'https://sre.google/sre-book/addressing-cascading-failures/',
  ),
  'brooker-simulation': s(
    'Brooker: simple simulations for system builders',
    'https://brooker.co.za/blog/2022/04/11/simulation.html',
  ),
  'breslau-zipf': s(
    'Web caching and Zipf-like distributions (Breslau et al.)',
    'https://pages.cs.wisc.edu/~cao/papers/zipf-implications.html',
  ),
  'ttl-cache-model': s(
    'Modeling TTL-based Internet caches',
    'https://www.researchgate.net/publication/4020982_Modeling_TTL-based_Internet_caches',
  ),
  'vattani-stampede': s(
    'Optimal probabilistic cache stampede prevention (Vattani et al.)',
    'https://www.vldb.org/pvldb/vol8/p886-vattani.pdf',
  ),
  'rfc2697-token-bucket': s(
    'RFC 2697: single rate three color marker',
    'https://www.rfc-editor.org/rfc/rfc2697',
  ),
};
