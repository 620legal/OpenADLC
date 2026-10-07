import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client.js', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
}));

import { query, queryOne } from '../client.js';
import { boardCards, byNextFirst, getIssue, listBlockedIssues, listRoutableIssues, priorityRank, setIssueLabels, setVouched, upsertIssue, workInFlight, type IssueRecord } from './issues.js';

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
    repoName: 'janedoe/FleetADLC',
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

  it('skips an issue labelled fleetadlc:ignore, as it skips needs-human, needs-triage and every do: label but do:ai', async () => {
    // Those three still enter the pipeline: a person owes something. fleetadlc:ignore
    // is the issue sitting untouched, and a builder was leased it because the
    // query never looked for the label.
    await listRoutableIssues('repo-1');

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/not \('needs-human' = any\(i\.labels\)\)/);
    expect(String(sql)).toMatch(/not \('needs-triage' = any\(i\.labels\)\)/);
    // do:product and do:legal wait on a person's decision as do:human does; a
    // builder was leased them because only do:human was looked for.
    expect(String(sql)).toMatch(/not exists \(select 1 from unnest\(i\.labels\) as l where l like 'do:%' and l <> 'do:ai'\)/);
    expect(String(sql)).toMatch(/not \(i\.labels && array\['fleetadlc:ignore', 'fleet:ignore'\]::text\[\]\)/);
    expect(params).toEqual(['repo-1']);
  });

  it('leaves an issue labelled fleetadlc:ignore out of the blocked issues the dispatcher unblocks', async () => {
    // Unblocking swaps blocked for start:now, so an ignored issue past spec
    // was made routable once what it waited for shipped.
    await listBlockedIssues('repo-1');

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/'blocked' = any\(i\.labels\)/);
    expect(String(sql)).toMatch(/not \(i\.labels && array\['fleetadlc:ignore', 'fleet:ignore'\]::text\[\]\)/);
    expect(params).toEqual(['repo-1']);
  });

  it('writes fleetadlc:ignore onto a row that is already there, and does not insert one', async () => {
    // Inserting would have to name a stage. Naming intake is what the sweep
    // then staffs, so the label would have been replaced by a stage.
    await setIssueLabels('repo-1', 4, ['fleetadlc:ignore']);

    const [sql, params] = vi.mocked(query).mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/update issues set/);
    expect(String(sql)).not.toMatch(/insert into/i);
    expect(params).toEqual(['repo-1', 4, ['fleetadlc:ignore']]);
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

  it('leaves out an issue labelled fleetadlc:ignore, and keeps it once the label is off', async () => {
    const row = (number: number, labels: string[]) => ({
      id: `id-${number}`, repo_id: 'repo', repo_name: 'fleetadlc', number, title: `issue ${number}`, stage: 'build', labels,
      declared_paths: [], pr_changed_paths: [], body: '', url: null, pr_number: null,
      updated_at: new Date('2026-09-18T00:00:00Z'), created_at: new Date('2026-09-18T00:00:00Z'),
    });
    const read = (rows: ReturnType<typeof row>[]) =>
      vi.mocked(query).mockImplementation((async (sql: string) => (sql.includes('from issues i join repos') ? rows : [])) as never);

    read([row(1, ['adlc:build']), row(2, ['adlc:build', 'fleetadlc:ignore']), row(3, ['fleet:ignore'])]);
    expect((await boardCards()).map((card) => card.ref)).toEqual(['fleetadlc#1']);

    read([row(1, ['adlc:build']), row(2, ['adlc:build'])]);
    expect((await boardCards()).map((card) => card.ref).sort()).toEqual(['fleetadlc#1', 'fleetadlc#2']);
  });
});
