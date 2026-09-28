import type { ReactNode } from 'react';
import { STATUS_GLYPH, STATUS_LABEL, type Status } from './colors';

const STATUS_TEXT: Record<Status, string> = {
  good: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  crit: 'text-red-700 dark:text-red-400',
};
const STATUS_BAR: Record<Status, string> = {
  good: 'bg-emerald-600 dark:bg-emerald-500',
  warn: 'bg-amber-500',
  crit: 'bg-red-600 dark:bg-red-500',
};

export interface KpiProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  status?: Status;
  title?: string;
}

/** Stat tile: label, headline number, optional sub-line and reserved-colour status with glyph. */
export function Kpi({ label, value, sub, status, title }: KpiProps) {
  return (
    <div
      title={title}
      className="relative overflow-hidden rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900"
    >
      {status && <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${STATUS_BAR[status]}`} />}
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-50">{value}</div>
      {(sub || status) && (
        <div className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">
          {status && (
            <span className={`mr-1 font-medium ${STATUS_TEXT[status]}`}>
              <span aria-hidden="true">{STATUS_GLYPH[status]} </span>
              {STATUS_LABEL[status]}
            </span>
          )}
          {sub}
        </div>
      )}
    </div>
  );
}

export function KpiGrid({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
      {children}
    </div>
  );
}
