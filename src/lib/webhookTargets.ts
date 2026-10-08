// Webhook notification targets the app can create for an alert — shaped for
// ServiceNow out of the box, or a plain URL. A target is a Cribl Notification
// Target of type "webhook": the Leader posts each fired notification to it, so
// the app never talks to ServiceNow itself. The config keys below are the ones
// Cribl's own "New Target → Webhook" form writes (checked 2026-10-08).

export type WebhookKind = 'servicenow_incident' | 'servicenow_event' | 'generic';
export type WebhookAuth = 'none' | 'basic' | 'token';

export const WEBHOOK_KINDS: { value: WebhookKind; label: string; hint: string }[] = [
  {
    value: 'servicenow_incident',
    label: 'ServiceNow incident (Table API)',
    hint: 'Opens an incident per fired alert via /api/now/table/incident. The user needs rights to create incidents (for example the itil role).',
  },
  {
    value: 'servicenow_event',
    label: 'ServiceNow event (Event Management)',
    hint: 'Pushes an event via /api/global/em/jsonv2 for alert rules to correlate. The user needs the evt_mgmt_integration role.',
  },
  { value: 'generic', label: 'Other webhook URL', hint: 'Posts the full notification event as JSON to any HTTPS endpoint.' },
];

export interface WebhookSpec {
  /** Target id; letters, numbers, hyphens, underscores. */
  id: string;
  kind: WebhookKind;
  /** ServiceNow instance, as "acme" or "acme.service-now.com". */
  instance: string;
  /** Full URL for the generic kind. */
  url: string;
  auth: WebhookAuth;
  username: string;
  password: string;
  token: string;
  /** ServiceNow incident: optional assignment group name and caller. */
  assignmentGroup: string;
  caller: string;
  /** ServiceNow event: the "source" the event is attributed to. */
  source: string;
}

export const TARGET_ID = /^[a-zA-Z0-9_-]{1,100}$/;

export function defaultWebhookSpec(kind: WebhookKind = 'servicenow_incident'): WebhookSpec {
  return {
    id: kind === 'servicenow_incident' ? 'servicenow_incident' : kind === 'servicenow_event' ? 'servicenow_events' : 'webhook',
    kind,
    instance: '',
    url: '',
    auth: kind === 'generic' ? 'none' : 'basic',
    username: '',
    password: '',
    token: '',
    assignmentGroup: '',
    caller: '',
    source: 'CriblVision',
  };
}

/** The ServiceNow host for an instance typed as "acme" or a full host/URL. */
export function serviceNowHost(instance: string): string {
  const trimmed = instance.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!trimmed) return '';
  return trimmed.includes('.') ? trimmed : `${trimmed}.service-now.com`;
}

/** Returns a problem with the spec, or '' when a target can be created. */
export function validateWebhookSpec(s: WebhookSpec): string {
  if (!TARGET_ID.test(s.id.trim())) return 'The target id can use letters, numbers, hyphens, and underscores.';
  if (s.kind === 'generic') {
    if (!/^https:\/\/\S+$/.test(s.url.trim())) return 'Enter the webhook URL, starting with https://.';
  } else if (!serviceNowHost(s.instance)) {
    return 'Enter your ServiceNow instance, for example acme or acme.service-now.com.';
  }
  if (s.auth === 'basic' && (!s.username.trim() || !s.password)) return 'Enter the username and password.';
  if (s.auth === 'token' && !s.token.trim()) return 'Enter the auth token.';
  return '';
}

// A JS string literal for use inside a Cribl expression.
const lit = (v: string) => JSON.stringify(v);

// Priority from the "[P1] …" headline the app puts first in every message.
const PRIORITY_EXPR = `(/\\[P1\\]/.test(message||'') ? '1' : /\\[P2\\]/.test(message||'') ? '2' : '3')`;
const HEADLINE_EXPR = `String(message||'').split('\\n')[0]`;
const TITLE_EXPR = `${HEADLINE_EXPR}.replace(/^\\s*\\[P[123]\\]\\s*/, '')`;
const DETAILS_EXPR = `String(message||'') + (searchResultsUrl ? '\\n\\nSearch results: ' + searchResultsUrl : '') + (resultSet ? '\\n\\nResults:\\n' + JSON.stringify(resultSet, null, 2) : '')`;

/** The expression Cribl evaluates per notification to build the request body. */
export function webhookSourceExpression(s: WebhookSpec): string {
  if (s.kind === 'servicenow_incident') {
    const fields = [
      `short_description: ${HEADLINE_EXPR}.slice(0, 160)`,
      `description: ${DETAILS_EXPR}`,
      `urgency: ${PRIORITY_EXPR}`,
      `impact: ${PRIORITY_EXPR}`,
      `correlation_id: String(savedQueryId||'')`,
      ...(s.assignmentGroup.trim() ? [`assignment_group: ${lit(s.assignmentGroup.trim())}`] : []),
      ...(s.caller.trim() ? [`caller_id: ${lit(s.caller.trim())}`] : []),
    ];
    return `JSON.stringify({ ${fields.join(', ')} })`;
  }
  if (s.kind === 'servicenow_event') {
    const fields = [
      `source: ${lit(s.source.trim() || 'CriblVision')}`,
      `event_class: 'Cribl Search'`,
      `node: String(tenantId || cribl_host || 'cribl')`,
      `type: ${TITLE_EXPR}`,
      `resource: String(savedQueryId||'')`,
      `message_key: String(savedQueryId||'')`,
      `severity: ${PRIORITY_EXPR}`,
      `description: ${DETAILS_EXPR}`,
      `additional_info: JSON.stringify({ savedQueryId, searchId, notificationId, searchResultsUrl, resultSet })`,
    ];
    return `JSON.stringify({ ${fields.join(', ')} })`;
  }
  return '__httpOut';
}

/** The Cribl Notification Target to create for the spec. */
export function buildWebhookTarget(s: WebhookSpec): Record<string, unknown> {
  const host = serviceNowHost(s.instance);
  const url =
    s.kind === 'servicenow_incident'
      ? `https://${host}/api/now/table/incident`
      : s.kind === 'servicenow_event'
        ? `https://${host}/api/global/em/jsonv2`
        : s.url.trim();
  const auth =
    s.auth === 'basic'
      ? { authType: 'basic', username: s.username.trim(), password: s.password }
      : s.auth === 'token'
        ? { authType: 'token', token: s.token.trim() }
        : { authType: 'none' };
  const format =
    s.kind === 'generic'
      ? { format: 'json_array' }
      : {
          format: 'custom',
          customSourceExpression: webhookSourceExpression(s),
          customDropWhenNull: false,
          customEventDelimiter: ',',
          customContentType: 'application/json',
          // One request per notification: an incident is a single record,
          // and Event Management wants events wrapped in a records array.
          customPayloadExpression: s.kind === 'servicenow_event' ? '`{"records":[${events}]}`' : '`${events}`',
        };
  return {
    id: s.id.trim(),
    type: 'webhook',
    url,
    method: 'POST',
    ...format,
    ...auth,
    extraHttpHeaders: [{ name: 'Accept', value: 'application/json' }],
    maxPayloadEvents: 1,
    flushPeriodSec: 1,
    timeoutSec: 30,
    compress: false,
    rejectUnauthorized: true,
    onBackpressure: 'drop',
  };
}
