import { useState } from 'react';
import { SOURCES, type ParamMeta, type Provenance } from '@launch-sim/engine';
import { Icon, focusRing, useDismiss } from '../ui';

const TEXT: Record<Provenance, string> = {
  documented: 'Documented in public Contentstack docs',
  conflicting: 'Public sources disagree',
  observed: 'Observed in public SDK source / behaviour',
  assumption: 'Assumption or workload input',
  private: 'Value from a private preset',
};

export function ProvenanceMark({ kind }: { kind: Provenance }) {
  switch (kind) {
    case 'documented':
      return <span className="block h-2.5 w-2.5 rounded-full bg-emerald-500" />;
    case 'conflicting':
      return (
        <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-400 text-[10px] leading-none font-bold text-amber-950">
          !
        </span>
      );
    case 'observed':
      return <span className="block h-2.5 w-2.5 rounded-full bg-sky-500" />;
    case 'private':
      return <Icon name="lock" className="h-3 w-3 text-violet-500" />;
    default:
      return (
        <span className="block h-2.5 w-2.5 rounded-full border border-dashed border-slate-500 dark:border-slate-400" />
      );
  }
}

export function ProvenanceBadge({ meta, provenance }: { meta: ParamMeta; provenance: Provenance }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const title = `${TEXT[provenance]}${meta.note ? ` — ${meta.note}` : ''}`;
  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        title={title}
        aria-label={`Provenance: ${provenance}. Show details`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-5 w-5 items-center justify-center rounded ${focusRing}`}
      >
        <ProvenanceMark kind={provenance} />
      </button>
      {open && (
        <div
          role="dialog"
          className="absolute top-6 left-0 z-30 w-64 rounded-md border border-slate-200 bg-white p-3 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          <div className="mb-1 font-medium">{TEXT[provenance]}</div>
          {meta.note && <p className="mb-2 text-slate-600 dark:text-slate-400">{meta.note}</p>}
          {meta.conflict && meta.conflict.length > 0 && (
            <div className="mb-2">
              <div className="font-medium text-amber-600 dark:text-amber-400">Conflicting values</div>
              <ul className="mt-1 space-y-1">
                {meta.conflict.map((c, i) => (
                  <li key={i}>
                    <span className="font-mono">{String(c.value)}</span>{' '}
                    <a
                      className="text-indigo-600 underline dark:text-indigo-400"
                      href={SOURCES[c.sourceId]?.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {SOURCES[c.sourceId]?.title ?? c.sourceId}
                    </a>
                    {c.note && <div className="text-slate-500">{c.note}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {meta.sources.length > 0 && (
            <div>
              <div className="font-medium">Sources</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {meta.sources.map((id) => (
                  <li key={id}>
                    <a
                      className="text-indigo-600 underline dark:text-indigo-400"
                      href={SOURCES[id]?.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {SOURCES[id]?.title ?? id}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
