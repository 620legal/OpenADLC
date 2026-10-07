import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The repositories the crew works in, as the walkthrough and settings add and
 * remove them.
 *
 * A repository added this way belongs to the builder. Its owner is who the
 * dispatcher leases its implementation to. It used to be the automation
 * account, as the one bot every install has — which thinks with no model, so
 * the first request to reach implementation went to a bot that could not do it.
 */

const crew = [
  { id: 'id-automation', name: 'janedoe-fleetadlc-flow', slot: 'automation', role: 'automation', engine: 'none' },
  { id: 'id-intake', name: 'ottoexampleco', slot: 'intake', role: 'intake', engine: 'claude' },
  { id: 'id-builder', name: 'fleetadlc-atlas-janedoe', slot: 'builder', role: 'implement', engine: 'claude' },
];

const store = vi.hoisted(() => {
  class RepoNameTaken extends Error {}
  const managed = [
    { id: 'repo-1', name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed', color: 'blue', ownerBotId: 'id-builder' },
    { id: 'repo-2', name: 'api', fullName: 'janedoe/api', color: 'amber', ownerBotId: 'id-builder' },
  ];
  return { RepoNameTaken, managed };
});

/** What keeps the crew in each repository, as the routes see it. */
const keeper = {
  ensure: vi.fn(async (repository: string, trigger: string) => ({
    repository,
    running: false,
    trigger,
    checkedAt: '2026-09-25T09:00:00.000Z',
    error: null,
    bots: [
      { bot: 'fleetadlc-atlas-janedoe', login: 'fleetadlc-atlas-janedoe', state: 'in', changed: true, detail: 'invited and accepted just now' },
      {
        bot: 'ottoexampleco',
        login: 'ottoexampleco',
        state: repository === 'janedoe/api' ? 'invited' : 'in',
        changed: false,
        detail: repository === 'janedoe/api' ? 'ottoexampleco is not connected yet, so it cannot accept anything' : 'can already work here',
      },
    ],
  })),
  view: vi.fn((repository: string) =>
    repository === 'janedoe/api' ? { repository, running: true, trigger: 'added', checkedAt: null, error: null, bots: [] } : null,
  ),
  forget: vi.fn(),
};
const invitations = {
  discover: vi.fn(async (repository: string) => ({
    pending: repository === 'janedoe/api' ? [{ id: 7, invitee: 'ottoexampleco', repository, expired: false }] : [],
    reason: null,
  })),
};

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
  bots: { listBots: vi.fn(async () => crew) },
  costs: {},
  credentials: {},
  issues: {},
  leases: { releaseForRepo: vi.fn(async () => []), listActiveLeases: vi.fn(async () => []) },
  listAudit: vi.fn(),
  mergeLines: {},
  modelAccounts: {},
  recordEvent: vi.fn(),
  repos: {
    RepoNameTaken: store.RepoNameTaken,
    listRepos: vi.fn(async () => store.managed),
    getRepoByName: vi.fn(async (name: string) => store.managed.find((repo) => repo.name === name || repo.fullName === name) ?? null),
    addRepo: vi.fn(async (input: Record<string, unknown>) => ({
      repo: { id: 'repo-1', color: 'amber', removedAt: null, ...input },
      outcome: 'added',
    })),
    removeRepo: vi.fn(async (name: string) =>
      name === 'fleetadlc-testbed'
        ? { id: 'repo-1', name, fullName: 'janedoe/fleetadlc-testbed', color: 'blue', removedAt: '2026-09-24T12:00:00.000Z' }
        : null,
    ),
    updateRepoSettings: vi.fn(async (name: string, patch: Record<string, unknown>) =>
      name === 'fleetadlc-testbed' ? { id: 'repo-1', name, fullName: 'janedoe/fleetadlc-testbed', color: 'blue', ...patch } : null,
    ),
  },
  requests: {},
  sessions: {},
  settings: { allSettings: vi.fn(async () => ({})) },
  tasks: { listTasks: vi.fn(async () => []) },
  threads: { expireEndedGatesInRepo: vi.fn(async () => []), listOpenGatesInRepo: vi.fn(async () => []) },
}));

import { audit, repos } from '@fleetadlc/db';

let bridge: Server;
let bridgeUrl: string;
/** What GitHub says each repository's default branch is; a repository it is not asked about is unanswered. */
const defaultBranches: Record<string, string> = {};

beforeEach(async () => {
  const { registerConsoleApi } = await import('./api.js');
  const { RepoRemoval } = await import('./repo-removal.js');
  const { Router } = await import('./router.js');
  const router = new Router();
  registerConsoleApi(router, {
    config: { gitHubClientId: '', webhookSecret: '', humans: [] } as never,
    hostd: {} as never,
    actors: {} as never,
    invitations: invitations as never,
    crewAccess: keeper as never,
    automation: {} as never,
    gates: {} as never,
    taskService: {} as never,
    threadStream: { subscribe: () => () => undefined, watching: 0 } as never,
    onboarding: {} as never,
    webhookSetup: {} as never,
    repoSetup: {} as never,
    defaultBranchOf: async (fullName: string) => defaultBranches[fullName] ?? null,
    // GitHub as the app, which a test never reaches: the flow says it could not ask.
    removal: new RepoRemoval({
      stop: async () => ({ state: 'stopped', questionsClosed: 0 }),
      github: async () => {
        throw new Error('no GitHub in a test');
      },
      crewAccess: keeper as never,
      labelNames: () => [],
    }),
  });
  bridge = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
});

afterEach(async () => {
  keeper.ensure.mockClear();
  keeper.forget.mockClear();
  invitations.discover.mockClear();
  vi.mocked(repos.addRepo).mockClear();
  vi.mocked(repos.removeRepo).mockClear();
  vi.mocked(repos.updateRepoSettings).mockClear();
  vi.mocked(audit).mockClear();
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
});

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${bridgeUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('the repository the walkthrough adds', () => {
  it('is owned by the builder, not by the automation account', async () => {
    const response = await send('POST', '/v1/onboarding/repository', { fullName: 'janedoe/fleetadlc-testbed' });

    expect(response.status).toBe(200);
    expect(vi.mocked(repos.addRepo)).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'fleetadlc-testbed', fullName: 'janedoe/fleetadlc-testbed', ownerBotId: 'id-builder' }),
    );
  });

  it('is one of several: each is added beside the others, and says the colour it was given', async () => {
    for (const fullName of ['janedoe/fleetadlc-testbed', 'https://github.com/janedoe/api.git']) {
      const response = await send('POST', '/v1/onboarding/repository', { fullName });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ outcome: 'added', repo: { color: 'amber' } });
    }
    expect(vi.mocked(repos.addRepo).mock.calls.map(([input]) => input.fullName)).toEqual(['janedoe/fleetadlc-testbed', 'janedoe/api']);
  });

  it('is refused, in words, when another repository already goes by its name', async () => {
    vi.mocked(repos.addRepo).mockRejectedValueOnce(
      new store.RepoNameTaken('OpenADLC already has a repository called api (janedoe/api), and names each repository by its name alone'),
    );
    const response = await send('POST', '/v1/onboarding/repository', { fullName: 'acme/api' });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('OpenADLC already has a repository called api');
  });

  it('is stored with the default branch GitHub reports, whatever the request says', async () => {
    defaultBranches['acme/legacy'] = 'master';
    try {
      const response = await send('POST', '/v1/onboarding/repository', { fullName: 'acme/legacy', defaultBranch: 'develop' });

      expect(response.status).toBe(200);
      expect(vi.mocked(repos.addRepo)).toHaveBeenCalledWith(expect.objectContaining({ fullName: 'acme/legacy', defaultBranch: 'master' }));
      expect(await response.json()).toMatchObject({ repo: { defaultBranch: 'master' } });
    } finally {
      delete defaultBranches['acme/legacy'];
    }
  });

  it('is still added when GitHub does not say its default branch, and says that it is unconfirmed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const response = await send('POST', '/v1/onboarding/repository', { fullName: 'acme/quiet', defaultBranch: 'develop' });

      expect(response.status).toBe(200);
      // Null: a new row gets `main`, one already here keeps its own (`addRepo`).
      expect(vi.mocked(repos.addRepo)).toHaveBeenCalledWith(expect.objectContaining({ fullName: 'acme/quiet', defaultBranch: null }));
      expect(warn.mock.calls.map((call) => String(call[0]))).toContain(
        '[bridge] acme/quiet: GitHub did not say its default branch, so it is unconfirmed; the next reconcile checks it',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('is refused when it is not owner/name', async () => {
    const response = await send('POST', '/v1/onboarding/repository', { fullName: 'just-a-name' });
    expect(response.status).toBe(400);
    expect(vi.mocked(repos.addRepo)).not.toHaveBeenCalled();
  });
});

describe('removing a repository from OpenADLC', () => {
  it('marks it removed, and is audited under the person who did it', async () => {
    const response = await send('POST', '/v1/repos/fleetadlc-testbed/remove');

    expect(response.status).toBe(200);
    expect(vi.mocked(repos.removeRepo)).toHaveBeenCalledWith('fleetadlc-testbed');
    expect(await response.json()).toMatchObject({ repo: { removedAt: '2026-09-24T12:00:00.000Z' } });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'repo.removed', target: 'janedoe/fleetadlc-testbed' }),
    );
  });

  it('says so for a repository there is none of', async () => {
    expect((await send('POST', '/v1/repos/nothing/remove')).status).toBe(404);
    expect((await send('GET', '/v1/repos/nothing/removal')).status).toBe(404);
  });

  it('takes the crew’s access by default and leaves the labels, and says what it could not do', async () => {
    const response = await send('POST', '/v1/repos/fleetadlc-testbed/remove');

    const report = (await response.json()) as { options: unknown; notDone: { step: string; why: string }[] };
    expect(report.options).toEqual({ crewAccess: true, labels: false, maybeTheirs: false });
    expect(report.notDone).toEqual([expect.objectContaining({ step: 'collaborator', why: 'no GitHub in a test' })]);
  });

  it('does as the review step chose', async () => {
    const response = await send('POST', '/v1/repos/fleetadlc-testbed/remove', { crewAccess: false, labels: true });

    const report = (await response.json()) as { options: unknown; notDone: { step: string }[] };
    expect(report.options).toEqual({ crewAccess: false, labels: true, maybeTheirs: false });
    expect(report.notDone.map((one) => one.step)).toEqual(['label']);
  });

  it('refuses a choice that is not true or false', async () => {
    const response = await send('POST', '/v1/repos/fleetadlc-testbed/remove', { labels: 'yes' });
    expect(response.status).toBe(400);
    expect(vi.mocked(repos.removeRepo)).not.toHaveBeenCalled();
  });

  it('shows what it would do first, without removing anything', async () => {
    const response = await send('GET', '/v1/repos/fleetadlc-testbed/removal');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      removal: { repository: 'janedoe/fleetadlc-testbed', tasks: [], questions: [], leases: [], crew: { known: false, reason: 'no GitHub in a test' } },
    });
    expect(vi.mocked(repos.removeRepo)).not.toHaveBeenCalled();
  });
});

describe('a repository’s colour', () => {
  it('is changed from settings, through the same audited route as the rest of them', async () => {
    const response = await send('PATCH', '/v1/repos/fleetadlc-testbed', { color: 'teal' });
    expect(response.status).toBe(200);
    expect(vi.mocked(repos.updateRepoSettings)).toHaveBeenCalledWith('fleetadlc-testbed', { color: 'teal' });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(expect.objectContaining({ action: 'repo.settings', payload: { color: 'teal' } }));
  });

  it('is a name from the palette, never a value', async () => {
    for (const color of ['#ff0000', 'var(--color-alarm)', 'chartreuse', 3]) {
      const response = await send('PATCH', '/v1/repos/fleetadlc-testbed', { color });
      expect(response.status).toBe(400);
    }
    expect(vi.mocked(repos.updateRepoSettings)).not.toHaveBeenCalled();
  });
});

describe('a repository’s default branch', () => {
  it('is set from settings, through the same audited route', async () => {
    const response = await send('PATCH', '/v1/repos/fleetadlc-testbed', { defaultBranch: 'master' });
    expect(response.status).toBe(200);
    expect(vi.mocked(repos.updateRepoSettings)).toHaveBeenCalledWith('fleetadlc-testbed', { defaultBranch: 'master' });
    expect(await response.json()).toMatchObject({ repo: { defaultBranch: 'master' } });
  });

  it('is a branch name, never empty or anything else', async () => {
    for (const defaultBranch of ['', ' ', 'two words', 5, null]) {
      const response = await send('PATCH', '/v1/repos/fleetadlc-testbed', { defaultBranch });
      expect(response.status, JSON.stringify(defaultBranch)).toBe(400);
    }
    expect(vi.mocked(repos.updateRepoSettings)).not.toHaveBeenCalled();
  });
});

describe('the crew in every repository OpenADLC works in', () => {
  it('is let into a repository as soon as it is added, not only into the first', async () => {
    const response = await send('POST', '/v1/onboarding/repository', { fullName: 'janedoe/api' });
    expect(response.status).toBe(200);
    expect(keeper.ensure).toHaveBeenCalledWith('janedoe/api', 'added', expect.objectContaining({ actor: expect.any(String) }));
    // The answer says it is going, for settings to show straight away.
    expect(await response.json()).toMatchObject({ access: { running: true, trigger: 'added' } });
  });

  it('is let in again when a person asks, and the answer says how it went', async () => {
    const response = await send('POST', '/v1/repos/api/access');
    expect(response.status).toBe(200);
    expect(keeper.ensure).toHaveBeenCalledWith('janedoe/api', 'retry', expect.anything());
    expect(((await response.json()) as { access: { bots: unknown[] } }).access.bots).toHaveLength(2);
    expect((await send('POST', '/v1/repos/nothing/access')).status).toBe(404);
  });

  it('is said for each repository settings lists', async () => {
    const body = (await (await send('GET', '/v1/repos')).json()) as { repos: { name: string; access: unknown }[] };
    expect(body.repos.map((repo) => [repo.name, repo.access])).toEqual([
      ['fleetadlc-testbed', null],
      ['api', { repository: 'janedoe/api', running: true, trigger: 'added', checkedAt: null, error: null, bots: [] }],
    ]);
  });

  it('is invited into every repository by the walkthrough’s button, each said on its own', async () => {
    const response = await send('POST', '/v1/invitations/invite', {});
    expect(response.status).toBe(200);
    expect(keeper.ensure.mock.calls.map(([repository, trigger]) => `${repository} ${trigger}`)).toEqual([
      'janedoe/fleetadlc-testbed invite',
      'janedoe/api invite',
    ]);
    const body = (await response.json()) as { results: { bot: string; state: string; detail: string }[]; repositories: { repository: string }[] };
    expect(body.repositories.map((one) => one.repository)).toEqual(['janedoe/fleetadlc-testbed', 'janedoe/api']);
    // One line a bot, the worst of them, naming where.
    expect(body.results.find((one) => one.bot === 'ottoexampleco')).toMatchObject({
      state: 'invited',
      detail: 'janedoe/api: ottoexampleco is not connected yet, so it cannot accept anything',
    });
  });

  it('still invites into just the one a caller names', async () => {
    await send('POST', '/v1/invitations/invite', { repo: 'janedoe/fleetadlc-testbed' });
    expect(keeper.ensure.mock.calls.map(([repository]) => repository)).toEqual(['janedoe/fleetadlc-testbed']);
  });

  it('has what is waiting looked for in every repository', async () => {
    const body = (await (await send('GET', '/v1/invitations')).json()) as {
      repositories: { repository: string; pending: unknown[] }[];
      pending: unknown[];
    };
    expect(body.repositories.map((one) => [one.repository, one.pending.length])).toEqual([
      ['janedoe/fleetadlc-testbed', 0],
      ['janedoe/api', 1],
    ]);
    expect(body.pending).toHaveLength(1);
  });

  it('is forgotten for a repository removed from OpenADLC', async () => {
    await send('POST', '/v1/repos/fleetadlc-testbed/remove');
    expect(keeper.forget).toHaveBeenCalledWith('janedoe/fleetadlc-testbed');
  });
});
