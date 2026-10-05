import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/AppContext';
import { useAsync } from '../hooks/useAsync';
import {
  getNotifications,
  getNotificationTargets,
  createNotification,
  updateNotification,
  deleteNotification,
  getInputStatuses,
  getOutputStatuses,
  getCurrentUser,
  streamLink,
  IS_DEMO,
  type NotificationWithGroup,
} from '../api/client';
import type { CriblNotification, NotificationTarget } from '../api/types';
import { Card, StatTile, Loading, ErrorBanner, HealthBadge } from '../components/ui';
import { SearchAlerts } from './SearchAlerts';

// The native Cribl notification conditions CriblVision can manage. Cribl's leader
// evaluates these server-side and delivers email through the SMTP target, so
// alerts fire even when nobody has the dashboard open.
interface ConditionDef {
  id: string;
  label: string;
  object: 'source' | 'destination';
  defaultWindow: string;
  volume?: boolean; // needs a dataVolume threshold (e.g. "1MB")
  usage?: boolean; // needs a usageThreshold percent
}

const CONDITIONS: ConditionDef[] = [
  { id: 'unhealthy-dest', label: 'Destination unhealthy', object: 'destination', defaultWindow: '60s' },
  { id: 'backpressure-dest', label: 'Destination backpressure engaged', object: 'destination', defaultWindow: '60s' },
  { id: 'persistent-queue-usage', label: 'Destination PQ usage above %', object: 'destination', defaultWindow: '60s', usage: true },
  { id: 'persistent-queue-usage-source', label: 'Source PQ usage above %', object: 'source', defaultWindow: '60s', usage: true },
  { id: 'no-data', label: 'Source received no data', object: 'source', defaultWindow: '5m' },
  { id: 'low-volume', label: 'Source volume below threshold', object: 'source', defaultWindow: '60s', volume: true },
  { id: 'high-volume', label: 'Source volume above threshold', object: 'source', defaultWindow: '60s', volume: true },
];

const conditionById = new Map(CONDITIONS.map((c) => [c.id, c]));

function conditionLabel(id: string): string {
  return conditionById.get(id)?.label ?? id;
}

function emailTo(n: CriblNotification): string {
  const smtp = (n.targetConfigs ?? []).find((t) => t.id === 'system_email');
  return smtp?.conf?.emailRecipient?.to ?? '';
}

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function StreamAlerts() {
  const { groups, group, tick } = useApp();
  // Alert CRUD needs an immediate refetch after each mutation, independent of
  // the global refresh tick.
  const [rev, setRev] = useState(0);

  const groupIds = useMemo(() => groups.map((g) => g.id), [groups]);
  const idKey = groupIds.join(',');

  const alerts = useAsync<NotificationWithGroup[]>(
    () => (groupIds.length ? getNotifications(groupIds) : Promise.resolve([])),
    [idKey, tick, rev],
  );
  const targets = useAsync<NotificationTarget[]>(() => getNotificationTargets(), [tick]);

  const smtp = (targets.data ?? []).find((t) => t.type === 'smtp');
  const rows = useMemo(
    () => (alerts.data ?? []).filter((n) => group === 'all' || n.group === group),
    [alerts.data, group],
  );
  const active = rows.filter((n) => !n.disabled);

  // ---- create form ----
  const [condition, setCondition] = useState(CONDITIONS[0].id);
  const [formGroup, setFormGroup] = useState('');
  const [name, setName] = useState('');
  const [timeWindow, setTimeWindow] = useState(CONDITIONS[0].defaultWindow);
  const [dataVolume, setDataVolume] = useState('1MB');
  const [usageThreshold, setUsageThreshold] = useState(90);
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [resolution, setResolution] = useState(true);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState('');

  const condDef = conditionById.get(condition) ?? CONDITIONS[0];
  const effGroup = formGroup || groups[0]?.id || '';

  // Prefill the recipient with the signed-in Cribl user's email.
  useEffect(() => {
    void getCurrentUser().then((u) => {
      if (u?.email) setTo((prev) => prev || u.email!);
    });
  }, []);

  // Objects the chosen condition can watch, from the live source/dest inventory.
  const objects = useAsync<string[]>(
    async () => {
      if (!effGroup) return [];
      const items =
        condDef.object === 'source'
          ? await getInputStatuses([effGroup])
          : await getOutputStatuses([effGroup]);
      return [...new Set(items.map((i) => i.id))].sort();
    },
    [effGroup, condDef.object, tick],
  );

  async function submit() {
    setFormError('');
    if (!effGroup) return setFormError('Pick a worker group.');
    if (!name) return setFormError(`Pick a ${condDef.object} to watch.`);
    if (!to.trim()) return setFormError('Enter a recipient email address.');
    const n: CriblNotification = {
      id: slugify(`criblvision-${condition}-${name}`),
      condition,
      disabled: false,
      targets: ['system_email'],
      conf: {
        name,
        timeWindow: timeWindow || condDef.defaultWindow,
        notifyOnResolution: resolution,
        ...(condDef.volume ? { dataVolume } : {}),
        ...(condDef.usage ? { usageThreshold } : {}),
      },
      targetConfigs: [
        {
          id: 'system_email',
          conf: {
            subject: subject || `[CriblVision] ${conditionLabel(condition)}: ${name}`,
            emailRecipient: { to: to.trim(), ...(cc.trim() ? { cc: cc.trim() } : {}) },
          },
        },
      ],
    };
    setBusy(true);
    try {
      await createNotification(effGroup, n);
      setName('');
      setSubject('');
      setRev((r) => r + 1);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(n: NotificationWithGroup) {
    try {
      await updateNotification(n.group, { ...n, disabled: !n.disabled });
      setRev((r) => r + 1);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(n: NotificationWithGroup) {
    const key = `${n.group}:${n.id}`;
    if (confirmDelete !== key) {
      setConfirmDelete(key);
      return;
    }
    setConfirmDelete('');
    try {
      await deleteNotification(n.group, n.id);
      setRev((r) => r + 1);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  }

  const sent = smtp?.status?.metrics?.totalSent ?? 0;
  const sendErrors = smtp?.status?.metrics?.errorCnt ?? 0;

  return (
    <>
      <div className="grid grid-4">
        <StatTile label="Alerts Configured" value={String(rows.length)} accent="var(--accent)" />
        <StatTile
          label="Active"
          value={String(active.length)}
          accent={active.length > 0 ? 'var(--good)' : 'var(--warning)'}
          foot={
            rows.length > active.length ? <span>{rows.length - active.length} disabled</span> : undefined
          }
        />
        <StatTile
          label="Email Target"
          value={smtp ? smtp.id : 'none'}
          accent={smtp ? (smtp.status?.health === 'Green' ? 'var(--good)' : 'var(--critical)') : 'var(--critical)'}
          foot={smtp ? <span>{sent} sent · {sendErrors} errors</span> : <span>no SMTP target configured</span>}
        />
        <StatTile
          label="Delivery"
          value={IS_DEMO ? 'demo' : 'via Cribl leader'}
          accent="var(--series-out)"
          foot={<span>conditions evaluated server-side</span>}
        />
      </div>

      {!smtp && !targets.loading && (
        <ErrorBanner message="No SMTP notification target found. Cribl.Cloud provides system_email out of the box; on-prem, add one under Settings → Notifications → Targets before creating email alerts." />
      )}

      <div className="grid grid-3">
        <Card title="Configured Alerts" className="col-span-2">
          {alerts.loading && !alerts.data ? (
            <Loading />
          ) : alerts.error ? (
            <ErrorBanner message={alerts.error} />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th className="no-sort">Condition</th>
                    <th className="no-sort">Watching</th>
                    <th className="no-sort">Group</th>
                    <th className="no-sort">Email To</th>
                    <th className="no-sort">Status</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((n) => {
                    const key = `${n.group}:${n.id}`;
                    const watching = typeof n.conf?.name === 'string' ? (n.conf.name as string) : '—';
                    return (
                      <tr key={key}>
                        <td className="id-cell" title={n.id}>
                          {conditionLabel(n.condition)}
                        </td>
                        <td className="mono" style={{ fontSize: 12.5 }}>
                          {watching}
                        </td>
                        <td>
                          <span className="type-chip">{n.group}</span>
                        </td>
                        <td className="muted" style={{ fontSize: 12.5 }}>
                          {emailTo(n) || '—'}
                        </td>
                        <td>
                          <HealthBadge
                            health={n.disabled ? 'Unknown' : 'Green'}
                            label={n.disabled ? 'Disabled' : 'Active'}
                          />
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className="btn btn-sm" onClick={() => void toggle(n)}>
                            {n.disabled ? 'Enable' : 'Disable'}
                          </button>{' '}
                          <button
                            className="btn btn-sm"
                            style={confirmDelete === key ? { color: 'var(--critical)' } : undefined}
                            onClick={() => void remove(n)}
                          >
                            {confirmDelete === key ? 'Confirm delete' : 'Delete'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                        No alerts configured yet — create one on the right.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          {rows.length > 0 && streamLink('notification', rows[0].group) && (
            <div style={{ paddingTop: 10 }}>
              <a
                className="btn"
                href={streamLink('notification', rows[0].group)}
                target="_top"
                rel="noreferrer"
                style={{ textDecoration: 'none' }}
              >
                Manage Notifications in Cribl Stream ↗
              </a>
            </div>
          )}
        </Card>

        <Card title="New Email Alert">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label className="form-field">
              <span className="dk">Condition</span>
              <select
                className="select"
                value={condition}
                onChange={(e) => {
                  setCondition(e.target.value);
                  const def = conditionById.get(e.target.value);
                  if (def) setTimeWindow(def.defaultWindow);
                  setName('');
                }}
              >
                {CONDITIONS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="form-field">
              <span className="dk">Worker group</span>
              <select className="select" value={effGroup} onChange={(e) => setFormGroup(e.target.value)}>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.id}
                  </option>
                ))}
              </select>
            </label>

            <label className="form-field">
              <span className="dk">{condDef.object === 'source' ? 'Source' : 'Destination'}</span>
              <select className="select" value={name} onChange={(e) => setName(e.target.value)}>
                <option value="">
                  {objects.loading ? 'Loading…' : `Select a ${condDef.object}…`}
                </option>
                {(objects.data ?? []).map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>

            <label className="form-field">
              <span className="dk">Time window</span>
              <input
                className="select"
                value={timeWindow}
                onChange={(e) => setTimeWindow(e.target.value)}
                placeholder={condDef.defaultWindow}
              />
            </label>

            {condDef.volume && (
              <label className="form-field">
                <span className="dk">Volume threshold</span>
                <input
                  className="select"
                  value={dataVolume}
                  onChange={(e) => setDataVolume(e.target.value)}
                  placeholder="1MB"
                />
              </label>
            )}

            {condDef.usage && (
              <label className="form-field">
                <span className="dk">PQ usage threshold (%)</span>
                <input
                  className="select"
                  type="number"
                  min={1}
                  max={100}
                  value={usageThreshold}
                  onChange={(e) => setUsageThreshold(Number(e.target.value))}
                />
              </label>
            )}

            <label className="form-field">
              <span className="dk">Email to</span>
              <input
                className="select"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="you@example.com"
              />
            </label>

            <label className="form-field">
              <span className="dk">Cc (optional)</span>
              <input className="select" value={cc} onChange={(e) => setCc(e.target.value)} />
            </label>

            <label className="form-field">
              <span className="dk">Subject (optional)</span>
              <input
                className="select"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={`[CriblVision] ${condDef.label}`}
              />
            </label>

            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={resolution}
                onChange={(e) => setResolution(e.target.checked)}
              />
              Only notify on start and resolution
            </label>

            {formError && <ErrorBanner message={formError} />}

            <button className="btn" disabled={busy} onClick={() => void submit()}>
              {busy ? 'Creating…' : 'Create Alert'}
            </button>
            <div className="muted" style={{ fontSize: 11.5 }}>
              Creates a native Cribl Notification delivered through the {smtp?.id ?? 'SMTP'} target.
              {IS_DEMO && ' Demo mode: stored locally, no email is sent.'}
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}

export function Alerts() {
  const [tab, setTab] = useState<'search' | 'stream'>('search');
  return (
    <>
      <div>
        <div className="pill-tabs">
          <button className={`pill-tab ${tab === 'search' ? 'active' : ''}`} onClick={() => setTab('search')}>
            Alert Catalog
          </button>
          <button className={`pill-tab ${tab === 'stream' ? 'active' : ''}`} onClick={() => setTab('stream')}>
            Source &amp; Destination Alerts
          </button>
        </div>
      </div>
      {tab === 'search' ? <SearchAlerts /> : <StreamAlerts />}
    </>
  );
}
