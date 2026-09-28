# Research: why Launch sites fail under load

This document summarizes the research behind the simulator. It combines public Contentstack documentation with an anonymized review of about a year of support cases, engineering tickets, and customer and architecture calls.

It contains **no customer names and no internal-only numbers**. Every number here is either publicly documented (with a link) or explicitly labelled as an observation or assumption. Numbers change, so re-verify them against current docs before quoting them.

Research date: 2026-09-28.

---

## 1. The request path

A Launch-hosted site has **two cache layers and two independent sets of rate limits**:

```
visitor ─▶ Launch CDN (Cloudflare) ──miss──▶ Launch origin: rate limiter ─▶ SSR / Cloud Functions
                                                                      │
                                                   CMS SDK calls (N per render)
                                                                      ▼
                                  CMS CDN (Delivery/GraphQL) ──miss──▶ CMS origin: per-org rate limiter
```

Only **cache misses** count against rate limits, at both layers. Two relations follow from that, and most customer issues come down to them:

```
Launch origin rps = edge rps × Launch miss ratio
CMS origin rps    = Launch origin rps × CMS calls per render × CMS miss ratio  (+ other org traffic)
```

Both limits are **per organization**. Every stack, environment, locale, staging job, build and CI pipeline in the org draws from the same budget.

## 2. Key documented limits

| Parameter | Value | Scope | Source |
|---|---|---|---|
| Launch origin (cache-miss) delivery rate limit | 200 req/s (Non-Enterprise), 1200 req/s (Enterprise, raisable) | org | [Launch platform limits](https://www.contentstack.com/docs/launch/platform-limits-on-launch) |
| Cache hits count toward Launch origin limit | No | — | same |
| Launch default request timeout | 30 s (up to 780 s on request) | request | same |
| Launch max time-to-first-byte | 98 s | request | same |
| Launch response body limit / response headers | 5 MB / 32 KB | request | same |
| Launch daily on-demand cache revalidations | 500 (Non-Enterprise), 2000 (Enterprise) | org/day | same |
| Launch redeploy | Purges the environment's entire CDN cache | environment | [Revalidate CDN cache](https://www.contentstack.com/docs/launch/revalidate-cdn-cache) |
| Launch 404/error responses | Never cached | — | [Launch FAQs](https://www.contentstack.com/docs/launch/faqs) |
| Launch server machines | L1 0.5 vCPU/1 GiB (default), L2 1/2, L3 2/4 | instance | [Server machines](https://www.contentstack.com/docs/launch/server-machines-on-launch) |
| Launch build max duration | 60 min | build | [Build machines](https://www.contentstack.com/docs/launch/build-machines-on-launch) |
| Launch Edge Functions | 128 MB memory, 400 ms startup, 1 MiB bundle | function | [Edge Functions](https://www.contentstack.com/docs/launch/edge-functions) |
| Next.js on Launch | Middleware runs at origin, not edge; ISR revalidation, `revalidatePath`, `revalidateTag`, and the App Router Data Cache are not supported | — | [Next.js on Launch](https://www.contentstack.com/docs/launch/nextjs-on-launch) |
| CDA (REST) origin (uncached) rate limit | 100 req/s (an older page says 80) | org | [CDA API reference](https://www.contentstack.com/docs/developers/apis/content-delivery-api) |
| CDA cached (CDN) requests | Not rate limited | — | same |
| GraphQL origin rate limit | 80 req/s (separate bucket) | org | [GraphQL API reference](https://www.contentstack.com/docs/developers/apis/graphql-content-delivery-api) |
| CMA read / write / bulk | 10 / 10 / 1 req/s | org | [CMA API reference](https://www.contentstack.com/docs/developers/apis/content-management-api) |
| CDA entries per request | 100 max | request | CDA reference |
| `include[]` depth / paths | 3 levels / 100 paths | request | CDA reference |
| CMS CDN purge on entry publish | The entry, list queries for its content type, and parent/referencing content types, per locale × environment | stack | [CDN cache docs](https://www.contentstack.com/docs/developers/apis/content-delivery-api) |
| CMS webhooks | One event per entry/asset (a 200-item release fires 200); retried at ~5/25/125/625 s | — | Webhooks docs |
| JS Delivery SDK retries | `retryLimit` 5, `retryDelay` 300 ms, fixed delay, no jitter; retries 429 | client | `@contentstack/core` source |

Public sources conflict on some values: the CDA limit (100 vs 80), the Launch request body limit (128 KB vs 5 MB), whether revalidation resets at a fixed hour or on a rolling 24 h window, and Next.js ISR support. The simulator flags every conflicting parameter.

**Not publicly documented:** Launch per-instance concurrency, maximum instances, scale-out speed, cold-start latency, purge propagation time, the default TTL for SSR responses without headers, and the exact rate-limit window algorithm. The simulator treats these as **assumptions**: every one is editable and flagged in the UI.

## 3. Failure patterns, ranked

Ranked by how often each pattern shows up in cases and how severe it is.

1. **CMS origin 429 bursts** — the most frequent and most escalated problem.
   - The per-org budget is small relative to peak traffic and enforced over roughly a 1-second window with little or no burst allowance. So spikes lasting a few seconds cause 429s even when minute averages look safe.
   - Customers who measure *total* rps think they are far below the limit, because only misses count.
   - A burst-tolerant limiter, which queues requests instead of rejecting them, is being rolled out. Its effect on latency and timeouts is exactly what architects need to see.
2. **Invalidation storms** — the root cause behind most of #1.
   - An entry publish hard-purges broad sets of CMS CDN keys: its content type's list queries, referencing entries, and locale fallbacks. Schema edits and shared-asset publishes purge more.
   - A Launch redeploy purges the whole site cache.
   - Multi-market go-lives start with cold caches.
   - The next traffic wave misses and bursts above the limit for seconds to minutes. Bulk publishes and releases fire one webhook per item, which amplifies purges and rebuilds.
3. **Uncached Launch pages.**
   - Missing, browser-only, or `no-store` `Cache-Control` headers.
   - Cache-key fragmentation from random query strings (often from crawlers or AI bots), cookies, or custom headers.
   - Next.js RSC requests.
   - Result: every page view becomes an SSR render plus several CMS calls.
4. **Per-render call fan-out.** Pages fetch header, footer, navigation, settings and each referenced item as separate calls: 5–10 calls is common, and 20–140 has been seen. On Launch, Next.js has no server data cache to absorb this. Link prefetching multiplied calls about 25× in one public write-up.
5. **Uncacheable error traffic.** 404/400/422 responses are not cached but still hit origin and count toward limits. Bots probing random URLs and malformed or oversized queries are the usual sources.
6. **Error-handling cascades.**
   - A 429 rendered as a 404 or error page, and then cached by a customer-managed CDN, turns a seconds-long burst into minutes of outage.
   - Fixed-delay SDK retries without jitter synchronize clients into retry pulses.
   - Client-side "wait for rate-limit reset" logic can push SSR past the 30 s timeout.
7. **Serverless constraints under spikes.** The 30 s timeout, cold starts after idle periods (no minimum instances), undersized machine tiers, and connection or file-descriptor exhaustion when HTTP clients don't use keep-alive.
8. **Large static builds.** High build parallelism exceeds the CMS limit. One failed call fails the whole build, and teams do a full rebuild on every publish. *(Planned for phase 2.)*
9. **Management API throughput.** 10 req/s throttles migrations, imports and bulk publishing of tens to hundreds of thousands of entries. *(Planned for phase 2.)*
10. **Load tests and spikes flagged as DDoS.** Unannounced load tests get auto-mitigated. Load tests also share the org's rate-limit budget with production.

## 4. Questions architects asked that nobody could answer on the spot

These are the simulator's acceptance criteria.

- "Will N sessions/month with an X× peak day work on Launch?"
- "What origin rps will a publish, purge or market launch generate, and how close to the limit are we (90/95/99%)?"
- "What rate limit should we request?"
- "Does publishing 12K assets trigger 429s?"
- "Do error responses and preflights count toward the limit?"
- "How much do TTL, stale-while-revalidate, cache priming, staggered publishing, and retry/backoff change the outcome?"
- "What does include depth or GraphQL change?"
- "How long will a migration take at 10 rps?" *(phase 2)*
- "Will a full-rebuild SSG architecture scale to twice the pages?" *(phase 2)*

## 5. Workload ranges seen (used for presets)

| Dimension | Range |
|---|---|
| Traffic | 2K users/day up to 40–100M hosting requests/day |
| Healthy edge hit ratio | ≥ 99% (the best-run sites reach 99.9%) |
| Cold-launch hit ratio | ~60%, rising to 90–95% |
| Pages | 1K–18K |
| Locales | 1–150+ |
| CMS calls per render | 3–8 typical, 20–140 in the worst cases |
| Peak multiplier on event days | 3–5× typical, 7–10× for retail events |
| CMS origin peaks | 55–500 rps against 80–200 rps limits |

**Calibration point.** A well-cached retail site served about 490K requests/minute at the edge with a 99.9% hit ratio, and its CMS origin saw only a few requests per second.

## 6. Framework behavior relevant to load

| Framework | When the CMS is called | Server cache on Launch | Build concurrency default |
|---|---|---|---|
| Next.js App Router | Per render (dynamic/SSR); RSC and prefetch requests add variants per URL | None (Data Cache unsupported); SDK calls go through axios and are not memoized | (vCPU−1) workers × 8 pages |
| Next.js Pages Router | `getServerSideProps` on every view **and** every client navigation (`/_next/data`) | Per-instance ISR only | (vCPU−1) workers |
| Nuxt 3/4 | SSR per request; client navigation from the browser | Nitro cache, in memory per instance | vCPU × 4 |
| Astro | Build (static); per request for on-demand pages and server islands | None built in | 1 |
| Remix / React Router 7 | Every request **and** every client navigation re-runs loaders | None built in | 1 |
| SvelteKit | Server load per request; only changed dependencies on navigation | None built in | 1 |
| Gatsby / pure SSG | Build time only | n/a | Plugin-defined |

Sources: the framework docs for each version. The full citations are kept alongside the research notes and summarized in `packages/engine/src/params/`.

## 7. Modeling references

- URL popularity as Zipf-like: Breslau et al., "Web Caching and Zipf-like Distributions", INFOCOM 1999.
- TTL cache hit ratios: Jung, Berger & Balakrishnan, INFOCOM 2003; Fofack et al. For a TTL set at fill with Poisson arrivals, the hit ratio is `h = λT / (1 + λT)`.
- LRU cache hit ratios: Che's approximation; Fricker, Robert & Roberts, 2012.
- Stampedes and early expiration: Vattani, Chierichetti & Lowenstein, "Optimal Probabilistic Cache Stampede Prevention", VLDB 2015.
- Backoff and jitter: [AWS Architecture Blog](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/). Cascading failures: [Google SRE Book](https://sre.google/sre-book/addressing-cascading-failures/).
- Simulation approach: [Brooker, "Simple Simulations for System Builders"](https://brooker.co.za/blog/2022/04/11/simulation.html); SimFaaS (Mahmoudi & Khazaei).
