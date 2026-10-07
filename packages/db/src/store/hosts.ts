import { query, queryOne } from '../client.js';

export interface HostRecord {
  id: string;
  name: string;
  zone: string | null;
  driver: 'docker' | 'local';
  capacityBots: number;
  /** How many tasks it runs at once, whoever's; see `FLEETADLC_HOST_CAPACITY_TASKS`. */
  capacityTasks: number;
  status: 'up' | 'down' | 'unknown';
  lastSeenAt: string | null;
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
}

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
  };
}

/**
 * Each hostd registers itself under its name and heartbeats it; `taskRoom`
 * sums the hosts' `capacity_tasks`. `capacity_bots` is recorded only.
 */
export async function registerHost(input: {
  name: string;
  zone: string | null;
  driver: 'docker' | 'local';
  capacityBots: number;
  capacityTasks?: number;
}): Promise<HostRecord> {
  const row = await queryOne<HostRow>(
    `insert into hosts (name, zone, driver, capacity_bots, capacity_tasks, status, last_seen_at)
     values ($1,$2,$3,$4,coalesce($5::int, 4),'up', now())
     on conflict (name) do update set
       zone = excluded.zone,
       driver = excluded.driver,
       capacity_bots = excluded.capacity_bots,
       capacity_tasks = coalesce($5::int, hosts.capacity_tasks),
       status = 'up',
       last_seen_at = now(),
       updated_at = now()
     returning id, name, zone, driver, capacity_bots, capacity_tasks, status, last_seen_at`,
    [input.name, input.zone, input.driver, input.capacityBots, input.capacityTasks ?? null],
  );
  if (!row) throw new Error('failed to register host');
  return toHost(row);
}

/**
 * The seed's host row: made when missing, and otherwise left as hostd
 * registered it. The seed used `registerHost`, which put `capacity_tasks` back
 * to 4 and marked the host up whether or not hostd was running, so a
 * `fleetadlc seed` beside a hostd set to 8 held every task past the fourth.
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
  const live = `status <> 'down' and last_seen_at > now() - interval '2 minutes'`;
  const row = await queryOne<{ hosts: string; capacity: string; used: string }>(
    `select (select count(*) from hosts where ${live})::text as hosts,
            (select coalesce(sum(capacity_tasks), 0) from hosts where ${live})::text as capacity,
            (select count(*) from tasks
              where state in ('queued','running') or (state = 'paused' and host_id is not null))::text as used`,
  );
  if (!row || Number(row.hosts) === 0) return null;
  return Number(row.capacity) - Number(row.used);
}

export async function listHosts(): Promise<HostRecord[]> {
  const rows = await query<HostRow>(
    'select id, name, zone, driver, capacity_bots, capacity_tasks, status, last_seen_at from hosts order by name',
  );
  return rows.map(toHost);
}
