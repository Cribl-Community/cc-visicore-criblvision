import { Fragment, useMemo, useState } from 'react';
import { useApp } from '../state/AppContext';
import { useAsync } from '../hooks/useAsync';
import { getCommitHistory, getCommitDetail, type CommitDetail, type DiffFileEntry } from '../api/client';
import { Card, StatTile, Loading, ErrorBanner } from '../components/ui';
import { TimeSeriesChart } from '../components/charts/TimeSeriesChart';
import { formatCount, formatTime, formatDate } from '../lib/format';

const COMMIT_FETCH_COUNT = 300;

function shortHash(h: string): string {
  return h.slice(0, 7);
}

function fileState(f: DiffFileEntry): { label: string; color: string } {
  if (f.isNew) return { label: 'Created', color: 'var(--good)' };
  if (f.isDeleted) return { label: 'Deleted', color: 'var(--critical)' };
  if (f.isRename) return { label: 'Renamed', color: 'var(--series-3)' };
  return { label: 'Modified', color: 'var(--warning)' };
}

function DiffFile({ file }: { file: DiffFileEntry }) {
  const state = fileState(file);
  return (
    <div className="diff-file">
      <div className="diff-file-head">
        <span className="type-chip" style={{ color: state.color }}>
          {state.label}
        </span>
        <span className="id-cell" style={{ maxWidth: 520 }} title={file.newName || file.oldName}>
          {file.newName || file.oldName}
        </span>
        <span className="muted" style={{ marginLeft: 'auto', fontSize: 11.5 }}>
          +{file.addedLines} -{file.deletedLines}
        </span>
      </div>
      {!file.isBinary &&
        file.blocks.map((b, bi) => (
          <div className="diff-block" key={bi}>
            <div className="diff-line diff-header">{b.header}</div>
            {b.lines.map((l, li) => (
              <div
                key={li}
                className={`diff-line ${l.type === 'insert' ? 'diff-add' : l.type === 'delete' ? 'diff-del' : 'diff-ctx'}`}
              >
                {l.type === 'insert' ? '+ ' : l.type === 'delete' ? '- ' : '  '}
                {l.content}
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

/**
 * Audits who changed what in the Cribl config and when, using Cribl's own
 * git-backed versioning API (`GET /version` for the commit log, `GET
 * /version/show` for a commit's full file-by-file diff on demand).
 *
 * Covers commits only — there's no deploy-history API to say which worker
 * groups actually deployed a given commit (deploying is a write-only PATCH
 * action, not something you can list). `/version` also has no time-range
 * param, just a `count`, so this fetches the most recent batch and filters
 * to the selected range client-side.
 */
export function CommitAuditLog() {
  const { range, tick } = useApp();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Map<string, CommitDetail>>(new Map());
  const [detailErrors, setDetailErrors] = useState<Map<string, string>>(new Map());
  const [loadingHash, setLoadingHash] = useState<string | null>(null);

  const commits = useAsync(() => getCommitHistory(COMMIT_FETCH_COUNT), [tick]);

  const sinceMs = Date.now() - range.rangeSeconds * 1000;
  const needle = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    return (commits.data ?? []).filter((c) => {
      if (c.date < sinceMs) return false;
      if (!needle) return true;
      return c.authorName.toLowerCase().includes(needle) || c.message.toLowerCase().includes(needle);
    });
  }, [commits.data, sinceMs, needle]);

  const timeSeries = useMemo(() => {
    const bucketMs = Math.max(3600_000, range.bucketSeconds * 1000);
    const byBucket = new Map<number, number>();
    for (const c of filtered) {
      const b = sinceMs + Math.floor((c.date - sinceMs) / bucketMs) * bucketMs;
      byBucket.set(b, (byBucket.get(b) ?? 0) + 1);
    }
    const times = [...byBucket.keys()].sort((a, b) => a - b);
    return [{ name: 'Commits', color: 'var(--accent)', points: times.map((t) => ({ t, v: byBucket.get(t) ?? 0 })) }];
  }, [filtered, sinceMs, range.bucketSeconds]);

  const authorCount = useMemo(
    () => new Set(filtered.map((c) => c.authorEmail || c.authorName)).size,
    [filtered],
  );

  async function toggle(hash: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
    if (details.has(hash) || detailErrors.has(hash)) return;
    setLoadingHash(hash);
    try {
      const d = await getCommitDetail(hash);
      setDetails((prev) => new Map(prev).set(hash, d));
    } catch (e) {
      setDetailErrors((prev) => new Map(prev).set(hash, e instanceof Error ? e.message : String(e)));
    } finally {
      setLoadingHash((cur) => (cur === hash ? null : cur));
    }
  }

  const dateAxis = range.rangeSeconds > 86400;

  return (
    <>
      <Card title="Filters">
        <div className="filter-bar">
          <div className="filter-group grow">
            <span className="control-label">Search Author / Message</span>
            <input
              className="select"
              placeholder="e.g. j.woger, syslog-clean…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ width: '100%', maxWidth: 320 }}
            />
          </div>
        </div>
        <div className="muted" style={{ marginTop: 14, fontSize: 12.5, lineHeight: 1.5 }}>
          Shows the config git commit history (<code>GET /version</code>) — there's no deploy-history
          API (deploying is a write-only action), so this covers commits only, not which worker groups
          have actually deployed a given one. <code>/version</code> has no time-range param, so this
          fetches the {COMMIT_FETCH_COUNT} most recent commits and filters to the selected range above.
        </div>
      </Card>

      <div className="grid grid-3">
        <StatTile label="Commits" value={formatCount(filtered.length)} accent="var(--accent)" foot={<span>{range.label.toLowerCase()}</span>} />
        <StatTile label="Authors" value={formatCount(authorCount)} accent="var(--series-3)" />
        <StatTile
          label="Fetched"
          value={formatCount((commits.data ?? []).length)}
          accent="var(--muted)"
          foot={<span>most recent, server-capped</span>}
        />
      </div>

      <Card title="Commits Over Time" note={range.label}>
        {commits.loading && !commits.data ? (
          <Loading height={220} />
        ) : commits.error ? (
          <ErrorBanner message={commits.error} />
        ) : (
          <TimeSeriesChart height={220} valueFormat={formatCount} dateAxis={dateAxis} series={timeSeries} />
        )}
      </Card>

      <Card title="Commit History" note={`${formatCount(filtered.length)} commits`}>
        {commits.loading && !commits.data ? (
          <Loading height={200} />
        ) : commits.error ? (
          <ErrorBanner message={commits.error} />
        ) : filtered.length === 0 ? (
          <div className="center-state" style={{ height: 120 }}>No commits in this window</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="no-sort">Date</th>
                  <th className="no-sort">Author</th>
                  <th className="no-sort">Message</th>
                  <th className="no-sort">Commit</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => {
                  const isOpen = open.has(c.hash);
                  const detail = details.get(c.hash);
                  const err = detailErrors.get(c.hash);
                  return (
                    <Fragment key={c.hash}>
                      <tr className="row-expandable" onClick={() => toggle(c.hash)}>
                        <td className="muted">
                          <span className={`row-caret ${isOpen ? 'open' : ''}`}>▶</span>
                          {formatDate(c.date)} {formatTime(c.date)}
                        </td>
                        <td>{c.authorName}</td>
                        <td className="id-cell" title={c.message}>{c.message}</td>
                        <td className="mono muted" title={c.hash}>{shortHash(c.hash)}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td className="detail-cell" colSpan={4}>
                            <div style={{ padding: '4px 16px 14px 34px' }}>
                              {loadingHash === c.hash && !detail ? (
                                <Loading height={80} />
                              ) : err ? (
                                <ErrorBanner message={err} />
                              ) : detail ? (
                                detail.files.length === 0 ? (
                                  <div className="muted" style={{ fontSize: 12.5 }}>
                                    No file changes reported for this commit.
                                  </div>
                                ) : (
                                  detail.files.map((f, fi) => <DiffFile key={fi} file={f} />)
                                )
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
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
