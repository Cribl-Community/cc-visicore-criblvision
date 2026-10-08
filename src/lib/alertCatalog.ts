// The alert catalog CriblVision ships: Cribl Search scheduled searches that any
// Cribl.Cloud workspace can enable. Every query reads a built-in dataset —
// cribl_metrics, or the Leader's cribl_internal_logs — and groups by worker
// group, so nothing is tied to a particular group
// (Cribl-managed and hybrid groups are covered alike). No recipient is shipped —
// whoever enables an alert chooses how it is delivered.

import type { CriblNotification, NotificationEmailConf, SavedSearch } from '../api/types';

export type Priority = 'P1' | 'P2' | 'P3';
export const PRIORITIES: Priority[] = ['P1', 'P2', 'P3'];

// The priority lives on the alert itself so it shows up in Cribl Search and in
// the email: saved-search names only allow [A-Za-z0-9 _-], so the name carries
// a "P1 - " prefix and the email subject a "[P1] " prefix.
const NAME_PREFIX = /^\s*\[?(P[123])\]?\s*[-:]?\s+/i;

export function priorityOf(label: string | undefined): Priority | null {
  const m = NAME_PREFIX.exec(label ?? '');
  return m ? (m[1].toUpperCase() as Priority) : null;
}

export function stripPriority(label: string | undefined): string {
  return (label ?? '').replace(NAME_PREFIX, '');
}

function nameWithPriority(label: string, p: Priority | null): string {
  const base = stripPriority(label);
  return p ? `${p} - ${base}` : base;
}

export function subjectWithPriority(label: string, p: Priority | null): string {
  const base = stripPriority(label);
  return p ? `[${p}] ${base}` : base;
}

// Catalog alerts open their message with a "[P1] Name" headline, which is all a
// system notification shows of the priority — keep it in step with the label.
function relabelMessage(message: unknown, baseName: string, p: Priority | null): unknown {
  if (typeof message !== 'string') return message;
  const [headline, ...rest] = message.split('\n');
  if (stripPriority(headline) !== baseName) return message;
  return [subjectWithPriority(baseName, p), ...rest].join('\n');
}

/** An alert's display label with its priority up front, e.g. "[P1] Worker Down". */
export function alertLabel(s: SavedSearch): string {
  return subjectWithPriority(s.name ?? s.id, priorityOf(s.name));
}

/** Notifications of a saved search that make it an alert. */
export function alertNotifications(s: SavedSearch): CriblNotification[] {
  return s.schedule?.notifications?.items ?? [];
}

/**
 * The saved search plus the notifications that need rewriting to carry priority
 * `p` (null clears the label). Subjects are only touched when they exist or a
 * label is being added, so unlabeled alerts keep Cribl's default subject.
 */
export function relabel(
  s: SavedSearch,
  p: Priority | null,
): { search: SavedSearch; notifications: CriblNotification[] } {
  const baseName = stripPriority(s.name ?? s.id);
  const notifications = alertNotifications(s).map((n) => ({
    ...n,
    conf: n.conf && { ...n.conf, message: relabelMessage(n.conf.message, baseName, p) },
    targetConfigs: (n.targetConfigs ?? []).map((t) => {
      const subject = t.conf?.subject;
      if (!t.conf?.emailRecipient || (!subject && !p)) return t;
      return { ...t, conf: { ...t.conf, subject: subjectWithPriority(subject || baseName, p) } };
    }),
  }));
  const search: SavedSearch = {
    ...s,
    name: nameWithPriority(baseName, p),
    schedule: s.schedule && {
      ...s.schedule,
      notifications: s.schedule.notifications && { ...s.schedule.notifications, items: notifications },
    },
  };
  return { search, notifications };
}

export const ALERT_CATEGORIES = [
  'Worker Nodes',
  'Data Flow',
  'Sources & Destinations',
  'Persistent Queues',
  'Collectors',
] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

/** The editable logic of an alert: what it searches, how far back, and how often. */
export interface AlertLogic {
  query: string;
  earliest: string;
  cron: string;
}

export function logicOf(s: SavedSearch): AlertLogic {
  return { query: s.query, earliest: s.earliest ?? '', cron: s.schedule?.cronSchedule ?? '' };
}

export function sameLogic(a: AlertLogic, b: AlertLogic): boolean {
  return a.query === b.query && a.earliest === b.earliest && a.cron === b.cron;
}

export interface AlertTemplate extends AlertLogic {
  /** Saved-search id the alert is installed under. */
  id: string;
  name: string;
  description: string;
  priority: Priority;
  /** Human-readable firing condition, shown in the catalog. */
  fires: string;
  category: AlertCategory;
}

const CORE_CATALOG: AlertTemplate[] = [
  {
    id: 'criblvision_worker_not_reporting',
    name: 'Cribl Worker Node Not Reporting to Leader',
    description:
      'A worker node stopped sending metrics to the Leader. Skips restarts under 15 minutes and stops re-alerting after 25.',
    priority: 'P1',
    category: 'Worker Nodes',
    earliest: '-1h',
    cron: '*/5 * * * *',
    fires: 'node silent for 15–25 min',
    query: `dataset="cribl_metrics"
| where metric == "system.mem_rss"
| where isnotempty(worker_node_hostname)
| summarize last_seen = max(_time) by Hostname = worker_node_hostname, WorkerGroup = worker_group
| extend MinutesDead = round((now() - last_seen) / 60, 1)
// --- Grace period: skip reboots under 15 min; suppress re-alerts after 25 min ---
| where MinutesDead >= 15 and MinutesDead <= 25
| project Hostname, WorkerGroup, MinutesDead, last_seen
| order by MinutesDead desc`,
  },
  {
    id: 'criblvision_worker_unhealthy',
    name: 'Cribl Worker Node Status Unhealthy',
    description:
      'A worker node reconnected to the Leader 3 or more times in 30 minutes — it is restarting, crash-looping, or dropping its connection. Read from the Leader\'s own log.',
    priority: 'P1',
    category: 'Worker Nodes',
    earliest: '-30m',
    cron: '*/5 * * * *',
    fires: 'node reconnected 3+ times in 30 min',
    query: `dataset="cribl_internal_logs" channel="CriblMaster" message="assigned worker group"
| summarize Reconnects = count(), FirstSeen = min(_time), LastSeen = max(_time) by Hostname = hostname, WorkerGroup = group
| where Reconnects >= 3
| extend MinutesSinceLast = round((now() - LastSeen) / 60, 1)
| project Hostname, WorkerGroup, Reconnects, MinutesSinceLast
| order by Reconnects desc`,
  },
  {
    id: 'criblvision_no_data_volume',
    name: 'Cribl - No Data Ingested - Volume Drop - GB',
    description:
      'A worker group with running nodes ingested zero bytes over the last hour. Anchored on node metrics so silence is detectable.',
    priority: 'P1',
    category: 'Data Flow',
    earliest: '-1h',
    cron: '0 * * * *',
    fires: 'group ingested 0 GB in 1h',
    query: `dataset="cribl_metrics"
| where metric == "total.in_bytes" or metric == "system.mem_rss"
| where isnotempty(worker_group)
| summarize TotalBytes_In = sum(case(metric == "total.in_bytes", value, 0)), anchor_rows = count() by worker_group
| extend Volume_GB = round(TotalBytes_In / 1073741824.0, 4)
| where TotalBytes_In <= 0
| project worker_group, Volume_GB, TotalBytes_In, anchor_rows
| order by worker_group asc`,
  },
  {
    id: 'criblvision_no_events_eps',
    name: 'Cribl - No Events Ingested - EPS Drop',
    description:
      'A worker group with running nodes ingested zero events over the last hour. Anchored on node metrics so silence is detectable.',
    priority: 'P1',
    category: 'Data Flow',
    earliest: '-1h',
    cron: '0 * * * *',
    fires: 'group at 0 events/sec for 1h',
    query: `dataset="cribl_metrics"
| where metric == "total.in_events" or metric == "system.mem_rss"
| where isnotempty(worker_group)
| summarize TotalEvents_In = sum(case(metric == "total.in_events", value, 0)), anchor_rows = count() by worker_group
| extend EPS = round(TotalEvents_In / 3600.0, 2)
| where TotalEvents_In <= 0
| project worker_group, EPS, TotalEvents_In, anchor_rows
| order by worker_group asc`,
  },
  {
    id: 'criblvision_worker_high_disk',
    name: 'Cribl Worker High Disk Utilization',
    description: 'Disk utilization on a worker node reached 80% or more.',
    priority: 'P2',
    category: 'Worker Nodes',
    earliest: '-15m',
    cron: '*/15 * * * *',
    fires: 'disk used ≥ 80%',
    query: `dataset="cribl_metrics"
| where metric == "system.disk_used" or metric == "system.total_disk"
| where isnotempty(worker_node_hostname)
| summarize usedDisk = max(case(metric == "system.disk_used", value, 0)), totalDisk = max(case(metric == "system.total_disk", value, 0)) by hostname = worker_node_hostname, worker_group
| where totalDisk > 0
| extend utilization_pct = round((usedDisk * 100.0) / totalDisk, 2),
         freeDiskGB = round((totalDisk - usedDisk) / 1073741824.0, 2),
         usedDiskGB = round(usedDisk / 1073741824.0, 2),
         totalDiskGB = round(totalDisk / 1073741824.0, 2)
| where utilization_pct >= 80
| project hostname, worker_group, utilization_pct, freeDiskGB, usedDiskGB, totalDiskGB
| order by utilization_pct desc`,
  },
  {
    id: 'criblvision_worker_high_memory',
    name: 'Cribl Worker High Memory Utilization',
    description:
      'Cribl memory (RSS) on a worker node went over 8 GB. Adjust the threshold by editing 8589934592 (bytes) in the query.',
    priority: 'P2',
    category: 'Worker Nodes',
    earliest: '-1h',
    cron: '*/15 * * * *',
    fires: 'memory RSS > 8 GB',
    query: `dataset="cribl_metrics"
| where metric == "system.mem_rss"
| where isnotempty(worker_node_hostname)
| summarize mem_rss = max(value) by bin(_time, 1m), host = worker_node_hostname, worker_group
| summarize unhealthy_memory_rss_usage_events = countif(mem_rss > 8589934592), max_mem_rss_gb = round(max(mem_rss) / 1073741824.0, 2) by host, worker_group
| where unhealthy_memory_rss_usage_events > 0
| order by max_mem_rss_gb desc`,
  },
  {
    id: 'criblvision_route_zero_volume',
    name: 'Route Zero-Volume Catch-All 24h vs prior 24h',
    description:
      'Any route in any worker group that moved data 24–48h ago but nothing in the last 24h — its source is likely down. Blind to routes silent for longer than 48h.',
    priority: 'P2',
    category: 'Data Flow',
    earliest: '-48h',
    cron: '0 8 * * *',
    fires: 'route dropped to zero',
    query: `dataset="cribl_metrics" (metric="route.in_events" OR metric="route.out_events")
| summarize recent = sum(case(_time > ago(24h), value, 0)), baseline = sum(case(_time <= ago(24h), value, 0)) by worker_group, route_name = name
| where baseline > 0 and recent == 0
| extend alert = "Route went to zero - had data 24-48h ago but none in last 24h - source likely DOWN"
| project alert, worker_group, route_name, recent, baseline
| order by worker_group asc, route_name asc`,
  },
];

const HEALTH_CATALOG: AlertTemplate[] = [
  {
    id: 'criblvision_source_unhealthy',
    name: 'Source Health Unhealthy',
    description: 'A Source reported red health during the last 15 minutes.',
    priority: 'P1',
    category: 'Sources & Destinations',
    earliest: '-15m',
    cron: '*/15 * * * *',
    fires: 'source health red',
    query: `dataset="cribl_metrics"
| where metric == "health.inputs"
| summarize trouble_samples = countif(value == 2), total_samples = count() by worker_group, input, input_type
| where trouble_samples > 0
| extend trouble_pct = round(trouble_samples * 100.0 / total_samples, 1)
| project worker_group, input, input_type, trouble_pct, trouble_samples
| order by trouble_pct desc`,
  },
  {
    id: 'criblvision_destination_unhealthy',
    name: 'Destination Health Unhealthy',
    description: 'A Destination reported red health during the last 15 minutes.',
    priority: 'P1',
    category: 'Sources & Destinations',
    earliest: '-15m',
    cron: '*/15 * * * *',
    fires: 'destination health red',
    query: `dataset="cribl_metrics"
| where metric == "health.outputs"
| summarize trouble_samples = countif(value == 2), total_samples = count() by worker_group, output
| where trouble_samples > 0
| extend trouble_pct = round(trouble_samples * 100.0 / total_samples, 1)
| project worker_group, output, trouble_pct, trouble_samples
| order by trouble_pct desc`,
  },
  {
    id: 'criblvision_destination_blocked',
    name: 'Destination Blocked',
    description: 'A Destination was blocked during the last 15 minutes.',
    priority: 'P1',
    category: 'Sources & Destinations',
    earliest: '-15m',
    cron: '*/15 * * * *',
    fires: 'destination blocked',
    query: `dataset="cribl_metrics"
| where metric == "blocked.outputs"
| summarize trouble_samples = countif(value == 2), total_samples = count() by worker_group, output, worker_node_hostname
| where trouble_samples > 0
| extend trouble_pct = round(trouble_samples * 100.0 / total_samples, 1)
| project worker_group, output, worker_node_hostname, trouble_pct, trouble_samples
| order by trouble_pct desc`,
  },
  {
    id: 'criblvision_destination_backpressure',
    name: 'Destination Backpressure',
    description: 'A Destination was applying backpressure during the last 15 minutes.',
    priority: 'P2',
    category: 'Sources & Destinations',
    earliest: '-15m',
    cron: '*/15 * * * *',
    fires: 'destination backpressure',
    query: `dataset="cribl_metrics"
| where metric == "backpressure.outputs"
| summarize trouble_samples = countif(value == 2), total_samples = count() by worker_group, output, worker_node_hostname
| where trouble_samples > 0
| extend trouble_pct = round(trouble_samples * 100.0 / total_samples, 1)
| project worker_group, output, worker_node_hostname, trouble_pct, trouble_samples
| order by trouble_pct desc`,
  },
  {
    id: 'criblvision_destination_dropped_events',
    name: 'Destination Dropped Events',
    description: 'A Destination dropped more than 100 events in the last hour (devnull excluded).',
    priority: 'P2',
    category: 'Sources & Destinations',
    earliest: '-1h',
    cron: '0 * * * *',
    fires: 'destination dropped > 100 events',
    query: `dataset="cribl_metrics"
| where metric == "total.dropped_events"
| where isnotempty(output) and output != "null" and output_type != "null"
| summarize dropped_events = sum(value) by worker_group, output, output_type, worker_node_hostname
| where dropped_events > 100
| order by dropped_events desc`,
  },
  {
    id: 'criblvision_pq_buffering',
    name: 'Persistent Queue Buffering',
    description: 'A persistent queue is buffering more than 1,000 events — its Destination is not keeping up.',
    priority: 'P2',
    category: 'Persistent Queues',
    earliest: '-15m',
    cron: '*/15 * * * *',
    fires: 'PQ buffering > 1,000 events',
    query: `dataset="cribl_metrics"
| where metric == "pq.buffered_events"
| extend pq_target = iff(isnotempty(output), output, input)
| summarize buffered_events = max(value) by worker_group, pq_target, worker_node_hostname
| where buffered_events > 1000
| order by buffered_events desc`,
  },
  {
    id: 'criblvision_pq_nearly_full',
    name: 'Persistent Queue Nearly Full',
    description: 'A persistent queue is more than 90% of its configured maximum size.',
    priority: 'P1',
    category: 'Persistent Queues',
    earliest: '-15m',
    cron: '*/15 * * * *',
    fires: 'PQ > 90% full',
    query: `dataset="cribl_metrics"
| where metric == "pq.queue_size"
| extend pq_target = iff(isnotempty(output), output, input)
| extend pq_type = iff(isnotempty(output), "output", "input")
| extend raw_max = iff(isnotempty(maxQueueSize), maxQueueSize, maxSourceQueueSize)
| where isnotempty(pq_target) and isnotempty(raw_max)
| summarize queued_bytes_peak = max(value) by worker_group, pq_target, pq_type, worker_node_hostname, raw_max
| extend max_bytes = case(
    raw_max endswith "GB", todouble(substring(raw_max, 0, strlen(raw_max) - 2)) * 1073741824,
    raw_max endswith "MB", todouble(substring(raw_max, 0, strlen(raw_max) - 2)) * 1048576,
    raw_max endswith "KB", todouble(substring(raw_max, 0, strlen(raw_max) - 2)) * 1024,
    0)
| where max_bytes > 0 and queued_bytes_peak > 0
| extend queued_gb = round(queued_bytes_peak / 1073741824.0, 2), max_gb = round(max_bytes / 1073741824.0, 2), pct_full = round((queued_bytes_peak / max_bytes) * 100, 1)
| where pct_full > 90
| project pq_type, worker_group, pq_target, worker_node_hostname, queued_gb, max_gb, pct_full
| order by pct_full desc`,
  },
  {
    id: 'criblvision_source_processing_errors',
    name: 'Source Processing Errors',
    description: 'A Source logged more than 10 processing errors in the last hour.',
    priority: 'P2',
    category: 'Sources & Destinations',
    earliest: '-1h',
    cron: '0 * * * *',
    fires: 'source logged > 10 errors',
    query: `dataset="cribl_metrics"
| where metric == "logged.errors"
| where isnotempty(input)
| summarize errors = sum(value) by worker_group, input, input_type, worker_node_hostname
| where errors > 10
| order by errors desc`,
  },
  {
    id: 'criblvision_source_failed_requests',
    name: 'Source Failed Requests',
    description: 'A Source had more than 10 failed requests in the last hour.',
    priority: 'P2',
    category: 'Sources & Destinations',
    earliest: '-1h',
    cron: '0 * * * *',
    fires: 'source had > 10 failed requests',
    query: `dataset="cribl_metrics"
| where metric == "iometrics.failed_requests"
| where isnotempty(input)
| summarize failed = sum(value) by worker_group, input, input_type, status_code, worker_node_hostname
| where failed > 10
| order by failed desc`,
  },
  {
    id: 'criblvision_worker_count_dropped',
    name: 'Worker Count Dropped',
    description:
      'A group has fewer connected workers in the last 15 minutes than it had earlier in the hour.',
    priority: 'P2',
    category: 'Worker Nodes',
    earliest: '-1h',
    cron: '*/15 * * * *',
    fires: 'fewer workers than earlier',
    query: `dataset="cribl_metrics"
| where metric == "system.num_workers"
| where isnotempty(worker_group)
| summarize workers_before = max(case(_time <= ago(15m), value, 0)), workers_now = min(case(_time > ago(15m), value, 1000000)) by worker_group, connectionType
| where workers_now < 1000000
| extend worker_drop = workers_before - workers_now
| where worker_drop > 0
| project worker_group, workers_before, workers_now, worker_drop
| order by worker_drop desc`,
  },
  {
    id: 'criblvision_worker_high_heap',
    name: 'Cribl Worker High Heap Memory',
    description: 'Cribl heap memory on a worker node went over 1 GB in the last hour.',
    priority: 'P3',
    category: 'Worker Nodes',
    earliest: '-1h',
    cron: '0 * * * *',
    fires: 'heap used > 1 GB',
    query: `dataset="cribl_metrics"
| where metric == "system.mem_heap_used"
| where isnotempty(worker_node_hostname)
| summarize max_heap = max(value) by worker_group, worker_node_hostname
| extend max_heap_gb = round(max_heap / 1073741824.0, 2)
| where max_heap > 1000000000
| order by max_heap_gb desc`,
  },
  {
    id: 'criblvision_worker_uneven_load',
    name: 'Uneven Worker Load',
    description: 'CPU load differs by more than 2.5x between worker nodes in the same group.',
    priority: 'P3',
    category: 'Worker Nodes',
    earliest: '-1h',
    cron: '0 * * * *',
    fires: 'node load imbalance > 2.5x',
    query: `dataset="cribl_metrics"
| where metric == "system.load_avg"
| where isnotempty(worker_group) and isnotempty(worker_node_hostname)
| summarize avg_load = round(avg(value), 2) by worker_group, worker_node_hostname
| summarize max_load = max(avg_load), min_load = min(avg_load), node_count = count() by worker_group
| where node_count > 1 and min_load > 0.01
| extend load_ratio = round(max_load / min_load, 2)
| where load_ratio > 2.5
| order by load_ratio desc`,
  },
  {
    id: 'criblvision_collector_task_errors',
    name: 'Collector Task Errors',
    description: 'Collector tasks failed more than 5 times in the last hour.',
    priority: 'P3',
    category: 'Collectors',
    earliest: '-1h',
    cron: '0 * * * *',
    fires: 'collector task errors > 5',
    query: `dataset="cribl_metrics"
| where metric == "jobs.task_errors"
| summarize errors = sum(value) by worker_group, worker_node_hostname
| where errors > 5
| order by errors desc`,
  },
  {
    id: 'criblvision_collector_jobs_stalled',
    name: 'Collector Jobs Stalled',
    description: 'More than 50 collection jobs were in flight at once — jobs may be stalled.',
    priority: 'P3',
    category: 'Collectors',
    earliest: '-1h',
    cron: '0 * * * *',
    fires: 'inflight jobs > 50',
    query: `dataset="cribl_metrics"
| where metric == "jobs.inflight_jobs"
| summarize max_inflight = max(value) by worker_group
| where max_inflight > 50
| order by max_inflight desc`,
  },
  {
    id: 'criblvision_high_ingest_rate',
    name: 'High Event Ingest Rate',
    description: 'A Source type in a group averaged more than 50,000 events/sec over the last hour.',
    priority: 'P3',
    category: 'Data Flow',
    earliest: '-1h',
    cron: '0 * * * *',
    fires: 'ingest > 50,000 events/sec',
    query: `dataset="cribl_metrics"
| where metric == "total.in_events"
| where isnotempty(input_type)
| summarize events_in = sum(value) by bin(_time, 5m), worker_group, input_type
| extend eps = events_in / 300
| summarize avg_eps = round(avg(eps), 2) by worker_group, input_type
| where avg_eps > 50000
| order by avg_eps desc`,
  },
  {
    id: 'criblvision_high_output_rate',
    name: 'High Event Output Rate',
    description: 'A group averaged more than 50,000 events/sec out over the last hour.',
    priority: 'P3',
    category: 'Data Flow',
    earliest: '-1h',
    cron: '0 * * * *',
    fires: 'output > 50,000 events/sec',
    query: `dataset="cribl_metrics"
| where metric == "total.out_events"
| where isnotempty(worker_group)
| summarize events_out = sum(value) by bin(_time, 5m), worker_group
| extend eps = events_out / 300
| summarize avg_eps = round(avg(eps), 2) by worker_group
| where avg_eps > 50000
| order by avg_eps desc`,
  },
];

/** Every alert the app ships, in display order (grouped by category). */
export const ALERT_CATALOG: AlertTemplate[] = ALERT_CATEGORIES.flatMap((c) =>
  [...CORE_CATALOG, ...HEALTH_CATALOG].filter((t) => t.category === c),
);

const MESSAGE = `Date: {{timestamp}}

A notification was triggered for the scheduled search: {{searchId}},
Tenant ID: {{tenantId}}
Search ID: {{savedQueryId}}.
Notification: {{notificationId}}`;

// Common schedules, offered as presets next to the raw cron field.
export const SCHEDULE_PRESETS: { cron: string; label: string }[] = [
  { cron: '* * * * *', label: 'Every minute' },
  { cron: '*/5 * * * *', label: 'Every 5 minutes' },
  { cron: '*/10 * * * *', label: 'Every 10 minutes' },
  { cron: '*/15 * * * *', label: 'Every 15 minutes' },
  { cron: '*/30 * * * *', label: 'Every 30 minutes' },
  { cron: '0 * * * *', label: 'Every hour' },
  { cron: '0 */6 * * *', label: 'Every 6 hours' },
  { cron: '0 0 * * *', label: 'Daily at 00:00 UTC' },
  { cron: '0 8 * * 1-5', label: 'Weekdays at 08:00 UTC' },
];

export const COMPARATORS: { value: string; label: string }[] = [
  { value: '>', label: 'greater than' },
  { value: '>=', label: 'greater than or equal to' },
  { value: '<', label: 'less than' },
  { value: '<=', label: 'less than or equal to' },
  { value: '==', label: 'equal to' },
  { value: '!=', label: 'not equal to' },
];

export const ATTACHMENT_TYPES: { value: AttachmentType; label: string }[] = [
  { value: 'inline', label: 'Inline table' },
  { value: 'csv', label: 'CSV' },
  { value: 'json', label: 'JSON' },
];
export type AttachmentType = 'inline' | 'csv' | 'json';

/** How an email target delivers the alert. */
export interface AlertEmail {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  includeResults: boolean;
  attachmentType: AttachmentType;
}

/**
 * Everything the notification attached to an alert can be configured with —
 * the same options Cribl Search offers on a scheduled search's notification.
 */
export interface AlertNotification {
  /** Fire on the result count, or on a custom expression over the results. */
  trigger:
    | { type: 'resultsCount'; comparator: string; count: number }
    | { type: 'custom'; expression: string };
  /** Notification-target ids the alert is sent to; at least one is required. */
  targets: string[];
  /** Settings for the email (SMTP) targets among `targets`. */
  email: AlertEmail;
  /** Message body; Cribl expands {{timestamp}}, {{searchId}} and friends. Empty means Cribl's default. */
  message: string;
}

export function sameNotification(a: AlertNotification, b: AlertNotification): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The shipped defaults for a catalog alert's notification. */
export function defaultNotification(
  t: AlertTemplate,
  priority: Priority,
  targets: string[],
  email: Partial<AlertEmail> = {},
): AlertNotification {
  return {
    trigger: { type: 'resultsCount', comparator: '>', count: 0 },
    targets,
    email: {
      to: '',
      cc: '',
      bcc: '',
      includeResults: true,
      attachmentType: 'inline',
      ...email,
      subject: subjectWithPriority(t.name, priority),
    },
    message: `${subjectWithPriority(t.name, priority)}\n\n${MESSAGE}`,
  };
}

/** The settings a live notification carries, in editable form. */
export function notificationOf(n: CriblNotification, smtpIds: Set<string>): AlertNotification {
  const conf = n.conf ?? {};
  const email = (n.targetConfigs ?? []).find((t) => smtpIds.has(t.id))?.conf;
  const attachment = String(email?.attachmentType ?? 'inline');
  return {
    trigger:
      conf.triggerType === 'custom'
        ? { type: 'custom', expression: String(conf.trigger ?? '') }
        : {
            type: 'resultsCount',
            comparator: String(conf.triggerComparator ?? '>'),
            count: Number(conf.triggerCount ?? 0),
          },
    targets: n.targets ?? [],
    email: {
      to: email?.emailRecipient?.to ?? '',
      cc: email?.emailRecipient?.cc ?? '',
      bcc: email?.emailRecipient?.bcc ?? '',
      subject: email?.subject ?? '',
      includeResults: email?.includeResults ?? true,
      attachmentType: (ATTACHMENT_TYPES.some((a) => a.value === attachment) ? attachment : 'inline') as AttachmentType,
    },
    message: typeof conf.message === 'string' ? conf.message : '',
  };
}

/** A copy of notification `n` carrying the settings `a`. */
export function applyNotification(
  n: CriblNotification,
  a: AlertNotification,
  smtpIds: Set<string>,
): CriblNotification {
  const { triggerType: _t, triggerComparator: _c, triggerCount: _n, trigger: _x, message: _m, ...rest } = n.conf ?? {};
  const trigger =
    a.trigger.type === 'custom'
      ? { triggerType: 'custom', trigger: a.trigger.expression }
      : { triggerType: 'resultsCount', triggerComparator: a.trigger.comparator, triggerCount: a.trigger.count };
  const { to, cc, bcc, subject, includeResults, attachmentType } = a.email;
  const edited: NotificationEmailConf = {
    subject,
    emailRecipient: { to, ...(cc ? { cc } : {}), ...(bcc ? { bcc } : {}) },
    includeResults,
    attachmentType,
  };
  const existing = new Map((n.targetConfigs ?? []).map((t) => [t.id, t.conf]));
  // Keep any per-target config Cribl stored for non-email targets.
  const kept = (n.targetConfigs ?? []).filter((t) => !smtpIds.has(t.id) && a.targets.includes(t.id));
  return {
    ...n,
    targets: a.targets,
    conf: { ...rest, ...trigger, ...(a.message ? { message: a.message } : {}) },
    // Email settings the editor does not show (for example a custom body) survive a save.
    targetConfigs: [
      ...kept,
      ...a.targets.filter((id) => smtpIds.has(id)).map((id) => ({ id, conf: { ...(existing.get(id) ?? {}), ...edited } })),
    ],
  };
}

/** The saved search + notification that enabling a catalog alert creates. */
export function buildAlert(
  t: AlertTemplate,
  priority: Priority,
  notification: AlertNotification,
  smtpIds: Set<string>,
): SavedSearch {
  const base: CriblNotification = {
    id: `${t.id}_notification_1`,
    disabled: false,
    condition: 'search',
    conf: { savedQueryId: t.id },
  };
  return {
    id: t.id,
    name: nameWithPriority(t.name, priority),
    description: t.description,
    query: t.query,
    earliest: t.earliest,
    latest: 'now',
    schedule: {
      enabled: true,
      cronSchedule: t.cron,
      tz: 'UTC',
      keepLastN: 2,
      notifications: { disabled: false, items: [applyNotification(base, notification, smtpIds)] },
    },
  };
}
