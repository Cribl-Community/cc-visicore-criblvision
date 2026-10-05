import { useMemo, useState } from 'react';
import { useApp } from '../state/AppContext';
import { useAsync } from '../hooks/useAsync';
import { getMessages, getSavedSearches } from '../api/client';
import type { Severity, SystemMessage } from '../api/types';
import { Card, StatTile, Loading, ErrorBanner } from '../components/ui';
import { IconChevron } from '../components/icons';
import { timeAgo } from '../lib/format';
import { alertLabel, alertNotifications } from '../lib/alertCatalog';

const SEV_LABEL: Record<Severity, string> = { error: 'Error', warn: 'Warn', info: 'Info' };
const SEV_CLASS: Record<Severity, string> = {
  error: 'sev-error',
  warn: 'sev-warn',
  info: 'sev-info',
};
const SEV_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

// How far back the page looks; Cribl keeps notifications for months.
const AGES = [
  { id: '24h', label: 'Last 24 hours', ms: 24 * 3_600_000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 3_600_000 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 24 * 3_600_000 },
  { id: 'all', label: 'All time', ms: Infinity },
] as const;
type AgeId = (typeof AGES)[number]['id'];

function normSev(s: string): Severity {
  return s === 'error' || s === 'warn' ? s : 'info';
}

// Alerts all post with the generic title "Notification", so say which alert fired.
// Catalog alerts open their text with a "[P1] Name" line; older and hand-made ones
// open with a date, so those are named from the alert the notification belongs to.
function headline(m: SystemMessage, alertNames: Map<string, string>): string {
  if (m.title && m.title !== 'Notification') return m.title;
  const text = m.text ?? '';
  const first = text.split('\n')[0];
  if (first && !first.startsWith('Date:') && !first.startsWith('{')) return first;
  const name = alertNames.get(m.id);
  if (name) return name;
  if (first.startsWith('{')) {
    try {
      const monitor = (JSON.parse(text) as { monitor_name?: string }).monitor_name;
      if (monitor) return monitor;
    } catch {
      /* not JSON after all — fall through */
    }
  }
  // The alert no longer exists; its id is still in the message body.
  return /Search ID: (.+?)\.?$/m.exec(text)?.[1] ?? (first || m.title);
}

export function Notifications() {
  const { tick } = useApp();
  const msgs = useAsync(() => getMessages(), [tick]);
  // Notification id → alert label, to title notifications by the alert that fired.
  const saved = useAsync(() => getSavedSearches().catch(() => []), []);
  const alertNames = useMemo(
    () =>
      new Map(
        (saved.data ?? []).flatMap((s) => alertNotifications(s).map((n) => [n.id, alertLabel(s)] as const)),
      ),
    [saved.data],
  );
  const [filter, setFilter] = useState<'all' | Severity>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const now = Date.now();

  const [age, setAge] = useState<AgeId>('7d');
  const all = useMemo(() => {
    const cutoff = Date.now() - (AGES.find((a) => a.id === age)?.ms ?? Infinity);
    return (msgs.data ?? []).filter((m) => !m.time || m.time >= cutoff);
  }, [msgs.data, age]);
  const counts = useMemo(() => {
    const c = { error: 0, warn: 0, info: 0 };
    for (const m of all) c[normSev(m.severity)]++;
    return c;
  }, [all]);

  const shown = useMemo(() => {
    let list = all;
    if (filter !== 'all') list = list.filter((m) => normSev(m.severity) === filter);
    if (q.trim()) {
      const n = q.toLowerCase();
      list = list.filter(
        (m) =>
          headline(m, alertNames).toLowerCase().includes(n) ||
          (m.text ?? '').toLowerCase().includes(n) ||
          (m.group ?? '').toLowerCase().includes(n),
      );
    }
    return [...list].sort((a, b) => {
      const s = SEV_ORDER[normSev(a.severity)] - SEV_ORDER[normSev(b.severity)];
      return s !== 0 ? s : (b.time ?? 0) - (a.time ?? 0);
    });
  }, [all, filter, q, alertNames]);

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const detail = (m: SystemMessage) => {
    const meta =
      m.metadata && (Array.isArray(m.metadata) ? m.metadata.length : true)
        ? `\n\nmetadata: ${JSON.stringify(m.metadata, null, 2)}`
        : '';
    return `${m.text || m.title}${meta}`;
  };

  return (
    <>
      <div className="grid grid-3">
        <StatTile
          label="Errors"
          value={String(counts.error)}
          accent={counts.error > 0 ? 'var(--critical)' : 'var(--good)'}
          active={filter === 'error'}
          onClick={() => setFilter(filter === 'error' ? 'all' : 'error')}
        />
        <StatTile
          label="Warnings"
          value={String(counts.warn)}
          accent={counts.warn > 0 ? 'var(--warning)' : 'var(--good)'}
          active={filter === 'warn'}
          onClick={() => setFilter(filter === 'warn' ? 'all' : 'warn')}
        />
        <StatTile
          label="Info"
          value={String(counts.info)}
          accent="var(--accent)"
          active={filter === 'info'}
          onClick={() => setFilter(filter === 'info' ? 'all' : 'info')}
        />
      </div>

      <Card
        title="System Notifications"
        right={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div className="pill-tabs">
              {(['all', 'error', 'warn', 'info'] as const).map((f) => (
                <button
                  key={f}
                  className={`pill-tab ${filter === f ? 'active' : ''}`}
                  onClick={() => setFilter(f)}
                >
                  {f === 'all' ? 'All' : `${SEV_LABEL[f]}s`}
                </button>
              ))}
            </div>
            <select
              className="select"
              aria-label="Time range"
              value={age}
              onChange={(e) => setAge(e.target.value as AgeId)}
            >
              {AGES.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
            <input
              className="select"
              placeholder="Search…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ width: 150 }}
            />
          </div>
        }
      >
        {msgs.loading && !msgs.data ? (
          <Loading />
        ) : msgs.error ? (
          <ErrorBanner message={msgs.error} />
        ) : shown.length === 0 ? (
          <div className="center-state">
            No notifications match
            {age !== 'all' && (msgs.data?.length ?? 0) > all.length && (
              <button className="btn btn-sm" onClick={() => setAge('all')}>
                Show all time ({msgs.data?.length})
              </button>
            )}
          </div>
        ) : (
          <div className="notif">
            {shown.map((m) => {
              const sev = normSev(m.severity);
              // The same message id can come from several groups or nodes.
              const rowKey = `${m.id}|${m.group ?? ''}|${m.workerId ?? ''}`;
              const isOpen = open.has(rowKey);
              return (
                <div className="notif-row" key={rowKey}>
                  <div className="notif-head" onClick={() => toggle(rowKey)}>
                    <IconChevron className={`notif-chevron ${isOpen ? 'open' : ''}`} />
                    <span className={`sev ${SEV_CLASS[sev]}`}>{SEV_LABEL[sev]}</span>
                    <span className="notif-title">{headline(m, alertNames)}</span>
                    {m.group && <span className="type-chip">{m.group}</span>}
                    <span className="notif-meta">{m.time ? timeAgo(m.time, now) : ''}</span>
                  </div>
                  {isOpen && (
                    <div className="notif-body">
                      <pre className="detail-pre">{detail(m)}</pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
}
