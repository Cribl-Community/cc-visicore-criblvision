import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/AppContext';
import { useAsync } from '../hooks/useAsync';
import {
  getOutEventsByOutput,
  getOutBytesByOutput,
  getInEventsByInput,
  getInBytesByInput,
  getWorkerProcessRows,
  getTopOutputs,
  getTopInputs,
  getWorkers,
  type InSplitBy,
} from '../api/client';
import { Card, Loading, ErrorBanner, MultiSelect } from '../components/ui';
import { TimeSeriesChart, type ChartSeries } from '../components/charts/TimeSeriesChart';
import { splitToSeries, type SplitSeries } from '../lib/metrics';
import { formatBytes, formatCount } from '../lib/format';

// Fixed 8-slot categorical order (never cycled — see App.css). A limit above
// 8 would force color reuse, so the Series Limit control tops out at 8.
const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
];
const LIMIT_OPTIONS = [3, 5, 8];

function toChartSeries(list: SplitSeries[]): ChartSeries[] {
  return list.map((s, i) => ({ name: s.id, color: CHART_COLORS[i % CHART_COLORS.length], points: s.points }));
}

function formatPercent(n: number): string {
  return `${n.toFixed(0)}%`;
}

/**
 * Breaks down throughput by destination, and by source or worker process, so
 * you can spot which output is carrying the load and — when split by worker
 * process — catch TCP pinning (one process pegged at high CPU/events while
 * its siblings idle).
 *
 * `cribl_wp` isn't a dimension the aggregate metrics-query endpoint exposes
 * for `total.*`/`system.*` measurements, so the worker-process split is
 * node-scoped: it calls the per-node metrics endpoint once per process index
 * (`wp` query param) for one selected node, instead of one cluster-wide query.
 */
export function DataWpIntrospection() {
  const { group, range, tick } = useApp();
  const [splitBy, setSplitBy] = useState<InSplitBy>('input');
  const [limit, setLimit] = useState(5);
  const [destSel, setDestSel] = useState<Set<string> | null>(null);
  const [srcSel, setSrcSel] = useState<Set<string> | null>(null);
  const [nodeId, setNodeId] = useState<string | null>(null);

  const destOptions = useAsync(() => getTopOutputs(group, range.rangeSeconds), [group, range.id, tick]);
  const srcOptions = useAsync(() => getTopInputs(group, range.rangeSeconds), [group, range.id, tick]);
  const workers = useAsync(() => getWorkers(), [tick]);

  const nodeOptions = useMemo(() => {
    const all = workers.data ?? [];
    return (group === 'all' ? all : all.filter((w) => w.group === group)).sort((a, b) =>
      (a.info.hostname ?? a.id).localeCompare(b.info.hostname ?? b.id),
    );
  }, [workers.data, group]);

  // Keep the node selection valid as the group filter or the worker list changes.
  useEffect(() => {
    if (nodeOptions.length === 0) {
      setNodeId(null);
    } else if (!nodeId || !nodeOptions.some((w) => w.id === nodeId)) {
      setNodeId(nodeOptions[0].id);
    }
  }, [nodeOptions, nodeId]);

  const selectedNode = nodeOptions.find((w) => w.id === nodeId);
  const wpCount = selectedNode?.workerProcesses ?? 1;

  const outEvents = useAsync(
    () => getOutEventsByOutput(group, range.rangeSeconds, range.bucketSeconds),
    [group, range.id, tick],
  );
  const outBytes = useAsync(
    () => getOutBytesByOutput(group, range.rangeSeconds, range.bucketSeconds),
    [group, range.id, tick],
  );
  const inEvents = useAsync(
    () => getInEventsByInput(group, range.rangeSeconds, range.bucketSeconds),
    [group, range.id, tick],
  );
  const inBytes = useAsync(
    () => getInBytesByInput(group, range.rangeSeconds, range.bucketSeconds),
    [group, range.id, tick],
  );
  const wpRows = useAsync(
    () =>
      splitBy === 'cribl_wp' && nodeId
        ? getWorkerProcessRows(nodeId, wpCount, range.rangeSeconds, range.bucketSeconds)
        : Promise.resolve([]),
    [splitBy, nodeId, wpCount, range.id, tick],
  );

  const dateAxis = range.rangeSeconds > 86400;
  // Sources filter only maps onto the in-charts when they're split by input —
  // worker-process ids aren't the same dimension, so the filter is a no-op
  // (and greyed out) while split by worker process.
  const srcInclude = srcSel ? [...srcSel] : undefined;
  const destInclude = destSel ? [...destSel] : undefined;
  const byWp = splitBy === 'cribl_wp';

  const outEventSeries = useMemo(
    () => splitToSeries(outEvents.data ?? [], 'output', 'events', { include: destInclude, limit }),
    [outEvents.data, destInclude, limit],
  );
  const outByteSeries = useMemo(
    () => splitToSeries(outBytes.data ?? [], 'output', 'bytes', { include: destInclude, limit }),
    [outBytes.data, destInclude, limit],
  );
  const inEventSeries = useMemo(
    () =>
      byWp
        ? splitToSeries(wpRows.data ?? [], 'cribl_wp', 'events', { limit })
        : splitToSeries(inEvents.data ?? [], 'input', 'events', { include: srcInclude, limit }),
    [byWp, wpRows.data, inEvents.data, srcInclude, limit],
  );
  const inByteSeries = useMemo(
    () =>
      byWp
        ? splitToSeries(wpRows.data ?? [], 'cribl_wp', 'bytes', { limit })
        : splitToSeries(inBytes.data ?? [], 'input', 'bytes', { include: srcInclude, limit }),
    [byWp, wpRows.data, inBytes.data, srcInclude, limit],
  );
  const cpuSeries = useMemo(
    () => splitToSeries(wpRows.data ?? [], 'cribl_wp', 'cpu', { limit }),
    [wpRows.data, limit],
  );

  const inEventsState = byWp ? wpRows : inEvents;
  const inBytesState = byWp ? wpRows : inBytes;
  const inNote = byWp ? `worker processes on ${selectedNode?.info.hostname ?? nodeId ?? '—'}` : 'split by input';

  return (
    <>
      <Card title="Filters">
        <div className="filter-bar">
          <div className="filter-group">
            <span className="control-label">Split Sources By</span>
            <div className="pill-tabs">
              <button
                className={`pill-tab ${splitBy === 'input' ? 'active' : ''}`}
                onClick={() => setSplitBy('input')}
              >
                Input
              </button>
              <button
                className={`pill-tab ${splitBy === 'cribl_wp' ? 'active' : ''}`}
                onClick={() => setSplitBy('cribl_wp')}
              >
                Worker Process
              </button>
            </div>
          </div>

          {byWp && (
            <div className="filter-group">
              <span className="control-label">Worker Node</span>
              <div className="control">
                <select
                  className="select"
                  value={nodeId ?? ''}
                  onChange={(e) => setNodeId(e.target.value)}
                  disabled={nodeOptions.length === 0}
                >
                  {nodeOptions.length === 0 && <option value="">No nodes</option>}
                  {nodeOptions.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.info.hostname ?? w.id}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div className="filter-group">
            <span className="control-label">Series Limit</span>
            <div className="control">
              <select className="select" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                {LIMIT_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    Top {n}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="filter-group grow">
            <span className="control-label">Destinations</span>
            {destOptions.loading && !destOptions.data ? (
              <span className="muted" style={{ fontSize: 12.5 }}>
                Loading…
              </span>
            ) : (
              <MultiSelect
                noun="destinations"
                options={(destOptions.data ?? []).map((d) => d.id)}
                selected={destSel}
                onChange={setDestSel}
              />
            )}
          </div>

          <div className="filter-group grow" data-disabled={byWp}>
            <span className="control-label">Sources {byWp && '· applies when split by Input'}</span>
            {srcOptions.loading && !srcOptions.data ? (
              <span className="muted" style={{ fontSize: 12.5 }}>
                Loading…
              </span>
            ) : (
              <MultiSelect
                noun="sources"
                options={(srcOptions.data ?? []).map((s) => s.id)}
                selected={srcSel}
                onChange={setSrcSel}
              />
            )}
          </div>
        </div>
      </Card>

      <Card title="Total Events Out" note={range.label}>
        {outEvents.loading && !outEvents.data ? (
          <Loading height={280} />
        ) : outEvents.error ? (
          <ErrorBanner message={outEvents.error} />
        ) : (
          <TimeSeriesChart height={280} valueFormat={formatCount} dateAxis={dateAxis} series={toChartSeries(outEventSeries)} />
        )}
      </Card>

      <Card title="Total Bytes Out" note={range.label}>
        {outBytes.loading && !outBytes.data ? (
          <Loading height={280} />
        ) : outBytes.error ? (
          <ErrorBanner message={outBytes.error} />
        ) : (
          <TimeSeriesChart height={280} valueFormat={formatBytes} dateAxis={dateAxis} series={toChartSeries(outByteSeries)} />
        )}
      </Card>

      <Card title="Total Events In" note={inNote}>
        {inEventsState.loading && !inEventsState.data ? (
          <Loading height={280} />
        ) : inEventsState.error ? (
          <ErrorBanner message={inEventsState.error} />
        ) : (
          <TimeSeriesChart height={280} valueFormat={formatCount} dateAxis={dateAxis} series={toChartSeries(inEventSeries)} />
        )}
      </Card>

      {byWp && (
        <Card title="CPU % by Worker Process" note="uneven load can indicate TCP pinning">
          {wpRows.loading && !wpRows.data ? (
            <Loading height={240} />
          ) : wpRows.error ? (
            <ErrorBanner message={wpRows.error} />
          ) : (
            <TimeSeriesChart height={240} valueFormat={formatPercent} dateAxis={dateAxis} series={toChartSeries(cpuSeries)} />
          )}
        </Card>
      )}

      <Card title="Total Bytes In" note={inNote}>
        {inBytesState.loading && !inBytesState.data ? (
          <Loading height={280} />
        ) : inBytesState.error ? (
          <ErrorBanner message={inBytesState.error} />
        ) : (
          <TimeSeriesChart height={280} valueFormat={formatBytes} dateAxis={dateAxis} series={toChartSeries(inByteSeries)} />
        )}
      </Card>
    </>
  );
}
