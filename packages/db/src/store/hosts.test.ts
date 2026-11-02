import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

import { query, queryOne } from '../client.js';
import { ensureHost, hostLoads, listHosts, registerHost, taskLoad, taskRoom, unclaimedTasks } from './hosts.js';

const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ');

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
});

describe('a host registering', () => {
  it('keeps the task capacity it had when it names none', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      id: 'host-1',
      name: 'mac',
      zone: null,
      driver: 'docker',
      capacity_bots: 8,
      capacity_tasks: 8,
      status: 'up',
      last_seen_at: new Date('2026-10-01T00:00:00.000Z'),
    });

    await registerHost({ name: 'mac', zone: null, driver: 'docker', capacityBots: 8 });

    expect(flat(vi.mocked(queryOne).mock.calls[0]?.[0])).toContain('capacity_tasks = coalesce($5::int, hosts.capacity_tasks)');
  });

  it('records the CPUs and memory it reports, on insert and on conflict alike', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      id: 'host-1',
      name: 'mac',
      zone: null,
      driver: 'docker',
      capacity_bots: 8,
      capacity_tasks: 4,
      status: 'up',
      last_seen_at: new Date('2026-10-01T00:00:00.000Z'),
      cpus: 8,
      // pg hands a bigint back as a string.
      memory_bytes: '17179869184',
    });

    const host = await registerHost({ name: 'mac', zone: null, driver: 'docker', capacityBots: 8, cpus: 8, memoryBytes: 17179869184 });

    expect(host).toMatchObject({ cpus: 8, memoryBytes: 17179869184 });
    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    expect(flat(sql)).toContain('(name, zone, driver, capacity_bots, capacity_tasks, status, last_seen_at, cpus, memory_bytes)');
    expect(flat(sql)).toContain("values ($1,$2,$3,$4,coalesce($5::int, 4),'up', now(), $6, $7)");
    // Overwritten, not coalesced: a host that stops reporting them reads "not reported".
    expect(flat(sql)).toContain('cpus = $6, memory_bytes = $7,');
    expect(flat(sql)).toContain('returning id, name, zone, driver, capacity_bots, capacity_tasks, status, last_seen_at, cpus, memory_bytes');
    expect(params).toEqual(['mac', null, 'docker', 8, null, 8, 17179869184]);
  });

  it('records null for a host that reports neither', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      id: 'host-1',
      name: 'mac',
      zone: null,
      driver: 'local',
      capacity_bots: 8,
      capacity_tasks: 4,
      status: 'up',
      last_seen_at: null,
      cpus: null,
      memory_bytes: null,
    });

    const host = await registerHost({ name: 'mac', zone: null, driver: 'local', capacityBots: 8 });

    expect(host).toMatchObject({ cpus: null, memoryBytes: null, lastSeenAt: null });
    expect(vi.mocked(queryOne).mock.calls[0]?.[1]).toEqual(['mac', null, 'local', 8, null, null, null]);
  });
});

describe('listing the hosts', () => {
  it('reads their CPUs and memory beside the rest', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      {
        id: 'host-1',
        name: 'mac',
        zone: null,
        driver: 'docker',
        capacity_bots: 8,
        capacity_tasks: 4,
        status: 'up',
        last_seen_at: new Date('2026-10-01T00:00:00.000Z'),
        cpus: 10,
        memory_bytes: '8589934592',
      },
    ]);

    expect(await listHosts()).toEqual([
      {
        id: 'host-1',
        name: 'mac',
        zone: null,
        driver: 'docker',
        capacityBots: 8,
        capacityTasks: 4,
        status: 'up',
        lastSeenAt: '2026-10-01T00:00:00.000Z',
        cpus: 10,
        memoryBytes: 8589934592,
      },
    ]);
    expect(flat(vi.mocked(query).mock.calls[0]?.[0])).toBe(
      'select id, name, zone, driver, capacity_bots, capacity_tasks, status, last_seen_at, cpus, memory_bytes from hosts order by name',
    );
  });
});

describe('each host’s load', () => {
  it('counts the tasks holding a computer on it, and those failed for its silence since its last beat', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      { host_id: 'host-1', used: '2', failed_silent: '0' },
      { host_id: 'host-2', used: '0', failed_silent: '3' },
    ]);

    const loads = await hostLoads('the host stopped reporting');

    expect([...loads]).toEqual([
      ['host-1', { used: 2, failedSilent: 0 }],
      ['host-2', { used: 0, failedSilent: 3 }],
    ]);
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(params).toEqual(['the host stopped reporting']);
    const text = flat(sql);
    // `taskLoad`'s predicate: a paused task here has a host, so its computer is kept.
    expect(text).toContain("count(*) filter (where t.state in ('queued','running') or t.state = 'paused')::text as used");
    // Only since the host's last beat, so an outage last week does not count again.
    expect(text).toContain(
      "count(*) filter (where t.state = 'failed' and t.exit_reason = $1 and h.last_seen_at is not null and t.ended_at >= h.last_seen_at)::text as failed_silent",
    );
    expect(text).toContain('from tasks t join hosts h on h.id = t.host_id group by t.host_id');
  });

  it('says apart the queued tasks no host has claimed', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ count: '2' });

    expect(await unclaimedTasks()).toBe(2);
    expect(flat(vi.mocked(queryOne).mock.calls[0]?.[0])).toBe(
      "select count(*)::text as count from tasks where state = 'queued' and host_id is null",
    );
  });
});

describe('the seed’s host', () => {
  it('is made when missing and otherwise left as hostd registered it', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    vi.mocked(queryOne).mockResolvedValueOnce({ id: 'host-1' });

    expect(await ensureHost({ name: 'mac', driver: 'docker', capacityBots: 5 })).toEqual({ id: 'host-1' });

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(flat(sql)).toBe('insert into hosts (name, driver, capacity_bots) values ($1, $2, $3) on conflict (name) do nothing');
    expect(params).toEqual(['mac', 'docker', 5]);
    expect(vi.mocked(queryOne).mock.calls[0]?.[1]).toEqual(['mac']);
  });
});

describe('the room the hosts have', () => {
  it('counts only hosts that have heartbeated lately, so a row left behind adds none', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ hosts: '1', capacity: '4', used: '1' });

    expect(await taskRoom()).toBe(3);

    const sql = flat(vi.mocked(queryOne).mock.calls[0]?.[0]);
    expect(sql).toContain("(select count(*) from hosts where status <> 'down' and last_seen_at > now() - interval '2 minutes')");
    expect(sql).toContain(
      "(select coalesce(sum(capacity_tasks), 0) from hosts where status <> 'down' and last_seen_at > now() - interval '2 minutes')",
    );
  });

  it('counts a paused task’s computer while it is kept, though its seat no longer counts the task', async () => {
    // A task paused on a person's answer stopped holding its seat's tasks at
    // once (`tasks.seatHasRoom`); its container, memory and database are still
    // on the host until its computer is given back.
    vi.mocked(queryOne).mockResolvedValueOnce({ hosts: '1', capacity: '4', used: '4' });

    expect(await taskRoom()).toBe(0);
    expect(flat(vi.mocked(queryOne).mock.calls[0]?.[0])).toContain(
      "(select count(*) from tasks where state in ('queued','running') or (state = 'paused' and host_id is not null))::text as used",
    );
  });

  it('is unknown while no host is live', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ hosts: '0', capacity: '0', used: '0' });
    expect(await taskRoom()).toBeNull();
  });
});

describe('what the hosts hold', () => {
  it('is their room and the tasks holding a computer, counted as the room is, for a card that waits for a host (#153)', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ hosts: '2', capacity: '8', used: '8' });

    expect(await taskLoad()).toEqual({ capacity: 8, used: 8 });

    const sql = flat(vi.mocked(queryOne).mock.calls[0]?.[0]);
    expect(sql).toContain(
      "(select coalesce(sum(capacity_tasks), 0) from hosts where status <> 'down' and last_seen_at > now() - interval '2 minutes')",
    );
    expect(sql).toContain("(select count(*) from tasks where state in ('queued','running') or (state = 'paused' and host_id is not null))::text as used");
  });

  it('is unknown while no host is live', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ hosts: '0', capacity: '0', used: '0' });
    expect(await taskLoad()).toBeNull();
  });
});
