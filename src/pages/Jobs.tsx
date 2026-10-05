import { Fragment, useMemo, useState } from 'react';
import { useApp, useGroupIds } from '../state/AppContext';
import { useAsync } from '../hooks/useAsync';
import { getJobs, getJobErrors, streamLink, type JobWithGroup } from '../api/client';
import type { JobError } from '../api/types';
import { Card, StatTile, Loading, ErrorBanner, HealthBadge } from '../components/ui';
import { formatBytes, formatCount, formatTime, timeAgo } from '../lib/format';

type Filter = 'all' | 'failed' | 'running' | 'scheduled';

/** Collector config name — jobs are named `<epoch>.<seq>.<kind>.<collectorId>`. */
function collectorName(j: JobWithGroup): string {
  return j.args?.id ?? j.id.split('.').slice(3).join('.') ?? j.id;
}

function jobKind(j: JobWithGroup): 'scheduled' | 'adhoc' {
  return j.args?.schedule?.cronSchedule || j.id.includes('.scheduled.') ? 'scheduled' : 'adhoc';
}

/** Failed tasks make a "finished" job a failure from an operator's viewpoint. */
function jobState(j: JobWithGroup): string {
  const state = j.status?.state ?? 'unknown';
  if (state === 'finished' && (j.stats?.tasks?.failed ?? 0) > 0) return 'failed tasks';
  return state;
}

function stateHealth(s: string): 'Green' | 'Yellow' | 'Red' {
  if (s === 'failed' || s === 'failed tasks' || s === 'cancelled') return 'Red';
  if (s === 'finished') return 'Green';
  return 'Yellow'; // running / pending / initializing
}

/** Expanded row body: task breakdown plus the actual task errors, fetched lazily. */
function JobDetail({ job }: { job: JobWithGroup }) {
  const hasFailures = (job.stats?.tasks?.failed ?? 0) > 0 || job.status?.state === 'failed';
  const errors = useAsync<JobError[]>(
    () => (hasFailures ? getJobErrors(job.group, job.id) : Promise.resolve([])),
    [job.group, job.id, hasFailures],
  );
  const [stackFor, setStackFor] = useState<number | null>(null);
  const tasks = job.stats?.tasks;

  return (
    <>
      <div className="detail-grid">
        <div>
          <div className="dk">Job ID</div>
          <div className="dv mono" style={{ fontSize: 11.5 }}>{job.id}</div>
        </div>
        <div>
          <div className="dk">Tasks (finished / failed / in flight)</div>
          <div className="dv">
            {tasks ? `${tasks.finished ?? 0} / ${tasks.failed ?? 0} / ${tasks.inFlight ?? 0}` : '—'}
          </div>
        </div>
        <div>
          <div className="dk">Discovered events</div>
          <div className="dv">{formatCount(job.stats?.discoveredEvents ?? 0)}</div>
        </div>
        {job.status?.reason && (
          <div>
            <div className="dk">Reason</div>
            <div className="dv">{job.status.reason}</div>
          </div>
        )}
      </div>
      {hasFailures && (
        <div style={{ padding: '0 16px 14px 34px' }}>
          <div className="section-title" style={{ margin: '2px 0 8px' }}>
            Task Errors
          </div>
          {errors.loading && !errors.data ? (
            <Loading height={60} />
          ) : errors.error ? (
            <ErrorBanner message={errors.error} />
          ) : (errors.data ?? []).length === 0 ? (
            <div className="muted" style={{ fontSize: 12.5 }}>
              No error detail recorded for this run — errors may have aged out (job artifacts
              expire with the run's TTL). Check the collector's recent runs in Cribl Stream.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {(errors.data ?? []).map((e, i) => {
                const msg = e.error?.reason?.message ?? e.error?.message ?? 'Unknown error';
                const stack = e.error?.reason?.stack ?? e.error?.stack;
                return (
                  <div key={i}>
                    <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
                      <span className="sev sev-error" style={{ marginTop: 1 }}>
                        {e.taskId ?? 'task'}
                      </span>
                      <span style={{ fontSize: 13 }}>
                        {msg}
                        {e.timestamp ? (
                          <span className="muted"> · {formatTime(e.timestamp)}</span>
                        ) : null}
                        {stack && (
                          <>
                            {' '}
                            <button
                              className="btn btn-sm"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                setStackFor(stackFor === i ? null : i);
                              }}
                            >
                              {stackFor === i ? 'Hide stack' : 'Stack trace'}
                            </button>
                          </>
                        )}
                      </span>
                    </div>
                    {stackFor === i && stack && <pre className="detail-pre">{stack}</pre>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function Jobs() {
  const { group, tick } = useApp();
  const groupIds = useGroupIds();
  const idKey = groupIds.join(',');

  const jobs = useAsync<JobWithGroup[]>(() => getJobs(groupIds), [idKey, tick]);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());

  function toggle(key: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const rows = useMemo(
    () => (jobs.data ?? []).filter((j) => group === 'all' || j.group === group),
    [jobs.data, group],
  );

  const failed = rows.filter((j) => stateHealth(jobState(j)) === 'Red');
  const running = rows.filter((j) => {
    const s = j.status?.state;
    return s === 'running' || s === 'pending' || s === 'initializing';
  });
  const scheduled = rows.filter((j) => jobKind(j) === 'scheduled');
  const totalCollected = rows.reduce((a, j) => a + (j.stats?.collectedEvents ?? 0), 0);

  const shown = useMemo(() => {
    let list = rows;
    if (filter === 'failed') list = failed;
    else if (filter === 'running') list = running;
    else if (filter === 'scheduled') list = scheduled;
    if (q.trim()) {
      const needle = q.toLowerCase();
      list = list.filter(
        (j) =>
          collectorName(j).toLowerCase().includes(needle) ||
          j.group.toLowerCase().includes(needle),
      );
    }
    return list;
  }, [rows, filter, q, failed, running, scheduled]);

  const now = Date.now();

  return (
    <>
      <div className="grid grid-4">
        <StatTile
          label="Job Runs"
          value={String(rows.length)}
          accent="var(--accent)"
          active={filter === 'all'}
          onClick={() => setFilter('all')}
        />
        <StatTile
          label="Failed"
          value={String(failed.length)}
          accent={failed.length > 0 ? 'var(--critical)' : 'var(--good)'}
          foot={failed.length > 0 ? <span>needs attention</span> : <span>all clean</span>}
          active={filter === 'failed'}
          onClick={() => setFilter(filter === 'failed' ? 'all' : 'failed')}
        />
        <StatTile
          label="In Flight"
          value={String(running.length)}
          accent="var(--series-in)"
          active={filter === 'running'}
          onClick={() => setFilter(filter === 'running' ? 'all' : 'running')}
        />
        <StatTile
          label="Events Collected"
          value={formatCount(totalCollected)}
          accent="var(--series-out)"
        />
      </div>

      <Card
        title="Collection Jobs"
        right={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div className="pill-tabs">
              {(['all', 'failed', 'running', 'scheduled'] as const).map((f) => (
                <button
                  key={f}
                  className={`pill-tab ${filter === f ? 'active' : ''}`}
                  onClick={() => setFilter(f)}
                >
                  {f === 'all' ? 'All' : f[0].toUpperCase() + f.slice(1)}
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
        {jobs.loading && !jobs.data ? (
          <Loading />
        ) : jobs.error ? (
          <ErrorBanner message={jobs.error} />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="no-sort">Collector</th>
                  <th className="no-sort">Group</th>
                  <th className="no-sort">Kind</th>
                  <th className="no-sort">State</th>
                  <th className="no-sort num">Tasks</th>
                  <th className="no-sort num">Failed</th>
                  <th className="no-sort num">Events</th>
                  <th className="no-sort num">Bytes</th>
                  <th className="no-sort">Started</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {shown.map((j) => {
                  const state = jobState(j);
                  const tasks = j.stats?.tasks;
                  const startedMs = j.stats?.state?.initializing ?? 0;
                  const cron = j.args?.schedule?.cronSchedule;
                  const rowKey = `${j.group}:${j.id}`;
                  const isOpen = open.has(rowKey);
                  return (
                    <Fragment key={rowKey}>
                    <tr className="row-expandable" onClick={() => toggle(rowKey)}>
                      <td className="id-cell" title={j.id}>
                        <span className={`row-caret ${isOpen ? 'open' : ''}`}>▶</span>
                        {collectorName(j)}
                      </td>
                      <td>
                        <span className="type-chip">{j.group}</span>
                      </td>
                      <td className="muted" title={cron ? `cron: ${cron}` : undefined}>
                        {jobKind(j)}
                        {cron ? ` (${cron})` : ''}
                      </td>
                      <td>
                        <HealthBadge health={stateHealth(state)} label={state} />
                      </td>
                      <td className="num">{tasks?.count ?? '—'}</td>
                      <td className={`num ${(tasks?.failed ?? 0) > 0 ? 'delta-down' : ''}`}>
                        {tasks?.failed || '—'}
                      </td>
                      <td className="num">
                        {j.stats?.collectedEvents ? formatCount(j.stats.collectedEvents) : '—'}
                      </td>
                      <td className="num">
                        {j.stats?.collectedBytes ? formatBytes(j.stats.collectedBytes) : '—'}
                      </td>
                      <td className="muted">{startedMs ? timeAgo(startedMs, now) : '—'}</td>
                      <td>
                        {streamLink('job', j.group) && (
                          <a
                            className="btn btn-sm"
                            href={streamLink('job', j.group)}
                            target="_top"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            style={{ textDecoration: 'none' }}
                          >
                            Open ↗
                          </a>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td className="detail-cell" colSpan={10}>
                          <JobDetail job={j} />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                      {rows.length === 0
                        ? 'No collection jobs found for this selection.'
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
