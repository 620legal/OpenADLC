import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
}));

import { query, queryOne } from '../client.js';
import { anyDoneBefore, boardCards, boardIssues, byNextFirst, getIssue, getIssues, listBlockedIssues, listRoutableIssues, priorityRank, resolveDependency, setIssueLabels, unresolvedDependencies, setIssueStage, setShippedAt, setVouched, upsertIssue, workInFlight, type IssueRecord } from './issues.js';

/**
 * The order is a comparator rather than a `order by` clause so that it can be
 * asked here without a database. `listIssues` and `listRoutableIssues` sort
 * with this exact function, so what these tests exercise is what the board and
 * the dispatcher do — not a description of it.
 */
function issue(partial: Partial<IssueRecord> & { number: number }): IssueRecord {
  return {
    id: `id-${partial.number}`,
    repoId: 'repo',
    repoName: 'janedoe/OpenADLC',
    title: `issue ${partial.number}`,
    stage: 'build',
    labels: [],
    declaredPaths: [],
    prChangedPaths: [],
    body: '',
    url: null,
    prNumber: null,
    updatedAt: '2026-09-18T00:00:00.000Z',
    createdAt: '2026-09-18T00:00:00.000Z',
    ...partial,
  };
}

const refs = (list: IssueRecord[]): number[] => [...list].sort(byNextFirst).map((entry) => entry.number);

describe('the order the board and the dispatcher both read', () => {
  it('keeps a waiting p0 above a p3 that was just touched', () => {
    // The defect: the board ordered by `updated_at desc`, so commenting on a p3
    // put it on top of a p0 that had been waiting three days. Nothing about
    // being touched makes a card the one to pick up next.
    const p0 = issue({ number: 1, labels: ['priority:p0'], createdAt: '2026-09-15T09:00:00.000Z' });
    const p3 = issue({
      number: 2,
      labels: ['priority:p3'],
      createdAt: '2026-09-18T09:00:00.000Z',
      updatedAt: '2026-09-18T17:30:00.000Z',
    });

    expect(refs([p3, p0])).toEqual([1, 2]);
  });

  it('breaks a tie on priority by age, oldest first', () => {
    const older = issue({ number: 10, labels: ['priority:p1'], createdAt: '2026-09-10T09:00:00.000Z' });
    const newer = issue({ number: 11, labels: ['priority:p1'], createdAt: '2026-09-17T09:00:00.000Z' });

    expect(refs([newer, older])).toEqual([10, 11]);
  });

  it('sorts an issue with no priority label last, however old it is', () => {
    // Under the dispatcher's old clause, anything not p0/p1/p2 fell into the
    // same bottom rank, so an ancient untriaged issue outranked a p3 somebody
    // had actually looked at. "Nobody has prioritised this" is not a priority.
    const untriaged = issue({ number: 20, labels: [], createdAt: '2026-01-01T09:00:00.000Z' });
    const p3 = issue({ number: 21, labels: ['priority:p3'], createdAt: '2026-09-17T09:00:00.000Z' });

    expect(refs([untriaged, p3])).toEqual([21, 20]);
  });

  it('reads the highest priority label when an issue carries more than one', () => {
    // Relabelling on GitHub does not always remove the old label, and a card
    // that is both p0 and p2 is a p0 until somebody says otherwise.
    expect(priorityRank(['priority:p2', 'priority:p0'])).toBe(priorityRank(['priority:p0']));
  });

  it('returns the same order twice for issues filed in the same instant', () => {
    // Seeding and importing both write a batch inside one transaction, so equal
    // timestamps are ordinary. Without the last tiebreak the column reshuffles
    // between five-second polls for no reason a person can see.
    const a = issue({ number: 31, labels: ['priority:p2'] });
    const b = issue({ number: 30, labels: ['priority:p2'] });

    expect(refs([a, b])).toEqual([30, 31]);
    expect(refs([b, a])).toEqual([30, 31]);
  });
});

describe('what a builder may be given', () => {
  beforeEach(() => {
    vi.mocked(query).mockClear();
  });

  it('skips an issue labelled openadlc:ignore, as it skips needs-human, needs-triage and every do: label but do:ai', async () => {
    // Those three still enter the pipeline: a person owes something. openadlc:ignore
    // is the issue sitting untouched, and a builder was leased it because the
    // query never looked for the label.
    await listRoutableIssues('repo-1');

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/not \('needs-human' = any\(i\.labels\)\)/);
    expect(String(sql)).toMatch(/not \('needs-triage' = any\(i\.labels\)\)/);
    // do:product and do:legal wait on a person's decision as do:human does; a
    // builder was leased them because only do:human was looked for.
    expect(String(sql)).toMatch(/not exists \(select 1 from unnest\(i\.labels\) as l where l like 'do:%' and l <> 'do:ai'\)/);
    expect(String(sql)).toMatch(/not \('openadlc:ignore' = any\(i\.labels\)\)/);
    expect(params).toEqual(['repo-1']);
  });

  it('leaves an issue labelled openadlc:ignore out of the blocked issues the dispatcher unblocks', async () => {
    // Unblocking swaps blocked for start:now, so an ignored issue past spec
    // was made routable once what it waited for shipped.
    await listBlockedIssues('repo-1');

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/'blocked' = any\(i\.labels\)/);
    expect(String(sql)).toMatch(/not \('openadlc:ignore' = any\(i\.labels\)\)/);
    expect(params).toEqual(['repo-1']);
  });

  it('writes openadlc:ignore onto a row that is already there, and does not insert one', async () => {
    // Inserting would have to name a stage. Naming intake is what the sweep
    // then staffs, so the label would have been replaced by a stage.
    await setIssueLabels('repo-1', 4, ['openadlc:ignore']);

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/update issues set/);
    expect(String(sql)).not.toMatch(/insert into/i);
    expect(params).toEqual(['repo-1', 4, ['openadlc:ignore']]);
  });
});

describe('where the order is written down', () => {
  it('is nowhere but the comparator, so the two lists cannot disagree again', () => {
    // The board and the dispatcher disagreed because each query carried its own
    // `order by`. A new one would be a second answer to "what is next", and
    // whichever list kept it would drift away from the other silently.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'issues.ts'), 'utf8');

    expect(source).not.toMatch(/order\s+by/i);
  });
});

describe('work in flight', () => {
  it('counts a patch round on the issue’s pull request as its build, so the dispatcher leases it to nobody else', async () => {
    // Sent back from review, an issue is in build with its lease and its pull
    // request, and its patch round is filed under the pull request: read only
    // by the issue's own subject, it looked like build nobody had started.
    vi.mocked(query).mockResolvedValueOnce([{ number: 7, declared_paths: ['a.ts'], pr_changed_paths: ['b.ts'], building: true }]);
    expect(await workInFlight('repo-1')).toEqual([{ number: 7, paths: ['a.ts', 'b.ts'], building: true }]);
    const sql = String(vi.mocked(query).mock.calls.at(-1)?.[0]);
    expect(sql).toContain("t.kind = 'patch' and i.pr_number is not null and t.subject_ref = r.name || '#' || i.pr_number");
  });
});

describe('the text vouched for on a stranger’s issue', () => {
  const row = {
    id: 'i-1',
    repo_id: 'repo-1',
    repo_name: 'widgets',
    number: 40,
    title: 'Make the theme darker',
    stage: 'build',
    labels: ['adlc:build'],
    declared_paths: ['src/theme/**'],
    pr_changed_paths: [],
    body: 'Expected paths: src/theme/**',
    url: null,
    pr_number: null,
    updated_at: new Date('2026-10-01T10:00:00Z'),
    created_at: new Date('2026-10-01T09:00:00Z'),
  };

  beforeEach(() => {
    vi.mocked(query).mockClear();
    vi.mocked(queryOne).mockClear();
  });

  it('is kept with who vouched, and read back with the issue', async () => {
    await setVouched('repo-1', 40, { title: 'Make the theme darker', body: 'Expected paths: src/theme/**', by: 'janedoe' });
    const [sql, params] = vi.mocked(query).mock.calls.at(-1) ?? [];
    expect(String(sql)).toContain('set vouched_title = $3, vouched_body = $4, vouched_by = $5, vouched_at = now()');
    expect(params).toEqual(['repo-1', 40, 'Make the theme darker', 'Expected paths: src/theme/**', 'janedoe']);

    vi.mocked(query).mockResolvedValueOnce([
      { ...row, vouched_title: 'Make the theme darker', vouched_body: 'Expected paths: src/theme/**', vouched_by: 'janedoe', vouched_at: new Date('2026-10-01T10:00:00Z') },
    ] as never);
    expect((await getIssue('repo-1', 40))?.vouched).toEqual({
      title: 'Make the theme darker',
      body: 'Expected paths: src/theme/**',
      by: 'janedoe',
      at: '2026-10-01T10:00:00.000Z',
    });
  });

  it('is none on an issue nobody had to vouch for', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ ...row, vouched_title: null, vouched_body: null, vouched_by: null, vouched_at: null }] as never);
    expect((await getIssue('repo-1', 40))?.vouched).toBeNull();
  });

  it('is left as it is by an upsert, which names none of it', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(row as never);
    await upsertIssue({ repoId: 'repo-1', number: 40, title: 'Edited', stage: 'build', labels: [], declaredPaths: [], url: null, prNumber: null, body: 'Edited' });
    const [sql] = vi.mocked(queryOne).mock.calls.at(-1) ?? [];
    const writes = String(sql).slice(0, String(sql).indexOf('returning'));
    expect(writes).not.toContain('vouched');
  });
});

describe('boardCards', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('leaves out an issue labelled openadlc:ignore, and keeps it once the label is off', async () => {
    const one = (number: number, labels: string[]) => issue({ number, repoName: 'openadlc', labels });

    expect((await boardCards([one(1, ['adlc:build']), one(2, ['adlc:build', 'openadlc:ignore'])])).map((card) => card.ref)).toEqual(['openadlc#1']);
    expect((await boardCards([one(1, ['adlc:build']), one(2, ['adlc:build'])])).map((card) => card.ref).sort()).toEqual(['openadlc#1', 'openadlc#2']);
  });

  it('is the cards of the issues the board read, and reads no issue itself', async () => {
    // It read every issue there had ever been, beside the board's own read of them all.
    await boardCards([issue({ number: 1, repoName: 'openadlc' })]);
    expect(vi.mocked(query).mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes('from issues'))).toEqual([]);
  });
});

/**
 * The board's issues, from a database of three years of them: `query` here
 * answers the two selections `boardIssues` makes as Postgres would, each by
 * its own conditions, and refuses any other.
 */
describe('the issues the board reads', () => {
  const day = 86_400_000;
  const NOW = Date.parse('2026-10-22T12:00:00.000Z');
  const since = new Date(NOW - 7 * day);
  type Row = { id: string; repo_id: string; repo_name: string; number: number; title: string; stage: string; labels: string[]; declared_paths: string[]; pr_changed_paths: string[]; body: string; url: null; pr_number: null; updated_at: Date; created_at: Date };
  let table: Row[] = [];
  const put = (number: number, stage: string, updatedDaysAgo: number, repo = 'api') =>
    table.push({
      id: `i-${repo}-${number}`, repo_id: `repo-${repo}`, repo_name: repo, number, title: `#${number}`, stage, labels: [`adlc:${stage}`],
      declared_paths: [], pr_changed_paths: [], body: '', url: null, pr_number: null,
      updated_at: new Date(NOW - updatedDaysAgo * day), created_at: new Date(NOW - 1100 * day),
    });
  const LIVE = /^where i\.stage <> 'done' and \(\$2::text is null or r\.name = \$2\)$/;
  const WEEK = /^where i\.stage = 'done' and i\.updated_at >= \$1 and \(\$2::text is null or r\.name = \$2\)$/;

  beforeEach(() => {
    table = [];
    vi.mocked(query).mockReset();
    vi.mocked(query).mockImplementation((async (sql: string, params: unknown[]) => {
      const [from, repoName] = params as [Date, string | null];
      const arms = String(sql).split('union all').map((arm) => arm.replace(/\s+/g, ' ').trim());
      return arms.flatMap((arm) => {
        const where = arm.slice(arm.indexOf('where '));
        const inRepo = (row: Row) => repoName === null || row.repo_name === repoName;
        if (LIVE.test(where)) return table.filter((row) => row.stage !== 'done' && inRepo(row));
        if (WEEK.test(where)) return table.filter((row) => row.stage === 'done' && row.updated_at.getTime() >= from.getTime() && inRepo(row));
        throw new Error(`the fake database does not know: ${where}`);
      });
    }) as never);
  });

  it('is the issues not in Done and those Done in the week, never the history before it', async () => {
    // Three years of work shipped a day apart, nearly all of it long gone from Done.
    for (let number = 1; number <= 1100; number += 1) put(number, 'done', 1100 - number);
    put(2001, 'build', 40);
    put(2002, 'review', 1);
    put(2003, 'merged', 30);
    put(2004, 'intake', 0, 'web');

    const read = await boardIssues(since);
    const numbers = read.map((one) => one.number).sort((a, b) => a - b);
    // Done today and on each of the seven days before, the last at the week's first moment.
    expect(numbers).toEqual([1093, 1094, 1095, 1096, 1097, 1098, 1099, 1100, 2001, 2002, 2003, 2004]);
    expect(read).toHaveLength(12);
    // In the order the board and the dispatcher share.
    expect(read.map((one) => one.number)).toEqual([...read].sort(byNextFirst).map((one) => one.number));
    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual([since, null]);

    // A repository's board reads its own.
    expect((await boardIssues(since, 'web')).map((one) => one.number)).toEqual([2004]);
  });

  it('lets a card go when it leaves the week, and has an issue back when it is reopened', async () => {
    put(40, 'done', 6.9);
    expect((await boardIssues(since)).map((one) => one.number)).toEqual([40]);
    // A week and a little later: out of Done's week, and out of the read.
    expect((await boardIssues(new Date(since.getTime() + 0.2 * day))).map((one) => one.number)).toEqual([]);
    // Reopened a month on: out of Done, so read whatever its row last said of it.
    table[0]!.stage = 'build';
    table[0]!.updated_at = new Date(NOW - 30 * day);
    expect((await boardIssues(since)).map((one) => one.number)).toEqual([40]);
  });

  it('reads the issues of the items it shows by their rows, and none for none', async () => {
    vi.mocked(query).mockReset();
    expect(await getIssues([])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    await getIssues([{ repoId: 'repo-api', number: 4 }, { repoId: 'repo-web', number: 9 }]);
    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('join unnest($1::uuid[], $2::int[]) as t(repo_id, number) on t.repo_id = i.repo_id and t.number = i.number');
    expect(params).toEqual([['repo-api', 'repo-web'], [4, 9]]);
  });

  it('asks each repository, not every issue, whether it had a card go to Done before the week', async () => {
    vi.mocked(queryOne).mockReset();
    vi.mocked(queryOne).mockResolvedValueOnce({ done: true } as never);
    expect(await anyDoneBefore(since, 'api')).toBe(true);
    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    const text = String(sql).replace(/\s+/g, ' ');
    expect(text).toContain('select 1 from repos r where r.removed_at is null and ($2::text is null or r.name = $2) and exists (select 1 from issues i where i.repo_id = r.id');
    expect(text).toContain("i.stage = 'done' and i.updated_at < $1");
    expect(text).toContain("not ('openadlc:ignore' = any(i.labels))");
    expect(params).toEqual([since, 'api']);
    vi.mocked(queryOne).mockResolvedValueOnce({ done: false } as never);
    expect(await anyDoneBefore(since)).toBe(false);
    expect(vi.mocked(queryOne).mock.calls[1]?.[1]).toEqual([since, null]);
  });
});

describe('the issue a dependency names', () => {
  const OWN = { id: 'repo-b', fullName: 'owner/b' };
  const issueRow = (repoId: string, number: number) => ({
    id: `i-${number}`,
    repo_id: repoId,
    repo_name: repoId,
    number,
    title: 'x',
    stage: 'done',
    labels: [],
    declared_paths: [],
    pr_changed_paths: [],
    body: '',
    url: null,
    pr_number: null,
    updated_at: new Date('2026-10-01T10:00:00Z'),
    created_at: new Date('2026-10-01T09:00:00Z'),
  });
  const repoRow = { id: 'repo-a', name: 'a', full_name: 'owner/a', owner_bot_id: null, concurrency: 1, stage_modes: {}, spec_required_labels: [], human_review_paths: [], default_branch: 'main', color: 'blue', removed_at: null };

  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(queryOne).mockReset();
    vi.mocked(query).mockImplementation((async (sql: string, params: [string, number]) =>
      String(sql).includes('ignored_issues') ? [] : [issueRow(params[0], params[1])]) as never);
  });

  it('reads its own repository for #N, or its own full name in any case, without looking for another', async () => {
    expect(await resolveDependency(OWN, { repo: null, number: 3 })).toMatchObject({ managed: true, issue: { repoId: 'repo-b', number: 3 } });
    expect(await resolveDependency(OWN, { repo: 'Owner/B', number: 4 })).toMatchObject({ managed: true, issue: { repoId: 'repo-b', number: 4 } });
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('reads another managed repository by its full name', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(repoRow as never);
    expect(await resolveDependency(OWN, { repo: 'OWNER/a', number: 7 })).toMatchObject({ managed: true, issue: { repoId: 'repo-a', number: 7 } });
    const [sql, params] = vi.mocked(queryOne).mock.calls[0] ?? [];
    expect(String(sql)).toContain('lower(full_name) = lower($1)');
    expect(String(sql)).toContain('removed_at is null');
    expect(params).toEqual(['OWNER/a']);
  });

  it('is no issue in a repository the install does not manage, or has removed', async () => {
    // An issue waiting on work there would otherwise be read as waiting on nothing.
    vi.mocked(queryOne).mockResolvedValueOnce(null as never);
    expect(await resolveDependency(OWN, { repo: 'nobody/x', number: 1 })).toEqual({ managed: false, issue: null, ignored: null });
    expect(query).not.toHaveBeenCalled();
  });

  it('is no issue for a number the platform has never seen', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(repoRow as never);
    vi.mocked(query).mockResolvedValueOnce([] as never);
    expect(await resolveDependency(OWN, { repo: 'owner/a', number: 99 })).toEqual({ managed: true, issue: null, ignored: null });
  });

  it('carries the record of one labelled openadlc:ignore, from the repository it is in', async () => {
    // The rule reads it beside the row: an ignored issue has no row unless it
    // is in a later stage, and its close never moves one it has.
    vi.mocked(query).mockImplementation((async (sql: string, params: [string, number]) =>
      String(sql).includes('ignored_issues')
        ? [{ repo_id: params[0], number: params[1], state: 'closed', state_reason: 'completed', closed_at: new Date('2026-10-20T10:00:00Z') }]
        : []) as never);
    expect(await resolveDependency(OWN, { repo: null, number: 18 })).toEqual({
      managed: true,
      issue: null,
      ignored: { repoId: 'repo-b', number: 18, state: 'closed', stateReason: 'completed', closedAt: '2026-10-20T10:00:00.000Z' },
    });
  });
});

describe('the dependencies reconcile looks up', () => {
  const REPO = { id: 'repo-b', fullName: 'owner/b' };

  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  function answer(waiting: { body: string; full_name: string }[], known: number[], ignored: { number: number; state: string }[]) {
    vi.mocked(query).mockImplementation((async (sql: string) => {
      if (String(sql).includes('from ignored_issues')) return ignored;
      if (String(sql).includes('join repos')) return waiting;
      return known.map((number) => ({ number }));
    }) as never);
  }

  it('names only what has neither a row nor a closed record, in this repository', async () => {
    answer(
      [
        { body: '## Dependencies\n\n- #17\n- #18\n- #20\n- #21\n- owner/a#5', full_name: 'owner/b' },
        { body: '## Dependencies\n\n- owner/B#30\n- #17', full_name: 'owner/a' },
      ],
      [20],
      [{ number: 21, state: 'closed' }],
    );
    // #20 is on the board and #21 is recorded closed; owner/a#5 and owner/a's
    // own #17 are another repository's.
    expect(await unresolvedDependencies(REPO)).toEqual([17, 18, 30]);
    const [waitingSql] = vi.mocked(query).mock.calls.find(([sql]) => String(sql).includes('join repos')) ?? [];
    expect(String(waitingSql)).toContain("stage not in ('merged', 'done')");
    expect(String(waitingSql)).toContain('removed_at is null');
  });

  it('names one recorded ignored and still open, so its close is read even when no delivery said it', async () => {
    answer([{ body: '## Dependencies\n\n- #18', full_name: 'owner/b' }], [], [{ number: 18, state: 'open' }]);
    expect(await unresolvedDependencies(REPO)).toEqual([18]);
  });
});

/**
 * When a card shipped, where its move to Done says: a release's publish time
 * for a repository that ships by release. The board read it from the card's
 * last deploy task, else from when its row changed, which for a release the
 * deploy sweep found later is the sweep.
 */
describe('when a card in Done shipped', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(query).mockImplementation((async () => []) as never);
    vi.mocked(queryOne).mockReset();
  });

  it('is written only on a card in Done, without marking its row changed', async () => {
    const at = new Date('2026-10-20T09:00:00.000Z');
    await setShippedAt('repo-1', 12, at);
    const [sql, params] = vi.mocked(query).mock.calls[0]!;
    expect(sql).toContain('set shipped_at = $3');
    expect(sql).toContain("stage = 'done'");
    expect(sql).not.toContain('updated_at');
    expect(params).toEqual(['repo-1', 12, at]);
  });

  it('is read with the issue, and cleared when the card leaves Done', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      {
        id: 'i1',
        repo_id: 'repo-1',
        repo_name: 'openadlc',
        number: 12,
        title: 'A change',
        stage: 'done',
        labels: [],
        declared_paths: [],
        pr_changed_paths: [],
        body: '',
        url: null,
        pr_number: 40,
        updated_at: new Date('2026-10-22T09:00:00.000Z'),
        created_at: new Date('2026-10-01T09:00:00.000Z'),
        shipped_at: new Date('2026-10-20T09:00:00.000Z'),
      },
    ] as never);
    expect((await getIssue('repo-1', 12))?.shippedAt).toBe('2026-10-20T09:00:00.000Z');
    expect(String(vi.mocked(query).mock.calls[0]![0])).toContain('i.shipped_at');

    await setIssueStage('repo-1', 12, 'build');
    expect(String(vi.mocked(query).mock.calls[1]![0])).toContain("shipped_at = case when $3 = 'done' then shipped_at end");
    vi.mocked(queryOne).mockResolvedValueOnce(null);
    await upsertIssue({ repoId: 'repo-1', number: 12, title: 'A change', stage: 'review', labels: [], declaredPaths: [], url: null, prNumber: 40 }).catch(() => undefined);
    expect(String(vi.mocked(queryOne).mock.calls.at(-1)![0])).toContain("shipped_at = case when excluded.stage = 'done' then issues.shipped_at end");
  });
});
