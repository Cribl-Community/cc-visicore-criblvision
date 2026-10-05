// Worker-group lens: health at a glance per group, with drill-down to a node.
// The deployment is a tree — groups hold nodes, and Sources/Destinations are
// configured per group — so these components roll health up to the group and
// let a click scope the app to one group or open one node.

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { WorkerNode } from '../api/types';
import { getNodeMetrics } from '../api/client';
import { useAsync } from '../hooks/useAsync';
import { countHealth, type HealthCounts } from '../lib/metrics';
import { nodeHealthy, type GroupStatus, type GroupSummary } from '../lib/fleet';
import { formatBytes, timeAgo } from '../lib/format';
import { HealthBadge, Meter } from './ui';
import { Sparkline } from './charts/Sparkline';

const STATUS_COLOR: Record<GroupStatus, string> = {
  Green: 'var(--ok)',
  Yellow: 'var(--warning)',
  Red: 'var(--critical)',
  Unknown: 'var(--surface-3)',
  Empty: 'var(--surface-3)',
};

const STATUS_LABEL: Record<GroupStatus, string> = {
  Green: 'Healthy',
  Yellow: 'Degraded',
  Red: 'Node down',
  Unknown: 'Status unavailable',
  Empty: 'No nodes',
};

/** Thin healthy / warning / unhealthy bar; segments are split by a surface gap. */
export function StackBar({ counts }: { counts: HealthCounts }) {
  return (
    <div className="stackbar" title={`${counts.Green} healthy · ${counts.Yellow} warning · ${counts.Red} unhealthy`}>
      {(['Red', 'Yellow', 'Green', 'Unknown'] as const).map(
        (h) => counts[h] > 0 && <span key={h} style={{ flex: counts[h], background: STATUS_COLOR[h] }} />,
      )}
    </div>
  );
}

/** Status as a colored mark plus a word — the text itself stays in ink. */
function Flag({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="flag">
      <i style={{ background: color }} />
      {children}
    </span>
  );
}

// ---- Host map -------------------------------------------------------------
// One small hexagon per node, a row per worker group / edge fleet, columns
// aligned so groups compare at a glance. Hexagons fill by health or by a
// utilization metric; the node table below each page is the same data as text.

type Fill = 'health' | 'cpu' | 'mem' | 'disk';
const FILLS: { id: Fill; label: string }[] = [
  { id: 'health', label: 'Health' },
  { id: 'cpu', label: 'CPU' },
  { id: 'mem', label: 'Memory' },
  { id: 'disk', label: 'Disk' },
];

// CPU and memory need one request per node, so only the first nodes are sampled.
const USAGE_MAX_NODES = 60;
const USAGE_RANGE_SEC = 900;
const NO_DATA = 'var(--surface-3)';

/** Utilization is magnitude, so one hue: the fuller the node, the stronger the fill. */
const PCT_SCALE: { below: number; label: string; color: string }[] = [
  { below: 50, label: '0–50%', color: 'var(--u1)' },
  { below: 75, label: '50–75%', color: 'var(--u2)' },
  { below: 90, label: '75–90%', color: 'var(--u3)' },
  { below: Infinity, label: '90%+', color: 'var(--u4)' },
];

function pctColor(pct: number | null | undefined): string {
  if (pct == null) return NO_DATA;
  return PCT_SCALE.find((b) => pct < b.below)?.color ?? NO_DATA;
}

function diskPct(w: WorkerNode): number | null {
  const { totalDiskSpace, freeDiskSpace } = w.info;
  return totalDiskSpace && freeDiskSpace != null ? (1 - freeDiskSpace / totalDiskSpace) * 100 : null;
}

function nodeName(w: WorkerNode): string {
  return w.info.hostname ?? w.id.slice(0, 14);
}

const HEX_R = 10;
const HEX_COLS = 24;

interface Hover {
  node: WorkerNode;
  x: number;
  y: number;
}

/** Nodes as a honeycomb strip: up to 24 per row, odd rows nested into the row above. */
function Honeycomb({
  nodes,
  colorOf,
  onHover,
  onSelect,
}: {
  nodes: WorkerNode[];
  colorOf: (w: WorkerNode) => string;
  onHover: (node: WorkerNode | null, el?: Element) => void;
  onSelect: (node: WorkerNode) => void;
}) {
  const r = HEX_R;
  const cols = Math.min(nodes.length, HEX_COLS);
  const rows = Math.ceil(nodes.length / cols);
  const w = Math.sqrt(3) * r;
  const width = cols * w + (rows > 1 ? w / 2 : 0);
  const height = (rows - 1) * 1.5 * r + 2 * r;
  // Drawn 1px short of the cell, so neighbours are split by a 2px surface gap.
  const corners = Array.from({ length: 6 }, (_, k) => {
    const a = (Math.PI / 180) * (60 * k - 30);
    return [(r - 1) * Math.cos(a), (r - 1) * Math.sin(a)] as const;
  });
  return (
    <svg className="hm-comb" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {nodes.map((node, i) => {
        const row = Math.floor(i / cols);
        const cx = (i % cols) * w + w / 2 + (row % 2 ? w / 2 : 0);
        const cy = row * 1.5 * r + r;
        return (
          <polygon
            key={node.id}
            className="hm-hex"
            points={corners.map(([x, y]) => `${(cx + x).toFixed(1)},${(cy + y).toFixed(1)}`).join(' ')}
            fill={colorOf(node)}
            role="button"
            tabIndex={0}
            aria-label={`Node ${nodeName(node)}`}
            onMouseEnter={(e) => onHover(node, e.currentTarget)}
            onMouseLeave={() => onHover(null)}
            onFocus={(e) => onHover(node, e.currentTarget)}
            onBlur={() => onHover(null)}
            onClick={() => onSelect(node)}
            onKeyDown={(e) => e.key === 'Enter' && onSelect(node)}
          />
        );
      })}
    </svg>
  );
}

/** Source or Destination health for one group: a thin bar and the count in words. */
function IOHealth({ counts, failed }: { counts: HealthCounts; failed: boolean }) {
  if (failed) return <span className="muted">Could not load</span>;
  if (counts.total === 0) return <span className="muted">—</span>;
  return (
    <div className="hm-io">
      <StackBar counts={counts} />
      <span className="hm-io-text">
        {counts.Green} of {counts.total} healthy
        {counts.Red > 0 && <Flag color="var(--critical)">{counts.Red} unhealthy</Flag>}
      </span>
    </div>
  );
}

/**
 * Host map of the deployment: a row per worker group or edge fleet, a hexagon
 * per node. Click a hexagon for the node, or a group's name to focus the app
 * on that group. Groups without connected nodes collapse into one line.
 */
export function HostMap({
  summaries,
  selected,
  onSelectGroup,
  onSelectNode,
  tick,
  showIO = true,
}: {
  summaries: GroupSummary[];
  /** Group the app is scoped to, or 'all'. */
  selected: string;
  onSelectGroup: (id: string) => void;
  onSelectNode: (node: WorkerNode) => void;
  /** Refresh counter; re-samples CPU / memory when it changes. */
  tick: number;
  /** Include each group's Source / Destination health columns. */
  showIO?: boolean;
}) {
  const [fill, setFill] = useState<Fill>('health');
  const [hover, setHover] = useState<Hover | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const live = summaries.filter((g) => g.status !== 'Empty');
  const empty = summaries.filter((g) => g.status === 'Empty');
  const allNodes = live.flatMap((g) => g.nodes);

  const sampled = allNodes.slice(0, USAGE_MAX_NODES).map((w) => w.id);
  const needsUsage = fill === 'cpu' || fill === 'mem';
  const usage = useAsync(
    async () => {
      if (!needsUsage) return null;
      const pairs = await Promise.all(
        sampled.map((id) =>
          getNodeMetrics(id, USAGE_RANGE_SEC)
            .then((pts) => {
              const last = (key: 'cpu' | 'memPct') => [...pts].reverse().find((p) => p[key] != null)?.[key] ?? null;
              return [id, { cpu: last('cpu'), mem: last('memPct') }] as const;
            })
            .catch(() => [id, { cpu: null, mem: null }] as const),
        ),
      );
      return new Map(pairs);
    },
    [needsUsage, sampled.join(','), tick],
  );

  const valueOf = (w: WorkerNode): number | null =>
    fill === 'disk' ? diskPct(w) : fill === 'health' ? null : (usage.data?.get(w.id)?.[fill] ?? null);
  const colorOf = (w: WorkerNode): string =>
    fill === 'health' ? (nodeHealthy(w) ? 'var(--ok)' : 'var(--critical)') : pctColor(valueOf(w));

  function onHover(node: WorkerNode | null, el?: Element) {
    if (!node || !el || !root.current) return setHover(null);
    const box = el.getBoundingClientRect();
    const origin = root.current.getBoundingClientRect();
    setHover({ node, x: box.left + box.width / 2 - origin.left, y: box.top - origin.top });
  }

  const sections = [
    { title: 'Worker Groups', groups: live.filter((g) => g.type !== 'edge') },
    { title: 'Edge Fleets', groups: live.filter((g) => g.type === 'edge') },
  ].filter((sec) => sec.groups.length > 0);
  const hovered = hover && usage.data?.get(hover.node.id);

  return (
    <div className="hm" ref={root}>
      <div className="hm-toolbar">
        <div className="hm-legend">
          {fill === 'health' ? (
            <>
              <Flag color="var(--ok)">Healthy</Flag>
              <Flag color="var(--critical)">Unhealthy or disconnected</Flag>
            </>
          ) : (
            <>
              <span className="hm-scale">
                {PCT_SCALE.map((b) => (
                  <span key={b.label}>
                    <i style={{ background: b.color }} />
                    {b.label}
                  </span>
                ))}
              </span>
              <Flag color={NO_DATA}>No data</Flag>
              {needsUsage && usage.loading && !usage.data && <span>Sampling nodes…</span>}
              {needsUsage && allNodes.length > USAGE_MAX_NODES && <span>First {USAGE_MAX_NODES} nodes sampled</span>}
            </>
          )}
        </div>
        <div className="pill-tabs" role="group" aria-label="Color nodes by">
          {FILLS.map((f) => (
            <button key={f.id} className={`pill-tab ${fill === f.id ? 'active' : ''}`} onClick={() => setFill(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {live.length === 0 ? (
        <div className="center-state">No group has a connected node</div>
      ) : (
        <div className={`hm-table${showIO ? '' : ' hm-nodes-only'}`}>
          {sections.map((sec, i) => (
            <Fragment key={sec.title}>
              {/* Column names once; later sections only need their title. */}
              <div className="hm-row hm-cols">
                <span>{sec.title}</span>
                {i === 0 && <span>Nodes</span>}
                {i === 0 && showIO && <span>Sources</span>}
                {i === 0 && showIO && <span>Destinations</span>}
              </div>
              {sec.groups.map((g) => (
                <div key={g.id} className={`hm-row${selected === g.id ? ' active' : ''}`}>
                  <button
                    className="hm-group"
                    title={selected === g.id ? 'Show all groups' : `Focus the app on ${g.id}`}
                    onClick={() => onSelectGroup(selected === g.id ? 'all' : g.id)}
                  >
                    <span className="hm-group-name">{g.id}</span>
                    <Flag color={STATUS_COLOR[g.status]}>
                      {g.status === 'Red' ? `${g.nodesDown} of ${g.nodes.length} nodes down` : STATUS_LABEL[g.status]}
                    </Flag>
                  </button>
                  <div className="hm-nodes">
                    <Honeycomb nodes={g.nodes} colorOf={colorOf} onHover={onHover} onSelect={onSelectNode} />
                    <span className="hm-count">{g.nodes.length}</span>
                  </div>
                  {showIO && <IOHealth counts={g.src} failed={g.ioFailed} />}
                  {showIO && <IOHealth counts={g.dst} failed={g.ioFailed} />}
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      )}

      {empty.length > 0 && (
        <div className="hm-empty">
          <span>
            {empty.length} group{empty.length === 1 ? '' : 's'} with no connected nodes
          </span>
          {empty.map((g) => (
            <button
              key={g.id}
              className={`chip${selected === g.id ? ' active' : ''}`}
              onClick={() => onSelectGroup(selected === g.id ? 'all' : g.id)}
            >
              {g.id}
            </button>
          ))}
        </div>
      )}

      {hover && (
        <div className="hm-tip" style={{ left: hover.x, top: hover.y }}>
          <div className="hm-tip-name">{nodeName(hover.node)}</div>
          <div className="hm-tip-sub">
            {hover.node.group} · {hover.node.disconnected ? 'disconnected' : hover.node.status}
          </div>
          <div className="hm-tip-values">
            {hovered?.cpu != null && (
              <span>
                <b>{hovered.cpu.toFixed(0)}%</b> CPU
              </span>
            )}
            {hovered?.mem != null && (
              <span>
                <b>{hovered.mem.toFixed(0)}%</b> memory
              </span>
            )}
            {diskPct(hover.node) != null && (
              <span>
                <b>{diskPct(hover.node)!.toFixed(0)}%</b> disk
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Per-group breakdown for a list page ------------------------------------
/** Health of one kind of object (Sources, Destinations…) split by worker group. */
export function GroupHealthList({
  rows,
  noun,
  nodeCounts,
  selected,
  onSelectGroup,
}: {
  /** Group id and health of every object on the page. */
  rows: { group: string; health: string | undefined }[];
  /** Plural name of the objects, e.g. "sources". */
  noun: string;
  /** Connected nodes per group; a group missing here has none. */
  nodeCounts: Map<string, number> | null;
  selected: string;
  onSelectGroup: (id: string) => void;
}) {
  const byGroup = new Map<string, (string | undefined)[]>();
  for (const r of rows) byGroup.set(r.group, [...(byGroup.get(r.group) ?? []), r.health]);
  const list = [...byGroup.entries()]
    .map(([id, healths]) => ({ id, counts: countHealth(healths) }))
    .sort((a, b) => b.counts.Red - a.counts.Red || b.counts.Yellow - a.counts.Yellow || a.id.localeCompare(b.id));

  if (list.length === 0) return <div className="center-state">No {noun}</div>;
  return (
    <div className="group-list">
      {selected !== 'all' && (
        <button className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => onSelectGroup('all')}>
          ← All groups
        </button>
      )}
      {list.map((g) => {
        const noNodes = nodeCounts != null && !nodeCounts.get(g.id);
        return (
          <button
            key={g.id}
            className={`group-row${selected === g.id ? ' active' : ''}`}
            onClick={() => onSelectGroup(selected === g.id ? 'all' : g.id)}
            title={`Show only ${g.id}`}
          >
            <span className="group-row-name">
              <span>{g.id}</span>
              {noNodes && <span className="type-chip">no nodes</span>}
            </span>
            <StackBar counts={g.counts} />
            <span className="group-row-count">
              {g.counts.Red > 0 ? <Flag color="var(--critical)">{g.counts.Red} unhealthy</Flag> : `${g.counts.total} ok`}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---- Node drawer ------------------------------------------------------------
// Nodes only keep about ten minutes of this history, whatever range is asked for.
const NODE_HISTORY_SEC = 900;

/** Detail for one worker / edge node: vitals plus its recent CPU and memory. */
export function NodeDrawer({
  node,
  onClose,
  onSelectGroup,
}: {
  node: WorkerNode;
  onClose: () => void;
  onSelectGroup: (id: string) => void;
}) {
  const history = useAsync(() => getNodeMetrics(node.id, NODE_HISTORY_SEC).catch(() => []), [node.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { info } = node;
  const diskPct =
    info.totalDiskSpace && info.freeDiskSpace != null ? (1 - info.freeDiskSpace / info.totalDiskSpace) * 100 : null;
  const points = history.data ?? [];
  const facts: [string, string][] = [
    ['Group', node.group],
    ['Version', info.cribl?.version ?? '—'],
    ['Worker processes', String(node.workerProcesses ?? '—')],
    ['CPUs', String(info.cpus ?? '—')],
    ['Memory', info.totalmem ? formatBytes(info.totalmem) : '—'],
    ['Platform', [info.platform, info.architecture].filter(Boolean).join(' / ') || '—'],
    ['Last heartbeat', node.lastMsgTime ? timeAgo(node.lastMsgTime, Date.now()) : '—'],
    ['Cribl started', info.cribl?.startTime ? timeAgo(info.cribl.startTime, Date.now()) : '—'],
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal node-drawer" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 650, fontSize: 15, wordBreak: 'break-all' }}>{info.hostname ?? node.id}</span>
          <HealthBadge
            health={nodeHealthy(node) ? 'Green' : 'Red'}
            label={node.disconnected ? 'Disconnected' : node.status}
          />
        </div>
        <div className="detail-grid" style={{ padding: 0 }}>
          {facts.map(([k, v]) => (
            <div key={k}>
              <div className="dk">{k}</div>
              <div className="dv">{v}</div>
            </div>
          ))}
        </div>
        <div className="node-trends">
          {(['cpu', 'memPct'] as const).map((key) => {
            const values = points.map((p) => p[key]);
            const last = [...values].reverse().find((v): v is number => v != null);
            return (
              <div key={key}>
                <div className="dk">{key === 'cpu' ? 'CPU · last 10 min' : 'Memory · last 10 min'}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {history.loading && !history.data ? (
                    <span className="muted">…</span>
                  ) : (
                    <Sparkline values={values} width={150} height={32} />
                  )}
                  <span className="mono">{last != null ? `${last.toFixed(0)}%` : '—'}</span>
                </div>
              </div>
            );
          })}
          <div>
            <div className="dk">Disk used</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 150 }}>
                <Meter pct={diskPct ?? 0} />
              </div>
              <span className="mono">{diskPct != null ? `${diskPct.toFixed(0)}%` : '—'}</span>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            className="btn"
            onClick={() => {
              onSelectGroup(node.group);
              onClose();
            }}
          >
            Show only {node.group}
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
