import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthRow } from '@fleetadlc/db';
import type { TaskFacts } from './work.js';

/**
 * "Needs you": everything waiting on a person, what happened, and what can be
 * done about it from the console.
 */

const NOW = new Date('2026-09-24T12:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 24 * 60 * 60_000).toISOString();

const BOTS = [
  { id: 'bot-intake', name: 'ottoexampleco', slot: 'intake', role: 'intake', githubLogin: 'ottoexampleco' },
  { id: 'bot-builder', name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement', githubLogin: 'fleetadlc-atlas-janedoe' },
  { id: 'bot-lead', name: 'lead-reviewer', slot: 'lead-reviewer', role: 'review_lead', githubLogin: null },
  { id: 'bot-second', name: 'irisexampleco', slot: 'second-reviewer', role: 'review_second', githubLogin: 'irisexampleco' },
  { id: 'bot-sre', name: 'tessexampleco', slot: 'sre', role: 'deploy', githubLogin: 'tessexampleco' },
];

const REPOS = [
  {
    id: 'repo-1',
    name: 'fleetadlc-testbed',
    fullName: 'janedoe/fleetadlc-testbed',
    stageModes: { intake: 'autonomous', spec: 'conditional', build: 'autonomous', review: 'autonomous', merged: 'autonomous', done: 'autonomous' },
  },
];

function issue(number: number, title: string, stage: string, prNumber: number | null = null) {
  return {
    repoId: 'repo-1',
    repoName: 'fleetadlc-testbed',
    number,
    title,
    stage: stage as never,
    url: `https://github.com/janedoe/fleetadlc-testbed/issues/${number}`,
    prNumber,
    labels: [],
    updatedAt: minutesAgo(5),
  };
}

const ISSUES = [
  issue(15, 'Show what a task has cost on its card', 'intake'),
  issue(14, 'Add a health endpoint to the API', 'merged', 31),
  issue(11, 'Rate-limit the webhook route', 'review', 29),
  issue(16, 'Let the board filter by label', 'build'),
];

let taskCount = 0;
function task(partial: Partial<TaskFacts> & Pick<TaskFacts, 'botId' | 'kind' | 'subjectRef' | 'state'>): TaskFacts {
  taskCount += 1;
  return {
    id: `task-${taskCount}`,
    repoId: 'repo-1',
    round: 0,
    costUsd: 0,
    startedAt: null,
    endedAt: null,
    exitReason: null,
    createdAt: minutesAgo(60),
    ...partial,
  };
}

/** A health check's row, as the store keeps it. */
function healthRow(partial: Partial<HealthRow> & Pick<HealthRow, 'id' | 'checkId' | 'state'>): HealthRow {
  return {
    subject: null,
    severity: partial.state === 'failing' ? 'blocking' : null,
    title: null,
    detail: null,
    action: null,
    facts: {},
    waitingFor: [],
    failingSince: partial.state === 'failing' ? minutesAgo(10) : null,
    checkedAt: NOW.toISOString(),
    notifiedAt: null,
    fixedAt: null,
    fixedTitle: null,
    fixedDismissedAt: null,
    ...partial,
  };
}

async function load() {
  return import('./attention.js');
}

describe('what needs a person', () => {
  it('says a bot’s question, offers its choices to answer it with, and something else in its thread', async () => {
    const { attentionItems } = await load();
    const asking = task({ id: 'task-q', botId: 'bot-intake', kind: 'intake', subjectRef: 'fleetadlc-testbed#15', state: 'paused' });

    const [item] = attentionItems({
      now: NOW,
      gates: [
        {
          id: 'gate-1',
          taskId: 'task-q',
          question: 'Should the cost include review rounds, or only the build?',
          options: ['include reviews', 'only the build'],
          githubCommentUrl: 'https://github.com/janedoe/fleetadlc-testbed/issues/15#issuecomment-1',
          createdAt: minutesAgo(2),
        },
      ],
      tasks: [asking],
      bots: BOTS,
      repos: REPOS,
      issues: ISSUES,
      requests: [],
      stallEvents: [],
    });

    expect(item).toMatchObject({
      id: 'gate:gate-1',
      kind: 'question',
      headline: 'The intake bot (ottoexampleco) has a question',
      subject: { repo: 'fleetadlc-testbed', number: 15, title: 'Show what a task has cost on its card', ref: 'fleetadlc-testbed#15', item: 'fleetadlc-testbed#15' },
      bot: { name: 'ottoexampleco', role: 'intake', roleLabel: 'intake' },
      since: minutesAgo(2),
      detail: 'Should the cost include review rounds, or only the build?',
    });
    expect(item?.question).toEqual({ gateId: 'gate-1', options: ['include reviews', 'only the build'] });
    expect(item?.actions).toEqual([
      { kind: 'answer', label: 'Something else…', bot: 'ottoexampleco' },
      { kind: 'open_url', label: 'On GitHub', url: 'https://github.com/janedoe/fleetadlc-testbed/issues/15#issuecomment-1' },
    ]);
  });

  it('says intake stopped trying an issue still in intake, and not once it has moved on', async () => {
    const { attentionItems } = await load();
    const input = {
      now: NOW,
      gates: [],
      tasks: [],
      bots: BOTS,
      repos: REPOS,
      issues: ISSUES,
      requests: [],
      stallEvents: [],
      intakeStalls: [
        { at: minutesAgo(5), payload: { subjectRef: 'fleetadlc-testbed#15', tries: 2 } },
        { at: minutesAgo(9), payload: { subjectRef: 'fleetadlc-testbed#16', tries: 2 } },
      ],
    };
    const stalled = attentionItems(input).filter((item) => item.id.startsWith('intake-stalled:'));

    // #16 has been moved on to build since; only #15, still in intake, waits.
    expect(stalled.map((item) => item.id)).toEqual(['intake-stalled:fleetadlc-testbed#15']);
    expect(stalled[0]).toMatchObject({ kind: 'triage_failed', group: 'work', headline: 'Intake could not shape fleetadlc-testbed#15' });
  });

  it('puts a pull request only a person can land in Needs you, with why and the way to merge it', async () => {
    const { attentionItems } = await load();
    const items = attentionItems({
      now: NOW,
      gates: [],
      tasks: [],
      bots: BOTS,
      repos: REPOS,
      issues: ISSUES,
      requests: [],
      stallEvents: [],
      heldMerges: [{ repo: 'fleetadlc-testbed', prNumber: 5, reason: 'it changes how CI runs (Makefile)', since: minutesAgo(2) }],
    });
    const item = items.find((one) => one.kind === 'merge_waiting');
    expect(item).toMatchObject({
      group: 'work',
      headline: 'Pull request #5 is ready, and waits for you to merge it',
      detail: 'Its reviews passed and CI is green. OpenADLC did not merge it, because it changes how CI runs (Makefile).',
      actions: [{ kind: 'open_url', label: 'Merge it on GitHub' }],
    });
  });

  it('asks a person about issues OpenADLC will not take on its own, one card per repository', async () => {
    // Filed by an old crew account with no access, they were skipped in silence.
    const { attentionItems } = await load();
    const items = attentionItems({
      now: NOW,
      gates: [],
      tasks: [],
      bots: BOTS,
      repos: REPOS,
      issues: ISSUES,
      requests: [],
      stallEvents: [],
      unowned: {
        'fleetadlc-testbed': [
          { number: 3, title: 'Add hello.mjs', url: 'u3', author: 'outside-author' },
          { number: 7, title: 'Add rub.html', url: 'u7', author: 'outside-author' },
        ],
        'gone-repo': [{ number: 1, title: 'x', url: 'u', author: 'y' }],
      },
    });
    const cards = items.filter((one) => one.kind === 'unowned_issues');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      group: 'work',
      headline: 'fleetadlc-testbed: 2 issues OpenADLC won’t take on its own',
      actions: [
        { kind: 'unowned_intake', label: 'Send to intake', repo: 'fleetadlc-testbed', numbers: [3, 7] },
        { kind: 'unowned_ignore', label: 'Ignore', repo: 'fleetadlc-testbed', numbers: [3, 7] },
        { kind: 'unowned_close', label: 'Close', repo: 'fleetadlc-testbed', numbers: [3, 7] },
      ],
    });
    expect(cards[0]?.detail).toContain('#3 Add hello.mjs; #7 Add rub.html');
    expect(cards[0]?.detail).toContain('(@outside-author) have no access to the repository');
    expect(cards[0]?.detail).toContain('and leaves them out of the overlap check');

    const [one] = attentionItems({
      now: NOW,
      gates: [],
      tasks: [],
      bots: BOTS,
      repos: REPOS,
      issues: ISSUES,
      requests: [],
      stallEvents: [],
      unowned: { 'fleetadlc-testbed': [{ number: 3, title: 'Add hello.mjs', url: 'u3', author: 'outside-author' }] },
    }).filter((item) => item.kind === 'unowned_issues');
    expect(one?.detail).toContain('does not send it to intake on its own, and leaves it out of the overlap check');
  });

  it('asks a person to release a promote held for them, or to switch the repository to automatic', async () => {
    const { attentionItems } = await load();
    const sha = 'abc1234def567890abc1234def567890abc12345';
    const base = { now: NOW, gates: [], tasks: [], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [] };

    const unread = 'The production environment could not be read, so it is not known to be holding a reviewer.';
    const [held] = attentionItems({ ...base, heldPromotes: [{ repo: 'fleetadlc-testbed', sha, since: minutesAgo(5), fileGoverned: false, reason: unread }] }).filter(
      (one) => one.kind === 'promote_held',
    );
    expect(held).toMatchObject({
      group: 'work',
      headline: 'fleetadlc-testbed@abc1234 waits for you to release it to production',
      actions: [
        { kind: 'promote_release', label: 'Release to production', repo: 'fleetadlc-testbed', sha },
        { kind: 'promote_automatic', label: 'Switch to automatic delivery', repo: 'fleetadlc-testbed', sha },
      ],
    });
    // The reason reads as a sentence between two others, as the card shows it.
    expect(held?.detail).toBe(
      "Its smoke passed on testing. fleetadlc-testbed's delivery rules say a person approves each production deploy. " +
        'The production environment could not be read, so it is not known to be holding a reviewer. ' +
        'OpenADLC holds the promote until you release it. Or switch the repository to automatic ' +
        'delivery: a soak on testing, the smoke, and an automatic rollback if production fails.',
    );

    // A hold with no recorded reason still reads as sentences.
    const [unrecorded] = attentionItems({ ...base, heldPromotes: [{ repo: 'fleetadlc-testbed', sha, since: minutesAgo(5), fileGoverned: false, reason: '' }] }).filter(
      (one) => one.kind === 'promote_held',
    );
    expect(unrecorded?.detail).toContain('approves each production deploy. Why this one is held was not recorded. OpenADLC holds the promote');

    // The file sets the rules, and wins over anything the console stores: the card opens it instead.
    const plan = 'GitHub’s plan cannot hold a production reviewer here.';
    const [governed] = attentionItems({ ...base, heldPromotes: [{ repo: 'fleetadlc-testbed', sha, since: minutesAgo(5), fileGoverned: true, reason: plan }] }).filter(
      (one) => one.kind === 'promote_held',
    );
    expect(governed?.actions[1]).toMatchObject({ kind: 'open_url', url: expect.stringMatching(/github\.com\/janedoe\/fleetadlc-testbed\/edit\/.+\/\.github\/fleetadlc\.yml$/) });
    expect(governed?.detail).toContain('approves each production deploy. GitHub’s plan cannot hold a production reviewer here. OpenADLC holds the promote');
  });

  it('names a bot with no account by its role, never by its seat', async () => {
    const { attentionItems } = await load();
    const asking = task({ id: 'task-lead', botId: 'bot-lead', kind: 'review', subjectRef: 'fleetadlc-testbed#29', state: 'paused' });

    const [item] = attentionItems({
      now: NOW,
      gates: [{ id: 'gate-2', taskId: 'task-lead', question: 'Which retry policy?', options: [], githubCommentUrl: null, createdAt: minutesAgo(3) }],
      tasks: [asking],
      bots: BOTS,
      repos: REPOS,
      issues: ISSUES,
      requests: [],
      stallEvents: [],
    });

    expect(item?.headline).toBe('The lead reviewer has a question');
    // The review is filed under the pull request; the item names the issue.
    expect(item?.subject).toMatchObject({ number: 11, title: 'Rate-limit the webhook route' });
  });

  it('carries what a question is about: the draft before "Here’s what I’ll file. OK?"', async () => {
    const { attentionItems } = await load();
    const asking = task({ id: 'task-lead', botId: 'bot-lead', kind: 'review', subjectRef: 'fleetadlc-testbed#29', state: 'paused' });
    const draft = 'Here is the issue I would file.\n\n**Title:** Add an ASCII banner';
    const [item] = attentionItems({
      now: NOW,
      gates: [{ id: 'gate-3', taskId: 'task-lead', question: 'Here’s what I’ll file. OK?', options: ['OK, file it', 'Change something'], githubCommentUrl: null, createdAt: minutesAgo(1), context: `${draft}\n` }],
      tasks: [asking],
      bots: BOTS,
      repos: REPOS,
      issues: ISSUES,
      requests: [],
      stallEvents: [],
    });
    expect(item?.context).toBe(draft);
  });

  it('reads a gate from the Ship stage as a question like any other: no stage waits for an OK', async () => {
    // `assist` promised a person in the loop that nothing put there, and is
    // gone; a gate is a bot asking, whatever stage it is in.
    const { attentionItems } = await load();
    const deploying = task({ id: 'task-ship', botId: 'bot-sre', kind: 'deploy', subjectRef: 'fleetadlc-testbed#31', state: 'paused' });

    const [item] = attentionItems({
      now: NOW,
      gates: [
        {
          id: 'gate-3',
          taskId: 'task-ship',
          question: 'Which window?',
          options: ['tonight', 'tomorrow'],
          githubCommentUrl: null,
          createdAt: minutesAgo(14),
        },
      ],
      tasks: [deploying],
      bots: BOTS,
      repos: REPOS,
      issues: ISSUES,
      requests: [],
      stallEvents: [],
    });

    expect(item).toMatchObject({ kind: 'question', detail: 'Which window?', question: { gateId: 'gate-3', options: ['tonight', 'tomorrow'] } });
    expect(item?.actions.map((action) => action.kind)).not.toContain('approve');
  });

  it('says a failed task’s reason in a sentence, and leaves out one that was tried again', async () => {
    const { attentionItems } = await load();
    const failed = task({
      id: 'task-failed',
      botId: 'bot-builder',
      kind: 'implement',
      subjectRef: 'fleetadlc-testbed#16',
      state: 'failed',
      createdAt: minutesAgo(50),
      endedAt: minutesAgo(40),
      exitReason: 'hostd refused: engine claude is not available on this host, so implement cannot run. Install it, or change this bot’s engine.',
    });
    const retriedAway = task({
      id: 'task-failed-earlier',
      botId: 'bot-builder',
      kind: 'implement',
      subjectRef: 'fleetadlc-testbed#15',
      state: 'failed',
      createdAt: minutesAgo(200),
      endedAt: minutesAgo(190),
      exitReason: 'model gone',
    });
    const retry = task({ botId: 'bot-builder', kind: 'implement', subjectRef: 'fleetadlc-testbed#15', state: 'running', createdAt: minutesAgo(100) });

    const items = attentionItems({
      now: NOW,
      gates: [],
      tasks: [failed, retriedAway, retry],
      bots: BOTS,
      repos: REPOS,
      issues: [...ISSUES.filter((one) => one.number !== 15), issue(15, 'Show what a task has cost on its card', 'build')],
      requests: [],
      stallEvents: [],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'task:task-failed',
      kind: 'task_failed',
      headline: 'The builder (fleetadlc-atlas-janedoe) could not finish the change',
      detail: 'Engine claude is not available on this host, so implement cannot run.',
      since: minutesAgo(40),
      subject: { number: 16, title: 'Let the board filter by label' },
    });
    // It can be run again from here, before anything else.
    expect(items[0]?.actions).toEqual([
      { kind: 'retry_task', label: 'Try again', taskId: 'task-failed' },
      { kind: 'stop_task', label: 'Stop', taskId: 'task-failed' },
      { kind: 'dismiss_task', label: 'Dismiss', tasks: [{ taskId: 'task-failed', occurrence: minutesAgo(40) }] },
      { kind: 'open_thread', label: 'Open thread', bot: 'fleetadlc-atlas-janedoe' },
      { kind: 'open_url', label: 'On GitHub', url: 'https://github.com/janedoe/fleetadlc-testbed/issues/16' },
    ]);
  });

  it('says a build finished without opening its pull request, and offers to open it from the branch', async () => {
    const { attentionItems } = await load();
    const branch = 'agent/fleetadlc-atlas-janedoe/16-issue-16';
    const failed = {
      ...task({
        id: 'task-no-pr',
        botId: 'bot-builder',
        kind: 'implement',
        subjectRef: 'fleetadlc-testbed#16',
        state: 'failed',
        endedAt: minutesAgo(10),
        exitReason: `finished without opening a pull request: its commits are on ${branch}, and a second try on that branch did not open one either`,
      }),
      branch,
    };

    const [item, ...rest] = attentionItems({
      now: NOW,
      gates: [],
      tasks: [failed],
      bots: BOTS,
      repos: REPOS.map((repo) => ({ ...repo, defaultBranch: 'main' })),
      issues: ISSUES,
      requests: [],
      stallEvents: [],
    });

    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      kind: 'task_failed',
      headline: 'The builder (fleetadlc-atlas-janedoe) finished without opening a pull request',
      detail: `The builder (fleetadlc-atlas-janedoe) pushed its work to ${branch} and ended twice without opening the pull request. Open it from the branch, or try again.`,
    });
    expect(item?.actions.slice(0, 2)).toEqual([
      { kind: 'open_url', label: 'Open pull request', url: `https://github.com/janedoe/fleetadlc-testbed/compare/main...${branch}?expand=1` },
      { kind: 'retry_task', label: 'Try again', taskId: 'task-no-pr' },
    ]);
  });

  it('says a build that pushed nothing failed, with Try again and no pull request to open', async () => {
    const { attentionItems } = await load();
    const failed = task({
      id: 'task-nothing',
      botId: 'bot-builder',
      kind: 'implement',
      subjectRef: 'fleetadlc-testbed#16',
      state: 'failed',
      endedAt: minutesAgo(10),
      exitReason: 'finished without pushing a commit or opening a pull request: agent/fleetadlc-atlas-janedoe/16-issue-16 has no commits beyond the base',
    });

    const [item] = attentionItems({ now: NOW, gates: [], tasks: [failed], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [] });
    expect(item).toMatchObject({
      headline: 'The builder (fleetadlc-atlas-janedoe) could not finish the change',
      detail: 'The builder (fleetadlc-atlas-janedoe) finished without pushing a commit or opening a pull request. Open its thread to see why, then try again.',
    });
    expect(item?.actions.map((action) => action.label)).not.toContain('Open pull request');
    expect(item?.actions[0]).toEqual({ kind: 'retry_task', label: 'Try again', taskId: 'task-nothing' });
  });

  it('forgets a failure after a week, and one whose card has moved past it', async () => {
    const { attentionItems } = await load();
    const old = task({ botId: 'bot-builder', kind: 'implement', subjectRef: 'fleetadlc-testbed#16', state: 'failed', createdAt: daysAgo(9), endedAt: daysAgo(8) });
    // The review failed, and the change shipped anyway.
    const movedOn = task({ botId: 'bot-second', kind: 'review', subjectRef: 'fleetadlc-testbed#31', state: 'failed', endedAt: minutesAgo(30) });

    expect(
      attentionItems({ now: NOW, gates: [], tasks: [old, movedOn], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [] }),
    ).toEqual([]);
  });

  it('does not take another reviewer’s later review for a second attempt at this one', async () => {
    const { attentionItems, triedAgain } = await load();
    const failed = task({ botId: 'bot-lead', kind: 'review', subjectRef: 'fleetadlc-testbed#29', state: 'failed', createdAt: minutesAgo(30), endedAt: minutesAgo(29) });
    const another = task({ botId: 'bot-second', kind: 'review', subjectRef: 'fleetadlc-testbed#29', state: 'done', createdAt: minutesAgo(29) });

    expect(triedAgain(failed, [failed, another])).toBe(false);
    const items = attentionItems({ now: NOW, gates: [], tasks: [failed, another], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [] });
    expect(items.map((item) => item.headline)).toEqual(['The lead reviewer could not finish its review']);
  });

  it('offers to triage again a request whose triage failed, and only while it is still a draft', async () => {
    const { attentionItems } = await load();
    const REQUEST = 'a4b02784-3ae8-450b-abe9-0c93eb4d67dc';
    const failed = task({
      botId: 'bot-intake',
      kind: 'intake',
      subjectRef: 'request:a4b02784',
      state: 'failed',
      createdAt: minutesAgo(10),
      endedAt: minutesAgo(9),
      exitReason: 'engine claude is not available on this host, so triage cannot run. Install it.',
    });
    const request = { id: REQUEST, text: 'Create html hello world and a readme file.\nWith a footer.', repoId: 'repo-1', state: 'draft', createdAt: minutesAgo(11) };

    const [item, ...rest] = attentionItems({ now: NOW, gates: [], tasks: [failed], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [request], stallEvents: [] });

    // The failed triage is said once, as the request's, not again as a failed task.
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      id: `request:${REQUEST}`,
      kind: 'triage_failed',
      headline: 'The intake bot (ottoexampleco) could not triage your request',
      subject: { repo: 'fleetadlc-testbed', number: null, title: 'Create html hello world and a readme file.', ref: null, item: 'request:a4b02784' },
      detail: 'Engine claude is not available on this host, so triage cannot run.',
    });
    expect(item?.actions[0]).toEqual({ kind: 'retry_triage', label: 'Try again', requestId: REQUEST });

    const filed = { ...request, state: 'filed' };
    expect(attentionItems({ now: NOW, gates: [], tasks: [failed], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [filed], stallEvents: [] })).toEqual([]);

    const retrying = task({ botId: 'bot-intake', kind: 'intake', subjectRef: 'request:a4b02784', state: 'running', createdAt: minutesAgo(1) });
    expect(
      attentionItems({ now: NOW, gates: [], tasks: [failed, retrying], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [request], stallEvents: [] }),
    ).toEqual([]);
  });

  it('lets a person dismiss a failed triage until a newer one ends, or abandon the request', async () => {
    // The card offered only Try again and Open thread, and stood for the
    // whole week for a request nobody wanted any more.
    const { attentionItems } = await load();
    const REQUEST = 'a4b02784-3ae8-450b-abe9-0c93eb4d67dc';
    const failed = task({ botId: 'bot-intake', kind: 'intake', subjectRef: 'request:a4b02784', state: 'failed', createdAt: minutesAgo(10), endedAt: minutesAgo(9), exitReason: 'boom' });
    const request = { id: REQUEST, text: 'Create html hello world.', repoId: 'repo-1', state: 'draft', createdAt: minutesAgo(11) };
    const read = (tasks: TaskFacts[], acknowledged?: Map<string, Set<string>>) =>
      attentionItems({ now: NOW, gates: [], tasks, bots: BOTS, repos: REPOS, issues: ISSUES, requests: [request], stallEvents: [], acknowledged });

    const [item] = read([failed]);
    expect(item?.actions).toEqual(
      expect.arrayContaining([
        { kind: 'dismiss_task', label: 'Dismiss', tasks: [{ taskId: failed.id, occurrence: minutesAgo(9) }] },
        { kind: 'abandon_request', label: 'Abandon', requestId: REQUEST },
      ]),
    );

    // Dismissed: gone, until a newer triage ends.
    expect(read([failed], new Map([[`task:${failed.id}`, new Set([minutesAgo(9)])]]))).toEqual([]);
    const again = task({ botId: 'bot-intake', kind: 'intake', subjectRef: 'request:a4b02784', state: 'failed', createdAt: minutesAgo(5), endedAt: minutesAgo(4), exitReason: 'boom' });
    expect(read([failed, again], new Map([[`task:${failed.id}`, new Set([minutesAgo(9)])]]))).toHaveLength(1);
  });

  it('says a queued request the queue stopped trying, with its reason and Try again', async () => {
    // Refused five times before any task was written — intake's prerequisites
    // failing during onboarding — it had no card, and sat in line for good.
    const { attentionItems } = await load();
    const REQUEST = 'b5c13895-4bf9-461c-bcf0-1d04fc5e78ed';
    const request = {
      id: REQUEST,
      text: 'Add a footer.\nWith the year.',
      repoId: 'repo-1',
      state: 'queued',
      createdAt: minutesAgo(30),
      updatedAt: minutesAgo(12),
      queueAttempts: 5,
      queueReason: 'intake is not ready: its GitHub account is not connected',
    };

    const items = attentionItems({ now: NOW, gates: [], tasks: [], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [request], stallEvents: [] });

    expect(items).toEqual([
      expect.objectContaining({
        id: `request:${REQUEST}`,
        kind: 'triage_failed',
        headline: 'Your request could not start its triage',
        detail: 'The queue tried 5 times and stopped: intake is not ready: its GitHub account is not connected. Put that right, then Try again.',
        subject: expect.objectContaining({ repo: 'fleetadlc-testbed', title: 'Add a footer.', item: 'request:b5c13895' }),
        since: minutesAgo(12),
        actions: [{ kind: 'retry_triage', label: 'Try again', requestId: REQUEST }],
      }),
    ]);
    // It waits for a person however long ago it was given up on.
    const old = { ...request, updatedAt: new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString() };
    expect(attentionItems({ now: NOW, gates: [], tasks: [], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [old], stallEvents: [] })).toHaveLength(1);
  });

  it('says nothing of an earlier failed triage while the request waits its turn again', async () => {
    const { attentionItems } = await load();
    const REQUEST = 'a4b02784-3ae8-450b-abe9-0c93eb4d67dc';
    const failed = task({
      botId: 'bot-intake',
      kind: 'intake',
      subjectRef: 'request:a4b02784',
      state: 'failed',
      createdAt: minutesAgo(10),
      endedAt: minutesAgo(9),
      exitReason: 'hostd shutting down',
    });
    const requeued = { id: REQUEST, text: 'Add a footer.', repoId: 'repo-1', state: 'queued', createdAt: minutesAgo(11), queueAttempts: 1, queueReason: null };

    expect(attentionItems({ now: NOW, gates: [], tasks: [failed], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [requeued], stallEvents: [] })).toEqual([]);
  });

  it('folds two requests whose triage failed the same way into one card', async () => {
    const { attentionItems } = await load();
    const firstFailed = task({
      botId: 'bot-intake',
      kind: 'intake',
      subjectRef: 'request:11111111',
      state: 'failed',
      endedAt: minutesAgo(15),
      exitReason: 'hostd shutting down',
    });
    const secondFailed = task({
      botId: 'bot-intake',
      kind: 'intake',
      subjectRef: 'request:22222222',
      state: 'failed',
      endedAt: minutesAgo(4),
      exitReason: 'hostd shutting down',
    });
    const requests = [
      { id: '11111111-aaaa-bbbb-cccc-000000000000', text: 'Add a footer', repoId: 'repo-1', state: 'draft', createdAt: minutesAgo(16) },
      { id: '22222222-aaaa-bbbb-cccc-000000000000', text: 'Add a header', repoId: 'repo-1', state: 'draft', createdAt: minutesAgo(5) },
    ];

    const items = attentionItems({ now: NOW, gates: [], tasks: [firstFailed, secondFailed], bots: BOTS, repos: REPOS, issues: ISSUES, requests, stallEvents: [] });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'triage_failed',
      headline: 'The intake bot (ottoexampleco) could not triage your request (+1 more)',
      since: minutesAgo(4),
    });
    expect(items[0]?.members?.map((member) => member.subject.title)).toEqual(['Add a header', 'Add a footer']);
  });

  it('says a review loop stopped, until something moves on the pull request', async () => {
    const { attentionItems } = await load();
    const stalled = {
      at: minutesAgo(40),
      payload: { repo: 'fleetadlc-testbed', pr: 29, issue: 11, rounds: 3, bot: 'fleetadlc-atlas-janedoe', botId: 'bot-builder' },
    };

    const [item] = attentionItems({ now: NOW, gates: [], tasks: [], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [stalled] });
    expect(item).toMatchObject({
      id: 'stall:fleetadlc-testbed#29',
      kind: 'review_stalled',
      headline: 'Review stopped after 3 rounds',
      subject: { number: 11, title: 'Rate-limit the webhook route' },
      bot: { name: 'fleetadlc-atlas-janedoe' },
      since: minutesAgo(40),
    });
    expect(item?.actions).toEqual([
      { kind: 'open_url', label: 'Decide on GitHub', url: 'https://github.com/janedoe/fleetadlc-testbed/pull/29' },
      { kind: 'open_thread', label: 'Open thread', bot: 'fleetadlc-atlas-janedoe' },
    ]);

    // A push started another review: it is moving again.
    const reviewAgain = task({ botId: 'bot-second', kind: 'review', subjectRef: 'fleetadlc-testbed#29', state: 'running', createdAt: minutesAgo(5) });
    expect(
      attentionItems({ now: NOW, gates: [], tasks: [reviewAgain], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [stalled] }),
    ).toEqual([]);

    // A person merged it anyway.
    const merged = ISSUES.map((one) => (one.number === 11 ? { ...one, stage: 'merged' as never } : one));
    expect(
      attentionItems({ now: NOW, gates: [], tasks: [], bots: BOTS, repos: REPOS, issues: merged, requests: [], stallEvents: [stalled] }),
    ).toEqual([]);
  });

  it('says one round, not one rounds, when review is allowed only one', async () => {
    const { attentionItems } = await load();
    const once = { at: minutesAgo(40), payload: { repo: 'fleetadlc-testbed', pr: 29, issue: 11, rounds: 1, bot: 'fleetadlc-atlas-janedoe', botId: 'bot-builder' } };
    const [item] = attentionItems({ now: NOW, gates: [], tasks: [], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [once] });
    expect(item?.headline).toBe('Review stopped after 1 round');
  });

  it('says a blocking seat holds the merge the lead approved, and what a person can do', async () => {
    // Only the lead's request sends work back, so a blocking seat's left the
    // pull request in Review with nobody on it and nothing on the board.
    const { attentionItems } = await load();
    const held = {
      at: minutesAgo(10),
      payload: { repo: 'fleetadlc-testbed', pr: 29, issue: 11, rounds: 0, heldBy: ['security-reviewer'], bot: 'security-reviewer', botId: null },
    };

    const [item] = attentionItems({ now: NOW, gates: [], tasks: [], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [held] });
    expect(item).toMatchObject({
      id: 'stall:fleetadlc-testbed#29',
      kind: 'review_stalled',
      group: 'work',
      headline: 'Review stopped: security-reviewer still asks for changes',
      subject: { number: 11 },
    });
    expect(item?.detail).toContain('security-reviewer is blocking and still asks for changes; the lead approved.');
    expect(item?.detail).toContain('dismiss its review on GitHub');
    expect(item?.actions?.[0]).toEqual({ kind: 'open_url', label: 'Decide on GitHub', url: 'https://github.com/janedoe/fleetadlc-testbed/pull/29' });

    // Asked to review again: it is moving.
    const again = task({ botId: 'bot-second', kind: 'review', subjectRef: 'fleetadlc-testbed#29', state: 'running', createdAt: minutesAgo(2) });
    expect(attentionItems({ now: NOW, gates: [], tasks: [again], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [held] })).toEqual([]);
    const merged = ISSUES.map((one) => (one.number === 11 ? { ...one, stage: 'merged' as never } : one));
    expect(
      attentionItems({ now: NOW, gates: [], tasks: [], bots: BOTS, repos: REPOS, issues: merged, requests: [], stallEvents: [held] }),
    ).toEqual([]);
  });

  it('says why a loop stopped for want of a lease or a builder, instead of that the reviewers still ask', async () => {
    // A send-back that found nothing holding the issue returned with nothing
    // said; now it records why, and the card shows that.
    const { attentionItems } = await load();
    const stopped = {
      at: minutesAgo(10),
      payload: { repo: 'fleetadlc-testbed', pr: 29, issue: 11, rounds: 0, bot: null, botId: null, reason: 'the builder that held #11 is no longer in the crew' },
    };

    const [item] = attentionItems({ now: NOW, gates: [], tasks: [], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [stopped] });

    expect(item).toMatchObject({ id: 'stall:fleetadlc-testbed#29', kind: 'review_stalled', subject: { number: 11 } });
    expect(item?.detail).toContain('the builder that held #11 is no longer in the crew');
    expect(item?.detail).not.toContain('The reviewers still ask for changes');
  });

  it('says a console request’s own question, naming the request, and answers it in the bot’s thread', async () => {
    const { attentionItems } = await load();
    // Triage asks what is missing through a gate, and the request waits in `questions`.
    const asking = task({ id: 'task-request', botId: 'bot-intake', kind: 'intake', subjectRef: 'request:a4b02784', state: 'paused' });
    const request = { id: 'a4b02784-3ae8-450b-abe9-0c93eb4d67dc', text: 'Create html hello world and a readme file.', repoId: 'repo-1', state: 'questions', createdAt: minutesAgo(12) };

    const items = attentionItems({
      now: NOW,
      gates: [{ id: 'gate-r', taskId: 'task-request', question: 'Which page should link to it?', options: [], githubCommentUrl: null, createdAt: minutesAgo(3) }],
      tasks: [asking],
      bots: BOTS,
      repos: REPOS,
      issues: ISSUES,
      requests: [request],
      stallEvents: [],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'question',
      headline: 'The intake bot (ottoexampleco) has a question',
      // No ref, since it is no issue yet: its item is how the card opens the request's own conversation.
      subject: { repo: 'fleetadlc-testbed', number: null, title: 'Create html hello world and a readme file.', ref: null, item: 'request:a4b02784' },
      detail: 'Which page should link to it?',
      actions: [{ kind: 'answer', label: 'Answer', bot: 'ottoexampleco' }],
      // An open question: nothing to press but Answer.
      question: { gateId: 'gate-r', options: [] },
    });
  });

  it('offers to triage again a request whose questions were answered and whose triage then failed', async () => {
    const { attentionItems } = await load();
    const failed = task({ botId: 'bot-intake', kind: 'intake', subjectRef: 'request:a4b02784', state: 'failed', createdAt: minutesAgo(10), endedAt: minutesAgo(2), exitReason: 'hostd refused: the model is gone.' });
    for (const state of ['questions', 'draft']) {
      const request = { id: 'a4b02784-3ae8-450b-abe9-0c93eb4d67dc', text: 'Create a page', repoId: 'repo-1', state, createdAt: minutesAgo(11) };
      const [item] = attentionItems({ now: NOW, gates: [], tasks: [failed], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [request], stallEvents: [] });
      expect(item?.kind, state).toBe('triage_failed');
    }
    const abandoned = { id: 'a4b02784-3ae8-450b-abe9-0c93eb4d67dc', text: 'Create a page', repoId: 'repo-1', state: 'abandoned', createdAt: minutesAgo(11) };
    expect(attentionItems({ now: NOW, gates: [], tasks: [failed], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [abandoned], stallEvents: [] })).toEqual([]);
  });

  it('says a weekly engine update that did not go in, with the way to it in settings', async () => {
    const { attentionItems } = await load();
    const [item] = attentionItems({
      now: NOW,
      gates: [],
      tasks: [],
      bots: BOTS,
      repos: REPOS,
      issues: ISSUES,
      requests: [],
      stallEvents: [],
      engineUpdate: {
        kind: 'engine-update-failed',
        title: 'The engine update did not go in — the bots are still on the engines they had',
        detail: 'claude 2.1.290 could not answer a one-line prompt with the Max account. The image was not swapped.',
        at: minutesAgo(90),
        href: '/settings#engine-updates',
      },
    });

    expect(item).toMatchObject({
      id: 'engine-update',
      kind: 'engine_update_failed',
      headline: 'The engine update did not go in',
      bot: null,
      since: minutesAgo(90),
      detail: 'Claude 2.1.290 could not answer a one-line prompt with the Max account.',
      actions: [{ kind: 'open_page', label: 'See the engine updates', href: '/settings#engine-updates' }],
    });
  });

  it('says GitHub is not sending, from the webhook’s check, with the app’s settings page as the thing to do', async () => {
    // On a real install the app was created with its webhook switched off, and
    // the board stayed empty while GitHub sent nothing at all. The only fix is
    // a switch on the app's settings page, so the card is the link to it — and
    // it is the webhook's health check that says so now, the same answer the
    // walkthrough's step and `fleetadlc doctor` read.
    const { attentionItems } = await load();
    const [item] = attentionItems({
      now: NOW,
      gates: [],
      tasks: [],
      bots: BOTS,
      repos: REPOS,
      issues: ISSUES,
      requests: [],
      stallEvents: [],
      health: [
        healthRow({
          id: 'webhook',
          checkId: 'webhook',
          state: 'failing',
          severity: 'blocking',
          title: 'GitHub is not sending events to OpenADLC',
          detail: 'Open the app’s settings and turn on **Active** under Webhook. OpenADLC found this by reading the repository; GitHub never delivered it.',
          action: { label: 'Open the app’s settings', url: 'https://github.com/settings/apps/fleetadlc-janedoe' },
          failingSince: minutesAgo(30),
          facts: {
            subject: {
              repo: 'fleetadlc-testbed',
              number: 1,
              title: 'Document the webhook step',
              ref: 'fleetadlc-testbed#1',
              url: 'https://github.com/janedoe/fleetadlc-testbed/issues/1',
            },
          },
        }),
      ],
    });

    expect(item).toMatchObject({
      id: 'check:webhook',
      kind: 'check_failed',
      headline: 'GitHub is not sending events to OpenADLC',
      subject: { repo: 'fleetadlc-testbed', number: 1, title: 'Document the webhook step', ref: 'fleetadlc-testbed#1' },
      bot: null,
      since: minutesAgo(30),
      severity: 'blocking',
      actions: [
        { kind: 'open_url', label: 'Open the app’s settings', url: 'https://github.com/settings/apps/fleetadlc-janedoe' },
        { kind: 'recheck', label: 'Check again', checkId: 'webhook' },
      ],
    });
    expect(item?.detail).toContain('turn on **Active** under Webhook');
  });

  it('starts a card with the time since its check has had no answer, and why, before the check’s own detail', async () => {
    const { attentionItems } = await load();
    const [item] = attentionItems({
      now: NOW,
      gates: [],
      tasks: [],
      bots: BOTS,
      repos: REPOS,
      issues: ISSUES,
      requests: [],
      stallEvents: [],
      health: [
        healthRow({
          id: 'repo-config:acme/api',
          checkId: 'repo-config',
          state: 'failing',
          severity: 'blocking',
          title: 'acme is named as a reviewer in acme/api’s CODEOWNERS',
          detail: 'Name the people who must approve.',
          failingSince: minutesAgo(60),
          facts: { unconfirmed: { since: '2026-09-25T11:30:00.000Z', reason: 'GitHub did not say whether janedoe can review.' } },
        }),
      ],
    } as never);
    expect(item?.detail).toBe(
      'OpenADLC couldn’t confirm this is still the case — since 2026-09-25 11:30 UTC its check has had no answer: ' +
        'GitHub did not say whether janedoe can review. If you fixed it, press Check again.\n\nName the people who must approve.',
    );
  });

  it('sends a person to a page in the console when that is where the check’s fix is', async () => {
    const { attentionItems } = await load();
    const [item] = attentionItems({
      now: NOW,
      gates: [],
      tasks: [],
      bots: BOTS,
      repos: REPOS,
      issues: ISSUES,
      requests: [],
      stallEvents: [],
      health: [
        healthRow({
          id: 'webhook',
          checkId: 'webhook',
          state: 'failing',
          severity: 'blocking',
          title: 'GitHub is delivering to a tunnel that has stopped',
          detail: 'Raise a new one on the webhook step.',
          action: { label: 'Open the webhook step', href: '/onboarding?step=webhook' },
          failingSince: minutesAgo(30),
        }),
      ],
    });

    expect(item?.actions).toEqual([
      { kind: 'open_page', label: 'Open the webhook step', href: '/onboarding?step=webhook' },
      { kind: 'recheck', label: 'Check again', checkId: 'webhook' },
    ]);
  });

  it('reads what the checks last said, and loses nothing else when it cannot', async () => {
    const { readAttention } = await load();
    const said = [healthRow({ id: 'hostd', checkId: 'hostd', state: 'failing', title: 'OpenADLC’s host service is not answering' })];
    const read = await readAttention(NOW, { health: { rows: async () => said } });
    expect(read.health?.map((row) => row.id)).toEqual(['hostd']);

    // An install whose migration has not run has no table to read.
    const failing = await readAttention(NOW, {
      health: {
        rows: async () => {
          throw new Error('relation "health_checks" does not exist');
        },
      },
    });
    expect(failing.health).toEqual([]);
    expect(failing.bots).toEqual(BOTS);
  });

  it('puts the newest first', async () => {
    const { attentionItems } = await load();
    const asking = task({ id: 'task-q2', botId: 'bot-intake', kind: 'intake', subjectRef: 'fleetadlc-testbed#15', state: 'paused' });
    const failed = task({ botId: 'bot-builder', kind: 'implement', subjectRef: 'fleetadlc-testbed#16', state: 'failed', endedAt: minutesAgo(1) });

    const items = attentionItems({
      now: NOW,
      gates: [{ id: 'gate-5', taskId: 'task-q2', question: 'Which?', options: [], githubCommentUrl: null, createdAt: minutesAgo(20) }],
      tasks: [asking, failed],
      bots: BOTS,
      repos: REPOS,
      issues: ISSUES,
      requests: [],
      stallEvents: [{ at: minutesAgo(10), payload: { repo: 'fleetadlc-testbed', pr: 29, issue: 11, rounds: 3 } }],
    });

    expect(items.map((item) => item.kind)).toEqual(['task_failed', 'review_stalled', 'question']);
  });
});

describe('a repository removed from OpenADLC', () => {
  it('has no question, failure, stall or failed triage in what needs you', async () => {
    const { attentionItems } = await load();
    const asking = task({ id: 'task-q', botId: 'bot-intake', kind: 'intake', subjectRef: 'fleetadlc-testbed#15', state: 'paused' });
    // Stopped by the removal: without this it would be a "was stopped before finishing" card.
    const stopped = task({
      botId: 'bot-builder',
      kind: 'implement',
      subjectRef: 'fleetadlc-testbed#16',
      state: 'stopped',
      endedAt: minutesAgo(1),
      exitReason: 'hostd restarted',
    });
    const triage = task({ botId: 'bot-intake', kind: 'intake', subjectRef: 'request:a4b02784', state: 'failed', endedAt: minutesAgo(2), exitReason: 'boom' });
    const request = { id: 'a4b02784-3ae8-450b-abe9-0c93eb4d67dc', text: 'A readme.', repoId: 'repo-1', state: 'draft', createdAt: minutesAgo(11) };
    const input = {
      now: NOW,
      gates: [{ id: 'gate-5', taskId: 'task-q', question: 'Which?', options: [], githubCommentUrl: null, createdAt: minutesAgo(20) }],
      tasks: [asking, stopped, triage],
      bots: BOTS,
      issues: ISSUES,
      requests: [request],
      stallEvents: [{ at: minutesAgo(10), payload: { repo: 'fleetadlc-testbed', pr: 29, issue: 11, rounds: 3 } }],
    };

    // While it is OpenADLC's, each is an item.
    expect(attentionItems({ ...input, repos: REPOS }).map((item) => item.kind).sort()).toEqual(
      ['question', 'review_stalled', 'task_failed', 'triage_failed'].sort(),
    );
    // Removed, none is.
    expect(attentionItems({ ...input, repos: [], removed: [{ id: 'repo-1', name: 'fleetadlc-testbed' }] })).toEqual([]);
  });

  it('leaves the other repositories’ items as they are', async () => {
    const { attentionItems } = await load();
    const there = task({ botId: 'bot-builder', kind: 'implement', subjectRef: 'old-api#3', repoId: 'repo-old', state: 'failed', endedAt: minutesAgo(1) });
    const here = task({ botId: 'bot-builder', kind: 'implement', subjectRef: 'fleetadlc-testbed#16', state: 'failed', endedAt: minutesAgo(1) });

    const items = attentionItems({
      now: NOW,
      gates: [],
      tasks: [there, here],
      bots: BOTS,
      repos: REPOS,
      issues: ISSUES,
      requests: [],
      stallEvents: [],
      removed: [{ id: 'repo-old', name: 'old-api' }],
    });

    expect(items.map((item) => item.subject.ref)).toEqual(['fleetadlc-testbed#16']);
  });

  it('leaves out a pull request the merge line held for a person in a removed repository', async () => {
    const { attentionItems } = await load();
    const items = attentionItems({
      now: NOW,
      gates: [],
      tasks: [],
      bots: BOTS,
      repos: REPOS,
      issues: ISSUES,
      requests: [],
      stallEvents: [],
      heldMerges: [
        { repo: 'old-api', prNumber: 5, reason: 'it changes how CI runs (Makefile)', since: minutesAgo(2) },
        { repo: 'fleetadlc-testbed', prNumber: 29, reason: 'it changes how CI runs (Makefile)', since: minutesAgo(2) },
      ],
      removed: [{ id: 'repo-old', name: 'old-api' }],
    });

    expect(items.filter((item) => item.kind === 'merge_waiting').map((item) => item.id)).toEqual(['merge:fleetadlc-testbed#29']);
  });
});

describe('an issue labelled fleetadlc:ignore', () => {
  // The console is for the work the crew does. #11 and its pull request #29
  // are a person's once the label is on, and none of their work needs you.
  const labelled = (labels: string[]) => ISSUES.map((one) => (one.number === 11 ? { ...one, labels: [...labels] } : one));

  it('has no question, failure, stall or held merge of its own or its pull request’s in what needs you', async () => {
    const { attentionItems } = await load();
    const asking = task({ id: 'task-q', botId: 'bot-lead', kind: 'review', subjectRef: 'fleetadlc-testbed#29', state: 'paused' });
    const failed = task({ botId: 'bot-second', kind: 'review', subjectRef: 'fleetadlc-testbed#29', state: 'failed', endedAt: minutesAgo(1), exitReason: 'boom' });
    // Another issue's work stays.
    const other = task({ botId: 'bot-builder', kind: 'implement', subjectRef: 'fleetadlc-testbed#16', state: 'failed', endedAt: minutesAgo(1), exitReason: 'boom' });
    const input = {
      now: NOW,
      gates: [{ id: 'gate-5', taskId: 'task-q', question: 'Which?', options: [], githubCommentUrl: null, createdAt: minutesAgo(20) }],
      tasks: [asking, failed, other],
      bots: BOTS,
      repos: REPOS,
      requests: [],
      stallEvents: [{ at: minutesAgo(10), payload: { repo: 'fleetadlc-testbed', pr: 29, issue: 11, rounds: 3 } }],
      heldMerges: [{ repo: 'fleetadlc-testbed', prNumber: 29, reason: 'it changes how CI runs (Makefile)', since: minutesAgo(2) }],
    };

    // Without the label, each is an item.
    const before = attentionItems({ ...input, issues: labelled([]) });
    expect(before.filter((item) => item.subject.item === 'fleetadlc-testbed#11').map((item) => item.kind).sort()).toEqual(
      ['merge_waiting', 'question', 'review_stalled', 'task_failed'].sort(),
    );

    const after = attentionItems({ ...input, issues: labelled(['fleetadlc:ignore']) });
    expect(after.map((item) => item.subject.ref)).toEqual(['fleetadlc-testbed#16']);
  });

  it('has no send-back held for a person either', async () => {
    const { attentionItems } = await load();
    const refused = { at: daysAgo(3), type: 'send_back.stalled', payload: { repo: 'fleetadlc-testbed', issue: 11, from: 'review', to: 'build', by: 'lead-reviewer', reason: 'Still wrong' } };
    const input = { now: NOW, gates: [], tasks: [], bots: BOTS, repos: REPOS, requests: [], stallEvents: [], sendBackEvents: [refused] };

    expect(attentionItems({ ...input, issues: labelled(['needs-human']) }).map((item) => item.id)).toEqual(['sendback:fleetadlc-testbed#11']);
    expect(attentionItems({ ...input, issues: labelled(['needs-human', 'fleetadlc:ignore']) })).toEqual([]);
  });
});

describe('work sent back to a person', () => {
  const refused = { at: daysAgo(3), type: 'send_back.stalled', payload: { repo: 'fleetadlc-testbed', issue: 11, from: 'review', to: 'build', by: 'lead-reviewer', reason: 'Still wrong' } };
  const held = { ...issue(11, 'Rate-limit the webhook route', 'review', 29), labels: ['needs-human'] };
  const base = { now: NOW, tasks: [], bots: BOTS, repos: REPOS, requests: [], stallEvents: [], sendBackEvents: [refused] };

  it('is a card while the issue waits where the send-back left it', async () => {
    const { attentionItems } = await load();
    const items = attentionItems({ ...base, gates: [], issues: [held] });
    expect(items.map((item) => item.id)).toEqual(['sendback:fleetadlc-testbed#11']);
  });

  it('gives the bot’s reason one full stop, though the bot wrote its own', async () => {
    const { attentionItems } = await load();
    const ended = { ...refused, payload: { ...refused.payload, reason: 'The design names no migration.' } };
    const [item] = attentionItems({ ...base, sendBackEvents: [ended], gates: [], issues: [held] });
    expect(item?.detail).toBe('lead-reviewer: The design names no migration. Decide where it goes, then take needs-human off.');
  });

  it('does not come back when a later question puts needs-human on the issue', async () => {
    const { attentionItems } = await load();
    const asking = task({ id: 'task-ask', botId: 'bot-builder', kind: 'patch', subjectRef: 'fleetadlc-testbed#29', state: 'paused' });
    const items = attentionItems({
      ...base,
      tasks: [asking],
      gates: [{ id: 'g1', taskId: 'task-ask', question: 'Which?', options: [], githubCommentUrl: null, createdAt: minutesAgo(5) }],
      issues: [held],
    });
    expect(items.map((item) => item.id)).toEqual(['gate:g1']);
  });

  it('does not come back once the issue has moved on', async () => {
    const { attentionItems } = await load();
    const items = attentionItems({ ...base, gates: [], issues: [{ ...held, stage: 'merged' as never }] });
    expect(items.filter((item) => item.kind === 'send_back_held')).toEqual([]);
  });
});

describe('a failed task, in words a person acts on', () => {
  const GROK_SIGNED_OUT =
    'hostd refused: POST http://127.0.0.1:47312/tasks → 500: { "error": "You are not authenticated — sign this subscription in again from the accounts step" }';

  it('names the pull request by its title, says what to do first, and keeps the raw reason behind Details', async () => {
    const { attentionItems } = await load();
    const failed = task({
      id: 'task-iris',
      botId: 'bot-second',
      kind: 'review',
      subjectRef: 'fleetadlc-testbed#2',
      state: 'failed',
      endedAt: minutesAgo(12),
      exitReason: GROK_SIGNED_OUT,
    });

    const [item] = attentionItems({
      now: NOW,
      gates: [],
      tasks: [failed],
      bots: BOTS.map((bot) => (bot.id === 'bot-second' ? { ...bot, modelAccountId: 'acct-grok' } : bot)),
      repos: REPOS,
      issues: ISSUES,
      requests: [],
      stallEvents: [],
      accounts: [{ id: 'acct-grok', label: 'Grok — SuperGrok', provider: 'xai', kind: 'subscription' }],
      // The board has no row whose pull request is #2; GitHub says what it is.
      titles: new Map([['fleetadlc-testbed#2', { title: 'Add a health endpoint', url: 'https://github.com/janedoe/fleetadlc-testbed/pull/2', pullRequest: true }]]),
    });

    expect(item).toMatchObject({
      id: 'task:task-iris',
      kind: 'task_failed',
      headline: 'The second reviewer (irisexampleco) could not finish its review',
      subject: { number: 2, title: 'Add a health endpoint', url: 'https://github.com/janedoe/fleetadlc-testbed/pull/2' },
      detail:
        'The xAI subscription “Grok — SuperGrok” the second reviewer (irisexampleco) thinks with is signed out. Sign it in again on the “Foundation model accounts / API keys” step, then try again.',
      raw: GROK_SIGNED_OUT,
    });
    expect(item?.actions).toEqual([
      { kind: 'open_page', label: 'Sign in again', href: '/onboarding?step=models' },
      { kind: 'retry_task', label: 'Try again', taskId: 'task-iris' },
      { kind: 'stop_task', label: 'Stop', taskId: 'task-iris' },
      { kind: 'dismiss_task', label: 'Dismiss', tasks: [{ taskId: 'task-iris', occurrence: minutesAgo(12) }] },
      { kind: 'open_thread', label: 'Open thread', bot: 'irisexampleco' },
      { kind: 'open_url', label: 'On GitHub', url: 'https://github.com/janedoe/fleetadlc-testbed/pull/2' },
    ]);
  });

  it('shows a task OpenADLC stopped under a bot, which nothing runs again, with Try again', async () => {
    const { attentionItems } = await load();
    const stopped = task({
      id: 'task-stopped',
      botId: 'bot-builder',
      kind: 'implement',
      subjectRef: 'fleetadlc-testbed#16',
      state: 'stopped',
      endedAt: minutesAgo(3),
      exitReason: 'hostd shutting down',
    });

    const [item] = attentionItems({ now: NOW, gates: [], tasks: [stopped], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [] });
    expect(item).toMatchObject({
      headline: 'The builder (fleetadlc-atlas-janedoe) was stopped before finishing the change',
      detail: 'OpenADLC stopped while the builder (fleetadlc-atlas-janedoe) was working, and nothing started the work again. Try again to pick it up.',
    });
    expect(item?.actions[0]).toEqual({ kind: 'retry_task', label: 'Try again', taskId: 'task-stopped' });
  });

  it('shows nothing for a task a person stopped from the console: they decided that work is over', async () => {
    const { attentionItems, STOPPED_BY_A_PERSON } = await load();
    const stopped = task({
      id: 'task-stopped',
      botId: 'bot-builder',
      kind: 'implement',
      subjectRef: 'fleetadlc-testbed#16',
      state: 'stopped',
      endedAt: minutesAgo(3),
      exitReason: `${STOPPED_BY_A_PERSON} janedoe: taking it over`,
    });
    expect(attentionItems({ now: NOW, gates: [], tasks: [stopped], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [] })).toEqual([]);
  });

  it('folds two reviewers stopped the same way into one card, listing both rather than repeating the story', async () => {
    const { attentionItems } = await load();
    // Two different pull requests, both in review, so neither is skipped as
    // work the card has already moved past.
    const reviewIssues = [issue(11, 'Rate-limit the webhook route', 'review'), issue(20, 'Add a cost column', 'review')];
    const lead = task({
      id: 'task-lead',
      botId: 'bot-lead',
      kind: 'review',
      subjectRef: 'fleetadlc-testbed#11',
      state: 'failed',
      endedAt: minutesAgo(20),
      exitReason: 'GitHub said: Bad credentials',
    });
    const second = task({
      id: 'task-second',
      botId: 'bot-second',
      kind: 'review',
      subjectRef: 'fleetadlc-testbed#20',
      state: 'failed',
      endedAt: minutesAgo(5),
      exitReason: 'GitHub said: Bad credentials',
    });

    const items = attentionItems({ now: NOW, gates: [], tasks: [lead, second], bots: BOTS, repos: REPOS, issues: reviewIssues, requests: [], stallEvents: [] });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'task-group:task:task-second,task:task-lead',
      kind: 'task_failed',
      // The newest first, and how many more are behind it.
      headline: 'The second reviewer (irisexampleco) could not finish its review (+1 more)',
      since: minutesAgo(5),
      // Reconnecting is each bot's own, so it is not offered as if it fixed
      // both; stopping and dismissing act on every task on the card.
      actions: [
        { kind: 'stop_task', label: 'Stop all', taskId: 'task-second', taskIds: ['task-second', 'task-lead'] },
        {
          kind: 'dismiss_task',
          label: 'Dismiss all',
          tasks: [
            { taskId: 'task-second', occurrence: minutesAgo(5) },
            { taskId: 'task-lead', occurrence: minutesAgo(20) },
          ],
        },
      ],
    });
    expect(items[0]?.members?.map((member) => member.id)).toEqual(['task:task-second', 'task:task-lead']);
    expect(items[0]?.members?.[0]).toMatchObject({ headline: 'The second reviewer (irisexampleco) could not finish its review', subject: { number: 20 } });
    expect(items[0]?.members?.[0]?.actions[0]).toEqual({ kind: 'open_page', label: 'Reconnect the second reviewer (irisexampleco)', href: '/settings#github-accounts' });
    expect(items[0]?.members?.[1]).toMatchObject({ headline: 'The lead reviewer could not finish its review', subject: { number: 11 } });
    expect(items[0]?.members?.[1]?.actions[0]).toEqual({
      kind: 'open_page',
      label: 'Reconnect the lead reviewer',
      href: '/settings#github-accounts',
    });
  });

  it('does not fold two bots that failed for different reasons, or at different work', async () => {
    const { attentionItems } = await load();
    const signedOut = task({
      botId: 'bot-lead',
      kind: 'review',
      subjectRef: 'fleetadlc-testbed#29',
      state: 'failed',
      endedAt: minutesAgo(20),
      exitReason: 'GitHub said: Bad credentials',
    });
    const differentReason = task({
      botId: 'bot-second',
      kind: 'review',
      subjectRef: 'fleetadlc-testbed#11',
      state: 'failed',
      endedAt: minutesAgo(5),
      exitReason: 'hostd shutting down',
    });
    const differentWork = task({
      botId: 'bot-builder',
      kind: 'implement',
      subjectRef: 'fleetadlc-testbed#16',
      state: 'failed',
      endedAt: minutesAgo(2),
      exitReason: 'GitHub said: Bad credentials',
    });

    const items = attentionItems({
      now: NOW,
      gates: [],
      tasks: [signedOut, differentReason, differentWork],
      bots: BOTS,
      repos: REPOS,
      issues: ISSUES,
      requests: [],
      stallEvents: [],
    });
    expect(items).toHaveLength(3);
    expect(items.every((item) => !item.members)).toBe(true);
  });

  it('does not fold two tasks that stopped without saying why: an unknown cause is not a shared one', async () => {
    const { attentionItems } = await load();
    const first = task({
      botId: 'bot-lead',
      kind: 'review',
      subjectRef: 'fleetadlc-testbed#29',
      state: 'failed',
      endedAt: minutesAgo(20),
      exitReason: null,
    });
    const second = task({
      botId: 'bot-second',
      kind: 'review',
      subjectRef: 'fleetadlc-testbed#11',
      state: 'failed',
      endedAt: minutesAgo(5),
      exitReason: '',
    });

    const items = attentionItems({ now: NOW, gates: [], tasks: [first, second], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [] });
    expect(items).toHaveLength(2);
    expect(items.every((item) => !item.members)).toBe(true);
    expect(items.every((item) => item.detail === 'It stopped without saying why.')).toBe(true);
  });
});

describe('what the health checks say', () => {
  it('is a card per failing check, the bot it is about named, and none for one waiting on another’s fix', async () => {
    const { attentionItems } = await load();
    const items = attentionItems({
      now: NOW,
      gates: [],
      tasks: [],
      bots: BOTS,
      repos: REPOS,
      issues: ISSUES,
      requests: [],
      stallEvents: [],
      health: [
        healthRow({
          id: 'app-permissions:git_signing_ssh_public_keys',
          checkId: 'app-permissions',
          state: 'failing',
          title: 'The OpenADLC app does not have “SSH signing keys”',
          action: { label: 'Open the app’s permissions', url: 'https://github.com/settings/apps/fleetadlc-janedoe/permissions' },
        }),
        healthRow({
          id: 'signing-key:bot-builder',
          checkId: 'signing-key',
          state: 'failing',
          title: 'fleetadlc-atlas-janedoe’s signing key is not on its GitHub account',
          waitingFor: ['app-permissions:git_signing_ssh_public_keys'],
          facts: { botId: 'bot-builder' },
        }),
        healthRow({
          id: 'token-expiry',
          checkId: 'token-expiry',
          state: 'failing',
          severity: 'warning',
          title: 'The OpenADLC app’s user tokens never expire',
        }),
        healthRow({ id: 'hostd', checkId: 'hostd', state: 'ok' }),
      ],
    });

    expect(items.map((item) => [item.id, item.kind, item.severity])).toEqual([
      ['check:app-permissions:git_signing_ssh_public_keys', 'check_failed', 'blocking'],
      ['check:token-expiry', 'check_failed', 'warning'],
    ]);
  });

  it('does not fold a blocking row behind a newer warning under the same check', async () => {
    // repo-rules and signing-key emit both severities under one checkId — a
    // repository stuck for everyone, and another merely unprotected. Folding
    // them by checkId alone took the newest row's severity, so a blocking
    // failure could read amber. Severity is part of the fold key, so the two
    // stay apart and each keeps its own colour.
    const { attentionItems } = await load();
    const items = attentionItems({
      now: NOW,
      gates: [],
      tasks: [],
      bots: BOTS,
      repos: REPOS,
      issues: ISSUES,
      requests: [],
      stallEvents: [],
      health: [
        healthRow({
          id: 'repo-rules:janedoe-a',
          checkId: 'repo-rules',
          state: 'failing',
          severity: 'blocking',
          title: 'Nothing the crew builds can land in janedoe/a',
          failingSince: minutesAgo(30),
        }),
        healthRow({
          id: 'repo-rules:janedoe-b',
          checkId: 'repo-rules',
          state: 'failing',
          severity: 'warning',
          title: 'janedoe/b is not protected the way OpenADLC sets it',
          failingSince: minutesAgo(5),
        }),
      ],
    });

    expect(items.map((item) => [item.headline, item.severity])).toEqual([
      ['janedoe/b is not protected the way OpenADLC sets it', 'warning'],
      ['Nothing the crew builds can land in janedoe/a', 'blocking'],
    ]);
    expect(items.every((item) => !item.members)).toBe(true);
  });

  it('folds the same check failing for two bots into one card naming both', async () => {
    const { attentionItems } = await load();
    const items = attentionItems({
      now: NOW,
      gates: [],
      tasks: [],
      bots: BOTS,
      repos: REPOS,
      issues: ISSUES,
      requests: [],
      stallEvents: [],
      health: [
        healthRow({
          id: 'bot-sign-in:bot-lead',
          checkId: 'bot-sign-in',
          state: 'failing',
          title: 'lead-reviewer has no GitHub account connected',
          failingSince: minutesAgo(30),
          action: { label: 'Connect the lead reviewer', href: '/onboarding?step=crew' },
          facts: { botId: 'bot-lead' },
        }),
        healthRow({
          id: 'bot-sign-in:bot-second',
          checkId: 'bot-sign-in',
          state: 'failing',
          title: 'irisexampleco has no GitHub account connected',
          failingSince: minutesAgo(10),
          action: { label: 'Connect the second reviewer', href: '/onboarding?step=crew' },
          facts: { botId: 'bot-second' },
        }),
      ],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'check-group:check:bot-sign-in:bot-second,check:bot-sign-in:bot-lead',
      kind: 'check_failed',
      headline: 'irisexampleco has no GitHub account connected (+1 more)',
      since: minutesAgo(10),
      severity: 'blocking',
      // Connecting a bot is that bot's own action, not offered as a fix for both;
      // asking the check again is the whole card's, so it is there once.
      actions: [{ kind: 'recheck', label: 'Check again', checkId: 'bot-sign-in' }],
    });
    expect(items[0]?.members?.map((member) => member.bot?.name)).toEqual(['irisexampleco', 'lead-reviewer']);
    // Its members keep their own actions only: Check again is the card's, not repeated under each.
    expect(items[0]?.members?.flatMap((member) => member.actions).some((action) => action.kind === 'recheck')).toBe(false);
  });

  it('shows the bot’s own card once its prerequisite is fixed', async () => {
    const { attentionItems } = await load();
    const [item] = attentionItems({
      now: NOW,
      gates: [],
      tasks: [],
      bots: BOTS,
      repos: REPOS,
      issues: ISSUES,
      requests: [],
      stallEvents: [],
      health: [
        healthRow({ id: 'app-permissions:git_signing_ssh_public_keys', checkId: 'app-permissions', state: 'ok' }),
        healthRow({
          id: 'signing-key:bot-builder',
          checkId: 'signing-key',
          state: 'failing',
          title: 'fleetadlc-atlas-janedoe’s signing key is not on its GitHub account',
          action: { label: 'Reconnect fleetadlc-atlas-janedoe', href: '/settings#github-accounts' },
          waitingFor: ['app-permissions:git_signing_ssh_public_keys'],
          facts: { botId: 'bot-builder' },
        }),
      ],
    });
    expect(item).toMatchObject({
      kind: 'check_failed',
      bot: { name: 'fleetadlc-atlas-janedoe' },
      actions: [
        { kind: 'open_page', label: 'Reconnect fleetadlc-atlas-janedoe', href: '/settings#github-accounts' },
        { kind: 'recheck', label: 'Check again', checkId: 'signing-key' },
      ],
    });
  });

  it('says once that something was fixed, which waits on nobody and is dismissed from the card', async () => {
    const { attentionItems, waitingCount } = await load();
    const items = attentionItems({
      now: NOW,
      gates: [],
      tasks: [],
      bots: BOTS,
      repos: REPOS,
      issues: ISSUES,
      requests: [],
      stallEvents: [],
      health: [
        healthRow({ id: 'webhook', checkId: 'webhook', state: 'ok', fixedAt: minutesAgo(2), fixedTitle: 'GitHub is delivering again' }),
        healthRow({ id: 'hostd', checkId: 'hostd', state: 'ok', fixedAt: minutesAgo(3), fixedTitle: 'OpenADLC’s host service is answering again', fixedDismissedAt: minutesAgo(1) }),
      ],
    });
    expect(items).toMatchObject([
      {
        id: 'fixed:webhook',
        kind: 'check_fixed',
        headline: 'GitHub is delivering again',
        actions: [{ kind: 'dismiss', label: 'Dismiss', checkId: 'webhook' }],
      },
    ]);
    expect(waitingCount(items)).toBe(0);
  });
  it('lets a person dismiss a notice with nothing to fix, until a newer occurrence arrives', async () => {
    const { attentionItems, waitingCount } = await load();
    const unsigned = (occurrence: string) =>
      healthRow({
        id: 'unattributed-post',
        checkId: 'unattributed-post',
        state: 'failing',
        severity: 'warning',
        title: 'A post by irisexampleco in janedoe/fleetadlc-testbed is not signed by OpenADLC',
        detail: 'The latest, a comment: it has no signature.',
        action: { label: 'Open the post', url: 'https://github.com/janedoe/fleetadlc-testbed/issues/3#issuecomment-1' },
        facts: { occurrence },
      });
    const read = (occurrence: string, acknowledged?: Map<string, Set<string>>) =>
      attentionItems({ now: NOW, gates: [], tasks: [], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [], health: [unsigned(occurrence)], acknowledged });

    const [card] = read('post:41');
    expect(card?.actions).toContainEqual({ kind: 'acknowledge', label: 'Dismiss', checkId: 'unattributed-post', occurrence: 'post:41' });

    // Dismissed: gone, and not counted.
    const seen = new Map([['unattributed-post', new Set(['post:41'])]]);
    expect(read('post:41', seen)).toEqual([]);
    expect(waitingCount(read('post:41', seen))).toBe(0);
    // A newer unsigned post brings it back.
    expect(read('post:42', seen)).toHaveLength(1);
  });

  it('stays dismissed when a newer post on it is resolved and an older one leads again', async () => {
    const { attentionItems } = await load();
    const card = (occurrences: string[]) =>
      attentionItems({
        now: NOW, gates: [], tasks: [], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [],
        health: [
          healthRow({
            id: 'unattributed-post',
            checkId: 'unattributed-post',
            state: 'failing',
            severity: 'warning',
            title: `${occurrences.length} posts by the crew's accounts are not signed by OpenADLC`,
            facts: { history: true, occurrence: occurrences[0], occurrences },
          }),
        ],
        acknowledged: new Map([['unattributed-post', new Set(['post:42', 'post:41'])]]),
      });
    // "This was me" on the two-post card covered both.
    expect(card(['post:42', 'post:41'])).toEqual([]);
    // 42 verified after all and was resolved: 41 leads, and it was already dismissed.
    expect(card(['post:41'])).toEqual([]);
    // A post nobody has seen brings it back.
    expect(card(['post:43', 'post:41'])).toHaveLength(1);
  });

  it('offers no Dismiss on a card that has something to fix', async () => {
    const { attentionItems } = await load();
    const items = attentionItems({
      now: NOW, gates: [], tasks: [], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [],
      health: [healthRow({ id: 'hostd', checkId: 'hostd', state: 'failing', title: 'OpenADLC’s host service is not answering' })],
    });
    expect(items[0]?.actions.map((action) => action.kind)).not.toContain('acknowledge');
  });
});

describe('a task’s reason, as a sentence', () => {
  it('keeps the first sentence, without the route it came through', async () => {
    const { shortReason } = await load();
    expect(shortReason('hostd refused: the model claude-opus-4 is not offered by this account. Pick another.')).toBe(
      'The model claude-opus-4 is not offered by this account.',
    );
    expect(shortReason('Claude Code 2.1.282 exited')).toBe('Claude Code 2.1.282 exited');
    expect(shortReason(null)).toBe('It stopped without saying why.');
    expect(shortReason('x'.repeat(300))).toHaveLength(178);
  });
});

/**
 * The route, over the store. The store is a fake that answers with one of each
 * kind, so what is checked is the wiring: the reads it makes and the shape it
 * answers with.
 */
const store = vi.hoisted(() => ({
  gates: [] as Record<string, unknown>[],
  tasks: [] as Record<string, unknown>[],
  since: null as Date | null,
  eventTypes: [] as string[],
  settings: {} as Record<string, string>,
}));

vi.mock('@fleetadlc/db', () => ({
  spendingLimits: {
    SPENDING_PROVIDERS: ['anthropic', 'openai', 'xai'],
    GLOBAL_SCOPE: 'global',
    seedGlobal: vi.fn(async () => false),
    effectiveTaskCap: vi.fn(async (_repoId: string | null, fallback: number) => fallback),
    amountOf: vi.fn(async () => null),
    refusal: vi.fn(async () => null),
    listLimits: vi.fn(async () => []),
    setLimit: vi.fn(async () => undefined),
    dollars: (amount: number) => (Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`),
    botKind: (id: string) => `month_bot:${id}`,
    providerKind: (provider: string) => `month_provider:${provider}`,
    repoScope: (id: string) => `repo:${id}`,
    repoIdOf: (scope: string) => (scope.startsWith('repo:') ? scope.slice(5) : null),
  },

  audit: vi.fn(async () => undefined),
  AccountInUse: class AccountInUse extends Error {},
  bots: { listBots: vi.fn(async () => BOTS) },
  costs: {},
  credentials: {},
  issues: { listIssues: vi.fn(async () => ISSUES) },
  leases: {},
  listAudit: vi.fn(),
  listEventsOfType: vi.fn(async (type: string, since: Date) => {
    store.eventTypes.push(type);
    store.since = since;
    // A stopped review loop's shape; a supersede's is another, and none is recorded here.
    if (type === 'design_memory.superseded') return [];
    return [{ at: '2026-09-24T11:20:00.000Z', payload: { repo: 'fleetadlc-testbed', pr: 29, issue: 11, rounds: 3 } }];
  }),
  mergeLines: {},
  modelAccounts: { list: vi.fn(async () => []) },
  recordEvent: vi.fn(),
  repos: { listRepos: vi.fn(async () => REPOS), getRepoByName: vi.fn(async () => null) },
  requests: { listRequests: vi.fn(async () => []) },
  sessions: {},
  settings: { allSettings: vi.fn(async () => store.settings) },
  tasks: {
    STOPPED_BY_PERSON: 'stopped by a person',
    listTasksSince: vi.fn(async () => store.tasks),
    getTask: vi.fn(async (id: string) =>
      id === 'task-old-gate'
        ? {
            id,
            botId: 'bot-intake',
            repoId: 'repo-1',
            kind: 'intake',
            subjectRef: 'fleetadlc-testbed#15',
            state: 'stopped',
            round: 0,
            costUsd: 0,
            startedAt: null,
            endedAt: null,
            exitReason: null,
            createdAt: '2026-09-01T00:00:00.000Z',
          }
        : null,
    ),
  },
  threads: { listOpenGates: vi.fn(async () => store.gates), listGatesForTasks: vi.fn(async () => []) },
}));

describe('GET /v1/attention', () => {
  let bridge: Server;
  let bridgeUrl: string;

  beforeEach(async () => {
    const { registerConsoleApi } = await import('./api.js');
    const { Router } = await import('./router.js');
    store.gates = [
      { id: 'gate-old', taskId: 'task-old-gate', question: 'Still there?', options: [], githubCommentUrl: null, createdAt: '2026-09-01T00:00:00.000Z' },
    ];
    store.tasks = [];
    store.eventTypes = [];
    store.settings = {};
    const router = new Router();
    registerConsoleApi(router, {
      config: { gitHubClientId: '', webhookSecret: '', humans: [] } as never,
      hostd: {} as never,
      actors: {} as never,
      invitations: {} as never,
      automation: {} as never,
      gates: {} as never,
      taskService: {} as never,
      threadStream: { subscribe: () => () => undefined, watching: 0 } as never,
      onboarding: {} as never,
      webhookSetup: {} as never,
      repoSetup: {} as never,
    });
    bridge = createServer((request, response) => void router.handle(request, response));
    await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
    bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
  });

  it('reads a failed engine update from the settings the update wrote', async () => {
    store.gates = [];
    store.settings = {
      engineUpdateLast: JSON.stringify({ state: 'failed', reason: 'The candidate image did not build.', finishedAt: '2026-09-24T10:00:00.000Z' }),
    };
    const body = (await (await fetch(`${bridgeUrl}/v1/attention`)).json()) as { items: { id: string; kind: string; actions: unknown[] }[] };
    expect(body.items.map((item) => item.kind)).toContain('engine_update_failed');
    expect(body.items.find((item) => item.kind === 'engine_update_failed')?.actions).toEqual([
      { kind: 'open_page', label: 'See the engine updates', href: '/settings#engine-updates' },
    ]);
  });

  it('answers with each thing waiting, the stopped review loops read from their event', async () => {
    const response = await fetch(`${bridgeUrl}/v1/attention`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: { id: string; kind: string; bot: { name: string } | null }[] };

    // And the send-backs a person has to take, the issues intake stopped
    // trying, and the design memory a design superseded, which this store has
    // none of.
    expect(store.eventTypes).toEqual(['review.stalled', 'send_back.stalled', 'send_back.to_person', 'intake.stalled', 'design_memory.superseded']);
    expect(body.items.map((item) => item.id)).toEqual(['stall:fleetadlc-testbed#29', 'gate:gate-old']);
    // A gate older than the week is still a gate: its task is read on its own.
    expect(body.items[1]).toMatchObject({ kind: 'question', bot: { name: 'ottoexampleco' } });
  });
});

describe('a design that superseded what a repository had decided', () => {
  it('is a notice on the issue: what replaced what, links to the comment and to Settings, and nothing to do', async () => {
    const { attentionItems } = await load();
    const [item] = attentionItems({
      now: NOW, gates: [], tasks: [], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [],
      designMemoryEvents: [
        {
          at: minutesAgo(5),
          payload: {
            repo: 'fleetadlc-testbed',
            issue: 11,
            by: 'system-engineer, unopposed at the move to build',
            commentUrl: 'https://github.com/janedoe/fleetadlc-testbed/issues/11#issuecomment-9',
            replaced: [{ id: 'a', title: 'Never log credentials', byId: 'b', byTitle: 'Log what helps' }],
          },
        },
      ],
    });
    expect(item).toMatchObject({
      kind: 'design_memory_superseded',
      group: 'work',
      headline: 'The design memory of fleetadlc-testbed changed',
      subject: { number: 11 },
      bot: null,
    });
    expect(item?.detail).toContain('“Log what helps” replaces “Never log credentials”');
    expect(item?.actions).toEqual([
      { kind: 'open_url', label: 'On GitHub', url: 'https://github.com/janedoe/fleetadlc-testbed/issues/11#issuecomment-9' },
      { kind: 'open_page', label: 'Design memory', href: '/settings/repositories/fleetadlc-testbed#fleetadlc-testbed-memory' },
    ]);
  });
});

describe('a card about history', () => {
  it('offers its own Dismiss first, its actions, What to do for an incident, and no Check again', async () => {
    const { attentionItems } = await load();
    const [card] = attentionItems({
      now: NOW, gates: [], tasks: [], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [],
      health: [
        healthRow({
          id: 'unattributed-post',
          checkId: 'unattributed-post',
          state: 'failing',
          severity: 'warning',
          title: 'A review on janedoe/fleetadlc-testbed#31 by irisexampleco is not signed by OpenADLC',
          detail: 'It counted.',
          action: { label: 'Open the post', url: 'https://github.com/janedoe/fleetadlc-testbed/pull/31#pullrequestreview-7' },
          facts: {
            history: true,
            occurrence: 'post:41',
            dismissLabel: 'This was me',
            actions: [{ label: 'Reconnect the account', href: '/settings#github-accounts' }, { nonsense: true }],
            incident: { repo: 'janedoe/fleetadlc-testbed', did: 'review', counted: true },
          },
        }),
      ],
    });
    expect(card?.actions).toEqual([
      { kind: 'acknowledge', label: 'This was me', checkId: 'unattributed-post', occurrence: 'post:41' },
      { kind: 'open_url', label: 'Open the post', url: 'https://github.com/janedoe/fleetadlc-testbed/pull/31#pullrequestreview-7' },
      { kind: 'open_page', label: 'Reconnect the account', href: '/settings#github-accounts' },
      { kind: 'incident', label: 'What to do' },
    ]);
    expect(card?.incident).toMatchObject({ did: 'review', counted: true });
  });

  it('is dismissed for when it started failing when its check names no occurrence', async () => {
    const { attentionItems } = await load();
    const row = healthRow({ id: 'old-news', checkId: 'old-news', state: 'failing', title: 'Something happened', facts: { history: true } });
    const [card] = attentionItems({ now: NOW, gates: [], tasks: [], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [], health: [row] });
    expect(card?.actions).toEqual([{ kind: 'acknowledge', label: 'Dismiss', checkId: 'old-news', occurrence: `since:${row.failingSince}` }]);
  });
});

describe('which group an item is in', () => {
  it('is work for what the crew needs to go on, and system for what the install needs', async () => {
    const { attentionItems, groupOf } = await load();
    expect(['question', 'review_stalled', 'task_failed', 'triage_failed'].map((kind) => groupOf(kind as never))).toEqual(['work', 'work', 'work', 'work']);
    expect(['check_failed', 'check_fixed', 'engine_update_failed'].map((kind) => groupOf(kind as never))).toEqual(['system', 'system', 'system']);

    const failed = task({ id: 'task-failed', botId: 'bot-builder', kind: 'implement', subjectRef: 'fleetadlc-testbed#16', state: 'failed', endedAt: minutesAgo(40), exitReason: 'engine exited 1' });
    const items = attentionItems({
      now: NOW, gates: [], tasks: [failed], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [],
      health: [healthRow({ id: 'hostd', checkId: 'hostd', state: 'failing', title: 'OpenADLC’s host service is not answering' })],
    });
    expect(items.map((item) => [item.kind, item.group])).toEqual(
      expect.arrayContaining([
        ['task_failed', 'work'],
        ['check_failed', 'system'],
      ]),
    );
    expect(items.every((item) => item.group)).toBe(true);
  });
});

describe('a card on work that is over', () => {
  const run = async (tasks: TaskFacts[], extra: Record<string, unknown> = {}) => {
    const { attentionItems } = await load();
    return attentionItems({ now: NOW, gates: [], tasks, bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [], ...extra });
  };

  it('is none for a task a person stopped from its thread, which kills its session', async () => {
    // Stopping the second reviewer on a merged issue from its thread left a "was
    // stopped before finishing" card: hostd writes this reason, not the card's.
    const stopped = task({
      botId: 'bot-sre',
      kind: 'deploy',
      subjectRef: 'fleetadlc-testbed#31',
      state: 'stopped',
      endedAt: minutesAgo(3),
      exitReason: 'stopped by a person (janedoe@example.com): its session was killed',
    });
    expect(await run([stopped])).toEqual([]);
  });

  it('is none for a task a person’s answer ended', async () => {
    const ended = [
      'plan change refused by alexsmith',
      'stopped at the cost cap: abandon (alexsmith)',
      'already landed: fleetadlc-testbed#15 is closed, so the work it was for is finished',
    ].map((exitReason) => task({ botId: 'bot-builder', kind: 'implement', subjectRef: 'fleetadlc-testbed#16', state: 'stopped', endedAt: minutesAgo(3), exitReason }));
    expect(await run(ended)).toEqual([]);
  });

  it('is said under recovered, not as a card, when its pull request has merged or closed', async () => {
    const failed = task({
      id: 'task-merged',
      botId: 'bot-second',
      kind: 'review',
      subjectRef: 'fleetadlc-testbed#184',
      state: 'failed',
      endedAt: minutesAgo(30),
      exitReason: 'GitHub said: Bad credentials',
    });

    const items = await run([failed], { closed: new Set(['fleetadlc-testbed#184']) });

    expect(items).toEqual([
      expect.objectContaining({
        id: 'landed:task-merged',
        kind: 'check_fixed',
        group: 'system',
        headline: 'fleetadlc-testbed#184 landed or was closed, so the second reviewer (irisexampleco) no longer has to finish its review',
        actions: [{ kind: 'dismiss_task', label: 'Dismiss', tasks: [{ taskId: 'task-merged', occurrence: minutesAgo(30) }] }],
      }),
    ]);
  });

  it('is gone altogether when the work landed and the failure is more than a day old', async () => {
    const failed = task({ botId: 'bot-intake', kind: 'intake', subjectRef: 'fleetadlc-testbed#176', state: 'failed', endedAt: daysAgo(2), exitReason: 'model gone' });
    expect(await run([failed], { closed: new Set(['fleetadlc-testbed#176']) })).toEqual([]);
  });

  it('is still a card while the subject is open, and for a deploy of a merged pull request', async () => {
    const review = task({ botId: 'bot-second', kind: 'review', subjectRef: 'fleetadlc-testbed#185', state: 'failed', endedAt: minutesAgo(30), exitReason: 'model gone' });
    const deploy = task({ botId: 'bot-sre', kind: 'deploy', subjectRef: 'fleetadlc-testbed#186', state: 'failed', endedAt: minutesAgo(20), exitReason: 'the deploy workflow failed' });

    const items = await run([review, deploy], { closed: new Set(['fleetadlc-testbed#186']) });

    expect(items.map((item) => [item.kind, item.subject.ref])).toEqual([
      ['task_failed', 'fleetadlc-testbed#186'],
      ['task_failed', 'fleetadlc-testbed#185'],
    ]);
  });
});

describe('a failure on a spend limit', () => {
  const LIMIT = 'engine exited 1: You’ve hit your org’s monthly spend limit. Raise it in the console.';
  const onAccount = BOTS.map((bot) => (bot.id === 'bot-second' || bot.id === 'bot-lead' ? { ...bot, modelAccountId: 'acct-1' } : bot));
  const run = async (tasks: TaskFacts[]) => {
    const { attentionItems } = await load();
    return attentionItems({ now: NOW, gates: [], tasks, bots: onAccount, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [] });
  };
  const hit = () =>
    task({ botId: 'bot-second', kind: 'review', subjectRef: 'fleetadlc-testbed#29', state: 'failed', startedAt: minutesAgo(600), endedAt: minutesAgo(590), exitReason: LIMIT });

  it('is a card while nothing on the account has run since', async () => {
    expect((await run([hit()])).map((item) => item.kind)).toEqual(['task_failed']);
  });

  it('stays, saying it can be tried again, when another task on the account ran since but the work did not', async () => {
    // Nothing runs a model-account failure again by itself: the review of #29
    // would stall with nothing on the board.
    const later = task({ botId: 'bot-lead', kind: 'review', subjectRef: 'fleetadlc-testbed#31', state: 'done', startedAt: minutesAgo(60), endedAt: minutesAgo(30) });
    const items = await run([hit(), later]);
    expect(items.map((item) => [item.kind, item.subject.ref])).toEqual([['task_failed', 'fleetadlc-testbed#11']]);
    expect(items[0]?.headline).toBe('The second reviewer (irisexampleco) could not finish its review; its model account has worked since, so it can be tried again');
  });

  it('clears once the account worked again and a later task on the same subject started', async () => {
    const later = task({ botId: 'bot-lead', kind: 'review', subjectRef: 'fleetadlc-testbed#31', state: 'done', startedAt: minutesAgo(60), endedAt: minutesAgo(30) });
    const again = task({ botId: 'bot-builder', kind: 'patch', subjectRef: 'fleetadlc-testbed#29', state: 'running', startedAt: minutesAgo(20) });
    expect((await run([hit(), later, again])).filter((item) => item.kind === 'task_failed')).toEqual([]);
  });

  it('clears once the account worked again and its subject closed', async () => {
    const { attentionItems } = await load();
    const later = task({ botId: 'bot-lead', kind: 'review', subjectRef: 'fleetadlc-testbed#31', state: 'done', startedAt: minutesAgo(60), endedAt: minutesAgo(30) });
    const deploy = task({ botId: 'bot-sre', kind: 'deploy', subjectRef: 'fleetadlc-testbed#29', state: 'failed', startedAt: minutesAgo(600), endedAt: minutesAgo(590), exitReason: LIMIT });
    const onSre = onAccount.map((bot) => (bot.id === 'bot-sre' ? { ...bot, modelAccountId: 'acct-1' } : bot));
    const input = { now: NOW, gates: [], bots: onSre, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [], testingDeploy: true };
    // Open: still a card. Closed: its work is over.
    expect((await attentionItems({ ...input, tasks: [deploy, later] })).map((item) => item.kind)).toEqual(['task_failed']);
    expect(attentionItems({ ...input, tasks: [deploy, later], closed: new Set(['fleetadlc-testbed#29']) })).toEqual([]);
  });

  it('keeps a later task on the subject from clearing it while the account still fails', async () => {
    const again = task({ botId: 'bot-builder', kind: 'patch', subjectRef: 'fleetadlc-testbed#29', state: 'running', startedAt: minutesAgo(20) });
    expect((await run([hit(), again])).map((item) => item.kind)).toEqual(['task_failed']);
  });

  it('stays while the task since failed on the limit too, or ran on another account', async () => {
    const again = task({
      botId: 'bot-lead',
      kind: 'review',
      subjectRef: 'fleetadlc-testbed#40',
      state: 'failed',
      startedAt: minutesAgo(60),
      endedAt: minutesAgo(59),
      exitReason: LIMIT,
    });
    const elsewhere = task({ botId: 'bot-builder', kind: 'implement', subjectRef: 'fleetadlc-testbed#16', state: 'running', startedAt: minutesAgo(60) });
    const items = await run([hit(), again, elsewhere]);
    expect(items.flatMap((item) => [item.id, ...(item.members ?? []).map((member) => member.id)]).filter((id) => id.startsWith('task:'))).toHaveLength(2);
  });
});

describe('dismissing a failed task’s card', () => {
  const failed = () =>
    task({ id: 'task-dismissed', botId: 'bot-builder', kind: 'implement', subjectRef: 'fleetadlc-testbed#16', state: 'failed', endedAt: minutesAgo(30), exitReason: 'model gone' });
  const run = async (acknowledged: Map<string, Set<string>>) => {
    const { attentionItems } = await load();
    return attentionItems({ now: NOW, gates: [], tasks: [failed()], bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [], acknowledged });
  };

  it('takes it off for the ending it was dismissed at', async () => {
    expect(await run(new Map([['task:task-dismissed', new Set([minutesAgo(30)])]]))).toEqual([]);
  });

  it('brings it back when the task ends again, later', async () => {
    const items = await run(new Map([['task:task-dismissed', new Set([minutesAgo(300)])]]));
    expect(items.map((item) => item.id)).toEqual(['task:task-dismissed']);
  });
});

describe('which subjects have closed', () => {
  it('asks GitHub once, keeps a closed one, and counts one it cannot read as open', async () => {
    const { ClosedSubjects } = await load();
    let now = 0;
    const getIssue = vi.fn(async (_repo: string, number: number) => {
      if (number === 3) throw new Error('GitHub is down');
      return { state: number === 1 ? ('closed' as const) : ('open' as const) };
    });
    const closed = new ClosedSubjects({
      client: async () => ({ getIssue }) as never,
      fullName: async (name) => `janedoe/${name}`,
      now: () => now,
    });

    expect([...(await closed.lookup(['fleetadlc-testbed#1', 'fleetadlc-testbed#2', 'fleetadlc-testbed#3']))]).toEqual(['fleetadlc-testbed#1']);
    expect(getIssue).toHaveBeenCalledWith('janedoe/fleetadlc-testbed', 1);
    expect(getIssue).toHaveBeenCalledTimes(3);

    now = 5 * 60 * 1000;
    await closed.lookup(['fleetadlc-testbed#1', 'fleetadlc-testbed#2']);
    // Both are kept: an open one asked about every two minutes, for every
    // card, spent the automation account's hourly limit.
    expect(getIssue).toHaveBeenCalledTimes(3);

    now = 11 * 60 * 1000;
    await closed.lookup(['fleetadlc-testbed#1', 'fleetadlc-testbed#2']);
    // Kept for about ten minutes, then asked again, so a reopen can show the card.
    expect(getIssue).toHaveBeenCalledTimes(5);
  });
});

describe('a deploy or QA card on work that shipped', () => {
  const run = async (tasks: TaskFacts[], extra: Record<string, unknown> = {}) => {
    const { attentionItems } = await load();
    return attentionItems({ now: NOW, gates: [], tasks, bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [], ...extra });
  };
  const deploy = (partial: Partial<TaskFacts> = {}) =>
    task({
      id: 'task-deploy',
      botId: 'bot-sre',
      kind: 'deploy',
      subjectRef: 'fleetadlc-testbed#193',
      state: 'failed',
      createdAt: minutesAgo(120),
      endedAt: minutesAgo(100),
      exitReason: 'the deploy workflow failed',
      ...partial,
    });

  it('is said under recovered once a later deploy of the repository finished', async () => {
    const later = task({ botId: 'bot-sre', kind: 'deploy', subjectRef: 'fleetadlc-testbed#199', state: 'done', createdAt: minutesAgo(50), endedAt: minutesAgo(40) });
    const items = await run([deploy(), later]);
    expect(items).toEqual([expect.objectContaining({ id: 'landed:task-deploy', kind: 'check_fixed' })]);
    expect(items[0]?.headline).toBe('A later deploy finished, so fleetadlc-testbed#193 no longer waits on the deploy that stopped');
  });

  it('leaves a QA card when a later deploy finished: that deploy did not check what QA failed on', async () => {
    const qa = deploy({ id: 'task-qa', kind: 'qa', exitReason: 'the checkout page did not load' });
    const later = task({ botId: 'bot-sre', kind: 'deploy', subjectRef: 'fleetadlc-testbed#199', state: 'done', createdAt: minutesAgo(50), endedAt: minutesAgo(40) });
    expect((await run([qa, later])).map((item) => item.id)).toEqual(['task:task-qa']);
    // It still goes when its pull request is closed and its repository ships
    // by merging. The install's testing URL no longer says so for a task on a
    // repository: that variable is empty where repositories declare their own.
    const landed = await run([qa], { closed: new Set(['fleetadlc-testbed#193']), testingDeploy: false, shipsByMerging: new Set(['repo-1']) });
    expect(landed.map((item) => item.id)).toEqual(['landed:task-qa']);
    expect(landed[0]?.headline).toBe('fleetadlc-testbed#193 is closed and nothing deploys it to testing, so there is no need for the checks');
  });

  it('stays a card when QA on a merged pull request failed and its repository deploys to testing', async () => {
    // As `verifyOnTesting` opens it: only once the testing deploy succeeded.
    // The install has no testing URL, as one whose repositories declare their
    // own testing deploy has none; this repository is not shipping by merging.
    const qa = deploy({ id: 'task-qa', kind: 'qa', exitReason: 'the checkout page did not load' });
    const closed = new Set(['fleetadlc-testbed#193']);
    const items = await run([qa], { closed, testingDeploy: false, shipsByMerging: new Set<string>() });
    expect(items.map((item) => item.id)).toEqual(['task:task-qa']);
    // The same task where merging is shipping is said under recovered.
    expect((await run([qa], { closed, testingDeploy: false, shipsByMerging: new Set(['repo-1']) })).map((item) => item.id)).toEqual(['landed:task-qa']);
  });

  it('stays when the later deploy failed too, or the finished one came before it', async () => {
    const failedToo = task({ botId: 'bot-sre', kind: 'deploy', subjectRef: 'fleetadlc-testbed#199', state: 'failed', createdAt: minutesAgo(50), endedAt: minutesAgo(40), exitReason: 'no' });
    const earlier = task({ botId: 'bot-sre', kind: 'deploy', subjectRef: 'fleetadlc-testbed#150', state: 'done', createdAt: minutesAgo(500), endedAt: minutesAgo(490) });
    const items = await run([deploy(), failedToo, earlier]);
    expect(items.flatMap((item) => [item.id, ...(item.members ?? []).map((member) => member.id)])).toContain('task:task-deploy');
  });

  it('is said under recovered when nothing deploys to testing and its pull request is closed', async () => {
    const closed = new Set(['fleetadlc-testbed#193']);
    // The install's testing URL decides only for a task with no repository.
    const orphan = deploy({ repoId: null });
    expect((await run([orphan], { closed, testingDeploy: false })).map((item) => item.id)).toEqual(['landed:task-deploy']);
    // With a testing deploy, a merged pull request is where its work starts.
    expect((await run([orphan], { closed, testingDeploy: true })).map((item) => item.id)).toEqual(['task:task-deploy']);
    // And while its pull request is open, it is news either way.
    expect((await run([orphan], { testingDeploy: false })).map((item) => item.id)).toEqual(['task:task-deploy']);
    // A task on a repository goes by that repository, whatever the install says.
    expect((await run([deploy()], { closed, testingDeploy: false })).map((item) => item.id)).toEqual(['task:task-deploy']);
  });

  it('is said under recovered when its repository ships by merging, though the install deploys to testing', async () => {
    const closed = new Set(['fleetadlc-testbed#193']);
    const none = new Set(['repo-1']);
    expect((await run([deploy()], { closed, testingDeploy: true, shipsByMerging: none })).map((item) => item.id)).toEqual(['landed:task-deploy']);
    // Another repository shipping by merging says nothing about this one.
    expect((await run([deploy()], { closed, testingDeploy: true, shipsByMerging: new Set(['repo-2']) })).map((item) => item.id)).toEqual(['task:task-deploy']);
    // While its pull request is open, it is still news.
    expect((await run([deploy()], { testingDeploy: true, shipsByMerging: none })).map((item) => item.id)).toEqual(['task:task-deploy']);
  });
});

describe('an end a person’s answer asked for', () => {
  const run = async (tasks: TaskFacts[], asked: unknown[]) => {
    const { attentionItems } = await load();
    return attentionItems({ now: NOW, gates: [], tasks, bots: BOTS, repos: REPOS, issues: ISSUES, requests: [], stallEvents: [], asked: asked as never });
  };
  // The SRE told to stop on #193 ended as "the session was killed".
  const killed = () =>
    task({ id: 'task-sre', botId: 'bot-sre', kind: 'deploy', subjectRef: 'fleetadlc-testbed#193', state: 'stopped', endedAt: minutesAgo(10), exitReason: 'the session was killed' });
  const gate = (answer: string | null, answeredAt: string | null, createdAt = minutesAgo(30), taskId = 'task-sre') => ({ id: `gate-${createdAt}`, taskId, answer, answeredAt, createdAt });

  it('is no card when the task’s last question was answered with a stop just before it ended', async () => {
    for (const answer of [
      'No, stop here',
      'Leave it unposted',
      'stop',
      'Abandon',
      'yes, stop and report skipped deploys',
      'no, leave this merge undeployed to testing',
      '2 — stop this round without changes',
      'Cancel',
      "don't deploy",
    ]) {
      expect(await run([killed()], [gate(answer, minutesAgo(12))])).toEqual([]);
    }
  });

  it('is a card when the answer said go on, came long before, or a later question followed it', async () => {
    const ids = async (asked: unknown[]) => (await run([killed()], asked)).map((item) => item.id);
    expect(await ids([gate('Yes, deploy it', minutesAgo(12))])).toEqual(['task:task-sre']);
    expect(await ids([gate('stop', minutesAgo(200))])).toEqual(['task:task-sre']);
    expect(await ids([gate('stop', minutesAgo(25)), gate(null, null, minutesAgo(20))])).toEqual(['task:task-sre']);
    expect(await ids([gate('stop', minutesAgo(12), minutesAgo(30), 'task-other')])).toEqual(['task:task-sre']);
  });

  it('is a card when the answer only mentions stopping, or says not to', async () => {
    for (const answer of [
      "Don't stop, keep going",
      'Go on, but stop before production',
      'Cancel the old run and try again',
      'Leave it running',
      'Leave it held',
      'not stop yet',
    ]) {
      expect((await run([killed()], [gate(answer, minutesAgo(12))])).map((item) => item.id), answer).toEqual(['task:task-sre']);
    }
  });

  it('reads a long answer that is not a stop in a moment', async () => {
    // Two runs of spaces side by side took seconds on this, on every read of Needs you.
    const answer = `yes${' '.repeat(40_000)}x`;
    const started = performance.now();
    expect((await run([killed()], [gate(answer, minutesAgo(12))])).map((item) => item.id)).toEqual(['task:task-sre']);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('is a card when the task failed on its own error after a stop answer', async () => {
    // Found live: "stop without posting", then hostd refused the resume.
    const refused = task({
      id: 'task-sre',
      botId: 'bot-sre',
      kind: 'deploy',
      subjectRef: 'fleetadlc-testbed#193',
      state: 'failed',
      endedAt: minutesAgo(10),
      exitReason: 'hostd refused: POST http://hostd/tasks/task-sre/resume → 500',
    });
    expect((await run([refused], [gate('stop without posting', minutesAgo(11))])).map((item) => item.id)).toEqual(['task:task-sre']);
  });

  it('is a card when "Leave it held" came before a spend-limit failure', async () => {
    // Found live: an answer that holds the work, then the account ran out.
    const limit = task({
      id: 'task-sre',
      botId: 'bot-intake',
      kind: 'intake',
      subjectRef: 'fleetadlc-testbed#15',
      state: 'failed',
      endedAt: minutesAgo(10),
      exitReason: 'engine exited 1: You’ve hit your org’s monthly spend limit · ask your admin to raise it',
    });
    expect((await run([limit], [gate('Leave it held', minutesAgo(11))])).map((item) => item.id)).toEqual(['task:task-sre']);
  });

  it('is a card when the task was stopped some other way than its session going', async () => {
    const shutdown = task({ id: 'task-sre', botId: 'bot-sre', kind: 'deploy', subjectRef: 'fleetadlc-testbed#193', state: 'stopped', endedAt: minutesAgo(10), exitReason: 'hostd shutting down' });
    expect((await run([shutdown], [gate('stop', minutesAgo(12))])).map((item) => item.id)).toEqual(['task:task-sre']);
  });
});

describe('which subjects have closed, over time', () => {
  it('reads a batch side by side, and forgets the oldest past its bound', async () => {
    const { ClosedSubjects } = await load();
    let inFlight = 0;
    let most = 0;
    const getIssue = vi.fn(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { state: 'closed' as const };
    });
    const fullName = vi.fn(async (name: string) => `janedoe/${name}`);
    const closed = new ClosedSubjects({ client: async () => ({ getIssue }) as never, fullName, now: () => 0 });

    const refs = Array.from({ length: 20 }, (_, index) => `fleetadlc-testbed#${index + 1}`);
    expect((await closed.lookup(refs)).size).toBe(20);
    expect(most).toBeGreaterThan(1);
    // One repository's name is read once for the batch.
    expect(fullName).toHaveBeenCalledTimes(1);

    for (let start = 21; start <= 1020; start += 20) {
      await closed.lookup(Array.from({ length: 20 }, (_, index) => `fleetadlc-testbed#${start + index}`));
    }
    getIssue.mockClear();
    await closed.lookup(['fleetadlc-testbed#1', 'fleetadlc-testbed#1020']);
    // The first was forgotten; the last is still kept.
    expect(getIssue).toHaveBeenCalledTimes(1);
    expect(getIssue).toHaveBeenCalledWith('janedoe/fleetadlc-testbed', 1);
  });
});

describe('reading what the stopped tasks asked', () => {
  it('asks once for every task whose session went away, and for none that failed', async () => {
    const { readAttention } = await load();
    store.gates = [];
    store.tasks = [
      task({ id: 'task-killed-1', botId: 'bot-sre', kind: 'deploy', subjectRef: 'fleetadlc-testbed#193', state: 'stopped', endedAt: minutesAgo(10), exitReason: 'the session was killed; the branch and the issue are untouched' }),
      task({ id: 'task-killed-2', botId: 'bot-sre', kind: 'deploy', subjectRef: 'fleetadlc-testbed#201', state: 'stopped', endedAt: minutesAgo(10), exitReason: 'the session was killed; the branch and the issue are untouched' }),
      task({ id: 'task-failed', botId: 'bot-second', kind: 'review', subjectRef: 'fleetadlc-testbed#202', state: 'failed', endedAt: minutesAgo(10), exitReason: 'hostd refused' }),
    ].map((one) => ({ ...one }));
    const gatesFor = vi.fn(async () => [{ id: 'gate-1', taskId: 'task-killed-1', answer: 'no, stop here', answeredAt: minutesAgo(11), createdAt: minutesAgo(20) }]);

    const input = await readAttention(NOW, { gatesFor });

    expect(gatesFor).toHaveBeenCalledTimes(1);
    expect(gatesFor).toHaveBeenCalledWith(['task-killed-1', 'task-killed-2']);
    expect(input.asked).toHaveLength(1);
  });

  it('shows the cards when that read fails', async () => {
    const { readAttention } = await load();
    store.gates = [];
    store.tasks = [task({ id: 'task-killed-1', botId: 'bot-sre', kind: 'deploy', subjectRef: 'fleetadlc-testbed#193', state: 'stopped', endedAt: minutesAgo(10), exitReason: 'the session was killed' })].map((one) => ({ ...one }));
    const input = await readAttention(NOW, { gatesFor: async () => Promise.reject(new Error('database gone')) });
    expect(input.asked).toEqual([]);
  });
});

describe('reading which subjects have closed', () => {
  it('asks GitHub only about the tasks that could still be a card', async () => {
    const { readAttention, STOPPED_BY_A_PERSON } = await load();
    store.gates = [];
    store.tasks = [
      task({ id: 'task-failed', botId: 'bot-second', kind: 'review', subjectRef: 'fleetadlc-testbed#202', state: 'failed', endedAt: minutesAgo(10), exitReason: 'hostd refused' }),
      // Stopped by a person: never a card, whether its pull request closed or not.
      task({ id: 'task-stopped', botId: 'bot-second', kind: 'review', subjectRef: 'fleetadlc-testbed#203', state: 'stopped', endedAt: minutesAgo(10), exitReason: `${STOPPED_BY_A_PERSON} janedoe: a new push` }),
    ].map((one) => ({ ...one }));
    const closed = vi.fn(async () => new Set(['fleetadlc-testbed#202']));

    const input = await readAttention(NOW, { closed });

    expect(closed).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledWith(['fleetadlc-testbed#202']);
    expect([...(input.closed ?? [])]).toEqual(['fleetadlc-testbed#202']);
  });
});

describe('reading which repositories ship by merging', () => {
  it('asks only about the repositories of a deploy or QA task that did not finish', async () => {
    const { readAttention } = await load();
    store.gates = [];
    store.tasks = [
      task({ id: 'task-deploy', botId: 'bot-sre', kind: 'deploy', subjectRef: 'fleetadlc-testbed#193', state: 'failed', endedAt: minutesAgo(10), exitReason: 'the deploy workflow failed' }),
    ].map((one) => ({ ...one }));
    const shipsByMerging = vi.fn(async () => true);

    const input = await readAttention(NOW, { shipsByMerging });

    expect(shipsByMerging).toHaveBeenCalledTimes(1);
    expect(shipsByMerging).toHaveBeenCalledWith(expect.objectContaining({ id: 'repo-1' }));
    expect([...(input.shipsByMerging ?? [])]).toEqual(['repo-1']);
  });

  it('keeps the card when that could not be told', async () => {
    const { readAttention } = await load();
    store.gates = [];
    store.tasks = [
      task({ id: 'task-deploy', botId: 'bot-sre', kind: 'deploy', subjectRef: 'fleetadlc-testbed#193', state: 'failed', endedAt: minutesAgo(10), exitReason: 'the deploy workflow failed' }),
    ].map((one) => ({ ...one }));
    const input = await readAttention(NOW, { shipsByMerging: async () => Promise.reject(new Error('GitHub down')) });
    expect([...(input.shipsByMerging ?? [])]).toEqual([]);
  });
});
