import { useState } from 'react';
import { EventSchema, setByPath, type ScenarioEvent } from '@launch-sim/engine';
import { useAppStore } from '../../state/store';
import { Icon, focusRing, useDismiss, type IconName } from '../ui';
import { NumInput, SelectInput, Toggle } from './inputs';

type Kind = ScenarioEvent['kind'];

const KINDS: { kind: Kind; label: string; icon: IconName }[] = [
  { kind: 'spike', label: 'Traffic spike', icon: 'bolt' },
  { kind: 'publish', label: 'Publish', icon: 'upload-cloud' },
  { kind: 'deploy', label: 'Deploy', icon: 'rocket' },
  { kind: 'goLive', label: 'Go-live (cold)', icon: 'globe' },
  { kind: 'crawler', label: 'Crawler', icon: 'bot' },
  { kind: 'loadTest', label: 'Load test', icon: 'test' },
  { kind: 'otherTraffic', label: 'Other org traffic', icon: 'users' },
];

type FieldDef =
  | { path: string; label: string; type: 'num'; unit?: string; min?: number; max?: number; step?: number }
  | { path: string; label: string; type: 'bool' }
  | { path: string; label: string; type: 'select'; options: { value: string; label: string }[] };

const num = (path: string, label: string, unit?: string, min = 0, step = 1, max?: number): FieldDef => ({
  path,
  label,
  type: 'num',
  unit,
  min,
  step,
  max,
});
const frac = (path: string, label: string) => num(path, label, 'fraction', 0, 0.05, 1);

const FIELDS: Record<Kind, FieldDef[]> = {
  spike: [num('durationSec', 'Duration', 's', 1), num('multiplier', 'Multiplier', '×', 0, 0.5), num('rampSec', 'Ramp', 's')],
  publish: [
    num('entries', 'Entries', '', 1),
    num('spreadSec', 'Spread', 's'),
    {
      path: 'onPublish',
      label: 'On publish',
      type: 'select',
      options: [
        { value: 'none', label: 'Nothing' },
        { value: 'revalidatePaths', label: 'Revalidate paths' },
        { value: 'revalidateTags', label: 'Revalidate tags' },
        { value: 'redeploy', label: 'Redeploy' },
      ],
    },
    { path: 'purge.pageQueries', label: 'Purge page queries', type: 'bool' },
    { path: 'purge.contentTypeLists', label: 'Purge type lists', type: 'bool' },
    frac('purge.referencingFraction', 'Purge referencing'),
    { path: 'purge.globals', label: 'Purge globals', type: 'bool' },
  ],
  deploy: [num('buildSec', 'Build time', 's'), num('priming.paths', 'Priming paths', '', 0), num('priming.rps', 'Priming rate', 'req/s')],
  goLive: [],
  crawler: [
    num('durationSec', 'Duration', 's', 1),
    num('rps', 'Rate', 'req/s'),
    frac('randomQueryFraction', 'Random-query fraction'),
    frac('notFoundFraction', '404 fraction'),
  ],
  loadTest: [
    num('durationSec', 'Duration', 's', 1),
    num('rps', 'Rate', 'req/s'),
    { path: 'cacheBusting', label: 'Cache busting', type: 'bool' },
  ],
  otherTraffic: [num('durationSec', 'Duration', 's', 1), num('rps', 'Rate', 'req/s')],
};

function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}

function EventRow({ ev, index }: { ev: ScenarioEvent; index: number }) {
  const events = useAppStore((s) => s.scenario.events);
  const setParam = useAppStore((s) => s.setParam);
  const err = useAppStore((s) => (s.paramError?.path === 'events' ? s.paramError.message : null));
  const [open, setOpen] = useState(false);
  const def = KINDS.find((k) => k.kind === ev.kind)!;
  const fields = FIELDS[ev.kind];

  const update = (path: string, value: unknown) => {
    const next = events.map((e, i) => (i === index ? setByPath(e, path, value) : e));
    setParam('events', next);
  };
  const remove = () => setParam('events', events.filter((_, i) => i !== index));
  const name = `${def.label} #${index + 1}`;

  return (
    <li className="rounded-md border border-slate-200 dark:border-slate-700">
      <div className="flex items-center gap-1 px-2 py-1">
        <Icon name={def.icon} className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
        <span className="flex-1 truncate text-xs font-medium">{def.label}</span>
        <span className="text-[10px] text-slate-400">at</span>
        <NumInput
          label={`${name} start time (s)`}
          value={ev.atSec}
          min={0}
          step={10}
          onCommit={(v) => update('atSec', v)}
          className="w-16"
        />
        <span className="text-[10px] text-slate-400">s</span>
        {fields.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} ${name} fields`}
            onClick={() => setOpen((o) => !o)}
            className={`rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 ${focusRing}`}
          >
            <Icon name="chevron" className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
          </button>
        )}
        <button
          type="button"
          aria-label={`Delete ${name}`}
          onClick={remove}
          className={`rounded p-1 text-slate-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950 ${focusRing}`}
        >
          <Icon name="trash" className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && (
        <div className="space-y-1 border-t border-slate-100 px-2 py-1.5 dark:border-slate-800">
          {fields.map((f) => {
            const v = get(ev, f.path);
            let control;
            if (f.type === 'bool') control = <Toggle checked={Boolean(v)} onChange={(x) => update(f.path, x)} label={f.label} />;
            else if (f.type === 'select')
              control = <SelectInput label={f.label} value={String(v)} options={f.options} onChange={(x) => update(f.path, x)} className="w-36" />;
            else
              control = (
                <NumInput label={`${name} ${f.label}`} value={v as number} min={f.min} max={f.max} step={f.step} onCommit={(x) => update(f.path, x)} />
              );
            return (
              <div key={f.path} className="flex items-center gap-1">
                <span className="flex-1 text-xs text-slate-600 dark:text-slate-400">{f.label}</span>
                {control}
                <span className="w-10 text-[10px] text-slate-400">{f.type === 'num' ? f.unit : ''}</span>
              </div>
            );
          })}
          {ev.kind === 'publish' && (
            <div className="flex items-center gap-1">
              <span className="flex-1 text-xs text-slate-600 dark:text-slate-400">Locales</span>
              <label className="flex items-center gap-1 text-[11px] text-slate-500">
                <input
                  type="checkbox"
                  checked={ev.locales === 'all'}
                  onChange={(e) => update('locales', e.target.checked ? 'all' : 1)}
                />
                all
              </label>
              <NumInput
                label={`${name} locales`}
                value={ev.locales === 'all' ? 0 : ev.locales}
                disabled={ev.locales === 'all'}
                min={1}
                step={1}
                onCommit={(x) => update('locales', x)}
                className="w-16"
              />
              <span className="w-10" />
            </div>
          )}
        </div>
      )}
      {err && (
        <div role="alert" className="px-2 pb-1 text-[11px] text-red-600 dark:text-red-400">
          Rejected: {err}
        </div>
      )}
    </li>
  );
}

export function EventsEditor() {
  const events = useAppStore((s) => s.scenario.events);
  const setParam = useAppStore((s) => s.setParam);
  const [menu, setMenu] = useState(false);
  const ref = useDismiss(menu, () => setMenu(false));

  const add = (kind: Kind) => {
    const ev = EventSchema.parse({ kind });
    setParam('events', [...events, ev]);
    setMenu(false);
  };

  return (
    <div>
      {events.length === 0 ? (
        <p className="py-1 text-xs text-slate-500 dark:text-slate-400">No events: steady traffic only.</p>
      ) : (
        <ul className="space-y-1.5">
          {events.map((ev, i) => (
            <EventRow key={i} ev={ev} index={i} />
          ))}
        </ul>
      )}
      <div ref={ref} className="relative mt-2">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
          className={`flex items-center gap-1 rounded border border-dashed border-slate-400 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800 ${focusRing}`}
        >
          <Icon name="plus" className="h-3.5 w-3.5" /> Add event
        </button>
        {menu && (
          <ul
            role="menu"
            className="absolute bottom-full left-0 z-30 mb-1 w-48 rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
          >
            {KINDS.map((k) => (
              <li key={k.kind} role="none">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => add(k.kind)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-800 ${focusRing}`}
                >
                  <Icon name={k.icon} className="h-3.5 w-3.5 text-indigo-500" /> {k.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
