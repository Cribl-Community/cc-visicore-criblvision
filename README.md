# CriblVision

**Health monitoring for Cribl deployments.**

![CriblVision — Deployment Overview](https://raw.githubusercontent.com/Cribl-Community/cc-visicore-criblvision/main/docs/overview.png)

## Install

CriblVision runs on the Cribl App Platform, which is part of Cribl.Cloud.

Install it from the Cribl Packs Dispensary, or grab the app archive from the
[latest release](https://github.com/Cribl-Community/cc-visicore-criblvision/releases/latest)
and in Cribl go to **Manage → App Platform → Add App → Import from File** to upload the
`.tgz`. **Import from URL** also works: paste the `.tgz` link copied from that release page.

Once installed and shared, the app runs on live data automatically — no configuration
needed. Alerts are opt-in: nothing is created in your workspace until you enable one.

A Cribl App Platform app that gives Stream administrators a single, real‑time view of
deployment health. Where the original [CriblVision Pack](https://packs.cribl.io/packs/cribl-criblvision-for-stream)
re‑implemented the same dashboards three times (Cribl Search / Splunk / Grafana), this
is one self‑contained web app that talks directly to the Cribl REST API — the dashboards
run no Search executions and there is no external backend.

## Dashboards

| Page | What it shows |
|---|---|
| **Overview** | KPI tiles (data in/out, reduction, healthy nodes), a **host map** of Worker Groups and Edge Fleets — one hexagon per node, clustered by group, filled by health, CPU, memory, or disk, with each group's Source / Destination health underneath; click a group name to focus the whole app on it or a hexagon for that node's vitals — live throughput chart, Source/Destination health donuts, top sources / destinations / routes, node table |
| **Throughput** | Bytes/events in‑out time series (toggle), dropped‑events trend, per‑group volume & reduction table |
| **Data WP Introspection** | Events and bytes in / out over time, split by Source or by worker process, plus **CPU % by worker process** — narrow to specific Sources and Destinations with searchable dropdowns |
| **Sizing Calculator** | Estimates the **worker processes you need** from observed throughput and a per-vCPU capacity you set (CPU type and speed) — total throughput, time spent at ≥ 90% CPU by worker process, and processes required by day |
| **Log Analytics** | Internal log lines by level over time, a level breakdown, the top channel / message pairs, and the raw events — filter by level or search text; click **Errors** or **Warnings** to narrow to that level |
| **Commit Audit Log** | Git-backed config history: commits over time, authors, and the commit list, filterable |
| **Persistent Queue Analytics** | Engaged persistent queues, total queue size, what is backpressured right now, queue size by Source / Destination over time, and the persistent-queue log lines |
| **Route/Pipeline Reductions** | Bytes and events in vs out — and how much each **route or pipeline** removes — with I/O over time and a per-route / per-pipeline breakdown; pick one from the dropdown or by typing its name |
| **Sources** | Every Source with live health, type, volume in, events, **persistent-queue depth, and backpressure state** — searchable, filterable by health, sortable, expandable to status detail + related error notifications + a deep link into Cribl Stream — plus a **health-by-worker-group** breakdown (groups with no connected nodes are flagged) and, in each row's drill-in, the **node log lines** that say why it is unhealthy |
| **Routes** | **Route Health**: routes that reported data in the window but have gone silent past a configurable stall threshold — stalled-first sorting, silent-for durations, and a deep link to the group's routing table |
| **Pipelines** | Per-pipeline events in/out, **dropped counts, drop %, and processing errors**, with a Top Droppers panel — spot the pipeline silently eating your events |
| **Destinations** | Every Destination with health, volume out, **dropped** counts, **persistent-queue depth, and backpressure state** (engaged now / earlier in window) — expandable to status detail + related errors + a deep link into Cribl Stream — with the same **health-by-worker-group** breakdown and **node log lines** as Sources |
| **Collectors** | Collection & scheduled job runs across groups — state, **failed-task counts**, cron schedules, events/bytes collected, filterable to failures and in-flight runs, **expandable to the actual task errors** (message + stack trace) |
| **Worker Nodes** | The same **host map** for nodes, then a worker & edge fleet health matrix — **CPU & memory trend sparklines per node**, disk, worker processes, last heartbeat, leader vitals, and a **Config & Version Drift** panel (committed config version, mixed-version and behind-leader detection per group) |
| **Alerts** | **Alerting** — an **Alert Catalog** of 23 ready-made P1 / P2 / P3 alerts (worker not reporting, no data ingested, unhealthy sources / destinations, blocked outputs, persistent-queue depth, high disk / memory and more) you enable with one click and deliver as a Cribl system notification, an email, or both; a status view of every scheduled-search alert in the workspace; plus native Cribl Notifications (destination unhealthy / backpressure / PQ usage, source no-data / volume thresholds). Cribl evaluates everything server-side, so alerts fire even with the dashboard closed — see [Alerts](#alerts) |
| **Notifications** | System errors / warnings / info (failed source inits, zero-volume routes) and fired alerts, titled by the alert and its priority — last 7 days by default, filterable, searchable, expandable to full detail |
| **Data Value** | Ingest vs delivery ROI: reduction %, estimated savings at your $/GB, monthly/annual projections, 45‑day daily trend, and **License Headroom** — daily ingest trended against the licensed quota with a days‑to‑quota projection |

A global **group** selector (all groups / any stream group / edge fleet), a **time‑range**
selector (1h · 6h · 24h · 7d), and 30‑second auto‑refresh apply across every page.
Summary tiles are clickable wherever a page can break the number down — for example
**Unhealthy** or **Backpressured** on Destinations, **Failed** on Collectors, **Stalled
Routes**, **Errors** on Notifications — and the Overview tiles open the page behind them.
Selections (group, range, stall threshold, $/GB rate, alert email recipient) persist in
the app's scoped KV store (localStorage in demo mode).

## Alerts

CriblVision sets alerts up through the Cribl REST API and Cribl itself evaluates and
delivers them. The app never routes, copies, or indexes your event data anywhere — it
creates no datasets, pipelines, routes, or destinations.

**Alert Catalog.** 23 alerts ship with the app. None is active until you enable it, and
no recipient is shipped. Clicking **Enable** opens a popup where you pick the priority
and how to be notified: an in-product **system notification**, an **email**, or both.

| Category | Alerts (default priority) |
|---|---|
| Worker Nodes | Worker Node Not Reporting to Leader (P1) · Worker Node Status Unhealthy — a node that keeps reconnecting (P1) · High Disk Utilization (P2) · High Memory Utilization (P2) · Worker Count Dropped (P2) · High Heap Memory (P3) · Uneven Worker Load (P3) |
| Data Flow | No Data Ingested (P1) · No Events Ingested (P1) · Route Zero-Volume Catch-All (P2) · High Event Ingest Rate (P3) · High Event Output Rate (P3) |
| Sources & Destinations | Source Health Unhealthy (P1) · Destination Health Unhealthy (P1) · Destination Blocked (P1) · Destination Backpressure (P2) · Destination Dropped Events (P2) · Source Processing Errors (P2) · Source Failed Requests (P2) |
| Persistent Queues | Persistent Queue Nearly Full (P1) · Persistent Queue Buffering (P2) |
| Collectors | Collector Task Errors (P3) · Collector Jobs Stalled (P3) |

- **How an alert runs.** Enabling one makes two API calls: it creates a scheduled search
  in Cribl Search and attaches a notification to it. On each run Cribl reads a built-in
  dataset — `cribl_metrics`, the internal metrics Cribl.Cloud keeps about its own Worker
  Groups, or `cribl_internal_logs`, the Leader's own log (used to spot nodes that keep
  reconnecting) — and notifies you with the matching rows. Only Cribl's own health data
  is read, never your events, and no extra data source has to be set up.
- **Any worker group.** The queries group by `worker_group` and hard-code no group name,
  so Cribl-managed and hybrid groups are covered alike.
- **Priorities.** The P1 / P2 / P3 label lives on the alert itself: the saved search is
  named `P1 - …`, and the notification and email subject start with `[P1]`, so the
  priority is visible in Cribl Search, in the notification, and in the inbox. Change it
  from the Alerts page at any time — including on alerts you created outside the app.
- **Scheduled Search Alerts.** The same page lists every scheduled search with a
  notification in the workspace — trigger, schedule, where it notifies, active or
  turned off — and lets you turn them off and on, label them, and drill in. Click any
  row (here or in the catalog) to see the search behind the alert, **Run search** to see
  the rows it returns right now, and edit the query, look-back, or schedule in place.
- **Make it yours.** Edits to an alert's query, look-back, or schedule are kept when you
  enable it, and **Reset to default** brings the shipped version back. **Clone** creates
  a separate alert under your own name that you can change freely; alerts the app
  created can be removed from the same page.
- **Source & Destination Alerts.** Native Cribl Notifications, evaluated by the Leader
  with no search at all.

Scheduled searches use Cribl Search credits each time they run; the schedule of an
enabled alert can be changed in Cribl Search. System notifications appear in Cribl's
notification list (and on the app's Notifications page); email is delivered through the
`system_email` notification target that Cribl.Cloud provides.

## How it works

The app runs sandboxed inside Cribl and uses the platform fetch proxy — it never handles
auth tokens. All access is declared in `config/policies.yml`; monitoring calls are
read‑only, and the only writes are behind the Alerts page (Notification CRUD and the
alert catalog's scheduled searches):

- `POST /system/metrics/query` — throughput / dropped / route / pipeline / persistent‑queue / backpressure metrics
- `GET /master/workers`, `/master/groups` — node & group inventory (incl. committed config versions)
- `GET /w/:wid/system/metrics` — per‑node recent CPU / memory (sparklines, host map, node panel)
- `GET /m/:gid/system/inputs|outputs` — per‑group Source/Destination config + authoritative health
- `GET /m/:gid/jobs` — collection & scheduled job runs (states, failed tasks, cron)
- `GET /notification-targets` — SMTP target inventory & delivery stats for the Alerts page
- `GET|POST|PATCH|DELETE /m/:gid/notifications` — the native Cribl Notifications that power email alerts
- `GET|POST|PATCH|DELETE /m/default_search/search/saved` (+ `/:id/notifications`) — the scheduled searches behind the alert catalog, and their P1 / P2 / P3 labels
- `POST /m/default_search/search/jobs`, `GET …/jobs/:id` and `…/results` — the one-off **Run search** in an alert's drill-in
- `GET /w/:wid/system/logs/*` — what a node logged about one Source / Destination (the "why" in its drill-in)
- `GET /system/logs/search` — each worker group's internal log, for Log Analytics and Persistent Queue Analytics
- `GET /version`, `/version/show` — git-backed config commits, for the Commit Audit Log
- `GET /system/messages` — system notifications (errors / warnings / info)
- `GET /system/info`, `/system/licenses/usage`, `/system/licenses` — leader vitals, daily usage & quota
- App‑scoped KV store (`/kvstore/vision/prefs`) — persisted UI preferences

When run standalone (`npm run dev`, no Cribl host) it falls back to captured demo
fixtures in `public/fixtures.json`, so the full UI is viewable without a live leader — a
**DEMO DATA** badge is shown in that mode.

## Develop

```bash
npm install
npm run dev        # standalone dev server with demo fixtures
npm run build      # type-check + production build
npm run lint       # oxlint
npm run package    # build + create the installable app archive (bumps version)
```

Install the resulting archive from **Cribl → Manage → App Platform**. Once installed,
`window.CRIBL_API_URL` is present and the app switches to live data automatically.

## Structure

```
src/
  api/        client.ts (live + fixture data layer), types.ts
  state/      AppContext.tsx (group / range / refresh)
  hooks/      useAsync.ts (polling fetch)
  lib/        format.ts, metrics.ts, routeHealth.ts, prefs.ts, alertCatalog.ts, fleet.ts
  components/ Layout, ui primitives, FleetMap (host map, per-group health, node panel),
              charts/ (TimeSeriesChart, HealthDonut, Sparkline)
  pages/      Overview, Throughput, DataWpIntrospection, SizingCalculator, LogAnalytics,
              CommitAuditLog, PersistentQueueAnalytics, RoutePipelineReductions,
              Sources + Destinations (IOPage), RouteHealth, Pipelines, Jobs,
              Alerts (SearchAlerts = alert catalog), Nodes, Notifications, DataValue
config/       policies.yml (declared API access), proxies.yml
```
