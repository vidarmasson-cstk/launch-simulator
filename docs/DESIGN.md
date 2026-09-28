# Launch Simulator — Design

Status: v1 design (MVP). Author: planning pass, 2026-09-28. Research basis: [RESEARCH.md](./RESEARCH.md).

## 1. Goal

Architects need to know, before they build, whether a site on Contentstack Launch will stay inside the rate limits, timeouts and compute capacity of **Launch** and the **Contentstack CMS APIs**. The simulator answers that under:

- steady peak traffic;
- transient events: publishes, deploys, go-lives, crawler surges, load tests;
- different frameworks and architectures, and different caching and retry strategies.

**Primary outputs:**

- origin rps vs limit at each layer;
- 429s, timeouts, error rate and latency over time;
- the bottleneck, and the rate limit you would need to request;
- concrete recommendations.

**Audience:** internal SAs/SEs and customer architects. The repository is public. It ships **only publicly documented values** as defaults. Internal users can load a **private parameter preset** (a local JSON file, never committed) that overrides them.

### MVP scope

| In (v1) | Phase 2 |
|---|---|
| Request-path model: edge → Launch CDN → Launch origin limiter → compute → CMS CDN → CMS limiter → SDK retries | SSG build simulator (build fan-out, duration, failure risk) |
| Steady-state analytic view (instant) | CMA migration / bulk-publish duration calculator |
| Timeline simulation (web worker) with events | Monte Carlo bands with many seeds (v1 supports seeds; UI shows single run + optional 5-run band) |
| Framework presets (Next App/Pages, Nuxt, Astro, Remix/RR7, SvelteKit, Angular, SSG) | CLI runner on the same engine |
| Compare up to 3 scenarios, findings/recommendations | Live calibration from Launch logs / analytics exports |
| Parameter provenance (documented / conflicting / observed / assumption / private) | Capacity-limited (LRU) CDN eviction |

## 2. Architecture

```
launch-simulator/
├─ packages/engine/         # pure TypeScript, no DOM; all math lives here
│  ├─ src/
│  │  ├─ index.ts           # public API
│  │  ├─ rng.ts             # seeded PRNG + Poisson/NegBin sampling
│  │  ├─ schema.ts          # zod Scenario schema (schemaVersion 1) + types
│  │  ├─ params/            # parameter registry with provenance
│  │  │  ├─ registry.ts     # ParamMeta type, lookup, preset overlay
│  │  │  ├─ sources.ts      # Source list (id → title, url, date)
│  │  │  ├─ defaults.ts     # public default Scenario values
│  │  │  └─ frameworks.ts   # framework presets
│  │  ├─ model/
│  │  │  ├─ popularity.ts   # Zipf key-space binning
│  │  │  ├─ cacheLayer.ts   # generic fluid TTL cache (SWR, collapse, purge, error caching)
│  │  │  ├─ limiters.ts     # fixed/sliding window, token bucket, GCRA w/ queue
│  │  │  ├─ retry.ts        # retry policies + retry scheduling ring
│  │  │  ├─ compute.ts      # Launch compute: instances, concurrency, queue, cold start, timeout
│  │  │  ├─ traffic.ts      # arrival generation (profile, spikes, bots)
│  │  │  ├─ events.ts       # event timeline → per-tick effects
│  │  │  ├─ latency.ts      # log-bucket latency histograms
│  │  │  ├─ pipeline.ts     # tick loop wiring all components
│  │  │  └─ metrics.ts      # per-second series + summary KPIs
│  │  ├─ analytic/steadyState.ts
│  │  ├─ findings.ts        # rule-based diagnostics + recommendations
│  │  └─ scenarios/         # template scenarios (presets gallery)
│  └─ test/
├─ apps/web/                # Vite + React + TS + Tailwind + Recharts + zustand
└─ docs/
```

**Tooling:**

- npm workspaces; TypeScript `strict`.
- Vitest for tests.
- ESLint (typescript-eslint, recommended) and Prettier.
- Node ≥ 20.

The web app runs timeline simulations in a **Web Worker** so the UI stays responsive. The analytic model runs synchronously on every edit.

## 3. Parameter provenance

Every tunable numeric parameter has metadata:

```ts
type Provenance = 'documented' | 'conflicting' | 'observed' | 'assumption' | 'private';
interface ParamMeta {
  path: string;            // dot-path into Scenario, e.g. "cms.cda.limitRps"
  label: string; unit: string; min?: number; max?: number; step?: number;
  provenance: Provenance;
  sources: string[];       // ids into sources.ts
  conflict?: { value: number | string; sourceId: string; note?: string }[];
  note?: string;           // e.g. "Not publicly documented; editable assumption"
}
```

- **Conflicting values:** the default is the value from the most recent doc. The UI shows a "sources disagree" badge that lists every value with its link.
- **Private presets:** `{ "format": "launch-sim-preset/v1", "name": "...", "overrides": { "<path>": { "value": ..., "note": "..." } } }`.
  - A preset is loaded in the browser through a file picker and kept in `localStorage`. It is never sent anywhere.
  - Overridden params show provenance `private`.
  - Exporting or sharing a scenario while a private preset is active **warns**, and offers to strip the private values.
- `.gitignore` includes `presets/private/` and `*.private.json`.

## 4. Scenario schema (summary)

`Scenario` is a single JSON document, validated with zod. Every field has a default, so a partial scenario is still valid.

```ts
Scenario {
  schemaVersion: 1; name; description?
  sim:      { durationSec, dtSec (0.1), seed, stochastic: boolean, burstiness (NegBin k; Infinity = Poisson) }
  traffic:  { baseEdgeRps /* page views/s from humans */, profile: 'flat'|'diurnal', 
              bots: { share, randomQueryFraction, notFoundFraction, zipfAlpha } }
  site:     { pages, locales, localeZipfAlpha, zipfAlpha, personalizeVariants,
              framework: FrameworkId, frameworkOverrides: Partial<FrameworkProfile>,
              cacheHeaders: { page: CachePolicy, data: CachePolicy, fn: CachePolicy },
              uncacheableFraction /* cookies/headers forcing bypass */ }
  launch:   { plan: 'standard'|'enterprise', originLimitRps, originBurstSec,
              cdn: { domains /* effective independent cache domains */, collapse: boolean, hitLatencyMs },
              externalCdn: { enabled, ttlSec, cachesErrors, errorTtlSec },
              compute: { machine: 'L1'|'L2'|'L3', concurrencyPerInstance, maxInstances, minInstances,
                         scaleOutPerSec, coldStartMs, idleScaleToZeroSec, timeoutSec, maxQueue },
              revalidation: { dailyQuota } }
  cms:      { api: 'rest'|'graphql',
              cda: { limitRps, algorithm: LimiterAlgo, burstMultiplierPct, maxWaitMs },
              graphql: { limitRps, algorithm, burstMultiplierPct, maxWaitMs },
              cdn: { domains, collapse: true, ttlSec: Infinity, hitLatencyMs, originLatencyMs },
              otherOrgTrafficRps /* other stacks / staging / builds sharing the org budget */,
              contentTypes, entriesPerType }
  sdk:      { retry: RetryPolicy, onFinalFailure: 'error500'|'render404'|'renderStale' }
  events:   Event[]
}
CachePolicy { cacheable: boolean, sMaxAgeSec, swrSec, staleIfErrorSec }
LimiterAlgo = 'fixedWindow' | 'slidingWindow' | 'tokenBucket' | 'gcra'
RetryPolicy { kind: 'none'|'fixed'|'exponential'|'exponentialJitter'|'sdkDefault', retries, baseDelayMs, capDelayMs }
Event =
 | { kind:'spike', atSec, durationSec, multiplier, rampSec }
 | { kind:'publish', atSec, entries, spreadSec, locales:'all'|number, purge: PurgeScope, onPublish: 'none'|'revalidatePaths'|'revalidateTags'|'redeploy' }
 | { kind:'deploy', atSec, buildSec, priming: { paths, rps } }
 | { kind:'goLive', atSec }            // all caches cold, compute cold
 | { kind:'crawler', atSec, durationSec, rps, randomQueryFraction, notFoundFraction }
 | { kind:'loadTest', atSec, durationSec, rps, cacheBusting: boolean }
 | { kind:'otherTraffic', atSec, durationSec, rps }   // e.g. staging job, build on same org
PurgeScope { pageQueries: boolean, contentTypeLists: boolean, referencingFraction, globals: boolean }
```

`FrameworkProfile` holds the per-render CMS call structure and client behavior (§6.6).

## 5. Time and randomness

- **Tick model.** The simulation is a fixed-step, fluid-plus-stochastic tick simulation with `dt = 0.1 s` by default. Rate limiters are evaluated at tick resolution, so a 1 s window spans 10 ticks. Charts use values aggregated per second.
- **Why fluid.** The cache state is a set of *bins* of keys, each tracked as fractions of keys in each state. The cost per tick is proportional to the number of bins, **independent of traffic volume**, so 10K rps and 10 rps cost the same. A 1 h simulation at 0.1 s is 36K ticks × about 200 bins. It must run in under 3 s in a worker.
- **Where randomness enters.** With `stochastic: true`, each tick's total arrivals per traffic class are sampled from a Poisson distribution. If `burstiness` k is finite, a Gamma-Poisson (negative binomial) is used instead, for over-dispersion. The **origin-bound request counts** at each limiter are also Poisson-sampled around their fluid expectation before the limiter sees them. This matters because real 1-second spikes cause 429s even when the averages are under the limit. Fluid state updates use expected values.
- **Determinism.** Everything is deterministic for a given `seed`. The PRNG is sfc32 or mulberry32.

## 6. Component models

### 6.1 Popularity and binning (`popularity.ts`)

- The key space has `K = pages × locales × personalizeVariants` keys.
- Page popularity is Zipf with exponent `zipfAlpha` (default 0.8). Locale weights are Zipf with `localeZipfAlpha` (0 means uniform). Variants are uniform.
- Keys are grouped into **bins**:
  - the top 16 ranks each get their own bin;
  - the remaining ranks go into about 48 log-spaced bins.
- Each bin stores `n` (the number of keys) and `p` (the mean per-key request probability). The bin probabilities `n·p` sum to 1.
- Locale × variant multiplies the count `n`; the bin structure comes from the page ranks. Each locale combination has its own ranking weight, so the true popularity of a key is `p_page × w_locale / variants`. Build bins over the product: generate (page-rank-bin, locale-bin) pairs, then merge them into ≤ 64 bins by sorting on `p`.
- The Launch page layer and the CMS page-query layer use the **same binning**, so the miss stream from Launch maps bin by bin onto CMS page-query requests.

### 6.2 Generic cache layer (`cacheLayer.ts`)

A `CacheLayer` models one cache tier (Launch CDN, the customer's external CDN, or the CMS CDN) for one class of keys.

**Configuration:** `{ ttlSec (Infinity allowed), swrSec, staleIfErrorSec, collapse, domains D, cacheErrors?: {ttlSec} }`.

Each key is replicated across `D` independent cache domains, so a bin holds `n·D` keys, each with request rate `r = λ·p/D`.

**State per bin**, as fractions of the bin's keys that sum to 1:

- `empty`: not cached.
- `fresh[age]`: a ring buffer over age ticks, with length `ceil(ttl/dt)`. If `ttl ≥ duration`, there is no expiry and a single scalar is used.
- `stale[age]`: a ring buffer of length `ceil(swr/dt)`. Stale keys are served stale while one background refresh is in flight.
- `pending`: a completion ring indexed by the tick when the fetch completes, with length `ceil(maxLatency/dt)`. Each slot holds `{ amount, successAmount }`. Keys that were stale when the fetch was triggered keep being served stale; track them as a separate `pendingStale` ring.
- `errorCached[age]`: only when `cacheErrors` is set.

**Per tick,** let `m = r·dt` be the expected requests per key and `q = 1 − e^{−m}` the probability a key is requested at least once. With `N = n·D`:

| Requests to… | Served as | Origin fetches started |
|---|---|---|
| fresh | hit | 0 |
| stale | stale hit | `N·stale·q`, and those keys move to `pendingStale` |
| pendingStale | stale hit | 0 |
| empty | miss (blocking) | collapse: `N·empty·q` (distinct keys); no collapse: `N·empty·m` |
| pending (blocking) | miss that waits for the in-flight fetch | collapse: 0; no collapse: `N·pending·m` |
| errorCached | error served | 0 |

**Transitions each tick:**

- Aging moves `fresh` past ttl into `stale`, or into `empty` if `swr = 0`. `stale` past swr moves to `empty`.
- Fetch completions for this tick move `successAmount` to `fresh[0]`. The failed amount moves to `errorCached[0]` if `cacheErrors`, otherwise to `empty`.
  - Launch never caches errors, so its layer has no `cacheErrors`. The external CDN layer can have it.
  - With `staleIfError > 0`, a failed refresh of a stale key keeps it `stale` instead.
- A purge of fraction φ moves φ of `fresh`, `stale` and `pendingStale` to `empty`, proportionally across ages. In-flight fetches still complete and fill the cache, which matches CDN behavior.

**API:**

```ts
layer.step(tick, lambdaPerBin: Float64Array /* req/s per bin */) → {
  requests, hits, staleHits, blockingMisses, collapsedWaits, errorsServed,
  originFetchesPerBin: Float64Array,   // new origin requests this tick, by bin
}
layer.scheduleCompletions(tick, perBinAmounts, completionTick, successFraction) // called by pipeline after downstream latency is known
layer.purge(fractionPerBin | scalar)
layer.hitRatio()   // instantaneous, for display
```

Uncacheable classes skip the layer: every request is an origin request.

**Analytic check.** A constant rate, fixed TTL T and no SWR must converge to `h = rT/(1+rT)` per key. This is a unit test.

### 6.3 Rate limiters (`limiters.ts`)

Every limiter works on fluid counts per tick and returns `{ accepted, rejected, queued, avgQueueDelayMs }`.

- `fixedWindow(limit)`: a 1 s window that **starts at the first request after the previous window ended**. It is not aligned to clock seconds, per internal descriptions of the legacy limiter. The first `limit` requests in the window are accepted and the rest rejected.
  - Test: 683 requests in one tick against a 100 limit → 100 accepted, 583 rejected.
- `slidingWindow(limit)`: accept while the count over the last `1/dt` ticks is below `limit`.
- `tokenBucket(rate, capacity)`: the Launch origin model. Documented as a "tiered token bucket, global per org; brief overshoot possible". Default `capacity = rate × originBurstSec`, with `originBurstSec = 1` as an assumption.
- `gcra(rate, burstMultiplierPct, maxWaitMs)`: the burst-aware limiter.
  - Emission interval `T = 1/rate`.
  - Burst tolerance `τ = (burstMultiplierPct/100 − 1)·1s`. 100% means no burst.
  - Requests that conform within `τ` pass immediately. Otherwise, if the wait is ≤ `maxWaitMs`, the request is **queued**: it is accepted with a delay, and that delay feeds render latency. Otherwise it is rejected with a 429.
  - Fluid implementation: a virtual queue `Q`. Per tick, service capacity is `rate·dt` plus unused burst credit, which is capped at `rate·τ`. New arrivals join `Q` if `(Q + a)/rate ≤ maxWait`; the overflow is rejected. The average delay is `Q/rate`.
  - Only the existence of burst-aware limiting is public. Default `burstMultiplierPct = 100`, which means off.

The CMS side has **separate buckets** for REST (CDA) and GraphQL. Both receive `otherOrgTrafficRps` and `otherTraffic` events as additional origin load.

### 6.4 Retries (`retry.ts`)

The retry ring is indexed by future tick and **attempt number**. When a limiter rejects `x` requests at attempt `k < retries`, they are scheduled at `tick + delay(k)/dt` with attempt `k+1`. At `k = retries` they become **final failures**.

| Policy | delay(k) |
|---|---|
| `fixed` | `baseDelayMs` |
| `exponential` | `min(cap, base·2^k)` |
| `exponentialJitter` | Full Jitter, `U(0, min(cap, base·2^k))`. The fluid version spreads the amount uniformly across the ticks of that interval. |
| `sdkDefault` | Mirrors `@contentstack/core`: 5 retries, 300 ms fixed. When the 429 carries `x-ratelimit-remaining: 0`, it waits `retry-after` or `reset + 1 s`, otherwise 1 s. Modelled as fixed `sdkRateLimitWaitMs` (default 1000 ms, an assumption) because CDA 429s report remaining = 0. A toggle `sdkAssumeRemainingHeader` falls back to 300 ms. |

Retried requests re-enter the CMS limiter in their scheduled tick. They are **not** re-evaluated against the CMS CDN, because a 429 only comes from origin.

### 6.5 Launch compute (`compute.ts`)

A fluid queue with autoscaling. Capacity is `C(t) = readyInstances × concurrencyPerInstance`.

**Per tick:**

1. `demand = queue + acceptedArrivals`. Start `s = min(demand, C − inFlight)` renders, and leave the rest in `queue`. If `queue > maxQueue`, the overflow is shed as 503s.
2. Each started render has service time `S = cpuMs(machine) + cmsPathMs + cmsQueueDelayMs + retryWaitMs`, computed by the pipeline (§6.7). Completions go into a ring at `tick + S/dt`.
3. A request whose `queueWait + S > timeoutSec` returns **504**. It still consumed its CMS calls if it had started. Queue wait is estimated as `queue / throughput`.
4. **Autoscaling:**
   - `desired = ceil((inFlight + queue) / concurrencyPerInstance)`, clamped to `[minInstances, maxInstances]`.
   - Instances are added at up to `scaleOutPerSec·dt` per tick and become ready after `coldStartMs`. Requests wait in the queue meanwhile, which is how a cold start shows up in latency.
   - If there are no arrivals for `idleScaleToZeroSec`, ready instances drop to `minInstances`.
5. `cpuMs(machine) = cpuRenderMsL1 × (0.5 / vCPU(machine))`. This linear scaling is an assumption.

**Defaults** — public docs don't state concurrency or scaling, so these are flagged assumptions: `concurrencyPerInstance = 1`, `maxInstances = 1000`, `scaleOutPerSec = 100`, `coldStartMs = 1500`, `minInstances = 0`, `idleScaleToZeroSec = 900`. They are editable, and a private preset overrides them per cloud.

### 6.6 Framework profile (`params/frameworks.ts`)

```ts
FrameworkProfile {
  id; label; renderMode: 'ssr'|'static'|'hybrid';
  // CMS calls per uncached server render
  globalCalls;       // header/footer/nav/settings; keys = globalKeys × locales (hot, shared across pages)
  pageCalls;         // page entry (+ includes); keys follow page bins
  listCalls;         // list/query calls; keys = contentTypes × locales
  n1Calls;           // per-item fetches (N+1); keys = entries pool (Zipf)
  sequentialWaves;   // latency = waves × per-call latency
  cpuRenderMsL1;
  // client behaviour per human page view
  clientNavFraction;     // share of page views that are client-side navigations (fetch data, not HTML)
  dataRequestsPerNav;    // e.g. RSC payload / _next/data / .data requests per client nav
  prefetchPerView;       // prefetch requests per view (Next <Link>)
  dataCacheable: boolean // RSC on Launch: false by default
  serverCache: { scope: 'none'|'perInstance'|'shared', ttlSec, appliesTo: ('global'|'list'|'page')[] }
  runtimeCms: boolean    // false for pure SSG/Gatsby: no CMS calls at request time
}
```

The defaults per framework come from the table in RESEARCH.md §6.

- They are labelled `assumption`, except where documented. Documented cases include: Next on Launch has no data cache; Remix re-runs loaders on every navigation; Next Pages uses `_next/data` on navigation.
- **Server cache, per instance.** For a key with total request rate `λk` and I ready instances, the analytic hit ratio is `h = (λk/I)·T / (1 + (λk/I)·T)`, applied per tick. It has no state and resets on deploy.
- **Server cache, shared.** A CacheLayer with `D = 1`. Not available on Launch; listed for comparison with other hosts.

### 6.7 Pipeline (`pipeline.ts`) — order within one tick

1. **Events → effects.** Apply purges, cold resets, traffic multipliers, crawler and load-test streams, other-traffic streams, and cache priming. Count revalidation quota use.
2. **Edge arrivals by class:**
   - `page` (HTML): human first loads and full navigations, plus bots.
   - `data`: RSC/data requests from client navigations, plus prefetches.
   - `botUnique`: always a miss — random query strings or cache-busting.
   - `notFound`: never cached. On Launch it is still an origin render, plus `cmsCallsPerNotFound` (default 1) uncacheable CMS calls.
   - Static assets are counted in edge rps only; they are always hits.
3. **External CDN (optional) → Launch CDN.** Each cacheable class steps through its layer(s). Uncacheable fractions (`uncacheableFraction`, policy `cacheable=false`) go straight to origin.
4. **Launch origin limiter.** A token bucket over all origin-bound requests, after Poisson sampling if stochastic. Rejected requests become **Launch 429** to visitors. The Launch layer's pending keys for those requests fail.
5. **Compute.** Admit and start renders (§6.5).
6. **CMS call generation for started renders.**
   - global: `renders × globalCalls` across `globalKeys × locales` keys.
   - page: per-bin `rendersPerBin × pageCalls`, using the Launch page bins.
   - list: `renders × listCalls` across content types × locales.
   - n1: `renders × n1Calls` across entries.
   - Server cache is applied first, then the CMS CDN layers. SSG and static renders generate none.
7. **CMS limiter** (bucket by `api`). Arrivals are the CMS CDN origin fetches, plus retries due this tick, plus other org traffic. Outcomes: accepted, queued (GCRA delay) or rejected. Rejected requests are scheduled as retries or become final failures.
8. **Latency and outcome for this tick's renders:**
   - `p429 = rejected/arrivals` in this tick.
   - Per-call latency: `L = h·cdnHitMs + (1−h)·(originMs + gcraDelay)`, plus the expected retry wait `Σ_k p429^k·delay(k)`.
   - `cmsPathMs = waves × L`.
   - Render failure probability: `pFail = 1 − (1 − p429^(retries+1))^callsPerRender`. The approximation uses the current tick's `p429`. Actual retry *load* is still tracked exactly in the retry ring.
   - Failed renders follow `onFinalFailure`:
     - `error500`: not cached at Launch.
     - `render404`: a 404, not cached at Launch but cacheable by the external CDN if `cachesErrors`. This is the documented cascade.
     - `renderStale`: served stale if the app has its own fallback.
9. **Schedule completions.** The Launch and external CDN pending cohorts complete at `tick + (queueWait + S)/dt`, with success fraction `1 − pFail − pTimeout`. The CMS CDN pending cohorts complete at `tick + (originMs + gcraDelay)/dt`, with the accepted fraction as success.
10. **Metrics.** Accumulate into per-second buckets and latency histograms.

**Known approximations** (documented in the UI's About panel):

- The fluid state uses expected values.
- Render latency uses same-tick CMS conditions.
- The Zipf ranks are static.
- There is no CDN capacity eviction.
- Instance-level variance is ignored.

### 6.8 Metrics (`metrics.ts`)

**Per-second series** (Float32Array columns):

- edge rps by class;
- Launch hit ratio (fresh+stale)/requests;
- Launch origin offered, accepted and 429;
- compute: instances ready, in-flight, queue, 503, 504;
- render p50/p95;
- visitor latency p50/p95 (a log-bucket histogram over hits and misses);
- CMS calls total; CMS CDN hit ratio;
- CMS origin offered, accepted, queued and 429; retries; final failures; GCRA delay;
- other org traffic; errors served to visitors by type;
- revalidations used.

**Summary KPIs:**

- peak 1 s Launch origin rps and % of limit; seconds over limit;
- peak 1 s CMS origin offered rps and % of limit; seconds with any 429;
- totals: Launch 429, CMS 429, 504, 503, error pages served;
- visitor error rate; worst-second visitor p95;
- CMS calls per page view (average);
- **suggested CMS limit to request**: `ceil(max 1-s offered CMS origin rps × 1.2)`, together with the rps at which 429s would disappear;
- **projected monthly API calls** from the average CMS calls per second, cached and uncached. Both count toward the monthly quota.
- the bottleneck (first layer that saturates).

### 6.9 Analytic steady state (`analytic/steadyState.ts`)

This model uses the same parameters, has no events, and gives instant results.

- **Launch page layer, fixed TTL T from fill, with Poisson arrivals.**
  - Origin fetch rate per key: `f = r/(1 + rT)`.
  - Blocking miss fraction: `1/(1+rT)` without SWR, and `e^{−rS}/(1+rT)` with SWR `S`.
  - If `T = ∞` (cached until purged), steady state is warm and only purge-driven misses count.
- **Purge-driven misses.** Publishes happen at `publishesPerHour` (a steady-state-only input). Each purges a set of keys `P`. The added origin rate is `publishRate × Σ_{k∈P} (1 − e^{−r_k·Δ})`, where `Δ = 1/publishRate`.
- **Downstream.** Renders → CMS calls → CMS CDN, with the same per-key formula. Then the CMS origin rate is compared with the limit.
- **429 risk.** Assume the 1-s count is Poisson (or negative binomial). Report `P(count > limit)` and the expected number of seconds over the limit per hour.
- **Compute.** Little's law gives in-flight `= rate × S`. Erlang C gives `P(wait)` at `c = maxInstances × concurrencyPerInstance`. Report utilisation.
- **Output shape.** The analytic model returns the same KPI shape the UI uses for timeline summaries.
- **Cross-check test.** Run a 30-minute timeline with stochastic off and no events, then compare its steady tail with the analytic result: they must be within 5%.

### 6.10 Findings (`findings.ts`)

Rules run over the summary and the scenario, and produce `{ severity, title, detail, suggestion?: ScenarioPatch }`. Each suggestion can be applied as a new scenario and opened in Compare.

- Launch page class uncacheable, or `sMaxAge = 0` → set `s-maxage` and SWR.
- CMS 429s concentrated after publish events → stagger the publish, narrow the purge scope, use tag-based revalidation, prime the cache, enable GCRA burst, or request a higher limit (suggest a value).
- Deploy or goLive events at peak with CMS 429s → deploy off-peak, and add cache priming for the top N paths. N comes from the popularity bins that cover 80% of traffic.
- Retry policy `fixed` or `sdkDefault` with CMS 429s → use exponential backoff with jitter.
- `globalCalls ≥ 3` with a low CMS hit ratio → combine the global queries into one, or cache them.
- `botUnique` or `notFound` traffic producing more than 20% of origin load → add WAF/bot rules, and don't query the CMS for unknown slugs.
- `render404` together with `externalCdn.cachesErrors` → don't cache 404s produced by 429s; use a 503 with `Retry-After`.
- Compute 504s or queue growth → raise the machine tier or concurrency, lower `sequentialWaves`, or parallelize the CMS calls.
- Revalidation calls over `dailyQuota` → use tag-based or prefix revalidation.
- `otherOrgTrafficRps` over 30% of the CMS limit → move staging and builds to a separate org or schedule them off-peak.

## 7. Web UI

- **Stack:** Vite, React, TypeScript, Tailwind, Recharts, zustand, zod (from the engine) and lz-string (URL share).
- **Theme:** neutral design, following the system light/dark setting.

**Layout:**

- **Header:**
  - scenario name and templates gallery;
  - import/export JSON and share URL;
  - "Load private preset", with an indicator badge and a clear button;
  - an About panel covering model assumptions and provenance legend.
- **Left: parameter editor.** Accordion sections: Traffic · Site & Framework · Launch Hosting · Contentstack CMS · SDK & Retries · Events · Simulation.
  - Each field has a provenance badge (documented = solid, conflicting = warning, assumption = dashed, private = lock) and a tooltip with its sources.
  - The event editor lists events as rows with a kind picker.
- **Main area:**
  1. **Flow diagram.** An SVG of the request path. Each hop shows rps, hit ratio and a headroom gauge against its limit (green < 70%, amber < 100%, red ≥ 100%). It uses steady-state values by default, and the values at the hovered second when a timeline is shown.
  2. **Tabs:**
     - **Steady state**: KPIs and the analytic 429 risk.
     - **Timeline**: a Run button with progress and synced charts with event markers (see below).
     - **Compare**: pick up to 3 saved scenarios; a KPI table and an overlaid CMS origin chart.
     - **Findings**: the list, with an "Apply suggestion → compare" action.

**Timeline charts:**

- (a) edge rps and Launch hit ratio;
- (b) Launch origin rps vs limit, plus 429s;
- (c) compute: instances, in-flight, queue, 504s;
- (d) CMS origin offered vs accepted vs limit, plus 429s and retries;
- (e) visitor latency p50/p95;
- (f) visitor errors by type.

**State:**

- A zustand store holds the current scenario, saved scenarios, the active private preset and the latest run results.
- Scenarios persist to `localStorage`, wrapped in try/catch.

## 8. Scenario templates (v1)

1. **Healthy retail peak.** Calibration scenario: ~8.2K edge rps, `s-maxage` + SWR, 99.9% hit ratio → CMS origin at a few rps.
2. **Missing `s-maxage`.** Same traffic, with pages uncacheable.
3. **Bulk publish at peak.** 500 entries, with broad purge scope and per-item revalidation.
4. **Deploy during peak.** Full Launch purge and cold compute, with and without priming.
5. **Multi-market go-live.** 20 locales and cold caches.
6. **AI crawler with random query strings.**
7. **Next.js App Router prefetch amplification.** RSC not cached, 5 prefetches per view.
8. **429 cached as 404 by a customer CDN.**
9. **Strict window vs burst-aware (GCRA).** A pair of scenarios for Compare.
10. **Staging job sharing the org budget.**

## 9. Validation

Unit tests:

- limiter exact cases;
- the cache-layer analytic convergence (`rT/(1+rT)` within 2%);
- purge semantics;
- the retry ring conserves request counts;
- compute satisfies Little's law;
- Zipf bins sum to 1;
- a deterministic seed gives identical series.

Scenario tests:

- The calibration scenario gives CMS origin under 10 rps.
- The missing-`s-maxage` scenario exceeds the CMS limit.
- The GCRA scenario gives fewer 429s and higher latency than the strict window.
- Analytic and timeline agree within 5% in steady state.

Performance: a 1 h run at `dt = 0.1` completes in under 3 s in Node, as a Vitest benchmark smoke test.

## 10. Implementation plan

The coding agents implement to this spec. Each wave is reviewed before the next one starts.

1. **Wave 1.** Scaffold, tooling, `schema.ts`, `params/*`, `rng.ts`, and empty module stubs with signatures.
2. **Wave 2, in parallel with disjoint files:**
   - (A) `popularity.ts` + `cacheLayer.ts`;
   - (B) `limiters.ts` + `retry.ts`;
   - (C) `traffic.ts` + `events.ts` + `compute.ts` + `latency.ts`.
   Each part ships with its tests.
3. **Wave 3.** `pipeline.ts` + `metrics.ts`; then `analytic/steadyState.ts`, `findings.ts` and the scenario templates, plus the scenario tests.
4. **Wave 4.** Web app:
   - (A) shell, store, editor and the provenance UI;
   - (B) worker, charts, flow diagram, compare and findings views.
5. **Wave 5.** Integration, calibration, performance, README, and a review pass.
