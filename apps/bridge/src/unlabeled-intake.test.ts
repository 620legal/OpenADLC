import { describe, expect, it, vi } from 'vitest';
import { UnlabeledIntake, openIssuesOn, type UnlabeledIntakeDeps, type UnlabeledIssue } from './unlabeled-intake.js';

const REPOS = [
  { id: 'repo-1', name: 'testbed', fullName: 'exampleco/testbed' },
  { id: 'repo-2', name: 'other', fullName: 'exampleco/other' },
];

function issue(number: number, over: Partial<UnlabeledIssue> = {}): UnlabeledIssue {
  return { number, title: `#${number}`, body: 'a body', htmlUrl: `https://github.com/x/${number}`, labels: [], pullRequest: false, author: 'janedoe', association: 'OWNER', ...over };
}

function sweep(over: Partial<UnlabeledIntakeDeps> = {}, open: Record<string, UnlabeledIssue[]> = {}) {
  const learned: string[] = [];
  const deps: UnlabeledIntakeDeps = {
    repos: async () => REPOS,
    openIssues: async (fullName) => open[fullName] ?? [],
    actsFor: async (_repo, author) => author.association === 'OWNER',
    intakeGoingIn: async () => false,
    paused: () => null,
    intakePaused: async () => null,
    learn: vi.fn(async (repo, one) => void learned.push(`${repo.name}#${one.number}`)),
    ...over,
  };
  return { intake: new UnlabeledIntake(deps), learned };
}

describe('issues nobody labelled, sent to intake', () => {
  it('sends the oldest unlabeled issue in each repository, one at a time', async () => {
    // testbed's #3 and #7 were never looked at, and intake worked around them on every request.
    const { intake, learned } = sweep({}, {
      'exampleco/testbed': [issue(7), issue(3), issue(9, { labels: ['adlc:build'] })],
      'exampleco/other': [issue(2)],
    });

    const said = await intake.sweepOnce();

    expect(learned).toEqual(['testbed#3', 'other#2']);
    expect(said[0]).toContain('sent testbed#3 to intake');
  });

  it('leaves pull requests, ignored issues, staged ones and authors it does not act for', async () => {
    const { intake, learned } = sweep({}, {
      'exampleco/testbed': [
        issue(1, { pullRequest: true }),
        issue(2, { labels: ['fleetadlc:ignore'] }),
        issue(3, { labels: ['sdlc:intake'] }),
        issue(4, { author: 'stranger', association: 'NONE' }),
        issue(5),
      ],
    });

    await intake.sweepOnce();

    expect(learned).toEqual(['testbed#5']);
  });

  it('starts nothing in a repository while intake is already on one of its issues, or while work is paused', async () => {
    const open = { 'exampleco/testbed': [issue(3)], 'exampleco/other': [issue(2)] };
    const going = sweep({ intakeGoingIn: async (repo) => repo === 'testbed' }, open);
    await going.intake.sweepOnce();
    expect(going.learned).toEqual(['other#2']);

    const paused = sweep({ paused: (repo) => (repo === 'other' ? 'other is paused' : null) }, open);
    await paused.intake.sweepOnce();
    expect(paused.learned).toEqual(['testbed#3']);

    const seat = sweep({ intakePaused: async () => 'intake is paused by janedoe' }, open);
    await seat.intake.sweepOnce();
    expect(seat.learned).toEqual([]);
  });
});

describe('issues it will not take on its own', () => {
  it('writes them down for a person, every pass, even while intake is busy there', async () => {
    // testbed's #3 and #7 were filed by an old crew account with no access,
    // and were skipped without a word.
    const recorded: Record<string, number[]> = {};
    const { intake, learned } = sweep(
      {
        intakeGoingIn: async () => true,
        recordUnowned: async (repo, list) => {
          recorded[repo] = list.map((one) => one.number);
          return true;
        },
      },
      {
        'exampleco/testbed': [
          issue(7, { author: 'outside-author', association: 'NONE' }),
          issue(3, { author: 'outside-author', association: 'NONE' }),
          issue(5),
          issue(8, { labels: ['fleetadlc:ignore'], author: 'stranger', association: 'NONE' }),
        ],
      },
    );

    const said = await intake.sweepOnce();

    expect(recorded['testbed']).toEqual([3, 7]);
    expect(recorded.other).toEqual([]);
    expect(learned).toEqual([]);
    expect(said).toContain('testbed: #3, #7 not sent to intake: OpenADLC does not act for their authors; Needs you asks what to do');
  });
});

describe('the open issues the sweep reads', () => {
  it('are every page of them, so the oldest are seen in a repository with more than a hundred open', async () => {
    // Newest first, as GitHub lists them: #150 down to #1.
    const all = Array.from({ length: 150 }, (_, index) => 150 - index);
    const asked: { state?: string; page?: number }[] = [];
    const client = {
      listIssues: async (_repo: string, params: { state?: string; perPage?: number; page?: number } = {}) => {
        asked.push({ state: params.state, page: params.page });
        const start = ((params.page ?? 1) - 1) * (params.perPage ?? 50);
        return all.slice(start, start + (params.perPage ?? 50)).map((number) => ({
          number,
          title: `#${number}`,
          body: null,
          labels: [],
          htmlUrl: `https://github.com/exampleco/testbed/issues/${number}`,
          pullRequest: false,
          state: 'open' as const,
          createdAt: '2026-10-01T00:00:00Z',
          updatedAt: '2026-10-01T00:00:00Z',
          author: 'janedoe',
          association: 'OWNER',
        }));
      },
    };

    const open = await openIssuesOn(client, 'exampleco/testbed');

    expect(open).toHaveLength(150);
    expect(open.map((one) => one.number)).toContain(1);
    expect(asked).toEqual([{ state: 'open', page: 1 }, { state: 'open', page: 2 }]);
  });
});
