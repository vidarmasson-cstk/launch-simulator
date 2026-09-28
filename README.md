# Launch Simulator

A request-path load simulator for sites hosted on Contentstack Launch. It answers whether a site stays inside the rate limits, timeouts and compute capacity of Launch and the Contentstack CMS APIs under steady peak traffic and transient events (publishes, deploys, go-lives, crawler surges, load tests), across frameworks and caching/retry strategies.

## Layout

- `packages/engine` (`@launch-sim/engine`): pure TypeScript model, Zod scenario schema, parameter registry with provenance, framework presets. Consumed directly as TS source.
- `apps/web`: placeholder for the Vite + React UI (later wave).
- `docs/`: [DESIGN.md](docs/DESIGN.md) (spec) and [RESEARCH.md](docs/RESEARCH.md) (research basis).

## Scripts

Run from the repo root (Node >= 20): `npm install`, `npm run build`, `npm test`, `npm run typecheck`, `npm run lint`, `npm run format`.

## Public defaults and private presets

This repository is public and ships only publicly documented values as defaults. Every parameter carries provenance (`documented`, `conflicting`, `observed`, `assumption`, `private`) and source links (`packages/engine/src/params/`). Internal users can load a private preset (`launch-sim-preset/v1` JSON) that overrides defaults locally. Keep such files out of git: `presets/private/` and `*.private.json` are ignored.
