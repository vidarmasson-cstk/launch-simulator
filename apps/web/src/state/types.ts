/**
 * Contract between the app shell/editor (state, worker, editor) and the results views.
 * Results components receive data only through props built from these types.
 */
import type {
  Finding,
  Preset,
  Scenario,
  ScenarioPatch,
  SimulationResult,
  SteadyStateResult,
} from '@launch-sim/engine';

export type RunStatus =
  | { state: 'idle' }
  | { state: 'running'; progress: number }
  | { state: 'done'; ms: number }
  | { state: 'error'; message: string };

export interface SavedScenario {
  id: string;
  name: string;
  scenario: Scenario;
  /** Timeline result, when it has been run. */
  result?: SimulationResult;
  steady: SteadyStateResult;
}

export type ResultsTab = 'steady' | 'timeline' | 'compare' | 'findings';

export interface AppState {
  scenario: Scenario;
  /** Paths overridden by the active private preset. */
  privatePaths: string[];
  privatePreset: Preset | null;
  steady: SteadyStateResult;
  result: SimulationResult | null;
  /** Scenario the current result was computed from (stale detection). */
  resultScenario: Scenario | null;
  runStatus: RunStatus;
  saved: SavedScenario[];
  compareIds: string[];
  tab: ResultsTab;
  findings: Finding[];
  /** Last rejected setParam (validation hint for the editor); cleared by the next accepted change. */
  paramError: { path: string; message: string } | null;

  setParam: (path: string, value: unknown) => void;
  setScenario: (scenario: Scenario) => void;
  loadTemplate: (id: string) => void;
  applyPatch: (patch: ScenarioPatch, asNewScenario: boolean) => void;
  loadPrivatePreset: (preset: Preset) => void;
  clearPrivatePreset: () => void;
  run: () => void;
  saveCurrent: (name?: string) => void;
  removeSaved: (id: string) => void;
  setCompareIds: (ids: string[]) => void;
  setTab: (tab: ResultsTab) => void;
}
