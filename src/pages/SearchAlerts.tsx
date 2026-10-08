import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useApp } from '../state/AppContext';
import { useAsync } from '../hooks/useAsync';
import { usePref } from '../lib/prefs';
import {
  getSavedSearches,
  getNotificationTargets,
  createNotificationTarget,
  deleteNotificationTarget,
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
  ATTACHMENT_TYPES,
  COMPARATORS,
  PRIORITIES,
  SCHEDULE_PRESETS,
  alertNotifications,
  applyNotification,
  buildAlert,
  defaultNotification,
  logicOf,
  notificationOf,
  priorityOf,
  relabel,
  sameLogic,
  sameNotification,
  stripPriority,
  subjectWithPriority,
  type AlertCategory,
  type AlertEmail,
  type AlertLogic,
  type AlertNotification,
  type AlertTemplate,
  type Priority,
} from '../lib/alertCatalog';
import {
  WEBHOOK_KINDS,
  buildWebhookTarget,
  defaultWebhookSpec,
  serviceNowHost,
  validateWebhookSpec,
  type WebhookAuth,
  type WebhookKind,
  type WebhookSpec,
} from '../lib/webhookTargets';
import { isTestSearch, sweepTestSearches, testNotificationTarget } from '../lib/targetTest';
import { Card, StatTile, Loading, ErrorBanner } from '../components/ui';

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

/** What a notification target is, in plain words. */
function targetLabel(t: NotificationTarget): string {
  if (t.type === 'smtp') return 'Email';
  if (t.type === 'bulletin_message') return 'System notification in Cribl';
  if (t.type === 'webhook') return 'Webhook';
  if (t.type === 'pagerduty') return 'PagerDuty';
  if (t.type === 'slack') return 'Slack';
  if (t.type === 'sns') return 'AWS SNS';
  return t.type;
}

/**
 * Inline form that creates a webhook notification target — ServiceNow incident,
 * ServiceNow event, or any URL — so the alert can be sent to it.
 */
function WebhookTargetForm({
  existing,
  onCreate,
  onTest,
  testResult,
  onClose,
}: {
  existing: string[];
  /** Creates the target in Cribl; resolves to an error message, or '' once it exists. */
  onCreate: (spec: WebhookSpec) => Promise<string>;
  /** Sends a test notification to the (created) target. */
  onTest: (id: string) => void;
  /** Outcome of the test for this target, if one ran. */
  testResult?: { state: 'running' | 'ok' | 'fail'; text: string };
  onClose: () => void;
}) {
  const [spec, setSpec] = useState<WebhookSpec>(defaultWebhookSpec());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Once the target exists in Cribl its definition is fixed; the form stays
  // open so it can be tested.
  const [created, setCreated] = useState(false);
  const set = (patch: Partial<WebhookSpec>) => setSpec({ ...spec, ...patch });
  const kind = WEBHOOK_KINDS.find((k) => k.value === spec.kind)!;
  const serviceNow = spec.kind !== 'generic';
  const host = serviceNowHost(spec.instance);

  function changeKind(next: WebhookKind) {
    const fresh = defaultWebhookSpec(next);
    // Keep what carries over between kinds; the id follows the kind unless edited.
    const idWasDefault = spec.id === defaultWebhookSpec(spec.kind).id;
    setSpec({ ...fresh, instance: spec.instance, username: spec.username, password: spec.password, token: spec.token, id: idWasDefault ? fresh.id : spec.id, auth: spec.kind === 'generic' || next === 'generic' ? fresh.auth : spec.auth });
  }

  /** Create the target if it does not exist yet; true once it does. */
  async function ensureCreated(): Promise<boolean> {
    if (created) return true;
    const problem = validateWebhookSpec(spec);
    if (problem) {
      setError(problem);
      return false;
    }
    if (existing.includes(spec.id.trim())) {
      setError(`A target named "${spec.id.trim()}" already exists.`);
      return false;
    }
    setError('');
    setBusy(true);
    const failure = await onCreate({ ...spec, id: spec.id.trim() });
    setBusy(false);
    if (failure) {
      setError(failure);
      return false;
    }
    setCreated(true);
    return true;
  }

  async function submit() {
    if (await ensureCreated()) onClose();
  }

  async function test() {
    if (await ensureCreated()) onTest(spec.id.trim());
  }

  const testing = testResult?.state === 'running';

  return (
    <fieldset
      className="webhook-form"
      disabled={busy || testing}
      onKeyDown={(e) => e.key === 'Enter' && e.target instanceof HTMLInputElement && (e.preventDefault(), void submit())}
    >
      <div className="dk" style={{ marginBottom: 0 }}>
        New webhook target
      </div>
      <div className="logic-fields">
        <label className="form-field">
          <span className="dk">Destination</span>
          <select className="select" value={spec.kind} onChange={(e) => changeKind(e.target.value as WebhookKind)}>
            {WEBHOOK_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span className="dk">Target id</span>
          <input className="select mono" value={spec.id} onChange={(e) => set({ id: e.target.value })} />
        </label>
      </div>
      <div className="muted" style={{ fontSize: 11.5 }}>
        {kind.hint}
      </div>
      {serviceNow ? (
        <label className="form-field">
          <span className="dk">ServiceNow instance</span>
          <input
            className="select"
            value={spec.instance}
            placeholder="acme  or  acme.service-now.com"
            onChange={(e) => set({ instance: e.target.value })}
          />
          {host && (
            <span className="muted mono" style={{ fontSize: 11.5 }}>
              https://{host}
              {spec.kind === 'servicenow_incident' ? '/api/now/table/incident' : '/api/global/em/jsonv2'}
            </span>
          )}
        </label>
      ) : (
        <label className="form-field">
          <span className="dk">Webhook URL</span>
          <input
            className="select mono"
            value={spec.url}
            placeholder="https://hooks.example.com/…"
            onChange={(e) => set({ url: e.target.value })}
          />
        </label>
      )}
      <div className="logic-fields">
        <label className="form-field">
          <span className="dk">Authentication</span>
          <select className="select" value={spec.auth} onChange={(e) => set({ auth: e.target.value as WebhookAuth })}>
            <option value="basic">Basic (username and password)</option>
            <option value="token">Bearer token</option>
            <option value="none">None</option>
          </select>
        </label>
        {spec.auth === 'basic' && (
          <>
            <label className="form-field">
              <span className="dk">Username</span>
              <input className="select" autoComplete="off" value={spec.username} onChange={(e) => set({ username: e.target.value })} />
            </label>
            <label className="form-field">
              <span className="dk">Password</span>
              <input className="select" type="password" autoComplete="new-password" value={spec.password} onChange={(e) => set({ password: e.target.value })} />
            </label>
          </>
        )}
        {spec.auth === 'token' && (
          <label className="form-field">
            <span className="dk">Token</span>
            <input className="select" type="password" autoComplete="off" value={spec.token} onChange={(e) => set({ token: e.target.value })} />
          </label>
        )}
      </div>
      {spec.kind === 'servicenow_incident' && (
        <div className="logic-fields">
          <label className="form-field">
            <span className="dk">Assignment group (optional)</span>
            <input className="select" value={spec.assignmentGroup} onChange={(e) => set({ assignmentGroup: e.target.value })} />
          </label>
          <label className="form-field">
            <span className="dk">Caller (optional)</span>
            <input className="select" value={spec.caller} placeholder="user id or sys_id" onChange={(e) => set({ caller: e.target.value })} />
          </label>
        </div>
      )}
      {spec.kind === 'servicenow_event' && (
        <label className="form-field">
          <span className="dk">Event source</span>
          <input className="select" value={spec.source} onChange={(e) => set({ source: e.target.value })} />
        </label>
      )}
      <div className="muted" style={{ fontSize: 11.5 }}>
        {spec.kind === 'servicenow_incident' &&
          'Each fired alert opens an incident: the alert name becomes the short description, the message and results the description, and P1 / P2 / P3 set urgency and impact to 1 / 2 / 3.'}
        {spec.kind === 'servicenow_event' &&
          'Each fired alert pushes one event: the alert name is the type, the search id the resource and message key, and P1 / P2 / P3 map to severity 1 / 2 / 3.'}
        {spec.kind === 'generic' && 'The full notification event is posted as a JSON array with one element.'}{' '}
        Credentials are stored on the target in Cribl, not in this app.
      </div>
      {error && <ErrorBanner message={error} />}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => void submit()}>
          {busy ? 'Creating…' : created ? 'Done' : 'Create target'}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          title="Creates the target if needed, then sends one test notification through it (a minute or so: Cribl can only test by firing a real notification through its scheduler)"
          onClick={() => void test()}
        >
          {testing ? 'Testing…' : created ? 'Test' : 'Create & test'}
        </button>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          {created ? 'Close' : 'Cancel'}
        </button>
        {testResult && (
          <span className={`target-test ${testResult.state}`} role="status">
            {testResult.state === 'ok' ? '✓ ' : testResult.state === 'fail' ? '✕ ' : ''}
            {testResult.text}
          </span>
        )}
      </div>
    </fieldset>
  );
}

/** Rename the email subject and message headline when they still carry `from`. */
function retitle(n: AlertNotification, from: string, to: string, p: Priority): AlertNotification {
  const base = stripPriority(from);
  const subject = stripPriority(n.email.subject) === base ? subjectWithPriority(to, p) : n.email.subject;
  const [headline, ...rest] = n.message.split('\n');
  const message = stripPriority(headline) === base ? [subjectWithPriority(to, p), ...rest].join('\n') : n.message;
  return { ...n, email: { ...n.email, subject }, message };
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

/** On/off switch with its state spelled out next to it. */
function Switch({
  on,
  label,
  tone,
  title,
  disabled,
  onClick,
}: {
  on: boolean;
  label: string;
  tone?: 'warn';
  title?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`switch ${on ? 'on' : ''} ${tone ?? ''}`}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="switch-track">
        <span className="switch-knob" />
      </span>
      <span className="switch-label">{label}</span>
    </button>
  );
}

/** Ignore row clicks that land on a control inside the row. */
function isControl(target: EventTarget): boolean {
  return target instanceof Element && !!target.closest('button, select, input, a, textarea, label');
}

/** Look-back and schedule, with a preset picker next to the raw cron. */
function ScheduleFields({
  draft,
  onChange,
  trigger,
}: {
  draft: AlertLogic;
  onChange: (next: AlertLogic) => void;
  /** Read-only firing condition, shown when the notification is not editable here. */
  trigger?: string;
}) {
  const preset = SCHEDULE_PRESETS.some((p) => p.cron === draft.cron.trim()) ? draft.cron.trim() : 'custom';
  return (
    <div className="logic-fields">
      <label className="form-field">
        <span className="dk">Looks back</span>
        <input
          className="select mono"
          value={draft.earliest}
          onChange={(e) => onChange({ ...draft, earliest: e.target.value })}
          placeholder="-1h"
        />
      </label>
      <label className="form-field">
        <span className="dk">Runs</span>
        <select
          className="select"
          value={preset}
          onChange={(e) => e.target.value !== 'custom' && onChange({ ...draft, cron: e.target.value })}
        >
          {SCHEDULE_PRESETS.map((p) => (
            <option key={p.cron} value={p.cron}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom cron…</option>
        </select>
      </label>
      <label className="form-field">
        <span className="dk">Schedule (cron, UTC)</span>
        <input
          className="select mono"
          value={draft.cron}
          onChange={(e) => onChange({ ...draft, cron: e.target.value })}
          placeholder="*/15 * * * *"
        />
      </label>
      {trigger && (
        <div className="form-field">
          <span className="dk">Fires when</span>
          <div className="mono" style={{ fontSize: 12.5, padding: '8px 0' }}>
            {trigger}
          </div>
        </div>
      )}
    </div>
  );
}

/** Returns a problem with the logic, or '' when it can be saved. */
function validateLogic(l: AlertLogic): string {
  if (!l.query) return 'The query cannot be empty.';
  if (!l.earliest) return 'Enter how far back the search looks, for example -1h.';
  if (l.cron.split(/\s+/).length !== 5)
    return 'The schedule must be a 5-field cron expression, for example */15 * * * *.';
  return '';
}

function trimLogic(l: AlertLogic): AlertLogic {
  return { query: l.query.trim(), earliest: l.earliest.trim(), cron: l.cron.trim() };
}

function trimNotification(n: AlertNotification): AlertNotification {
  const email = n.email;
  return {
    ...n,
    trigger:
      n.trigger.type === 'custom'
        ? { ...n.trigger, expression: n.trigger.expression.trim() }
        : { ...n.trigger, count: Number.isFinite(n.trigger.count) ? Math.max(0, Math.floor(n.trigger.count)) : NaN },
    email: { ...email, to: email.to.trim(), cc: email.cc.trim(), bcc: email.bcc.trim(), subject: email.subject.trim() },
    message: n.message.trim(),
  };
}

/** Returns a problem with the notification settings, or '' when they can be saved. */
function validateNotification(n: AlertNotification, smtpIds: Set<string>): string {
  if (n.targets.length === 0) return 'Choose at least one place to send the notification.';
  if (n.trigger.type === 'custom') {
    if (!n.trigger.expression) return 'Enter the expression that decides when the alert fires.';
  } else if (!Number.isFinite(n.trigger.count) || n.trigger.count < 0) {
    return 'The result count must be 0 or more.';
  }
  if (n.targets.some((id) => smtpIds.has(id))) {
    if (!n.email.to) return 'Enter who should receive the alert email.';
    if (!n.email.subject) return 'Enter an email subject.';
  }
  return '';
}

/**
 * The options Cribl Search offers on a scheduled search's notification: when it
 * fires, where it goes, the email it sends, and the message body.
 */
function NotificationEditor({
  value,
  onChange,
  targets,
  smtpIds,
  name,
  onCreateTarget,
  onDeleteTarget,
  alertName,
}: {
  value: AlertNotification;
  onChange: (next: AlertNotification) => void;
  targets: NotificationTarget[];
  smtpIds: Set<string>;
  /** Unique per editor; groups its radio buttons. */
  name: string;
  /** Creates a webhook target in Cribl; resolves to an error message, or '' once it exists. */
  onCreateTarget: (spec: WebhookSpec) => Promise<string>;
  /** Deletes a webhook target from Cribl; resolves to an error message, or '' once gone. */
  onDeleteTarget: (id: string) => Promise<string>;
  /** Named in the test notification. */
  alertName: string;
}) {
  const n = value;
  const [addingWebhook, setAddingWebhook] = useState(false);
  // Target id the open webhook form last tested, so its result shows in the form.
  const [formTestId, setFormTestId] = useState('');
  // Per-target "Test" outcome.
  const [tests, setTests] = useState<Record<string, { state: 'running' | 'ok' | 'fail'; text: string }>>({});
  // Webhook target whose Delete is awaiting a second click.
  const [confirmDelete, setConfirmDelete] = useState('');

  async function remove(t: NotificationTarget) {
    if (confirmDelete !== t.id) return setConfirmDelete(t.id);
    setConfirmDelete('');
    const failure = await onDeleteTarget(t.id);
    if (failure) return setTests((x) => ({ ...x, [t.id]: { state: 'fail', text: failure } }));
    set({ targets: n.targets.filter((id) => id !== t.id) });
  }

  async function test(t: NotificationTarget) {
    // A target created a moment ago may not be in the list yet.
    const settings = trimNotification(n);
    if (smtpIds.has(t.id) && !settings.email.to)
      return setTests((x) => ({ ...x, [t.id]: { state: 'fail', text: 'Enter the email recipient first.' } }));
    const report = (state: 'running' | 'ok' | 'fail', text: string) => setTests((x) => ({ ...x, [t.id]: { state, text } }));
    report('running', 'Starting…');
    try {
      const r = await testNotificationTarget(t.id, t, settings, alertName, smtpIds, (line) => report('running', line));
      report(r.ok ? 'ok' : 'fail', r.detail);
    } catch (e) {
      report('fail', e instanceof Error ? e.message : String(e));
    }
  }
  const trigger = n.trigger;
  const set = (patch: Partial<AlertNotification>) => onChange({ ...n, ...patch });
  const setEmail = (patch: Partial<AlertEmail>) => onChange({ ...n, email: { ...n.email, ...patch } });
  const hasEmail = n.targets.some((id) => smtpIds.has(id));
  const [showCc, setShowCc] = useState(!!n.email.cc);
  const [showBcc, setShowBcc] = useState(!!n.email.bcc);

  return (
    <div className="notif-editor">
      <div className="form-field">
        <span className="dk">When…</span>
        <div className="notif-when">
          <select
            className="select"
            aria-label="Trigger type"
            value={trigger.type}
            onChange={(e) =>
              set({
                trigger:
                  e.target.value === 'custom'
                    ? { type: 'custom', expression: '' }
                    : { type: 'resultsCount', comparator: '>', count: 0 },
              })
            }
          >
            <option value="resultsCount">Count of results</option>
            <option value="custom">Custom expression</option>
          </select>
          {trigger.type === 'resultsCount' ? (
            <>
              <select
                className="select"
                aria-label="Comparator"
                value={trigger.comparator}
                onChange={(e) => set({ trigger: { ...trigger, comparator: e.target.value } })}
              >
                {COMPARATORS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              <input
                className="select mono"
                aria-label="Result count"
                type="number"
                min={0}
                step={1}
                value={Number.isFinite(trigger.count) ? trigger.count : ''}
                onChange={(e) => set({ trigger: { ...trigger, count: e.target.valueAsNumber } })}
              />
            </>
          ) : (
            <input
              className="select mono"
              aria-label="Trigger expression"
              value={trigger.expression}
              placeholder="e.g. count > 5"
              onChange={(e) => set({ trigger: { type: 'custom', expression: e.target.value } })}
            />
          )}
        </div>
      </div>

      <div className="form-field">
        <span className="dk">Send notification to</span>
        {targets.map((t) => {
          const result = tests[t.id];
          return (
            <div key={t.id} className="target-row">
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={n.targets.includes(t.id)}
                  onChange={(e) =>
                    set({
                      targets: e.target.checked ? [...n.targets, t.id] : n.targets.filter((id) => id !== t.id),
                    })
                  }
                />
                {targetLabel(t)}
                <span className="muted mono" style={{ fontSize: 11.5 }}>
                  {t.id}
                </span>
              </label>
              <button
                type="button"
                className="btn btn-sm"
                disabled={result?.state === 'running'}
                title="Sends one test notification to this target through a one-off scheduled search (about 20 seconds)"
                onClick={() => void test(t)}
              >
                {result?.state === 'running' ? 'Testing…' : 'Test'}
              </button>
              {t.type === 'webhook' && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={result?.state === 'running'}
                  style={confirmDelete === t.id ? { color: 'var(--critical)' } : undefined}
                  title="Deletes this webhook target from Cribl. Other alerts that send to it will stop reaching it."
                  onClick={() => void remove(t)}
                >
                  {confirmDelete === t.id ? 'Confirm delete' : 'Delete'}
                </button>
              )}
              {result && (
                <span className={`target-test ${result.state}`} role="status">
                  {result.state === 'ok' ? '✓ ' : result.state === 'fail' ? '✕ ' : ''}
                  {result.text}
                </span>
              )}
            </div>
          );
        })}
        {targets.length === 0 && (
          <span className="muted" style={{ fontSize: 12.5 }}>
            No notification targets are configured in Cribl.
          </span>
        )}
        {!addingWebhook && (
          <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => setAddingWebhook(true)}>
            Add webhook target (ServiceNow…)
          </button>
        )}
        {addingWebhook && (
          <WebhookTargetForm
            existing={targets.map((t) => t.id)}
            onClose={() => {
              setAddingWebhook(false);
              setFormTestId('');
            }}
            onCreate={async (spec) => {
              const failure = await onCreateTarget(spec);
              if (failure) return failure;
              set({ targets: [...n.targets, spec.id] });
              return '';
            }}
            onTest={(id) => {
              setFormTestId(id);
              void test(targets.find((t) => t.id === id) ?? { id, type: 'webhook' });
            }}
            testResult={formTestId ? tests[formTestId] : undefined}
          />
        )}
      </div>

      {hasEmail && (
        <>
          <div className="form-field">
            <div className="notif-to-head">
              <span className="dk">To</span>
              <label className="check-row" style={{ padding: 0, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={showCc}
                  onChange={(e) => {
                    setShowCc(e.target.checked);
                    if (!e.target.checked) setEmail({ cc: '' });
                  }}
                />
                Cc
              </label>
              <label className="check-row" style={{ padding: 0, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={showBcc}
                  onChange={(e) => {
                    setShowBcc(e.target.checked);
                    if (!e.target.checked) setEmail({ bcc: '' });
                  }}
                />
                Bcc
              </label>
            </div>
            <input
              className="select"
              aria-label="Email to"
              value={n.email.to}
              onChange={(e) => setEmail({ to: e.target.value })}
              placeholder="you@example.com, team@example.com"
            />
          </div>
          {showCc && (
            <label className="form-field">
              <span className="dk">Cc</span>
              <input className="select" value={n.email.cc} onChange={(e) => setEmail({ cc: e.target.value })} />
            </label>
          )}
          {showBcc && (
            <label className="form-field">
              <span className="dk">Bcc</span>
              <input className="select" value={n.email.bcc} onChange={(e) => setEmail({ bcc: e.target.value })} />
            </label>
          )}
          <label className="form-field">
            <span className="dk">Subject</span>
            <input
              className="select"
              value={n.email.subject}
              onChange={(e) => setEmail({ subject: e.target.value })}
            />
          </label>
          <div className="form-field">
            <label className="check-row">
              <input
                type="checkbox"
                checked={n.email.includeResults}
                onChange={(e) => setEmail({ includeResults: e.target.checked })}
              />
              Include search results
            </label>
            {n.email.includeResults && (
              <>
                <div className="radio-row" role="radiogroup" aria-label="Send results as">
                  <span className="dk" style={{ marginBottom: 0 }}>
                    Send as
                  </span>
                  {ATTACHMENT_TYPES.map((a) => (
                    <label key={a.value} className="check-row" style={{ padding: 0 }}>
                      <input
                        type="radio"
                        name={`${name}-attachment`}
                        value={a.value}
                        checked={n.email.attachmentType === a.value}
                        onChange={() => setEmail({ attachmentType: a.value })}
                      />
                      {a.label}
                    </label>
                  ))}
                </div>
                <div className="muted" style={{ fontSize: 11.5, paddingTop: 4 }}>
                  The email carries up to 100 events and 20 fields of the search results.
                </div>
              </>
            )}
          </div>
        </>
      )}

      <label className="form-field">
        <span className="dk">Message</span>
        <textarea
          className="select logic-query notif-message"
          spellCheck={false}
          rows={Math.min(12, n.message.split('\n').length + 1)}
          value={n.message}
          onChange={(e) => set({ message: e.target.value })}
        />
        <span className="muted" style={{ fontSize: 11.5 }}>
          Cribl fills in {'{{timestamp}}'}, {'{{searchId}}'}, {'{{savedQueryId}}'}, {'{{tenantId}}'} and{' '}
          {'{{notificationId}}'} when it sends.
        </span>
      </label>
    </div>
  );
}

function triggerLabel(n: AlertNotification): string {
  if (n.trigger.type === 'custom') return n.trigger.expression || 'custom expression';
  return `results ${n.trigger.comparator} ${Number.isFinite(n.trigger.count) ? n.trigger.count : '?'}`;
}

function scheduleLabel(l: AlertLogic): string {
  const preset = SCHEDULE_PRESETS.find((p) => p.cron === l.cron.trim());
  return `looks back ${l.earliest || '?'} · ${preset ? preset.label.toLowerCase() : l.cron || 'no schedule'}`;
}

/** A collapsible part of the drill-in, with a one-line summary while closed. */
function Section({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="logic-section">
      <button type="button" className="section-toggle" aria-expanded={open} onClick={onToggle}>
        <span className={`row-caret ${open ? 'open' : ''}`}>▶</span>
        <span className="dk" style={{ margin: 0 }}>
          {title}
        </span>
        <span className="muted section-summary">{summary}</span>
        <span className="muted section-hint">{open ? 'Collapse' : 'Expand'}</span>
      </button>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

/**
 * Drill-in under an alert row: the search behind the alert and, once the alert
 * is enabled, its notification — both editable in place, collapsed until opened.
 */
function AlertLogicPanel({
  logic,
  defaults,
  notification,
  moreNotifications = 0,
  targets,
  smtpIds,
  onCreateTarget,
  onDeleteTarget,
  alertName,
  saveLabel,
  note,
  onSave,
}: {
  logic: AlertLogic;
  /** Catalog defaults, when the alert has them — enables "Reset to default". */
  defaults?: AlertLogic;
  /** The live notification's settings; absent until the alert is enabled. */
  notification?: AlertNotification;
  /** Further notifications on the same search that are not edited here. */
  moreNotifications?: number;
  targets: NotificationTarget[];
  smtpIds: Set<string>;
  onCreateTarget: (spec: WebhookSpec) => Promise<string>;
  onDeleteTarget: (id: string) => Promise<string>;
  /** Shown in test notifications. */
  alertName: string;
  saveLabel: string;
  note: string;
  /** Resolves to an error message, or '' once saved. */
  onSave: (next: AlertLogic, notification?: AlertNotification) => Promise<string>;
}) {
  const [draft, setDraft] = useState(logic);
  const [notif, setNotif] = useState(notification);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SearchRun | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [showNotif, setShowNotif] = useState(false);
  const dirty = !sameLogic(draft, logic) || (!!notif && !!notification && !sameNotification(notif, notification));

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
    const next = trimLogic(draft);
    const nextNotif = notif && trimNotification(notif);
    const logicProblem = validateLogic(next);
    const notifProblem = nextNotif ? validateNotification(nextNotif, smtpIds) : '';
    if (logicProblem) setShowSearch(true);
    else if (notifProblem) setShowNotif(true);
    if (logicProblem || notifProblem) return setError(logicProblem || notifProblem);
    setError('');
    setBusy(true);
    const failure = await onSave(next, nextNotif);
    setBusy(false);
    if (failure) return setError(failure);
    setDraft(next);
    if (nextNotif) setNotif(nextNotif);
  }

  function discard() {
    setDraft(logic);
    setNotif(notification);
  }

  const targetNames = (notif?.targets ?? []).map((id) => targetLabel(targets.find((t) => t.id === id) ?? { id, type: id }));

  return (
    <div className="alert-logic">
      <Section
        title="Search"
        summary={`${draft.query.split('\n')[0].trim()} · ${scheduleLabel(draft)}`}
        open={showSearch}
        onToggle={() => setShowSearch((v) => !v)}
      >
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
        <ScheduleFields
          draft={draft}
          onChange={setDraft}
          trigger={notif ? undefined : 'results > 0 — chosen when you enable the alert'}
        />
      </Section>
      {notif && (
        <Section
          title="Notification"
          summary={`${triggerLabel(notif)} → ${targetNames.join(', ') || 'nowhere'}${
            notif.targets.some((id) => smtpIds.has(id)) && notif.email.to ? ` (${notif.email.to})` : ''
          }`}
          open={showNotif}
          onToggle={() => setShowNotif((v) => !v)}
        >
          <NotificationEditor
            value={notif}
            onChange={setNotif}
            targets={targets}
            smtpIds={smtpIds}
            name="panel"
            onCreateTarget={onCreateTarget}
            onDeleteTarget={onDeleteTarget}
            alertName={alertName}
          />
          {moreNotifications > 0 && (
            <div className="muted" style={{ fontSize: 11.5 }}>
              This search has {moreNotifications} more {moreNotifications === 1 ? 'notification' : 'notifications'}{' '}
              that can be edited in Cribl Search.
            </div>
          )}
        </Section>
      )}
      {error && <ErrorBanner message={error} />}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-sm" disabled={running || !draft.query.trim()} onClick={() => void run()}>
          {running ? 'Searching…' : 'Run search'}
        </button>
        <button className="btn btn-sm btn-primary" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? 'Saving…' : saveLabel}
        </button>
        <button className="btn btn-sm" disabled={!dirty || busy} onClick={discard}>
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

/**
 * Popup that collects what enabling a catalog alert needs: priority, schedule,
 * and the notification — the same options as on a saved search in Cribl Search.
 */
function EnableDialog({
  template,
  cloneName,
  initialPriority,
  logic: startLogic,
  notification: startNotification,
  targets,
  smtpIds,
  onCreateTarget,
  onDeleteTarget,
  onCancel,
  onEnable,
}: {
  template: AlertTemplate;
  /** Set when cloning: the starting name for the copy, which the user can change. */
  cloneName?: string;
  /** Priority the dialog starts on; the notification's labels must match it. */
  initialPriority?: Priority;
  logic: AlertLogic;
  notification: AlertNotification;
  targets: NotificationTarget[];
  smtpIds: Set<string>;
  onCreateTarget: (spec: WebhookSpec) => Promise<string>;
  onDeleteTarget: (id: string) => Promise<string>;
  onCancel: () => void;
  /** Resolves to an error message, or '' once the alert is enabled. */
  onEnable: (priority: Priority, logic: AlertLogic, notification: AlertNotification, name: string) => Promise<string>;
}) {
  const cloning = cloneName != null;
  const [name, setName] = useState(cloneName ?? template.name);
  const [priority, setPriority] = useState<Priority>(initialPriority ?? template.priority);
  const [logic, setLogic] = useState(startLogic);
  const [notif, setNotif] = useState(startNotification);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // The subject and message headline carry the priority; keep them in step
  // unless they have been edited to something else.
  function changePriority(p: Priority) {
    setNotif((n) => retitle(n, name, name, p));
    setPriority(p);
  }
  function changeName(next: string) {
    setNotif((n) => retitle(n, name, next, priority));
    setName(next);
  }

  async function submit() {
    if (cloning && !ALERT_NAME.test(name.trim()))
      return setError('The name can use letters, numbers, spaces, hyphens, and underscores.');
    const nextLogic = trimLogic(logic);
    const nextNotif = trimNotification(notif);
    const problem = validateLogic(nextLogic) || validateNotification(nextNotif, smtpIds);
    if (problem) return setError(problem);
    setError('');
    setBusy(true);
    const failure = await onEnable(priority, nextLogic, nextNotif, name.trim());
    // On success the parent unmounts this dialog.
    if (failure) {
      setError(failure);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form
        className="modal modal-wide"
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
              ? 'Creates a separate alert with its own name. Its query starts as a copy and can be edited afterwards.'
              : template.description}
          </div>
        </div>

        {cloning && (
          <label className="form-field">
            <span className="dk">Name</span>
            <input className="select" autoFocus value={name} onChange={(e) => changeName(e.target.value)} />
          </label>
        )}

        <label className="form-field">
          <span className="dk">Priority</span>
          <PrioritySelect value={priority} onChange={(p) => p && changePriority(p)} />
        </label>

        <div className="dk notif-heading">Schedule</div>
        <ScheduleFields draft={logic} onChange={setLogic} />

        <div className="dk notif-heading">Notification</div>
        <NotificationEditor
          value={notif}
          onChange={setNotif}
          targets={targets}
          smtpIds={smtpIds}
          name="dialog"
          onCreateTarget={onCreateTarget}
          onDeleteTarget={onDeleteTarget}
          alertName={stripPriority(name)}
        />

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

  const saved = useAsync<SavedSearch[]>(async () => {
    const items = await getSavedSearches();
    // Test searches an interrupted "Test target" left behind are removed and never shown.
    void sweepTestSearches(items);
    return items.filter((s) => !isTestSearch(s));
  }, [tick, rev]);
  // Targets refetch right after one is created, independent of the global tick.
  const [trev, setTrev] = useState(0);
  const targets = useAsync<NotificationTarget[]>(() => getNotificationTargets(), [tick, trev]);
  const targetList = useMemo(() => targets.data ?? [], [targets.data]);
  const smtp = targetList.find((t) => t.type === 'smtp');
  const bulletin = targetList.find((t) => t.type === 'bulletin_message');
  const smtpIds = useMemo(() => new Set(targetList.filter((t) => t.type === 'smtp').map((t) => t.id)), [targetList]);
  const bulletinIds = useMemo(
    () => new Set(targetList.filter((t) => t.type === 'bulletin_message').map((t) => t.id)),
    [targetList],
  );

  // Last-used recipients, remembered so the enable popup can prefill them.
  const [to, setTo] = usePref('alertEmailTo', '');
  const [cc, setCc] = usePref('alertEmailCc', '');
  const [bcc, setBcc] = usePref('alertEmailBcc', '');
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
  // Notification settings of catalog alerts disabled this session, so enabling
  // them again starts from what they had.
  const [notifDrafts, setNotifDrafts] = useState<Record<string, AlertNotification>>({});

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

  /** The settings of the first notification on a live alert. */
  function liveNotification(s: SavedSearch): AlertNotification | undefined {
    const first = alertNotifications(s)[0];
    return first && notificationOf(first, smtpIds);
  }

  /**
   * The notification settings a catalog alert (or a clone named `name`) starts
   * from: what it has live, what it had before being disabled, or the defaults.
   */
  function startNotification(t: AlertTemplate, name = t.name): AlertNotification {
    const live = byId.get(t.id);
    const kept = (live && liveNotification(live)) ?? notifDrafts[t.id];
    if (kept) return retitle(kept, t.name, name, priorityOf(live?.name) ?? t.priority);
    const defaults = [...(bulletin ? [bulletin.id] : []), ...(smtp && to ? [smtp.id] : [])];
    return defaultNotification({ ...t, name }, t.priority, defaults, { to, cc, bcc });
  }

  /** Create a webhook notification target in Cribl and reload the target list. */
  async function createWebhook(spec: WebhookSpec): Promise<string> {
    try {
      await createNotificationTarget(buildWebhookTarget(spec) as { id: string; type: string } & Record<string, unknown>);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    setTrev((r) => r + 1);
    return '';
  }

  /** Delete a webhook notification target from Cribl and reload the target list. */
  async function deleteWebhook(id: string): Promise<string> {
    try {
      await deleteNotificationTarget(id);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    setTrev((r) => r + 1);
    return '';
  }

  function rememberRecipients(n: AlertNotification) {
    if (!n.targets.some((id) => smtpIds.has(id))) return;
    setTo(n.email.to);
    setCc(n.email.cc);
    setBcc(n.email.bcc);
  }

  /** Write edited logic and notification settings to an existing alert. */
  async function saveLogic(s: SavedSearch, next: AlertLogic, notif?: AlertNotification): Promise<string> {
    try {
      if (!sameLogic(next, logicOf(s))) {
        await updateSavedSearch({
          ...s,
          query: next.query,
          earliest: next.earliest,
          schedule: { ...s.schedule, cronSchedule: next.cron },
        });
      }
      const first = alertNotifications(s)[0];
      if (notif && first && !sameNotification(notif, notificationOf(first, smtpIds))) {
        await updateSearchNotification(s.id, applyNotification(first, notif, smtpIds));
        rememberRecipients(notif);
      }
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    setRev((r) => r + 1);
    return '';
  }

  async function enable(
    t: AlertTemplate,
    priority: Priority,
    logic: AlertLogic,
    notif: AlertNotification,
  ): Promise<string> {
    try {
      await createSearchAlert(buildAlert({ ...t, ...logic }, priority, notif, smtpIds));
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    rememberRecipients(notif);
    setNotifDrafts(({ [t.id]: _gone, ...rest }) => rest);
    setEnabling(null);
    setRev((r) => r + 1);
    return '';
  }

  /** Create a separate alert from a catalog alert, under a new name and id. */
  async function clone(
    t: AlertTemplate,
    priority: Priority,
    logic: AlertLogic,
    notif: AlertNotification,
    name: string,
  ): Promise<string> {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    let id = `criblvision_${slug}`;
    for (let n = 2; byId.has(id); n++) id = `criblvision_${slug}_${n}`;
    try {
      await createSearchAlert(buildAlert({ ...t, ...logic, id, name }, priority, notif, smtpIds));
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    rememberRecipients(notif);
    setCloning(null);
    setShowOff(false);
    setRev((r) => r + 1);
    return '';
  }

  /**
   * Disable a catalog alert: removes its scheduled search from Cribl Search,
   * keeping its edits and notification settings for if it is enabled again.
   */
  function disable(t: AlertTemplate, live: SavedSearch) {
    const logic = logicOf(live);
    if (!sameLogic(logic, t)) setDrafts((d) => ({ ...d, [t.id]: logic }));
    const notif = liveNotification(live);
    if (notif) setNotifDrafts((d) => ({ ...d, [t.id]: notif }));
    void run(t.id, () => deleteSavedSearch(t.id));
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
                  const on = !!live && isActive(live);
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
                        <td style={{ fontSize: 12.5 }}>{live ? triggerText(live) : t.fires}</td>
                        <td className="mono" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
                          {logic.cron}
                        </td>
                        <td>
                          <Switch
                            on={on}
                            tone={live && !on ? 'warn' : undefined}
                            label={on ? 'Enabled' : live ? 'Turned off' : 'Not enabled'}
                            title={
                              on
                                ? 'Click to disable — removes the scheduled search from Cribl Search'
                                : live
                                  ? 'Click to turn the schedule back on'
                                  : 'Click to enable'
                            }
                            disabled={busy === t.id}
                            onClick={() => (on ? disable(t, live) : live ? toggle(live) : setEnabling(t))}
                          />
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
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
                              key={live ? `live:${live.name}` : 'draft'}
                              logic={logic}
                              defaults={t}
                              notification={live && liveNotification(live)}
                              moreNotifications={live ? Math.max(0, alertNotifications(live).length - 1) : 0}
                              targets={targetList}
                              smtpIds={smtpIds}
                              onCreateTarget={createWebhook}
                              onDeleteTarget={deleteWebhook}
                              alertName={t.name}
                              saveLabel={live ? 'Save changes' : 'Keep edits'}
                              note={
                                live
                                  ? 'Saving updates the scheduled search and its notification in Cribl Search.'
                                  : 'Edits are used when you enable this alert.'
                              }
                              onSave={
                                live
                                  ? (next, n) => saveLogic(live, next, n)
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
          notification, email, or both when it fires. Click the status to enable or disable an alert.
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
                          <Switch
                            on={isActive(s)}
                            tone={isActive(s) ? undefined : 'warn'}
                            label={isActive(s) ? 'Active' : 'Turned off'}
                            title={isActive(s) ? 'Click to turn off the schedule' : 'Click to turn the schedule on'}
                            disabled={busy === s.id}
                            onClick={() => toggle(s)}
                          />
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {s.id.startsWith('criblvision_') && (
                            <button
                              className="btn btn-sm"
                              disabled={busy === s.id}
                              style={confirmRemove === s.id ? { color: 'var(--critical)' } : undefined}
                              onClick={() => remove(s.id)}
                            >
                              {confirmRemove === s.id ? 'Confirm remove' : 'Remove'}
                            </button>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td className="detail-cell" colSpan={7}>
                            <AlertLogicPanel
                              key={`live:${s.name}`}
                              logic={logicOf(s)}
                              defaults={templateById.get(s.id)}
                              notification={liveNotification(s)}
                              moreNotifications={Math.max(0, alertNotifications(s).length - 1)}
                              targets={targetList}
                              smtpIds={smtpIds}
                              onCreateTarget={createWebhook}
                              onDeleteTarget={deleteWebhook}
                              alertName={stripPriority(s.name) || s.id}
                              saveLabel="Save changes"
                              note="Saving updates the scheduled search and its notification in Cribl Search."
                              onSave={(next, n) => saveLogic(s, next, n)}
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
          logic={drafts[enabling.id] ?? enabling}
          notification={startNotification(enabling)}
          targets={targetList}
          smtpIds={smtpIds}
          onCreateTarget={createWebhook}
                              onDeleteTarget={deleteWebhook}
          onCancel={() => setEnabling(null)}
          onEnable={(priority, logic, notif) => enable(enabling, priority, logic, notif)}
        />
      )}
      {cloning && (
        <EnableDialog
          key={`clone:${cloning.id}`}
          template={cloning}
          cloneName={`${cloning.name} copy`}
          initialPriority={priorityOf(byId.get(cloning.id)?.name) ?? cloning.priority}
          logic={byId.has(cloning.id) ? logicOf(byId.get(cloning.id)!) : (drafts[cloning.id] ?? cloning)}
          notification={startNotification(cloning, `${cloning.name} copy`)}
          targets={targetList}
          smtpIds={smtpIds}
          onCreateTarget={createWebhook}
                              onDeleteTarget={deleteWebhook}
          onCancel={() => setCloning(null)}
          onEnable={(priority, logic, notif, name) => clone(cloning, priority, logic, notif, name)}
        />
      )}
    </>
  );
}
