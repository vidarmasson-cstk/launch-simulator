import type { MetricsSeries } from '@launch-sim/engine';

/** Columns where the peak within a bucket matters (spikes must not be averaged away). */
const PEAK_COLUMNS = new Set([
  'launchOriginOffered',
  'launchOriginAccepted',
  'launch429',
  'c503',
  'c504',
  'queue',
  'queueWaitMs',
  'cmsOriginOffered',
  'cmsOriginTotal',
  'cmsOriginAccepted',
  'cmsQueued',
  'cms429',
  'cmsRetries',
  'cmsFinalFailures',
  'renderP95',
  'visitorP95',
  'visitorErrors',
  'visitorErrors5xx',
  'visitorErrors404',
  'visitorErrors429',
  'inFlight',
  'instances',
  'edgeRps',
  'edgePageRps',
  'edgeDataRps',
  'edgeBotRps',
  'gcraDelayMs',
]);

export type Row = Record<string, number> & { t: number };

export const MAX_POINTS = 1200;

export function bucketSize(length: number, maxPoints = MAX_POINTS): number {
  return Math.max(1, Math.ceil(length / maxPoints));
}

/**
 * Bucket per-second columns into at most `maxPoints` rows. Peak-like columns take the max of the
 * bucket, ratios and medians the mean. `t` is the bucket start second.
 */
export function downsample(
  series: MetricsSeries,
  columns: string[],
  maxPoints = MAX_POINTS,
  bucket = bucketSize(series.length, maxPoints),
): Row[] {
  const n = series.length;
  const rows: Row[] = [];
  for (let start = 0; start < n; start += bucket) {
    const end = Math.min(n, start + bucket);
    const row = { t: start } as Row;
    for (const name of columns) {
      const col = series.columns[name];
      if (!col) {
        row[name] = 0;
        continue;
      }
      if (bucket === 1) {
        row[name] = col[start]!;
      } else if (PEAK_COLUMNS.has(name)) {
        let m = -Infinity;
        for (let i = start; i < end; i++) if (col[i]! > m) m = col[i]!;
        row[name] = m;
      } else {
        // Mean over defined values: ratio columns are NaN for seconds without requests.
        let s = 0;
        let k = 0;
        for (let i = start; i < end; i++) {
          const v = col[i]!;
          if (Number.isFinite(v)) {
            s += v;
            k++;
          }
        }
        row[name] = k > 0 ? s / k : NaN;
      }
    }
    // Recharts draws gaps for null, not NaN.
    for (const name of columns) if (Number.isNaN(row[name])) (row as Record<string, number | null>)[name] = null;
    rows.push(row);
  }
  return rows;
}
