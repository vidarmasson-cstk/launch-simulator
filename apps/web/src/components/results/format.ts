/** Number formatting helpers for the results views. All return plain strings. */

const UNITS: Array<[number, string]> = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
];

function trim(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Big numbers: 1234 -> "1.2K", 3_400_000 -> "3.4M", 950 -> "950". */
export function fmtBig(n: number): string {
  if (!Number.isFinite(n)) return '–';
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a < 1000) {
    if (a >= 999.5) return `${sign}1K`;
    return `${sign}${a >= 100 ? Math.round(a) : trim(a.toFixed(a >= 10 ? 0 : 1))}`;
  }
  for (let i = 0; i < UNITS.length; i++) {
    const [size, suffix] = UNITS[i]!;
    if (a >= size) {
      const v = a / size;
      const digits = v < 10 ? 1 : 0;
      if (Number(v.toFixed(digits)) >= 1000 && i > 0) {
        return `${sign}1${UNITS[i - 1]![1]}`;
      }
      return `${sign}${trim(v.toFixed(digits))}${suffix}`;
    }
  }
  return `${sign}${a}`;
}

/** Requests per second, without unit: 8.2, 143, 1.2K, 8.2K. Small values keep 2 decimals below 1. */
export function fmtRps(n: number): string {
  if (!Number.isFinite(n)) return '–';
  if (n === 0) return '0';
  if (Math.abs(n) < 1) return n.toFixed(2);
  return fmtBig(n);
}

/** Percentage from a plain percent value (143.2 -> "143%"). */
export function fmtPct(pct: number, digits = 0): string {
  if (!Number.isFinite(pct)) return '–';
  if (pct > 0 && pct < 0.5 && digits === 0) return '<1%';
  if (pct >= 1000) return `${fmtBig(pct)}%`;
  return `${trim(pct.toFixed(digits))}%`;
}

/** Percentage from a 0..1 ratio (0.923 -> "92%"). */
export function fmtRatio(r: number, digits = 0): string {
  if (!Number.isFinite(r)) return '–';
  return fmtPct(r * 100, digits);
}

/** Probability as percent, with a floor label for tiny values. */
export function fmtProb(p: number): string {
  if (!Number.isFinite(p)) return '–';
  if (p <= 0) return '0%';
  if (p < 0.0001) return '<0.01%';
  if (p < 0.01) return `${(p * 100).toFixed(2)}%`;
  if (p < 0.1) return `${(p * 100).toFixed(1)}%`;
  return `${Math.round(p * 100)}%`;
}

/** Milliseconds: 85 -> "85 ms", 1500 -> "1.5 s", 90000 -> "1.5 min". */
export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '–';
  if (ms < 1) return ms === 0 ? '0 ms' : '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${trim((ms / 1000).toFixed(ms < 10_000 ? 2 : 1))} s`;
  return `${trim((ms / 60_000).toFixed(1))} min`;
}

/** Seconds as a clock: 75 -> "01:15", 3725 -> "1:02:05". */
export function fmtClock(sec: number): string {
  if (!Number.isFinite(sec)) return '–';
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, '0');
  const rr = String(r).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${rr}` : `${mm}:${rr}`;
}

/** Plain decimal with a fixed max number of fraction digits, trailing zeros trimmed. */
export function fmtNum(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '–';
  return trim(n.toFixed(digits));
}

/** Seconds per hour of some event, "~0" when negligible. */
export function fmtSecPerHour(s: number): string {
  if (!Number.isFinite(s)) return '–';
  if (s < 0.05) return '~0';
  if (s < 10) return fmtNum(s, 1);
  return fmtBig(Math.round(s));
}
