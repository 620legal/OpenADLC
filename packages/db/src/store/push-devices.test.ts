import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(async () => []),
}));

import { query } from '../client.js';
import { add, allIds, count, idFor, listFor, remove, removeById, removeFor, services } from './push-devices.js';

const migration = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', '0164_push_devices.sql'), 'utf8')
  .replace(/--.*$/gm, '')
  .replace(/\s+/g, ' ')
  .toLowerCase();

describe('0164, the table of a person’s push devices', () => {
  it('holds no endpoint and no keys: the subscription is a secret-store entry', () => {
    expect(migration).toContain('create table if not exists push_devices');
    expect(migration).toContain('endpoint_hash text not null');
    expect(migration).not.toMatch(/\bendpoint text\b/);
    expect(migration).not.toMatch(/p256dh|\bauth\b/);
  });

  it('goes with its person: removing the person removes their rows', () => {
    expect(migration).toContain('person_id uuid not null references people(id) on delete cascade');
  });

  it('knows the same browser saving again by its endpoint, per person', () => {
    expect(migration).toContain('unique (person_id, endpoint_hash)');
  });
});

describe('the push devices store', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(query).mockResolvedValue([] as never);
  });

  it('adds one, or renames the row this endpoint already has', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      { id: 'd1', person_id: 'p1', name: 'iPhone · Safari', service: 'web.push.apple.com', added_at: new Date('2026-11-10T10:00:00Z') },
    ] as never);
    const device = await add({ id: 'd1', personId: 'p1', name: 'iPhone · Safari', service: 'web.push.apple.com', endpointHash: 'abc' });
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('on conflict (person_id, endpoint_hash) do update set name = excluded.name');
    expect(params).toEqual(['d1', 'p1', 'iPhone · Safari', 'web.push.apple.com', 'abc']);
    expect(device).toEqual({ id: 'd1', personId: 'p1', name: 'iPhone · Safari', service: 'web.push.apple.com', addedAt: '2026-11-10T10:00:00.000Z' });
  });

  it('lists the devices of several people at once, and asks nothing for nobody', async () => {
    expect(await listFor([])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    await listFor(['p1', 'p2']);
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('where person_id = any($1::uuid[])');
    expect(params).toEqual([['p1', 'p2']]);
  });

  it('removes only the caller’s own device, and says whether there was one', async () => {
    expect(await remove('d1', 'p1')).toBe(false);
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('where id = $1 and person_id = $2');
    expect(params).toEqual(['d1', 'p1']);
    vi.mocked(query).mockResolvedValueOnce([{ id: 'd1' }] as never);
    expect(await remove('d1', 'p1')).toBe(true);
  });

  it('reads and removes by id, by person, and counts', async () => {
    await removeById('d1');
    await removeFor('p1');
    vi.mocked(query).mockResolvedValueOnce([{ n: '3' }] as never);
    expect(await count('p1')).toBe(3);
    vi.mocked(query).mockResolvedValueOnce([{ id: 'd9' }] as never);
    expect(await idFor('p1', 'abc')).toBe('d9');
    vi.mocked(query).mockResolvedValueOnce([{ id: 'd1' }, { id: 'd2' }] as never);
    expect(await allIds()).toEqual(['d1', 'd2']);
    vi.mocked(query).mockResolvedValueOnce([{ service: 'fcm.googleapis.com' }] as never);
    expect(await services()).toEqual(['fcm.googleapis.com']);
    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toContain('delete from push_devices where id = $1');
    expect(String(vi.mocked(query).mock.calls[1]?.[0])).toContain('delete from push_devices where person_id = $1');
  });
});
