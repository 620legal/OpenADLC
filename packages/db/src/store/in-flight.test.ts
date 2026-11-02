import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(async () => []),
}));

import { query } from '../client.js';
import { inFlight } from './in-flight.js';

/** The statement, with its whitespace run together so a clause reads as one line. */
async function statement(): Promise<string> {
  await inFlight();
  return String(vi.mocked(query).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
}

describe('what the install has in flight', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(query).mockResolvedValue([] as never);
  });

  it('counts the three sources in one statement, as numbers', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ tasks: '2', merges: '1', deploys: '0' }] as never);
    expect(await inFlight()).toEqual({ tasks: 2, merges: 1, deploys: 0 });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('is nothing when the database answers no row', async () => {
    expect(await inFlight()).toEqual({ tasks: 0, merges: 0, deploys: 0 });
  });

  it('counts tasks queued or running, and not one paused on a person', async () => {
    const sql = await statement();
    expect(sql).toContain("from tasks where state in ('queued', 'running')");
    expect(sql).not.toContain("'paused'");
  });

  it('counts merges the line is working on, not one waiting, and none untouched for a day', async () => {
    const sql = await statement();
    expect(sql).toContain("from merge_lines where state in ('updating', 'testing', 'merging') and updated_at > now() - interval '24 hours'");
    expect(sql).not.toContain("'waiting'");
  });

  it('counts deploys waiting on a promote or still running, none untouched for a day', async () => {
    const sql = await statement();
    expect(sql).toContain("from deploy_runs where updated_at > now() - interval '24 hours'");
    // On its soak or held for a person, and promotable.
    expect(sql).toContain(
      "promote_dispatched_at is null and (promote_after is not null or promote_held_at is not null) and smoke_conclusion = 'success' and sent_back_at is null and rollback_dispatched_at is null",
    );
    // Dispatched and not seen to end.
    expect(sql).toContain('testing_dispatched_at is not null and testing_conclusion is null');
    expect(sql).toContain('promote_dispatched_at is not null and production_conclusion is null');
  });
});
