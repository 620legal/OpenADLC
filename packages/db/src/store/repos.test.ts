import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

import { query, queryOne } from '../client.js';
import { RepoNameTaken, addRepo, getProductionChoice, getRepoByName, listRepos, removeRepo, setDefaultBranch, setProductionChoice, updateRepoSettings, upsertRepo } from './repos.js';

function row(extra: Record<string, unknown> = {}) {
  return {
    id: 'repo-1',
    name: 'fleetadlc-testbed',
    full_name: 'janedoe/fleetadlc-testbed',
    owner_bot_id: 'id-builder',
    concurrency: 1,
    stage_modes: { merged: 'assist' },
    spec_required_labels: [],
    human_review_paths: [],
    default_branch: 'main',
    color: 'blue',
    removed_at: null,
    ...extra,
  };
}

const INPUT = {
  name: 'api',
  fullName: 'acme/api',
  ownerBotId: 'id-builder',
  concurrency: 1,
  stageModes: { merged: 'untouched' as const },
  specRequiredLabels: [],
  humanReviewPaths: [],
  defaultBranch: 'main',
};

/** What a statement sets, without the columns it returns. */
function setClause(sql: string): string {
  return sql.slice(0, sql.indexOf(' returning '));
}

/** Every statement sent, whitespace folded. */
function sent(): { sql: string; params: unknown[] }[] {
  return [...vi.mocked(query).mock.calls, ...vi.mocked(queryOne).mock.calls].map(([sql, params]) => ({
    sql: String(sql).replace(/\s+/g, ' ').trim(),
    params: (params ?? []) as unknown[],
  }));
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(queryOne).mockReset();
});

describe('reading repositories', () => {
  it('finds only the ones OpenADLC works in, unless asked for the removed ones too', async () => {
    vi.mocked(query).mockResolvedValue([row()]);
    await listRepos();
    await listRepos({ includeRemoved: true });
    const [active, all] = sent();
    expect(active!.sql).toContain('where removed_at is null');
    expect(all!.sql).not.toContain('removed_at is null');
  });

  it('reads a stage left in assist as autonomous, which is all it ever did', async () => {
    vi.mocked(query).mockResolvedValue([row({ stage_modes: { merged: 'assist', spec: 'conditional' } })]);
    const [repo] = await listRepos();
    expect(repo!.stageModes).toEqual({ merged: 'autonomous', spec: 'conditional' });
  });

  it('reads untouched on a stage other than intake or spec as autonomous, which is what the dispatcher did with it', async () => {
    vi.mocked(queryOne).mockResolvedValue(row({ stage_modes: { build: 'untouched', spec: 'untouched' } }));
    const repo = await getRepoByName('fleetadlc-testbed');
    expect(repo!.stageModes).toEqual({ build: 'autonomous', spec: 'untouched' });
  });

  it('by name, the same way', async () => {
    vi.mocked(queryOne).mockResolvedValue(null);
    await getRepoByName('fleetadlc-testbed');
    await getRepoByName('fleetadlc-testbed', { includeRemoved: true });
    const [active, all] = sent();
    expect(active!.sql).toContain('and removed_at is null');
    expect(all!.sql).not.toContain('removed_at is null');
  });

  it('carries the colour, and when it was removed', async () => {
    vi.mocked(query).mockResolvedValue([row({ color: 'teal', removed_at: new Date('2026-09-24T09:00:00Z') })]);
    const [repo] = await listRepos({ includeRemoved: true });
    expect(repo).toMatchObject({ color: 'teal', removedAt: '2026-09-24T09:00:00.000Z' });
  });
});

describe('adding a repository', () => {
  it('gives a new one the next colour nobody has, and the owner it was handed', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(null) // not known by its full name
      .mockResolvedValueOnce(null) // nor by its name
      .mockResolvedValueOnce(row({ id: 'repo-2', name: 'api', full_name: 'acme/api', color: 'pink' }));
    vi.mocked(query).mockResolvedValueOnce([{ color: 'blue' }, { color: 'amber' }]);

    const { repo, outcome } = await addRepo(INPUT);

    expect(outcome).toBe('added');
    expect(repo.color).toBe('pink');
    const insert = sent().find((one) => one.sql.startsWith('insert into repos'))!;
    expect(insert.params).toEqual(['api', 'acme/api', 'id-builder', 1, JSON.stringify({ merged: 'untouched' }), [], [], 'main', 'pink']);
    // Only the colours of repositories OpenADLC works in count: a removed one gave its colour back.
    expect(sent().find((one) => one.sql.startsWith('select color'))!.sql).toContain('where removed_at is null');
  });

  it('brings a removed one back as it was, with its settings and its colour', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(row({ removed_at: new Date('2026-09-20T00:00:00Z'), color: 'violet', concurrency: 2 }))
      .mockResolvedValueOnce(row({ color: 'violet', concurrency: 2 }));
    vi.mocked(query).mockResolvedValueOnce([{ color: 'blue' }, { color: 'amber' }]);

    const { repo, outcome } = await addRepo({ ...INPUT, name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed' });

    expect(outcome).toBe('restored');
    expect(repo).toMatchObject({ color: 'violet', concurrency: 2, removedAt: null });
    const update = sent().find((one) => one.sql.startsWith('update repos'))!;
    expect(update.sql).toContain('removed_at = null');
    // Its owner stays; the builder is only for a repository nobody owns.
    expect(update.sql).toContain('owner_bot_id = coalesce(owner_bot_id, $2)');
    expect(setClause(update.sql)).not.toMatch(/concurrency|stage_modes/);
    expect(update.params).toEqual(['repo-1', 'id-builder', 'violet', 'main']);
    expect(sent().some((one) => one.sql.startsWith('insert'))).toBe(false);
  });

  it('gives one coming back a colour of its own when another repository took its colour meanwhile', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(row({ removed_at: new Date('2026-09-20T00:00:00Z'), color: 'blue' }))
      .mockResolvedValueOnce(row({ color: 'pink' }));
    vi.mocked(query).mockResolvedValueOnce([{ color: 'blue' }, { color: 'amber' }]);

    await addRepo({ ...INPUT, name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed' });

    expect(sent().find((one) => one.sql.startsWith('update repos'))!.params).toEqual(['repo-1', 'id-builder', 'pink', 'main']);
  });

  it('leaves one already here as it is, rather than resetting its settings', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(row({ concurrency: 3 })).mockResolvedValueOnce(row({ concurrency: 3 }));
    const { outcome } = await addRepo({ ...INPUT, fullName: 'Janedoe/FleetADLC-Testbed' });
    expect(outcome).toBe('already');
    // GitHub's names are not case-sensitive, and neither is this.
    expect(sent()[0]!.sql).toContain('where lower(full_name) = lower($1)');
    expect(sent().some((one) => one.sql.startsWith('insert'))).toBe(false);
  });

  it('takes GitHub’s default branch for one already here, or keeps its own when GitHub was not asked', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(row({ concurrency: 3 })).mockResolvedValueOnce(row({ concurrency: 3, default_branch: 'master' }));
    const { repo } = await addRepo({ ...INPUT, fullName: 'janedoe/fleetadlc-testbed', defaultBranch: 'master' });
    const update = sent().find((one) => one.sql.startsWith('update repos'))!;
    expect(update.sql).toContain('default_branch = coalesce($4, default_branch)');
    expect(update.params.at(-1)).toBe('master');
    expect(setClause(update.sql)).not.toMatch(/concurrency|stage_modes/);
    expect(repo.defaultBranch).toBe('master');

    vi.mocked(queryOne).mockReset();
    vi.mocked(queryOne).mockResolvedValueOnce(row()).mockResolvedValueOnce(row());
    await addRepo({ ...INPUT, fullName: 'janedoe/fleetadlc-testbed', defaultBranch: null });
    expect(sent().find((one) => one.sql.startsWith('update repos'))!.params.at(-1)).toBeNull();
  });

  it('gives a new one `main` only when GitHub could not be asked', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(row({ name: 'api' }));
    vi.mocked(query).mockResolvedValueOnce([]);
    await addRepo({ ...INPUT, defaultBranch: null });
    expect(sent().find((one) => one.sql.startsWith('insert into repos'))!.params[7]).toBe('main');
  });

  it('refuses one whose name another repository already goes by, instead of overwriting it', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row({ name: 'api', full_name: 'janedoe/api' }));

    const refusal = await addRepo(INPUT).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(RepoNameTaken);
    expect((refusal as Error).message).toContain('janedoe/api');
    expect(sent().some((one) => /^(insert|update)/.test(one.sql))).toBe(false);
  });
});

describe('seeding a repository from config/repos.yaml', () => {
  /** The row as the database has it, and the statements sent at it, for a seed run after run. */
  function table(initial: ReturnType<typeof row> | null) {
    let stored = initial;
    // The colours in use, and the audit insert.
    vi.mocked(query).mockResolvedValue([]);
    vi.mocked(queryOne).mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
      const text = sql.replace(/\s+/g, ' ');
      if (/^ ?select .* from repos where name = \$1/.test(text)) return (stored && stored.name === params[0] ? stored : null) as never;
      if (text.trim().startsWith('insert into repos')) {
        stored = row({
          name: params[0], full_name: params[1], owner_bot_id: params[2], concurrency: params[3],
          stage_modes: JSON.parse(String(params[4])), spec_required_labels: params[5], human_review_paths: params[6],
          default_branch: params[7], color: params[8],
        });
        return stored as never;
      }
      if (text.trim().startsWith('update repos set full_name')) {
        stored = row({
          ...stored, full_name: params[1], owner_bot_id: params[2], concurrency: params[3],
          stage_modes: JSON.parse(String(params[4])), spec_required_labels: params[5], human_review_paths: params[6],
          default_branch: params[7],
        });
        return stored as never;
      }
      if (text.trim().startsWith('update repos set concurrency = coalesce')) {
        // The console's change: one stage, merged into the stored ones.
        const patch = params[2] ? JSON.parse(String(params[2])) : {};
        stored = row({ ...stored, stage_modes: { ...stored!.stage_modes, ...patch } });
        return stored as never;
      }
      return null as never;
    });
    return { now: () => stored };
  }

  const audited = () => sent().filter((one) => one.sql.startsWith('insert into audit'));
  const FILE = { name: 'api', fullName: 'acme/api', ownerBotId: 'id-builder' };

  it('gives a new row a colour and the defaults for what the file leaves out', async () => {
    const db = table(null);
    vi.mocked(query).mockResolvedValueOnce([{ color: 'blue' }]);
    const repo = await upsertRepo({ ...FILE, stageModes: { intake: 'untouched' } });
    expect(repo).toMatchObject({ concurrency: 1, defaultBranch: 'main', specRequiredLabels: expect.arrayContaining(['safety']) });
    expect(repo.stageModes).toMatchObject({ spec: 'conditional', intake: 'untouched' });
    expect(db.now()?.color).not.toBe('blue');
    expect(audited()).toEqual([]);
  });

  it('keeps a stage a person changed in the console when the file does not name stage modes', async () => {
    // Every setting was written at every start, with the schema's defaults for
    // those left out: a stage set to untouched went back to autonomous.
    const db = table(null);
    await upsertRepo(FILE);
    await updateRepoSettings('api', { stageModes: { intake: 'untouched' } });
    await upsertRepo(FILE);
    expect(db.now()?.stage_modes).toMatchObject({ intake: 'untouched' });
    await upsertRepo({ ...FILE, concurrency: 3 });
    expect(db.now()?.stage_modes).toMatchObject({ intake: 'untouched' });
    expect(db.now()?.concurrency).toBe(3);
  });

  it('lets a setting the file writes win, and audits what it changed, with the seed as actor', async () => {
    table(row({ name: 'api', full_name: 'acme/api', concurrency: 1, stage_modes: { intake: 'untouched', spec: 'conditional' } }));
    await upsertRepo({ ...FILE, concurrency: 2, stageModes: { intake: 'autonomous' } });
    const [line] = audited();
    expect(audited()).toHaveLength(1);
    expect(line!.params.slice(0, 3)).toEqual(['fleetadlc seed', 'repo.seeded', 'acme/api']);
    const payload = JSON.parse(String(line!.params[3]));
    expect(payload.fields).toEqual(['concurrency', 'stageModes']);
    expect(payload.from.concurrency).toBe(1);
    expect(payload.to.stageModes).toMatchObject({ intake: 'autonomous', spec: 'conditional' });
  });

  it('writes nothing and audits nothing when the file changes nothing', async () => {
    table(row({ name: 'api', full_name: 'acme/api', concurrency: 2 }));
    await upsertRepo({ ...FILE, concurrency: 2 });
    expect(sent().some((one) => one.sql.startsWith('update repos'))).toBe(false);
    expect(audited()).toEqual([]);
  });

  it('refuses an entry whose name another repository has, and leaves that row as it is', async () => {
    // Matched by name alone, the seed rewrote janedoe/api, its issues and tasks
    // with it, into acme/api.
    const db = table(row({ name: 'api', full_name: 'janedoe/api', owner_bot_id: 'id-other' }));
    const refusal = await upsertRepo({ ...FILE, concurrency: 4 }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RepoNameTaken);
    expect((refusal as Error).message).toContain('janedoe/api');
    expect((refusal as Error).message).toContain('acme/api');
    expect(db.now()).toMatchObject({ full_name: 'janedoe/api', owner_bot_id: 'id-other', concurrency: 1 });
    expect(sent().some((one) => one.sql.startsWith('update repos') || one.sql.startsWith('insert into repos'))).toBe(false);
  });

  it('leaves an existing row’s colour and removal alone', async () => {
    table(row({ name: 'api', full_name: 'acme/api', color: 'amber' }));
    await upsertRepo({ ...FILE, concurrency: 5 });
    const update = sent().find((one) => one.sql.startsWith('update repos set full_name'))!;
    expect(setClause(update.sql)).not.toContain('color');
    expect(setClause(update.sql)).not.toContain('removed_at');
  });
});

describe('removing a repository', () => {
  it('marks when it stopped and deletes nothing', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(row({ removed_at: new Date('2026-09-24T10:00:00Z') }));
    const removed = await removeRepo('fleetadlc-testbed');
    expect(removed?.removedAt).toBe('2026-09-24T10:00:00.000Z');
    const [statement] = sent();
    expect(statement!.sql).toContain('removed_at = coalesce(removed_at, now())');
    expect(statement!.sql).not.toMatch(/\bdelete\b/);
  });

  it('is null for a repository there is no row for', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null);
    expect(await removeRepo('nothing')).toBeNull();
  });
});

describe('a repository’s settings', () => {
  it('change its colour, and only while OpenADLC works in it', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(row({ color: 'teal' }));
    const updated = await updateRepoSettings('fleetadlc-testbed', { color: 'teal' });
    expect(updated?.color).toBe('teal');
    const [statement] = sent();
    expect(statement!.sql).toContain('color = coalesce($4, color)');
    expect(statement!.sql).toContain('where name = $1 and removed_at is null');
    expect(statement!.params).toEqual(['fleetadlc-testbed', null, null, 'teal', null]);
  });

  it('change its default branch', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(row({ default_branch: 'develop' }));
    const updated = await updateRepoSettings('fleetadlc-testbed', { defaultBranch: 'develop' });
    expect(updated?.defaultBranch).toBe('develop');
    const [statement] = sent();
    expect(statement!.sql).toContain('default_branch = coalesce($5, default_branch)');
    expect(statement!.params).toEqual(['fleetadlc-testbed', null, null, null, 'develop']);
  });

  it('take the default branch GitHub reports, by full name, only while OpenADLC works in it', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(row({ default_branch: 'master' }));
    expect((await setDefaultBranch('Janedoe/FleetADLC-Testbed', 'master'))?.defaultBranch).toBe('master');
    const [statement] = sent();
    expect(statement!.sql).toContain('default_branch = $2');
    expect(statement!.sql).toContain('where lower(full_name) = lower($1) and removed_at is null');
    expect(statement!.params).toEqual(['Janedoe/FleetADLC-Testbed', 'master']);

    vi.mocked(queryOne).mockResolvedValueOnce(null);
    expect(await setDefaultBranch('acme/gone', 'main')).toBeNull();
  });

  it('merge the stages given into the stored ones, never replace the map', async () => {
    // The console sends the one stage a person changed; replacing the map
    // with it would drop every other stage's mode.
    vi.mocked(queryOne).mockResolvedValueOnce(row({ stage_modes: { merged: 'autonomous', spec: 'conditional' } }));
    await updateRepoSettings('fleetadlc-testbed', { stageModes: { spec: 'conditional' } });
    const [statement] = sent();
    expect(statement!.sql).toContain("stage_modes = coalesce(stage_modes, '{}'::jsonb) || coalesce($3::jsonb, '{}'::jsonb)");
    expect(statement!.params).toEqual(['fleetadlc-testbed', null, JSON.stringify({ spec: 'conditional' }), null, null]);
  });
});

describe('how a repository’s production ships', () => {
  it('reads the recorded choice, and none for a repository nobody asked', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ production_approval: 'reviewers', production_soak_minutes: 0, production_reviewers: ['janedoe'] });
    expect(await getProductionChoice('repo-1')).toEqual({ approval: 'reviewers', soakMinutes: 0, reviewers: ['janedoe'] });
    vi.mocked(queryOne).mockResolvedValueOnce({ production_approval: null, production_soak_minutes: null, production_reviewers: [] });
    expect(await getProductionChoice('repo-2')).toEqual({ approval: null, soakMinutes: null, reviewers: [] });
  });

  it('records all of it at once', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await setProductionChoice('repo-1', { approval: 'auto', soakMinutes: 30, reviewers: [] });
    expect(String(vi.mocked(query).mock.calls[0]![0])).toContain('production_approval = $2, production_soak_minutes = $3, production_reviewers = $4');
    expect(vi.mocked(query).mock.calls[0]![1]).toEqual(['repo-1', 'auto', 30, []]);
  });
});
