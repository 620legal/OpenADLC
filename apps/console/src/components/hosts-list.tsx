import { SettingsCard } from '@/components/settings-sections';
import type { HostRow, HostsView } from '@/lib/api';
import { ago } from '@/lib/when';

const GIB = 1024 ** 3;

/** "seen 8 s ago": a host beats every ten seconds, so minutes would hide a stopped one. */
export function seenAgo(lastSeenAt: string, now: string): string {
  const elapsed = Date.parse(now) - Date.parse(lastSeenAt);
  if (Number.isFinite(elapsed) && elapsed < 60_000) return `seen ${Math.max(0, Math.floor(elapsed / 1000))} s ago`;
  return `seen ${ago(lastSeenAt, now)}`;
}

/** "16 GB", "7.5 GB": GiB, as the machine counts it, with one decimal under 10. */
export function memory(bytes: number): string {
  const gib = bytes / GIB;
  return `${gib < 10 ? Number(gib.toFixed(1)) : Math.round(gib)} GB`;
}

function Size({ host }: { host: HostRow }) {
  const cpus = host.cpus === null ? 'CPUs not reported' : `${host.cpus} ${host.cpus === 1 ? 'CPU' : 'CPUs'}`;
  const mem = host.memoryBytes === null ? 'memory not reported' : memory(host.memoryBytes);
  return (
    <span>
      {cpus} · {mem}
    </span>
  );
}

function Name({ host }: { host: HostRow }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="font-medium text-body">{host.name}</span>
      <span className="text-[12px] text-muted">{host.driver}</span>
    </span>
  );
}

function LiveRow({ host, now }: { host: HostRow; now: string }) {
  return (
    <li className="flex flex-col gap-0.5 border-t border-edge py-2.5 first:border-t-0" data-host={host.name}>
      <Name host={host} />
      <span className="flex flex-wrap gap-x-3 text-[12.5px] text-muted">
        <span>{host.lastSeenAt && seenAgo(host.lastSeenAt, now)}</span>
        <span>
          {host.used} of {host.capacityTasks} tasks
        </span>
        <Size host={host} />
      </span>
    </li>
  );
}

function SilentRow({ host, now, silentAfterMs }: { host: HostRow; now: string; silentAfterMs: number }) {
  const failed =
    host.failedSilent === 0
      ? 'No task was running on it.'
      : `${host.failedSilent} ${host.failedSilent === 1 ? 'task was' : 'tasks were'} failed with “the host stopped reporting”.`;
  return (
    <li className="flex flex-col gap-0.5 border-t border-edge py-2.5 first:border-t-0" data-host={host.name}>
      <Name host={host} />
      <span className="text-[12.5px] text-body">
        Silent: last heard from {host.lastSeenAt ? ago(host.lastSeenAt, now) : 'never'} (no heartbeat for{' '}
        {Math.round(silentAfterMs / 60_000)} min)
      </span>
      <span className="text-[12.5px] text-muted">{failed}</span>
      <span className="text-[12.5px] text-muted">
        <Size host={host} />
      </span>
    </li>
  );
}

function NeverSeenRow({ host }: { host: HostRow }) {
  return (
    <li className="flex flex-col gap-0.5 border-t border-edge py-2.5 first:border-t-0" data-host={host.name}>
      <Name host={host} />
      <span className="flex flex-wrap gap-x-3 text-[12.5px] text-muted">
        <span>never seen</span>
        <Size host={host} />
      </span>
    </li>
  );
}

/**
 * Settings → Hosts: each machine that runs tasks, read-only. A host is silent
 * when reconcile would fail its tasks (`GET /v1/hosts`), so a silent row can
 * say what that cost; one that has never beaten is not silent, only new.
 */
export function HostsList({ view }: { view: HostsView }) {
  const live = view.hosts.filter((host) => host.state === 'live');
  const silent = view.hosts.filter((host) => host.state === 'silent');
  const neverSeen = view.hosts.filter((host) => host.state === 'never_seen');

  return (
    <SettingsCard id="hosts" title="Hosts" line="The machines that run tasks, and how busy each is.">
      {view.hosts.length === 0 ? (
        <p className="text-[12.5px] text-body">
          No host has registered yet. Start hostd, and run <code>openadlc doctor</code> to see why it hasn’t.
        </p>
      ) : (
        <>
          {live.length > 0 && (
            <ul className="flex flex-col">
              {live.map((host) => (
                <LiveRow key={host.id} host={host} now={view.now} />
              ))}
            </ul>
          )}
          {silent.length > 0 && (
            <section aria-labelledby="hosts-silent-title" className="mt-3 flex flex-col">
              <h3 id="hosts-silent-title" className="text-[12.5px] font-semibold text-body">
                Silent
              </h3>
              <ul className="flex flex-col">
                {silent.map((host) => (
                  <SilentRow key={host.id} host={host} now={view.now} silentAfterMs={view.silentAfterMs} />
                ))}
              </ul>
            </section>
          )}
          {neverSeen.length > 0 && (
            <ul className="mt-3 flex flex-col">
              {neverSeen.map((host) => (
                <NeverSeenRow key={host.id} host={host} />
              ))}
            </ul>
          )}
        </>
      )}
      {view.unclaimed > 0 && (
        <p className="mt-2 text-[12.5px] text-muted">
          {view.unclaimed} {view.unclaimed === 1 ? 'task' : 'tasks'} waiting to be claimed by a host
        </p>
      )}
    </SettingsCard>
  );
}
