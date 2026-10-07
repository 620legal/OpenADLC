import { describe, expect, it } from 'vitest';
import { boardWork } from './board-work.js';
import {
  ignoredSubjects,
  shownIssues,
  cardWork,
  issueForSubject,
  issuesMergedBy,
  ownIssueOf,
  reviewRound,
  scopeLabelAcceptedFrom,
  standingStalls,
  taskSummary,
  type IssueFacts,
  type TaskFacts,
} from './work.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

function issue(partial: Partial<IssueFacts> & Pick<IssueFacts, 'number' | 'stage'>): IssueFacts {
  return {
    repoId: 'repo-1',
    repoName: 'fleetadlc',
    title: `Issue ${partial.number}`,
    url: null,
    prNumber: null,
    labels: [],
    updatedAt: minutesAgo(30),
    ...partial,
  };
}

let count = 0;
function task(partial: Partial<TaskFacts> & Pick<TaskFacts, 'kind' | 'subjectRef' | 'state'>): TaskFacts {
  count += 1;
  return {
    id: `task-${count}`,
    botId: 'bot-builder',
    repoId: 'repo-1',
    round: 0,
    costUsd: 0,
    startedAt: null,
    endedAt: null,
    exitReason: null,
    createdAt: minutesAgo(60 - count),
    ...partial,
  };
}

const BOTS = [
  { id: 'bot-builder', name: 'fleetadlc-atlas-janedoe' },
  { id: 'bot-intake', name: 'ottoexampleco' },
  { id: 'bot-lead', name: 'noraexampleco' },
  { id: 'bot-second', name: 'irisexampleco' },
  { id: 'bot-sre', name: 'tessexampleco' },
];
const botName = (id: string): string => BOTS.find((bot) => bot.id === id)?.name ?? 'a bot';

describe('which issue a subject is about', () => {
  const issues = [issue({ number: 12, stage: 'review', prNumber: 31 }), issue({ number: 31, stage: 'build', repoName: 'other' })];

  it('is the issue itself, or the issue whose pull request it is', () => {
    expect(issueForSubject('fleetadlc#12', issues)?.number).toBe(12);
    expect(issueForSubject('fleetadlc#31', issues)?.number).toBe(12);
    expect(issueForSubject('other#31', issues)?.repoName).toBe('other');
    expect(issueForSubject('request:a4b02784', issues)).toBeNull();
    expect(issueForSubject('fleetadlc@3f2a1b0c', issues)).toBeNull();
  });
});

describe('the review round', () => {
  it('is the first, and one more for every fix', () => {
    expect(reviewRound([])).toBe(1);
    expect(reviewRound([{ kind: 'review' }, { kind: 'patch' }, { kind: 'review' }])).toBe(2);
  });

  it('does not count a conflict resolution, as the review loop’s limit does not', () => {
    expect(reviewRound([{ kind: 'patch', skill: 'resolve-conflict' }, { kind: 'patch', skill: null }])).toBe(2);
  });
});


describe('a review loop that stopped', () => {
  const stalled = { at: minutesAgo(40), payload: { repo: 'fleetadlc', pr: 31, issue: 12, rounds: 3 } };
  const issues = [issue({ number: 12, stage: 'review', prNumber: 31 })];

  it('stands, the newest stop per pull request', () => {
    const again = { at: minutesAgo(20), payload: { repo: 'fleetadlc', pr: 31, issue: 12, rounds: 4 } };
    const standing = standingStalls([stalled, again], issues, []);
    expect([...standing.keys()]).toEqual(['fleetadlc#31']);
    expect(standing.get('fleetadlc#31')?.rounds).toBe(4);
  });

  it('ends when anything is started on the pull request after it, or the issue leaves review', () => {
    const later = task({ kind: 'review', subjectRef: 'fleetadlc#31', state: 'running', createdAt: minutesAgo(10) });
    const earlier = task({ kind: 'patch', subjectRef: 'fleetadlc#31', state: 'done', createdAt: minutesAgo(50) });
    expect(standingStalls([stalled], issues, [earlier]).size).toBe(1);
    expect(standingStalls([stalled], issues, [later]).size).toBe(0);
    expect(standingStalls([stalled], [issue({ number: 12, stage: 'merged', prNumber: 31 })], []).size).toBe(0);
  });

  it('ignores an event it cannot read', () => {
    expect(standingStalls([{ at: minutesAgo(1), payload: { pr: 'x' } }], issues, []).size).toBe(0);
  });

  it('names the blocking seats a lead’s approval could not set aside, and none for a loop out of rounds', () => {
    const held = { at: minutesAgo(5), payload: { repo: 'fleetadlc', pr: 31, issue: 12, rounds: 0, heldBy: ['security-reviewer', 7] } };
    expect(standingStalls([held], issues, []).get('fleetadlc#31')?.heldBy).toEqual(['security-reviewer']);
    expect(standingStalls([stalled], issues, []).get('fleetadlc#31')?.heldBy).toEqual([]);
  });
});

describe('what a card says about the work on it', () => {
  const building = issue({ number: 16, stage: 'build' });

  it('adds up what the issue, its pull request and its request cost, and names who is on it now', () => {
    const inReview = issue({ number: 12, stage: 'review', prNumber: 31 });
    const tasks = [
      task({ kind: 'intake', subjectRef: 'request:a4b02784', state: 'done', costUsd: 0.12 }),
      task({ kind: 'implement', subjectRef: 'fleetadlc#12', state: 'done', costUsd: 0.84, endedAt: minutesAgo(30) }),
      task({ kind: 'review', subjectRef: 'fleetadlc#31', state: 'done', costUsd: 0.2, botId: 'bot-lead', endedAt: minutesAgo(20) }),
      task({ kind: 'patch', subjectRef: 'fleetadlc#31', state: 'done', costUsd: 0.3, round: 1, endedAt: minutesAgo(15) }),
      task({ kind: 'review', subjectRef: 'fleetadlc#31', state: 'running', costUsd: 0.05, botId: 'bot-second', startedAt: minutesAgo(6) }),
      task({ kind: 'implement', subjectRef: 'fleetadlc#99', state: 'running', costUsd: 5 }),
    ];

    const work = cardWork(inReview, {
      tasks,
      botName,
      stalls: new Map(),
      requestSubjects: ['request:a4b02784'],
    });

    expect(work.costUsd).toBe(1.51);
    expect(work.active).toEqual([
      { bot: 'irisexampleco', kind: 'review', state: 'running', round: 0, startedAt: minutesAgo(6), endedAt: null, exitReason: null },
    ]);
    expect(work.last?.kind).toBe('patch');
    expect(work.reviewRound).toBe(2);
    expect(work.stalledAfterRounds).toBeNull();
    expect(work.shippedAt).toBeNull();
  });

  it('has no review round before there is a pull request', () => {
    expect(cardWork(building, { tasks: [], botName, stalls: new Map() }).reviewRound).toBeNull();
  });

  it('says when the review loop stopped', () => {
    const inReview = issue({ number: 12, stage: 'review', prNumber: 31 });
    const stall = { repo: 'fleetadlc', pr: 31, issue: 12, rounds: 3, botId: null, bot: null, heldBy: [], reason: null, at: minutesAgo(10) };
    expect(
      cardWork(inReview, { tasks: [], botName, stalls: new Map([['fleetadlc#31', stall]]) })
        .stalledAfterRounds,
    ).toBe(3);
  });

  it('says a reviewer’s review failed, even after another reviewer finished, until that reviewer reviews again', () => {
    const inReview = issue({ number: 1, stage: 'review', prNumber: 2 });
    const failed = task({ kind: 'review', subjectRef: 'fleetadlc#2', state: 'failed', botId: 'bot-second', endedAt: minutesAgo(12) });
    const finished = task({ kind: 'review', subjectRef: 'fleetadlc#2', state: 'done', botId: 'bot-lead', endedAt: minutesAgo(5) });
    const reviewFailed = (tasks: TaskFacts[], card = inReview) =>
      cardWork(card, { tasks, botName, stalls: new Map() }).reviewFailed;

    // The card read "Waiting for the reviewers" here: its newest task was the one that finished.
    expect(reviewFailed([failed, finished])).toBe(true);
    const again = task({ kind: 'review', subjectRef: 'fleetadlc#2', state: 'running', botId: 'bot-second', startedAt: minutesAgo(1) });
    expect(reviewFailed([failed, finished, again])).toBe(false);
    // Not a review card any more: whatever failed holds nothing up.
    expect(reviewFailed([failed, finished], issue({ number: 1, stage: 'merged', prNumber: 2 }))).toBe(false);
  });

  it('says when a finished card shipped: its last deploy, or when it last changed', () => {
    const done = issue({ number: 10, stage: 'done', prNumber: 30, updatedAt: minutesAgo(5) });
    const deployed = task({ kind: 'deploy', subjectRef: 'fleetadlc#30', state: 'done', endedAt: minutesAgo(120) });
    expect(cardWork(done, { tasks: [deployed], botName, stalls: new Map() }).shippedAt).toBe(
      minutesAgo(120),
    );
    expect(cardWork(done, { tasks: [], botName, stalls: new Map() }).shippedAt).toBe(minutesAgo(5));
  });

  it('names what a blocked card waits on, from its Dependencies', () => {
    const blocked = issue({
      number: 3,
      stage: 'build',
      labels: ['adlc:build', 'blocked'],
      body: '### Outcome\n\nA second page.\n\n### Dependencies\n\n- #1\n\n### Priority\n\np1',
    });
    expect(cardWork(blocked, { tasks: [], botName, stalls: new Map() }).waitingOn).toEqual([1]);
    // Not blocked, nothing to wait on, whatever its body says.
    expect(cardWork({ ...blocked, labels: ['adlc:build'] }, { tasks: [], botName, stalls: new Map() }).waitingOn).toEqual([]);
  });
});

describe('the board’s work, read together', () => {
  it('marks a bot working, or waiting behind a question', () => {
    const issues = [issue({ number: 14, stage: 'merged', prNumber: 33 }), issue({ number: 16, stage: 'build' })];
    const asking = task({ kind: 'deploy', subjectRef: 'fleetadlc#33', state: 'paused', botId: 'bot-sre' });
    const writing = task({ kind: 'implement', subjectRef: 'fleetadlc#16', state: 'running', startedAt: minutesAgo(12) });

    const work = boardWork({
      issues,
      tasks: [asking, writing],
      bots: BOTS,
      repos: [{ id: 'repo-1', name: 'fleetadlc', stageModes: { merged: 'autonomous' } }],
      gates: [{ taskId: asking.id }],
      stallEvents: [],
      requests: [],
    });

    expect([...work.running]).toEqual(['bot-builder']);
    expect([...work.waiting]).toEqual(['bot-sre']);
    expect(work.byRef.get('fleetadlc#14')).toMatchObject({ assignees: ['tessexampleco'] });
    expect(work.byRef.get('fleetadlc#16')).toMatchObject({ assignees: ['fleetadlc-atlas-janedoe'] });
  });
});

describe('a request intake is working on', () => {
  // On the live install the Intake column said 0 while the intake bot asked three
  // questions and wrote up the snake game: the request was not an issue yet.
  const REQUEST = {
    id: '57796b82-0000-4000-8000-000000000000',
    repoId: 'repo-1',
    issueNumber: null,
    text: 'Add a keyboard-controlled snake game at snake.html\n\nLike the old Nokia one.',
    state: 'questions',
    createdAt: minutesAgo(8),
  };
  const read = (requests: (typeof REQUEST)[], tasks: TaskFacts[], gates: { taskId: string }[] = []) =>
    boardWork({
      issues: [],
      tasks,
      bots: BOTS,
      repos: [{ id: 'repo-1', name: 'fleetadlc-testbed', stageModes: {} }],
      gates,
      stallEvents: [],
      requests,
    }).requests;

  it('is a card in Intake, waiting on the person while its question is open', () => {
    const triage = task({ kind: 'intake', subjectRef: 'request:57796b82', state: 'paused', botId: 'bot-intake', costUsd: 0.41 });

    expect(read([REQUEST], [triage], [{ taskId: triage.id }])).toEqual([
      expect.objectContaining({
        ref: 'request:57796b82',
        repo: 'fleetadlc-testbed',
        title: 'Add a keyboard-controlled snake game at snake.html',
        stage: 'intake',
        request: true,
        gateOpen: true,
        assignees: ['ottoexampleco'],
        costUsd: 0.41,
        active: [expect.objectContaining({ bot: 'ottoexampleco', kind: 'intake', state: 'paused' })],
      }),
    ]);
  });

  it('is shown while it is being written up, and gone once it is filed, or when nothing is working on it', () => {
    const writing = task({ kind: 'intake', subjectRef: 'request:57796b82', state: 'running', botId: 'bot-intake' });
    const ended = task({ kind: 'intake', subjectRef: 'request:57796b82', state: 'failed', botId: 'bot-intake' });

    expect(read([{ ...REQUEST, state: 'draft' }], [writing]).map((card) => card.gateOpen)).toEqual([false]);
    // Filed, it is the issue's card now.
    expect(read([{ ...REQUEST, state: 'filed', issueNumber: 5 } as never], [writing])).toEqual([]);
    // Its triage ended without filing: the thread says why, not a card forever.
    expect(read([REQUEST], [ended])).toEqual([]);
  });
});

describe('a bot’s task, for the crew page', () => {
  it('names the issue a review is about, the round it is in out of how many, and what it has cost', () => {
    const reviewing = task({
      kind: 'review',
      subjectRef: 'fleetadlc#31',
      state: 'running',
      botId: 'bot-second',
      startedAt: minutesAgo(6),
      costUsd: 0.38,
    });
    const summary = taskSummary(reviewing, {
      issues: [issue({ number: 12, stage: 'review', prNumber: 31, title: 'Record which model each review used' })],
      gated: new Set(),
      patches: [{ kind: 'patch' }],
      maxRounds: 3,
    });

    expect(summary).toEqual({
      kind: 'review',
      state: 'running',
      subjectRef: 'fleetadlc#31',
      repo: 'fleetadlc',
      issue: { repo: 'fleetadlc', number: 12, title: 'Record which model each review used' },
      startedAt: minutesAgo(6),
      endedAt: null,
      round: 2,
      maxRounds: 3,
      waitingOnYou: false,
      costUsd: 0.38,
    });
  });

  it('names the repository the work is in, a removed one as much as any, and none for work in none', () => {
    const repoNames = new Map([['repo-1', 'fleetadlc'], ['repo-old', 'old-api']]);
    // Its own repository first: a request filed for one says so nowhere in its subject.
    const triage = task({ kind: 'intake', subjectRef: 'request:a4b02784', state: 'running', repoId: 'repo-old' });
    expect(taskSummary(triage, { issues: [], gated: new Set(), repoNames }).repo).toBe('old-api');
    // Then the subject: an issue, or a deploy of a commit.
    const deploying = task({ kind: 'deploy', subjectRef: 'website@3f2c1a9', state: 'running', repoId: null });
    expect(taskSummary(deploying, { issues: [], gated: new Set() }).repo).toBe('website');
    const unnamed = task({ kind: 'intake', subjectRef: 'request:b5c13895', state: 'running', repoId: null });
    expect(taskSummary(unnamed, { issues: [], gated: new Set() }).repo).toBeNull();
  });

  it('gives a round limit only to work in the review loop', () => {
    const building = task({ kind: 'implement', subjectRef: 'fleetadlc#16', state: 'running', costUsd: 0.84 });
    const summary = taskSummary(building, { issues: [], gated: new Set(), maxRounds: 3 });
    expect(summary.maxRounds).toBeNull();
    expect(summary.costUsd).toBe(0.84);
  });

  it('says a paused task is waiting on a person only when a question is open', () => {
    const paused = task({ kind: 'intake', subjectRef: 'fleetadlc#15', state: 'paused' });
    expect(taskSummary(paused, { issues: [], gated: new Set([paused.id]) }).waitingOnYou).toBe(true);
    expect(taskSummary(paused, { issues: [], gated: new Set() }).waitingOnYou).toBe(false);
  });
});

describe('the issues a merged pull request finishes', () => {
  const PULL = { number: 12, branch: 'agent/fleetadlc-atlas-janedoe/5-issue-5', body: '', intoDefaultBranch: true, sameRepository: true };

  // Another tool's pull request said "Closes #N": GitHub closed the issue, and
  // the board kept it in Review, since only the branch was read.
  it('finds the issue a pull request closes when its branch names none', () => {
    expect(issuesMergedBy({ ...PULL, branch: 'cursor/no-testing-deploy-47b2', body: 'Closes #219', closing: [219] })).toEqual({ own: null, closes: [219] });
  });

  it('finds the issue its branch was cut for when its body closes none', () => {
    expect(issuesMergedBy({ ...PULL, closing: [] })).toEqual({ own: 5, closes: [] });
  });

  it('counts an issue named both ways once, as its own, and keeps every other one it closes', () => {
    expect(issuesMergedBy({ ...PULL, body: 'Closes #5. Fixes #6.', closing: [5, 6, 6] })).toEqual({ own: 5, closes: [6] });
  });

  it('takes GitHub’s list over the body: a sidebar link counts, and a keyword GitHub ignored does not', () => {
    expect(issuesMergedBy({ ...PULL, branch: 'feature/x', body: 'Closes #8', closing: [9] })).toEqual({ own: null, closes: [9] });
  });

  it('reads the body when GitHub’s list could not be read', () => {
    expect(issuesMergedBy({ ...PULL, branch: 'feature/x', body: 'Fixes #8 and resolves #9', closing: null })).toEqual({ own: null, closes: [8, 9] });
  });

  it('reads no keyword in the body of a pull request into another branch, as GitHub reads none', () => {
    expect(issuesMergedBy({ ...PULL, branch: 'feature/x', body: 'Fixes #8', intoDefaultBranch: false, closing: null })).toEqual({ own: null, closes: [] });
  });

  it('never names the pull request itself', () => {
    expect(issuesMergedBy({ ...PULL, branch: 'feature/x', body: 'Fixes #12, closes #8', closing: null })).toEqual({ own: null, closes: [8] });
  });

  // A fork's branch can be called anything, a builder's name included.
  it('takes no issue from the branch of a fork’s pull request, and still finishes the ones GitHub says it closes', () => {
    expect(issuesMergedBy({ ...PULL, branch: 'agent/x/12-fix', closing: [9], sameRepository: false })).toEqual({ own: null, closes: [9] });
  });
});

describe('the issue a pull request’s branch was cut for', () => {
  const pr = (repo: { full_name?: string } | null | undefined) => ({ head: { ref: 'agent/x/12-fix', repo } });

  it('is read from a branch in the repository itself, whatever the case of its name', () => {
    expect(ownIssueOf(pr({ full_name: 'JaneDoe/FleetADLC' }), 'janedoe/fleetadlc')).toBe(12);
  });

  it('is none for a fork’s branch, or one whose repository GitHub no longer names', () => {
    expect(ownIssueOf(pr({ full_name: 'stranger/fleetadlc' }), 'janedoe/fleetadlc')).toBeNull();
    expect(ownIssueOf(pr(null), 'janedoe/fleetadlc')).toBeNull();
    expect(ownIssueOf(pr(undefined), 'janedoe/fleetadlc')).toBeNull();
  });
});

describe('who may put scope:cross-cutting on', () => {
  const context = {
    crew: [{ githubLogin: 'exampleco-crew' }, { githubLogin: 'exampleco-review' }],
    automationLogin: 'exampleco-flow',
  };

  it('takes it from the app, the automation account and a person', () => {
    expect(scopeLabelAcceptedFrom({ login: 'fleetadlc-exampleco[bot]', viaApp: true }, context)).toBe(true);
    expect(scopeLabelAcceptedFrom({ login: 'exampleco-flow' }, context)).toBe(true);
    expect(scopeLabelAcceptedFrom({ login: 'janedoe' }, context)).toBe(true);
  });

  it('never takes it from a crew account, the builder whose work it would widen included', () => {
    expect(scopeLabelAcceptedFrom({ login: 'exampleco-crew' }, context)).toBe(false);
    expect(scopeLabelAcceptedFrom({ login: 'Exampleco-Review' }, context)).toBe(false);
    expect(scopeLabelAcceptedFrom({ login: null }, context)).toBe(false);
  });
});

describe('what the console leaves out', () => {
  const issue = (number: number, prNumber: number | null, labels: string[]) => ({ repoName: 'api', number, prNumber, labels });

  it('is every issue labelled fleetadlc:ignore (or fleet:ignore) and the pull request recorded on it, and nothing else', () => {
    const issues = [issue(1, 5, ['fleetadlc:ignore']), issue(2, null, ['fleet:ignore']), issue(3, 7, ['adlc:review'])];
    expect([...ignoredSubjects(issues)].sort()).toEqual(['api#1', 'api#2', 'api#5']);
    expect(shownIssues(issues).map((one) => one.number)).toEqual([3]);
  });
});
