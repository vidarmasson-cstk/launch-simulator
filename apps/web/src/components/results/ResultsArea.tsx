import { useMemo, useRef, type KeyboardEvent } from 'react';
import { useAppStore } from '../../state/store';
import type { ResultsTab } from '../../state/types';
import { ComparePanel } from './ComparePanel';
import { FindingsPanel } from './FindingsPanel';
import { FlowDiagram } from './FlowDiagram';
import { hopsAtSecond } from './flowHops';
import { fmtClock } from './format';
import { useHoverStore } from './hover';
import { SteadyStatePanel } from './SteadyStatePanel';
import { TimelinePanel } from './TimelinePanel';

const TABS: Array<{ id: ResultsTab; label: string }> = [
  { id: 'steady', label: 'Steady state' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'compare', label: 'Compare' },
  { id: 'findings', label: 'Findings' },
];

/** Flow diagram wired to the store: steady values, or the hovered second on the Timeline tab. */
function ConnectedFlow() {
  const steady = useAppStore((s) => s.steady);
  const result = useAppStore((s) => s.result);
  const tab = useAppStore((s) => s.tab);
  const second = useHoverStore((s) => s.second);
  const hovered = tab === 'timeline' && result && second !== null;
  const hops = useMemo(
    () => (hovered && result ? hopsAtSecond(steady.hops, result.series, second!) : steady.hops),
    [hovered, result, steady.hops, second],
  );
  return <FlowDiagram hops={hops} caption={hovered ? `Simulated second ${fmtClock(second!)}` : 'Steady state'} />;
}

function Tabs() {
  const tab = useAppStore((s) => s.tab);
  const setTab = useAppStore((s) => s.setTab);
  const count = useAppStore((s) => s.findings.length);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    let n = i;
    if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') n = (i + TABS.length - 1) % TABS.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = TABS.length - 1;
    else return;
    e.preventDefault();
    setTab(TABS[n]!.id);
    refs.current[n]?.focus();
  };
  return (
    <div role="tablist" aria-label="Results views" className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800">
      {TABS.map((t, i) => {
        const active = tab === t.id;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            type="button"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-indigo-600 ${
              active
                ? 'border-indigo-600 text-slate-900 dark:border-indigo-400 dark:text-slate-50'
                : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
            }`}
          >
            {t.label}
            {t.id === 'findings' && count > 0 && (
              <span
                aria-label={`${count} findings`}
                className="rounded-full bg-slate-200 px-1.5 text-xs tabular-nums text-slate-800 dark:bg-slate-700 dark:text-slate-100"
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function Panel() {
  const tab = useAppStore((s) => s.tab);
  const steady = useAppStore((s) => s.steady);
  const result = useAppStore((s) => s.result);
  const scenario = useAppStore((s) => s.scenario);
  const resultScenario = useAppStore((s) => s.resultScenario);
  const runStatus = useAppStore((s) => s.runStatus);
  const run = useAppStore((s) => s.run);
  const saved = useAppStore((s) => s.saved);
  const compareIds = useAppStore((s) => s.compareIds);
  const setCompareIds = useAppStore((s) => s.setCompareIds);
  const saveCurrent = useAppStore((s) => s.saveCurrent);
  const findings = useAppStore((s) => s.findings);
  const applyPatch = useAppStore((s) => s.applyPatch);
  const stale = useMemo(
    () => !!result && JSON.stringify(scenario) !== JSON.stringify(resultScenario),
    [result, scenario, resultScenario],
  );
  switch (tab) {
    case 'timeline':
      return <TimelinePanel result={result} stale={stale} runStatus={runStatus} onRun={run} />;
    case 'compare':
      return (
        <ComparePanel saved={saved} compareIds={compareIds} onChangeIds={setCompareIds} onSave={() => saveCurrent()} />
      );
    case 'findings':
      return <FindingsPanel findings={findings} onApply={applyPatch} />;
    default:
      return <SteadyStatePanel steady={steady} />;
  }
}

/** Main results column: flow diagram, tabs and the active panel. */
export function ResultsArea() {
  return (
    <div className="space-y-3 p-3 md:p-4">
      <ConnectedFlow />
      <Tabs />
      <Panel />
    </div>
  );
}
