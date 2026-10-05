import { Fragment, useMemo, useState } from 'react';
import { useApp, useGroupIds } from '../state/AppContext';
import { useAsync } from '../hooks/useAsync';
import {
  getIOStatuses,
  getIOVolumes,
  getMessages,
  getOutputPQStats,
  getInputPQStats,
  streamLink,
  type OutputPQStat,
} from '../api/client';
import type { SystemMessage } from '../api/types';
import { getIOLogs, getWorkers } from '../api/client';
import { Card, StatTile, Loading, ErrorBanner, HealthBadge } from '../components/ui';
import { GroupHealthList } from '../components/FleetMap';
import { nodeHealthy } from '../lib/fleet';
import { countHealth, normHealth } from '../lib/metrics';
import { formatBytes, formatCount, formatTime, timeAgo } from '../lib/format';

const IO_LOG_RANGE_SEC = 3600;
const IO_LOG_ROWS = 6;

/** What the group's nodes logged about one Source/Destination in the last hour. */
function RelatedLogs({ kind, id, group }: { kind: 'input' | 'output'; id: string; group: string }) {
  // Loaded once when the row is opened — these are several node requests, so
  // they don't ride the 30s auto-refresh.
  const logs = useAsync(() => getIOLogs(kind, id, group, IO_LOG_RANGE_SEC), [kind, id, group]);
  const now = Date.now();
  return (
    <>
      <div className="section-title" style={{ margin: '14px 0 8px' }}>
        Node Log · last hour
      </div>
      {logs.loading && !logs.data ? (
        <div className="muted" style={{ fontSize: 12.5 }}>
          Reading node logs…
        </div>
      ) : logs.error ? (
        <div className="muted" style={{ fontSize: 12.5 }}>
          Could not read node logs: {logs.error}
        </div>
      ) : !logs.data || logs.data.nodes === 0 ? (
        <div className="muted" style={{ fontSize: 12.5 }}>
          This group has no connected nodes, so there is no node log to read.
        </div>
      ) : logs.data.groups.length === 0 ? (
        <div className="muted" style={{ fontSize: 12.5 }}>
          Nothing logged about this {kind === 'input' ? 'source' : 'destination'} on {logs.data.nodes} node
          {logs.data.nodes === 1 ? '' : 's'} in the last hour.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {logs.data.groups.slice(0, IO_LOG_ROWS).map((g, i) => (
            <div key={i} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
              <span
                className={`sev ${g.level === 'error' ? 'sev-error' : g.level === 'warn' ? 'sev-warn' : 'sev-info'}`}
                style={{ marginTop: 1 }}
              >
                {g.level}
              </span>
              <div style={{ fontSize: 13, minWidth: 0 }}>
                <div>
                  {g.message}
                  <span className="muted" style={{ fontSize: 12 }}>
                    {' '}
                    · {g.count}× · last {g.last ? timeAgo(g.last, now) : '—'} · {g.hosts.join(', ')}
                  </span>
                </div>
                {g.reason && (
                  <div className="mono muted" style={{ fontSize: 12, wordBreak: 'break-word' }}>
                    {g.reason}
                  </div>
                )}
              </div>
            </div>
          ))}
          {logs.data.groups.length > IO_LOG_ROWS && (
            <div className="muted" style={{ fontSize: 12 }}>
              + {logs.data.groups.length - IO_LOG_ROWS} more distinct messages
            </div>
          )}
        </div>
      )}
    </>
  );
}

interface Row {
  id: string;
  group: string;
  type: string;
  health: string | undefined;
  bytes: number;
  events: number;
  dropped: number;
  /** Current persistent-queue depth in bytes (destinations only). */
  pqBytes: number;
  /** 2 = backpressure engaged now, 1 = engaged earlier in window, 0 = none. */
  bpState: number;
  pq?: OutputPQStat;
  metrics: Record<string, number>;
  timestamp?: number;
  message?: string;
}

type SortKey = 'id' | 'group' | 'type' | 'health' | 'bytes' | 'events' | 'dropped' | 'pqBytes' | 'bpState';
const HEALTH_ORDER: Record<string, number> = { Red: 0, Yellow: 1, Green: 2, Unknown: 3 };

export function IOPage({ kind }: { kind: 'source' | 'destination' }) {
  const { group, setGroup, range, tick } = useApp();
  const groupIds = useGroupIds();
  const idKey = groupIds.join(',');
  const isSource = kind === 'source';

  const loaded = useAsync(() => getIOStatuses(isSource ? 'input' : 'output', groupIds), [idKey, tick, kind]);
  const status = { ...loaded, data: loaded.data?.items ?? null };
  const failedGroups = loaded.data?.failed ?? [];
  const volumes = useAsync(
    () => getIOVolumes(isSource ? 'input' : 'output', group, range.rangeSeconds),
    [group, range.id, tick, kind],
  );
  const msgs = useAsync<SystemMessage[]>(() => getMessages(), [tick]);
  // Backpressure & persistent-queue stats — sources spool to PQ too (Always On /
  // Smart mode), so both sides get coverage, each split by its own dimension.
  const pqStats = useAsync<OutputPQStat[]>(
    () =>
      isSource
        ? getInputPQStats(group, range.rangeSeconds, range.bucketSeconds)
        : getOutputPQStats(group, range.rangeSeconds, range.bucketSeconds),
    [group, range.id, tick, kind],
  );

  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'Red' | 'Yellow' | 'Green' | 'bp'>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'bytes', dir: -1 });
  const [open, setOpen] = useState<Set<string>>(new Set());

  function toggle(key: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Correlate an IO item with system notifications that name it. Match the id as a
  // quoted token (e.g. Failed to initialize Source "win-data-gen") in the same group
  // (or an ungrouped/global message) to avoid false substring hits.
  function relatedMessages(id: string, grp: string): SystemMessage[] {
    const quoted = `"${id}"`;
    return (msgs.data ?? []).filter(
      (m) =>
        (m.severity === 'error' || m.severity === 'warn') &&
        (m.group === grp || !m.group) &&
        ((m.title ?? '').includes(quoted) || (m.text ?? '').includes(quoted)),
    );
  }

  const pqByKey = useMemo(() => {
    const m = new Map<string, OutputPQStat>();
    for (const s of pqStats.data ?? []) m.set(`${s.group}::${s.id}`, s);
    return m;
  }, [pqStats.data]);

  const rows: Row[] = useMemo(() => {
    const list = (status.data ?? []).map((s) => {
      const v = volumes.data?.get(`${s.group}::${s.id}`);
      const pq = pqByKey.get(`${s.group}::${s.id}`);
      return {
        id: s.id,
        group: s.group,
        type: s.type,
        health: s.status?.health,
        bytes: v?.bytes ?? 0,
        events: v?.events ?? 0,
        dropped: Number(s.status?.metrics?.numDropped ?? 0),
        pqBytes: pq?.pqBytes ?? 0,
        bpState: pq?.backpressureNow ? 2 : pq && pq.backpressureBuckets > 0 ? 1 : 0,
        pq,
        metrics: s.status?.metrics ?? {},
        timestamp: s.status?.timestamp,
        message: (s.status as { message?: string })?.message,
      };
    });
    return list;
  }, [status.data, volumes.data, pqByKey]);

  const counts = countHealth(rows.map((r) => r.health));

  // Connected nodes per group — a group with none explains why its objects are down.
  const workers = useAsync(() => getWorkers(), [tick]);
  const nodeCounts = useMemo(() => {
    if (!workers.data) return null;
    const m = new Map<string, number>();
    for (const w of workers.data) if (nodeHealthy(w)) m.set(w.group, (m.get(w.group) ?? 0) + 1);
    return m;
  }, [workers.data]);

  const shown = useMemo(() => {
    let list = rows;
    if (filter === 'bp') list = list.filter((r) => r.bpState === 2);
    else if (filter !== 'all') list = list.filter((r) => normHealth(r.health) === filter);
    if (q.trim()) {
      const needle = q.toLowerCase();
      list = list.filter((r) => r.id.toLowerCase().includes(needle) || r.type.toLowerCase().includes(needle));
    }
    const { key, dir } = sort;
    return [...list].sort((a, b) => {
      let c: number;
      if (key === 'id' || key === 'type' || key === 'group') c = a[key].localeCompare(b[key]);
      else if (key === 'health') c = HEALTH_ORDER[normHealth(a.health)] - HEALTH_ORDER[normHealth(b.health)];
      else c = a[key] - b[key];
      return c * dir;
    });
  }, [rows, filter, q, sort]);

  function th(key: SortKey, label: string, numeric = false) {
    const activeSort = sort.key === key;
    return (
      <th
        className={numeric ? 'num' : ''}
        onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === -1 ? 1 : -1 }))}
      >
        {label}
        {activeSort && <span className="arrow">{sort.dir === -1 ? '▾' : '▴'}</span>}
      </th>
    );
  }

  const volLabel = isSource ? 'Volume In' : 'Volume Out';
  const totalVol = rows.reduce((a, r) => a + r.bytes, 0);
  const bpNow = rows.filter((r) => r.bpState === 2).length;
  const totalPQ = rows.reduce((a, r) => a + r.pqBytes, 0);

  return (
    <>
      <div className="grid grid-4">
        <StatTile
          label={`Total ${isSource ? 'Sources' : 'Destinations'}`}
          value={String(counts.total)}
          accent="var(--accent)"
          active={filter === 'all'}
          onClick={() => setFilter('all')}
        />
        <StatTile
          label="Healthy"
          value={String(counts.Green)}
          accent="var(--good)"
          active={filter === 'Green'}
          onClick={() => setFilter(filter === 'Green' ? 'all' : 'Green')}
        />
        <StatTile
          label="Unhealthy"
          value={String(counts.Red)}
          accent={counts.Red > 0 ? 'var(--critical)' : 'var(--good)'}
          foot={counts.Yellow > 0 ? <span>{counts.Yellow} warning</span> : undefined}
          active={filter === 'Red'}
          onClick={() => setFilter(filter === 'Red' ? 'all' : 'Red')}
        />
        <StatTile
          label="Backpressured"
          value={String(bpNow)}
          accent={bpNow > 0 ? 'var(--critical)' : 'var(--good)'}
          active={filter === 'bp'}
          onClick={() => setFilter(filter === 'bp' ? 'all' : 'bp')}
          foot={
            totalPQ > 0 ? (
              <span>{formatBytes(totalPQ)} queued to disk</span>
            ) : (
              <span>
                {formatBytes(totalVol)} {isSource ? 'received' : 'delivered'}
              </span>
            )
          }
        />
      </div>

      {failedGroups.length > 0 && (
        <ErrorBanner
          message={`Could not load ${isSource ? 'sources' : 'destinations'} for ${failedGroups.join(', ')} — ${
            failedGroups.length === 1 ? 'that group is' : 'those groups are'
          } missing below, not healthy.`}
        />
      )}

      <div className="grid grid-3">
        <Card title="Health by Worker Group" note="click to focus">
          {status.loading && !status.data ? (
            <Loading height={150} />
          ) : (
            <GroupHealthList
              rows={rows}
              noun={isSource ? 'sources' : 'destinations'}
              nodeCounts={nodeCounts}
              selected={group}
              onSelectGroup={setGroup}
            />
          )}
        </Card>
        <Card
          title={`${isSource ? 'Sources' : 'Destinations'}`}
          className="col-span-2"
          right={
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div className="pill-tabs">
                {(['all', 'Red', 'Yellow', 'Green', 'bp'] as const).map((f) => (
                  <button
                    key={f}
                    className={`pill-tab ${filter === f ? 'active' : ''}`}
                    onClick={() => setFilter(f)}
                  >
                    {f === 'all'
                      ? 'All'
                      : f === 'Red'
                        ? 'Unhealthy'
                        : f === 'Yellow'
                          ? 'Warning'
                          : f === 'Green'
                            ? 'Healthy'
                            : 'Backpressured'}
                  </button>
                ))}
              </div>
              <input
                className="select"
                placeholder="Search…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                style={{ width: 140 }}
              />
            </div>
          }
        >
          {status.loading && !status.data ? (
            <Loading />
          ) : status.error ? (
            <ErrorBanner message={status.error} />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    {th('id', 'ID')}
                    {th('group', 'Group')}
                    {th('type', 'Type')}
                    {th('health', 'Health')}
                    {th('bytes', volLabel, true)}
                    {th('events', 'Events', true)}
                    {!isSource && th('dropped', 'Dropped', true)}
                    {th('pqBytes', 'PQ Depth', true)}
                    {th('bpState', 'Backpressure')}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const rowKey = `${r.group}:${r.id}`;
                    const isOpen = open.has(rowKey);
                    const metricEntries = Object.entries(r.metrics).filter(
                      ([, v]) => typeof v === 'number',
                    );
                    return (
                      <Fragment key={rowKey}>
                        <tr className="row-expandable" onClick={() => toggle(rowKey)}>
                          <td className="id-cell" title={r.id}>
                            <span className={`row-caret ${isOpen ? 'open' : ''}`}>▶</span>
                            {r.id}
                          </td>
                          <td className="muted">{r.group}</td>
                          <td>
                            <span className="type-chip">{r.type}</span>
                          </td>
                          <td>
                            <HealthBadge health={r.health} />
                          </td>
                          <td className="num">{formatBytes(r.bytes)}</td>
                          <td className="num">{formatCount(r.events)}</td>
                          {!isSource && (
                            <td className={`num ${r.dropped > 0 ? 'delta-down' : ''}`}>
                              {r.dropped > 0 ? formatCount(r.dropped) : '—'}
                            </td>
                          )}
                          <td
                            className={`num ${r.pqBytes > 0 ? 'delta-down' : ''}`}
                            title={r.pq ? `Peak in window: ${formatBytes(r.pq.pqPeakBytes)}` : undefined}
                          >
                            {r.pqBytes > 0 ? formatBytes(r.pqBytes) : '—'}
                          </td>
                          <td>
                            {r.bpState === 2 ? (
                              <HealthBadge health="Red" label="Engaged" />
                            ) : r.bpState === 1 ? (
                              <HealthBadge health="Yellow" label="Earlier" />
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td className="detail-cell" colSpan={isSource ? 8 : 9}>
                              <div className="detail-grid">
                                <div>
                                  <div className="dk">Health</div>
                                  <div className="dv">{normHealth(r.health)}</div>
                                </div>
                                <div>
                                  <div className="dk">Group</div>
                                  <div className="dv">{r.group}</div>
                                </div>
                                <div>
                                  <div className="dk">Type</div>
                                  <div className="dv">{r.type}</div>
                                </div>
                                <div>
                                  <div className="dk">Last update</div>
                                  <div className="dv">
                                    {r.timestamp ? formatTime(r.timestamp) : '—'}
                                  </div>
                                </div>
                                                {r.pq && (
                                  <>
                                    <div>
                                      <div className="dk">PQ depth (peak)</div>
                                      <div className="dv">
                                        {formatBytes(r.pq.pqBytes)} ({formatBytes(r.pq.pqPeakBytes)})
                                      </div>
                                    </div>
                                    <div>
                                      <div className="dk">Backpressure buckets</div>
                                      <div className="dv">{r.pq.backpressureBuckets}</div>
                                    </div>
                                  </>
                                )}
                                {metricEntries.map(([k, v]) => (
                                  <div key={k}>
                                    <div className="dk">{k}</div>
                                    <div className="dv">
                                      {/byte/i.test(k)
                                        ? formatBytes(v)
                                        : v.toLocaleString()}
                                    </div>
                                  </div>
                                ))}
                              </div>
                              {(() => {
                                const related = normHealth(r.health) === 'Green' ? [] : relatedMessages(r.id, r.group);
                                const showWhy = normHealth(r.health) !== 'Green';
                                return (
                                  <div style={{ padding: '0 16px 14px 34px' }}>
                                    {r.message && <pre className="detail-pre">{r.message}</pre>}
                                    {showWhy && (
                                      <>
                                        <div className="section-title" style={{ margin: '2px 0 8px' }}>
                                          Related Notifications
                                        </div>
                                        {related.length > 0 ? (
                                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                            {related.map((m, i) => (
                                              <div
                                                key={i}
                                                style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}
                                              >
                                                <span
                                                  className={`sev ${m.severity === 'error' ? 'sev-error' : 'sev-warn'}`}
                                                  style={{ marginTop: 1 }}
                                                >
                                                  {m.severity === 'error' ? 'Error' : 'Warn'}
                                                </span>
                                                <span style={{ fontSize: 13 }}>{m.text || m.title}</span>
                                              </div>
                                            ))}
                                          </div>
                                        ) : (
                                          <div className="muted" style={{ fontSize: 12.5 }}>
                                            No system notification recorded for this{' '}
                                            {isSource ? 'source' : 'destination'}. It is reporting{' '}
                                            <strong>{normHealth(r.health)}</strong> health with no
                                            recent throughput — check its connectivity and
                                            configuration in Cribl Stream.
                                          </div>
                                        )}
                                      </>
                                    )}
                                    <RelatedLogs kind={isSource ? 'input' : 'output'} id={r.id} group={r.group} />
                                  </div>
                                );
                              })()}
                              <div style={{ padding: '2px 16px 14px 34px' }}>
                                <a
                                  className="btn"
                                  href={streamLink(kind, r.group) || '#'}
                                  target="_top"
                                  rel="noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  style={{ textDecoration: 'none' }}
                                >
                                  Open {isSource ? 'Source' : 'Destination'} in Cribl Stream ↗
                                </a>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={isSource ? 8 : 9} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                        No matches
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
