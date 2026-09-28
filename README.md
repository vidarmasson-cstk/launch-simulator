# Launch Simulator

A request-path load simulator for sites hosted on Contentstack Launch. It is meant for solution architects and engineers who need to know, before they build or launch, whether a site stays inside the rate limits, timeouts and compute capacity of Launch and the Contentstack CMS APIs. It covers steady peak traffic and transient events (publishes, deploys, go-lives, crawler surges, load tests), across frameworks and caching or retry strategies.

Everything runs in the browser. There is no backend.

## The core relation

Load on each origin is what the layer in front of it fails to absorb:

```
origin rps = edge rps × miss ratio × calls per miss
```

The simulator applies this at every hop of the request path, with cache TTLs, stale-while-revalidate, purges, rate limiters and retries changing the miss ratio and the calls over time:

```
 visitors / bots
       |
       v
 [ Edge / optional external CDN ]
       |  miss
       v
 [ Launch CDN ] -- hit --> response
       |  miss
       v
 [ Launch origin limiter ] -- over limit --> 429
       |
       v
 [ Launch compute: instances, queue, cold start, timeout ] -- 503 / 504
       |  N CMS calls per render
       v
 [ CMS CDN ] -- hit --> data
       |  miss
       v
 [ CMS rate limiter ] -- over limit --> 429 --> SDK retry
       |
       v
 [ Contentstack CMS origin ]
```

## Quick start

Requires Node 20 or later.

```sh
npm install
npm run dev -w @launch-sim/web      # dev server
npm test                            # engine and web tests
npm run build -w @launch-sim/web    # static build in apps/web/dist
```

Other root scripts: `npm run typecheck`, `npm run lint`, `npm run format`.

## How to use it

- **Templates.** Start from a template (healthy retail peak, bulk publish at peak, deploy during peak, crawler surge, strict versus burst-friendly limiter, and more). Each one has a description of what to look at. Then edit any parameter.
- **Steady state.** Instant analytic view: origin rps against the limit at each hop, utilisation, expected seconds per hour over a limit, suggested CMS limit to request, projected monthly API calls.
- **Timeline.** A per-tick simulation (in a web worker) with events on a timeline. It shows origin load, hit ratios, compute queue and instances, 429/503/504 counts, retries and visitor latency second by second. Hover a chart to see that second in the flow diagram.
- **Compare.** Save up to three scenarios and compare their key numbers side by side.
- **Findings.** Rule-based diagnostics. Each finding is `critical` (visitors saw errors or a limit is exceeded), `warning` (risk, near a limit, or latency) or `info`, and most carry a one-click patch you can apply and re-run.
- **Provenance badges.** Every parameter shows where its value comes from: documented (public Contentstack docs), sources disagree (all values listed), observed (public SDK source or behaviour), assumption or input (not public, or a workload you choose), or private (set by a private preset). Treat assumptions as things to confirm.

## Public defaults and private presets

This repository is public and ships only publicly documented values as defaults. Internal users can load a private preset (a `launch-sim-preset/v1` JSON file) that overrides defaults. Use the Load button in the header. The preset stays in the browser and is never uploaded.

```json
{
  "format": "launch-sim-preset/v1",
  "name": "My preset",
  "overrides": {
    "launch.compute.concurrencyPerInstance": { "value": 1, "note": "Placeholder note." },
    "launch.originLimitRps": { "value": 1000, "note": "Placeholder note." }
  }
}
```

Keys are parameter paths from the registry (`packages/engine/src/params/registry.ts`); unknown paths are rejected. Never commit a private preset: `presets/private/` and `*.private.json` are gitignored.

## Deploying on Contentstack Launch

The build is a static site. On Launch, configure it as a static site: framework preset "Other" (or static), build command `npm run build -w @launch-sim/web`, output directory `apps/web/dist`. Check the current Launch documentation for the exact fields.

## Model limitations

The simulator is a fluid (expected-value) model, and public documentation leaves several parameters open. See [DESIGN section 6.7](docs/DESIGN.md#67-pipeline-pipelinets--order-within-one-tick) for the known approximations:

- The fluid state uses expected values.
- Render latency uses same-tick CMS conditions.
- Zipf popularity ranks are static.
- There is no CDN capacity eviction.
- Instance-level variance is ignored.

Compute behaviour (concurrency, scaling, cold starts) is an editable assumption. Treat results as a way to find risks and compare options, not as a guarantee.

## Repository layout

```
packages/engine/   pure TypeScript model, Zod schema, parameter registry, templates, findings (Vitest)
apps/web/          Vite + React UI: editor, charts, compare, findings
docs/              RESEARCH.md and DESIGN.md
```

- [docs/RESEARCH.md](docs/RESEARCH.md): public limits, framework behaviour and the questions the tool should answer.
- [docs/DESIGN.md](docs/DESIGN.md): model specification and implementation notes.
