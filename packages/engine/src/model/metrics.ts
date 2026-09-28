import type { Scenario } from '../schema';
import { LatencyHistogram } from './latency';
import type { MetricsSeries, SummaryKpis } from './types';

/**
 * Per-tick sample handed to the collector by the pipeline. All fields marked "count" are amounts
 * for this tick (not rates); the collector converts sums into per-second rates.
 */
export interface TickSample {
  // edge (counts)
  edgePage: number;
  edgeData: number;
  /** Bot-driven requests (bot page + bot unique + not found); an "of which" figure. */
  edgeBot: number;
  edgeStatic: number;
  edgeTotal: number;
  // launch layers and origin (counts)
  launchReq: number;
  launchHits: number;
  launchOffered: number;
  launchAccepted: number;
  launch429: number;
  // compute
  instances: number;
  inFlight: number;
  queue: number;
  queueWaitMs: number;
  c503: number;
  c504: number;
  // cms (counts)
  cmsCalls: number;
  cmsReq: number;
  cmsHits: number;
  cmsOfferedNew: number;
  cmsOfferedOther: number;
  cmsTotal: number;
  cmsAccepted: number;
  cmsQueued: number;
  cms429: number;
  cmsRetries: number;
  cmsFinal: number;
  gcraDelayMs: number;
  otherOrg: number;
  // visitors (counts)
  visitorErrors5xx: number;
  visitorErrors404: number;
  visitorErrors429: number;
  visitorRequests: number;
  humanViews: number;
  // cumulative values
  revalidationsUsed: number;
  revalidationsRejected: number;
}

type Key = keyof TickSample;

/** Summed over the second, divided by the covered duration -> per-second rate. */
const RATE_KEYS: Key[] = [
  'edgePage',
  'edgeData',
  'edgeBot',
  'edgeStatic',
  'edgeTotal',
  'launchReq',
  'launchHits',
  'launchOffered',
  'launchAccepted',
  'launch429',
  'c503',
  'c504',
  'cmsCalls',
  'cmsReq',
  'cmsHits',
  'cmsOfferedNew',
  'cmsOfferedOther',
  'cmsTotal',
  'cmsAccepted',
  'cms429',
  'cmsRetries',
  'cmsFinal',
  'otherOrg',
  'visitorErrors5xx',
  'visitorErrors404',
  'visitorErrors429',
  'visitorRequests',
  'humanViews',
];
/** Mean over the ticks of the second. */
const MEAN_KEYS: Key[] = ['instances', 'inFlight', 'queue', 'cmsQueued'];
/** Max over the ticks of the second. */
const MAX_KEYS: Key[] = ['gcraDelayMs', 'queueWaitMs'];
/** Last value within the second. */
const LAST_KEYS: Key[] = ['revalidationsUsed', 'revalidationsRejected'];

const MONTH_SEC = 2_592_000;

function cmsLimitOf(s: Scenario): number {
  return s.cms.api === 'graphql' ? s.cms.graphql.limitRps : s.cms.cda.limitRps;
}

/**
 * Per-second series and summary KPIs (DESIGN 6.8).
 *
 * Usage per tick: `begin(timeSec)`, any number of `addRender` / `addVisitor`, then `record(sample)`.
 * Second index = floor(tick start time). Rates are the summed counts of the ticks that fall in the
 * second divided by their total duration, so they stay correct when dt does not divide 1 s.
 *
 * Derived columns: edgeRps is the sum of every edge stream including static assets; launchHitRatio
 * = (hits + stale hits) / requests over the Launch page + data layers only (bypassed classes are not
 * in its denominator; 0 if no layer requests); cmsCdnHitRatio likewise over the CMS CDN layers;
 * cmsOriginOffered = new origin fetches + other-org traffic (retries excluded), cmsOriginTotal
 * includes retries; visitorErrors = 5xx + 404 + 429 served to visitors.
 */
export class MetricsCollector {
  private readonly n: number;
  private readonly scenario: Scenario;
  private readonly acc = new Map<Key, Float64Array>();
  private readonly dur: Float64Array;
  private readonly tickCount: Float64Array;
  private readonly renderP50: Float32Array;
  private readonly renderP95: Float32Array;
  private readonly visitorP50: Float32Array;
  private readonly visitorP95: Float32Array;
  private readonly renderHist = new LatencyHistogram();
  private readonly visitorHist = new LatencyHistogram();
  private cur = 0;
  private curFlushed = false;
  private dt: number;

  // exact totals (counts) for the summary
  private tLaunch429 = 0;
  private tCms429 = 0;
  private t503 = 0;
  private t504 = 0;
  private tVisitorErrors = 0;
  private tVisitorRequests = 0;
  private tCmsCalls = 0;
  private tHumanViews = 0;

  private built: MetricsSeries | null = null;

  constructor(scenario: Scenario) {
    this.scenario = scenario;
    this.dt = scenario.sim.dtSec;
    this.n = Math.max(1, Math.ceil(scenario.sim.durationSec - 1e-9));
    for (const k of [...RATE_KEYS, ...MEAN_KEYS, ...MAX_KEYS, ...LAST_KEYS]) {
      this.acc.set(k, new Float64Array(this.n));
    }
    this.dur = new Float64Array(this.n);
    this.tickCount = new Float64Array(this.n);
    this.renderP50 = new Float32Array(this.n);
    this.renderP95 = new Float32Array(this.n);
    this.visitorP50 = new Float32Array(this.n);
    this.visitorP95 = new Float32Array(this.n);
  }

  private flushQuantiles(): void {
    if (this.curFlushed) return;
    const i = this.cur;
    if (this.renderHist.totalWeight() > 0) {
      this.renderP50[i] = this.renderHist.quantile(0.5);
      this.renderP95[i] = this.renderHist.quantile(0.95);
    }
    if (this.visitorHist.totalWeight() > 0) {
      this.visitorP50[i] = this.visitorHist.quantile(0.5);
      this.visitorP95[i] = this.visitorHist.quantile(0.95);
    }
    this.renderHist.reset();
    this.visitorHist.reset();
    this.curFlushed = true;
  }

  /** Start a tick at `timeSec`; rolls the per-second histograms over when the second changes. */
  begin(timeSec: number): void {
    const sec = Math.min(this.n - 1, Math.max(0, Math.floor(timeSec + 1e-9)));
    if (sec !== this.cur) {
      this.flushQuantiles();
      this.cur = sec;
      this.curFlushed = false;
    }
  }

  /** Service time of started renders (ms), weighted by count. */
  addRender(valueMs: number, weight: number): void {
    this.renderHist.add(valueMs, weight);
  }

  /** Visitor-perceived latency (ms), weighted by count. */
  addVisitor(valueMs: number, weight: number): void {
    this.visitorHist.add(valueMs, weight);
  }

  record(s: TickSample): void {
    const i = this.cur;
    this.dur[i] = this.dur[i]! + this.dt;
    this.tickCount[i] = this.tickCount[i]! + 1;
    for (const k of RATE_KEYS) {
      const a = this.acc.get(k)!;
      a[i] = a[i]! + s[k];
    }
    for (const k of MEAN_KEYS) {
      const a = this.acc.get(k)!;
      a[i] = a[i]! + s[k];
    }
    for (const k of MAX_KEYS) {
      const a = this.acc.get(k)!;
      if (s[k] > a[i]!) a[i] = s[k];
    }
    for (const k of LAST_KEYS) this.acc.get(k)![i] = s[k];
    this.tLaunch429 += s.launch429;
    this.tCms429 += s.cms429;
    this.t503 += s.c503;
    this.t504 += s.c504;
    this.tVisitorErrors += s.visitorErrors5xx + s.visitorErrors404 + s.visitorErrors429;
    this.tVisitorRequests += s.visitorRequests;
    this.tCmsCalls += s.cmsCalls;
    this.tHumanViews += s.humanViews;
    this.built = null;
  }

  series(): MetricsSeries {
    if (this.built) return this.built;
    this.flushQuantiles();
    const n = this.n;
    const cols: Record<string, Float32Array> = {};
    const col = (name: string) => (cols[name] = new Float32Array(n));
    const rate = (k: Key): Float64Array => {
      const a = this.acc.get(k)!;
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = this.dur[i]! > 0 ? a[i]! / this.dur[i]! : 0;
      return out;
    };
    const mean = (k: Key): Float64Array => {
      const a = this.acc.get(k)!;
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = this.tickCount[i]! > 0 ? a[i]! / this.tickCount[i]! : 0;
      return out;
    };
    const put = (name: string, v: ArrayLike<number>) => {
      const c = col(name);
      for (let i = 0; i < n; i++) c[i] = v[i]!;
    };
    const ratio = (num: Float64Array, den: Float64Array) => {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = den[i]! > 0 ? num[i]! / den[i]! : 0;
      return out;
    };

    put('edgeRps', rate('edgeTotal'));
    put('edgePageRps', rate('edgePage'));
    put('edgeDataRps', rate('edgeData'));
    put('edgeBotRps', rate('edgeBot'));
    put('staticRps', rate('edgeStatic'));
    put('humanViewsRps', rate('humanViews'));
    put('launchHitRatio', ratio(rate('launchHits'), rate('launchReq')));
    put('launchOriginOffered', rate('launchOffered'));
    put('launchOriginAccepted', rate('launchAccepted'));
    put('launch429', rate('launch429'));
    put('launchLimit', new Float64Array(n).fill(this.scenario.launch.originLimitRps));
    put('instances', mean('instances'));
    put('inFlight', mean('inFlight'));
    put('queue', mean('queue'));
    put('queueWaitMs', this.acc.get('queueWaitMs')!);
    put('c503', rate('c503'));
    put('c504', rate('c504'));
    put('renderP50', this.renderP50);
    put('renderP95', this.renderP95);
    put('visitorP50', this.visitorP50);
    put('visitorP95', this.visitorP95);
    put('cmsCalls', rate('cmsCalls'));
    put('cmsCdnHitRatio', ratio(rate('cmsHits'), rate('cmsReq')));
    const offNew = rate('cmsOfferedNew');
    const offOther = rate('cmsOfferedOther');
    const offered = new Float64Array(n);
    for (let i = 0; i < n; i++) offered[i] = offNew[i]! + offOther[i]!;
    put('cmsOriginOffered', offered);
    put('cmsOriginTotal', rate('cmsTotal'));
    put('cmsOriginAccepted', rate('cmsAccepted'));
    put('cmsQueued', mean('cmsQueued'));
    put('cms429', rate('cms429'));
    put('cmsRetries', rate('cmsRetries'));
    put('cmsFinalFailures', rate('cmsFinal'));
    put('cmsLimit', new Float64Array(n).fill(cmsLimitOf(this.scenario)));
    put('gcraDelayMs', this.acc.get('gcraDelayMs')!);
    put('otherOrgRps', rate('otherOrg'));
    const e5 = rate('visitorErrors5xx');
    const e4 = rate('visitorErrors404');
    const e2 = rate('visitorErrors429');
    const all = new Float64Array(n);
    for (let i = 0; i < n; i++) all[i] = e5[i]! + e4[i]! + e2[i]!;
    put('visitorErrors', all);
    put('visitorErrors5xx', e5);
    put('visitorErrors404', e4);
    put('visitorErrors429', e2);
    put('visitorRequests', rate('visitorRequests'));
    put('revalidationsUsed', this.acc.get('revalidationsUsed')!);
    put('revalidationsRejected', this.acc.get('revalidationsRejected')!);

    this.built = { length: n, columns: cols };
    return this.built;
  }

  /**
   * Summary KPIs. Definitions: peaks are maxima over per-second rates; `secondsOverLaunchLimit` =
   * seconds with launchOriginOffered > launchLimit; `secondsWithCms429` = seconds with cms429 > 0.5;
   * `visitorErrorRate` = sum(visitorErrors) / sum(visitorRequests) (dynamic requests, no static
   * assets, 429s included); `cmsCallsPerPageView` = sum(cmsCalls) / sum(human page views), where
   * human page views = human HTML page requests (excluding bots and non-busting load tests, which
   * are counted as bot-like traffic) + client-side navigations; `suggestedCmsLimitRps` =
   * ceil(1.2 x peak offered); projected monthly calls: cached = mean(cmsCalls - new origin offered)
   * x 2,592,000 (calls answered by the CMS CDN), uncached = mean(cmsOriginAccepted) x 2,592,000.
   * `bottleneck` is the layer with the earliest failure second (launchOrigin: launch429 > 0.5;
   * compute: c503 > 0.5 or estimated queue wait above the timeout; cmsOrigin: cms429 > 0.5;
   * timeout: c504 > 0.5); ties resolve in that order.
   */
  summary(): SummaryKpis {
    const { columns: c, length: n } = this.series();
    const col = (name: string) => c[name]!;
    const max = (a: Float32Array) => {
      let m = 0;
      for (let i = 0; i < a.length; i++) if (a[i]! > m) m = a[i]!;
      return m;
    };
    const mean = (a: ArrayLike<number>) => {
      let s = 0;
      for (let i = 0; i < n; i++) s += a[i]!;
      return n > 0 ? s / n : 0;
    };
    const launchOffered = col('launchOriginOffered');
    const launchLimit = this.scenario.launch.originLimitRps;
    const cmsLimit = cmsLimitOf(this.scenario);
    const cmsOffered = col('cmsOriginOffered');
    const cmsCalls = col('cmsCalls');
    const otherOrg = col('otherOrgRps');
    const cmsAccepted = col('cmsOriginAccepted');
    const l429 = col('launch429');
    const cms429 = col('cms429');
    const c503 = col('c503');
    const c504 = col('c504');
    const qWait = col('queueWaitMs');
    const vp95 = col('visitorP95');

    let overLimit = 0;
    let secCms429 = 0;
    const cachedRate = new Float64Array(n);
    const first = { launchOrigin: -1, compute: -1, cmsOrigin: -1, timeout: -1 };
    const timeoutMs = this.scenario.launch.compute.timeoutSec * 1000;
    for (let i = 0; i < n; i++) {
      if (launchOffered[i]! > launchLimit + 1e-6) overLimit++;
      if (cms429[i]! > 0.5) secCms429++;
      cachedRate[i] = Math.max(0, cmsCalls[i]! - Math.max(0, cmsOffered[i]! - otherOrg[i]!));
      if (first.launchOrigin < 0 && l429[i]! > 0.5) first.launchOrigin = i;
      if (first.compute < 0 && (c503[i]! > 0.5 || qWait[i]! > timeoutMs)) first.compute = i;
      if (first.cmsOrigin < 0 && cms429[i]! > 0.5) first.cmsOrigin = i;
      if (first.timeout < 0 && c504[i]! > 0.5) first.timeout = i;
    }
    let bottleneck: SummaryKpis['bottleneck'] = 'none';
    let best = Infinity;
    for (const k of ['launchOrigin', 'compute', 'cmsOrigin', 'timeout'] as const) {
      if (first[k] >= 0 && first[k] < best) {
        best = first[k];
        bottleneck = k;
      }
    }

    const peakLaunch = max(launchOffered);
    const peakCms = max(cmsOffered);
    return {
      peakLaunchOriginRps: peakLaunch,
      peakLaunchOriginPctOfLimit: launchLimit > 0 ? (100 * peakLaunch) / launchLimit : 0,
      secondsOverLaunchLimit: overLimit,
      peakCmsOriginOfferedRps: peakCms,
      peakCmsOriginPctOfLimit: cmsLimit > 0 ? (100 * peakCms) / cmsLimit : 0,
      secondsWithCms429: secCms429,
      totalLaunch429: this.tLaunch429,
      totalCms429: this.tCms429,
      total504: this.t504,
      total503: this.t503,
      errorPagesServed: this.tVisitorErrors,
      visitorErrorRate: this.tVisitorRequests > 0 ? this.tVisitorErrors / this.tVisitorRequests : 0,
      worstSecondVisitorP95Ms: max(vp95),
      cmsCallsPerPageView: this.tHumanViews > 0 ? this.tCmsCalls / this.tHumanViews : 0,
      suggestedCmsLimitRps: Math.ceil(peakCms * 1.2),
      projectedMonthlyApiCalls: {
        cached: mean(cachedRate) * MONTH_SEC,
        uncached: mean(cmsAccepted) * MONTH_SEC,
      },
      bottleneck,
    };
  }
}
