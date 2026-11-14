import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

import { query, queryOne } from '../client.js';
import { HOST_CHECK_LOG_TAIL_BYTES, byId, carry, finish, keptTail, passesFor, running, start } from './host-check-runs.js';

const HEAD = 'a'.repeat(40);
const ID = '0b6f1d1c-6c55-4c1c-9a59-1f4a4b8f2a10';

const ROW = {
  id: ID,
  run_id: 'run-1',
  repo_id: 'repo-1',
  repo_name: 'app',
  repo_full_name: 'acme/app',
  pr_number: 46,
  head_sha: HEAD,
  state: 'running',
  carried_from: null,
  command: 'make host-ci',
  timeout_minutes: 90,
  exit_code: null,
  duration_ms: null,
  log_tail: null,
  reason: null,
  started_at: new Date('2026-11-14T10:00:00.000Z'),
  finished_at: null,
};

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
});

describe('a host check run, as the bridge records it', () => {
  it('is started once per hostd run id: the same report or start again writes no second row', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    vi.mocked(queryOne).mockResolvedValueOnce(ROW);
    const run = await start({ runId: 'run-1', repoId: 'repo-1', prNumber: 46, headSha: HEAD, command: 'make host-ci', timeoutMinutes: 90 });
    expect(run).toMatchObject({ id: ID, runId: 'run-1', repoName: 'app', repoFullName: 'acme/app', state: 'running', command: 'make host-ci', timeoutMinutes: 90 });
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/on conflict \(run_id\) do nothing/);
    expect(params).toEqual(['run-1', 'repo-1', 46, HEAD, 'running', 'make host-ci', 90, null]);
  });

  it('finishes only a running row, so a report sent twice is written once', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ id: ID }).mockResolvedValueOnce({ ...ROW, state: 'passed', duration_ms: '2520000', exit_code: 0 });
    const first = await finish('run-1', { state: 'passed', exitCode: 0, durationMs: 2_520_000, logTail: 'ok' });
    expect(first).toMatchObject({ state: 'passed', durationMs: 2_520_000, exitCode: 0 });
    const [sql] = vi.mocked(queryOne).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/where run_id = \$1 and state = 'running'/);

    vi.mocked(queryOne).mockResolvedValueOnce(null);
    await expect(finish('run-1', { state: 'passed', exitCode: 0 })).resolves.toBeNull();
  });

  it('keeps the end of the log, without NUL and with credentials masked', async () => {
    const token = `ghp_${'x'.repeat(36)}`;
    const tail = keptTail(`${'y'.repeat(HOST_CHECK_LOG_TAIL_BYTES)}\u0000 printed ${token}`);
    expect(tail.length).toBeLessThanOrEqual(HOST_CHECK_LOG_TAIL_BYTES);
    expect(tail).not.toContain('\u0000');
    expect(tail).not.toContain(token);
    expect(tail.endsWith('printed ')).toBe(false);
  });

  it('answers the heads a run passed on, which is what the merge reads', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ head_sha: HEAD }, { head_sha: 'b'.repeat(40) }]);
    await expect(passesFor('repo-1', 46)).resolves.toEqual([HEAD, 'b'.repeat(40)]);
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/state = 'passed'/);
    expect(params).toEqual(['repo-1', 46]);
  });

  it('finds no row for an id that is not a uuid, rather than letting Postgres refuse it', async () => {
    await expect(byId('not-a-uuid')).resolves.toBeNull();
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('lists the running rows for the sweep', async () => {
    vi.mocked(query).mockResolvedValueOnce([ROW]);
    await expect(running()).resolves.toHaveLength(1);
    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toMatch(/h.state = 'running'/);
  });
});

describe('0168, the host check’s settings and runs', () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', '0168_host_check_runs.sql'), 'utf8')
    .replace(/--.*$/gm, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

  it('adds the setting to the repository row, with no command for every repository already there', () => {
    expect(sql).toContain('add column if not exists host_check_command text;');
    expect(sql).toContain('host_check_timeout_minutes int not null default 60');
    expect(sql).toContain('check (host_check_timeout_minutes between 1 and 1440)');
    expect(sql).toContain('host_check_required boolean not null default true');
  });

  it('keeps one row per hostd run, in one of the states the store knows', () => {
    expect(sql).toContain('run_id text unique not null');
    expect(sql).toContain("check (state in ('running', 'passed', 'failed', 'cancelled', 'refused', 'lost', 'carried'))");
  });

  it('says a carried pass apart from a run, so passesFor never answers one', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    vi.mocked(queryOne).mockResolvedValueOnce({ ...ROW, state: 'carried', carried_from: 'b'.repeat(40) });
    const carried = await carry({ repoId: 'repo-1', prNumber: 46, headSha: HEAD, from: 'b'.repeat(40), command: 'make host-ci', timeoutMinutes: 90 });
    expect(carried).toMatchObject({ state: 'carried', carriedFrom: 'b'.repeat(40) });
    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toContain("'carried'");
  });
});
