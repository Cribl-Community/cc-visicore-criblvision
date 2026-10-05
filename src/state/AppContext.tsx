import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getGroups } from '../api/client';
import { loadPrefs, savePrefs } from '../lib/prefs';
import type { Group } from '../api/types';

export interface TimeRange {
  id: string;
  label: string;
  rangeSeconds: number;
  bucketSeconds: number;
}

export const TIME_RANGES: TimeRange[] = [
  { id: '1h', label: 'Last 1 hour', rangeSeconds: 3600, bucketSeconds: 60 },
  { id: '6h', label: 'Last 6 hours', rangeSeconds: 21600, bucketSeconds: 300 },
  { id: '24h', label: 'Last 24 hours', rangeSeconds: 86400, bucketSeconds: 900 },
  { id: '7d', label: 'Last 7 days', rangeSeconds: 604800, bucketSeconds: 3600 },
];

const REFRESH_MS = 30000;

interface AppState {
  groups: Group[];
  groupsLoading: boolean;
  /** Selected group id, or 'all' for every worker/edge group. */
  group: string;
  setGroup: (g: string) => void;
  range: TimeRange;
  setRangeId: (id: string) => void;
  /** Increments on each auto-refresh tick or manual refresh; effects depend on it. */
  tick: number;
  refresh: () => void;
  lastRefresh: number;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [group, setGroup] = useState<string>('all');
  const [rangeId, setRangeId] = useState<string>('6h');
  const [tick, setTick] = useState(0);
  const [lastRefresh, setLastRefresh] = useState(() => Date.now());

  // The group inventory reloads on every refresh, so a new group appears — and a
  // failed first load recovers — without reloading the page. A failed reload
  // keeps the groups already known.
  const prefsRestored = useRef(false);
  useEffect(() => {
    let alive = true;
    Promise.all([getGroups().catch(() => null), loadPrefs()])
      .then(([gs, prefs]) => {
        if (!alive || !gs) return;
        // Only groups that actually process data: stream + edge fleets.
        const usable = gs.filter((g) => g.type === 'stream' || g.type === 'edge');
        setGroups(usable);
        if (prefsRestored.current) return;
        prefsRestored.current = true;
        // Restore saved selections, ignoring a group that no longer exists.
        if (prefs.group && (prefs.group === 'all' || usable.some((g) => g.id === prefs.group))) {
          setGroup(prefs.group);
        }
        if (prefs.rangeId && TIME_RANGES.some((r) => r.id === prefs.rangeId)) {
          setRangeId(prefs.rangeId);
        }
      })
      .finally(() => alive && setGroupsLoading(false));
    return () => {
      alive = false;
    };
  }, [tick]);

  useEffect(() => {
    const t = setInterval(() => {
      setTick((n) => n + 1);
      setLastRefresh(Date.now());
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  const range = useMemo(
    () => TIME_RANGES.find((r) => r.id === rangeId) ?? TIME_RANGES[1],
    [rangeId],
  );

  const value = useMemo<AppState>(
    () => ({
      groups,
      groupsLoading,
      group,
      setGroup: (g: string) => {
        setGroup(g);
        savePrefs({ group: g });
      },
      range,
      setRangeId: (id: string) => {
        setRangeId(id);
        savePrefs({ rangeId: id });
      },
      tick,
      refresh: () => {
        setTick((n) => n + 1);
        setLastRefresh(Date.now());
      },
      lastRefresh,
    }),
    [groups, groupsLoading, group, range, tick, lastRefresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used within AppProvider');
  return v;
}

/** Resolve the selected group into the concrete group ids to query. */
export function useGroupIds(): string[] {
  const { group, groups } = useApp();
  return group === 'all' ? groups.map((g) => g.id) : [group];
}
