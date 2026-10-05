// Shared data shapes returned by the Cribl REST API (trimmed to what the app uses).

export type Health = 'Green' | 'Yellow' | 'Red' | 'Unknown';

export interface Group {
  id: string;
  name?: string;
  description?: string;
  type: 'stream' | 'edge' | 'search' | 'outpost' | string;
  isFleet?: boolean;
  onPrem?: boolean;
  provisioned?: boolean;
  estimatedIngestRate?: number;
  cloud?: { provider?: string; region?: string };
  /** Committed config version (short git hash). */
  configVersion?: string;
  /** Target Cribl version when a group upgrade is pending. */
  upgradeVersion?: string;
}

export interface WorkerNode {
  id: string;
  status: string; // "healthy" | ...
  group: string;
  workerProcesses?: number;
  lastMsgTime?: number;
  disconnected?: boolean;
  info: {
    hostname?: string;
    platform?: string;
    architecture?: string;
    cpus?: number;
    totalmem?: number;
    totalDiskSpace?: number;
    freeDiskSpace?: number;
    startTime?: number;
    cribl?: { version?: string; startTime?: number };
  };
}

export interface IOStatus {
  id: string;
  type: string;
  status: {
    timestamp?: number;
    health?: Health;
    healthCounts?: Record<string, number>;
    metrics?: Record<string, number>;
  };
}

/** One time-bucket row from POST /system/metrics/query. */
export interface MetricRow {
  starttime: number; // epoch seconds
  endtime: number; // epoch seconds
  [alias: string]: number | string | undefined;
}

export interface LicenseUsageDay {
  startTime: number; // epoch ms
  endTime: number; // epoch ms
  inBytes: number;
  outBytes: number;
  inEvents: number;
  outEvents: number;
  exemptedLicenseInBytes?: number;
}

export type Severity = 'error' | 'warn' | 'info';

export interface SystemMessage {
  id: string;
  severity: Severity;
  title: string;
  text: string;
  time: number; // epoch ms
  group?: string;
  workerId?: string;
  metadata?: unknown;
}

/** One job instance from GET /m/:gid/jobs (collection runs, scheduled or ad hoc). */
export interface CollectionJob {
  id: string;
  keep?: boolean;
  args?: {
    id?: string;
    type?: string; // "collection" | "executor" | ...
    description?: string;
    groupId?: string;
    collector?: { type?: string };
    schedule?: { cronSchedule?: string; enabled?: boolean };
  };
  status?: { state?: string; reason?: string };
  stats?: {
    tasks?: {
      finished?: number;
      failed?: number;
      cancelled?: number;
      orphaned?: number;
      inFlight?: number;
      count?: number;
      totalExecutionTime?: number;
    };
    /** State-name → epoch-ms timestamp of when the job entered that state. */
    state?: Record<string, number>;
    collectedBytes?: number;
    collectedEvents?: number;
    discoveredEvents?: number;
    totalResults?: number;
  };
}

/** One task error from GET /m/:gid/jobs/:id/errors. */
export interface JobError {
  timestamp?: number; // epoch ms
  taskId?: string;
  error?: {
    name?: string;
    message?: string;
    stack?: string;
    reason?: { message?: string; stack?: string };
  };
}

/** A configured notification target (GET /notification-targets). */
export interface NotificationTarget {
  id: string;
  type: string; // "smtp" | "bulletin_message" | "webhook" | ...
  status?: { health?: Health; metrics?: Record<string, number> };
}

/** Email settings for one target inside a Notification's targetConfigs. */
export interface NotificationEmailConf {
  subject?: string;
  body?: string;
  emailRecipient?: { to?: string; cc?: string; bcc?: string };
  /** Search alerts only: attach the triggering result rows to the email. */
  includeResults?: boolean;
  attachmentType?: string;
}

/** A native Cribl Notification (condition → targets), group-scoped. */
export interface CriblNotification {
  id: string;
  condition: string;
  disabled?: boolean;
  targets?: string[];
  /** Condition-specific config (name, timeWindow, dataVolume, usageThreshold…). */
  conf?: Record<string, unknown>;
  targetConfigs?: { id: string; conf?: NotificationEmailConf }[];
}

/**
 * A Cribl Search saved search. With a schedule and at least one notification
 * it acts as an alert: Cribl runs the query on the cron and emails when the
 * trigger condition matches.
 */
export interface SavedSearch {
  id: string;
  name?: string;
  description?: string;
  query: string;
  earliest?: string;
  latest?: string;
  schedule?: {
    enabled?: boolean;
    cronSchedule?: string;
    tz?: string;
    keepLastN?: number;
    notifications?: { disabled?: boolean; items?: CriblNotification[] };
  };
}

export interface SystemInfo {
  BUILD?: { VERSION?: string; BRANCH?: string; TIMESTAMP?: string };
  hostname?: string;
  uptime?: number;
  loadavg?: number[];
  memory?: { free?: number; total?: number };
  workerProcesses?: number;
  distMode?: string;
}
