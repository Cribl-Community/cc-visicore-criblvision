import { useMemo, useState } from 'react';
import { useApp } from '../state/AppContext';
import { useAsync } from '../hooks/useAsync';
import { getRouteSeries, streamLink } from '../api/client';
import type { MetricRow } from '../api/types';
import { analyzeRoutes, type RouteHealth as RouteRow } from '../lib/routeHealth';
import { usePref } from '../lib/prefs';
import { Card, StatTile, Loading, ErrorBanner, HealthBadge } from '../components/ui';
import { formatBytes, formatCount, formatDuration, timeAgo } from '../lib/format';

// "Stalled after" thresholds. Applied client-side, so changing it re-scores
// the already-fetched window without a refetch.
const STALL_OPTIONS = [
  { seconds: 30 * 60, label: '30 minutes' },
  { seconds: 3600, label: '1 hour' },
  { seconds: 2 * 3600, label: '2 hours' },
  { seconds: 4 * 3600, label: '4 hours' },
  { seconds: 6 * 3600, label: '6 hours' },
  { seconds: 12 * 3600, label: '12 hours' },
];

type Filter = 'all' | 'stalled' | 'active';

export function RouteHealthPage() {
  const { group, range, tick } = useApp();
  const [stallSeconds, setStallSeconds] = usePref('stallSeconds', 2 * 3600);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');

  const raw = useAsync<MetricRow[]>(
    () => getRouteSeries(group, range.rangeSeconds, range.bucketSeconds),
    [group, range.id, tick],
  );

  // Re-derive verdicts whenever data or the stall threshold changes — the
  // threshold is applied client-side, so no refetch is needed.
  const routes = useMemo(
    () => analyzeRoutes(raw.data ?? [], { stallSeconds }),
    [raw.data, stallSeconds],
  );

  const stalled = routes.filter((r) => r.status === 'stalled');
  const active = routes.filter((r) => r.status === 'active');
  const totalBytes = routes.reduce((a, r) => a + r.bytes, 0);

  const shown = useMemo(() => {
    let list: RouteRow[] = routes;
    if (filter !== 'all') list = list.filter((r) => r.status === filter);
    if (q.trim()) {
      const needle = q.toLowerCase();
      list = list.filter(
        (r) => r.name.toLowerCase().includes(needle) || r.workerGroup.toLowerCase().includes(needle),
      );
    }
    return list;
  }, [routes, filter, q]);

  // A route can only look "stalled" if the lookback window is longer than the
  // stall threshold; otherwise a silent route simply has no rows in the window.
  const windowTooShort = range.rangeSeconds <= stallSeconds;
  const now = Date.now();

  return (
    <>
      <div className="grid grid-4">
        <StatTile
          label="Stalled Routes"
          value={String(stalled.length)}
          accent={stalled.length > 0 ? 'var(--critical)' : 'var(--good)'}
          foot={<span>silent ≥ {formatDuration(stallSeconds)}</span>}
          active={filter === 'stalled'}
          onClick={() => setFilter(filter === 'stalled' ? 'all' : 'stalled')}
        />
        <StatTile
          label="Active Routes"
          value={String(active.length)}
          accent="var(--good)"
          active={filter === 'active'}
          onClick={() => setFilter(filter === 'active' ? 'all' : 'active')}
        />
        <StatTile
          label="Reporting Routes"
          value={String(routes.length)}
          accent="var(--accent)"
          active={filter === 'all'}
          onClick={() => setFilter('all')}
        />
        <StatTile label="Volume In" value={formatBytes(totalBytes)} accent="var(--series-in)" />
      </div>

      {windowTooShort && (
        <div className="error-banner" style={{ marginBottom: 14 }}>
          ⚠ The selected time range ({range.label.toLowerCase()}) is not longer than the stall
          threshold ({formatDuration(stallSeconds)}), so stalled routes can't be detected — pick a
          longer time range or a shorter threshold.
        </div>
      )}

      <Card
        title="Route Health"
        right={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label className="muted" style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center' }}>
              Stalled after
              <select
                className="select"
                value={stallSeconds}
                onChange={(e) => setStallSeconds(Number(e.target.value))}
                aria-label="Stall threshold"
              >
                {STALL_OPTIONS.map((o) => (
                  <option key={o.seconds} value={o.seconds}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="pill-tabs">
              {(['all', 'stalled', 'active'] as const).map((f) => (
                <button
                  key={f}
                  className={`pill-tab ${filter === f ? 'active' : ''}`}
                  onClick={() => setFilter(f)}
                >
                  {f === 'all' ? 'All' : f === 'stalled' ? 'Stalled' : 'Active'}
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
        {raw.loading && !raw.data ? (
          <Loading />
        ) : raw.error ? (
          <ErrorBanner message={raw.error} />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Route</th>
                  <th>Group</th>
                  <th>Status</th>
                  <th className="num">Silent For</th>
                  <th>Last Data</th>
                  <th className="num">Events (window)</th>
                  <th className="num">Bytes (window)</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.key}>
                    <td className="id-cell" title={r.routeId}>
                      {r.name}
                    </td>
                    <td className="muted">{r.workerGroup}</td>
                    <td>
                      <HealthBadge
                        health={r.status === 'stalled' ? 'Red' : 'Green'}
                        label={r.status === 'stalled' ? 'Stalled' : 'Active'}
                      />
                    </td>
                    <td className={`num ${r.status === 'stalled' ? 'delta-down' : ''}`}>
                      {r.status === 'stalled' ? formatDuration(r.gapSeconds) : '—'}
                    </td>
                    <td className="muted">{timeAgo(r.lastDataTime * 1000, now)}</td>
                    <td className="num">{formatCount(r.events)}</td>
                    <td className="num">{formatBytes(r.bytes)}</td>
                    <td>
                      {streamLink('route', r.workerGroup) && (
                        <a
                          href={streamLink('route', r.workerGroup)}
                          target="_top"
                          rel="noreferrer"
                          title={`Open ${r.workerGroup} routing table in Cribl Stream`}
                          style={{ whiteSpace: 'nowrap' }}
                        >
                          Open ↗
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                      {routes.length === 0
                        ? `No routes reported data in the ${range.label.toLowerCase()} window.`
                        : 'No matches'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
