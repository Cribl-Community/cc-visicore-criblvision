import { useMemo, useState } from 'react';
import { useApp } from '../state/AppContext';
import { useAsync } from '../hooks/useAsync';
import { getRouteSeries, getPipelineSeries } from '../api/client';
import type { MetricRow } from '../api/types';
import { Card, StatTile, Loading, ErrorBanner, SearchSelect } from '../components/ui';
import { TimeSeriesChart } from '../components/charts/TimeSeriesChart';
import { sumAlias, sumPointsByBucket } from '../lib/metrics';
import { formatBytes, formatCount, formatPct, reductionPct } from '../lib/format';

type Metric = 'route' | 'pipe';

interface BreakdownRow {
  name: string;
  group: string;
  eventsIn: number;
  eventsOut: number;
  bytesIn: number;
  bytesOut: number;
}

/**
 * Byte/event I/O across Routes or Pipelines, and how much each reduces —
 * the breakdown table is where you find which specific route or pipeline is
 * (or isn't) doing the reduction you'd expect.
 *
 * Pipelines don't report byte metrics in core internal metrics (only routes
 * do), so Pipeline mode is event counts only — matching what's actually
 * available, not a limitation of this app. Skips the original's "Redux
 * Stats" mode, which depends on the separate, optional Cribl Redux Stats
 * Pack instrumenting pipelines — no core metric equivalent exists to build
 * that from.
 */
export function RoutePipelineReductions() {
  const { group, range, tick } = useApp();
  const [metric, setMetric] = useState<Metric>('route');
  const [selected, setSelected] = useState('all');

  const series = useAsync<MetricRow[]>(
    () => (metric === 'route' ? getRouteSeries(group, range.rangeSeconds, range.bucketSeconds) : getPipelineSeries(group, range.rangeSeconds, range.bucketSeconds)),
    [metric, group, range.id, tick],
  );

  const idField = metric === 'route' ? 'name' : 'id';
  const isRoute = metric === 'route';

  const entities = useMemo(() => {
    const ids = new Set<string>();
    for (const r of series.data ?? []) {
      const id = r[idField];
      if (typeof id === 'string' && id) ids.add(id);
    }
    return [...ids].sort();
  }, [series.data, idField]);

  // Reset the entity picker back to "All" when switching metric or when the
  // previously selected entity disappears from this window's data.
  const rows = useMemo(() => {
    const all = series.data ?? [];
    if (selected === 'all' || !entities.includes(selected)) return all;
    return all.filter((r) => r[idField] === selected);
  }, [series.data, selected, entities, idField]);

  const eventsIn = sumAlias(rows, 'eventsIn');
  const eventsOut = sumAlias(rows, 'eventsOut');
  const bytesIn = sumAlias(rows, 'bytesIn');
  const bytesOut = sumAlias(rows, 'bytesOut');

  const breakdown = useMemo(() => {
    const acc = new Map<string, BreakdownRow>();
    for (const r of series.data ?? []) {
      const name = r[idField];
      if (typeof name !== 'string' || !name) continue;
      const grp = typeof r.__worker_group === 'string' ? r.__worker_group : '(unknown)';
      const key = `${name}::${grp}`;
      const cur = acc.get(key) ?? { name, group: grp, eventsIn: 0, eventsOut: 0, bytesIn: 0, bytesOut: 0 };
      cur.eventsIn += Number(r.eventsIn ?? 0);
      cur.eventsOut += Number(r.eventsOut ?? 0);
      cur.bytesIn += Number(r.bytesIn ?? 0);
      cur.bytesOut += Number(r.bytesOut ?? 0);
      acc.set(key, cur);
    }
    return [...acc.values()].sort((a, b) => (isRoute ? b.bytesIn - a.bytesIn : b.eventsIn - a.eventsIn));
  }, [series.data, idField, isRoute]);

  const dateAxis = range.rangeSeconds > 86400;
  const entityLabel = isRoute ? 'Route' : 'Pipeline';

  return (
    <>
      <Card title="Filters">
        <div className="filter-bar">
          <div className="filter-group">
            <span className="control-label">Show</span>
            <div className="pill-tabs">
              <button className={`pill-tab ${metric === 'route' ? 'active' : ''}`} onClick={() => { setMetric('route'); setSelected('all'); }}>
                Routes
              </button>
              <button className={`pill-tab ${metric === 'pipe' ? 'active' : ''}`} onClick={() => { setMetric('pipe'); setSelected('all'); }}>
                Pipelines
              </button>
            </div>
          </div>
          <div className="filter-group">
            <span className="control-label">{entityLabel}</span>
            <SearchSelect
              noun={isRoute ? 'routes' : 'pipelines'}
              options={entities}
              value={selected === 'all' || !entities.includes(selected) ? null : selected}
              onChange={(next) => setSelected(next ?? 'all')}
            />
          </div>
        </div>
        {!isRoute && (
          <div className="muted" style={{ marginTop: 14, fontSize: 12.5, lineHeight: 1.5 }}>
            Pipelines don't report byte I/O in core internal metrics — only event counts.
          </div>
        )}
      </Card>

      <div className="grid grid-4">
        {isRoute && (
          <>
            <StatTile label="Bytes In" value={formatBytes(bytesIn)} accent="var(--series-in)" />
            <StatTile label="Bytes Out" value={formatBytes(bytesOut)} accent="var(--series-out)" />
          </>
        )}
        <StatTile label="Events In" value={formatCount(eventsIn)} accent="var(--series-in)" />
        <StatTile label="Events Out" value={formatCount(eventsOut)} accent="var(--series-out)" />
      </div>

      <div className="grid grid-2">
        {isRoute && (
          <StatTile
            label="Bytes Reduced"
            value={formatBytes(bytesIn - bytesOut)}
            accent={bytesIn - bytesOut >= 0 ? 'var(--good)' : 'var(--critical)'}
            foot={<span>{formatPct(reductionPct(bytesIn, bytesOut))}</span>}
          />
        )}
        <StatTile
          label="Events Reduced"
          value={formatCount(eventsIn - eventsOut)}
          accent={eventsIn - eventsOut >= 0 ? 'var(--good)' : 'var(--critical)'}
          foot={<span>{formatPct(reductionPct(eventsIn, eventsOut))}</span>}
        />
      </div>

      {isRoute && (
        <Card title="Bytes I/O Over Time" note={range.label}>
          {series.loading && !series.data ? (
            <Loading height={260} />
          ) : series.error ? (
            <ErrorBanner message={series.error} />
          ) : (
            <TimeSeriesChart
              height={260}
              valueFormat={formatBytes}
              dateAxis={dateAxis}
              series={[
                { name: 'Bytes In', color: 'var(--series-in)', points: sumPointsByBucket(rows, 'bytesIn') },
                { name: 'Bytes Out', color: 'var(--series-out)', points: sumPointsByBucket(rows, 'bytesOut') },
              ]}
            />
          )}
        </Card>
      )}

      <Card title="Events I/O Over Time" note={range.label}>
        {series.loading && !series.data ? (
          <Loading height={260} />
        ) : series.error ? (
          <ErrorBanner message={series.error} />
        ) : (
          <TimeSeriesChart
            height={260}
            valueFormat={formatCount}
            dateAxis={dateAxis}
            series={[
              { name: 'Events In', color: 'var(--series-in)', points: sumPointsByBucket(rows, 'eventsIn') },
              { name: 'Events Out', color: 'var(--series-out)', points: sumPointsByBucket(rows, 'eventsOut') },
            ]}
          />
        )}
      </Card>

      <Card title={`Breakdown of I/O by ${entityLabel}`} note={range.label}>
        {series.loading && !series.data ? (
          <Loading height={200} />
        ) : breakdown.length === 0 ? (
          <div className="center-state" style={{ height: 120 }}>No data in this window</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="no-sort">{entityLabel}</th>
                  <th className="no-sort">Worker Group</th>
                  {isRoute && (
                    <>
                      <th className="no-sort num">Bytes In</th>
                      <th className="no-sort num">Bytes Out</th>
                      <th className="no-sort num">Bytes Reduced</th>
                      <th className="no-sort num">Reduced %</th>
                    </>
                  )}
                  <th className="no-sort num">Events In</th>
                  <th className="no-sort num">Events Out</th>
                  <th className="no-sort num">Events Reduced</th>
                  <th className="no-sort num">Reduced %</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.map((r) => {
                  const bytesReduced = r.bytesIn - r.bytesOut;
                  const eventsReduced = r.eventsIn - r.eventsOut;
                  return (
                    <tr key={`${r.name}::${r.group}`}>
                      <td className="id-cell" title={r.name}>{r.name}</td>
                      <td className="muted">{r.group}</td>
                      {isRoute && (
                        <>
                          <td className="num">{formatBytes(r.bytesIn)}</td>
                          <td className="num">{formatBytes(r.bytesOut)}</td>
                          <td className={`num ${bytesReduced >= 0 ? 'delta-up' : 'delta-down'}`}>{formatBytes(bytesReduced)}</td>
                          <td className={`num ${bytesReduced >= 0 ? 'delta-up' : 'delta-down'}`}>{formatPct(reductionPct(r.bytesIn, r.bytesOut))}</td>
                        </>
                      )}
                      <td className="num">{formatCount(r.eventsIn)}</td>
                      <td className="num">{formatCount(r.eventsOut)}</td>
                      <td className={`num ${eventsReduced >= 0 ? 'delta-up' : 'delta-down'}`}>{formatCount(eventsReduced)}</td>
                      <td className={`num ${eventsReduced >= 0 ? 'delta-up' : 'delta-down'}`}>{formatPct(reductionPct(r.eventsIn, r.eventsOut))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
