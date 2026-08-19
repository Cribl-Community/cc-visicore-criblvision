import { useMemo } from 'react';
import { useApp, useGroupIds } from '../state/AppContext';
import { useAsync } from '../hooks/useAsync';
import {
  getOutputPQStats,
  getInputPQStats,
  getPQSeriesByDim,
  searchLogs,
  type OutputPQStat,
} from '../api/client';
import { Card, StatTile, Loading, ErrorBanner, HealthBadge } from '../components/ui';
import { TimeSeriesChart, type ChartSeries } from '../components/charts/TimeSeriesChart';
import { splitToSeries } from '../lib/metrics';
import { formatBytes, formatCount } from '../lib/format';

// Fixed 8-slot categorical order (never cycled — see App.css).
const CHART_COLORS = [
  'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)',
  'var(--chart-5)', 'var(--chart-6)', 'var(--chart-7)', 'var(--chart-8)',
];
const PQ_CHANNEL = 'ipersistentqueue';
const MAX_RAW_ROWS = 100;
const PER_SIDE_LIMIT = 4;

interface EngagedRow extends OutputPQStat {
  type: 'Source' | 'Destination';
}

/**
 * Persistent-queue health: how many Sources/Destinations currently have a PQ
 * engaged, how big those queues are and whether they're growing (a queue
 * that keeps growing means that Destination can't ingest fast enough and
 * Worker Nodes are spooling to disk), and the raw `IPersistentQueue` log
 * lines for troubleshooting.
 */
export function PersistentQueueAnalytics() {
  const { group, range, tick } = useApp();
  const groupIds = useGroupIds();

  const outputPQ = useAsync(() => getOutputPQStats(group, range.rangeSeconds, range.bucketSeconds), [group, range.id, tick]);
  const inputPQ = useAsync(() => getInputPQStats(group, range.rangeSeconds, range.bucketSeconds), [group, range.id, tick]);
  const outSeriesRows = useAsync(() => getPQSeriesByDim('output', group, range.rangeSeconds, range.bucketSeconds), [group, range.id, tick]);
  const inSeriesRows = useAsync(() => getPQSeriesByDim('input', group, range.rangeSeconds, range.bucketSeconds), [group, range.id, tick]);
  const logs = useAsync(() => searchLogs(groupIds, range.rangeSeconds), [groupIds.join(','), range.id, tick]);

  const engaged: EngagedRow[] = useMemo(() => {
    const dest = (outputPQ.data ?? []).map((s) => ({ ...s, type: 'Destination' as const }));
    const src = (inputPQ.data ?? []).map((s) => ({ ...s, type: 'Source' as const }));
    return [...dest, ...src].filter((s) => s.pqBytes > 0).sort((a, b) => b.pqBytes - a.pqBytes);
  }, [outputPQ.data, inputPQ.data]);

  const totalPQBytes = useMemo(
    () => [...(outputPQ.data ?? []), ...(inputPQ.data ?? [])].reduce((a, s) => a + s.pqBytes, 0),
    [outputPQ.data, inputPQ.data],
  );
  const backpressuredCount = useMemo(() => engaged.filter((s) => s.backpressureNow).length, [engaged]);

  const sizeSeries = useMemo(() => {
    const dest = splitToSeries(outSeriesRows.data ?? [], 'output', 'pqBytes', { limit: PER_SIDE_LIMIT }).map((s) => ({
      ...s,
      id: `Dest: ${s.id}`,
    }));
    const src = splitToSeries(inSeriesRows.data ?? [], 'input', 'pqBytes', { limit: PER_SIDE_LIMIT }).map((s) => ({
      ...s,
      id: `Src: ${s.id}`,
    }));
    const combined = [...dest, ...src];
    return combined.map((s, i): ChartSeries => ({ name: s.id, color: CHART_COLORS[i % CHART_COLORS.length], points: s.points }));
  }, [outSeriesRows.data, inSeriesRows.data]);

  const pqLogs = useMemo(
    () => (logs.data ?? []).filter((e) => e.channel.toLowerCase() === PQ_CHANNEL).slice(0, MAX_RAW_ROWS),
    [logs.data],
  );

  const dateAxis = range.rangeSeconds > 86400;
  const seriesLoading = outSeriesRows.loading && !outSeriesRows.data && inSeriesRows.loading && !inSeriesRows.data;

  return (
    <>
      <div className="grid grid-3">
        <StatTile
          label="Engaged Persistent Queues"
          value={formatCount(engaged.length)}
          accent={engaged.length > 0 ? 'var(--warning)' : 'var(--good)'}
        />
        <StatTile label="Total PQ Size" value={formatBytes(totalPQBytes)} accent="var(--series-in)" foot={<span>{range.label.toLowerCase()}</span>} />
        <StatTile
          label="Backpressured Now"
          value={formatCount(backpressuredCount)}
          accent={backpressuredCount > 0 ? 'var(--critical)' : 'var(--good)'}
        />
      </div>

      <Card title="Engaged Persistent Queues" note={range.label}>
        {outputPQ.loading && !outputPQ.data && inputPQ.loading && !inputPQ.data ? (
          <Loading height={160} />
        ) : outputPQ.error || inputPQ.error ? (
          <ErrorBanner message={outputPQ.error ?? inputPQ.error ?? ''} />
        ) : engaged.length === 0 ? (
          <div className="center-state" style={{ height: 120 }}>No persistent queues currently engaged</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="no-sort">Type</th>
                  <th className="no-sort">Persistent Queue</th>
                  <th className="no-sort">Worker Group</th>
                  <th className="no-sort num">PQ Size</th>
                  <th className="no-sort num">Peak</th>
                  <th className="no-sort">Backpressure</th>
                </tr>
              </thead>
              <tbody>
                {engaged.map((r) => (
                  <tr key={`${r.type}:${r.group}:${r.id}`}>
                    <td>
                      <span className="type-chip">{r.type}</span>
                    </td>
                    <td className="id-cell" title={r.id}>{r.id}</td>
                    <td className="muted">{r.group}</td>
                    <td className="num">{formatBytes(r.pqBytes)}</td>
                    <td className="muted num">{formatBytes(r.pqPeakBytes)}</td>
                    <td>
                      {r.backpressureNow ? (
                        <HealthBadge health="Red" label="Engaged" />
                      ) : r.backpressureBuckets > 0 ? (
                        <HealthBadge health="Yellow" label="Earlier" />
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Persistent Queue Size by Source/Destination" note={`top ${PER_SIDE_LIMIT} of each · ${range.label}`}>
        {seriesLoading ? (
          <Loading height={280} />
        ) : (
          <TimeSeriesChart height={280} valueFormat={formatBytes} dateAxis={dateAxis} series={sizeSeries} />
        )}
      </Card>

      <Card title="Persistent Queue Logs" note={`channel=IPersistentQueue · ${pqLogs.length} of ${logs.data?.length ?? 0} log lines`}>
        {logs.loading && !logs.data ? (
          <Loading height={200} />
        ) : logs.error ? (
          <ErrorBanner message={logs.error} />
        ) : pqLogs.length === 0 ? (
          <div className="center-state" style={{ height: 120 }}>No IPersistentQueue log lines in this window</div>
        ) : (
          <div className="log-lines" style={{ maxHeight: 420 }}>
            {pqLogs.map((e, i) => (
              <div className="log-line" key={i}>
                <span className="log-line-no">{i + 1}</span>
                <span className="log-line-text">{JSON.stringify(e.raw)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
