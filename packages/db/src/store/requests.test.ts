import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

import { query, queryOne } from '../client.js';
import { AmbiguousRequestPrefix, claimQueued, createRequest, findRequestByPrefix, listQueued, queueAgain, requeue, updateRequest } from './requests.js';

const row = (id: string) => ({
  id,
  text: 'Create html hello world and a readme file.',
  context: null,
  repo_id: 'repo-1',
  kind: 'feature',
  requested_by: 'janedoe',
  issue_number: null,
  state: 'draft',
  created_at: new Date('2026-09-24T20:44:22.945Z'),
});

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
});

describe('the request a subject names', () => {
  it('is found by the eight characters the subject carries', async () => {
    vi.mocked(query).mockResolvedValueOnce([row('a4b02784-3ae8-450b-abe9-0c93eb4d67dc')]);

    const found = await findRequestByPrefix('A4B02784');

    expect(found).toMatchObject({ id: 'a4b02784-3ae8-450b-abe9-0c93eb4d67dc', state: 'draft', requestedBy: 'janedoe' });
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/where id::text like \$1 order by created_at limit 2/);
    expect(params).toEqual(['a4b02784%']);
  });

  it('is refused when two requests share the prefix, rather than guessed', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      row('a4b02784-3ae8-450b-abe9-0c93eb4d67dc'),
      row('a4b02784-0000-4000-8000-000000000001'),
    ]);

    await expect(findRequestByPrefix('a4b02784')).rejects.toBeInstanceOf(AmbiguousRequestPrefix);
  });

  it('is nobody when nothing matches', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    expect(await findRequestByPrefix('ffffffff')).toBeNull();
  });

  it('never reaches the database with something that is not part of an id', async () => {
    // `%` and `_` would make a prefix a pattern, and an empty one matches every row.
    for (const prefix of ['', '   ', '%', 'a4b_2784', "a4b02784' or 1=1"]) {
      expect(await findRequestByPrefix(prefix)).toBeNull();
    }
    expect(query).not.toHaveBeenCalled();
  });
});

describe('a new request', () => {
  const input = { text: 'Add a dark mode.', context: null, repoId: 'repo-1', kind: 'feature', requestedBy: 'janedoe', state: 'queued' as const };
  const refused = (constraint: string) =>
    Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', constraint });

  it('draws a fresh id when its first eight characters are another request’s, so its subject names it alone', async () => {
    vi.mocked(queryOne)
      .mockRejectedValueOnce(refused('requests_id8'))
      .mockResolvedValueOnce({ ...row('b71c09e2-3ae8-450b-abe9-0c93eb4d67dc'), state: 'queued' });

    expect(await createRequest(input)).toMatchObject({ id: 'b71c09e2-3ae8-450b-abe9-0c93eb4d67dc', state: 'queued' });
    expect(queryOne).toHaveBeenCalledTimes(2);
    // The id is the column's default, never one the store made up.
    expect(String(vi.mocked(queryOne).mock.calls[1]?.[0])).toMatch(/insert into requests \(text, context, repo_id, kind, requested_by, state\)/);
  });

  it('gives up after a few draws, and says why', async () => {
    vi.mocked(queryOne).mockRejectedValue(refused('requests_id8'));

    await expect(createRequest(input)).rejects.toMatchObject({ code: '23505', constraint: 'requests_id8' });
    expect(queryOne).toHaveBeenCalledTimes(5);
  });

  it('is not tried again for any other refusal', async () => {
    vi.mocked(queryOne).mockRejectedValueOnce(refused('requests_pkey'));
    await expect(createRequest(input)).rejects.toMatchObject({ constraint: 'requests_pkey' });
    expect(queryOne).toHaveBeenCalledTimes(1);

    vi.mocked(queryOne).mockRejectedValueOnce(new Error('connection terminated'));
    await expect(createRequest(input)).rejects.toThrow('connection terminated');
    expect(queryOne).toHaveBeenCalledTimes(2);
  });
});

describe('the queue of requests waiting for intake', () => {
  it('is read oldest first', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ ...row('a'), state: 'queued' }]);

    expect(await listQueued()).toMatchObject([{ id: 'a', state: 'queued' }]);
    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toMatch(/where state = 'queued' order by created_at, id/);
  });

  it('gives a request to one taker only, in one statement', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...row('a'), state: 'draft' }).mockResolvedValueOnce(null);

    expect(await claimQueued('a')).toMatchObject({ id: 'a', state: 'draft' });
    expect(await claimQueued('a')).toBeNull();
    expect(String(vi.mocked(queryOne).mock.calls[0]?.[0])).toMatch(/where id = \$1 and state = 'queued'/);
  });

  it('takes back in line only a request whose triage ended without filing', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...row('a'), state: 'queued' });

    expect(await queueAgain('a')).toMatchObject({ state: 'queued' });
    expect(String(vi.mocked(queryOne).mock.calls.at(-1)?.[0])).toMatch(/where id = \$1 and state in \('queued', 'draft', 'questions'\)/);
  });

  it('counts a failed start as an attempt only when the request is what failed', async () => {
    vi.mocked(query).mockResolvedValue([]);

    await requeue('a', 'cannot work in fleetadlc-private');
    await requeue('a', 'hostd refused: hostd did not answer', { counts: false });
    await requeue('a');

    expect(vi.mocked(query).mock.calls.map((call) => call[1])).toEqual([
      ['a', 'cannot work in fleetadlc-private', true],
      ['a', 'hostd refused: hostd did not answer', false],
      ['a', null, false],
    ]);
  });

  it('puts back only a request its taker still holds as a draft', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);

    await requeue('a');

    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toMatch(/set state = 'queued'.*where id = \$1 and state = 'draft'/s);
  });
});

describe('a request filed', () => {
  it('keeps the repository it was filed in when it named none, and never replaces one it named', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...row('a4b02784-3ae8-450b-abe9-0c93eb4d67dc'), state: 'filed', issue_number: 7 });
    await updateRequest('a4b02784-3ae8-450b-abe9-0c93eb4d67dc', { state: 'filed', issueNumber: 7, repoId: 'repo-2' });
    const [sql, params] = vi.mocked(queryOne).mock.calls.at(-1)!;
    expect(String(sql)).toContain('repo_id = coalesce(repo_id, $4)');
    expect(params).toEqual(['a4b02784-3ae8-450b-abe9-0c93eb4d67dc', 'filed', 7, 'repo-2']);
  });
});
