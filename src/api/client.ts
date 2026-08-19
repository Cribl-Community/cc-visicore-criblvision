// Cribl API client. Uses the platform fetch proxy (window.CRIBL_API_URL) when
// running inside Cribl; falls back to captured fixtures for standalone demo/dev.
import type {
  CollectionJob,
  CriblNotification,
  Group,
  IOStatus,
  JobError,
  LicenseUsageDay,
  MetricRow,
  NotificationTarget,
  SystemInfo,
  SystemMessage,
  WorkerNode,
} from './types';

export interface CriblUser {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  initials?: string;
}

declare global {
  interface Window {
    CRIBL_API_URL?: string;
    CRIBL_BASE_PATH?: string;
    getCriblUser?: () => Promise<CriblUser>;
  }
}

/** Signed-in Cribl user, or null in demo mode / on failure. */
export async function getCurrentUser(): Promise<CriblUser | null> {
  if (typeof window === 'undefined' || !window.getCriblUser) return null;
  try {
    return await window.getCriblUser();
  } catch {
    return null;
  }
}

const API_URL = (typeof window !== 'undefined' && window.CRIBL_API_URL) || '';

/** True when no live Cribl API is available and the app renders captured demo data. */
export const IS_DEMO = !API_URL;

/** Cribl UI origin (derived from the API URL), e.g. https://tenant.cribl.cloud. */
export const CRIBL_ORIGIN = API_URL.replace(/\/api\/v1\/?$/, '');

/**
 * Deep link to a Source, Destination, or the Data Routes page in the Cribl
 * Stream UI for a group. Absolute URL so it works from inside the app's
 * sandboxed iframe with target="_top". Returns '' in demo mode (no live origin).
 */
export function streamLink(
  kind: 'source' | 'destination' | 'route' | 'pipeline' | 'job' | 'notification',
  group: string,
): string {
  if (!CRIBL_ORIGIN) return '';
  const seg =
    kind === 'source'
      ? 'inputs'
      : kind === 'destination'
        ? 'outputs'
        : kind === 'route'
          ? 'routes'
          : kind === 'pipeline'
            ? 'pipelines'
            : kind === 'job'
              ? 'jobs'
              : 'notifications';
  return `${CRIBL_ORIGIN}/stream/m/${group}/${seg}`;
}

const IN_OUT_AGGS = [
  'sum("total.in_events").as("eventsIn")',
  'sum("total.out_events").as("eventsOut")',
  'sum("total.in_bytes").as("bytesIn")',
  'sum("total.out_bytes").as("bytesOut")',
];

// ---------------------------------------------------------------------------
// Low-level transport
// ---------------------------------------------------------------------------

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} → ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'DELETE',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`DELETE ${path} → ${res.status} ${res.statusText}`);
}

interface Fixtures {
  capturedAt: number;
  groups: { items: Group[] };
  workers: { items: WorkerNode[] };
  systemInfo: { items: SystemInfo[] };
  health: unknown;
  licenseUsage: { items: LicenseUsageDay[] };
  throughputAll: MetricRow[];
  droppedAll: MetricRow[];
  byGroup: MetricRow[];
  topSourcesDefault: MetricRow[];
  topDestsDefault: MetricRow[];
  statusInputs: Record<string, { items?: IOStatus[] }>;
  statusOutputs: Record<string, { items?: IOStatus[] }>;
  messages: { items: SystemMessage[] };
}

let fixturesPromise: Promise<Fixtures> | null = null;
function fixtures(): Promise<Fixtures> {
  if (!fixturesPromise) {
    fixturesPromise = fetch(`${import.meta.env.BASE_URL}fixtures.json`).then((r) => {
      if (!r.ok) throw new Error('Unable to load demo fixtures');
      return r.json() as Promise<Fixtures>;
    });
  }
  return fixturesPromise;
}

// ---------------------------------------------------------------------------
// Metric query
// ---------------------------------------------------------------------------

export interface MetricQuery {
  where: string;
  aggregations: string[];
  splitBys?: string[];
  timeWindowSeconds: number; // -1 = natural buckets, N = N-second buckets
  earliestSeconds: number;
}

function whereForGroup(group: string | 'all'): string {
  if (group === 'all') return '((__dist_mode=="worker") || (__dist_mode=="managed-edge"))';
  return `(__worker_group=="${group}")`;
}

async function runQuery(q: MetricQuery): Promise<MetricRow[]> {
  const body: Record<string, unknown> = {
    where: q.where,
    aggs: {
      aggregations: q.aggregations,
      timeWindowSeconds: q.timeWindowSeconds,
      ...(q.splitBys ? { splitBys: q.splitBys } : {}),
    },
    earliest: `${q.earliestSeconds}s`,
    latest: Date.now(),
  };
  const res = await apiPost<{ results?: MetricRow[] }>('/system/metrics/query', body);
  return res.results ?? [];
}

// ---------------------------------------------------------------------------
// High-level, semantic data access (each has a demo fallback)
// ---------------------------------------------------------------------------

export async function getGroups(): Promise<Group[]> {
  if (IS_DEMO) return (await fixtures()).groups.items;
  return (await apiGet<{ items: Group[] }>('/master/groups')).items;
}

export async function getWorkers(): Promise<WorkerNode[]> {
  if (IS_DEMO) return (await fixtures()).workers.items;
  return (await apiGet<{ items: WorkerNode[] }>('/master/workers')).items;
}

export async function getSystemInfo(): Promise<SystemInfo | null> {
  if (IS_DEMO) return (await fixtures()).systemInfo.items[0] ?? null;
  const r = await apiGet<{ items: SystemInfo[] }>('/system/info');
  return r.items[0] ?? null;
}

/** System notifications — errors, warnings, info (failed inits, zero-volume routes, etc). */
export async function getMessages(): Promise<SystemMessage[]> {
  if (IS_DEMO) return (await fixtures()).messages.items;
  return (await apiGet<{ items: SystemMessage[] }>('/system/messages')).items ?? [];
}

export async function getLicenseUsage(): Promise<LicenseUsageDay[]> {
  if (IS_DEMO) return (await fixtures()).licenseUsage.items;
  return (await apiGet<{ items: LicenseUsageDay[] }>('/system/licenses/usage')).items;
}

interface ConfigIOItem {
  id: string;
  type: string;
  disabled?: boolean | null;
  status?: IOStatus['status'];
}

// The Source/Destination config endpoints (/system/inputs, /system/outputs) carry
// the authoritative runtime health in each item's `status.health`. The
// /system/status/* endpoints report "loaded" state and show everything Green, so
// we deliberately use the config endpoints and drop disabled items (not running).
async function fetchConfigStatus(path: string): Promise<IOStatus[]> {
  const r = await apiGet<{ items: ConfigIOItem[] }>(path);
  return (r.items ?? [])
    .filter((i) => !i.disabled)
    .map((i) => ({ id: i.id, type: i.type, status: i.status ?? {} }));
}

export async function getInputStatus(group: string): Promise<IOStatus[]> {
  if (IS_DEMO) return (await fixtures()).statusInputs[group]?.items ?? [];
  return fetchConfigStatus(`/m/${group}/system/inputs`);
}

export async function getOutputStatus(group: string): Promise<IOStatus[]> {
  if (IS_DEMO) return (await fixtures()).statusOutputs[group]?.items ?? [];
  return fetchConfigStatus(`/m/${group}/system/outputs`);
}

export type IOStatusWithGroup = IOStatus & { group: string };

function tag(items: IOStatus[], group: string): IOStatusWithGroup[] {
  return items.map((i) => ({ ...i, group }));
}

/** Source status across several groups, each tagged with its group. */
export async function getInputStatuses(groupIds: string[]): Promise<IOStatusWithGroup[]> {
  const all = await Promise.all(
    groupIds.map((g) => getInputStatus(g).then((items) => tag(items, g)).catch(() => [])),
  );
  return all.flat();
}

/** Destination status across several groups, each tagged with its group. */
export async function getOutputStatuses(groupIds: string[]): Promise<IOStatusWithGroup[]> {
  const all = await Promise.all(
    groupIds.map((g) => getOutputStatus(g).then((items) => tag(items, g)).catch(() => [])),
  );
  return all.flat();
}

/** Throughput (events + bytes in/out) time series for a group or all groups. */
export async function getThroughputSeries(
  group: string | 'all',
  rangeSeconds: number,
  bucketSeconds: number,
): Promise<MetricRow[]> {
  if (IS_DEMO) return (await fixtures()).throughputAll;
  return runQuery({
    where: `(has_no_dimensions) && ${whereForGroup(group)}`,
    aggregations: IN_OUT_AGGS,
    timeWindowSeconds: bucketSeconds,
    earliestSeconds: rangeSeconds,
  });
}

/** Dropped-events time series for a group or all worker groups. */
export async function getDroppedSeries(
  group: string | 'all',
  rangeSeconds: number,
  bucketSeconds: number,
): Promise<MetricRow[]> {
  if (IS_DEMO) return (await fixtures()).droppedAll;
  const where =
    group === 'all'
      ? '(has_no_dimensions) && (__dist_mode=="worker")'
      : `(has_no_dimensions) && (__worker_group=="${group}")`;
  return runQuery({
    where,
    aggregations: ['sum("total.dropped_events").as("dropped")'],
    timeWindowSeconds: bucketSeconds,
    earliestSeconds: rangeSeconds,
  });
}

/** Per-worker-group throughput totals over the last 24h (split by group). */
export async function getGroupTotals(rangeSeconds: number): Promise<MetricRow[]> {
  if (IS_DEMO) return (await fixtures()).byGroup;
  return runQuery({
    where: '(has_no_dimensions)',
    aggregations: IN_OUT_AGGS,
    splitBys: ['__worker_group'],
    timeWindowSeconds: -1,
    earliestSeconds: rangeSeconds,
  });
}

// ---------------------------------------------------------------------------
// Thruput introspection — per-destination, per-source/worker-process series
// ---------------------------------------------------------------------------

function demoSeededJitter(seed: string, end: number): number {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 997;
  return 0.75 + 0.5 * Math.abs(Math.sin(end / 977 + h));
}

/** Synthetic per-bucket rows split by `dim`, one ramping rate per id. */
function demoSplitRows(
  ids: string[],
  dim: string,
  rangeSeconds: number,
  bucketSeconds: number,
  perSecBase: number,
  alias: string,
): MetricRow[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows: MetricRow[] = [];
  ids.forEach((id, idx) => {
    const rate = perSecBase * (0.35 + ((idx + 1) / ids.length) * 0.9);
    for (let end = nowSec; end > nowSec - rangeSeconds; end -= bucketSeconds) {
      const v = Math.max(0, Math.round(rate * bucketSeconds * demoSeededJitter(id, end)));
      rows.push({ starttime: end - bucketSeconds, endtime: end, [dim]: id, [alias]: v });
    }
  });
  return rows;
}

async function demoIds(dim: 'input' | 'output'): Promise<string[]> {
  const f = await fixtures();
  const rows = dim === 'input' ? f.topSourcesDefault : f.topDestsDefault;
  return [...new Set(rows.map((r) => String(r[dim] ?? '')))].filter(Boolean);
}

/** Events-out time series split by destination (output). */
export async function getOutEventsByOutput(
  group: string | 'all',
  rangeSeconds: number,
  bucketSeconds: number,
): Promise<MetricRow[]> {
  if (IS_DEMO) return demoSplitRows(await demoIds('output'), 'output', rangeSeconds, bucketSeconds, 40, 'events');
  return runQuery({
    where: whereForTop(group),
    aggregations: ['sum("total.out_events").as("events")'],
    splitBys: ['output'],
    timeWindowSeconds: bucketSeconds,
    earliestSeconds: rangeSeconds,
  });
}

/** Bytes-out time series split by destination (output). */
export async function getOutBytesByOutput(
  group: string | 'all',
  rangeSeconds: number,
  bucketSeconds: number,
): Promise<MetricRow[]> {
  if (IS_DEMO) return demoSplitRows(await demoIds('output'), 'output', rangeSeconds, bucketSeconds, 55_000, 'bytes');
  return runQuery({
    where: whereForTop(group),
    aggregations: ['sum("total.out_bytes").as("bytes")'],
    splitBys: ['output'],
    timeWindowSeconds: bucketSeconds,
    earliestSeconds: rangeSeconds,
  });
}

export type InSplitBy = 'input' | 'cribl_wp';

/** Events-in time series split by source (input). */
export async function getInEventsByInput(
  group: string | 'all',
  rangeSeconds: number,
  bucketSeconds: number,
): Promise<MetricRow[]> {
  if (IS_DEMO) return demoSplitRows(await demoIds('input'), 'input', rangeSeconds, bucketSeconds, 35, 'events');
  return runQuery({
    where: whereForTop(group),
    aggregations: ['sum("total.in_events").as("events")'],
    splitBys: ['input'],
    timeWindowSeconds: bucketSeconds,
    earliestSeconds: rangeSeconds,
  });
}

/** Bytes-in time series split by source (input). */
export async function getInBytesByInput(
  group: string | 'all',
  rangeSeconds: number,
  bucketSeconds: number,
): Promise<MetricRow[]> {
  if (IS_DEMO) return demoSplitRows(await demoIds('input'), 'input', rangeSeconds, bucketSeconds, 48_000, 'bytes');
  return runQuery({
    where: whereForTop(group),
    aggregations: ['sum("total.in_bytes").as("bytes")'],
    splitBys: ['input'],
    timeWindowSeconds: bucketSeconds,
    earliestSeconds: rangeSeconds,
  });
}

// `cribl_wp` is NOT a dimension on the aggregate `/system/metrics/query`
// endpoint's `total.*`/`system.*` measurements (confirmed live — a
// splitBys:['cribl_wp'] query silently returns unsplit rows with no
// `cribl_wp` key at all). Per-worker-process metrics instead live behind the
// per-node endpoint's `wp` query param ("Worker Process index to query.
// Supported only on Worker Nodes" — see openapi.json `/system/metrics`), so
// this has to be one call per process index against one specific node,
// mirroring `getNodeMetrics`.
const MAX_WORKER_PROCESSES = 24;

async function fetchWorkerProcessRow(nodeId: string, wp: number, rangeSeconds: number): Promise<MetricRow[]> {
  const now = Math.floor(Date.now() / 1000);
  const res = await apiGet<{ results?: { metrics?: RawNodeEntry[] } }>(
    `/w/${encodeURIComponent(nodeId)}/system/metrics?wp=${wp}&earliest=${now - rangeSeconds}&latest=${now}`,
  );
  const entries = res.results?.metrics ?? [];
  const rows: MetricRow[] = [];
  for (const e of entries) {
    const t = entryVal(e, '_time');
    if (t == null) continue;
    rows.push({
      starttime: t,
      endtime: t,
      cribl_wp: `w${wp}`,
      events: entryVal(e, 'total.in_events') ?? 0,
      bytes: entryVal(e, 'total.in_bytes') ?? 0,
      cpu: entryVal(e, 'system.cpu_perc') ?? 0,
    });
  }
  return rows;
}

function demoWorkerProcessRows(wpCount: number, rangeSeconds: number, bucketSeconds: number): MetricRow[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows: MetricRow[] = [];
  for (let wp = 0; wp < wpCount; wp++) {
    const id = `w${wp}`;
    let h = 0;
    for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 997;
    const evRate = 35 * (0.35 + ((wp + 1) / wpCount) * 0.9);
    const cpuBase = 12 + (h % 40) + wp * 3;
    for (let end = nowSec; end > nowSec - rangeSeconds; end -= bucketSeconds) {
      const jitter = demoSeededJitter(id, end);
      const wave = Math.sin(end / 1800 + h) * 9 + Math.sin(end / 300 + h * 2) * 4;
      const events = Math.max(0, Math.round(evRate * bucketSeconds * jitter));
      rows.push({
        starttime: end,
        endtime: end,
        cribl_wp: id,
        events,
        bytes: Math.round(events * 1400),
        cpu: Math.min(99, Math.max(1, cpuBase + wave)),
      });
    }
  }
  return rows;
}

/**
 * Per-worker-process rows (events-in, bytes-in, CPU%) for one node's worker
 * processes — surfaces uneven load across processes (one pinned near 100%
 * CPU/events while its siblings idle is the classic TCP-pinning signature).
 * Node-scoped because `wp` is a per-node process index, not a cluster-wide id.
 */
export async function getWorkerProcessRows(
  nodeId: string,
  wpCount: number,
  rangeSeconds: number,
  bucketSeconds: number,
): Promise<MetricRow[]> {
  const count = Math.min(MAX_WORKER_PROCESSES, Math.max(1, wpCount));
  if (IS_DEMO) return demoWorkerProcessRows(count, rangeSeconds, bucketSeconds);
  const rows = await Promise.all(
    Array.from({ length: count }, (_, wp) => fetchWorkerProcessRow(nodeId, wp, rangeSeconds)),
  );
  return rows.flat();
}

// ---------------------------------------------------------------------------
// Destination backpressure & persistent queues
// ---------------------------------------------------------------------------

export interface OutputPQStat {
  /** Bare output id (type prefix stripped, matching the status API ids). */
  id: string;
  group: string;
  /** Persistent-queue size (bytes) in the most recent bucket that reported. */
  pqBytes: number;
  /** Peak persistent-queue size (bytes) across the window. */
  pqPeakBytes: number;
  /** Backpressure engaged in the most recent bucket that reported. */
  backpressureNow: boolean;
  /** Number of time buckets in the window where backpressure was engaged. */
  backpressureBuckets: number;
}

// Demo backpressure/PQ profiles keyed by `${group}::${outputId}` — one output
// currently backpressured with a deep PQ, one that recovered earlier.
const DEMO_PQ: Record<string, { pqBytes: number; peak: number; now: boolean; buckets: number }> = {
  'default::AIO_Splunk': { pqBytes: 3.2 * 1024 ** 3, peak: 4.1 * 1024 ** 3, now: true, buckets: 9 },
  'defaultHybrid::archive-lake': { pqBytes: 0, peak: 1.4 * 1024 ** 3, now: false, buckets: 3 },
};

// Source-side PQ demo: one source spooling to disk while its pipeline backs up.
const DEMO_PQ_SOURCES: Record<string, { pqBytes: number; peak: number; now: boolean; buckets: number }> = {
  'default::in_syslog_tls': { pqBytes: 640 * 1024 ** 2, peak: 1.1 * 1024 ** 3, now: true, buckets: 5 },
};

function demoPQStatsFrom(
  table: Record<string, { pqBytes: number; peak: number; now: boolean; buckets: number }>,
  group: string | 'all',
): OutputPQStat[] {
  return Object.entries(table)
    .map(([key, v]) => {
      const [g, id] = key.split('::');
      return {
        id,
        group: g,
        pqBytes: v.pqBytes,
        pqPeakBytes: v.peak,
        backpressureNow: v.now,
        backpressureBuckets: v.buckets,
      };
    })
    .filter((s) => group === 'all' || s.group === group);
}

/**
 * Per-source/destination backpressure + persistent-queue depth over the window.
 * `pq.queue_size` is a gauge (bytes) dimensioned by input or output;
 * `backpressure.outputs` / `backpressure.inputs` is non-zero while engaged.
 */
async function getPQStatsByDim(
  dim: 'input' | 'output',
  group: string | 'all',
  rangeSeconds: number,
  bucketSeconds: number,
): Promise<OutputPQStat[]> {
  const rows = await runQuery({
    where: whereForTop(group),
    aggregations: [
      'max("pq.queue_size").as("pqBytes")',
      `max("backpressure.${dim}s").as("bp")`,
    ],
    splitBys: [dim, '__worker_group'],
    timeWindowSeconds: bucketSeconds,
    earliestSeconds: rangeSeconds,
  });

  interface Acc {
    id: string;
    group: string;
    latestTime: number;
    latestPQ: number;
    latestBP: number;
    peak: number;
    bpBuckets: number;
  }
  const acc = new Map<string, Acc>();
  for (const r of rows) {
    const raw = typeof r[dim] === 'string' ? (r[dim] as string) : '';
    if (!raw) continue;
    const id = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
    const grp = typeof r.__worker_group === 'string' ? r.__worker_group : '(unknown)';
    const key = `${grp}::${id}`;
    const pq = Number(r.pqBytes ?? 0);
    const bp = Number(r.bp ?? 0);
    const end = Number(r.endtime ?? 0);

    let a = acc.get(key);
    if (!a) {
      a = { id, group: grp, latestTime: 0, latestPQ: 0, latestBP: 0, peak: 0, bpBuckets: 0 };
      acc.set(key, a);
    }
    a.peak = Math.max(a.peak, pq);
    if (bp > 0) a.bpBuckets++;
    if (end >= a.latestTime) {
      a.latestTime = end;
      a.latestPQ = pq;
      a.latestBP = bp;
    }
  }

  return [...acc.values()].map((a) => ({
    id: a.id,
    group: a.group,
    pqBytes: a.latestPQ,
    pqPeakBytes: a.peak,
    backpressureNow: a.latestBP > 0,
    backpressureBuckets: a.bpBuckets,
  }));
}

/** Destination-side PQ depth + backpressure over the window. */
export async function getOutputPQStats(
  group: string | 'all',
  rangeSeconds: number,
  bucketSeconds: number,
): Promise<OutputPQStat[]> {
  if (IS_DEMO) return demoPQStatsFrom(DEMO_PQ, group);
  return getPQStatsByDim('output', group, rangeSeconds, bucketSeconds);
}

/** Source-side PQ depth + backpressure over the window. */
export async function getInputPQStats(
  group: string | 'all',
  rangeSeconds: number,
  bucketSeconds: number,
): Promise<OutputPQStat[]> {
  if (IS_DEMO) return demoPQStatsFrom(DEMO_PQ_SOURCES, group);
  return getPQStatsByDim('input', group, rangeSeconds, bucketSeconds);
}

// Demo PQ-size-over-time profiles: the backpressured entry ramps up toward
// its peak (the "PQ growing = destination can't keep up" signal this
// dashboard exists to catch); the recovered one decays back toward zero.
function demoPQSeries(
  dim: 'input' | 'output',
  group: string | 'all',
  rangeSeconds: number,
  bucketSeconds: number,
): MetricRow[] {
  const table = dim === 'output' ? DEMO_PQ : DEMO_PQ_SOURCES;
  const entries = Object.entries(table).filter(([key]) => group === 'all' || key.startsWith(`${group}::`));
  const nowSec = Math.floor(Date.now() / 1000);
  const rows: MetricRow[] = [];
  for (const [key, v] of entries) {
    const [g, id] = key.split('::');
    for (let end = nowSec; end > nowSec - rangeSeconds; end -= bucketSeconds) {
      const frac = 1 - (nowSec - end) / rangeSeconds; // 0 at window start -> 1 now
      const val = v.now ? v.peak * Math.min(1, frac * 1.15) : v.peak * Math.max(0, 1 - frac * 1.4);
      rows.push({ starttime: end - bucketSeconds, endtime: end, [dim]: id, __worker_group: g, pqBytes: Math.max(0, val) });
    }
  }
  return rows;
}

/** Raw per-bucket PQ-size rows split by input or output, for the size-over-time chart. */
export async function getPQSeriesByDim(
  dim: 'input' | 'output',
  group: string | 'all',
  rangeSeconds: number,
  bucketSeconds: number,
): Promise<MetricRow[]> {
  if (IS_DEMO) return demoPQSeries(dim, group, rangeSeconds, bucketSeconds);
  return runQuery({
    where: whereForTop(group),
    aggregations: ['max("pq.queue_size").as("pqBytes")'],
    splitBys: [dim, '__worker_group'],
    timeWindowSeconds: bucketSeconds,
    earliestSeconds: rangeSeconds,
  });
}

// ---------------------------------------------------------------------------
// Per-node system metrics (CPU / memory sparklines)
// ---------------------------------------------------------------------------

export interface NodePoint {
  /** Sample time, epoch ms. */
  t: number;
  /** CPU utilization percent (0-100), if reported. */
  cpu: number | null;
  /** Memory used percent (0-100), if reported. */
  memPct: number | null;
}

/** One sample entry from GET /w/:id/system/metrics — metric name → samples. */
type RawNodeEntry = Record<string, { model?: unknown; val?: number }[] | undefined>;

function entryVal(e: RawNodeEntry, key: string): number | null {
  const arr = e[key];
  const v = Array.isArray(arr) && arr.length > 0 ? arr[0]?.val : undefined;
  return typeof v === 'number' ? v : null;
}

function demoNodePoints(nodeId: string, rangeSeconds: number): NodePoint[] {
  // Deterministic per node: hash the id into a base load profile.
  let h = 0;
  for (const c of nodeId) h = (h * 31 + c.charCodeAt(0)) % 997;
  const baseCpu = 12 + (h % 45);
  const baseMem = 35 + (h % 40);
  const nowSec = Math.floor(Date.now() / 1000);
  const stepSec = Math.max(60, Math.floor(rangeSeconds / 48));
  const out: NodePoint[] = [];
  for (let t = nowSec - rangeSeconds; t <= nowSec; t += stepSec) {
    const wave = Math.sin(t / 1800 + h) * 8 + Math.sin(t / 300 + h * 2) * 4;
    out.push({
      t: t * 1000,
      cpu: Math.min(98, Math.max(1, baseCpu + wave)),
      memPct: Math.min(97, Math.max(5, baseMem + wave / 2)),
    });
  }
  return out;
}

/**
 * CPU / memory history for one worker or edge node from the per-node system
 * metrics endpoint (the aggregated metrics query has no per-node dimension).
 */
export async function getNodeMetrics(nodeId: string, rangeSeconds: number): Promise<NodePoint[]> {
  if (IS_DEMO) return demoNodePoints(nodeId, rangeSeconds);
  const now = Math.floor(Date.now() / 1000);
  const res = await apiGet<{ results?: { metrics?: RawNodeEntry[] } }>(
    `/w/${encodeURIComponent(nodeId)}/system/metrics?earliest=${now - rangeSeconds}&latest=${now}`,
  );
  const entries = res.results?.metrics ?? [];
  const points: NodePoint[] = [];
  for (const e of entries) {
    const t = entryVal(e, '_time');
    if (t == null) continue;
    const cpu = entryVal(e, 'system.cpu_perc');
    const free = entryVal(e, 'system.free_mem');
    const total = entryVal(e, 'system.total_mem');
    const memPct = free != null && total != null && total > 0 ? ((total - free) / total) * 100 : null;
    if (cpu == null && memPct == null) continue;
    points.push({ t: t * 1000, cpu, memPct });
  }
  points.sort((a, b) => a.t - b.t);
  return points;
}

export interface NodeThroughputPoint {
  /** Sample time, epoch ms. */
  t: number;
  inBytes: number;
  outBytes: number;
}

function demoNodeThroughput(nodeId: string, rangeSeconds: number): NodeThroughputPoint[] {
  let h = 0;
  for (const c of nodeId) h = (h * 31 + c.charCodeAt(0)) % 997;
  const baseInBps = 400_000 + (h % 900_000);
  const nowSec = Math.floor(Date.now() / 1000);
  const stepSec = Math.max(60, Math.floor(rangeSeconds / 48));
  const out: NodeThroughputPoint[] = [];
  for (let t = nowSec - rangeSeconds; t <= nowSec; t += stepSec) {
    const wave = 0.55 + 0.45 * Math.abs(Math.sin(t / 5400 + h));
    const inBps = baseInBps * wave;
    out.push({ t: t * 1000, inBytes: inBps * stepSec, outBytes: inBps * stepSec * 0.65 });
  }
  return out;
}

/**
 * Whole-node in/out byte throughput from the per-node system metrics endpoint
 * (same source as `getNodeMetrics`, just reading the `total.*_bytes` fields
 * instead of `system.*`) — used to size one node's capacity against its
 * observed load without depending on the aggregate query's `host` dimension.
 */
export async function getNodeThroughput(nodeId: string, rangeSeconds: number): Promise<NodeThroughputPoint[]> {
  if (IS_DEMO) return demoNodeThroughput(nodeId, rangeSeconds);
  const now = Math.floor(Date.now() / 1000);
  const res = await apiGet<{ results?: { metrics?: RawNodeEntry[] } }>(
    `/w/${encodeURIComponent(nodeId)}/system/metrics?earliest=${now - rangeSeconds}&latest=${now}`,
  );
  const entries = res.results?.metrics ?? [];
  const points: NodeThroughputPoint[] = [];
  for (const e of entries) {
    const t = entryVal(e, '_time');
    if (t == null) continue;
    const inBytes = entryVal(e, 'total.in_bytes');
    const outBytes = entryVal(e, 'total.out_bytes');
    if (inBytes == null && outBytes == null) continue;
    points.push({ t: t * 1000, inBytes: inBytes ?? 0, outBytes: outBytes ?? 0 });
  }
  points.sort((a, b) => a.t - b.t);
  return points;
}

// ---------------------------------------------------------------------------
// License quota (daily ingest allowance)
// ---------------------------------------------------------------------------

/**
 * Daily ingest quota in bytes from the license totals (`quota` is GB/day),
 * or null when the license reports no quota.
 */
export async function getLicenseQuota(): Promise<number | null> {
  if (IS_DEMO) return 20 * 1024 ** 3; // 20 GB/day pairs with the demo usage data
  const r = await apiGet<{ items?: { id?: string; quota?: number }[] }>('/system/licenses');
  const items = r.items ?? [];
  const total = items.find((i) => i.id === '_TOTAL_') ?? items[0];
  return total?.quota && total.quota > 0 ? total.quota * 1024 ** 3 : null;
}

// ---------------------------------------------------------------------------
// Route health
// ---------------------------------------------------------------------------

// Demo mode has no captured route metrics, so synthesize per-route samples:
// steady senders plus a couple that went quiet, mirroring what the live
// query returns. `silentSeconds` is how long ago the route stopped reporting.
const DEMO_ROUTES = [
  { route: 'default', group: 'default', eps: 1400, Bps: 980_000 },
  { route: 'syslog-to-s3', group: 'default', eps: 620, Bps: 710_000 },
  { route: 'firewall-archive', group: 'default', eps: 240, Bps: 380_000, silentSeconds: 3.4 * 3600 },
  { route: 'metrics-to-prometheus', group: 'defaultHybrid', eps: 900, Bps: 120_000 },
  { route: 'win-events', group: 'Windows_Fleet', eps: 310, Bps: 240_000, silentSeconds: 75 * 60 },
  { route: 'nessus-scans', group: 'tenable', eps: 45, Bps: 90_000 },
  { route: 'linux-journald', group: 'Linux_Fleet', eps: 150, Bps: 60_000 },
];

// Reduction factor per demo route (a filter/sampling step inside the route
// itself, distinct from a downstream pipeline's own reduction) — mirrors the
// Splunk dashboard's Route mode, which reports both in and out for routes
// (unlike pipelines, which only report event counts, no bytes, in core metrics).
const DEMO_ROUTE_REDUCTION: Record<string, number> = {
  default: 0,
  'syslog-to-s3': 0.08,
  'firewall-archive': 0.42,
  'metrics-to-prometheus': 0,
  'win-events': 0.15,
  'nessus-scans': 0,
  'linux-journald': 0.05,
};

function demoRouteRows(group: string | 'all', rangeSeconds: number, bucketSeconds: number): MetricRow[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows: MetricRow[] = [];
  for (const r of DEMO_ROUTES) {
    if (group !== 'all' && r.group !== group) continue;
    const silent = r.silentSeconds ?? 0;
    const reduction = 1 - (DEMO_ROUTE_REDUCTION[r.route] ?? 0);
    for (let end = nowSec; end > nowSec - rangeSeconds; end -= bucketSeconds) {
      if (nowSec - end < silent) continue; // the route's silent tail: no rows
      const jitter = 0.75 + 0.5 * Math.abs(Math.sin(end / 977 + r.route.length));
      const eventsIn = Math.round(r.eps * bucketSeconds * jitter);
      const bytesIn = Math.round(r.Bps * bucketSeconds * jitter);
      rows.push({
        starttime: end - bucketSeconds,
        endtime: end,
        route: r.route,
        name: r.route,
        __worker_group: r.group,
        eventsIn,
        bytesIn,
        eventsOut: Math.round(eventsIn * reduction),
        bytesOut: Math.round(bytesIn * reduction),
      });
    }
  }
  return rows;
}

/**
 * Per-route throughput samples (split by route + worker group), bucketed by
 * `bucketSeconds`. Feeds the Route Health page's stall detection and the
 * Route/Pipeline Reductions page's Route mode.
 */
export async function getRouteSeries(
  group: string | 'all',
  rangeSeconds: number,
  bucketSeconds: number,
): Promise<MetricRow[]> {
  if (IS_DEMO) return demoRouteRows(group, rangeSeconds, bucketSeconds);
  return runQuery({
    where: whereForTop(group),
    aggregations: [
      'sum("route.in_events").as("eventsIn")',
      'sum("route.in_bytes").as("bytesIn")',
      'sum("route.out_events").as("eventsOut")',
      'sum("route.out_bytes").as("bytesOut")',
    ],
    splitBys: ['route', 'name', '__worker_group'],
    timeWindowSeconds: bucketSeconds,
    earliestSeconds: rangeSeconds,
  });
}

export interface TopItem {
  id: string;
  bytes: number;
  events: number;
}

function whereForTop(group: string | 'all'): string {
  return group === 'all'
    ? '((__dist_mode=="worker") || (__dist_mode=="managed-edge"))'
    : `(__worker_group=="${group}")`;
}

/** Top sources by bytes in for a group, aggregated across buckets. */
export async function getTopInputs(group: string | 'all', rangeSeconds: number): Promise<TopItem[]> {
  const rows = IS_DEMO
    ? (await fixtures()).topSourcesDefault
    : await runQuery({
        where: whereForTop(group),
        aggregations: ['sum("total.in_bytes").as("bytes")', 'sum("total.in_events").as("events")'],
        splitBys: ['input'],
        timeWindowSeconds: -1,
        earliestSeconds: rangeSeconds,
      });
  return aggregateSplit(rows, 'input', IS_DEMO ? 'bytesIn' : 'bytes', IS_DEMO ? 'eventsIn' : 'events');
}

/** Top destinations by bytes out for a group, aggregated across buckets. */
export async function getTopOutputs(group: string | 'all', rangeSeconds: number): Promise<TopItem[]> {
  const rows = IS_DEMO
    ? (await fixtures()).topDestsDefault
    : await runQuery({
        where: whereForTop(group),
        aggregations: ['sum("total.out_bytes").as("bytes")', 'sum("total.out_events").as("events")'],
        splitBys: ['output'],
        timeWindowSeconds: -1,
        earliestSeconds: rangeSeconds,
      });
  return aggregateSplit(rows, 'output', IS_DEMO ? 'bytesOut' : 'bytes', IS_DEMO ? 'eventsOut' : 'events');
}

/** Top routes by bytes in for a group, aggregated across buckets. */
export async function getTopRoutes(group: string | 'all', rangeSeconds: number): Promise<TopItem[]> {
  const rows = IS_DEMO
    ? demoRouteRows(group, rangeSeconds, Math.max(60, Math.floor(rangeSeconds / 60)))
    : await runQuery({
        where: whereForTop(group),
        aggregations: ['sum("route.in_bytes").as("bytes")', 'sum("route.in_events").as("events")'],
        splitBys: ['name'],
        timeWindowSeconds: -1,
        earliestSeconds: rangeSeconds,
      });
  return aggregateSplit(rows, 'name', IS_DEMO ? 'bytesIn' : 'bytes', IS_DEMO ? 'eventsIn' : 'events');
}

/** Collapse split time-bucket rows into one total per split key.
 *  Metric input/output dimensions are formatted `<type>:<id>`; strip the type
 *  prefix so ids line up with the bare ids from the Source/Destination status API. */
function aggregateSplit(rows: MetricRow[], dim: string, byteKey: string, evKey: string): TopItem[] {
  const acc = new Map<string, TopItem>();
  for (const r of rows) {
    const raw = (r[dim] as string) ?? '(none)';
    const id = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
    const cur = acc.get(id) ?? { id, bytes: 0, events: 0 };
    cur.bytes += Number(r[byteKey] ?? 0);
    cur.events += Number(r[evKey] ?? 0);
    acc.set(id, cur);
  }
  return [...acc.values()].filter((x) => x.id !== '(none)').sort((a, b) => b.bytes - a.bytes);
}

// ---------------------------------------------------------------------------
// Pipeline health
// ---------------------------------------------------------------------------

export interface PipelineStat {
  id: string;
  group: string;
  eventsIn: number;
  eventsOut: number;
  dropped: number;
  errors: number;
}

// Demo pipelines: mostly clean, one dropping heavily (a filter pipeline), one erroring.
const DEMO_PIPELINES = [
  { id: 'passthru', group: 'default', eps: 1200, dropPct: 0, errPct: 0 },
  { id: 'syslog-clean', group: 'default', eps: 640, dropPct: 0.35, errPct: 0 },
  { id: 'firewall-filter', group: 'default', eps: 410, dropPct: 0.82, errPct: 0 },
  { id: 'win-events-shape', group: 'Windows_Fleet', eps: 300, dropPct: 0.12, errPct: 0.03 },
  { id: 'metrics-rollup', group: 'defaultHybrid', eps: 900, dropPct: 0.55, errPct: 0 },
  { id: 'vectra-enrich', group: 'default', eps: 260, dropPct: 0.05, errPct: 0.11 },
  { id: 'journald-trim', group: 'Linux_Fleet', eps: 150, dropPct: 0.4, errPct: 0 },
];

function demoPipelineStats(group: string | 'all', rangeSeconds: number): PipelineStat[] {
  return DEMO_PIPELINES.filter((p) => group === 'all' || p.group === group).map((p) => {
    const evIn = Math.round(p.eps * rangeSeconds);
    const dropped = Math.round(evIn * p.dropPct);
    const errors = Math.round(evIn * p.errPct);
    return { id: p.id, group: p.group, eventsIn: evIn, eventsOut: evIn - dropped - errors, dropped, errors };
  });
}

/** Per-pipeline event totals (in/out/dropped/errors) over the window. */
export async function getPipelineStats(
  group: string | 'all',
  rangeSeconds: number,
): Promise<PipelineStat[]> {
  if (IS_DEMO) return demoPipelineStats(group, rangeSeconds);
  const rows = await runQuery({
    where: whereForTop(group),
    aggregations: [
      'sum("pipe.in_events").as("evIn")',
      'sum("pipe.out_events").as("evOut")',
      'sum("pipe.dropped_events").as("evDrop")',
      'sum("pipe.err_events").as("evErr")',
    ],
    splitBys: ['id', '__worker_group'],
    timeWindowSeconds: -1,
    earliestSeconds: rangeSeconds,
  });
  const acc = new Map<string, PipelineStat>();
  for (const r of rows) {
    const id = typeof r.id === 'string' ? r.id : '';
    if (!id) continue;
    const grp = typeof r.__worker_group === 'string' ? r.__worker_group : '(unknown)';
    const key = `${grp}::${id}`;
    const cur = acc.get(key) ?? { id, group: grp, eventsIn: 0, eventsOut: 0, dropped: 0, errors: 0 };
    cur.eventsIn += Number(r.evIn ?? 0);
    cur.eventsOut += Number(r.evOut ?? 0);
    cur.dropped += Number(r.evDrop ?? 0);
    cur.errors += Number(r.evErr ?? 0);
    acc.set(key, cur);
  }
  return [...acc.values()].sort((a, b) => b.eventsIn - a.eventsIn);
}

function demoPipelineRows(group: string | 'all', rangeSeconds: number, bucketSeconds: number): MetricRow[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows: MetricRow[] = [];
  for (const p of DEMO_PIPELINES) {
    if (group !== 'all' && p.group !== group) continue;
    for (let end = nowSec; end > nowSec - rangeSeconds; end -= bucketSeconds) {
      const jitter = 0.75 + 0.5 * Math.abs(Math.sin(end / 977 + p.id.length));
      const eventsIn = Math.round(p.eps * bucketSeconds * jitter);
      rows.push({
        starttime: end - bucketSeconds,
        endtime: end,
        id: p.id,
        __worker_group: p.group,
        eventsIn,
        eventsOut: Math.round(eventsIn * (1 - p.dropPct - p.errPct)),
      });
    }
  }
  return rows;
}

/**
 * Per-pipeline event I/O samples (split by pipeline + worker group), bucketed
 * by `bucketSeconds` — pipelines don't report byte metrics in core internal
 * metrics (only routes do), so this is event counts only. Feeds the
 * Route/Pipeline Reductions page's Pipeline mode.
 */
export async function getPipelineSeries(
  group: string | 'all',
  rangeSeconds: number,
  bucketSeconds: number,
): Promise<MetricRow[]> {
  if (IS_DEMO) return demoPipelineRows(group, rangeSeconds, bucketSeconds);
  return runQuery({
    where: whereForTop(group),
    aggregations: ['sum("pipe.in_events").as("eventsIn")', 'sum("pipe.out_events").as("eventsOut")'],
    splitBys: ['id', '__worker_group'],
    timeWindowSeconds: bucketSeconds,
    earliestSeconds: rangeSeconds,
  });
}

// ---------------------------------------------------------------------------
// Collection jobs
// ---------------------------------------------------------------------------

export type JobWithGroup = CollectionJob & { group: string };

function demoJobs(): JobWithGroup[] {
  const nowMs = Date.now();
  const mk = (
    n: number,
    collector: string,
    group: string,
    state: string,
    failed: number,
    finished: number,
    opts: { cron?: string; events?: number; bytes?: number } = {},
  ): JobWithGroup => ({
    id: `${Math.floor(nowMs / 1000) - n * 300}.${1000 + n}.${opts.cron ? 'scheduled' : 'adhoc'}.${collector}`,
    group,
    args: {
      id: collector,
      type: 'collection',
      collector: { type: 'rest' },
      ...(opts.cron ? { schedule: { cronSchedule: opts.cron, enabled: true } } : {}),
    },
    status: { state },
    stats: {
      tasks: { finished, failed, cancelled: 0, inFlight: state === 'running' ? 1 : 0, count: finished + failed },
      state: { initializing: nowMs - n * 300_000, finished: state === 'finished' ? nowMs - n * 300_000 + 45_000 : 0 },
      collectedEvents: opts.events ?? 0,
      collectedBytes: opts.bytes ?? 0,
    },
  });
  return [
    mk(1, 'sailpoint-identity-sync', 'default', 'finished', 0, 4, { cron: '*/5 * * * *', events: 1840, bytes: 2.1e6 }),
    mk(2, 'webex-audit-pull', 'default', 'finished', 1, 1, { cron: '*/5 * * * *', events: 220, bytes: 4.4e5 }),
    mk(3, 's3-replay-window', 'default', 'running', 0, 2, { events: 51000, bytes: 8.2e7 }),
    mk(4, 'sailpoint-identity-sync', 'default', 'finished', 0, 4, { cron: '*/5 * * * *', events: 1795, bytes: 2.0e6 }),
    mk(5, 'tenable-scan-results', 'tenable', 'failed', 2, 0, { cron: '0 * * * *' }),
    mk(6, 'webex-audit-pull', 'default', 'finished', 0, 2, { cron: '*/5 * * * *', events: 305, bytes: 6.1e5 }),
  ];
}

/** Collection/scheduled job instances across groups, newest first. */
export async function getJobs(groupIds: string[]): Promise<JobWithGroup[]> {
  if (IS_DEMO) return demoJobs();
  const per = await Promise.all(
    groupIds.map((g) =>
      apiGet<{ items?: CollectionJob[] }>(`/m/${encodeURIComponent(g)}/jobs`)
        .then((r) => (r.items ?? []).map((j) => ({ ...j, group: g })))
        .catch(() => [] as JobWithGroup[]),
    ),
  );
  return per
    .flat()
    .sort((a, b) => (b.stats?.state?.initializing ?? 0) - (a.stats?.state?.initializing ?? 0));
}

/**
 * Task errors for one job run. The endpoint returns a single error object for
 * one failed task and an array when several tasks failed; normalize to a list.
 */
export async function getJobErrors(group: string, jobId: string): Promise<JobError[]> {
  if (IS_DEMO) {
    if (!jobId.includes('tenable-scan-results')) return [];
    return [
      {
        timestamp: Date.now() - 12 * 60_000,
        taskId: 'discover',
        error: {
          name: 'FatalTaskError',
          message: 'encountered fatal task error',
          reason: {
            message:
              'Discover failed: request to https://cloud.tenable.com/scans returned 401 Unauthorized — check the collector credentials.',
          },
        },
      },
    ];
  }
  const res = await apiGet<JobError | JobError[] | { items?: JobError[] }>(
    `/m/${encodeURIComponent(group)}/jobs/${encodeURIComponent(jobId)}/errors`,
  );
  if (Array.isArray(res)) return res;
  if (res && typeof res === 'object' && 'items' in res && Array.isArray(res.items)) return res.items;
  return res && typeof res === 'object' && ('error' in res || 'taskId' in res)
    ? [res as JobError]
    : [];
}

// ---------------------------------------------------------------------------
// Email alerting — native Cribl Notifications (group-scoped) + targets
// ---------------------------------------------------------------------------

export type NotificationWithGroup = CriblNotification & { group: string };

const DEMO_ALERTS_KEY = 'criblvision-demo-alerts';

function loadDemoAlerts(): NotificationWithGroup[] {
  try {
    const raw = localStorage.getItem(DEMO_ALERTS_KEY);
    if (raw) return JSON.parse(raw) as NotificationWithGroup[];
  } catch {
    /* fall through to seed */
  }
  return [
    {
      id: 'criblvision-unhealthy-to-splunk',
      group: 'default',
      condition: 'unhealthy-dest',
      disabled: false,
      targets: ['system_email'],
      conf: { name: 'to-splunk-dev', timeWindow: '300s', notifyOnResolution: true },
      targetConfigs: [
        {
          id: 'system_email',
          conf: { subject: '[CriblVision] to-splunk-dev unhealthy', emailRecipient: { to: 'ops@example.com' } },
        },
      ],
    },
    {
      id: 'criblvision-nodata-win-events',
      group: 'Windows_Fleet',
      condition: 'no-data',
      disabled: true,
      targets: ['system_email'],
      conf: { name: 'win-data-gen', timeWindow: '15m', notifyOnResolution: true },
      targetConfigs: [
        {
          id: 'system_email',
          conf: { subject: '[CriblVision] win-data-gen silent', emailRecipient: { to: 'ops@example.com' } },
        },
      ],
    },
  ];
}

function saveDemoAlerts(items: NotificationWithGroup[]): void {
  try {
    localStorage.setItem(DEMO_ALERTS_KEY, JSON.stringify(items));
  } catch {
    /* demo persistence is best-effort */
  }
}

/** Configured notification targets (email, in-product bulletin, webhooks…). */
export async function getNotificationTargets(): Promise<NotificationTarget[]> {
  if (IS_DEMO) {
    return [
      { id: 'system_email', type: 'smtp', status: { health: 'Green', metrics: { totalSent: 7, errorCnt: 0 } } },
      { id: 'system_notifications', type: 'bulletin_message', status: { health: 'Green' } },
    ];
  }
  return (await apiGet<{ items?: NotificationTarget[] }>('/notification-targets')).items ?? [];
}

/** All Notifications across the given groups, each tagged with its group. */
export async function getNotifications(groupIds: string[]): Promise<NotificationWithGroup[]> {
  if (IS_DEMO) return loadDemoAlerts();
  const per = await Promise.all(
    groupIds.map((g) =>
      apiGet<{ items?: CriblNotification[] }>(`/m/${encodeURIComponent(g)}/notifications`)
        .then((r) => (r.items ?? []).map((n) => ({ ...n, group: g })))
        .catch(() => [] as NotificationWithGroup[]),
    ),
  );
  return per.flat();
}

export async function createNotification(group: string, n: CriblNotification): Promise<void> {
  if (IS_DEMO) {
    const items = loadDemoAlerts();
    if (items.some((x) => x.id === n.id)) throw new Error(`Alert id "${n.id}" already exists`);
    items.push({ ...n, group });
    saveDemoAlerts(items);
    return;
  }
  await apiPost(`/m/${encodeURIComponent(group)}/notifications`, n);
}

export async function updateNotification(group: string, n: CriblNotification): Promise<void> {
  if (IS_DEMO) {
    const items = loadDemoAlerts().map((x) =>
      x.id === n.id && x.group === group ? { ...n, group } : x,
    );
    saveDemoAlerts(items);
    return;
  }
  await apiPatch(`/m/${encodeURIComponent(group)}/notifications/${encodeURIComponent(n.id)}`, n);
}

export async function deleteNotification(group: string, id: string): Promise<void> {
  if (IS_DEMO) {
    saveDemoAlerts(loadDemoAlerts().filter((x) => !(x.id === id && x.group === group)));
    return;
  }
  await apiDelete(`/m/${encodeURIComponent(group)}/notifications/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Internal-log search (Log Analytics page)
// ---------------------------------------------------------------------------
//
// `/system/logs/search` reaches a worker group's centrally-stored log via
// `type=group&groupId=<gid>` — it can't address one specific Worker/Edge
// node's log within a group (no equivalent to `/w/:id/system/metrics`), and
// there's no confirmed-working path for the Leader's own root log.

export interface LogEntry {
  time: number; // epoch ms
  level: string;
  channel: string;
  message: string;
  reason?: string;
  /** The event exactly as returned by the server, for raw-text display. */
  raw: Record<string, unknown>;
}

const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'silly'] as const;

function strField(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** `time` comes back as either an epoch number (seconds or ms) or an ISO-8601 string. */
function parseLogTime(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/** Parse one raw log-search event (shape is server-defined, `additionalProperties: true`). */
function parseLogEvent(e: Record<string, unknown>): LogEntry | null {
  const level = strField(e.level)?.toLowerCase();
  if (!level) return null;
  const time = parseLogTime(e.time ?? e._time ?? e.ts) ?? Date.now();
  const errObj = e.error as Record<string, unknown> | undefined;
  const errObj2 = e.err as Record<string, unknown> | undefined;
  const reason = strField(e.reason) ?? strField(errObj?.message) ?? strField(errObj2?.message);
  return {
    time,
    level,
    channel: strField(e.channel) ?? '(none)',
    message: strField(e.message) ?? '(no message)',
    reason,
    raw: e,
  };
}

const DEMO_LOG_MESSAGES: Record<string, { level: string; channel: string; message: string; reason?: string; weight: number }[]> = {
  error: [
    { level: 'error', channel: 'outputs', message: 'Failed to send to destination', reason: 'connect ECONNREFUSED 10.0.4.21:9997', weight: 6 },
    { level: 'error', channel: 'inputs', message: 'TLS handshake failed', reason: 'unable to verify the first certificate', weight: 2 },
  ],
  warn: [
    { level: 'warn', channel: 'pipelines', message: 'Dropping event, exceeded max size', weight: 14 },
    { level: 'warn', channel: 'outputs', message: 'Persistent queue backing up', reason: 'downstream unhealthy', weight: 5 },
    { level: 'warn', channel: 'license', message: 'Approaching daily ingest quota', weight: 3 },
  ],
  info: [
    { level: 'info', channel: 'server', message: '_raw stats', weight: 40 },
    { level: 'info', channel: 'cfg', message: 'Config committed', weight: 6 },
    { level: 'info', channel: 'inputs', message: 'Source started', weight: 8 },
  ],
  debug: [{ level: 'debug', channel: 'pipelines', message: 'Function eval', weight: 20 }],
  silly: [{ level: 'silly', channel: 'server', message: 'heartbeat', weight: 30 }],
};

function demoLogEntries(rangeSeconds: number): LogEntry[] {
  const nowMs = Date.now();
  const entries: LogEntry[] = [];
  for (const level of LOG_LEVELS) {
    for (const tmpl of DEMO_LOG_MESSAGES[level]) {
      const count = Math.max(1, Math.round((tmpl.weight * rangeSeconds) / 900));
      for (let i = 0; i < count; i++) {
        const time = nowMs - Math.floor(Math.random() * rangeSeconds * 1000);
        entries.push({
          time,
          level: tmpl.level,
          channel: tmpl.channel,
          message: tmpl.message,
          reason: tmpl.reason,
          raw: {
            time: new Date(time).toISOString(),
            level: tmpl.level,
            channel: tmpl.channel,
            message: tmpl.message,
            ...(tmpl.reason ? { reason: tmpl.reason } : {}),
          },
        });
      }
    }
  }
  return entries.sort((a, b) => b.time - a.time);
}

// `type=multi` with an explicit `files` list 500s regardless of how many
// files are passed. `type=single` needs a real multi-segment path (a bare
// filename like `files=cribl.log` 400s with "invalid path") and there's no
// confirmed-working path for the Leader's own root log, so this only covers
// `type=group&groupId=<gid>`, which lets the server resolve that group's own
// log file(s) itself — no path-guessing needed.
async function fetchLogEvents(params: Record<string, string>): Promise<Record<string, unknown>[]> {
  const qs = new URLSearchParams(params);
  try {
    // Some validation failures come back as HTTP 200 with a `{status:"error"}`
    // body rather than a non-2xx status, so apiGet won't throw on them —
    // check explicitly or a bad group/path silently reads as "no data". A
    // successful response is `{ items: [{ events: [...] }] }` — one item per
    // matched log file (e.g. cribl.log and cribl_stderr.log for one group).
    const res = await apiGet<{
      status?: string;
      message?: string;
      items?: { events?: Record<string, unknown>[] }[];
    }>(`/system/logs/search?${qs.toString()}`);
    if (res.status === 'error') {
      console.warn(`/system/logs/search (${qs.toString()}):`, res.message);
      return [];
    }
    return (res.items ?? []).flatMap((item) => item.events ?? []);
  } catch (e) {
    // One inaccessible/renamed log file or group shouldn't blank the whole page.
    console.warn(`/system/logs/search (${qs.toString()}):`, e);
    return [];
  }
}

const MAX_LOGS_SEARCH_LIMIT = 1000; // server-enforced ceiling on `limit`

/** Recent log lines for the given worker groups over the window, newest first, capped at `limit`. */
export async function searchLogs(groupIds: string[], rangeSeconds: number, limit = MAX_LOGS_SEARCH_LIMIT): Promise<LogEntry[]> {
  if (IS_DEMO) return demoLogEntries(rangeSeconds);
  const now = Math.floor(Date.now() / 1000);
  const common = {
    et: String(now - rangeSeconds),
    lt: String(now),
    limit: String(Math.min(limit, MAX_LOGS_SEARCH_LIMIT)),
  };

  const groupEvents = await Promise.all(
    groupIds.map((gid) => fetchLogEvents({ ...common, type: 'group', groupId: gid })),
  );

  return groupEvents
    .flat()
    .map(parseLogEvent)
    .filter((e): e is LogEntry => e != null)
    .sort((a, b) => b.time - a.time);
}

// ---------------------------------------------------------------------------
// Config commit history (Commit Audit Log page)
// ---------------------------------------------------------------------------
//
// `GET /version` is Cribl's own git-log-equivalent for the config repo, and
// `GET /version/show?commit=<hash>` returns that commit's message plus a
// structured diff for every file it touched — no deploy-history API exists
// (deploying is a write-only action), so this only covers commits.

export interface CommitInfo {
  hash: string;
  authorName: string;
  authorEmail: string;
  date: number; // epoch ms
  message: string;
  body?: string;
}

export type DiffLineEntry =
  | { type: 'insert'; newNumber: number; content: string }
  | { type: 'delete'; oldNumber: number; content: string }
  | { type: 'context'; oldNumber: number; newNumber: number; content: string };

export interface DiffFileEntry {
  oldName: string;
  newName: string;
  isNew: boolean;
  isDeleted: boolean;
  isRename: boolean;
  isBinary: boolean;
  addedLines: number;
  deletedLines: number;
  blocks: { header: string; lines: DiffLineEntry[] }[];
}

export interface CommitDetail {
  message: string;
  files: DiffFileEntry[];
}

function parseCommitDate(v: unknown): number {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : Date.now();
}

const DEMO_COMMITS: { author: string; email: string; message: string; hoursAgo: number }[] = [
  { author: 'j.woger', email: 'j.woger@example.com', message: 'Update pipeline: syslog-clean — drop debug fields', hoursAgo: 2 },
  { author: 'a.chen', email: 'a.chen@example.com', message: 'Add destination: splunk-hec-dr', hoursAgo: 9 },
  { author: 'j.woger', email: 'j.woger@example.com', message: 'Increase persistent queue size on AIO_Splunk', hoursAgo: 26 },
  { author: 'svc-cribl-ci', email: 'ci@example.com', message: 'Sync routes from staging branch', hoursAgo: 30 },
  { author: 'a.chen', email: 'a.chen@example.com', message: 'Fix regex in firewall-filter pipeline', hoursAgo: 55 },
  { author: 'j.woger', email: 'j.woger@example.com', message: 'Rotate TLS cert for in_syslog_tls', hoursAgo: 80 },
  { author: 'svc-cribl-ci', email: 'ci@example.com', message: 'Sync routes from staging branch', hoursAgo: 100 },
  { author: 'a.chen', email: 'a.chen@example.com', message: 'Remove unused lookup: legacy_hostmap', hoursAgo: 148 },
];

const DEMO_HASHES = ['a3f9c21', 'e71b04d', '9c2a8f1', '4d6e0b7', 'f0a3c88', '2b7d1e4', '8c5f0a2', '1e9b3d6'];

function demoCommitHistory(): CommitInfo[] {
  const nowMs = Date.now();
  return DEMO_COMMITS.map((c, i) => ({
    hash: DEMO_HASHES[i % DEMO_HASHES.length],
    authorName: c.author,
    authorEmail: c.email,
    date: nowMs - c.hoursAgo * 3600_000,
    message: c.message,
  }));
}

function demoCommitDetail(): CommitDetail {
  return {
    message: 'demo commit',
    files: [
      {
        oldName: 'groups/default/pipelines/syslog-clean.json',
        newName: 'groups/default/pipelines/syslog-clean.json',
        isNew: false,
        isDeleted: false,
        isRename: false,
        isBinary: false,
        addedLines: 2,
        deletedLines: 1,
        blocks: [
          {
            header: '@@ -12,6 +12,7 @@ functions',
            lines: [
              { type: 'context', oldNumber: 12, newNumber: 12, content: '  { "id": "eval", "filter": "true" }' },
              { type: 'delete', oldNumber: 13, content: '  { "id": "eval", "conf": { "keep": ["host","level"] } }' },
              { type: 'insert', newNumber: 13, content: '  { "id": "eval", "conf": { "keep": ["host","level","source"] } }' },
              { type: 'insert', newNumber: 14, content: '  { "id": "drop", "filter": "level==\\"debug\\"" }' },
              { type: 'context', oldNumber: 14, newNumber: 15, content: '  { "id": "serialize" }' },
            ],
          },
        ],
      },
    ],
  };
}

/** Recent config commits, newest first. */
export async function getCommitHistory(count = 300): Promise<CommitInfo[]> {
  if (IS_DEMO) return demoCommitHistory();
  const res = await apiGet<{ items?: Record<string, unknown>[] }>(`/version?count=${count}`);
  return (res.items ?? []).map((c) => ({
    hash: strField(c.hash) ?? '',
    authorName: strField(c.author_name) ?? 'unknown',
    authorEmail: strField(c.author_email) ?? '',
    date: parseCommitDate(c.date),
    message: strField(c.message) ?? '(no message)',
    body: strField(c.body),
  }));
}

/** Full diff + message for one commit — fetched on demand when a row expands. */
export async function getCommitDetail(hash: string): Promise<CommitDetail> {
  if (IS_DEMO) return demoCommitDetail();
  const res = await apiGet<{ items?: { commitMessage?: string; diffJson?: Record<string, unknown>[] }[] }>(
    `/version/show?commit=${encodeURIComponent(hash)}&diffLineLimit=400`,
  );
  const item = res.items?.[0];
  const files = (item?.diffJson ?? []).map((f) => ({
    oldName: strField(f.oldName) ?? '',
    newName: strField(f.newName) ?? '',
    isNew: f.isNew === true,
    isDeleted: f.isDeleted === true,
    isRename: f.isRename === true,
    isBinary: f.isBinary === true,
    addedLines: typeof f.addedLines === 'number' ? f.addedLines : 0,
    deletedLines: typeof f.deletedLines === 'number' ? f.deletedLines : 0,
    blocks: Array.isArray(f.blocks)
      ? (f.blocks as Record<string, unknown>[]).map((b) => ({
          header: strField(b.header) ?? '',
          lines: Array.isArray(b.lines) ? (b.lines as DiffLineEntry[]) : [],
        }))
      : [],
  }));
  return { message: item?.commitMessage ?? '', files };
}
