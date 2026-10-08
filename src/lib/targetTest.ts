// "Test target": fire a real notification through one notification target.
//
// Cribl has no test call for webhook targets (its connection check answers
// "Target does not support connection check", checked 2026-10-08), so the test
// takes the same path a live alert does: a temporary scheduled search with a
// notification that always fires, sent to the one target. The search is
// scheduled for a three-minute window that starts at the current minute and is
// pinned to the hour, day, and month: the scheduler picks it up within seconds,
// it can run at most three times, and then not for a year — so a reload
// mid-test cannot leave a recurring search behind, and leftovers are swept the
// next time the Alerts page loads. (A cron pinned to a single minute does not
// fire reliably in Cribl Search; a range that includes the current minute fires
// within ~20s of creation — checked 2026-10-08.)
// Delivery is read from the target's own counters (email, webhook…) or, for the
// in-product target, from the system message that appears.

import {
  IS_DEMO,
  createSearchAlert,
  deleteSavedSearch,
  getMessages,
  getNotificationTargets,
} from '../api/client';
import type { CriblNotification, NotificationTarget, SavedSearch } from '../api/types';
import { applyNotification, type AlertNotification } from './alertCatalog';

export interface TargetTestResult {
  ok: boolean;
  /** What happened, in a sentence. */
  detail: string;
}

/** Saved-search id prefix of test searches, so they can be recognised and swept. */
export const TEST_SEARCH_PREFIX = 'criblvision_test_';

export function isTestSearch(s: SavedSearch): boolean {
  return s.id.startsWith(TEST_SEARCH_PREFIX);
}

// Test searches this tab is running right now; the sweep leaves them alone.
const running = new Set<string>();

/**
 * Delete test searches left behind by an interrupted test (a reload or closed
 * tab mid-test). Called whenever the saved-search list is loaded.
 */
export async function sweepTestSearches(saved: SavedSearch[]): Promise<void> {
  for (const s of saved) {
    if (isTestSearch(s) && !running.has(s.id)) await deleteSavedSearch(s.id).catch(() => {});
  }
}

const POLL_MS = 3_000;
// How long to wait for the search to run and the target to report: the window
// itself plus scheduler latency.
const GRACE_MS = 200_000;
const WINDOW_MINUTES = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A cron for a WINDOW_MINUTES-long window starting at the current minute,
 * pinned to today's hour, day, and month. A cron cannot cross the hour, so in
 * the last two minutes of an hour `at` is the top of the next hour and the
 * caller waits for it.
 */
export function oneShotSchedule(now = Date.now()): { at: number; cron: string } {
  let at = Math.floor(now / 60_000) * 60_000;
  if (new Date(at).getUTCMinutes() > 60 - WINDOW_MINUTES) at = Math.ceil((at + 1) / 3_600_000) * 3_600_000;
  const d = new Date(at);
  const m = d.getUTCMinutes();
  return { at, cron: `${m}-${m + WINDOW_MINUTES - 1} ${d.getUTCHours()} ${d.getUTCDate()} ${d.getUTCMonth() + 1} *` };
}

/** Counters that mean "delivered" and "failed" on a target's status. */
function tally(t: NotificationTarget | undefined): { sent: number; failed: number } {
  const m = t?.status?.metrics ?? {};
  let sent = 0;
  let failed = 0;
  for (const [k, v] of Object.entries(m)) {
    if (typeof v !== 'number') continue;
    if (/sent|success/i.test(k)) sent += v;
    if (/err|drop|fail/i.test(k)) failed += v;
  }
  return { sent, failed };
}

async function targetStatus(id: string): Promise<{ sent: number; failed: number }> {
  return tally((await getNotificationTargets().catch(() => [] as NotificationTarget[])).find((t) => t.id === id));
}

/**
 * Send a test notification to `targetId` using the alert's current settings
 * (so an email test goes to the recipients entered), and report delivery.
 * `onProgress` receives short status lines while the test runs.
 */
export async function testNotificationTarget(
  targetId: string,
  target: NotificationTarget,
  settings: AlertNotification,
  alertName: string,
  smtpIds: Set<string>,
  onProgress: (line: string) => void,
): Promise<TargetTestResult> {
  if (IS_DEMO) {
    onProgress('Demo mode: pretending to send…');
    await sleep(1500);
    return { ok: true, detail: 'Demo mode — no notification was sent.' };
  }

  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const searchId = `${TEST_SEARCH_PREFIX}${targetId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}_${token}`;
  const isBulletin = target.type === 'bulletin_message';
  const probe = `CriblVision test notification for "${alertName}" — target ${targetId} is working. (${token})`;

  const base: CriblNotification = {
    id: `${searchId}_notification_1`,
    disabled: false,
    condition: 'search',
    conf: { savedQueryId: searchId },
  };
  const notification = applyNotification(
    base,
    {
      ...settings,
      targets: [targetId],
      trigger: { type: 'resultsCount', comparator: '>=', count: 0 },
      email: { ...settings.email, includeResults: false, subject: `CriblVision test — ${settings.email.subject || alertName}` },
      message: `${probe}\n\nThis was sent from the CriblVision Alerts page to check the target. No action is needed.`,
    },
    smtpIds,
  );

  const { at, cron } = oneShotSchedule();
  while (Date.now() < at) {
    onProgress(`Waiting for the top of the hour, since a test cannot straddle it — starts in ${Math.round((at - Date.now()) / 1000)}s…`);
    await sleep(Math.min(POLL_MS, at - Date.now()));
  }
  // Snapshot the target's counters before the search exists, so an unrelated
  // alert landing in the next few seconds is the only thing that could
  // confuse the reading.
  const before = isBulletin ? { sent: 0, failed: 0 } : await targetStatus(targetId);
  onProgress('Cribl tests a target by firing a real notification: creating a one-off search…');
  running.add(searchId);
  await createSearchAlert({
    id: searchId,
    name: `CriblVision test notification ${token}`,
    description: 'Temporary: created by CriblVision to test a notification target. Deleted automatically.',
    query: 'dataset="cribl_metrics" | limit 1',
    earliest: '-15m',
    latest: 'now',
    schedule: {
      enabled: true,
      cronSchedule: cron,
      tz: 'UTC',
      keepLastN: 1,
      notifications: { disabled: false, items: [notification] },
    },
  });

  try {
    const started = Date.now();
    while (Date.now() - started < GRACE_MS) {
      await sleep(POLL_MS);
      const waited = Math.round((Date.now() - started) / 1000);
      if (isBulletin) {
        const hit = (await getMessages().catch(() => [])).some((m) => `${m.title} ${m.text}`.includes(token));
        if (hit) return { ok: true, detail: `Delivered in ${waited}s — the test shows in Cribl's notifications.` };
      } else {
        const now = await targetStatus(targetId);
        if (now.failed > before.failed)
          return {
            ok: false,
            detail: `The target's error count went up when the test ran (${waited}s). Check the target's status under Notifications → Targets in Cribl (credentials, URL, or roles).`,
          };
        if (now.sent > before.sent)
          return {
            ok: true,
            detail: `Sent in ${waited}s — the target's sent count went up. Counters are per target, so confirm it arrived at the other end.`,
          };
      }
      onProgress(`Cribl is running the test search and sending — usually about 20s (${waited}s so far)…`);
    }
    return {
      ok: false,
      detail: isBulletin
        ? 'No test notification showed up within 3 minutes. Check that scheduled searches are running in Cribl Search.'
        : 'The target reported nothing within 3 minutes. Check that scheduled searches are running, then the target status under Notifications → Targets in Cribl.',
    };
  } finally {
    await deleteSavedSearch(searchId).catch(() => {});
    running.delete(searchId);
  }
}
