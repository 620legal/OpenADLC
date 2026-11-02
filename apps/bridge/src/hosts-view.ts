import { HOST_SILENT_MS } from './reconciler.js';

/** A `hosts` row as the store reads it: the fields Settings → Hosts shows. */
export interface HostInput {
  id: string;
  name: string;
  driver: 'docker' | 'local';
  capacityTasks: number;
  lastSeenAt: string | null;
  cpus: number | null;
  memoryBytes: number | null;
}

export type HostState = 'live' | 'silent' | 'never_seen';

export interface HostRow {
  id: string;
  name: string;
  driver: 'docker' | 'local';
  capacityTasks: number;
  /** Tasks holding a computer on it, as `taskLoad` counts them. */
  used: number;
  cpus: number | null;
  memoryBytes: number | null;
  lastSeenAt: string | null;
  state: HostState;
  /** Tasks reconcile failed for its silence since its last beat; 0 unless silent. */
  failedSilent: number;
}

export interface HostsView {
  /** The bridge's clock, so "seen 8 s ago" does not depend on the browser's. */
  now: string;
  /** Queued tasks no host has claimed yet, counted toward no host. */
  unclaimed: number;
  silentAfterMs: number;
  hosts: HostRow[];
}

const ORDER: Record<HostState, number> = { live: 0, silent: 1, never_seen: 2 };

/**
 * Judges each host as reconcile does: silent once its last beat is
 * `HOST_SILENT_MS` old, which is when reconcile starts failing its tasks. Not
 * `taskLoad`'s two-minute window: a page that called a host silent three
 * minutes before its tasks were failed would say they were failed when they
 * were not. See docs/adr/0025-the-hosts-page-reads-what-reconcile-judges.md.
 */
export function hostsView(
  hosts: readonly HostInput[],
  loads: ReadonlyMap<string, { used: number; failedSilent: number }>,
  unclaimed: number,
  now: Date,
): HostsView {
  const silentBefore = now.getTime() - HOST_SILENT_MS;
  const rows = hosts.map((host): HostRow => {
    const state: HostState =
      host.lastSeenAt === null ? 'never_seen' : Date.parse(host.lastSeenAt) >= silentBefore ? 'live' : 'silent';
    const load = loads.get(host.id);
    return {
      id: host.id,
      name: host.name,
      driver: host.driver,
      capacityTasks: host.capacityTasks,
      used: load?.used ?? 0,
      cpus: host.cpus,
      memoryBytes: host.memoryBytes,
      lastSeenAt: host.lastSeenAt,
      state,
      failedSilent: state === 'silent' ? (load?.failedSilent ?? 0) : 0,
    };
  });
  rows.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
  return { now: now.toISOString(), unclaimed, silentAfterMs: HOST_SILENT_MS, hosts: rows };
}
