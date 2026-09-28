import { create } from 'zustand';
import LZString from 'lz-string';
import {
  ScenarioSchema,
  TEMPLATES,
  applyPatch as enginePatch,
  applyPreset,
  computeSteadyState,
  generateFindings,
  getByPath,
  setByPath,
  type Preset,
  type Scenario,
  type SimulationResult,
} from '@launch-sim/engine';
import type { AppState, ResultsTab, SavedScenario } from './types';
import type { WorkerResponse } from '../worker/simWorker';

const STORE_KEY = 'launch-sim:v1';
const PRESET_KEY = 'launch-sim:private-preset';

// ---- safe storage ----
function lsGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string | null) {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    /* ignore */
  }
}

// ---- helpers ----
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const clone = <T>(v: T): T => structuredClone(v);
export const defaultScenario = (): Scenario => ScenarioSchema.parse({});
const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function derive(scenario: Scenario, result?: SimulationResult | null) {
  const steady = computeSteadyState(scenario);
  return { steady, findings: generateFindings(scenario, steady, result ?? undefined) };
}

/** Revert the given paths to public defaults. */
function revertPaths(scenario: Scenario, paths: string[]): Scenario {
  const defaults = defaultScenario();
  let next = scenario;
  for (const p of paths) next = setByPath(next, p, getByPath(defaults, p));
  return ScenarioSchema.parse(next);
}

function presetValue(preset: Preset, path: string): unknown {
  return (preset.overrides[path] as { value: unknown } | undefined)?.value;
}

function firstIssue(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const i = error.issues[0];
  return i ? i.message : 'Invalid value';
}

// ---- share URL ----
export function encodeScenario(scenario: Scenario): string {
  return LZString.compressToEncodedURIComponent(JSON.stringify(scenario));
}
export function decodeScenario(encoded: string): Scenario | null {
  try {
    const json = LZString.decompressFromEncodedURIComponent(encoded);
    if (!json) return null;
    const r = ScenarioSchema.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
function scenarioFromHash(hash: string): Scenario | null {
  const m = /(?:^#|&)s=([^&]+)/.exec(hash);
  return m?.[1] ? decodeScenario(m[1]) : null;
}

/** Current scenario; with stripPrivate, private-preset values revert to public defaults. */
export function currentScenario(stripPrivate: boolean): Scenario {
  const st = useAppStore.getState();
  return stripPrivate && st.privatePaths.length > 0 ? revertPaths(st.scenario, st.privatePaths) : st.scenario;
}

/** Share URL for the current scenario. With stripPrivate, private-preset values revert to public defaults. */
export function buildShareUrl(stripPrivate: boolean): string {
  const base = typeof location !== 'undefined' ? location.href.split('#')[0] : '';
  return `${base}#s=${encodeScenario(currentScenario(stripPrivate))}`;
}

// ---- initial state ----
interface Persisted {
  scenario?: unknown;
  saved?: { id: string; name: string; scenario: unknown }[];
  tab?: ResultsTab;
}

const TABS: ResultsTab[] = ['steady', 'timeline', 'compare', 'findings'];

function loadInitial() {
  let scenario = defaultScenario();
  let saved: SavedScenario[] = [];
  let tab: ResultsTab = 'steady';
  let preset: Preset | null = null;
  let privatePaths: string[] = [];
  let fromUrl = false;

  try {
    const p = JSON.parse(lsGet(STORE_KEY) ?? 'null') as Persisted | null;
    if (p) {
      const s = ScenarioSchema.safeParse(p.scenario ?? {});
      if (p.scenario && s.success) scenario = s.data;
      if (p.tab && TABS.includes(p.tab)) tab = p.tab;
      for (const e of p.saved ?? []) {
        const sc = ScenarioSchema.safeParse(e.scenario);
        if (sc.success && e.id)
          saved.push({ id: e.id, name: e.name, scenario: sc.data, steady: computeSteadyState(sc.data) });
      }
    }
  } catch {
    saved = [];
  }

  const shared = typeof location !== 'undefined' ? scenarioFromHash(location.hash) : null;
  if (shared) {
    scenario = shared;
    fromUrl = true;
  }

  if (!fromUrl) {
    try {
      const raw = JSON.parse(lsGet(PRESET_KEY) ?? 'null') as { preset?: Preset } | null;
      if (raw?.preset) {
        const applied = applyPreset(scenario, raw.preset);
        preset = raw.preset;
        privatePaths = applied.overriddenPaths;
        scenario = applied.scenario;
      }
    } catch {
      preset = null;
    }
  }
  return { scenario, saved, tab, preset, privatePaths };
}

// ---- worker ----
let worker: Worker | null = null;
function killWorker() {
  worker?.terminate();
  worker = null;
}

export const useAppStore = create<AppState>()((set, get) => {
  const init = loadInitial();
  const d0 = derive(init.scenario);

  const apply = (scenario: Scenario, extra: Partial<AppState> = {}) => {
    const st = get();
    const stillFresh = st.result && st.resultScenario && same(st.resultScenario, scenario);
    set({
      scenario,
      ...derive(scenario, stillFresh ? st.result : null),
      paramError: null,
      ...extra,
    });
  };

  return {
    scenario: init.scenario,
    privatePaths: init.privatePaths,
    privatePreset: init.preset,
    steady: d0.steady,
    findings: d0.findings,
    result: null,
    resultScenario: null,
    runStatus: { state: 'idle' },
    saved: init.saved,
    compareIds: [],
    tab: init.tab,
    paramError: null,

    setParam: (path, value) => {
      const st = get();
      const next = ScenarioSchema.safeParse(setByPath(clone(st.scenario), path, value));
      if (!next.success) {
        set({ paramError: { path, message: firstIssue(next.error) } });
        return;
      }
      apply(next.data, {
        privatePaths: st.privatePaths.filter((p) => p !== path && !path.startsWith(`${p}.`)),
      });
    },

    setScenario: (scenario) => {
      const st = get();
      const parsed = ScenarioSchema.safeParse(scenario);
      if (!parsed.success) {
        set({ paramError: { path: '', message: firstIssue(parsed.error) } });
        return;
      }
      const preset = st.privatePreset;
      apply(parsed.data, {
        privatePaths: preset
          ? st.privatePaths.filter((p) => same(getByPath(parsed.data, p), presetValue(preset, p)))
          : [],
      });
    },

    loadTemplate: (id) => {
      const t = TEMPLATES.find((x) => x.id === id);
      if (!t) return;
      let sc = ScenarioSchema.parse(t.scenario);
      let paths: string[] = [];
      const preset = get().privatePreset;
      if (preset) {
        try {
          const a = applyPreset(sc, preset);
          sc = a.scenario;
          paths = a.overriddenPaths;
        } catch {
          /* keep public template */
        }
      }
      apply(sc, { privatePaths: paths, result: null, resultScenario: null, runStatus: { state: 'idle' } });
    },

    applyPatch: (patch, asNewScenario) => {
      const st = get();
      const parsed = ScenarioSchema.safeParse(enginePatch(clone(st.scenario), patch));
      if (!parsed.success) {
        set({ paramError: { path: '', message: firstIssue(parsed.error) } });
        return;
      }
      if (!asNewScenario) {
        apply(parsed.data);
        return;
      }
      const saved = [...st.saved];
      const fresh = st.result && st.resultScenario && same(st.resultScenario, st.scenario);
      let base = saved.find((s) => same(s.scenario, st.scenario));
      if (!base) {
        base = {
          id: newId(),
          name: st.scenario.name,
          scenario: clone(st.scenario),
          steady: st.steady,
          ...(fresh && st.result ? { result: st.result } : {}),
        };
        saved.push(base);
      }
      const patched: Scenario = { ...parsed.data, name: `${st.scenario.name} (patched)` };
      const entry: SavedScenario = {
        id: newId(),
        name: patched.name,
        scenario: patched,
        steady: computeSteadyState(patched),
      };
      saved.push(entry);
      apply(patched, { saved, compareIds: [base.id, entry.id], tab: 'compare' });
    },

    loadPrivatePreset: (preset) => {
      const st = get();
      const a = applyPreset(st.scenario, preset);
      lsSet(PRESET_KEY, JSON.stringify({ preset }));
      apply(a.scenario, { privatePreset: preset, privatePaths: a.overriddenPaths });
    },

    clearPrivatePreset: () => {
      const st = get();
      lsSet(PRESET_KEY, null);
      apply(revertPaths(st.scenario, st.privatePaths), { privatePreset: null, privatePaths: [] });
    },

    run: () => {
      const st = get();
      killWorker();
      if (typeof Worker === 'undefined') {
        set({ runStatus: { state: 'error', message: 'Web Workers are not available.' } });
        return;
      }
      const scenario = clone(st.scenario);
      set({ runStatus: { state: 'running', progress: 0 } });
      const w = new Worker(new URL('../worker/simWorker.ts', import.meta.url), { type: 'module' });
      worker = w;
      w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        if (worker !== w) return;
        const m = ev.data;
        if (m.type === 'progress') {
          set({ runStatus: { state: 'running', progress: m.fraction } });
        } else if (m.type === 'result') {
          const cur = get();
          const steady = computeSteadyState(scenario);
          const findings = same(cur.scenario, scenario)
            ? generateFindings(scenario, steady, m.result)
            : cur.findings;
          set({
            result: m.result,
            resultScenario: scenario,
            runStatus: { state: 'done', ms: m.ms },
            findings,
          });
          killWorker();
        } else {
          set({ runStatus: { state: 'error', message: m.message } });
          killWorker();
        }
      };
      w.onerror = (e) => {
        if (worker !== w) return;
        set({ runStatus: { state: 'error', message: e.message || 'Worker error' } });
        killWorker();
      };
      w.postMessage({ type: 'run', scenario });
    },

    saveCurrent: (name) => {
      const st = get();
      const fresh = st.result && st.resultScenario && same(st.resultScenario, st.scenario);
      const entry: SavedScenario = {
        id: newId(),
        name: name?.trim() || st.scenario.name || 'Scenario',
        scenario: clone(st.scenario),
        steady: st.steady,
        ...(fresh && st.result ? { result: st.result } : {}),
      };
      set({ saved: [...st.saved, entry] });
    },

    removeSaved: (id) => {
      const st = get();
      set({ saved: st.saved.filter((s) => s.id !== id), compareIds: st.compareIds.filter((c) => c !== id) });
    },

    setCompareIds: (ids) => set({ compareIds: ids.slice(0, 3) }),
    setTab: (tab) => set({ tab }),
  };
});

// ---- persistence (scenario, saved without results, tab) ----
useAppStore.subscribe((s, prev) => {
  if (s.scenario === prev.scenario && s.saved === prev.saved && s.tab === prev.tab) return;
  lsSet(
    STORE_KEY,
    JSON.stringify({
      scenario: s.scenario,
      saved: s.saved.map(({ id, name, scenario }) => ({ id, name, scenario })),
      tab: s.tab,
    } satisfies Persisted),
  );
});
