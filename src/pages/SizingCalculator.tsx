import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/AppContext';
import { useAsync } from '../hooks/useAsync';
import { getWorkers, getNodeThroughput, getWorkerProcessRows } from '../api/client';
import { Card, StatTile, Loading, ErrorBanner } from '../components/ui';
import { TimeSeriesChart } from '../components/charts/TimeSeriesChart';
import { splitToSeries } from '../lib/metrics';
import { formatBytes, formatCount } from '../lib/format';

const MAX_WP_ROWS = 24;
const CPU_SPEEDS = Array.from({ length: 25 }, (_, i) => Math.round((1.5 + i * 0.1) * 10) / 10);
const CPU_ARCH = [
  { value: 200, label: 'x64 (Hyperthreading)' },
  { value: 400, label: 'x64' },
  { value: 480, label: 'ARM64' },
];
const GIB = 1024 ** 3;
const DAY_SECONDS = 86400;
const CPU_HOT_THRESHOLD = 90;

function formatTimePct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Estimates whether a worker node's current CPU allocation and process count
 * can keep up with its observed throughput, using Cribl's published per-vCPU
 * capacity guidance — flags nodes that need more worker processes and shows
 * which processes are running hot on CPU.
 *
 * Node-scoped because `host`/`cribl_wp` aren't usable dimensions on the
 * aggregate metrics query, so throughput and per-process CPU both come from
 * the per-node `/w/:id/system/metrics` endpoint instead.
 */
export function SizingCalculator() {
  const { group, range, tick } = useApp();
  const [cpuSpeed, setCpuSpeed] = useState(3.0);
  const [cpuType, setCpuType] = useState(200);
  const [nodeId, setNodeId] = useState<string | null>(null);

  const workers = useAsync(() => getWorkers(), [tick]);
  const nodeOptions = useMemo(() => {
    const all = workers.data ?? [];
    return (group === 'all' ? all : all.filter((w) => w.group === group)).sort((a, b) =>
      (a.info.hostname ?? a.id).localeCompare(b.info.hostname ?? b.id),
    );
  }, [workers.data, group]);

  useEffect(() => {
    if (nodeOptions.length === 0) {
      setNodeId(null);
    } else if (!nodeId || !nodeOptions.some((w) => w.id === nodeId)) {
      setNodeId(nodeOptions[0].id);
    }
  }, [nodeOptions, nodeId]);

  const selectedNode = nodeOptions.find((w) => w.id === nodeId);
  const wpCount = selectedNode?.workerProcesses ?? 1;

  const throughput = useAsync(
    () => (nodeId ? getNodeThroughput(nodeId, range.rangeSeconds) : Promise.resolve([])),
    [nodeId, range.id, tick],
  );
  const wpRows = useAsync(
    () => (nodeId ? getWorkerProcessRows(nodeId, wpCount, range.rangeSeconds, range.bucketSeconds) : Promise.resolve([])),
    [nodeId, wpCount, range.id, tick],
  );

  // ((architecture factor * GHz) / 3) GiB/day per vCPU — Cribl's published
  // sizing-capacity formula.
  const perCpuCapacityPerDay = ((cpuType * cpuSpeed) / 3) * GIB;
  const nodeCapacityPerDay = perCpuCapacityPerDay * wpCount;

  const totalBytesInWindow = useMemo(
    () => (throughput.data ?? []).reduce((a, p) => a + p.inBytes + p.outBytes, 0),
    [throughput.data],
  );
  const dailyRate =
    range.rangeSeconds > 0 ? (totalBytesInWindow / range.rangeSeconds) * DAY_SECONDS : 0;
  const estimatedWpRequired = perCpuCapacityPerDay > 0 ? Math.round(dailyRate / perCpuCapacityPerDay) + 1 : 0;
  const undersized = estimatedWpRequired > wpCount;

  const dailyTable = useMemo(() => {
    const byDay = new Map<string, { inBytes: number; outBytes: number }>();
    for (const p of throughput.data ?? []) {
      const key = dayKey(p.t);
      const cur = byDay.get(key) ?? { inBytes: 0, outBytes: 0 };
      cur.inBytes += p.inBytes;
      cur.outBytes += p.outBytes;
      byDay.set(key, cur);
    }
    return [...byDay.entries()]
      .map(([date, v]) => {
        const total = v.inBytes + v.outBytes;
        return {
          date,
          inBytes: v.inBytes,
          outBytes: v.outBytes,
          total,
          wpRequired: perCpuCapacityPerDay > 0 ? Math.round(total / perCpuCapacityPerDay) + 1 : 0,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [throughput.data, perCpuCapacityPerDay]);

  const cpuHotTable = useMemo(() => {
    const series = splitToSeries(wpRows.data ?? [], 'cribl_wp', 'cpu', { limit: MAX_WP_ROWS });
    return series
      .map((s) => {
        const total = s.points.length;
        const hot = s.points.filter((p) => p.v >= CPU_HOT_THRESHOLD).length;
        return { id: s.id, pct: total > 0 ? hot / total : 0 };
      })
      .sort((a, b) => b.pct - a.pct);
  }, [wpRows.data]);

  const dateAxis = range.rangeSeconds > 86400;

  return (
    <>
      <Card title="Filters">
        <div className="filter-bar">
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

          <div className="filter-group">
            <span className="control-label">CPU Speed</span>
            <div className="control">
              <select className="select" value={cpuSpeed} onChange={(e) => setCpuSpeed(Number(e.target.value))}>
                {CPU_SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s.toFixed(1)} GHz
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="filter-group">
            <span className="control-label">CPU Architecture</span>
            <div className="pill-tabs">
              {CPU_ARCH.map((a) => (
                <button
                  key={a.value}
                  className={`pill-tab ${cpuType === a.value ? 'active' : ''}`}
                  onClick={() => setCpuType(a.value)}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="muted" style={{ marginTop: 14, fontSize: 12.5, lineHeight: 1.5 }}>
          Estimates whether this node's current worker-process count is sufficient for its observed
          throughput, using Cribl's published per-vCPU capacity assumption — it doesn't account for
          pipeline processing cost. It also doesn't include an event-loop-utilization (eluPerc) check,
          since that value only appears in Cribl's internal log lines rather than a REST metric, and
          this app only has API access.{' '}
          <a href="https://docs.cribl.io/stream/scaling/" target="_top" rel="noreferrer">
            Sizing &amp; Scaling docs ↗
          </a>
        </div>
      </Card>

      <div className="grid grid-4">
        <StatTile label="Worker Process Count" value={formatCount(wpCount)} accent="var(--accent)" />
        <StatTile
          label="Capacity per vCPU"
          value={formatBytes(perCpuCapacityPerDay)}
          accent="var(--series-in)"
          foot={<span>/ day</span>}
        />
        <StatTile
          label="Estimated Node Capacity"
          value={formatBytes(nodeCapacityPerDay)}
          accent="var(--series-out)"
          foot={<span>/ day across {wpCount} processes</span>}
        />
        <StatTile
          label="Estimated Processes Required"
          value={formatCount(estimatedWpRequired)}
          accent={undersized ? 'var(--critical)' : 'var(--good)'}
          foot={<span>{undersized ? `undersized — have ${wpCount}` : `have ${wpCount}, adequate`}</span>}
        />
      </div>

      <Card title="Total Throughput (In + Out)" note={`${selectedNode?.info.hostname ?? nodeId ?? '—'} · ${range.label}`}>
        {throughput.loading && !throughput.data ? (
          <Loading height={260} />
        ) : throughput.error ? (
          <ErrorBanner message={throughput.error} />
        ) : (
          <TimeSeriesChart
            height={260}
            valueFormat={formatBytes}
            dateAxis={dateAxis}
            series={[
              { name: 'Bytes In', color: 'var(--series-in)', points: (throughput.data ?? []).map((p) => ({ t: p.t, v: p.inBytes })) },
              { name: 'Bytes Out', color: 'var(--series-out)', points: (throughput.data ?? []).map((p) => ({ t: p.t, v: p.outBytes })) },
            ]}
          />
        )}
      </Card>

      <Card title="Estimated Worker Processes Required, by Day" note="daily throughput vs. this node's per-vCPU capacity">
        {throughput.loading && !throughput.data ? (
          <Loading height={160} />
        ) : dailyTable.length === 0 ? (
          <div className="center-state" style={{ height: 120 }}>No data in this window</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="no-sort">Date</th>
                  <th className="no-sort num">Bytes In</th>
                  <th className="no-sort num">Bytes Out</th>
                  <th className="no-sort num">Total</th>
                  <th className="no-sort num">Est. Processes Required</th>
                </tr>
              </thead>
              <tbody>
                {dailyTable.map((d) => (
                  <tr key={d.date}>
                    <td className="id-cell">{d.date}</td>
                    <td className="num">{formatBytes(d.inBytes)}</td>
                    <td className="num">{formatBytes(d.outBytes)}</td>
                    <td className="num">{formatBytes(d.total)}</td>
                    <td className={`num ${d.wpRequired > wpCount ? 'delta-down' : ''}`}>{d.wpRequired}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Time ≥90% CPU by Worker Process"
        note={`percentage of samples at or above ${CPU_HOT_THRESHOLD}% CPU — high across the board suggests upsizing`}
      >
        {wpRows.loading && !wpRows.data ? (
          <Loading height={160} />
        ) : wpRows.error ? (
          <ErrorBanner message={wpRows.error} />
        ) : cpuHotTable.length === 0 ? (
          <div className="center-state" style={{ height: 120 }}>No data in this window</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="no-sort">Worker Process</th>
                  <th className="no-sort num">Time ≥90% CPU</th>
                </tr>
              </thead>
              <tbody>
                {cpuHotTable.map((r) => (
                  <tr key={r.id}>
                    <td className="id-cell">{r.id}</td>
                    <td className={`num ${r.pct >= 0.5 ? 'delta-down' : ''}`}>{formatTimePct(r.pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
