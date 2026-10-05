import { Fragment, useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/AppContext';
import { useAsync } from '../hooks/useAsync';
import { usePref } from '../lib/prefs';
import {
  getSavedSearches,
  getNotificationTargets,
  createSearchAlert,
  updateSavedSearch,
  updateSearchNotification,
  deleteSavedSearch,
  runSearch,
  savedSearchesLink,
  IS_DEMO,
  type SearchRun,
} from '../api/client';
import type { NotificationTarget, SavedSearch } from '../api/types';
import {
  ALERT_CATALOG,
  ALERT_CATEGORIES,
  PRIORITIES,
  alertNotifications,
  buildAlert,
  logicOf,
  priorityOf,
  relabel,
  sameLogic,
  stripPriority,
  type AlertCategory,
  type AlertDelivery,
  type AlertLogic,
  type AlertTemplate,
  type Priority,
} from '../lib/alertCatalog';
import { Card, StatTile, Loading, ErrorBanner, HealthBadge } from '../components/ui';

const templateById = new Map(ALERT_CATALOG.map((t) => [t.id, t]));

const PRIORITY_ACCENT: Record<Priority, string> = {
  P1: 'var(--critical)',
  P2: 'var(--warning)',
  P3: 'var(--series-in)',
};

function isActive(s: SavedSearch): boolean {
  return s.schedule?.enabled === true && s.schedule.notifications?.disabled !== true;
}

/** Where an alert is delivered: email recipients and/or in-product system notifications. */
function deliveries(s: SavedSearch, bulletinIds: Set<string>): string {
  const notifications = alertNotifications(s);
  const to = notifications.flatMap((n) =>
    (n.targetConfigs ?? []).map((t) => t.conf?.emailRecipient?.to ?? ''),
  );
  const system = notifications.some((n) => (n.targets ?? []).some((id) => bulletinIds.has(id)));
  return [...new Set(to.filter(Boolean)), ...(system ? ['System notification'] : [])].join(', ');
}

function triggerText(s: SavedSearch): string {
  const conf = alertNotifications(s)[0]?.conf ?? {};
  if (conf.triggerType === 'custom') return String(conf.trigger ?? 'custom');
  return `results ${String(conf.triggerComparator ?? '>')} ${String(conf.triggerCount ?? 0)}`;
}

function PrioritySelect({
  value,
  onChange,
  allowNone,
  disabled,
}: {
  value: Priority | null;
  onChange: (p: Priority | null) => void;
  allowNone?: boolean;
  disabled?: boolean;
}) {
  return (
    <select
      className={`select prio-select ${value ? `prio-${value.toLowerCase()}` : ''}`}
      value={value ?? ''}
      disabled={disabled}
      aria-label="Priority"
      onChange={(e) => onChange((e.target.value || null) as Priority | null)}
    >
      {allowNone && <option value="">—</option>}
      {PRIORITIES.map((p) => (
        <option key={p} value={p}>
          {p}
        </option>
      ))}
    </select>
  );
}

/** Ignore row clicks that land on a control inside the row. */
function isControl(target: EventTarget): boolean {
  return target instanceof Element && !!target.closest('button, select, input, a, textarea');
}

/** Drill-in under an alert row: the search behind the alert, editable in place. */
function AlertLogicPanel({
  logic,
  defaults,
  trigger,
  saveLabel,
  note,
  onSave,
}: {
  logic: AlertLogic;
  /** Catalog defaults, when the alert has them — enables "Reset to default". */
  defaults?: AlertLogic;
  trigger: string;
  saveLabel: string;
  note: string;
  /** Resolves to an error message, or '' once saved. */
  onSave: (next: AlertLogic) => Promise<string>;
}) {
  const [draft, setDraft] = useState(logic);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SearchRun | null>(null);
  const dirty = !sameLogic(draft, logic);

  /** Run the query as it stands in the editor, saved or not. */
  async function run() {
    setError('');
    setResult(null);
    setRunning(true);
    try {
      setResult(await runSearch(draft.query.trim(), draft.earliest.trim() || '-1h'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  async function save() {
    const next = { query: draft.query.trim(), earliest: draft.earliest.trim(), cron: draft.cron.trim() };
    if (!next.query) return setError('The query cannot be empty.');
    if (!next.earliest) return setError('Enter how far back the search looks, for example -1h.');
    if (next.cron.split(/\s+/).length !== 5)
      return setError('The schedule must be a 5-field cron expression, for example */15 * * * *.');
    setError('');
    setBusy(true);
    const failure = await onSave(next);
    setBusy(false);
    if (failure) setError(failure);
    else setDraft(next);
  }

  return (
    <div className="alert-logic">
      <label className="form-field">
        <span className="dk">Query</span>
        <textarea
          className="select logic-query"
          spellCheck={false}
          rows={Math.min(22, draft.query.split('\n').length + 1)}
          value={draft.query}
          onChange={(e) => setDraft({ ...draft, query: e.target.value })}
        />
      </label>
      <div className="logic-fields">
        <label className="form-field">
          <span className="dk">Looks back</span>
          <input
            className="select mono"
            value={draft.earliest}
            onChange={(e) => setDraft({ ...draft, earliest: e.target.value })}
            placeholder="-1h"
          />
        </label>
        <label className="form-field">
          <span className="dk">Schedule (cron, UTC)</span>
          <input
            className="select mono"
            value={draft.cron}
            onChange={(e) => setDraft({ ...draft, cron: e.target.value })}
            placeholder="*/15 * * * *"
          />
        </label>
        <div className="form-field">
          <span className="dk">Fires when</span>
          <div className="mono" style={{ fontSize: 12.5, padding: '8px 0' }}>
            {trigger}
          </div>
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-sm" disabled={running || !draft.query.trim()} onClick={() => void run()}>
          {running ? 'Searching…' : 'Run search'}
        </button>
        <button className="btn btn-sm btn-primary" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? 'Saving…' : saveLabel}
        </button>
        <button className="btn btn-sm" disabled={!dirty || busy} onClick={() => setDraft(logic)}>
          Discard edits
        </button>
        {defaults && !sameLogic(draft, defaults) && (
          <button className="btn btn-sm" disabled={busy} onClick={() => setDraft(defaults)}>
            Reset to default
          </button>
        )}
        <span className="muted" style={{ fontSize: 11.5 }}>
          {note}
        </span>
      </div>
      {result && <SearchResults result={result} />}
    </div>
  );
}

/** Inline rows from a test run of an alert's query. */
function SearchResults({ result }: { result: SearchRun }) {
  const columns = [...new Set(result.rows.flatMap((r) => Object.keys(r)))];
  if (result.rows.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 12.5 }}>
        No rows — nothing matches right now, so this alert would not fire.
        {IS_DEMO && ' (Demo mode does not run searches.)'}
      </div>
    );
  }
  return (
    <div>
      <div className="muted" style={{ fontSize: 12.5, paddingBottom: 6 }}>
        {result.total} {result.total === 1 ? 'row' : 'rows'} — an alert that fires on results &gt; 0 would
        fire now.{result.total > result.rows.length && ` Showing the first ${result.rows.length}.`}
      </div>
      <div className="table-wrap logic-results">
        <table className="data">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c} className="no-sort">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c} className="mono" style={{ fontSize: 12 }}>
                    {r[c] == null ? '—' : typeof r[c] === 'object' ? JSON.stringify(r[c]) : String(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Cribl's rule for saved-search names.
const ALERT_NAME = /^[a-zA-Z0-9 _-]{1,200}$/;

/** Popup that collects what enabling a catalog alert needs: priority and delivery. */
function EnableDialog({
  template,
  canEmail,
  canNotify,
  defaultTo,
  defaultCc,
  cloneName,
  onCancel,
  onEnable,
}: {
  template: AlertTemplate;
  /** Set when cloning: the starting name for the copy, which the user can change. */
  cloneName?: string;
  canEmail: boolean;
  canNotify: boolean;
  defaultTo: string;
  defaultCc: string;
  onCancel: () => void;
  /** Resolves to an error message, or '' once the alert is enabled. */
  onEnable: (priority: Priority, delivery: AlertDelivery, name: string) => Promise<string>;
}) {
  const cloning = cloneName != null;
  const [name, setName] = useState(cloneName ?? template.name);
  const [priority, setPriority] = useState<Priority>(template.priority);
  const [system, setSystem] = useState(canNotify);
  const [email, setEmail] = useState(canEmail && !!defaultTo);
  const [to, setTo] = useState(defaultTo);
  const [cc, setCc] = useState(defaultCc);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  async function submit() {
    if (cloning && !ALERT_NAME.test(name.trim()))
      return setError('The name can use letters, numbers, spaces, hyphens, and underscores.');
    if (!system && !email) return setError('Choose at least one way to be notified.');
    if (email && !to.trim()) return setError('Enter who should receive the alert email.');
    setError('');
    setBusy(true);
    const failure = await onEnable(
      priority,
      { system, ...(email ? { email: { to: to.trim(), cc: cc.trim() } } : {}) },
      name.trim(),
    );
    // On success the parent unmounts this dialog.
    if (failure) {
      setError(failure);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${cloning ? 'Clone' : 'Enable'} ${template.name}`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div>
          <div className="card-title">{cloning ? 'Clone alert' : 'Enable alert'}</div>
          <div style={{ fontWeight: 550, paddingTop: 6 }}>{template.name}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {cloning
              ? 'Creates a separate alert with its own name. Its query, look-back, and schedule start as a copy and can be edited afterwards.'
              : template.description}
          </div>
        </div>

        {cloning && (
          <label className="form-field">
            <span className="dk">Name</span>
            <input className="select" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        )}

        <label className="form-field">
          <span className="dk">Priority</span>
          <PrioritySelect value={priority} onChange={(p) => p && setPriority(p)} />
        </label>

        <div className="form-field">
          <span className="dk">Notify by</span>
          <label className="check-row">
            <input
              type="checkbox"
              checked={system}
              disabled={!canNotify}
              onChange={(e) => setSystem(e.target.checked)}
            />
            System notification in Cribl
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={email}
              disabled={!canEmail}
              onChange={(e) => setEmail(e.target.checked)}
            />
            Email{!canEmail && ' (no SMTP notification target configured)'}
          </label>
        </div>

        {email && (
          <>
            <label className="form-field">
              <span className="dk">Email to</span>
              <input
                className="select"
                type="email"
                autoFocus
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="you@example.com"
              />
            </label>
            <label className="form-field">
              <span className="dk">Cc (optional)</span>
              <input className="select" value={cc} onChange={(e) => setCc(e.target.value)} />
            </label>
          </>
        )}

        {error && <ErrorBanner message={error} />}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : cloning ? 'Create clone' : 'Enable alert'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function SearchAlerts() {
  const { tick } = useApp();
  // Alert CRUD needs an immediate refetch after each mutation, independent of
  // the global refresh tick.
  const [rev, setRev] = useState(0);

  const saved = useAsync<SavedSearch[]>(() => getSavedSearches(), [tick, rev]);
  const targets = useAsync<NotificationTarget[]>(() => getNotificationTargets(), [tick]);
  const smtp = (targets.data ?? []).find((t) => t.type === 'smtp');
  const bulletinIds = useMemo(
    () => new Set((targets.data ?? []).filter((t) => t.type === 'bulletin_message').map((t) => t.id)),
    [targets.data],
  );

  // Last-used recipient, remembered so the enable popup can prefill it.
  const [to, setTo] = usePref('alertEmailTo', '');
  const [cc, setCc] = usePref('alertEmailCc', '');
  // Catalog alert whose enable popup is open.
  const [enabling, setEnabling] = useState<AlertTemplate | null>(null);
  // Catalog alert being cloned into a separate, renamed alert.
  const [cloning, setCloning] = useState<AlertTemplate | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState('');
  const [filter, setFilter] = useState<'all' | Priority | 'none'>('all');
  const [showOff, setShowOff] = useState(false);
  // Catalog filters.
  const [catPriority, setCatPriority] = useState<'all' | Priority>('all');
  const [catStatus, setCatStatus] = useState<'all' | 'enabled' | 'available'>('all');
  const [catCategory, setCatCategory] = useState<'all' | AlertCategory>('all');
  // Rows drilled into, keyed per table so an alert can be open in either.
  const [open, setOpen] = useState<Set<string>>(new Set());
  // Logic edits to catalog alerts that are not enabled yet; applied on enable.
  const [drafts, setDrafts] = useState<Record<string, AlertLogic>>({});

  const byId = useMemo(() => new Map((saved.data ?? []).map((s) => [s.id, s])), [saved.data]);
  const alerts = useMemo(
    () => (saved.data ?? []).filter((s) => alertNotifications(s).length > 0),
    [saved.data],
  );
  const active = alerts.filter(isActive);
  const count = (p: Priority) => active.filter((s) => priorityOf(s.name) === p).length;
  const installed = ALERT_CATALOG.filter((t) => byId.has(t.id)).length;
  const catalog = useMemo(
    () =>
      ALERT_CATALOG.filter((t) => {
        const live = byId.get(t.id);
        // An enabled alert is filtered by the label it carries now, not its default.
        const priority = live ? priorityOf(live.name) : t.priority;
        return (
          (catPriority === 'all' || priority === catPriority) &&
          (catStatus === 'all' || (catStatus === 'enabled') === !!live) &&
          (catCategory === 'all' || t.category === catCategory)
        );
      }),
    [byId, catPriority, catStatus, catCategory],
  );

  const rows = useMemo(() => {
    const order = (s: SavedSearch) => {
      const p = priorityOf(s.name);
      return p ? PRIORITIES.indexOf(p) : PRIORITIES.length;
    };
    return alerts
      .filter((s) => showOff || isActive(s))
      .filter((s) => filter === 'all' || (priorityOf(s.name) ?? 'none') === filter)
      .sort((a, b) => order(a) - order(b) || stripPriority(a.name).localeCompare(stripPriority(b.name)));
  }, [alerts, filter, showOff]);
  const turnedOff = alerts.length - active.length;

  async function run(key: string, fn: () => Promise<void>) {
    setError('');
    setBusy(key);
    try {
      await fn();
      setRev((r) => r + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  function toggleOpen(key: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** Write edited logic to an existing alert. */
  async function saveLogic(s: SavedSearch, next: AlertLogic): Promise<string> {
    try {
      await updateSavedSearch({
        ...s,
        query: next.query,
        earliest: next.earliest,
        schedule: { ...s.schedule, cronSchedule: next.cron },
      });
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    setRev((r) => r + 1);
    return '';
  }

  async function enable(t: AlertTemplate, priority: Priority, delivery: AlertDelivery): Promise<string> {
    try {
      await createSearchAlert(buildAlert({ ...t, ...drafts[t.id] }, priority, delivery));
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    if (delivery.email) {
      setTo(delivery.email.to);
      setCc(delivery.email.cc ?? '');
    }
    setEnabling(null);
    setRev((r) => r + 1);
    return '';
  }

  /** Create a separate alert from a catalog alert, under a new name and id. */
  async function clone(t: AlertTemplate, priority: Priority, delivery: AlertDelivery, name: string): Promise<string> {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    let id = `criblvision_${slug}`;
    for (let n = 2; byId.has(id); n++) id = `criblvision_${slug}_${n}`;
    const live = byId.get(t.id);
    const logic = live ? logicOf(live) : (drafts[t.id] ?? t);
    try {
      await createSearchAlert(buildAlert({ ...t, ...logic, id, name }, priority, delivery));
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    setCloning(null);
    setShowOff(false);
    setRev((r) => r + 1);
    return '';
  }

  function remove(id: string) {
    if (confirmRemove !== id) return setConfirmRemove(id);
    setConfirmRemove('');
    void run(id, () => deleteSavedSearch(id));
  }

  function setPriority(s: SavedSearch, p: Priority | null) {
    void run(s.id, async () => {
      const next = relabel(s, p);
      await updateSavedSearch(next.search);
      for (const n of next.notifications) await updateSearchNotification(s.id, n);
    });
  }

  function toggle(s: SavedSearch) {
    // An alert is off when either its schedule or its notifications are disabled,
    // so turning it on has to clear both.
    const on = !isActive(s);
    const notifications = s.schedule?.notifications;
    void run(s.id, () =>
      updateSavedSearch({
        ...s,
        schedule: {
          ...s.schedule,
          enabled: on,
          ...(on && notifications ? { notifications: { ...notifications, disabled: false } } : {}),
        },
      }),
    );
  }

  return (
    <>
      <div className="grid grid-4">
        {PRIORITIES.map((p) => (
          <StatTile
            key={p}
            label={`${p} Alerts Active`}
            value={String(count(p))}
            accent={PRIORITY_ACCENT[p]}
            active={filter === p && catPriority === p}
            onClick={() => {
              const next = filter === p && catPriority === p ? 'all' : p;
              setFilter(next);
              setCatPriority(next);
            }}
          />
        ))}
        <StatTile
          label="Catalog Enabled"
          value={`${installed} / ${ALERT_CATALOG.length}`}
          accent="var(--accent)"
          active={catStatus === 'enabled'}
          onClick={() => setCatStatus(catStatus === 'enabled' ? 'all' : 'enabled')}
          foot={
            <span>
              {smtp ? `email via ${smtp.id}` : 'system notifications only'}
              {IS_DEMO && ' · demo'}
            </span>
          }
        />
      </div>

      {error && <ErrorBanner message={error} />}

      <Card
        title="Alert Catalog"
        right={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              className="select"
              aria-label="Filter by category"
              value={catCategory}
              onChange={(e) => setCatCategory(e.target.value as 'all' | AlertCategory)}
            >
              <option value="all">All categories</option>
              {ALERT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              className="select"
              aria-label="Filter by status"
              value={catStatus}
              onChange={(e) => setCatStatus(e.target.value as 'all' | 'enabled' | 'available')}
            >
              <option value="all">Any status</option>
              <option value="enabled">Enabled</option>
              <option value="available">Not enabled</option>
            </select>
            <div className="pill-tabs">
              {(['all', ...PRIORITIES] as const).map((f) => (
                <button
                  key={f}
                  className={`pill-tab ${catPriority === f ? 'active' : ''}`}
                  onClick={() => setCatPriority(f)}
                >
                  {f === 'all' ? 'All' : f}
                </button>
              ))}
            </div>
          </div>
        }
      >
        {saved.loading && !saved.data ? (
          <Loading />
        ) : saved.error ? (
          <ErrorBanner message={saved.error} />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="no-sort">Priority</th>
                  <th className="no-sort">Alert</th>
                  <th className="no-sort">Fires When</th>
                  <th className="no-sort">Schedule</th>
                  <th className="no-sort">Status</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {catalog.map((t, i) => {
                  const live = byId.get(t.id);
                  const newSection = t.category !== catalog[i - 1]?.category;
                  const key = `catalog:${t.id}`;
                  const isOpen = open.has(key);
                  const logic = live ? logicOf(live) : (drafts[t.id] ?? t);
                  return (
                    <Fragment key={t.id}>
                      {newSection && (
                        <tr>
                          <td colSpan={6} className="catalog-section">
                            {t.category}
                          </td>
                        </tr>
                      )}
                      <tr className="row-expandable" onClick={(e) => !isControl(e.target) && toggleOpen(key)}>
                        <td>
                          {live ? (
                            <PrioritySelect
                              value={priorityOf(live.name)}
                              allowNone
                              disabled={busy === t.id}
                              onChange={(p) => setPriority(live, p)}
                            />
                          ) : (
                            <span className={`prio-chip prio-${t.priority.toLowerCase()}`}>{t.priority}</span>
                          )}
                        </td>
                        <td>
                          <div style={{ fontWeight: 550 }}>
                            <span className={`row-caret ${isOpen ? 'open' : ''}`}>▶</span>
                            {t.name}
                            {!sameLogic(logic, t) && (
                              <span className="type-chip" style={{ marginLeft: 8 }}>
                                Edited
                              </span>
                            )}
                          </div>
                          <div className="muted" style={{ fontSize: 12, maxWidth: 520 }}>
                            {t.description}
                          </div>
                        </td>
                        <td style={{ fontSize: 12.5 }}>{t.fires}</td>
                        <td className="mono" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
                          {logic.cron}
                        </td>
                        <td>
                          {live ? (
                            <HealthBadge
                              health={isActive(live) ? 'Green' : 'Unknown'}
                              label={isActive(live) ? 'Enabled' : 'Turned off'}
                            />
                          ) : (
                            <span className="muted" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
                              Not enabled
                            </span>
                          )}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {live ? (
                            <button
                              className="btn btn-sm"
                              disabled={busy === t.id}
                              style={confirmRemove === t.id ? { color: 'var(--critical)' } : undefined}
                              onClick={() => remove(t.id)}
                            >
                              {confirmRemove === t.id ? 'Confirm remove' : 'Remove'}
                            </button>
                          ) : (
                            <button className="btn btn-sm" onClick={() => setEnabling(t)}>
                              Enable
                            </button>
                          )}{' '}
                          <button
                            className="btn btn-sm"
                            title="Create a separate copy you can rename and customize"
                            onClick={() => setCloning(t)}
                          >
                            Clone
                          </button>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td className="detail-cell" colSpan={6}>
                            <AlertLogicPanel
                              key={live ? 'live' : 'draft'}
                              logic={logic}
                              defaults={t}
                              trigger={live ? triggerText(live) : 'results > 0'}
                              saveLabel={live ? 'Save changes' : 'Keep edits'}
                              note={
                                live
                                  ? 'Saving updates the scheduled search in Cribl Search.'
                                  : 'Edits are used when you enable this alert.'
                              }
                              onSave={
                                live
                                  ? (next) => saveLogic(live, next)
                                  : (next) => {
                                      setDrafts((d) => ({ ...d, [t.id]: next }));
                                      return Promise.resolve('');
                                    }
                              }
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {catalog.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                      No catalog alerts match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        <div className="muted" style={{ fontSize: 11.5, paddingTop: 10 }}>
          Enabling an alert creates a scheduled search in Cribl Search that reads Cribl's built-in
          internal metrics and Leader logs across every worker group and notifies you by system
          notification, email, or both when it fires.
          {IS_DEMO && ' Demo mode: stored locally, no email is sent.'}
        </div>
      </Card>

      <Card
        title="Scheduled Search Alerts"
        right={
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <label
              style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5 }}
              title="Alerts that exist in Cribl Search but whose schedule is switched off, so they never run"
            >
              <input
                type="checkbox"
                checked={showOff}
                onChange={(e) => setShowOff(e.target.checked)}
              />
              Include turned-off alerts ({turnedOff})
            </label>
            <div className="pill-tabs">
              {(['all', ...PRIORITIES, 'none'] as const).map((f) => (
                <button
                  key={f}
                  className={`pill-tab ${filter === f ? 'active' : ''}`}
                  onClick={() => setFilter(f)}
                >
                  {f === 'all' ? 'All' : f === 'none' ? 'Unlabeled' : f}
                </button>
              ))}
            </div>
          </div>
        }
      >
        {saved.loading && !saved.data ? (
          <Loading />
        ) : saved.error ? null : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="no-sort">Priority</th>
                  <th className="no-sort">Alert</th>
                  <th className="no-sort">Trigger</th>
                  <th className="no-sort">Schedule</th>
                  <th className="no-sort">Notifies</th>
                  <th className="no-sort">Status</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const key = `scheduled:${s.id}`;
                  const isOpen = open.has(key);
                  return (
                    <Fragment key={s.id}>
                      <tr className="row-expandable" onClick={(e) => !isControl(e.target) && toggleOpen(key)}>
                        <td>
                          <PrioritySelect
                            value={priorityOf(s.name)}
                            allowNone
                            disabled={busy === s.id}
                            onChange={(p) => setPriority(s, p)}
                          />
                        </td>
                        <td className="id-cell" title={s.description || s.id}>
                          <span className={`row-caret ${isOpen ? 'open' : ''}`}>▶</span>
                          {stripPriority(s.name) || s.id}
                        </td>
                        <td className="mono" style={{ fontSize: 12.5 }}>
                          {triggerText(s)}
                        </td>
                        <td className="mono" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
                          {s.schedule?.cronSchedule ?? '—'}
                        </td>
                        <td className="muted" style={{ fontSize: 12.5 }}>
                          {deliveries(s, bulletinIds) || '—'}
                        </td>
                        <td>
                          <HealthBadge
                            health={isActive(s) ? 'Green' : 'Unknown'}
                            label={isActive(s) ? 'Active' : 'Turned off'}
                          />
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className="btn btn-sm" disabled={busy === s.id} onClick={() => toggle(s)}>
                            {isActive(s) ? 'Turn off' : 'Turn on'}
                          </button>
                          {s.id.startsWith('criblvision_') && (
                            <>
                              {' '}
                              <button
                                className="btn btn-sm"
                                disabled={busy === s.id}
                                style={confirmRemove === s.id ? { color: 'var(--critical)' } : undefined}
                                onClick={() => remove(s.id)}
                              >
                                {confirmRemove === s.id ? 'Confirm remove' : 'Remove'}
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td className="detail-cell" colSpan={7}>
                            <AlertLogicPanel
                              logic={logicOf(s)}
                              defaults={templateById.get(s.id)}
                              trigger={triggerText(s)}
                              saveLabel="Save changes"
                              note="Saving updates the scheduled search in Cribl Search."
                              onSave={(next) => saveLogic(s, next)}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                      {alerts.length === 0
                        ? 'No scheduled search alerts yet — enable one from the catalog above.'
                        : 'No alerts match this filter.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {savedSearchesLink() && (
          <div style={{ paddingTop: 10 }}>
            <a
              className="btn"
              href={savedSearchesLink()}
              target="_top"
              rel="noreferrer"
              style={{ textDecoration: 'none' }}
            >
              Manage Saved Searches in Cribl Search ↗
            </a>
          </div>
        )}
      </Card>

      {enabling && (
        <EnableDialog
          key={enabling.id}
          template={enabling}
          canEmail={!!smtp}
          canNotify={bulletinIds.size > 0}
          defaultTo={to}
          defaultCc={cc}
          onCancel={() => setEnabling(null)}
          onEnable={(priority, delivery) => enable(enabling, priority, delivery)}
        />
      )}
      {cloning && (
        <EnableDialog
          key={`clone:${cloning.id}`}
          template={cloning}
          cloneName={`${cloning.name} copy`}
          canEmail={!!smtp}
          canNotify={bulletinIds.size > 0}
          defaultTo={to}
          defaultCc={cc}
          onCancel={() => setCloning(null)}
          onEnable={(priority, delivery, name) => clone(cloning, priority, delivery, name)}
        />
      )}
    </>
  );
}
