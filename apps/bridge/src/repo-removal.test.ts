import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Taking a repository out of OpenADLC in one flow: what it says before
 * anything happens, what it ends, what it takes away when asked, and what it
 * lists when a step could not be done.
 */

vi.mock('@fleetadlc/db', () => ({
  audit: vi.fn(async () => undefined),
  bots: { listBots: vi.fn() },
  leases: { listActiveLeases: vi.fn(), releaseForRepo: vi.fn() },
  repos: { getRepoByName: vi.fn(), removeRepo: vi.fn() },
  tasks: { listTasks: vi.fn() },
  threads: { listOpenGatesInRepo: vi.fn(), expireEndedGatesInRepo: vi.fn() },
}));

import { audit, bots, leases, repos, tasks, threads } from '@fleetadlc/db';
import { GitHubApiError } from '@fleetadlc/github';
import {
  DEFAULT_REMOVAL,
  LEFT_ALONE,
  RepoRemoval,
  appStanding,
  configuredLabelNames,
  removalGitHub,
  sortLabels,
  type RemovalGitHub,
  type RepoRemovalDeps,
} from './repo-removal.js';

/** The labels setting up a repository makes, read from this checkout's `config/labels.json`. */
const CONFIGURED = configuredLabelNames(fileURLToPath(new URL('../../../', import.meta.url)));

const REPO = { id: 'repo-app', name: 'app', fullName: 'janedoe/app', color: 'blue', removedAt: null };
const REMOVED = { ...REPO, removedAt: '2026-09-30T10:00:00.000Z' };

const CREW = [
  { id: 'bot-intake', name: 'ottoexampleco', githubLogin: 'ottoexampleco' },
  { id: 'bot-builder', name: 'fleetadlc-atlas-janedoe', githubLogin: 'fleetadlc-atlas-janedoe' },
  // A second seat on the builder's account: one account, one removal.
  { id: 'bot-builder-2', name: 'builder-2', githubLogin: 'FleetADLC-Atlas-Janedoe' },
  { id: 'bot-reviewer', name: 'irisexampleco', githubLogin: 'irisexampleco' },
  { id: 'bot-new', name: 'second-reviewer', githubLogin: null },
];

const PAUSED = { id: 'task-paused', botId: 'bot-intake', repoId: 'repo-app', kind: 'intake', state: 'paused', subjectRef: 'app#12' };
const RUNNING = { id: 'task-running', botId: 'bot-builder', repoId: 'repo-app', kind: 'implement', state: 'running', subjectRef: 'app#14' };
const ELSEWHERE = { id: 'task-other', botId: 'bot-builder', repoId: 'repo-other', kind: 'implement', state: 'running', subjectRef: 'other#1' };

const GATE = { id: 'gate-1', taskId: 'task-paused', question: 'Which database?', subjectRef: 'app#12' };
const LEASE = { id: 'lease-14', repoId: 'repo-app', issueNumber: 14, botId: 'bot-builder', state: 'in_task' };

/** GitHub as the app, recording what was asked of it. */
function fakeGitHub(overrides: Partial<RemovalGitHub> = {}) {
  const calls: string[] = [];
  const github: RemovalGitHub = {
    collaborators: vi.fn(async () => ['janedoe', 'fleetadlc-atlas-janedoe', 'irisexampleco']),
    removeCollaborator: vi.fn(async (login: string) => void calls.push(`remove ${login}`)),
    cancelInvitation: vi.fn(async (id: number) => void calls.push(`cancel ${id}`)),
    labels: vi.fn(async () => ['adlc:build', 'priority:p1', 'bug', 'area:general', 'fleetadlc:ignore', 'Size:large', 'priority:high', 'blocked', 'sdlc:build']),
    deleteLabel: vi.fn(async (name: string) => void calls.push(`delete ${name}`)),
    ...overrides,
  };
  return { github, calls };
}

function removal(github: RemovalGitHub, overrides: Partial<RepoRemovalDeps> = {}) {
  const stop = vi.fn(async (_taskId: string, _actor: string, _note: string) => ({ state: 'stopped', questionsClosed: _taskId === 'task-paused' ? 1 : 0 }));
  const crewAccess = {
    view: vi.fn(() => ({ bots: [{ bot: 'irisexampleco', login: 'irisexampleco', state: 'in' }] })) as never,
    forget: vi.fn(),
  };
  const deps: RepoRemovalDeps = {
    stop,
    github: vi.fn(async () => github),
    invitations: vi.fn(async () => ({ pending: [{ id: 41, invitee: 'ottoexampleco', repository: 'janedoe/app', expired: false }], reason: null })),
    crewAccess,
    app: vi.fn(async () => ({ allRepositories: true, settingsUrl: 'https://github.com/settings/installations/7', reason: null })),
    labelNames: () => CONFIGURED,
    ...overrides,
  };
  return { flow: new RepoRemoval(deps), stop, crewAccess, deps };
}

beforeEach(() => {
  vi.mocked(audit).mockClear();
  vi.mocked(bots.listBots).mockResolvedValue(CREW as never);
  vi.mocked(repos.getRepoByName).mockResolvedValue(REPO as never);
  vi.mocked(repos.removeRepo).mockReset().mockResolvedValue(REMOVED as never);
  vi.mocked(tasks.listTasks).mockReset().mockResolvedValue([PAUSED, RUNNING, ELSEWHERE] as never);
  vi.mocked(threads.listOpenGatesInRepo).mockResolvedValue([GATE] as never);
  vi.mocked(threads.expireEndedGatesInRepo).mockReset().mockResolvedValue(['gate-old']);
  vi.mocked(leases.listActiveLeases).mockResolvedValue([LEASE] as never);
  vi.mocked(leases.releaseForRepo).mockReset().mockResolvedValue([LEASE] as never);
});

describe('the review step, before anything happens', () => {
  it('lists the work, the questions, the leases, the crew, the labels and the app, and changes nothing', async () => {
    const { github, calls } = fakeGitHub();
    const { flow, stop, deps } = removal(github);

    const preview = await flow.preview('app');

    expect(preview).toEqual({
      repository: 'janedoe/app',
      removedAt: null,
      tasks: [
        { id: 'task-paused', subject: 'app#12', kind: 'intake', state: 'paused', bot: 'ottoexampleco', question: 'Which database?' },
        { id: 'task-running', subject: 'app#14', kind: 'implement', state: 'running', bot: 'fleetadlc-atlas-janedoe', question: null },
      ],
      questions: [{ id: 'gate-1', subject: 'app#12', question: 'Which database?' }],
      leases: [{ id: 'lease-14', issue: 14, bot: 'fleetadlc-atlas-janedoe', state: 'in_task' }],
      crew: {
        known: true,
        reason: null,
        accounts: [
          { bots: ['fleetadlc-atlas-janedoe', 'builder-2'], login: 'fleetadlc-atlas-janedoe', state: 'collaborator' },
          { bots: ['irisexampleco'], login: 'irisexampleco', state: 'collaborator' },
          { bots: ['ottoexampleco'], login: 'ottoexampleco', state: 'invited' },
        ],
      },
      labels: {
        known: true,
        reason: null,
        names: ['adlc:build', 'priority:p1', 'area:general', 'fleetadlc:ignore', 'Size:large', 'sdlc:build'],
        maybeTheirs: ['priority:high', 'blocked'],
      },
      app: { allRepositories: true, settingsUrl: 'https://github.com/settings/installations/7', reason: null },
      leftAlone: LEFT_ALONE,
    });
    expect(stop).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    // The crew and the labels share the one installation token.
    expect(deps.github).toHaveBeenCalledTimes(1);
    expect(repos.removeRepo).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('says why it cannot list the crew or the labels when GitHub cannot be asked', async () => {
    const { flow } = removal(fakeGitHub().github, {
      github: async () => {
        throw new Error('OpenADLC does not hold the GitHub App’s private key, so it cannot act on the repository');
      },
    });

    const preview = await flow.preview('app');

    expect(preview?.crew).toEqual({ known: false, reason: expect.stringContaining('private key'), accounts: [] });
    expect(preview?.labels).toEqual({ known: false, reason: expect.stringContaining('private key'), names: [], maybeTheirs: [] });
    // The rest is OpenADLC's own, and is listed all the same.
    expect(preview?.tasks).toHaveLength(2);
  });

  it('ignores an invitation that belongs to another repository', async () => {
    const { github, calls } = fakeGitHub();
    const { flow } = removal(github, {
      invitations: async () => ({
        pending: [
          { id: 99, invitee: 'ottoexampleco', repository: 'janedoe/other', expired: false },
          { id: 41, invitee: 'ottoexampleco', repository: 'janedoe/app', expired: false },
        ],
        reason: null,
      }),
    });

    const report = await flow.remove('app', 'janedoe');

    expect(report?.invitationsCancelled).toEqual(['ottoexampleco']);
    expect(calls).toContain('cancel 41');
    expect(calls).not.toContain('cancel 99');
  });

  it('names an invitation OpenADLC cannot see the id of, from what the keeper last found', async () => {
    const { flow } = removal(fakeGitHub().github, {
      invitations: async () => ({ pending: [], reason: 'the `gh` command is not installed on the machine running OpenADLC' }),
      crewAccess: { view: () => ({ bots: [{ bot: 'ottoexampleco', login: 'ottoexampleco', state: 'invited' }] }) as never, forget: vi.fn() },
    });

    const preview = await flow.preview('app');

    expect(preview?.crew.accounts).toContainEqual({ bots: ['ottoexampleco'], login: 'ottoexampleco', state: 'invited' });
    expect(preview?.crew.reason).toContain('`gh`');
  });

  it('is nothing for a repository OpenADLC never had', async () => {
    vi.mocked(repos.getRepoByName).mockResolvedValueOnce(null);
    expect(await removal(fakeGitHub().github).flow.preview('nothing')).toBeNull();
  });
});

describe('removing a repository', () => {
  it('marks it removed first, then stops its work, closes its questions and releases its leases, each audited', async () => {
    const order: string[] = [];
    vi.mocked(repos.removeRepo).mockImplementationOnce(async () => (order.push('removed'), REMOVED) as never);
    const { github } = fakeGitHub();
    const { flow, stop } = removal(github);
    stop.mockImplementation(async (id: string) => (order.push(`stop ${id}`), { state: 'stopped', questionsClosed: id === 'task-paused' ? 1 : 0 }));

    const report = await flow.remove('app', 'janedoe', { crewAccess: false, labels: false });

    expect(order).toEqual(['removed', 'stop task-paused', 'stop task-running']);
    // Through the card's Stop, with the reason the audit gives.
    expect(stop).toHaveBeenCalledWith('task-paused', 'janedoe', 'repository removed from OpenADLC by janedoe');
    expect(stop).not.toHaveBeenCalledWith('task-other', expect.anything(), expect.anything());
    expect(threads.expireEndedGatesInRepo).toHaveBeenCalledWith('repo-app', 'janedoe', 'repository removed from OpenADLC by janedoe');
    expect(leases.releaseForRepo).toHaveBeenCalledWith({ repoId: 'repo-app', actor: 'janedoe', reason: 'repository removed from OpenADLC by janedoe' });
    expect(report).toMatchObject({
      stopped: [
        { task: 'task-paused', subject: 'app#12', was: 'paused' },
        { task: 'task-running', subject: 'app#14', was: 'running' },
      ],
      questionsClosed: 2,
      leasesReleased: [14],
      collaboratorsRemoved: [],
      labelsRemoved: [],
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'janedoe',
        action: 'repo.removed',
        target: 'janedoe/app',
        payload: expect.objectContaining({ stopped: ['app#12', 'app#14'], questionsClosed: 2, leasesReleased: [14] }),
      }),
    );
  });

  it('takes the crew off its collaborators and cancels their invitations by default, and audits what it removed', async () => {
    const { github, calls } = fakeGitHub();
    const { flow, crewAccess } = removal(github);

    const report = await flow.remove('app', 'janedoe', DEFAULT_REMOVAL);

    // janedoe is a person, not the crew: left alone. The builder's account is removed once for its two seats.
    expect(calls).toEqual(['remove fleetadlc-atlas-janedoe', 'remove irisexampleco', 'cancel 41']);
    expect(report?.collaboratorsRemoved).toEqual(['fleetadlc-atlas-janedoe', 'irisexampleco']);
    expect(report?.invitationsCancelled).toEqual(['ottoexampleco']);
    expect(crewAccess.forget).toHaveBeenCalledWith('janedoe/app');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'repo.crew_removed',
        target: 'janedoe/app',
        payload: { collaborators: ['fleetadlc-atlas-janedoe', 'irisexampleco'], invitations: ['ottoexampleco'], failed: [] },
      }),
    );
  });

  it('leaves the labels unless asked, and then deletes only OpenADLC’s', async () => {
    const { github, calls } = fakeGitHub();
    await removal(github).flow.remove('app', 'janedoe', { crewAccess: false, labels: false });
    expect(calls).toEqual([]);
    expect(github.labels).not.toHaveBeenCalled();

    const report = await removal(github).flow.remove('app', 'janedoe', { crewAccess: false, labels: true });
    // Not `priority:high` or `blocked`, which may be the repository's own.
    expect(report?.labelsRemoved).toEqual(['adlc:build', 'priority:p1', 'area:general', 'fleetadlc:ignore', 'Size:large', 'sdlc:build']);
    expect(calls).toEqual(report?.labelsRemoved.map((name) => `delete ${name}`));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'repo.labels_removed', payload: { removed: report?.labelsRemoved, failed: [] } }),
    );
  });

  it('deletes the labels that may be the repository’s own only when that is ticked as well', async () => {
    const { github, calls } = fakeGitHub();
    const report = await removal(github).flow.remove('app', 'janedoe', { crewAccess: false, labels: false, maybeTheirs: true });
    expect(report?.labelsRemoved).toEqual(['priority:high', 'blocked']);
    expect(calls).toEqual(['delete priority:high', 'delete blocked']);
  });

  it('names the permission a refused label needs, GitHub’s own when it says, and never Administration', async () => {
    const refused = (accepted: string | null) =>
      fakeGitHub({
        deleteLabel: vi.fn(async (name: string) => {
          throw new GitHubApiError(403, `/repos/janedoe/app/labels/${name}`, '{"message":"Resource not accessible by integration"}', accepted);
        }),
      }).github;

    const named = await removal(refused('issues=write; pull_requests=write')).flow.remove('app', 'janedoe', { crewAccess: false, labels: true });
    expect(named?.notDone).toContainEqual(
      expect.objectContaining({
        step: 'label',
        why: 'the OpenADLC GitHub App needs `Issues: read and write` or `Pull requests: read and write` on this repository',
      }),
    );

    const unnamed = await removal(refused(null)).flow.remove('app', 'janedoe', { crewAccess: false, labels: true });
    expect(unnamed?.notDone).toContainEqual(
      expect.objectContaining({ step: 'label', why: 'the OpenADLC GitHub App needs `Issues: read and write` on this repository' }),
    );
  });

  it('touches no collaborator when the crew’s access is to stay', async () => {
    const { github, calls } = fakeGitHub();
    await removal(github).flow.remove('app', 'janedoe', { crewAccess: false, labels: false });
    expect(github.collaborators).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('says the app still reaches it when installed on all repositories, with its installation’s page', async () => {
    const report = await removal(fakeGitHub().github).flow.remove('app', 'janedoe', { crewAccess: false, labels: false });
    expect(report?.notDone).toEqual([
      expect.objectContaining({
        step: 'app',
        what: expect.stringContaining('installed on all of janedoe’s repositories'),
        action: { label: 'Installation settings', url: 'https://github.com/settings/installations/7' },
      }),
    ]);
  });

  it('is nothing for a repository OpenADLC never had, and does nothing', async () => {
    vi.mocked(repos.removeRepo).mockResolvedValueOnce(null);
    const { github, calls } = fakeGitHub();
    const { flow, stop } = removal(github);
    expect(await flow.remove('nothing', 'janedoe')).toBeNull();
    expect(stop).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('a removal that could not do everything', () => {
  it('still removes the repository, and lists each thing not done with what finishes it', async () => {
    // GitHub refuses one collaborator; hostd does not answer for one task.
    const { github, calls } = fakeGitHub({
      removeCollaborator: vi.fn(async (login: string) => {
        if (login === 'irisexampleco') throw new GitHubApiError(403, '/repos/janedoe/app/collaborators/irisexampleco', '{"message":"Resource not accessible by integration"}');
        calls.push(`remove ${login}`);
      }),
    });
    const { flow, stop, crewAccess } = removal(github, { app: async () => ({ allRepositories: false, settingsUrl: null, reason: null }) });
    stop.mockImplementation(async (id: string) => {
      if (id === 'task-running') throw new Error('hostd did not stop it: connect ECONNREFUSED');
      return { state: 'stopped', questionsClosed: 1 };
    });

    const report = await flow.remove('app', 'janedoe', DEFAULT_REMOVAL);

    expect(report?.repo.removedAt).toBe('2026-09-30T10:00:00.000Z');
    expect(report?.stopped.map((one) => one.task)).toEqual(['task-paused']);
    expect(calls).toEqual(['remove fleetadlc-atlas-janedoe', 'cancel 41']);
    expect(report?.notDone).toEqual([
      {
        step: 'task',
        what: 'the implement task on app#14 is still running',
        why: 'hostd did not stop it: connect ECONNREFUSED',
        action: { label: 'Remove from OpenADLC again', retry: true },
      },
      {
        step: 'collaborator',
        what: 'irisexampleco is still a collaborator',
        why: 'the OpenADLC GitHub App needs `Administration: read and write` on this repository',
        action: { label: 'Collaborators on GitHub', url: 'https://github.com/janedoe/app/settings/access' },
      },
    ]);
    // The rest went ahead.
    expect(leases.releaseForRepo).toHaveBeenCalled();
    expect(crewAccess.forget).toHaveBeenCalledWith('janedoe/app');
    // And the audit lists the same.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'repo.removed',
        payload: expect.objectContaining({
          notDone: [
            expect.objectContaining({ step: 'task', action: 'Remove from OpenADLC again' }),
            expect.objectContaining({ step: 'collaborator', what: 'irisexampleco is still a collaborator', action: 'Collaborators on GitHub' }),
          ],
        }),
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'repo.crew_removed',
        payload: expect.objectContaining({ failed: [{ login: 'irisexampleco', why: expect.stringContaining('Administration') }] }),
      }),
    );
  });

  it('lists the store steps it could not do, to be done by removing again', async () => {
    vi.mocked(tasks.listTasks).mockRejectedValueOnce(new Error('connection reset'));
    vi.mocked(threads.expireEndedGatesInRepo).mockRejectedValueOnce(new Error('connection reset'));
    vi.mocked(leases.releaseForRepo).mockRejectedValueOnce(new Error('connection reset'));
    const { flow } = removal(fakeGitHub().github, { app: async () => ({ allRepositories: false, settingsUrl: null, reason: null }) });

    const report = await flow.remove('app', 'janedoe', { crewAccess: false, labels: false });

    expect(report?.notDone.map((one) => [one.step, one.action])).toEqual([
      ['task', { label: 'Remove from OpenADLC again', retry: true }],
      ['question', { label: 'Remove from OpenADLC again', retry: true }],
      ['lease', { label: 'Remove from OpenADLC again', retry: true }],
    ]);
  });

  it('lists an invitation it cannot see the id of, with where to cancel it', async () => {
    const { flow } = removal(fakeGitHub().github, {
      invitations: async () => ({ pending: [], reason: 'the `gh` command is not installed on the machine running OpenADLC' }),
      crewAccess: { view: () => ({ bots: [{ bot: 'ottoexampleco', login: 'ottoexampleco', state: 'invited' }] }) as never, forget: vi.fn() },
      app: async () => ({ allRepositories: false, settingsUrl: null, reason: null }),
    });

    const report = await flow.remove('app', 'janedoe', DEFAULT_REMOVAL);

    expect(report?.notDone).toEqual([
      {
        step: 'invitation',
        what: 'ottoexampleco’s invitation is still pending',
        why: 'OpenADLC cannot see the invitation to cancel it: the `gh` command is not installed on the machine running OpenADLC',
        action: { label: 'Invitations on GitHub', url: 'https://github.com/janedoe/app/settings/access' },
      },
    ]);
  });

  it('lists the crew and the labels as not done when GitHub cannot be asked at all', async () => {
    const { flow } = removal(fakeGitHub().github, {
      github: async () => {
        throw new Error('/repos/janedoe/app/installation → 404: Not Found');
      },
      app: async () => ({ allRepositories: false, settingsUrl: null, reason: null }),
    });

    const report = await flow.remove('app', 'janedoe', { crewAccess: true, labels: true });

    expect(report?.notDone.map((one) => [one.step, one.what, one.action])).toEqual([
      ['collaborator', 'the crew’s accounts may still be collaborators', { label: 'Collaborators on GitHub', url: 'https://github.com/janedoe/app/settings/access' }],
      ['label', 'OpenADLC’s labels are still there', { label: 'Labels on GitHub', url: 'https://github.com/janedoe/app/labels' }],
    ]);
    expect(report?.repo.removedAt).not.toBeNull();
  });

  it('lists the labels it could not delete, and deletes the rest', async () => {
    const { github, calls } = fakeGitHub({
      deleteLabel: vi.fn(async (name: string) => {
        if (name === 'priority:p1') throw new Error('/repos/janedoe/app/labels/priority%3Ap1 → 500: boom');
        calls.push(`delete ${name}`);
      }),
    });
    const { flow } = removal(github, { app: async () => ({ allRepositories: false, settingsUrl: null, reason: null }) });

    const report = await flow.remove('app', 'janedoe', { crewAccess: false, labels: true });

    expect(report?.labelsRemoved).toEqual(['adlc:build', 'area:general', 'fleetadlc:ignore', 'Size:large', 'sdlc:build']);
    expect(report?.notDone).toEqual([
      expect.objectContaining({ step: 'label', what: '1 of OpenADLC’s labels is still there: priority:p1', action: { label: 'Labels on GitHub', url: 'https://github.com/janedoe/app/labels' } }),
    ]);
  });

  it('finishes the rest when run again on a repository already removed', async () => {
    // What was left: one task hostd did not stop. It is the only unfinished one now.
    vi.mocked(tasks.listTasks).mockResolvedValueOnce([RUNNING] as never);
    const { flow, stop } = removal(fakeGitHub().github, { app: async () => ({ allRepositories: false, settingsUrl: null, reason: null }) });

    const report = await flow.remove('app', 'janedoe', { crewAccess: false, labels: false });

    expect(stop).toHaveBeenCalledWith('task-running', 'janedoe', 'repository removed from OpenADLC by janedoe');
    expect(report?.notDone).toEqual([]);
  });
});

describe('OpenADLC’s labels', () => {
  it('are the ones config/labels.json names, and their older names, in any letter case', () => {
    const ours = ['adlc:review', 'priority:p0', 'do:human', 'start:now', 'review:human', 'touches:schema', 'size:large', 'area:general', 'scope:cross-cutting', 'ADLC:done', 'fleetadlc:ignore', 'fleetadlc:paused', 'fleetadlc:next', 'deployed:prod', 'sdlc:build', 'fleet:ignore'];
    expect(sortLabels(ours, CONFIGURED)).toEqual({ ours, maybeTheirs: [] });
  });

  it('keeps apart a generic name and one that only starts like OpenADLC’s, which may be the repository’s own', () => {
    const sorted = sortLabels(['priority:high', 'area:frontend', 'size:XL', 'Review: needed', 'scope:backend', 'blocked', 'needs-human', 'incident', 'bug', 'priority', 'my-area:x'], CONFIGURED);
    expect(sorted.ours).toEqual([]);
    expect(sorted.maybeTheirs).toEqual(['priority:high', 'area:frontend', 'size:XL', 'Review: needed', 'scope:backend', 'blocked', 'needs-human', 'incident']);
  });
});

describe('GitHub, as the flow asks it', () => {
  function client(pages: Record<string, unknown[]> = {}, refuse: Record<string, number> = {}) {
    const asked: string[] = [];
    return {
      asked,
      request: vi.fn(async (method: string, path: string) => {
        asked.push(`${method} ${path}`);
        if (refuse[path]) throw new GitHubApiError(refuse[path]!, path, 'no');
        return (pages[path] ?? []) as never;
      }),
    };
  }

  it('reads direct collaborators only, every page of them', async () => {
    const first = Array.from({ length: 100 }, (_, n) => ({ login: `person-${n}` }));
    const fake = client({
      '/repos/janedoe/app/collaborators?affiliation=direct&per_page=100&page=1': first,
      '/repos/janedoe/app/collaborators?affiliation=direct&per_page=100&page=2': [{ login: 'irisexampleco' }],
    });
    const logins = await removalGitHub(fake, 'janedoe/app').collaborators();
    expect(logins).toHaveLength(101);
    expect(fake.asked).toHaveLength(2);
  });

  it('removes, cancels and deletes by name, and counts one already gone as done', async () => {
    const fake = client({}, { '/repos/janedoe/app/labels/area%3Aconsole': 404 });
    const github = removalGitHub(fake, 'janedoe/app');
    await github.removeCollaborator('irisexampleco');
    await github.cancelInvitation(41);
    await github.deleteLabel('area:console');
    expect(fake.asked).toEqual([
      'DELETE /repos/janedoe/app/collaborators/irisexampleco',
      'DELETE /repos/janedoe/app/invitations/41',
      'DELETE /repos/janedoe/app/labels/area%3Aconsole',
    ]);
  });

  it('passes on any other refusal', async () => {
    const fake = client({}, { '/repos/janedoe/app/collaborators/irisexampleco': 403 });
    await expect(removalGitHub(fake, 'janedoe/app').removeCollaborator('irisexampleco')).rejects.toThrow('403');
  });
});

describe('where the app stands', () => {
  const view = (selection: 'all' | 'selected' | null) => ({
    installationsView: async () => ({
      app: { slug: 'fleetadlc' } as never,
      reason: '',
      accounts: [
        {
          login: 'JaneDoe',
          type: 'User' as const,
          id: 1,
          installUrl: 'https://github.com/settings/installations/7',
          installation: selection ? { id: 7, selection, settingsUrl: null, suspended: false } : null,
          repositories: ['app'],
          fix: null,
        },
      ],
    }),
  });

  it('says an installation on all repositories still reaches it, with the page to narrow it', async () => {
    expect(await appStanding(view('all') as never, 'janedoe/app')).toEqual({
      allRepositories: true,
      settingsUrl: 'https://github.com/settings/installations/7',
      reason: null,
    });
  });

  it('says one on selected repositories does not reach it by default', async () => {
    expect((await appStanding(view('selected') as never, 'janedoe/app')).allRepositories).toBe(false);
    expect((await appStanding(view(null) as never, 'janedoe/app')).allRepositories).toBe(false);
  });

  it('says why when the app cannot be read', async () => {
    const standing = await appStanding({ installationsView: async () => ({ app: null, accounts: [], reason: 'no key' }) } as never, 'janedoe/app');
    expect(standing).toEqual({ allRepositories: null, settingsUrl: null, reason: 'no key' });
  });
});
