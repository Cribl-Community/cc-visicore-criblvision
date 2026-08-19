import { useMemo, useState } from 'react';
import { useApp, useGroupIds } from '../state/AppContext';
import { useAsync } from '../hooks/useAsync';
import { searchLogs } from '../api/client';
import { Card, StatTile, Loading, ErrorBanner, ChipSelect, BarList } from '../components/ui';
import { TimeSeriesChart } from '../components/charts/TimeSeriesChart';
import { formatCount, formatTime } from '../lib/format';

const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'silly'] as const;
const DEFAULT_LEVELS = new Set<string>(['error', 'warn', 'info']);
const LEVEL_LABEL: Record<string, string> = {
  error: 'Error',
  warn: 'Warn',
  info: 'Info',
  debug: 'Debug',
  silly: 'Silly',
};
const LEVEL_COLOR: Record<string, string> = {
  error: 'var(--critical)',
  warn: 'var(--warning)',
  info: 'var(--accent)',
  debug: 'var(--series-3)',
  silly: 'var(--muted)',
};
const MAX_TABLE_ROWS = 50;
const MAX_RAW_ROWS = 200;

/**
 * Breaks down internal logs by level, and by channel/message within each
 * level, so you can spot what's actually generating errors or warnings
 * without reading raw log files.
 *
 * Searches each selected worker group's centrally-stored log. It can't drill
 * into one specific Worker/Edge node's log within a group — `/system/logs/search`
 * has no per-node equivalent to the metrics endpoints' `/w/:id/...` — and
 * doesn't include the Leader's own root log, which has no confirmed-working
 * request shape.
 */
export function LogAnalytics() {
  const { range, tick } = useApp();
  const groupIds = useGroupIds();
  const [levels, setLevels] = useState<Set<string>>(DEFAULT_LEVELS);
  const [q, setQ] = useState('');

  const logs = useAsync(() => searchLogs(groupIds, range.rangeSeconds), [groupIds.join(','), range.id, tick]);

  const needle = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    return (logs.data ?? []).filter((e) => {
      if (!levels.has(e.level)) return false;
      if (!needle) return true;
      return e.channel.toLowerCase().includes(needle) || e.message.toLowerCase().includes(needle);
    });
  }, [logs.data, levels, needle]);

  const totalByLevel = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of filtered) counts.set(e.level, (counts.get(e.level) ?? 0) + 1);
    return LOG_LEVELS.filter((l) => levels.has(l))
      .map((l) => ({ id: LEVEL_LABEL[l], level: l, value: counts.get(l) ?? 0 }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [filtered, levels]);

  const timeSeries = useMemo(() => {
    const bucketMs = Math.max(1000, range.bucketSeconds * 1000);
    const nowMs = Date.now();
    const startMs = nowMs - range.rangeSeconds * 1000;
    const byBucket = new Map<number, Map<string, number>>();
    for (const e of filtered) {
      const bucketStart = startMs + Math.floor((e.time - startMs) / bucketMs) * bucketMs;
      const rec = byBucket.get(bucketStart) ?? new Map<string, number>();
      rec.set(e.level, (rec.get(e.level) ?? 0) + 1);
      byBucket.set(bucketStart, rec);
    }
    const times = [...byBucket.keys()].sort((a, b) => a - b);
    return LOG_LEVELS.filter((l) => levels.has(l)).map((l) => ({
      name: LEVEL_LABEL[l],
      color: LEVEL_COLOR[l],
      points: times.map((t) => ({ t, v: byBucket.get(t)?.get(l) ?? 0 })),
    }));
  }, [filtered, levels, range.bucketSeconds, range.rangeSeconds]);

  const tableRows = useMemo(() => {
    const map = new Map<string, { level: string; channel: string; message: string; count: number; lastTime: number }>();
    for (const e of filtered) {
      const key = `${e.level}::${e.channel}::${e.message}`;
      const cur = map.get(key) ?? { level: e.level, channel: e.channel, message: e.message, count: 0, lastTime: 0 };
      cur.count++;
      if (e.time >= cur.lastTime) cur.lastTime = e.time;
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => b.count - a.count).slice(0, MAX_TABLE_ROWS);
  }, [filtered]);

  const rawRows = useMemo(() => filtered.slice(0, MAX_RAW_ROWS), [filtered]);

  const dateAxis = range.rangeSeconds > 86400;
  const errorCount = totalByLevel.find((r) => r.level === 'error')?.value ?? 0;
  const warnCount = totalByLevel.find((r) => r.level === 'warn')?.value ?? 0;

  return (
    <>
      <Card title="Filters">
        <div className="filter-bar">
          <div className="filter-group grow">
            <span className="control-label">Levels</span>
            <ChipSelect
              options={[...LOG_LEVELS]}
              selected={levels.size === LOG_LEVELS.length ? null : levels}
              onChange={(next) => setLevels(next ?? new Set(LOG_LEVELS))}
            />
          </div>
          <div className="filter-group grow">
            <span className="control-label">Search Channel / Message</span>
            <input
              className="select"
              placeholder="e.g. destination, ECONNREFUSED…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ width: '100%', maxWidth: 320 }}
            />
          </div>
        </div>
        <div className="muted" style={{ marginTop: 14, fontSize: 12.5, lineHeight: 1.5 }}>
          Reads each worker group selected above (top bar) — it can't drill into one specific Worker
          or Edge node's log within a group, and doesn't include the Leader's own log.
        </div>
      </Card>

      <div className="grid grid-4">
        <StatTile label="Log Lines" value={formatCount(filtered.length)} accent="var(--accent)" foot={<span>{range.label.toLowerCase()}</span>} />
        <StatTile
          label="Errors"
          value={formatCount(errorCount)}
          accent={errorCount > 0 ? 'var(--critical)' : 'var(--good)'}
        />
        <StatTile
          label="Warnings"
          value={formatCount(warnCount)}
          accent={warnCount > 0 ? 'var(--warning)' : 'var(--good)'}
        />
        <StatTile label="Distinct Channel / Message Pairs" value={formatCount(tableRows.length)} accent="var(--series-3)" />
      </div>

      <Card title="Log Level Breakdown Over Time" note={range.label}>
        {logs.loading && !logs.data ? (
          <Loading height={260} />
        ) : logs.error ? (
          <ErrorBanner message={logs.error} />
        ) : (
          <TimeSeriesChart height={260} valueFormat={formatCount} dateAxis={dateAxis} series={timeSeries} />
        )}
      </Card>

      <Card title="Log Level Breakdown" note="totals over the selected window">
        {logs.loading && !logs.data ? (
          <Loading height={160} />
        ) : (
          <BarList
            items={totalByLevel}
            colorFor={(id) => LEVEL_COLOR[totalByLevel.find((r) => r.id === id)?.level ?? 'info']}
            formatValue={formatCount}
          />
        )}
      </Card>

      <Card title="Channel / Message Breakdown" note={`top ${MAX_TABLE_ROWS} by count`}>
        {logs.loading && !logs.data ? (
          <Loading height={200} />
        ) : tableRows.length === 0 ? (
          <div className="center-state" style={{ height: 120 }}>No matching log lines</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="no-sort">Level</th>
                  <th className="no-sort">Channel</th>
                  <th className="no-sort">Message</th>
                  <th className="no-sort num">Count</th>
                  <th className="no-sort">Last Seen</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <span className="type-chip" style={{ color: LEVEL_COLOR[r.level] }}>
                        {LEVEL_LABEL[r.level]}
                      </span>
                    </td>
                    <td className="id-cell" title={r.channel}>{r.channel}</td>
                    <td className="id-cell" title={r.message}>{r.message}</td>
                    <td className="num">{formatCount(r.count)}</td>
                    <td className="muted">{formatTime(r.lastTime)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Raw Events"
        note={
          filtered.length > MAX_RAW_ROWS
            ? `newest ${MAX_RAW_ROWS} of ${formatCount(filtered.length)}`
            : `${formatCount(filtered.length)} lines`
        }
      >
        {logs.loading && !logs.data ? (
          <Loading height={240} />
        ) : rawRows.length === 0 ? (
          <div className="center-state" style={{ height: 120 }}>No matching log lines</div>
        ) : (
          <div className="log-lines" style={{ maxHeight: 480 }}>
            {rawRows.map((e, i) => (
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
