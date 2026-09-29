import type { PopularityBin, PopularityConfig } from './types';

const DEFAULT_TOP_RANKS = 16;
const DEFAULT_MAX_BINS = 64;
/** Max number of geometric page-rank ranges beyond the top ranks. */
const MAX_PAGE_RANGES = 128;

function zipfWeights(count: number, alpha: number): Float64Array {
  const w = new Float64Array(count);
  for (let i = 0; i < count; i++) w[i] = alpha === 0 ? 1 : Math.pow(i + 1, -alpha);
  return w;
}

/**
 * Zipf key-space binning (DESIGN 6.1). Bins sum to 1 in n*p.
 *
 * Key probability = pageWeight(rank) * localeWeight(rank) / variants. The top `topRanks` keys get
 * their own bin; every other (page-range, locale) cell is assigned to one of the remaining
 * log-spaced probability buckets. Cost is O(pages + ranges * locales); the key space is never
 * materialised.
 */
export function buildPopularityBins(config: PopularityConfig): PopularityBin[] {
  const pages = Math.floor(config.pages);
  const locales = Math.floor(config.locales);
  const variants = Math.floor(config.variants);
  if (!(pages >= 1) || !(locales >= 1) || !(variants >= 1)) {
    throw new Error('popularity: pages, locales and variants must be >= 1');
  }
  const maxBins = Math.max(1, Math.floor(config.maxBins ?? DEFAULT_MAX_BINS));
  const topRanks = Math.max(0, Math.floor(config.topRanks ?? DEFAULT_TOP_RANKS));
  const totalKeys = pages * locales * variants;
  const topCount = Math.min(topRanks, totalKeys, maxBins === 1 ? 0 : maxBins - 1);

  // ---- Page groups: individual ranks up to K, then geometric ranges. ----
  const singles = Math.min(pages, Math.max(topCount, 1));
  const groupStart: number[] = [];
  const groupEnd: number[] = [];
  for (let i = 1; i <= singles; i++) {
    groupStart.push(i);
    groupEnd.push(i);
  }
  const restPages = pages - singles;
  if (restPages > 0) {
    const ranges = Math.min(restPages, MAX_PAGE_RANGES);
    let prev = singles;
    for (let k = 1; k <= ranges; k++) {
      const end = k === ranges ? pages : singles + Math.round(Math.pow(restPages, k / ranges));
      if (end > prev) {
        groupStart.push(prev + 1);
        groupEnd.push(end);
        prev = end;
      }
    }
  }
  const G = groupStart.length;
  const gSum = new Float64Array(G);
  let pageTotal = 0;
  {
    let g = 0;
    const alpha = config.zipfAlpha;
    let acc = 0;
    for (let i = 1; i <= pages; i++) {
      acc += alpha === 0 ? 1 : Math.pow(i, -alpha);
      if (i === groupEnd[g]) {
        gSum[g] = acc;
        pageTotal += acc;
        acc = 0;
        g++;
      }
    }
  }

  const lw = zipfWeights(locales, config.localeZipfAlpha);
  let localeTotal = 0;
  for (let j = 0; j < locales; j++) localeTotal += lw[j]!;
  for (let j = 0; j < locales; j++) lw[j] = lw[j]! / localeTotal;

  const bins: PopularityBin[] = [];
  const removed = new Float64Array(singles * locales);

  // ---- Top keys: cells (i, j) with i*j <= topCount dominate everything else. ----
  if (topCount > 0) {
    const cand: { i: number; j: number; p: number }[] = [];
    for (let i = 1; i <= Math.min(singles, topCount); i++) {
      const pageP = gSum[i - 1]! / pageTotal; // singles: one page per group
      const jMax = Math.min(locales, Math.floor(topCount / i));
      for (let j = 1; j <= jMax; j++) cand.push({ i, j, p: (pageP * lw[j - 1]!) / variants });
    }
    cand.sort((a, b) => b.p - a.p || a.i * a.j - b.i * b.j);
    let remaining = topCount;
    for (const c of cand) {
      if (remaining <= 0) break;
      const t = Math.min(variants, remaining);
      for (let k = 0; k < t; k++) bins.push({ n: 1, p: c.p });
      removed[(c.i - 1) * locales + (c.j - 1)] = t;
      remaining -= t;
    }
  }

  // ---- Remaining cells into log-probability buckets. ----
  const B = Math.max(1, maxBins - bins.length);
  const cellN: number[] = [];
  const cellP: number[] = [];
  let lnMin = Infinity;
  let lnMax = -Infinity;
  for (let g = 0; g < G; g++) {
    const count = groupEnd[g]! - groupStart[g]! + 1;
    const pageMean = gSum[g]! / count / pageTotal;
    for (let j = 0; j < locales; j++) {
      const n = count * variants - (g < singles ? removed[g * locales + j]! : 0);
      if (n <= 0) continue;
      const p = (pageMean * lw[j]!) / variants;
      if (!(p > 0)) continue;
      cellN.push(n);
      cellP.push(p);
      const l = Math.log(p);
      if (l < lnMin) lnMin = l;
      if (l > lnMax) lnMax = l;
    }
  }
  if (cellN.length > 0) {
    const bucketN = new Float64Array(B);
    const bucketMass = new Float64Array(B);
    const span = lnMax - lnMin;
    for (let c = 0; c < cellN.length; c++) {
      let idx = 0;
      if (B > 1 && span > 1e-12) {
        idx = Math.min(B - 1, Math.floor(((Math.log(cellP[c]!) - lnMin) / span) * B));
      }
      bucketN[idx] = bucketN[idx]! + cellN[c]!;
      bucketMass[idx] = bucketMass[idx]! + cellN[c]! * cellP[c]!;
    }
    for (let b = 0; b < B; b++) {
      if (bucketN[b]! > 0) bins.push({ n: bucketN[b]!, p: bucketMass[b]! / bucketN[b]! });
    }
  }

  bins.sort((a, b) => b.p - a.p);
  return bins;
}

/** Single bin of n equally popular keys. */
export function binsFromUniform(n: number): PopularityBin[] {
  const keys = Math.max(1, n);
  return [{ n: keys, p: 1 / keys }];
}

/** Number of keys (most popular first) needed to cover `fraction` of traffic. */
export function topKeysShare(bins: PopularityBin[], fraction: number): number {
  if (!(fraction > 0)) return 0;
  const sorted = [...bins].sort((a, b) => b.p - a.p);
  let covered = 0;
  let keys = 0;
  for (const bin of sorted) {
    const mass = bin.n * bin.p;
    if (covered + mass >= fraction - 1e-12) {
      keys += bin.p > 0 ? Math.min(bin.n, (fraction - covered) / bin.p) : 0;
      return Math.ceil(keys - 1e-9);
    }
    covered += mass;
    keys += bin.n;
  }
  return Math.ceil(keys - 1e-9);
}
