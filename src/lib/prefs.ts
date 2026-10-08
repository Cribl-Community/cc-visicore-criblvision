// Persisted user preferences. Inside Cribl they live in the app's scoped
// KV store (survives across browsers/devices); in demo mode they fall back to
// localStorage. Reads happen once per session; writes are debounced and
// fire-and-forget — prefs are never worth blocking the UI over.

import { useCallback, useEffect, useState } from 'react';

export interface Prefs {
  /** Selected worker group ('all' or a group id). */
  group?: string;
  /** Selected time range id (must match a TIME_RANGES id). */
  rangeId?: string;
  /** Route Health stall threshold, seconds. */
  stallSeconds?: number;
  /** Data Value downstream cost, $/GB. */
  priceGB?: number;
  /** Search alerts: who receives the email (never shipped — set per install). */
  alertEmailTo?: string;
  alertEmailCc?: string;
  alertEmailBcc?: string;
}

const API_URL = (typeof window !== 'undefined' && window.CRIBL_API_URL) || '';
const KV_URL = `${API_URL}/kvstore/vision/prefs`;
const LS_KEY = 'cribl-vision-prefs';
const SAVE_DEBOUNCE_MS = 600;

let cache: Prefs = {};
let loadPromise: Promise<Prefs> | null = null;

function sanitize(v: unknown): Prefs {
  if (!v || typeof v !== 'object') return {};
  const o = v as Record<string, unknown>;
  const p: Prefs = {};
  if (typeof o.group === 'string') p.group = o.group;
  if (typeof o.rangeId === 'string') p.rangeId = o.rangeId;
  if (typeof o.stallSeconds === 'number') p.stallSeconds = o.stallSeconds;
  if (typeof o.priceGB === 'number') p.priceGB = o.priceGB;
  if (typeof o.alertEmailTo === 'string') p.alertEmailTo = o.alertEmailTo;
  if (typeof o.alertEmailCc === 'string') p.alertEmailCc = o.alertEmailCc;
  if (typeof o.alertEmailBcc === 'string') p.alertEmailBcc = o.alertEmailBcc;
  return p;
}

/** Load prefs once; concurrent callers share the same promise. Never throws. */
export function loadPrefs(): Promise<Prefs> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        if (!API_URL) {
          cache = sanitize(JSON.parse(localStorage.getItem(LS_KEY) ?? '{}'));
        } else {
          const res = await fetch(KV_URL, { headers: { accept: 'application/json' } });
          if (res.ok) {
            const body: unknown = await res.json();
            // KV entries may come back either raw or wrapped as { value: ... }.
            const inner =
              body && typeof body === 'object' && 'value' in (body as Record<string, unknown>)
                ? (body as Record<string, unknown>).value
                : body;
            cache = sanitize(inner);
          }
        }
      } catch {
        cache = {};
      }
      return cache;
    })();
  }
  return loadPromise;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Merge a patch into the prefs and persist it (debounced, best-effort). */
export function savePrefs(patch: Partial<Prefs>): void {
  cache = { ...cache, ...patch };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = JSON.stringify(cache);
    if (!API_URL) {
      try {
        localStorage.setItem(LS_KEY, data);
      } catch {
        // storage full/blocked — prefs just won't stick
      }
    } else {
      void fetch(KV_URL, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: data,
      }).catch(() => {});
    }
  }, SAVE_DEBOUNCE_MS);
}

/**
 * useState backed by a persisted pref. Starts at the cached/fallback value,
 * upgrades once prefs finish loading, and persists on every set.
 */
export function usePref<K extends keyof Prefs>(
  key: K,
  fallback: NonNullable<Prefs[K]>,
): [NonNullable<Prefs[K]>, (v: NonNullable<Prefs[K]>) => void] {
  const [val, setVal] = useState<NonNullable<Prefs[K]>>(cache[key] ?? fallback);

  useEffect(() => {
    let alive = true;
    void loadPrefs().then((p) => {
      if (alive && p[key] != null) setVal(p[key] as NonNullable<Prefs[K]>);
    });
    return () => {
      alive = false;
    };
  }, [key]);

  const set = useCallback(
    (v: NonNullable<Prefs[K]>) => {
      setVal(v);
      savePrefs({ [key]: v });
    },
    [key],
  );

  return [val, set];
}
