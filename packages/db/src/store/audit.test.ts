import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({ query: vi.fn() }));

import { query } from '../client.js';
import { hasEventOfType, lastEventAt, listEventsOfTypeWith, pruneGithubDeliveries } from './audit.js';

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe('asking whether an event was recorded', () => {
  it('lets the database match the fields, rather than reading every event back', async () => {
    const since = new Date('2026-09-16T00:00:00.000Z');
    vi.mocked(query).mockResolvedValueOnce([{ found: 1 }]);

    await expect(hasEventOfType('deploy.testing_live', since, { repo: 'api', sha: 'deadbeef' })).resolves.toBe(true);

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('payload @> $3::jsonb');
    expect(String(sql)).toContain('limit 1');
    expect(params).toEqual(['deploy.testing_live', since, JSON.stringify({ repo: 'api', sha: 'deadbeef' })]);
  });

  it('answers no when nothing matched', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);

    await expect(hasEventOfType('deploy.testing_live', new Date(), { repo: 'api', sha: 'feedface' })).resolves.toBe(false);
  });
});

describe('reading the events about one subject', () => {
  it('matches the fields at any age, with no window that a slow subject outlives', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ id: '4', at: new Date('2026-01-02T00:00:00.000Z'), payload: { repo: 'shop', pr: 31 } }]);

    await expect(listEventsOfTypeWith('conflict.resolved', { repo: 'shop', pr: 31 })).resolves.toEqual([
      { id: 4, at: '2026-01-02T00:00:00.000Z', payload: { repo: 'shop', pr: 31 } },
    ]);

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('payload @> $2::jsonb');
    expect(String(sql)).not.toContain('at >=');
    expect(params).toEqual(['conflict.resolved', JSON.stringify({ repo: 'shop', pr: 31 })]);
  });
});

describe('when an event about one subject was last recorded', () => {
  it('reads only the newest, matched by its fields', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ at: new Date('2026-10-01T09:30:00.000Z') }]);

    await expect(lastEventAt('review.round_opened', { subjectRef: 'shop#31' })).resolves.toBe('2026-10-01T09:30:00.000Z');

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('payload @> $2::jsonb');
    expect(String(sql)).toContain('order by at desc limit 1');
    expect(params).toEqual(['review.round_opened', JSON.stringify({ subjectRef: 'shop#31' })]);
  });

  it('answers null when there is none', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);

    await expect(lastEventAt('review.round_opened', { subjectRef: 'shop#32' })).resolves.toBeNull();
  });
});

describe('removing old GitHub deliveries', () => {
  it('removes only processed github rows before the moment, keeps the newest delivery, and says how many', async () => {
    const before = new Date('2026-09-04T00:00:00.000Z');
    vi.mocked(query).mockResolvedValueOnce([{ removed: '1234' }]);

    await expect(pruneGithubDeliveries(before)).resolves.toBe(1234);

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    const text = String(sql).replace(/\s+/g, ' ');
    expect(text).toContain("delete from events where source = 'github' and processed_at is not null and at < $1");
    // The row lastGithubDelivery reads, so a quiet install still knows when GitHub was last heard from.
    expect(text).toContain("and id <> (select id from events where source = 'github' order by at desc limit 1)");
    for (const source of ['platform', 'schedule', 'console', 'alert']) expect(text).not.toContain(source);
    expect(params).toEqual([before]);
  });

  it('says none when nothing was old enough', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ removed: '0' }]);

    await expect(pruneGithubDeliveries(new Date())).resolves.toBe(0);
  });
});
