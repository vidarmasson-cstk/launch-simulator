import { useEffect, useState } from 'react';

/**
 * Chart palette: the validated neutral categorical slots of the dataviz skill, stepped per mode.
 * Colour follows the entity (offered is always blue, rejected always red, ...), never its rank.
 */
export interface Palette {
  blue: string;
  orange: string;
  aqua: string;
  yellow: string;
  magenta: string;
  violet: string;
  red: string;
  ink: string;
  muted: string;
  grid: string;
  surface: string;
  good: string;
  warn: string;
  crit: string;
}

export const LIGHT: Palette = {
  blue: '#2a78d6',
  orange: '#eb6834',
  aqua: '#1baf7a',
  yellow: '#eda100',
  magenta: '#e87ba4',
  violet: '#4a3aa7',
  red: '#e34948',
  ink: '#0f172a',
  muted: '#64748b',
  grid: '#e2e8f0',
  surface: '#ffffff',
  good: '#1baf7a',
  warn: '#eda100',
  crit: '#e34948',
};

export const DARK: Palette = {
  blue: '#3987e5',
  orange: '#d95926',
  aqua: '#199e70',
  yellow: '#c98500',
  magenta: '#d55181',
  violet: '#9085e9',
  red: '#e66767',
  ink: '#f1f5f9',
  muted: '#94a3b8',
  grid: '#1e293b',
  surface: '#0f172a',
  good: '#199e70',
  warn: '#c98500',
  crit: '#e66767',
};

/** Scenario colours in the Compare view (fixed order, first three categorical slots). */
export const SCENARIO_SLOTS: Array<keyof Palette> = ['blue', 'orange', 'aqua'];

function detectDark(): boolean {
  if (typeof document === 'undefined') return false;
  const root = document.documentElement;
  if (root.classList.contains('dark')) return true;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    // The app toggles the `dark` class; without it we follow the system setting.
    return window.matchMedia('(prefers-color-scheme: dark)').matches && !root.classList.contains('light');
  }
  return false;
}

/** Reactive palette that follows the `dark` class on <html>. */
export function usePalette(): Palette {
  const [dark, setDark] = useState(detectDark);
  useEffect(() => {
    const update = () => setDark(detectDark());
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    mq?.addEventListener?.('change', update);
    return () => {
      mo.disconnect();
      mq?.removeEventListener?.('change', update);
    };
  }, []);
  return dark ? DARK : LIGHT;
}

export type Status = 'good' | 'warn' | 'crit';

/** Headroom status from utilisation in percent: < 70 good, < 100 warn, >= 100 critical. */
export function statusOf(utilPct: number | undefined): Status | undefined {
  if (utilPct === undefined || !Number.isFinite(utilPct)) return undefined;
  if (utilPct < 70) return 'good';
  if (utilPct < 100) return 'warn';
  return 'crit';
}

export const STATUS_LABEL: Record<Status, string> = {
  good: 'Headroom',
  warn: 'Near limit',
  crit: 'Over limit',
};

/** Glyph shown with the colour so status never relies on hue alone. */
export const STATUS_GLYPH: Record<Status, string> = { good: '✓', warn: '!', crit: '✕' };
