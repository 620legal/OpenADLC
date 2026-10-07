import { beforeEach, describe, expect, it, vi } from 'vitest';

const managed = vi.hoisted(() => ({
  repos: [
    { name: 'api', fullName: 'acme/api' },
    { name: 'web', fullName: 'acme/web' },
  ],
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
  repos: { listRepos: vi.fn(async () => managed.repos) },
}));

import { audit } from '@fleetadlc/db';
import type { Reach, ReachFix } from './app-reach.js';
import { acrossRepositories, CrewAccessKeeper } from './crew-access.js';
import type { CrewAccess } from './invitation-service.js';

const NOW = new Date('2026-09-25T09:00:00.000Z');
const bot = (name: string, state: CrewAccess['state'], extra: Partial<CrewAccess> = {}): CrewAccess => ({
  bot: name,
  login: name,
  state,
  changed: false,
  detail: state === 'in' ? 'can already work here' : `${state} detail`,
  ...extra,
});

/** Invitations that answer from a table, and say who asked for what. */
function inviting(answers: Record<string, CrewAccess[] | Error>) {
  const asked: string[] = [];
  const invitations = {
    inviteAndAccept: vi.fn(async (repository: string, onlyBot?: string) => {
      asked.push(onlyBot ? `${repository} ${onlyBot}` : repository);
      const answer = answers[repository];
      if (answer instanceof Error) throw answer;
      return { results: (answer ?? []).filter((one) => !onlyBot || one.bot === onlyBot) };
    }),
  };
  return { invitations, asked };
}

beforeEach(() => {
  vi.mocked(audit).mockClear();
});

describe('keeping the crew in every repository', () => {
  it('lets them into each repository OpenADLC works in, not only the first', async () => {
    const { invitations, asked } = inviting({
      'acme/api': [bot('builder', 'in')],
      'acme/web': [bot('builder', 'in', { changed: true, detail: 'invited and accepted just now' })],
    });
    const keeper = new CrewAccessKeeper(invitations, () => NOW);

    const lines = await keeper.ensureAll('start');

    expect(asked).toEqual(['acme/api', 'acme/web']);
    expect(keeper.view('acme/web')).toMatchObject({ running: false, trigger: 'start', checkedAt: NOW.toISOString(), error: null });
    // What changed is said; what was already so is not.
    expect(lines).toEqual(['builder can work in acme/web']);
  });

  it('says a run is going the moment one starts, before GitHub has answered', async () => {
    let finish!: () => void;
    const invitations = {
      inviteAndAccept: vi.fn(
        () => new Promise<{ results: CrewAccess[] }>((resolve) => (finish = () => resolve({ results: [bot('builder', 'in')] }))),
      ),
    };
    const keeper = new CrewAccessKeeper(invitations, () => NOW);

    const run = keeper.ensure('acme/docs', 'added');
    expect(keeper.view('acme/docs')).toMatchObject({ running: true, trigger: 'added', checkedAt: null, bots: [] });

    await vi.waitFor(() => expect(invitations.inviteAndAccept).toHaveBeenCalled());
    finish();
    expect(await run).toMatchObject({ running: false, bots: [bot('builder', 'in')] });
  });

  it('joins a run already going for the whole crew instead of starting another', async () => {
    let finish!: () => void;
    const invitations = {
      inviteAndAccept: vi.fn(
        () => new Promise<{ results: CrewAccess[] }>((resolve) => (finish = () => resolve({ results: [bot('builder', 'in')] }))),
      ),
    };
    const keeper = new CrewAccessKeeper(invitations, () => NOW);

    const first = keeper.ensure('acme/api', 'reconcile');
    const second = keeper.ensure('acme/api', 'retry');
    await vi.waitFor(() => expect(invitations.inviteAndAccept).toHaveBeenCalledTimes(1));
    finish();
    expect(await second).toBe(await first);
    expect(invitations.inviteAndAccept).toHaveBeenCalledTimes(1);
  });

  it('asks again for a bot that has just connected, keeping what it knew of the others', async () => {
    const { invitations } = inviting({ 'acme/api': [bot('builder', 'in'), bot('reviewer', 'invited')] });
    const keeper = new CrewAccessKeeper(invitations, () => NOW);
    await keeper.ensure('acme/api', 'start');

    invitations.inviteAndAccept.mockResolvedValueOnce({ results: [bot('reviewer', 'in', { changed: true })] });
    const after = await keeper.ensure('acme/api', 'connected', { onlyBot: 'reviewer' });

    expect(invitations.inviteAndAccept).toHaveBeenLastCalledWith('acme/api', 'reviewer');
    expect(after.bots.map((one) => `${one.bot} ${one.state}`).sort()).toEqual(['builder in', 'reviewer in']);
  });

  it('keeps why it could not look, with what it found the time before', async () => {
    const { invitations } = inviting({ 'acme/api': [bot('builder', 'in')] });
    const keeper = new CrewAccessKeeper(invitations, () => NOW);
    await keeper.ensure('acme/api', 'start');

    invitations.inviteAndAccept.mockRejectedValueOnce(new Error('no GitHub App private key is stored, so OpenADLC cannot invite anybody'));
    const after = await keeper.ensure('acme/api', 'retry');

    expect(after).toMatchObject({
      error: 'no GitHub App private key is stored, so OpenADLC cannot invite anybody',
      bots: [bot('builder', 'in')],
    });
  });

  it('records what changed, once, and not a run that found everything as it was', async () => {
    const { invitations } = inviting({
      'acme/api': [bot('builder', 'in', { changed: true, detail: 'invited and accepted just now' }), bot('qa', 'no-account')],
    });
    const keeper = new CrewAccessKeeper(invitations, () => NOW);

    await keeper.ensure('acme/api', 'added', { actor: 'janedoe@example.test' });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'janedoe@example.test', action: 'repo.crew_access', target: 'acme/api' }),
    );

    vi.mocked(audit).mockClear();
    invitations.inviteAndAccept.mockResolvedValueOnce({ results: [bot('builder', 'in'), bot('qa', 'no-account')] });
    await keeper.ensure('acme/api', 'reconcile');
    // The builder is in as it was, and qa still has no account: nothing to record.
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it('forgets a repository OpenADLC stopped working in', async () => {
    const { invitations } = inviting({ 'acme/api': [bot('builder', 'in')], 'acme/web': [bot('builder', 'in')] });
    const keeper = new CrewAccessKeeper(invitations, () => NOW);
    await keeper.ensureAll('start');

    managed.repos = [{ name: 'api', fullName: 'acme/api' }];
    try {
      await keeper.ensureAll('reconcile');
      expect(keeper.view('acme/web')).toBeNull();
    } finally {
      managed.repos = [
        { name: 'api', fullName: 'acme/api' },
        { name: 'web', fullName: 'acme/web' },
      ];
    }
  });
});

describe('one line per bot across several repositories', () => {
  it('is the worst any repository found, naming it', () => {
    expect(
      acrossRepositories([
        { repository: 'acme/api', bots: [bot('builder', 'in', { changed: true }), bot('reviewer', 'in')] },
        { repository: 'acme/web', bots: [bot('builder', 'invited', { detail: 'it is not connected yet' }), bot('reviewer', 'in')] },
      ]),
    ).toEqual([
      bot('builder', 'invited', { changed: true, detail: 'acme/web: it is not connected yet' }),
      bot('reviewer', 'in'),
    ]);
  });

  it('names no repository when there is only one', () => {
    expect(acrossRepositories([{ repository: 'acme/api', bots: [bot('builder', 'refused')] }])).toEqual([bot('builder', 'refused')]);
  });
});

describe('telling what else should look again', () => {
  it('tells when a run let somebody in, and not when it found everything as it was', async () => {
    const { invitations } = inviting({ 'acme/api': [bot('builder', 'in', { changed: true, detail: 'invited and accepted just now' })] });
    const keeper = new CrewAccessKeeper(invitations, () => NOW);
    const told = vi.fn();
    keeper.whenChanged(told);

    await keeper.ensure('acme/api', 'added');
    expect(told).toHaveBeenCalledTimes(1);

    invitations.inviteAndAccept.mockResolvedValueOnce({ results: [bot('builder', 'in')] });
    await keeper.ensure('acme/api', 'reconcile');
    expect(told).toHaveBeenCalledTimes(1);
  });
});

describe('a repository the app cannot reach', () => {
  const INSTALL: ReachFix = {
    need: 'install',
    title: 'The OpenADLC app is not installed on acme',
    detail: 'An owner of acme installs it and chooses api: only the repositories the crew works in, not all of acme’s.',
    action: { label: 'Install on acme', url: 'https://github.com/apps/fleetadlc-janedoe/installations/new' },
    steps: [
      {
        text: 'Install it on acme and choose api',
        action: { label: 'Install on acme', url: 'https://github.com/apps/fleetadlc-janedoe/installations/new' },
      },
    ],
  };
  const blocked = async (repository: string): Promise<Reach> => ({ state: 'blocked', repository, account: 'acme', ...INSTALL });

  it('says what to do and where, instead of inviting and keeping GitHub’s 404', async () => {
    // What settings showed for exampleco/infra: the JSON, and a Try again that could not work.
    const { invitations, asked } = inviting({ 'acme/api': new Error('/repos/acme/api/installation → 404: {"message":"Not Found"}') });
    const keeper = new CrewAccessKeeper(invitations, () => NOW, blocked);

    const access = await keeper.ensure('acme/api', 'added');

    expect(asked).toEqual([]);
    expect(access).toMatchObject({ running: false, error: 'The OpenADLC app is not installed on acme', needs: INSTALL });
    expect(JSON.stringify(access)).not.toContain('404');
  });

  it('invites as before where the app can reach it, and where GitHub could not say', async () => {
    const { invitations, asked } = inviting({ 'acme/api': [bot('builder', 'in')], 'acme/web': [bot('builder', 'in')] });
    const keeper = new CrewAccessKeeper(invitations, () => NOW, async (repository) =>
      repository === 'acme/api'
        ? { state: 'reachable', repository, account: 'acme', installationId: 7 }
        : { state: 'unknown', repository, reason: 'GitHub did not say' },
    );

    await keeper.ensureAll('start');

    expect(asked).toEqual(['acme/api', 'acme/web']);
    expect(keeper.view('acme/api')).toMatchObject({ error: null, needs: null });
    expect(keeper.view('acme/web')).toMatchObject({ error: null, needs: null });
  });

  it('lets the crew in once the app is installed, and stops saying what to do', async () => {
    let installed = false;
    const { invitations } = inviting({ 'acme/api': [bot('builder', 'in', { changed: true })] });
    const keeper = new CrewAccessKeeper(invitations, () => NOW, async (repository) =>
      installed ? { state: 'reachable', repository, account: 'acme', installationId: 7 } : blocked(repository),
    );

    expect((await keeper.ensure('acme/api', 'added')).needs).toEqual(INSTALL);
    installed = true;
    const after = await keeper.ensure('acme/api', 'reconcile');

    expect(after).toMatchObject({ error: null, needs: null });
    expect(after.bots.map((one) => one.state)).toEqual(['in']);
  });

  it('records the refusal once, in words, however often it runs', async () => {
    const { invitations } = inviting({});
    const keeper = new CrewAccessKeeper(invitations, () => NOW, blocked);

    await keeper.ensure('acme/api', 'added');
    await keeper.ensure('acme/api', 'reconcile');

    expect(vi.mocked(audit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]?.[0]).toMatchObject({
      action: 'repo.crew_access',
      payload: { error: 'The OpenADLC app is not installed on acme' },
    });
  });
});
