import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transaction = vi.hoisted(() => ({ calls: [] as { text: string; params: unknown[] }[], claimed: true }));

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) =>
    fn({
      query: async (text: string, params: unknown[]) => {
        transaction.calls.push({ text, params });
        return { rows: text.startsWith('update discover_runs') && transaction.claimed ? [{ repo_id: 'repo-1' }] : [] };
      },
    }),
  ),
}));

import { query, queryOne } from '../client.js';
import { finish, latestDoneProposals, proposalsWithFingerprint, record, recordEmpty, removeRun, startRun } from './discover-proposals.js';

const RUN_ROW = {
  id: '0b6f1d1c-6c55-4c1c-9a59-1f4a4b8f2a10',
  repo_id: 'repo-1',
  task_id: null,
  lenses: ['improve'],
  state: 'running',
  commit_sha: null,
  proposal_count: 0,
  dropped_count: 0,
  note: null,
  reason: null,
  started_by: 'ana',
  created_at: new Date('2026-11-26T10:00:00.000Z'),
  ended_at: null,
};

const FINGERPRINT = 'f'.repeat(64);
const PROPOSAL = {
  lens: 'improve',
  key: 'finish-csv-export',
  fingerprint: FINGERPRINT,
  title: 'Finish the CSV export',
  description: 'The handler returns an empty file.',
  status: 'partial',
  evidence: [{ file: 'apps/web/src/export.ts', line: 12 }],
};

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
  transaction.calls = [];
  transaction.claimed = true;
});

describe('0173, Discover runs and their proposals', () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', '0173_discover_runs.sql'), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .toLowerCase();

  it('adds two tables, and changes nothing that exists', () => {
    expect(sql).toContain('create table if not exists discover_runs');
    expect(sql).toContain('create table if not exists discover_proposals');
    expect(sql).not.toMatch(/alter table|drop |update |delete from|insert into/);
  });

  it('holds one live run per repository, and takes a removed repository’s runs and proposals with it', () => {
    expect(sql).toContain("create unique index if not exists discover_runs_one_running on discover_runs (repo_id) where state = 'running'");
    expect(sql).toContain('repo_id uuid not null references repos(id) on delete cascade');
    expect(sql).toContain('run_id uuid not null references discover_runs(id) on delete cascade');
    expect(sql.match(/references repos\(id\) on delete cascade/g)).toHaveLength(2);
  });

  it('keeps one proposal per fingerprint in a run, and finds a fingerprint across a repository’s runs', () => {
    expect(sql).toContain('unique (run_id, fingerprint)');
    expect(sql).toContain('create index if not exists discover_proposals_seen on discover_proposals (repo_id, fingerprint)');
    expect(sql).toContain("check (fingerprint ~ '^[0-9a-f]{64}$')");
    expect(sql).toContain("check (status in ('missing', 'partial', 'already there'))");
  });
});

describe('starting a run', () => {
  it('records it running, by whom, with its lenses', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(RUN_ROW);
    const started = await startRun({ repoId: 'repo-1', lenses: ['improve'], startedBy: 'ana' });
    expect(started).toEqual({ run: expect.objectContaining({ id: RUN_ROW.id, state: 'running', lenses: ['improve'], taskId: null }) });
    expect(vi.mocked(queryOne).mock.calls[0]?.[1]).toEqual(['repo-1', ['improve'], 'ana']);
  });

  it('answers the live run when the repository has one: the index refuses a second', async () => {
    vi.mocked(queryOne)
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key value violates unique constraint "discover_runs_one_running"'), { code: '23505', constraint: 'discover_runs_one_running' }))
      .mockResolvedValueOnce({ ...RUN_ROW, id: 'live-run' });
    expect(await startRun({ repoId: 'repo-1', lenses: ['improve'], startedBy: 'ana' })).toEqual({ conflict: expect.objectContaining({ id: 'live-run' }) });
  });

  it('passes on any other failure', async () => {
    vi.mocked(queryOne).mockRejectedValueOnce(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }));
    await expect(startRun({ repoId: 'repo-1', lenses: ['improve'], startedBy: 'ana' })).rejects.toThrow('connection refused');
  });

  it('records an empty repository’s run done, with its note and no task', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ ...RUN_ROW, state: 'done', note: 'the default branch has no commits', ended_at: new Date() });
    const started = await recordEmpty({ repoId: 'repo-1', lenses: ['improve'], startedBy: 'ana', note: 'the default branch has no commits' });
    expect(started).toEqual({ run: expect.objectContaining({ state: 'done', note: 'the default branch has no commits', taskId: null }) });
    expect(String(vi.mocked(queryOne).mock.calls[0]?.[0])).toContain("'done'");
  });
});

describe('recording a run’s proposals', () => {
  it('writes every proposal with its fingerprint, and the counts and commit, in one transaction', async () => {
    const stored = await record(RUN_ROW.id, { commit: 'a'.repeat(40), proposals: [PROPOSAL, { ...PROPOSAL, key: 'other', fingerprint: 'e'.repeat(64) }], dropped: 3, note: 'Looked at apps/web.' });
    expect(stored).toBe(true);
    const [claim, ...inserts] = transaction.calls;
    expect(claim?.text).toContain("state = 'running' and commit_sha is null");
    expect(claim?.params).toEqual([RUN_ROW.id, 'a'.repeat(40), 2, 3, 'Looked at apps/web.']);
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.params.slice(0, 5)).toEqual([RUN_ROW.id, 'repo-1', 'improve', 'finish-csv-export', FINGERPRINT]);
    expect(JSON.parse(inserts[0]?.params[8] as string)).toEqual(PROPOSAL.evidence);
  });

  it('writes nothing for a run that has ended or already recorded its result', async () => {
    transaction.claimed = false;
    expect(await record(RUN_ROW.id, { commit: 'a'.repeat(40), proposals: [PROPOSAL], dropped: 0, note: null })).toBe(false);
    expect(transaction.calls).toHaveLength(1);
  });
});

describe('reading proposals back', () => {
  it('finds the same fingerprint in two runs of one repository, one row each', async () => {
    const row = (runId: string) => ({ ...PROPOSAL, id: `p-${runId}`, run_id: runId, repo_id: 'repo-1', created_at: new Date('2026-11-26T10:00:00.000Z') });
    vi.mocked(query).mockResolvedValueOnce([row('run-2'), row('run-1')]);
    const seen = await proposalsWithFingerprint('repo-1', FINGERPRINT);
    expect(seen.map((one) => one.runId)).toEqual(['run-2', 'run-1']);
    expect(vi.mocked(query).mock.calls[0]?.[0]).toContain('where repo_id = $1 and fingerprint = $2');
  });

  it('gives the next run the last done run’s proposals, and no failed run’s', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await latestDoneProposals('repo-1', 100);
    expect(vi.mocked(query).mock.calls[0]?.[0]).toContain("state = 'done' and commit_sha is not null");
    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual(['repo-1', 100]);
  });
});

describe('ending a run', () => {
  it('ends only a running run, once', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null);
    expect(await finish(RUN_ROW.id, 'failed', 'the engine stopped')).toBeNull();
    expect(vi.mocked(queryOne).mock.calls[0]?.[0]).toContain("where id = $1 and state = 'running'");
  });

  it('removes only a run whose start never became a task', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await removeRun(RUN_ROW.id);
    expect(vi.mocked(query).mock.calls[0]?.[0]).toContain('task_id is null');
  });
});
