import type { Finding, FindingSeverity, ScenarioPatch } from '@launch-sim/engine';

const ORDER: Record<FindingSeverity, number> = { critical: 0, warning: 1, info: 2 };

export function sortFindings(findings: Finding[]): Finding[] {
  return findings
    .map((f, i) => [f, i] as const)
    .sort((a, b) => ORDER[a[0].severity] - ORDER[b[0].severity] || a[1] - b[1])
    .map(([f]) => f);
}

const STYLE: Record<FindingSeverity, { label: string; box: string; badge: string }> = {
  critical: {
    label: 'Critical',
    box: 'border-l-red-600 dark:border-l-red-500',
    badge: 'text-red-700 dark:text-red-400',
  },
  warning: {
    label: 'Warning',
    box: 'border-l-amber-500',
    badge: 'text-amber-700 dark:text-amber-400',
  },
  info: {
    label: 'Info',
    box: 'border-l-sky-600 dark:border-l-sky-500',
    badge: 'text-sky-700 dark:text-sky-400',
  },
};

function Icon({ severity }: { severity: FindingSeverity }) {
  const common = { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'currentColor' } as const;
  if (severity === 'critical')
    return (
      <svg {...common}>
        <path d="M5 1h6l4 4v6l-4 4H5l-4-4V5zM5.4 4.6 4.6 5.4 7.2 8l-2.6 2.6.8.8L8 8.8l2.6 2.6.8-.8L8.8 8l2.6-2.6-.8-.8L8 7.2z" fillRule="evenodd" />
      </svg>
    );
  if (severity === 'warning')
    return (
      <svg {...common}>
        <path d="M8 1 15.5 14h-15zM7.3 6v4h1.4V6zm0 5v1.4h1.4V11z" fillRule="evenodd" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-.7 3h1.4v1.4H7.3zm0 2.6h1.4V12H7.3z" fillRule="evenodd" />
    </svg>
  );
}

export interface FindingsPanelProps {
  findings: Finding[];
  onApply: (patch: ScenarioPatch, compare: boolean) => void;
}

export function FindingsPanel({ findings, onApply }: FindingsPanelProps) {
  const sorted = sortFindings(findings);
  if (sorted.length === 0) {
    return (
      <div role="tabpanel" aria-label="Findings" className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
        No findings for this scenario.
      </div>
    );
  }
  return (
    <ul role="tabpanel" aria-label="Findings" className="space-y-2">
      {sorted.map((f, i) => {
        const s = STYLE[f.severity];
        return (
          <li
            key={`${f.title}-${i}`}
            className={`rounded-lg border border-l-4 border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900 ${s.box}`}
          >
            <div className="flex items-start gap-2">
              <span className={`mt-0.5 shrink-0 ${s.badge}`}>
                <Icon severity={f.severity} />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                  <span className={`mr-2 text-xs font-medium uppercase tracking-wide ${s.badge}`}>{s.label}</span>
                  {f.title}
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-slate-700 dark:text-slate-300">{f.detail}</p>
                {f.suggestion && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => onApply(f.suggestion!, false)}
                      className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                    >
                      Apply
                    </button>
                    <button
                      type="button"
                      onClick={() => onApply(f.suggestion!, true)}
                      className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700"
                    >
                      Apply &amp; compare
                    </button>
                  </div>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
