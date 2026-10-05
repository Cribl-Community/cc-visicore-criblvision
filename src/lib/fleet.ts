// Rolls node, Source, and Destination health up to one status per worker group.

import type { Group, Health, WorkerNode } from '../api/types';
import type { IOStatusWithGroup } from '../api/client';
import { countHealth, type HealthCounts } from './metrics';

export function nodeHealthy(w: WorkerNode): boolean {
  return w.status === 'healthy' && !w.disconnected;
}

/** 'Empty' = the group has no connected nodes, so nothing in it is running. */
export type GroupStatus = Health | 'Empty';

export interface GroupSummary {
  id: string;
  type: string;
  nodes: WorkerNode[];
  nodesDown: number;
  src: HealthCounts;
  dst: HealthCounts;
  status: GroupStatus;
  /** Source / Destination status could not be loaded for this group. */
  ioFailed: boolean;
}

const STATUS_ORDER: Record<GroupStatus, number> = { Red: 0, Yellow: 1, Green: 2, Unknown: 3, Empty: 4 };

/** Roll node, Source, and Destination health up to one status per group; worst first. */
export function summarizeGroups(
  groups: Group[],
  workers: WorkerNode[],
  inputs: IOStatusWithGroup[],
  outputs: IOStatusWithGroup[],
  /** Groups whose Source / Destination status could not be loaded. */
  failed: string[] = [],
): GroupSummary[] {
  return groups
    .map((g) => {
      const nodes = workers.filter((w) => w.group === g.id);
      const nodesDown = nodes.filter((w) => !nodeHealthy(w)).length;
      const src = countHealth(inputs.filter((s) => s.group === g.id).map((s) => s.status?.health));
      const dst = countHealth(outputs.filter((s) => s.group === g.id).map((s) => s.status?.health));
      // A node down is the group's own problem; unhealthy Sources or Destinations
      // on healthy nodes mean the group is running but degraded.
      const status: GroupStatus =
        nodes.length === 0
          ? 'Empty'
          : nodesDown > 0
            ? 'Red'
            : failed.includes(g.id)
              ? 'Unknown'
              : src.Red + dst.Red + src.Yellow + dst.Yellow > 0
                ? 'Yellow'
                : 'Green';
      return { id: g.id, type: g.type, nodes, nodesDown, src, dst, status, ioFailed: failed.includes(g.id) };
    })
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.id.localeCompare(b.id));
}
