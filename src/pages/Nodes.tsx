import { useMemo, useState } from 'react';
import { useApp } from '../state/AppContext';
import { useAsync } from '../hooks/useAsync';
import { getWorkers, getSystemInfo, getNodeMetrics, type NodePoint } from '../api/client';
import { Card, StatTile, Loading, ErrorBanner, HealthBadge, Meter } from '../components/ui';
import { Sparkline } from '../components/charts/Sparkline';
import { HostMap, NodeDrawer } from '../components/FleetMap';
import { summarizeGroups } from '../lib/fleet';
import { formatBytes, formatDuration, timeAgo } from '../lib/format';
import type { WorkerNode } from '../api/types';

// Per-node metrics are one API call each, so cap how many nodes get sparklines
// and how far back they reach (long windows return huge sample sets).
const MAX_SPARK_NODES = 40;
const MAX_SPARK_RANGE_SEC = 24 * 3600;

// Per-group config & software-version drift, derived from data already loaded:
// a group is "drifting" when its nodes run more than one Cribl version, or run
// a version different from the leader's.
interface GroupDrift {
  id: string;
  configVersion?: string;
  upgradeVersion?: string;
  nodeCount: number;
  versions: string[];
  behindLeader: boolean;
}

function computeDrift(
  groups: { id: string; configVersion?: string; upgradeVersion?: string }[],
  nodes: WorkerNode[],
  leaderVersion: string | undefined,
): GroupDrift[] {
  const leaderShort = leaderVersion?.split('-')[0];
  return groups
    .map((g) => {
      const members = nodes.filter((w) => w.group === g.id);
      const versions = [...new Set(members.map((w) => w.info.cribl?.version).filter((v): v is string => !!v))];
      const behindLeader =
        !!leaderShort && versions.length > 0 && versions.some((v) => v.split('-')[0] !== leaderShort);
      return {
        id: g.id,
        configVersion: g.configVersion,
        upgradeVersion: g.upgradeVersion,
        nodeCount: members.length,
        versions,
        behindLeader,
      };
    })
    .filter((g) => g.nodeCount > 0)
    .sort((a, b) => Number(b.versions.length > 1 || b.behindLeader) - Number(a.versions.length > 1 || a.behindLeader));
}

export function Nodes() {
  const { group, setGroup, range, tick, groups } = useApp();
  const [openNode, setOpenNode] = useState<WorkerNode | null>(null);
  const workers = useAsync(() => getWorkers(), [tick]);
  const sys = useAsync(() => getSystemInfo(), [tick]);

  const nodes = useMemo(() => {
    const all = workers.data ?? [];
    return (group === 'all' ? all : all.filter((w) => w.group === group)).slice().sort((a, b) =>
      (a.info.hostname ?? a.id).localeCompare(b.info.hostname ?? b.id),
    );
  }, [workers.data, group]);

  const sparkIds = useMemo(
    () => nodes.slice(0, MAX_SPARK_NODES).map((w) => w.id),
    [nodes],
  );
  const sparkRange = Math.min(range.rangeSeconds, MAX_SPARK_RANGE_SEC);
  const nodeMetrics = useAsync<Record<string, NodePoint[]>>(
    async () => {
      const pairs = await Promise.all(
        sparkIds.map((id) =>
          getNodeMetrics(id, sparkRange)
            .then((pts) => [id, pts] as const)
            .catch(() => [id, [] as NodePoint[]] as const),
        ),
      );
      return Object.fromEntries(pairs);
    },
    [sparkIds.join(','), sparkRange, tick],
  );

  // Node health only here — Source / Destination health lives on the Overview map.
  const fleet = useMemo(
    () =>
      summarizeGroups(group === 'all' ? groups : groups.filter((g) => g.id === group), workers.data ?? [], [], []),
    [groups, group, workers.data],
  );

  const healthy = nodes.filter((w) => w.status === 'healthy' && !w.disconnected).length;
  const versions = useMemo(() => {
    const s = new Set<string>();
    nodes.forEach((w) => w.info.cribl?.version && s.add(w.info.cribl.version));
    return [...s];
  }, [nodes]);
  const totalWP = nodes.reduce((a, w) => a + (w.workerProcesses ?? 0), 0);
  const now = Date.now();
  const leader = sys.data;

  const drift = useMemo(
    () =>
      computeDrift(
        group === 'all' ? groups : groups.filter((g) => g.id === group),
        workers.data ?? [],
        leader?.BUILD?.VERSION,
      ),
    [groups, group, workers.data, leader?.BUILD?.VERSION],
  );
  const driftingGroups = drift.filter((g) => g.versions.length > 1 || g.behindLeader);

  function sparkCell(nodeId: string, key: 'cpu' | 'memPct') {
    const pts = nodeMetrics.data?.[nodeId];
    if (!pts || pts.length === 0) {
      return <span className="muted">{nodeMetrics.loading ? '…' : '—'}</span>;
    }
    const values = pts.map((p) => p[key]);
    const last = [...values].reverse().find((v): v is number => v != null);
    if (last == null) return <span className="muted">—</span>;
    const color = last > 90 ? 'var(--critical)' : last > 75 ? 'var(--warning)' : 'var(--good)';
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Sparkline values={values} color={color} />
        <span className="mono muted" style={{ fontSize: 11, width: 34 }}>
          {last.toFixed(0)}%
        </span>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-4">
        <StatTile label="Nodes" value={String(nodes.length)} accent="var(--accent)" />
        <StatTile
          label="Healthy"
          value={`${healthy}/${nodes.length}`}
          accent={healthy === nodes.length ? 'var(--good)' : 'var(--critical)'}
        />
        <StatTile label="Worker Processes" value={String(totalWP)} accent="var(--series-in)" />
        <StatTile
          label="Versions"
          value={String(versions.length)}
          accent={versions.length > 1 ? 'var(--warning)' : 'var(--good)'}
          foot={versions.length > 1 ? <span>version drift</span> : <span>all aligned</span>}
        />
      </div>

      {leader && (
        <Card title="Leader" note={leader.BUILD?.VERSION ?? leader.distMode}>
          <div className="grid grid-4">
            <div className="kv">
              <span className="k">Hostname</span>
              <span className="v" style={{ fontVariant: 'normal' }}>
                {leader.hostname ?? '—'}
              </span>
            </div>
            <div className="kv">
              <span className="k">Uptime</span>
              <span className="v">{leader.uptime ? formatDuration(leader.uptime) : '—'}</span>
            </div>
            <div className="kv">
              <span className="k">Load avg</span>
              <span className="v">{leader.loadavg?.map((n) => n.toFixed(2)).join(' ') ?? '—'}</span>
            </div>
            <div className="kv">
              <span className="k">Memory used</span>
              <span className="v">
                {leader.memory?.total && leader.memory?.free
                  ? `${(((leader.memory.total - leader.memory.free) / leader.memory.total) * 100).toFixed(0)}%`
                  : '—'}
              </span>
            </div>
          </div>
        </Card>
      )}

      <Card
        title="Config & Version Drift"
        note={
          driftingGroups.length > 0
            ? `${driftingGroups.length} group${driftingGroups.length === 1 ? '' : 's'} drifting`
            : 'all groups aligned'
        }
      >
        {workers.loading && !workers.data ? (
          <Loading height={120} />
        ) : drift.length === 0 ? (
          <div className="center-state">No groups with connected nodes for this selection</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="no-sort">Group</th>
                  <th className="no-sort num">Nodes</th>
                  <th className="no-sort">Committed Config</th>
                  <th className="no-sort">Node Versions</th>
                  <th className="no-sort">Leader {leader?.BUILD?.VERSION ?? ''}</th>
                  <th className="no-sort">Pending Upgrade</th>
                </tr>
              </thead>
              <tbody>
                {drift.map((g) => {
                  const mixed = g.versions.length > 1;
                  return (
                    <tr key={g.id}>
                      <td className="id-cell">{g.id}</td>
                      <td className="num">{g.nodeCount}</td>
                      <td className="mono muted">{g.configVersion?.slice(0, 9) ?? '—'}</td>
                      <td>
                        {g.versions.length === 0 ? (
                          <span className="muted">—</span>
                        ) : (
                          g.versions.map((v) => (
                            <span
                              key={v}
                              className="type-chip"
                              style={mixed ? { color: 'var(--warning)' } : undefined}
                            >
                              {v.split('-')[0]}
                            </span>
                          ))
                        )}
                      </td>
                      <td>
                        {mixed ? (
                          <HealthBadge health="Yellow" label="Mixed versions" />
                        ) : g.behindLeader ? (
                          <HealthBadge health="Yellow" label="Behind leader" />
                        ) : (
                          <HealthBadge health="Green" label="Aligned" />
                        )}
                      </td>
                      <td className="mono muted">{g.upgradeVersion ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Node Map" note="one hexagon per node · click one for its detail">
        {workers.loading && !workers.data ? (
          <Loading height={140} />
        ) : (
          <HostMap
            summaries={fleet}
            selected={group}
            onSelectGroup={setGroup}
            onSelectNode={setOpenNode}
            tick={tick}
            showIO={false}
          />
        )}
      </Card>

      <Card title="Worker & Edge Nodes">
        {workers.loading && !workers.data ? (
          <Loading />
        ) : workers.error ? (
          <ErrorBanner message={workers.error} />
        ) : nodes.length === 0 ? (
          <div className="center-state">No connected nodes for this selection</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="no-sort">Host</th>
                  <th className="no-sort">Group</th>
                  <th className="no-sort">Status</th>
                  <th className="no-sort" style={{ minWidth: 130 }}>
                    CPU
                  </th>
                  <th className="no-sort" style={{ minWidth: 130 }}>
                    Mem
                  </th>
                  <th className="no-sort num">CPUs</th>
                  <th className="no-sort num">WP</th>
                  <th className="no-sort num">Memory</th>
                  <th className="no-sort" style={{ minWidth: 150 }}>
                    Disk used
                  </th>
                  <th className="no-sort">Version</th>
                  <th className="no-sort">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((w) => {
                  const diskPct =
                    w.info.totalDiskSpace && w.info.freeDiskSpace
                      ? (1 - w.info.freeDiskSpace / w.info.totalDiskSpace) * 100
                      : 0;
                  return (
                    <tr key={w.id} className="row-expandable" onClick={() => setOpenNode(w)}>
                      <td className="id-cell">{w.info.hostname ?? w.id.slice(0, 14)}</td>
                      <td>
                        <span className="type-chip">{w.group}</span>
                      </td>
                      <td>
                        <HealthBadge
                          health={w.status === 'healthy' && !w.disconnected ? 'Green' : 'Red'}
                          label={w.disconnected ? 'Disconnected' : w.status}
                        />
                      </td>
                      <td>{sparkCell(w.id, 'cpu')}</td>
                      <td>{sparkCell(w.id, 'memPct')}</td>
                      <td className="num">{w.info.cpus ?? '—'}</td>
                      <td className="num">{w.workerProcesses ?? '—'}</td>
                      <td className="num">{w.info.totalmem ? formatBytes(w.info.totalmem) : '—'}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Meter pct={diskPct} />
                          <span className="mono muted" style={{ fontSize: 11, width: 34 }}>
                            {diskPct ? `${diskPct.toFixed(0)}%` : '—'}
                          </span>
                        </div>
                      </td>
                      <td className="mono muted">{w.info.cribl?.version ?? '—'}</td>
                      <td className="muted">{w.lastMsgTime ? timeAgo(w.lastMsgTime, now) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {openNode && <NodeDrawer node={openNode} onClose={() => setOpenNode(null)} onSelectGroup={setGroup} />}
    </>
  );
}
