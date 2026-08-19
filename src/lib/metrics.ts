import type { ChartPoint } from '../components/charts/TimeSeriesChart';
import type { Health, MetricRow } from '../api/types';

/** Pull one alias out of metric rows as chart points (epoch-seconds → ms). */
export function toPoints(rows: MetricRow[], alias: string): ChartPoint[] {
  return rows.map((r) => ({
    t: Number(r.starttime) * 1000,
    v: Number(r[alias] ?? 0),
  }));
}

/** Sum one alias across all rows. */
export function sumAlias(rows: MetricRow[], alias: string): number {
  return rows.reduce((acc, r) => acc + Number(r[alias] ?? 0), 0);
}

/** Sum one alias across multiple split entities (e.g. every route) into a single time series, one point per bucket. */
export function sumPointsByBucket(rows: MetricRow[], alias: string): ChartPoint[] {
  const byBucket = new Map<number, number>();
  for (const r of rows) {
    const t = Number(r.starttime) * 1000;
    byBucket.set(t, (byBucket.get(t) ?? 0) + Number(r[alias] ?? 0));
  }
  return [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
}

export interface SplitSeries {
  id: string;
  points: ChartPoint[];
}

/**
 * Reshape time-bucket rows split by one dimension (e.g. `output`, `input`,
 * `cribl_wp`) into one aligned time series per distinct id — every series
 * shares the same bucket set, missing values fill as 0.
 *
 * Metric dimensions come formatted `<type>:<id>` (e.g. `splunk:AIO_Splunk`);
 * the type prefix is stripped so ids line up with the plain ids used
 * elsewhere (status API, chip filters).
 *
 * `include` restricts to a specific id set (a user filter); otherwise the
 * top `limit` ids by total value are kept, so the fixed 8-slot categorical
 * palette is never exceeded — the remainder is dropped, not folded into an
 * "Other" bucket, matching the Splunk dashboard's `useother=false`.
 */
export function splitToSeries(
  rows: MetricRow[],
  dim: string,
  alias: string,
  opts: { include?: string[]; limit?: number } = {},
): SplitSeries[] {
  const times = [...new Set(rows.map((r) => Number(r.starttime)))].sort((a, b) => a - b);
  const byId = new Map<string, Map<number, number>>();
  const totals = new Map<string, number>();

  for (const r of rows) {
    const raw = (r[dim] as string) ?? '';
    if (!raw) continue;
    const id = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
    const t = Number(r.starttime);
    const v = Number(r[alias] ?? 0);
    if (!byId.has(id)) byId.set(id, new Map());
    const bucket = byId.get(id)!;
    bucket.set(t, (bucket.get(t) ?? 0) + v);
    totals.set(id, (totals.get(id) ?? 0) + v);
  }

  let ids = [...byId.keys()].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
  if (opts.include && opts.include.length > 0) {
    const wanted = new Set(opts.include);
    ids = ids.filter((id) => wanted.has(id));
  } else if (opts.limit) {
    ids = ids.slice(0, opts.limit);
  }

  return ids.map((id) => ({
    id,
    points: times.map((t) => ({ t: t * 1000, v: byId.get(id)!.get(t) ?? 0 })),
  }));
}

/**
 * Least-squares linear trend over (t ms, v) points. Returns the slope per day
 * and a predictor, or null with fewer than 2 points. Used to project daily
 * license usage toward the quota.
 */
export function linearTrend(
  points: ChartPoint[],
): { slopePerDay: number; at: (tMs: number) => number } | null {
  if (points.length < 2) return null;
  const DAY = 86_400_000;
  const t0 = points[0].t;
  const xs = points.map((p) => (p.t - t0) / DAY);
  const ys = points.map((p) => p.v);
  const n = points.length;
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (ys[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  if (den === 0) return null;
  const slope = num / den;
  const intercept = yMean - slope * xMean;
  return {
    slopePerDay: slope,
    at: (tMs: number) => intercept + slope * ((tMs - t0) / DAY),
  };
}

/** Normalize a Cribl health string to our union. */
export function normHealth(h: string | undefined): Health {
  if (h === 'Green' || h === 'Yellow' || h === 'Red') return h;
  return 'Unknown';
}

export interface HealthCounts {
  Green: number;
  Yellow: number;
  Red: number;
  Unknown: number;
  total: number;
}

export function countHealth(healths: (string | undefined)[]): HealthCounts {
  const c: HealthCounts = { Green: 0, Yellow: 0, Red: 0, Unknown: 0, total: 0 };
  for (const h of healths) {
    c[normHealth(h)]++;
    c.total++;
  }
  return c;
}
