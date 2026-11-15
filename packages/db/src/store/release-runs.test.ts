import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

import { query, queryOne } from '../client.js';
import { HOST_CHECK_LOG_TAIL_BYTES, HOST_CHECK_REASON_CHARS } from './host-check-runs.js';
import {
  RELEASE_IN_FLIGHT,
  ReleaseAlreadyRunning,
  anyInFlight,
  anyRunning,
  builtUnheld,
  finish,
  get,
  markTagged,
  publishFailed,
  published,
  publishingUnheld,
  running,
  setReleaseId,
  start,
  toPublishing,
} from './release-runs.js';

const SHA = 'a'.repeat(40);
const ID = '0b6f1d1c-6c55-4c1c-9a59-1f4a4b8f2a10';
const TOKEN = `ghp_${'x'.repeat(36)}`;

const ROW = {
  id: ID,
  run_id: 'run-1',
  repo_id: 'repo-1',
  repo_name: 'app',
  repo_full_name: 'acme/app',
  sha: SHA,
  clean: false,
  command: 'make release',
  artifact: 'build/App.zip',
  version_file: 'VERSION',
  version_key: null,
  release_repo: null,
  timeout_minutes: 180,
  previous_version: '1.3.0',
  state: 'running',
  version: null,
  sha256: null,
  bytes: null,
  artifact_name: null,
  exit_code: null,
  duration_ms: null,
  log_tail: null,
  reason: null,
  requested_by_login: 'ana',
  requested_by_id: '42',
  started_at: new Date('2026-11-15T10:00:00.000Z'),
  finished_at: null,
};

const START = {
  runId: 'run-1',
  repoId: 'repo-1',
  sha: SHA,
  clean: false,
  command: 'make release',
  artifact: 'build/App.zip',
  versionFile: 'VERSION',
  versionKey: null,
  releaseRepo: null,
  timeoutMinutes: 180,
  previousVersion: '1.3.0',
  requestedByLogin: 'ana',
  requestedById: 42,
};

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
});

describe('a release run, as the bridge records it', () => {
  it('is started once per run id, with the pinned sha and who asked', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    vi.mocked(queryOne).mockResolvedValueOnce(ROW);
    const run = await start(START);
    expect(run).toMatchObject({ id: ID, sha: SHA, state: 'running', requestedByLogin: 'ana', requestedById: 42, previousVersion: '1.3.0' });
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/on conflict \(run_id\) do nothing/);
    expect((params as unknown[]).slice(0, 3)).toEqual(['run-1', 'repo-1', SHA]);
  });

  it('says a second running release of a repository is refused by the database', async () => {
    vi.mocked(query).mockRejectedValueOnce(Object.assign(new Error('duplicate key value violates unique constraint "release_runs_one_running"'), { code: '23505', constraint: 'release_runs_one_running' }));
    await expect(start({ ...START, runId: 'run-2' })).rejects.toBeInstanceOf(ReleaseAlreadyRunning);
  });

  it('passes any other error through', async () => {
    vi.mocked(query).mockRejectedValueOnce(Object.assign(new Error('duplicate run id'), { code: '23505', constraint: 'release_runs_run_id_key' }));
    await expect(start(START)).rejects.not.toBeInstanceOf(ReleaseAlreadyRunning);
  });

  it('redacts and caps the reason and log tail when it starts', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    vi.mocked(queryOne).mockResolvedValueOnce({ ...ROW, state: 'refused' });
    await start({ ...START, state: 'refused', reason: `${TOKEN} ${'r'.repeat(5_000)}`, logTail: `${'y'.repeat(HOST_CHECK_LOG_TAIL_BYTES)} ${TOKEN}` });
    const params = vi.mocked(query).mock.calls[0]?.[1] as unknown[];
    const reason = String(params[12]);
    const tail = String(params[13]);
    expect(reason).not.toContain(TOKEN);
    expect(reason.length).toBeLessThanOrEqual(HOST_CHECK_REASON_CHARS);
    expect(tail).not.toContain(TOKEN);
    expect(tail.length).toBeLessThanOrEqual(HOST_CHECK_LOG_TAIL_BYTES);
  });

  it('finishes only a running row, so a report sent twice is written once', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce({ id: ID })
      .mockResolvedValueOnce({ ...ROW, state: 'built', version: '1.4.0', sha256: 'b'.repeat(64), bytes: '1234', artifact_name: 'App.zip' });
    const first = await finish('run-1', { state: 'built', version: '1.4.0', sha256: 'b'.repeat(64), bytes: 1234, artifactName: 'App.zip' });
    expect(first).toMatchObject({ state: 'built', version: '1.4.0', bytes: 1234, artifactName: 'App.zip' });
    expect(String(vi.mocked(queryOne).mock.calls[0]?.[0])).toMatch(/where run_id = \$1 and state = 'running'/);

    vi.mocked(queryOne).mockResolvedValueOnce(null);
    await expect(finish('run-1', { state: 'failed' })).resolves.toBeNull();
  });

  it('redacts and caps the reason and log tail when it finishes', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ id: ID }).mockResolvedValueOnce({ ...ROW, state: 'failed' });
    await finish('run-1', { state: 'failed', reason: `cat said ${TOKEN}\u0000`, logTail: `${'z'.repeat(HOST_CHECK_LOG_TAIL_BYTES + 10)} printed ${TOKEN}` });
    const params = vi.mocked(queryOne).mock.calls[0]?.[1] as unknown[];
    expect(String(params[8])).not.toContain(TOKEN);
    expect(String(params[8]).length).toBeLessThanOrEqual(HOST_CHECK_LOG_TAIL_BYTES);
    expect(String(params[9])).not.toContain(TOKEN);
    expect(String(params[9])).not.toContain('\u0000');
  });

  it('reads no row for an id that is not a uuid', async () => {
    await expect(get('nope')).resolves.toBeNull();
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('lists the running rows and answers whether a repository has one', async () => {
    vi.mocked(query).mockResolvedValueOnce([ROW]);
    expect((await running()).map((run) => run.runId)).toEqual(['run-1']);
    vi.mocked(queryOne).mockResolvedValueOnce({ any: true });
    await expect(anyRunning('repo-1')).resolves.toBe(true);
  });
});

describe('publishing a built release (#344)', () => {
  it('says a second release in flight is refused by the new index too', async () => {
    vi.mocked(query).mockRejectedValueOnce(
      Object.assign(new Error('duplicate key value violates unique constraint "release_runs_one_in_flight"'), { code: '23505', constraint: 'release_runs_one_in_flight' }),
    );
    await expect(start({ ...START, runId: 'run-2' })).rejects.toBeInstanceOf(ReleaseAlreadyRunning);
  });

  it('reads the publish columns', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      ...ROW,
      state: 'published',
      tag: 'v1.4.0',
      release_id: '991',
      release_url: 'https://github.com/acme/app/releases/tag/v1.4.0',
      asset_url: 'https://github.com/acme/app/releases/download/v1.4.0/App.zip',
      tagged: true,
      published_at: new Date('2026-11-15T11:00:00.000Z'),
    });
    await expect(get(ID)).resolves.toMatchObject({ state: 'published', tag: 'v1.4.0', releaseId: 991, tagged: true, publishedAt: '2026-11-15T11:00:00.000Z' });
    vi.mocked(queryOne).mockResolvedValueOnce(ROW);
    await expect(get(ID)).resolves.toMatchObject({ tag: null, releaseId: null, tagged: false, publishedAt: null });
  });

  it.each([
    ['toPublishing', () => toPublishing('run-1', 'v1.4.0'), "state = 'built'"],
    ['setReleaseId', () => setReleaseId('run-1', 991), "state = 'publishing'"],
    ['markTagged', () => markTagged('run-1'), "state = 'publishing'"],
    ['published', () => published('run-1', { releaseUrl: 'u', assetUrl: 'a' }), "state = 'publishing'"],
    ['publishFailed', () => publishFailed('run-1', 'why'), "state in ('built', 'publishing')"],
  ] as const)('%s moves only from the state it expects, and changes nothing from another', async (_name, call, from) => {
    vi.mocked(queryOne).mockResolvedValueOnce(null);
    await expect(call()).resolves.toBeNull();
    const sql = String(vi.mocked(queryOne).mock.calls[0]?.[0]);
    expect(sql).toContain(`where run_id = $1 and ${from}`);
    expect(queryOne).toHaveBeenCalledTimes(1);
  });

  it('answers the row it moved', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ id: ID }).mockResolvedValueOnce({ ...ROW, state: 'publishing', tag: 'v1.4.0' });
    await expect(toPublishing('run-1', 'v1.4.0')).resolves.toMatchObject({ state: 'publishing', tag: 'v1.4.0' });
  });

  it('redacts and caps a publish failure’s reason', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ id: ID }).mockResolvedValueOnce({ ...ROW, state: 'publish_failed' });
    await publishFailed('run-1', `GitHub said ${TOKEN} ${'r'.repeat(5_000)}`);
    const reason = String((vi.mocked(queryOne).mock.calls[0]?.[1] as unknown[])[1]);
    expect(reason).not.toContain(TOKEN);
    expect(reason.length).toBeLessThanOrEqual(HOST_CHECK_REASON_CHARS);
  });

  it('lists built and publishing rows no publisher here holds, and answers whether one is in flight', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ ...ROW, state: 'built' }]).mockResolvedValueOnce([]);
    expect((await builtUnheld(['run-9'])).map((run) => run.runId)).toEqual(['run-1']);
    await publishingUnheld();
    expect(String(vi.mocked(query).mock.calls[0]?.[0])).toContain("x.state = 'built' and not (x.run_id = any($1::text[]))");
    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual([['run-9']]);
    expect(String(vi.mocked(query).mock.calls[1]?.[0])).toContain("x.state = 'publishing'");
    vi.mocked(queryOne).mockResolvedValueOnce({ any: true });
    await expect(anyInFlight('repo-1')).resolves.toBe(true);
    expect(vi.mocked(queryOne).mock.calls.at(-1)?.[1]).toEqual(['repo-1', ['running', 'built', 'publishing']]);
    expect(RELEASE_IN_FLIGHT).toEqual(['running', 'built', 'publishing']);
  });
});

describe('0170, publishing', () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', '0170_release_publish.sql'), 'utf8')
    .replace(/--.*$/gm, '')
    .replace(/\s+/g, ' ');

  it('holds one release in flight per repository, building, built or publishing', () => {
    expect(sql).toContain('drop index if exists release_runs_one_running;');
    expect(sql).toMatch(/create unique index if not exists release_runs_one_in_flight on release_runs \(repo_id\) where state in \('running', 'built', 'publishing'\)/);
  });

  it('widens the state check with the three publish states and adds only nullable or defaulted columns', () => {
    expect(sql).toMatch(/check \(state in \('running', 'built', 'failed', 'cancelled', 'refused', 'lost', 'publishing', 'published', 'publish_failed'\)\)/);
    expect(sql).toContain('add column if not exists tagged boolean not null default false;');
    expect(sql).toContain('alter table repos add column if not exists release_manifest_asset text;');
  });
});

describe('0169, the release recipe and runs', () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', '0169_release_runs.sql'), 'utf8')
    .replace(/--.*$/gm, '')
    .replace(/\s+/g, ' ');

  it('holds one running release per repository with a partial unique index', () => {
    expect(sql).toMatch(/create unique index if not exists release_runs_one_running on release_runs \(repo_id\) where state = 'running'/);
  });

  it('keeps the pinned sha as 40 hex characters, and who asked', () => {
    expect(sql).toMatch(/sha text not null check \(sha ~ '\^\[0-9a-f\]\{40\}\$'\)/);
    expect(sql).toMatch(/requested_by_login text not null/);
    expect(sql).toMatch(/requested_by_id bigint not null/);
  });

  it('limits the time limit to 1 to 1440 minutes, and adds only nullable recipe columns', () => {
    expect(sql).toMatch(/check \(release_timeout_minutes between 1 and 1440\)/);
    for (const column of ['release_command', 'release_artifact', 'release_version_file', 'release_version_key', 'release_repo']) {
      expect(sql).toContain(`add column if not exists ${column} text;`);
    }
  });
});
