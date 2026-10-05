import { useMemo, useState } from 'react';
import { useApp } from '../state/AppContext';
import { useAsync } from '../hooks/useAsync';
import { getPipelineStats, streamLink, type PipelineStat } from '../api/client';
import { Card, StatTile, Loading, ErrorBanner, BarList } from '../components/ui';
import { formatCount, formatPct } from '../lib/format';

type SortKey = 'id' | 'group' | 'eventsIn' | 'eventsOut' | 'dropped' | 'errors' | 'dropPct';

function dropPct(p: PipelineStat): number {
  return p.eventsIn > 0 ? p.dropped / p.eventsIn : 0;
}

export function Pipelines() {
  const { group, range, tick } = useApp();
  const stats = useAsync<PipelineStat[]>(
    () => getPipelineStats(group, range.rangeSeconds),
    [group, range.id, tick],
  );

  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'eventsIn', dir: -1 });

  const rows = stats.data ?? [];
  const totalIn = rows.reduce((a, r) => a + r.eventsIn, 0);
  const totalDropped = rows.reduce((a, r) => a + r.dropped, 0);
  const totalErrors = rows.reduce((a, r) => a + r.errors, 0);

  const shown = useMemo(() => {
    let list = rows;
    if (q.trim()) {
      const needle = q.toLowerCase();
      list = list.filter(
        (r) => r.id.toLowerCase().includes(needle) || r.group.toLowerCase().includes(needle),
      );
    }
    const { key, dir } = sort;
    return [...list].sort((a, b) => {
      let c: number;
      if (key === 'id' || key === 'group') c = a[key].localeCompare(b[key]);
      else if (key === 'dropPct') c = dropPct(a) - dropPct(b);
      else c = a[key] - b[key];
      return c * dir;
    });
  }, [rows, q, sort]);

  const topDroppers = useMemo(
    () =>
      rows
        .filter((r) => r.dropped > 0)
        .sort((a, b) => b.dropped - a.dropped)
        .slice(0, 8)
        .map((r) => ({ id: r.id, value: r.dropped })),
    [rows],
  );

  function th(key: SortKey, label: string, numeric = false) {
    const active = sort.key === key;
    return (
      <th
        className={numeric ? 'num' : ''}
        onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === -1 ? 1 : -1 }))}
      >
        {label}
        {active && <span className="arrow">{sort.dir === -1 ? '▾' : '▴'}</span>}
      </th>
    );
  }

  return (
    <>
      <div className="grid grid-4">
        <StatTile label="Pipelines Reporting" value={String(rows.length)} accent="var(--accent)" />
        <StatTile
          label="Events In"
          value={formatCount(totalIn)}
          accent="var(--series-in)"
          active={sort.key === 'eventsIn'}
          onClick={() => setSort({ key: 'eventsIn', dir: -1 })}
        />
        <StatTile
          label="Dropped"
          value={formatCount(totalDropped)}
          accent={totalDropped > 0 ? 'var(--warning)' : 'var(--good)'}
          foot={
            <span>
              {totalIn > 0 ? formatPct(totalDropped / totalIn, 1).replace('+', '') : '0%'} of events in
            </span>
          }
          active={sort.key === 'dropped'}
          onClick={() => setSort({ key: 'dropped', dir: -1 })}
        />
        <StatTile
          label="Errors"
          value={formatCount(totalErrors)}
          accent={totalErrors > 0 ? 'var(--critical)' : 'var(--good)'}
          active={sort.key === 'errors'}
          onClick={() => setSort({ key: 'errors', dir: -1 })}
        />
      </div>

      <div className="grid grid-3">
        <Card
          title="Pipelines"
          className="col-span-2"
          right={
            <input
              className="select"
              placeholder="Search…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ width: 160 }}
            />
          }
        >
          {stats.loading && !stats.data ? (
            <Loading />
          ) : stats.error ? (
            <ErrorBanner message={stats.error} />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    {th('id', 'Pipeline')}
                    {th('group', 'Group')}
                    {th('eventsIn', 'Events In', true)}
                    {th('eventsOut', 'Events Out', true)}
                    {th('dropped', 'Dropped', true)}
                    {th('dropPct', 'Drop %', true)}
                    {th('errors', 'Errors', true)}
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const pct = dropPct(r);
                    return (
                      <tr key={`${r.group}:${r.id}`}>
                        <td className="id-cell" title={r.id}>
                          {r.id}
                        </td>
                        <td>
                          <span className="type-chip">{r.group}</span>
                        </td>
                        <td className="num">{formatCount(r.eventsIn)}</td>
                        <td className="num">{formatCount(r.eventsOut)}</td>
                        <td className={`num ${r.dropped > 0 ? 'delta-down' : ''}`}>
                          {r.dropped > 0 ? formatCount(r.dropped) : '—'}
                        </td>
                        <td className={`num ${pct > 0.5 ? 'delta-down' : ''}`}>
                          {pct > 0 ? `${(pct * 100).toFixed(1)}%` : '—'}
                        </td>
                        <td className={`num ${r.errors > 0 ? 'delta-down' : ''}`}>
                          {r.errors > 0 ? formatCount(r.errors) : '—'}
                        </td>
                        <td>
                          {streamLink('pipeline', r.group) && (
                            <a
                              className="btn btn-sm"
                              href={streamLink('pipeline', r.group)}
                              target="_top"
                              rel="noreferrer"
                              style={{ textDecoration: 'none' }}
                            >
                              Open ↗
                            </a>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                        {rows.length === 0
                          ? `No pipelines reported events in the ${range.label.toLowerCase()} window.`
                          : 'No matches'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Top Droppers" note="events dropped">
          {stats.loading && !stats.data ? (
            <Loading />
          ) : topDroppers.length === 0 ? (
            <div className="center-state">No drops in window</div>
          ) : (
            <BarList color="var(--warning)" formatValue={formatCount} items={topDroppers} />
          )}
        </Card>
      </div>
    </>
  );
}
