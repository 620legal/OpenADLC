import { query, queryOne } from '../client.js';

export interface HostRecord {
  id: string;
  name: string;
  zone: string | null;
  driver: 'docker' | 'local';
  capacityBots: number;
  /** How many tasks it runs at once, whoever's; see `OPENADLC_HOST_CAPACITY_TASKS`. */
  capacityTasks: number;
  status: 'up' | 'down' | 'unknown';
  lastSeenAt: string | null;
  /** What hostd saw at its last registration; null until one reports it. */
  cpus: number | null;
  memoryBytes: number | null;
}

interface HostRow {
  id: string;
  name: string;
  zone: string | null;
  driver: 'docker' | 'local';
  capacity_bots: number;
  capacity_tasks: number;
  status: HostRecord['status'];
  last_seen_at: Date | null;
  cpus: number | null;
  // pg returns a bigint as a string.
  memory_bytes: string | number | null;
}

const COLUMNS = 'id, name, zone, driver, capacity_bots, capacity_tasks, status, last_seen_at, cpus, memory_bytes';

function toHost(row: HostRow): HostRecord {
  return {
    id: row.id,
    name: row.name,
    zone: row.zone,
    driver: row.driver,
    capacityBots: row.capacity_bots,
    capacityTasks: row.capacity_tasks,
    status: row.status,
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    cpus: row.cpus ?? null,
    memoryBytes: row.memory_bytes == null ? null : Number(row.memory_bytes),
  };
}

/**
 * Each hostd registers itself under its name and heartbeats it; `taskRoom`
 * sums the hosts' `capacity_tasks`. `capacity_bots` is recorded only.
 *
 * `cpus` and `memory_bytes` are what this registration reported, not kept
 * from the last one: a figure nobody reports now reads "not reported" on
 * Settings → Hosts rather than an old machine's size.
 */
export async function registerHost(input: {
  name: string;
  zone: string | null;
  driver: 'docker' | 'local';
  capacityBots: number;
  capacityTasks?: number;
  cpus?: number | null;
  memoryBytes?: number | null;
}): Promise<HostRecord> {
  const row = await queryOne<HostRow>(
    `insert into hosts (name, zone, driver, capacity_bots, capacity_tasks, status, last_seen_at, cpus, memory_bytes)
     values ($1,$2,$3,$4,coalesce($5::int, 4),'up', now(), $6, $7)
     on conflict (name) do update set
       zone = excluded.zone,
       driver = excluded.driver,
       capacity_bots = excluded.capacity_bots,
       capacity_tasks = coalesce($5::int, hosts.capacity_tasks),
       status = 'up',
       last_seen_at = now(),
       cpus = $6,
       memory_bytes = $7,
       updated_at = now()
     returning ${COLUMNS}`,
    [
      input.name,
      input.zone,
      input.driver,
      input.capacityBots,
      input.capacityTasks ?? null,
      input.cpus ?? null,
      input.memoryBytes ?? null,
    ],
  );
  if (!row) throw new Error('failed to register host');
  return toHost(row);
}

/**
 * The seed's host row: made when missing, and otherwise left as hostd
 * registered it. The seed used `registerHost`, which put `capacity_tasks` back
 * to 4 and marked the host up whether or not hostd was running, so a
 * `openadlc seed` beside a hostd set to 8 held every task past the fourth.
 */
export async function ensureHost(input: { name: string; driver: 'docker' | 'local'; capacityBots: number }): Promise<{ id: string }> {
  await query(
    `insert into hosts (name, driver, capacity_bots) values ($1, $2, $3) on conflict (name) do nothing`,
    [input.name, input.driver, input.capacityBots],
  );
  const row = await queryOne<{ id: string }>('select id from hosts where name = $1', [input.name]);
  if (!row) throw new Error(`failed to record the host ${input.name}`);
  return row;
}

export async function heartbeat(name: string): Promise<void> {
  await query(`update hosts set last_seen_at = now(), status = 'up', updated_at = now() where name = $1`, [name]);
}

/**
 * How many more tasks the install's hosts can run at once: the sum of their
 * `capacity_tasks`, less every task that holds a computer (queued or running,
 * or paused with its computer kept). Null while no host is live, when nothing
 * can be said: a task start then finds hostd's own answer.
 *
 * A host is live while it heartbeats (every ten seconds). Nothing marks a host
 * down, so a row left behind — a renamed machine, a replaced VM — counted
 * toward the room for ever, and the dispatcher kept starting tasks hostd had
 * no room for.
 */
export async function taskRoom(): Promise<number | null> {
  const load = await taskLoad();
  return load === null ? null : load.capacity - load.used;
}

/**
 * What `taskRoom` is the difference of: the live hosts' `capacity_tasks`
 * summed, and the tasks holding a computer now. The board says both of a
 * card that waits only for a host's room ("4 of 4 running"): told the room
 * alone, it could say only that there was none. Null while no host is live.
 */
export async function taskLoad(): Promise<{ capacity: number; used: number } | null> {
  const live = `status <> 'down' and last_seen_at > now() - interval '2 minutes'`;
  const row = await queryOne<{ hosts: string; capacity: string; used: string }>(
    `select (select count(*) from hosts where ${live})::text as hosts,
            (select coalesce(sum(capacity_tasks), 0) from hosts where ${live})::text as capacity,
            (select count(*) from tasks
              where state in ('queued','running') or (state = 'paused' and host_id is not null))::text as used`,
  );
  if (!row || Number(row.hosts) === 0) return null;
  return { capacity: Number(row.capacity), used: Number(row.used) };
}

export async function listHosts(): Promise<HostRecord[]> {
  const rows = await query<HostRow>(`select ${COLUMNS} from hosts order by name`);
  return rows.map(toHost);
}

/**
 * Per host, what Settings → Hosts says of it: `used`, the tasks holding a
 * computer on it (`taskLoad`'s predicate, grouped by host), and
 * `failedSilent`, the tasks failed with `stoppedReason` since its last beat,
 * so an outage last week is not counted again. The reason comes from the
 * caller: it is the bridge's reconcile that writes it, and this package does
 * not import the bridge. A host with no such task is absent from the map.
 */
export async function hostLoads(stoppedReason: string): Promise<Map<string, { used: number; failedSilent: number }>> {
  const rows = await query<{ host_id: string; used: string; failed_silent: string }>(
    `select t.host_id,
            count(*) filter (where t.state in ('queued','running') or t.state = 'paused')::text as used,
            count(*) filter (where t.state = 'failed' and t.exit_reason = $1
                               and h.last_seen_at is not null and t.ended_at >= h.last_seen_at)::text as failed_silent
       from tasks t
       join hosts h on h.id = t.host_id
      group by t.host_id`,
    [stoppedReason],
  );
  return new Map(rows.map((row) => [row.host_id, { used: Number(row.used), failedSilent: Number(row.failed_silent) }]));
}

/**
 * Queued tasks no host has claimed yet: they count toward `taskLoad`'s `used`
 * but toward no host's, so the page says them apart and its rows add up to
 * the board's "N of M running".
 */
export async function unclaimedTasks(): Promise<number> {
  const row = await queryOne<{ count: string }>(`select count(*)::text as count from tasks where state = 'queued' and host_id is null`);
  return Number(row?.count ?? 0);
}
