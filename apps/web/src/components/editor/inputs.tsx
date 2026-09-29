import { useId, useState } from 'react';
import { focusRing } from '../ui';

const base =
  'rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 ' +
  focusRing;

export function NumInput({
  value,
  onCommit,
  min,
  max,
  step,
  label,
  invalid,
  disabled,
  className = 'w-24',
}: {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  invalid?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      inputMode="decimal"
      aria-label={label}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      min={min}
      max={max}
      step={step ?? 'any'}
      value={draft ?? (Number.isFinite(value) ? String(value) : '')}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = e.target.valueAsNumber;
        if (e.target.value !== '' && Number.isFinite(n)) onCommit(n);
      }}
      onBlur={() => setDraft(null)}
      className={`${base} text-right tabular-nums ${className} ${invalid ? 'border-red-500 dark:border-red-500' : ''} disabled:opacity-40`}
    />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-slate-600'} ${focusRing}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : ''}`}
      />
    </button>
  );
}

export function SelectInput({
  value,
  options,
  onChange,
  label,
  className = 'w-40',
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  label: string;
  className?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${base} ${className}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function TextInput({
  value,
  onChange,
  label,
  className = 'w-full',
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  className?: string;
}) {
  const id = useId();
  return (
    <input
      id={id}
      type="text"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${base} ${className}`}
    />
  );
}
