import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

import { query, queryOne } from '../client.js';
import { ensureHost, registerHost, taskLoad, taskRoom } from './hosts.js';

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
