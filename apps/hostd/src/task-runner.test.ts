import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bot } from '@fleetadlc/shared';
import { ModelUnavailable } from '@fleetadlc/engines';
import { internalSecretRef, modelAccountRef, setSecretStore, taskTokenFor, type SecretStore } from '@fleetadlc/github';
import type { ExecDriver, TaskComputer, TaskComputerSpec } from './drivers/types.js';
import type { HostdConfig } from './config.js';

vi.mock('@fleetadlc/db', () => ({
  bots: { getBotByName: vi.fn(), getBotById: vi.fn() },
  repos: { getRepoByName: vi.fn(), listRepos: vi.fn(async () => []) },
  tasks: { updateTaskState: vi.fn(), getTask: vi.fn(), releaseComputer: vi.fn(async () => undefined) },
  modelAccounts: { get: vi.fn() },
  leases: { getLease: vi.fn(async () => null), settlePausedLeases: vi.fn(async () => ({ released: [], held: [] })) },
}));

import { bots, leases, modelAccounts, repos, tasks } from '@fleetadlc/db';
import { SessionEnvMinter } from './session-env.js';
import { HostFull, TaskRunner, type StartTaskInput } from './task-runner.js';
import { BRANCH_GONE, BranchGoneError } from './worktree.js';

const ACCOUNT = '550e8400-e29b-41d4-a716-446655440000';

function crew(partial: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    name: 'atlas',
    slot: 'builder',
    displayName: 'Builder',
    role: 'implement',
    engine: 'claude',
    model: 'newest:opus',
    githubLogin: null,
    hostId: null,
    container: 'bot-atlas',
    status: 'stopped',
    skills: ['implement'],
    sidecarDb: false,
    modelAccountId: ACCOUNT,
    modelSetAt: null,
    ...partial,
  };
}

function driver(): ExecDriver {
  const held = new Map<string, TaskComputer>();
  return {
    kind: 'local',
    acquire: vi.fn(async (spec: TaskComputerSpec) => {
      const computer = { taskId: spec.taskId, bot: spec.bot, container: null, databaseUrl: null, slotDir: spec.slotDir };
      held.set(spec.taskId, computer);
      return computer;
    }),
    release: vi.fn(async (taskId: string) => void held.delete(taskId)),
    computerOf: (taskId: string) => held.get(taskId) ?? null,
    ensureBot: vi.fn(async () => undefined),
    removeBot: vi.fn(async () => undefined),
    startSession: vi.fn(async () => ({ bot: 'atlas', name: 'implement', pid: 1, cmd: 'node' })),
    listSessions: vi.fn(async () => []),
    capturePane: vi.fn(async () => []),
    killSession: vi.fn(async () => undefined),
    attachCommand: () => ['tmux'],
    exec: vi.fn(async () => ({ code: 0, stdout: '.git', stderr: '' })),
    // Where the docker driver mounts a login, which is what a session is told.
    loginPath: vi.fn(() => '/fleetadlc/login'),
  };
}

function config(): HostdConfig {
  return {
    hostName: 'local',
    zone: null,
    driver: 'local',
    port: 1,
    bridgeUrl: 'http://bridge',
    workRoot: join(scratch, 'work'),
    loginRoot,
    skillsRoot: join(scratch, 'skills'),
    rolesRoot: join(scratch, 'roles'),
    capacityBots: 1,
    capacityTasks: 4,
    pausedKeepMinutes: 15,
    tmuxBin: 'tmux',
    registryHost: null,
  };
}

let loginRoot: string;
/** The work, skills and roles roots: one per test, removed after it, so no run leaves task folders behind. */
let scratch: string;

beforeEach(() => {
  loginRoot = mkdtempSync(join(tmpdir(), 'fleetadlc-task-logins-'));
  scratch = mkdtempSync(join(tmpdir(), 'fleetadlc-task-work-'));
  vi.mocked(bots.getBotByName).mockReset();
  vi.mocked(bots.getBotById).mockReset();
  // The store answers the row it wrote; null is a write it refused.
  vi.mocked(tasks.updateTaskState).mockReset().mockImplementation(async (id: string, state: string) => ({ id, state }) as never);
  vi.mocked(tasks.getTask).mockReset();
  vi.mocked(modelAccounts.get).mockReset();
});

afterEach(() => {
  rmSync(loginRoot, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const START = {
  taskId: 'task-1',
  bot: 'atlas',
  kind: 'implement',
  subjectRef: 'fleetadlc#155',
  skill: 'implement',
} as const;

describe('starting a task on the resolved model', () => {
  it('passes the resolved id into the session, and the alias beside it', async () => {
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({
      env: { FLEETADLC_MODEL: 'claude-opus-5', FLEETADLC_MODEL_ALIAS: 'newest:opus' },
      cleanup: async () => undefined,
    });
    const exec = driver();
    const runner = new TaskRunner(config(), exec, null, async () => ({
      model: 'claude-opus-5',
      modelAlias: 'newest:opus',
      account: { id: ACCOUNT, provider: 'anthropic', kind: 'key' },
    }));

    await runner.start({
      taskId: 'task-1',
      bot: 'atlas',
      kind: 'implement',
      subjectRef: 'fleetadlc#155',
      skill: 'implement',
    });

    expect(mint).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-opus-5', modelAlias: 'newest:opus' }));
    expect(vi.mocked(exec.startSession)).toHaveBeenCalledWith(
      expect.objectContaining({ env: expect.objectContaining({ FLEETADLC_MODEL: 'claude-opus-5' }) }),
    );
    const env = vi.mocked(exec.startSession).mock.calls[0]?.[0].env ?? {};
    expect(env.FLEETADLC_MODEL).not.toMatch(/^newest:/);
    mint.mockRestore();
  });

  it('tells the task the bridge a container can reach, when hostd knows it by another name', async () => {
    // hostd in compose calls the bridge `http://bridge:47311`, a name a bot's
    // container on its own network cannot resolve.
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
    const runner = new TaskRunner(
      {
        ...config(),
        driver: 'docker',
        bridgeUrl: 'http://bridge:47311',
        taskBridgeUrl: 'http://host.docker.internal:47311',
        taskHostdUrl: 'http://host.docker.internal:58612',
      },
      driver(),
      null,
      async () => ({ model: 'claude-opus-5', modelAlias: null, account: null }),
    );

    await runner.start({ taskId: 'task-1', bot: 'atlas', kind: 'implement', subjectRef: 'fleetadlc#155', skill: 'implement' });

    expect(mint).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeUrl: 'http://host.docker.internal:47311', hostdUrl: 'http://host.docker.internal:58612' }),
    );
    mint.mockRestore();
  });

  it('hands the session the prices hostd read from the install at start', async () => {
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
    const modelPrices = { 'claude-opus-5': { inPerMtok: 250, outPerMtok: 25 } };
    const runner = new TaskRunner({ ...config(), modelPrices }, driver(), null, async () => ({
      model: 'claude-opus-5',
      modelAlias: null,
      account: null,
    }));

    await runner.start(START);

    expect(mint).toHaveBeenCalledWith(expect.objectContaining({ modelPrices }));
    mint.mockRestore();
  });

  it('fails the task with the refusal and does not start a session', async () => {
    vi.mocked(bots.getBotByName).mockResolvedValue(crew({ model: 'claude-opus-4-6' }));
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint');
    const exec = driver();
    const runner = new TaskRunner(config(), exec, null, async () => {
      throw new ModelUnavailable('this account cannot call claude-opus-4-6 — it offers claude-opus-5, claude-sonnet-5');
    });

    await expect(
      runner.start({
        taskId: 'task-1',
        bot: 'atlas',
        kind: 'implement',
        subjectRef: 'fleetadlc#155',
        skill: 'implement',
      }),
    ).rejects.toThrow(/cannot call claude-opus-4-6/);

    expect(mint).not.toHaveBeenCalled();
    expect(exec.startSession).not.toHaveBeenCalled();
    expect(exec.acquire).not.toHaveBeenCalled();
    mint.mockRestore();
  });
});

describe('a task for a bot there is no row for', () => {
  it('says what to do, not only that the bot is unknown', async () => {
    vi.mocked(bots.getBotByName).mockResolvedValue(null as never);
    const runner = new TaskRunner(config(), driver(), null, async () => ({ model: 'claude-opus-5', modelAlias: null, account: null }));

    await expect(runner.start({ ...START, bot: 'gone' })).rejects.toThrow(
      /there is no bot gone: it was renamed or removed\. Start the work again from the board/,
    );
  });
});

describe('the computer and the session a task is given', () => {
  it('sizes the computer as the seat says, and names the session after the task as well as the skill', async () => {
    // cpus and memoryGb from config/bots.yaml were never passed on, and a
    // session named only after its skill was one per bot: a second task of
    // the same skill on the seat replaced the first one's session.
    vi.mocked(bots.getBotByName).mockResolvedValue(crew({ cpus: 3, memoryGb: 6 }));
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
    const exec = driver();
    const runner = new TaskRunner(config(), exec, null, async () => ({ model: 'claude-opus-5', modelAlias: null, account: null }));

    const started = await runner.start({ ...START, taskId: '550e8400-e29b-41d4-a716-446655440000' });

    expect(exec.acquire).toHaveBeenCalledWith(expect.objectContaining({ bot: 'atlas', cpus: 3, memoryGb: 6 }));
    expect(vi.mocked(exec.startSession).mock.calls[0]?.[0].name).toBe('implement-550e8400');
    expect(started.session).toBe('atlas/implement-550e8400');
    expect(tasks.updateTaskState).toHaveBeenCalledWith(
      '550e8400-e29b-41d4-a716-446655440000',
      'running',
      expect.objectContaining({ tmuxSession: 'atlas/implement-550e8400' }),
    );
    mint.mockRestore();
  });
});

describe('a task whose computer is being made', () => {
  it('counts as starting from before its computer exists until it is held, so the sweep leaves its folder', async () => {
    // The driver records a computer only once its container is up; the sweep
    // in between deleted a resumed intake's folder from under its container.
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
    const exec = driver();
    const runner = new TaskRunner(config(), exec, null, async () => ({ model: 'claude-opus-5', modelAlias: null, account: null }));
    const taskId = '650e8400-e29b-41d4-a716-446655440000';
    const seen: boolean[] = [];
    const acquire = exec.acquire;
    exec.acquire = vi.fn(async (spec: TaskComputerSpec) => {
      seen.push(runner.isStarting(taskId));
      return acquire(spec);
    });

    await runner.start({ ...START, taskId });

    expect(seen).toEqual([true]);
    expect(runner.isStarting(taskId)).toBe(false);
    mint.mockRestore();
  });

  it('stops counting as starting when its start fails, and says so in hostd’s log', async () => {
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const exec = driver();
    exec.acquire = vi.fn(async () => {
      throw new Error('docker would not start it');
    });
    const runner = new TaskRunner(config(), exec, null, async () => ({ model: 'claude-opus-5', modelAlias: null, account: null }));
    const taskId = '750e8400-e29b-41d4-a716-446655440000';

    await expect(runner.start({ ...START, taskId })).rejects.toThrow('docker would not start it');

    expect(runner.isStarting(taskId)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`task ${taskId} did not start: docker would not start it`));
    warn.mockRestore();
  });
});

describe('the key a task is given', () => {
  it('comes from the account its model was resolved against', async () => {
    // The minter used to read the bot row again. A console save in between
    // paired one account's model with another account's key.
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({
      env: {},
      cleanup: async () => undefined,
    });
    const resolvedAgainst = { id: ACCOUNT, provider: 'anthropic', kind: 'key' } as const;
    const runner = new TaskRunner(config(), driver(), null, async () => ({
      model: 'claude-opus-5',
      modelAlias: 'newest:opus',
      account: resolvedAgainst,
    }));

    await runner.start(START);

    expect(mint).toHaveBeenCalledWith(expect.objectContaining({ account: resolvedAgainst }));
    mint.mockRestore();
  });
});

describe('the GitHub token a task is given', () => {
  it('is the task’s own bot’s, so a revert the deploy bot opens is authored by the deploy seat', async () => {
    // A red smoke's revert has to arrive as the deploy bot's pull request: that
    // is who the review fast path and the audit expect a `system/revert-`
    // branch from. The session opens it with whatever GH_TOKEN it holds.
    vi.mocked(bots.getBotByName).mockResolvedValue(
      crew({ id: 'bot-harbor', name: 'harbor', slot: 'deploy', role: 'deploy', githubLogin: 'harbor-janedoe' }),
    );
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
    const tokenForTask = vi.fn(async (bot: string) => ({ token: `ghu_${bot}`, expiresAt: null, login: `${bot}-janedoe` }));
    const runner = new TaskRunner(config(), driver(), { tokenForTask } as never, async () => ({
      model: 'claude-opus-5',
      modelAlias: null,
      account: null,
    }));

    await runner.start({
      taskId: 'task-revert',
      bot: 'harbor',
      kind: 'deploy',
      subjectRef: 'fleetadlc@a1b2c3d4',
      skill: 'deploy',
      branch: 'system/revert-a1b2c3d4',
    });

    // No repository, so the account's token, as before.
    expect(tokenForTask.mock.calls).toEqual([['harbor', null]]);
    expect(mint).toHaveBeenCalledWith(expect.objectContaining({ bot: 'harbor', token: 'ghu_harbor' }));
    mint.mockRestore();
  });

  it('is asked for the task’s repository, so the bridge can narrow it to that one', async () => {
    vi.mocked(bots.getBotByName).mockResolvedValue(crew({ githubLogin: 'atlas-janedoe' }));
    vi.mocked(repos.getRepoByName).mockResolvedValue({ id: 'repo-widgets', name: 'widgets', fullName: 'exampleco/widgets', defaultBranch: 'main' } as never);
    const tokenForTask = vi.fn(async (_bot: string, _repository: string | null) => {
      throw new Error('stop here: only what was asked matters');
    });
    const runner = new TaskRunner(config(), driver(), { tokenForTask } as never, async () => ({ model: 'claude-opus-5', modelAlias: null, account: null }));

    try {
      await expect(runner.start({ ...START, repo: 'widgets' })).rejects.toThrow(/stop here/);
      expect(tokenForTask.mock.calls).toEqual([['atlas', 'exampleco/widgets']]);
    } finally {
      vi.mocked(repos.getRepoByName).mockReset();
    }
  });

  it('fails the start with the bridge’s reason when none can be minted, before a computer is taken', async () => {
    // It used to start with no token: a private clone failed with git's
    // "could not read Username", and a public one ran a whole session first.
    vi.mocked(bots.getBotByName).mockResolvedValue(crew({ githubLogin: 'atlas-janedoe' }));
    const tokenForTask = vi.fn(async () => {
      throw new Error('atlas has no GitHub token: the bridge would not mint one (409) the authorization was revoked');
    });
    const exec = driver();
    const runner = new TaskRunner(config(), exec, { tokenForTask } as never, async () => ({ model: 'claude-opus-5', modelAlias: null, account: null }));

    await expect(runner.start(START)).rejects.toThrow(/the authorization was revoked/);

    expect(exec.acquire).not.toHaveBeenCalled();
    expect(exec.startSession).not.toHaveBeenCalled();
  });
});

describe('resuming a task', () => {
  function paused() {
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    vi.mocked(bots.getBotById).mockResolvedValue(crew());
    vi.mocked(tasks.getTask).mockResolvedValue({
      id: 'task-1',
      botId: 'bot-1',
      repoId: null,
      kind: 'implement',
      subjectRef: 'fleetadlc#155',
      branch: null,
      skill: 'implement',
      costCapUsd: 15,
    } as never);
  }

  it('asks for the model before it takes the old session down', async () => {
    paused();
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({
      env: {},
      cleanup: async () => undefined,
    });
    const exec = driver();
    const choose = vi
      .fn()
      .mockResolvedValueOnce({ model: 'claude-opus-5', modelAlias: null, account: null })
      .mockRejectedValueOnce(new ModelUnavailable('this account cannot call claude-opus-5 — its opus models are claude-opus-6'));
    const runner = new TaskRunner(config(), exec, null, choose);
    await runner.start(START);

    await expect(runner.resume('task-1', [])).rejects.toThrow(/cannot call claude-opus-5/);

    // Refused before `end`: the task is as it was, for the bridge to fail
    // with the reason, rather than paused with nothing behind it.
    expect(exec.killSession).not.toHaveBeenCalled();
    expect(runner.activeTaskIds()).toEqual(['task-1']);
    mint.mockRestore();
  });

  it('takes down the session it made and gives the computer back when the bridge ended the task meanwhile', async () => {
    // The bridge's resume request timed out and it failed the task; the store
    // refuses `running` over `failed`, so the resumed session must not run on.
    paused();
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
    vi.mocked(tasks.updateTaskState).mockResolvedValueOnce(null);
    const exec = driver();
    const runner = new TaskRunner(config(), exec, null, async () => ({ model: 'claude-opus-5', modelAlias: null, account: null }));

    await expect(runner.resume('task-1', [])).rejects.toThrow(/had already ended/);

    expect(exec.startSession).toHaveBeenCalled();
    expect(exec.killSession).toHaveBeenCalledWith('atlas', 'implement-task1');
    expect(exec.release).toHaveBeenCalledWith('task-1', 'its task had already ended');
    expect(vi.mocked(tasks.updateTaskState).mock.calls.map(([, state]) => state)).toEqual(['running']);
    expect(runner.activeTaskIds()).toEqual([]);
    mint.mockRestore();
  });

  it('hands a review seat’s part and lens to its session, on a start and on a resume', async () => {
    paused();
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
    const runner = new TaskRunner(config(), driver(), null, async () => ({ model: 'claude-opus-5', modelAlias: null, account: null }));

    await runner.start({ ...START, kind: 'review', skill: 'pr-review', reviewMode: 'blocking', reviewLens: 'security' });
    expect(mint).toHaveBeenLastCalledWith(expect.objectContaining({ reviewMode: 'blocking', reviewLens: 'security' }));

    await runner.resume('task-1', [], undefined, undefined, 'advisory', 'second');
    expect(mint).toHaveBeenLastCalledWith(expect.objectContaining({ reviewMode: 'advisory', reviewLens: 'second' }));
    mint.mockRestore();
  });

  it('starts on the model it resolved, without asking twice', async () => {
    paused();
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({
      env: {},
      cleanup: async () => undefined,
    });
    const choose = vi.fn(async () => ({ model: 'claude-opus-5', modelAlias: null, account: null }));
    const runner = new TaskRunner(config(), driver(), null, choose);

    await runner.resume('task-1', []);

    expect(choose).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-opus-5' }));
    mint.mockRestore();
  });

  it('starts a stacked build again from its dependency’s branch, and tells it again what it is built on', async () => {
    const brief = { name: 'stacked-on.md', title: 'Built on #7, still in review', content: 'Your branch starts from agent/atlas/7-issue-7.' };
    vi.mocked(bots.getBotById).mockResolvedValue(crew());
    vi.mocked(tasks.getTask).mockResolvedValue({
      id: 'task-1',
      botId: 'bot-1',
      repoId: null,
      kind: 'implement',
      subjectRef: 'fleetadlc#155',
      branch: 'agent/atlas/155-issue-155',
      skill: 'implement',
      costCapUsd: 15,
      baseRef: 'refs/heads/agent/atlas/7-issue-7',
      baseContext: [brief],
    } as never);
    const runner = new TaskRunner(config(), driver(), null, async () => ({ model: 'claude-opus-5', modelAlias: null, account: null }));
    const start = vi.spyOn(runner, 'start').mockResolvedValue({ session: 'implement' } as never);
    const issue = { name: 'issue.md', title: 'fleetadlc#155', content: 'the issue' };

    await runner.resume('task-1', [issue]);

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ baseRef: 'refs/heads/agent/atlas/7-issue-7', context: [issue, brief], checkoutExistingBranch: true }),
      expect.anything(),
    );
  });
});

describe('resuming a paused task in a repository since removed from OpenADLC', () => {
  it('starts it again in that repository, from the bot’s own copy of it', async () => {
    // Nothing new starts in a removed repository; a question answered after
    // the removal is work somebody chose to let finish, where it was.
    const removed = { id: 'repo-api', name: 'api', fullName: 'acme/api', defaultBranch: 'main', removedAt: '2026-09-24T09:00:00.000Z' };
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    vi.mocked(bots.getBotById).mockResolvedValue(crew());
    vi.mocked(tasks.getTask).mockResolvedValue({
      id: 'task-1',
      botId: 'bot-1',
      repoId: 'repo-api',
      kind: 'implement',
      subjectRef: 'api#12',
      branch: 'agent/atlas/12-issue-12',
      skill: 'implement',
      costCapUsd: 15,
    } as never);
    vi.mocked(repos.listRepos).mockImplementation((async (options?: { includeRemoved?: boolean }) =>
      options?.includeRemoved ? [removed] : []) as never);
    vi.mocked(repos.getRepoByName).mockImplementation((async (name: string, options?: { includeRemoved?: boolean }) =>
      options?.includeRemoved && name === 'api' ? removed : null) as never);
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
    const runner = new TaskRunner(config(), driver(), null, async () => ({ model: 'claude-opus-5', modelAlias: null, account: null }));
    // Where it would clone from; answered with nothing, so no network is needed to see which repository it asked about.
    const remoteFor = vi
      .spyOn(runner as unknown as { remoteFor: (fullName: string | null) => Promise<string | null> }, 'remoteFor')
      .mockResolvedValue(null);

    try {
      await runner.resume('task-1', []);
      expect(remoteFor).toHaveBeenCalledWith('acme/api');
    } finally {
      mint.mockRestore();
      vi.mocked(repos.listRepos).mockImplementation((async () => []) as never);
      vi.mocked(repos.getRepoByName).mockReset();
    }
  });
});

describe('the login a task’s container holds', () => {
  const SEAT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

  function memory(initial: Record<string, string> = {}): SecretStore {
    const data = new Map(Object.entries(initial));
    return {
      get: async (ref) => data.get(ref) ?? null,
      set: async (ref, value) => void data.set(ref, value),
      delete: async (ref) => void data.delete(ref),
      list: async (prefix = '') => [...data.keys()].filter((ref) => ref.startsWith(prefix)),
    };
  }

  async function startOn(account: { id: string; provider: 'anthropic' | 'openai' | 'xai'; kind: 'key' | 'subscription' }) {
    vi.mocked(bots.getBotByName).mockResolvedValue(crew({ modelAccountId: account.id }));
    const exec = driver();
    const runner = new TaskRunner(config(), exec, null, async () => ({
      model: 'pinned-model',
      modelAlias: null,
      account,
    }));
    await runner.start(START);
    return exec;
  }

  it('is the account’s own, for a bot on an OpenAI or xAI subscription', async () => {
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });

    const codex = await startOn({ id: SEAT, provider: 'openai', kind: 'subscription' });
    const grok = await startOn({ id: SEAT, provider: 'xai', kind: 'subscription' });

    expect(codex.acquire).toHaveBeenCalledWith(expect.objectContaining({ bot: 'atlas', login: { accountId: SEAT, provider: 'openai' } }));
    expect(grok.acquire).toHaveBeenCalledWith(expect.objectContaining({ bot: 'atlas', login: { accountId: SEAT, provider: 'xai' } }));
    // Made by hostd, closed to everyone else, before the container is asked to mount it.
    expect(statSync(join(loginRoot, SEAT)).mode & 0o777).toBe(0o700);
    mint.mockRestore();
  });

  it('is none for a bot on a key or on a Claude subscription', async () => {
    // Said as null rather than left out: a container still holding a seat's
    // login is recreated without it, and "no opinion" would leave it there.
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });

    const key = await startOn({ id: ACCOUNT, provider: 'openai', kind: 'key' });
    const claude = await startOn({ id: ACCOUNT, provider: 'anthropic', kind: 'subscription' });

    expect(key.acquire).toHaveBeenCalledWith(expect.objectContaining({ bot: 'atlas', login: null }));
    expect(claude.acquire).toHaveBeenCalledWith(expect.objectContaining({ bot: 'atlas', login: null }));
    mint.mockRestore();
  });

  it('is where the session is pointed, as the driver says it is mounted', async () => {
    setSecretStore(memory());

    const exec = await startOn({ id: SEAT, provider: 'openai', kind: 'subscription' });

    const env = vi.mocked(exec.startSession).mock.calls[0]?.[0].env ?? {};
    expect(exec.loginPath).toHaveBeenCalledWith(SEAT);
    expect(env.CODEX_HOME).toBe('/fleetadlc/login');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
  });

  it('gives a bot on a Claude subscription its token, and no API key beside it', async () => {
    setSecretStore(memory({ [modelAccountRef(ACCOUNT)]: 'sk-ant-oat01-a-long-lived-token' }));

    const exec = await startOn({ id: ACCOUNT, provider: 'anthropic', kind: 'subscription' });

    const env = vi.mocked(exec.startSession).mock.calls[0]?.[0].env ?? {};
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-a-long-lived-token');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('CODEX_HOME');
  });
});

describe('a bot on a subscription, resolved by the runner itself', () => {
  const SEAT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
  const TOKEN = 'sk-ant-oat01-a-long-lived-token';

  /** What `grok models` lists for a SuperGrok seat. */
  const GROK_SEAT = [
    { id: 'grok-4.7', createdAt: null, isDefault: true },
    { id: 'grok-4.7-build-fast', createdAt: null, isDefault: false },
    { id: 'grok-4.6', createdAt: null, isDefault: false },
  ];

  function memory(initial: Record<string, string> = {}): SecretStore {
    const data = new Map(Object.entries(initial));
    return {
      get: async (ref) => data.get(ref) ?? null,
      set: async (ref, value) => void data.set(ref, value),
      delete: async (ref) => void data.delete(ref),
      list: async (prefix = '') => [...data.keys()].filter((ref) => ref.startsWith(prefix)),
    };
  }

  function accounts(rows: Record<string, { provider: 'anthropic' | 'openai' | 'xai'; kind: 'key' | 'subscription' }>) {
    vi.mocked(modelAccounts.get).mockImplementation(async (id: string) => {
      const row = rows[id];
      return row ? { id, label: 'seat', createdAt: '2026-09-24T00:00:00.000Z', ...row } : null;
    });
  }

  function sessionEnv(exec: ExecDriver, call = 0): Record<string, string> {
    return vi.mocked(exec.startSession).mock.calls[call]?.[0].env ?? {};
  }

  it('runs grok’s default for newest:grok, asking the seat’s CLI through the sign-in service', async () => {
    // hostd never passed a subscription list here, so newest:grok on a seat
    // failed every task with "pin a model id".
    setSecretStore(memory());
    accounts({ [SEAT]: { provider: 'xai', kind: 'subscription' } });
    vi.mocked(bots.getBotByName).mockResolvedValue(
      crew({ name: 'grok', engine: 'grok', model: 'newest:grok', modelAccountId: SEAT }),
    );
    const cliModels = vi.fn(async () => GROK_SEAT);
    const exec = driver();

    await new TaskRunner(config(), exec, null, undefined, cliModels).start({ ...START, bot: 'grok' });

    expect(cliModels).toHaveBeenCalledWith(SEAT);
    expect(sessionEnv(exec)).toMatchObject({
      FLEETADLC_ENGINE: 'grok',
      FLEETADLC_MODEL: 'grok-4.7',
      FLEETADLC_MODEL_ALIAS: 'newest:grok',
      GROK_HOME: '/fleetadlc/login',
    });
  });

  it('runs the newest Opus for newest:opus on a Claude seat, listed with the seat’s token', async () => {
    setSecretStore(memory({ [modelAccountRef(ACCOUNT)]: TOKEN }));
    accounts({ [ACCOUNT]: { provider: 'anthropic', kind: 'subscription' } });
    vi.mocked(bots.getBotByName).mockResolvedValue(crew({ model: 'newest:opus', modelAccountId: ACCOUNT }));
    const asked: Headers[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        asked.push(new Headers(init?.headers));
        return new Response(
          JSON.stringify({
            data: [
              { id: 'claude-opus-5', created_at: '2026-04-01T00:00:00Z' },
              { id: 'claude-opus-5-5', created_at: '2026-09-01T00:00:00Z' },
            ],
            has_more: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const exec = driver();

    await new TaskRunner(config(), exec, null).start(START);

    expect(asked[0]?.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(asked[0]?.get('anthropic-beta')).toBe('oauth-2025-04-20');
    expect(sessionEnv(exec)).toMatchObject({
      FLEETADLC_ENGINE: 'claude',
      FLEETADLC_MODEL: 'claude-opus-5-5',
      FLEETADLC_MODEL_ALIAS: 'newest:opus',
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    });
  });

  it('follows a bot moved from an Anthropic key to an xAI seat at its next task: grok, with the seat’s login', async () => {
    // The engine is read from the bot row and the mount from the account, at
    // each start, so the console's switch needs no restart and no rebuild.
    setSecretStore(memory({ [modelAccountRef(ACCOUNT)]: 'sk-ant-api03-a-key-for-the-test' }));
    accounts({
      [ACCOUNT]: { provider: 'anthropic', kind: 'key' },
      [SEAT]: { provider: 'xai', kind: 'subscription' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5', created_at: '2026-03-01T00:00:00Z' }] }), {
          status: 200,
        }),
      ),
    );
    vi.mocked(bots.getBotByName)
      .mockResolvedValueOnce(crew({ engine: 'claude', model: 'claude-sonnet-5', modelAccountId: ACCOUNT }))
      .mockResolvedValueOnce(crew({ engine: 'grok', model: 'grok-4.7', modelAccountId: SEAT }));
    const exec = driver();
    const runner = new TaskRunner(config(), exec, null, undefined, async () => GROK_SEAT);

    await runner.start({ ...START, taskId: 'task-1' });
    await runner.start({ ...START, taskId: 'task-2' });

    expect(vi.mocked(exec.acquire).mock.calls.map(([spec]) => spec.login)).toEqual([null, { accountId: SEAT, provider: 'xai' }]);
    expect(sessionEnv(exec, 0)).toMatchObject({ FLEETADLC_ENGINE: 'claude', FLEETADLC_MODEL: 'claude-sonnet-5' });
    expect(sessionEnv(exec, 0)).not.toHaveProperty('GROK_HOME');
    expect(sessionEnv(exec, 1)).toMatchObject({ FLEETADLC_ENGINE: 'grok', FLEETADLC_MODEL: 'grok-4.7', GROK_HOME: '/fleetadlc/login' });
    // The Anthropic key does not travel with the bot to its new engine.
    expect(sessionEnv(exec, 1)).not.toHaveProperty('ANTHROPIC_API_KEY');
  });
});

describe('how many computers a host holds', () => {
  const RESOLVED = async () => ({ model: 'claude-opus-5', modelAlias: null, account: null });

  it('runs two tasks of one seat at once, each in a computer of its own', async () => {
    // One task per seat was the collision guarantee when a seat was a
    // container. A computer is a task's now, so a seat's tasks never share one.
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
    const exec = driver();
    const runner = new TaskRunner(config(), exec, null, RESOLVED);

    const [one, two] = await Promise.all([
      runner.start({ ...START, taskId: '11111111-0000-4000-8000-000000000001' }),
      runner.start({ ...START, taskId: '22222222-0000-4000-8000-000000000002', subjectRef: 'fleetadlc#156' }),
    ]);

    expect(runner.heldBy('atlas')).toBe(2);
    expect(one.session).toBe('atlas/implement-11111111');
    expect(two.session).toBe('atlas/implement-22222222');
    const slots = vi.mocked(exec.acquire).mock.calls.map(([spec]) => spec.slotDir);
    expect(new Set(slots).size).toBe(2);

    await runner.end('11111111-0000-4000-8000-000000000001', 'done');
    expect(runner.heldBy('atlas')).toBe(1);
    mint.mockRestore();
  });

  it('refuses a start past the host’s capacity, before anything is made, and says how to give it more', async () => {
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
    const exec = driver();
    const runner = new TaskRunner({ ...config(), capacityTasks: 1 }, exec, null, RESOLVED);
    await runner.start(START);

    const refused = runner.start({ ...START, taskId: 'task-2', subjectRef: 'fleetadlc#156' });

    await expect(refused).rejects.toBeInstanceOf(HostFull);
    await expect(refused).rejects.toThrow(/FLEETADLC_HOST_CAPACITY_TASKS/);
    expect(exec.acquire).toHaveBeenCalledTimes(1);
    mint.mockRestore();
  });
});

describe('a task paused on a person', () => {
  const RESOLVED = async () => ({ model: 'claude-opus-5', modelAlias: null, account: null });

  it('keeps its computer for a while, then gives it back, and resumes in a new one', async () => {
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    vi.mocked(bots.getBotById).mockResolvedValue(crew());
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
    const exec = driver();
    const runner = new TaskRunner(config(), exec, null, RESOLVED);
    await runner.start(START);
    const paused = async () => true;
    const keep = 15 * 60_000;

    // Within the time it is kept: take-over still works.
    expect(await runner.releasePausedPast(keep, paused, 1_000)).toEqual([]);
    expect(await runner.releasePausedPast(keep, paused, 1_000 + keep - 1)).toEqual([]);
    expect(runner.sessionOf('task-1')).not.toBeNull();

    // Past it: given back, and the task is still held, as released.
    expect(await runner.releasePausedPast(keep, paused, 1_000 + keep)).toEqual(['task-1']);
    expect(exec.release).toHaveBeenCalledWith('task-1', 'paused past the time its computer is kept');
    expect(runner.isReleased('task-1')).toBe(true);
    expect(runner.sessionOf('task-1')).toBeNull();
    expect(runner.computersHeld()).toBe(0);
    // On no host now, so it stops counting against its seat and the hosts.
    expect(tasks.releaseComputer).toHaveBeenCalledWith('task-1');

    // The answer resumes it on a computer of its own again.
    vi.mocked(tasks.getTask).mockResolvedValue({
      id: 'task-1',
      botId: 'bot-1',
      repoId: null,
      kind: 'implement',
      subjectRef: 'fleetadlc#155',
      branch: null,
      skill: 'implement',
      costCapUsd: 15,
      leaseId: null,
      state: 'paused',
      exitReason: null,
    } as never);
    await runner.resume('task-1', []);
    expect(exec.acquire).toHaveBeenCalledTimes(2);
    expect(exec.release).toHaveBeenCalledTimes(1);
    expect(runner.isReleased('task-1')).toBe(false);
    mint.mockRestore();
  });

  it('resumes on a computer nothing takes down, when its answer comes while its computer is being given back', async () => {
    // The release harvests under the mirror's lock, which can take minutes,
    // and then releases by task id: a resume in that window lost its new
    // computer to it, and its row lost its host fields.
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    vi.mocked(bots.getBotById).mockResolvedValue(crew());
    vi.mocked(tasks.releaseComputer).mockClear();
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
    const exec = driver();
    const runner = new TaskRunner(config(), exec, null, RESOLVED);
    await runner.start(START);
    const first = exec.computerOf('task-1');

    let unblock: () => void = () => undefined;
    let blocked: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => (blocked = resolve));
    vi.mocked(exec.killSession).mockImplementationOnce(async () => {
      blocked();
      await new Promise<void>((resolve) => (unblock = resolve));
    });
    const releasing = runner.releasePausedPast(0, async () => true);
    await reached;

    vi.mocked(tasks.getTask).mockResolvedValue({
      id: 'task-1',
      botId: 'bot-1',
      repoId: null,
      kind: 'implement',
      subjectRef: 'fleetadlc#155',
      branch: null,
      skill: 'implement',
      costCapUsd: 15,
      leaseId: null,
      state: 'paused',
      exitReason: null,
    } as never);
    const resumed = runner.resume('task-1', []);
    await new Promise((resolve) => setTimeout(resolve, 10));
    unblock();
    await releasing;
    await resumed;

    const now = exec.computerOf('task-1');
    expect(now).not.toBeNull();
    expect(now).not.toBe(first);
    expect(exec.acquire).toHaveBeenCalledTimes(2);
    expect(exec.release).toHaveBeenCalledTimes(1);
    // The row was given back before the new computer was taken, never after.
    const secondAcquire = vi.mocked(exec.acquire).mock.invocationCallOrder[1] ?? 0;
    for (const order of vi.mocked(tasks.releaseComputer).mock.invocationCallOrder) expect(order).toBeLessThan(secondAcquire);
    expect(runner.isReleased('task-1')).toBe(false);
    mint.mockRestore();
  });

  it('is said plainly to a person who opens its terminal once its computer is given back', async () => {
    vi.mocked(tasks.getTask).mockResolvedValue({ id: 'task-1', state: 'paused', branch: 'agent/atlas/155-issue-155' } as never);
    const runner = new TaskRunner(config(), driver(), null, RESOLVED);

    expect(await runner.whyNoComputer('task-1')).toEqual({
      status: 409,
      error: 'computer released while paused; work is on agent/atlas/155-issue-155. Answering its question starts it again',
    });
  });
});

describe('what a task may write, on a branch it checks out', () => {
  const repo = { id: 'repo-fleetadlc', name: 'fleetadlc', fullName: 'exampleco/fleetadlc', defaultBranch: 'main' };

  async function startOn(kind: 'review' | 'patch', skill?: string) {
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    vi.mocked(repos.getRepoByName).mockResolvedValue(repo as never);
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
    const runner = new TaskRunner(config(), driver(), null, async () => ({ model: 'claude-opus-5', modelAlias: null, account: null }));
    const internals = runner as unknown as {
      remoteFor: (fullName: string | null) => Promise<string | null>;
      worktrees: { checkoutExisting: unknown; changedFiles: unknown; pruneAbandoned: unknown };
    };
    vi.spyOn(internals, 'remoteFor').mockResolvedValue('https://github.com/exampleco/fleetadlc.git');
    internals.worktrees.pruneAbandoned = vi.fn(async () => 0);
    internals.worktrees.checkoutExisting = vi.fn(async () => ({ mirror: '/m', path: '/wt', branch: 'agent/builder/7-issue-7', baseSha: 'abc' }));
    internals.worktrees.changedFiles = vi.fn(async () => ['apps/bridge/src/attention.ts']);
    try {
      await runner.start({ ...START, taskId: `task-${kind}`, kind, skill: skill ?? (kind === 'review' ? 'pr-review' : 'implement'), repo: 'fleetadlc', branch: 'agent/builder/7-issue-7', checkoutExistingBranch: true, declaredPaths: kind === 'patch' ? ['apps/console/src/page.tsx'] : [] });
      return mint.mock.calls.at(-1)?.[0] as { declaredPaths?: string[] };
    } finally {
      mint.mockRestore();
      vi.mocked(repos.getRepoByName).mockReset();
    }
  }

  it('keeps a review to nothing but what it posts, however much the pull request changes', async () => {
    // Widened by the diff, a reviewer was briefed that it may write the code it
    // reviews — and only its prompt kept it from doing so.
    expect((await startOn('review')).declaredPaths).toEqual([]);
  });

  it('lets a patch round keep writing what its branch already changes', async () => {
    expect((await startOn('patch')).declaredPaths).toEqual(['apps/console/src/page.tsx', 'apps/bridge/src/attention.ts']);
  });

  it('keeps a conflict resolution to the conflicted files, not everything the pull request changes', async () => {
    // Widened by the diff, the resolver was briefed that it may write files the
    // other seats had already approved, and the bridge carried those approvals.
    expect((await startOn('patch', 'resolve-conflict')).declaredPaths).toEqual(['apps/console/src/page.tsx']);
  });

  it('keeps the unpushed commits of a round that writes the branch, and tells it of any set aside', async () => {
    // Resumed after the remote moved on, a builder's own commits come off the
    // branch; told nothing, it would either lose them or force them back.
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    vi.mocked(repos.getRepoByName).mockResolvedValue(repo as never);
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
    const runner = new TaskRunner(config(), driver(), null, async () => ({ model: 'claude-opus-5', modelAlias: null, account: null }));
    const internals = runner as unknown as {
      remoteFor: (fullName: string | null) => Promise<string | null>;
      worktrees: { checkoutExisting: ReturnType<typeof vi.fn>; changedFiles: unknown; pruneAbandoned: unknown };
    };
    vi.spyOn(internals, 'remoteFor').mockResolvedValue('https://github.com/exampleco/fleetadlc.git');
    internals.worktrees.pruneAbandoned = vi.fn(async () => 0);
    internals.worktrees.changedFiles = vi.fn(async () => []);
    const setAside = { ref: 'refs/fleetadlc/unpushed/agent/builder/7-issue-7', tip: 'b'.repeat(40), commits: ['b'.repeat(40)], reason: 'moved' as const };
    internals.worktrees.checkoutExisting = vi.fn(async () => ({ mirror: '/m', path: '/wt', branch: 'agent/builder/7-issue-7', baseSha: 'abc', setAside }));
    try {
      for (const [kind, keeps] of [['patch', true], ['review', false]] as const) {
        await runner.start({ ...START, taskId: `task-${kind}`, kind, skill: kind === 'review' ? 'pr-review' : 'implement', repo: 'fleetadlc', branch: 'agent/builder/7-issue-7', checkoutExistingBranch: true });
        expect(internals.worktrees.checkoutExisting.mock.calls.at(-1)?.[0]).toMatchObject({ keepUnpushed: keeps });
      }
      const files = (mint.mock.calls.at(-1)?.[0] as { contextFiles: string[] }).contextFiles;
      const note = files.find((file) => file.endsWith('set-aside-commits.md'));
      expect(note).toBeDefined();
      expect(readFileSync(note!, 'utf8')).toContain(`git cherry-pick ${'b'.repeat(40)}`);
    } finally {
      mint.mockRestore();
      vi.mocked(repos.getRepoByName).mockReset();
    }
  });
});

describe('resuming a task, what it may write', () => {
  it('writes where its lease let it before the pause, not only tests and docs', async () => {
    // Found live: resumed after a question, the builder's grant
    // held only the defaults, and it ended without building anything.
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    vi.mocked(bots.getBotById).mockResolvedValue(crew());
    vi.mocked(tasks.getTask).mockResolvedValue({
      id: 'task-1', botId: 'bot-1', repoId: null, kind: 'implement', subjectRef: 'fleetadlc#78', branch: null,
      skill: 'implement', costCapUsd: 15, leaseId: 'lease-78',
    } as never);
    vi.mocked(leases.getLease).mockResolvedValue({ id: 'lease-78', declaredPaths: ['apps/bridge/src/webhooks.ts'] } as never);
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
    const runner = new TaskRunner(config(), driver(), null, async () => ({ model: 'claude-opus-5', modelAlias: null, account: null }));
    try {
      await runner.resume('task-1', []);
      expect(mint).toHaveBeenCalledWith(expect.objectContaining({ declaredPaths: ['apps/bridge/src/webhooks.ts'] }));
    } finally {
      mint.mockRestore();
    }
  });
});

describe('resuming a task whose pull request was merged or closed', () => {
  it('stops it, says so on the task, and stops it again on the next resume', async () => {
    // The first resume sees the branch gone after it was pushed. By the second,
    // that fetch has pruned the branch and the record of its push, so the
    // branch looked never pushed and the builder started over from the base.
    const repo = { id: 'repo-fleetadlc', name: 'fleetadlc', fullName: 'exampleco/fleetadlc', defaultBranch: 'main' };
    const paused = {
      id: 'task-9', botId: 'bot-1', repoId: repo.id, kind: 'implement', subjectRef: 'fleetadlc#9',
      branch: 'agent/atlas/9-issue-9', skill: 'implement', costCapUsd: 15, leaseId: null, exitReason: null,
    };
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    vi.mocked(bots.getBotById).mockResolvedValue(crew());
    vi.mocked(repos.listRepos).mockResolvedValue([repo] as never);
    vi.mocked(repos.getRepoByName).mockResolvedValue(repo as never);
    vi.mocked(tasks.getTask).mockResolvedValue(paused as never);
    vi.mocked(tasks.updateTaskState).mockReset().mockResolvedValue(null);
    const runner = new TaskRunner(config(), driver(), null, async () => ({ model: 'claude-opus-5', modelAlias: null, account: null }));
    const internals = runner as unknown as {
      remoteFor: (fullName: string | null) => Promise<string | null>;
      worktrees: { checkoutExisting: ReturnType<typeof vi.fn>; pruneAbandoned: unknown };
    };
    vi.spyOn(internals, 'remoteFor').mockResolvedValue('https://github.com/exampleco/fleetadlc.git');
    internals.worktrees.pruneAbandoned = vi.fn(async () => 0);
    const reason = `agent/atlas/9-issue-9 was deleted on exampleco/fleetadlc after this task pushed it: ${BRANCH_GONE}. Everything it had committed had been pushed.`;
    internals.worktrees.checkoutExisting = vi.fn(async () => {
      throw new BranchGoneError(reason);
    });
    try {
      await expect(runner.resume('task-9', [])).rejects.toThrow(BRANCH_GONE);
      expect(tasks.updateTaskState).toHaveBeenCalledWith('task-9', 'failed', { exitReason: reason });

      // Resumed again, with the reason it was stopped for on the task.
      vi.mocked(tasks.getTask).mockResolvedValue({ ...paused, state: 'failed', exitReason: reason } as never);
      await expect(runner.resume('task-9', [])).rejects.toThrow(BRANCH_GONE);
      expect(internals.worktrees.checkoutExisting).toHaveBeenCalledTimes(1);
    } finally {
      vi.mocked(repos.listRepos).mockReset();
      vi.mocked(repos.listRepos).mockResolvedValue([]);
      vi.mocked(repos.getRepoByName).mockReset();
    }
  });
});

describe('a task’s computer', () => {
  const RESOLVED = async () => ({ model: 'claude-opus-5', modelAlias: null, account: null });

  it('is in its own directory, and is given back when the task ends, after the session is stopped', async () => {
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
    const exec = driver();
    const order: string[] = [];
    vi.mocked(exec.killSession).mockImplementation(async () => void order.push('session killed'));
    vi.mocked(exec.release).mockImplementation(async () => void order.push('computer released'));
    const runner = new TaskRunner(config(), exec, null, RESOLVED);

    const started = await runner.start(START);
    // `<work root>/slots/<task>-<start>`: the clone, the briefing and the home beside it.
    const first = vi.mocked(exec.acquire).mock.calls[0]?.[0].slotDir ?? '';
    expect(dirname(first)).toBe(join(scratch, 'work', 'slots'));
    expect(basename(first)).toMatch(/^task-1-[a-z0-9]+$/);
    expect(started.worktree).toBe(`${first}/wt`);

    await runner.end('task-1', 'done');
    expect(order).toEqual(['session killed', 'computer released']);
    expect(exec.release).toHaveBeenCalledWith('task-1', 'done');

    // Started again — a resume — it is in a folder of its own, never the last
    // one's path: under OrbStack a folder deleted and made again at once at
    // the same path was still missing inside the new container.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runner.start(START);
    const second = vi.mocked(exec.acquire).mock.calls[1]?.[0].slotDir ?? '';
    expect(dirname(second)).toBe(join(scratch, 'work', 'slots'));
    expect(basename(second)).toMatch(/^task-1-[a-z0-9]+$/);
    expect(second).not.toBe(first);
    mint.mockRestore();
  });

  it('is given back when the task’s start fails after it was acquired, since no task holds it', async () => {
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
    const exec = driver();
    vi.mocked(exec.startSession).mockRejectedValue(new Error('tmux new-session failed: no server'));
    const runner = new TaskRunner(config(), exec, null, RESOLVED);

    await expect(runner.start(START)).rejects.toThrow(/no server/);

    expect(exec.release).toHaveBeenCalledWith('task-1', 'its start failed');
    expect(runner.activeTaskIds()).toEqual([]);
    mint.mockRestore();
  });
});

describe('a task with no repository', () => {
  const RESOLVED = async () => ({ model: 'claude-opus-5', modelAlias: null, account: null });

  /**
   * A driver that looks at the real filesystem, as a container does: `git -C`
   * fails on a directory with no `.git`, and `test -d` on one that is not
   * there. The usual mock answered 0 to everything, which hid that a task
   * with no repository could never start.
   */
  function looking(): ExecDriver {
    const exec = driver();
    vi.mocked(exec.exec).mockImplementation(async (_computer, command) => {
      const [binary, ...args] = command;
      if (binary === 'git' && args[0] === '-C') {
        const seen = existsSync(join(args[1] ?? '', '.git'));
        return seen ? { code: 0, stdout: '.git', stderr: '' } : { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
      }
      if (binary === 'test' && args[0] === '-d') return { code: existsSync(args[1] ?? '') ? 0 : 1, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    return exec;
  }

  it('starts in an empty directory of its own, made before it is looked for', async () => {
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
    const exec = looking();
    const runner = new TaskRunner({ ...config(), workRoot: loginRoot }, exec, null, RESOLVED);
    try {
      const started = await runner.start({ ...START, repo: null });

      expect(statSync(started.worktree).isDirectory()).toBe(true);
      expect(vi.mocked(exec.startSession).mock.calls[0]?.[0].cwd).toBe(started.worktree);
      const commands = vi.mocked(exec.exec).mock.calls.map(([, command]) => command[0]);
      expect(commands).not.toContain('git');
    } finally {
      mint.mockRestore();
    }
  });

  it('is still refused, with the directory named and no word of git, when its directory is missing', async () => {
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
    const exec = looking();
    vi.mocked(exec.exec).mockResolvedValue({ code: 1, stdout: '', stderr: '' });
    const runner = new TaskRunner({ ...config(), workRoot: loginRoot }, exec, null, RESOLVED);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const refused = runner.start({ ...START, repo: null });
      await expect(refused).rejects.toThrow(/has no directory at \/.+\/wt in its computer/);
      await expect(refused).rejects.not.toThrow(/git/);
      expect(vi.mocked(exec.exec)).toHaveBeenCalledWith(expect.anything(), ['test', '-d', expect.stringMatching(/\/wt$/)]);
    } finally {
      mint.mockRestore();
      warn.mockRestore();
    }
  });

  it('leaves the git check on a task whose clone is missing', async () => {
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    vi.mocked(repos.getRepoByName).mockResolvedValue({ id: 'repo-widgets', name: 'widgets', fullName: 'exampleco/widgets', defaultBranch: 'main' } as never);
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
    const runner = new TaskRunner({ ...config(), workRoot: loginRoot }, looking(), null, RESOLVED);
    const internals = runner as unknown as { remoteFor: () => Promise<string | null>; worktrees: { create: unknown } };
    vi.spyOn(internals, 'remoteFor').mockResolvedValue('https://github.com/exampleco/widgets.git');
    // A clone that never reached the directory the computer sees.
    internals.worktrees.create = vi.fn(async () => ({ path: join(loginRoot, 'nowhere'), mirror: '/m', branch: 'agent/atlas/7-issue-7', setAside: null }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(runner.start({ ...START, repo: 'widgets' })).rejects.toThrow(/cannot see its worktree/);
    } finally {
      mint.mockRestore();
      warn.mockRestore();
      vi.mocked(repos.getRepoByName).mockReset();
    }
  });
});

describe('a task adopted after hostd restarts', () => {
  it('runs local CI against the database its computer was started with', async () => {
    // `docker exec` does not inherit the session's environment, so a URL left
    // null here was a `make ci` with no database for every adopted builder.
    const runner = new TaskRunner({ ...config(), workRoot: loginRoot }, driver(), null);
    const url = 'postgres://t_task1:derived@host.docker.internal:47433/t_task1';
    const slotDir = join(loginRoot, 'slots', 'task-1-abc');

    runner.adopt(
      { id: 'task-1', kind: 'implement', branch: 'agent/atlas/7-issue-7', tmuxSession: 'atlas/implement-task1' },
      { taskId: 'task-1', bot: 'atlas', container: 'task-task1', databaseUrl: url, slotDir },
      'exampleco/widgets',
    );

    expect(runner.localCiTarget('task-1')?.env.DATABASE_URL).toBe(url);
  });
});

describe('a task cancelled on the host', () => {
  it('settles its lease as a task that ends through the bridge does, since a restart or a drain never reaches that route', async () => {
    vi.mocked(tasks.updateTaskState).mockResolvedValue({ id: 'task-1', subjectRef: 'fleetadlc#78', leaseId: 'lease-78' } as never);
    const runner = new TaskRunner(config(), driver(), null);

    await runner.cancel('task-1', 'container restarted');

    expect(tasks.updateTaskState).toHaveBeenCalledWith('task-1', 'stopped', { exitReason: 'container restarted' });
    expect(leases.settlePausedLeases).toHaveBeenCalledWith({
      leaseId: 'lease-78',
      actor: 'hostd',
      reason: 'its task on fleetadlc#78 stopped: container restarted',
      holdUntil: expect.any(Date),
    });
  });

  it('is still stopped when the lease cannot be settled: the reconciler sweeps it', async () => {
    vi.mocked(tasks.updateTaskState).mockResolvedValue({ id: 'task-1', subjectRef: 'fleetadlc#78', leaseId: 'lease-78' } as never);
    vi.mocked(leases.settlePausedLeases).mockRejectedValueOnce(new Error('connection reset'));
    const runner = new TaskRunner(config(), driver(), null);

    await expect(runner.cancel('task-1', 'hostd shutting down')).resolves.toBeUndefined();
  });
});

/**
 * A start takes seconds to minutes, and its task is held only at the end. A
 * cancel in that window found nothing to end and wrote `stopped`; the start
 * then launched the session and wrote `running` over it, and the work a
 * person stopped ran on.
 */
describe('a task cancelled while it is starting', () => {
  const RESOLVED = async () => ({ model: 'claude-opus-5', modelAlias: null, account: null });

  /** A runner whose computer is handed over only when the test says. */
  function paused() {
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
    const exec = driver();
    const runner = new TaskRunner(config(), exec, null, RESOLVED);
    let handOver: () => void = () => undefined;
    let acquired: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => (acquired = resolve));
    const acquire = exec.acquire;
    exec.acquire = vi.fn(async (spec: TaskComputerSpec) => {
      const computer = await acquire(spec);
      acquired();
      await new Promise<void>((resolve) => (handOver = resolve));
      return computer;
    });
    const states = () => vi.mocked(tasks.updateTaskState).mock.calls.map((call) => call[1]);
    return { exec, runner, mint, reached, handOver: () => handOver(), states };
  }

  it('is stopped, and its start starts no session and gives its computer back', async () => {
    const { exec, runner, mint, reached, handOver, states } = paused();

    const starting = runner.start(START);
    await reached;
    await runner.cancel('task-1', 'stopped by a person');
    handOver();

    await expect(starting).rejects.toThrow(/stopped while it was starting/);
    expect(states()).toEqual(['stopped']);
    expect(exec.startSession).not.toHaveBeenCalled();
    expect(exec.release).toHaveBeenCalledWith('task-1', 'its start failed');
    expect(runner.activeTaskIds()).toEqual([]);
    mint.mockRestore();
  });

  it('is stopped by a drain too, not only once it is held', async () => {
    const { exec, runner, mint, reached, handOver, states } = paused();
    vi.mocked(tasks.getTask).mockResolvedValue({ id: 'task-1', state: 'queued' } as never);

    const starting = runner.start(START);
    await reached;
    expect(runner.startingTaskIds('atlas')).toEqual(['task-1']);
    expect(await runner.drain('hostd is stopping')).toEqual({ stopped: ['task-1'], kept: [], timedOut: [] });
    handOver();

    await expect(starting).rejects.toThrow(/stopped while it was starting/);
    expect(states()).toEqual(['stopped']);
    expect(exec.startSession).not.toHaveBeenCalled();
    mint.mockRestore();
  });

  it('kills the session it made and gives the computer back when its task had already ended', async () => {
    // The bridge failed it, its start request having timed out, or it was
    // stopped: the store refuses `running` over either.
    vi.mocked(bots.getBotByName).mockResolvedValue(crew());
    const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
    vi.mocked(tasks.updateTaskState).mockResolvedValue(null);
    const exec = driver();
    const runner = new TaskRunner(config(), exec, null, RESOLVED);

    await expect(runner.start(START)).rejects.toThrow(/had already ended/);

    expect(exec.startSession).toHaveBeenCalled();
    expect(exec.killSession).toHaveBeenCalledWith('atlas', 'implement-task1');
    expect(exec.release).toHaveBeenCalledWith('task-1', 'its task had already ended');
    expect(runner.activeTaskIds()).toEqual([]);
    mint.mockRestore();
  });
});

/**
 * `make setup` had no limit. One that hung kept its start in "starting", which
 * counts against the host's capacity, so a few of them filled the host.
 */
describe('a make setup that does not finish', () => {
  it('is stopped at its limit, warned about, and the start goes on as for any failed setup', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const worktree = join(loginRoot, 'wt');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, 'Makefile'), 'setup:\n\tsleep 3600\n');
    const exec = driver();
    vi.mocked(exec.exec).mockResolvedValue({ code: 124, stdout: '', stderr: '', timedOut: true } as never);
    const runner = new TaskRunner({ ...config(), setupTimeoutMinutes: 20 }, exec, null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const computer = { taskId: 'task-1', bot: 'atlas', container: null, databaseUrl: 'postgres://t', slotDir: loginRoot };

    await (runner as unknown as { prepare: (...args: unknown[]) => Promise<void> }).prepare(computer, worktree, 'postgres://t', join(loginRoot, 'home'));

    expect(exec.exec).toHaveBeenCalledWith(computer, ['make', '-s', 'setup'], expect.objectContaining({ timeoutMs: 20 * 60_000 }));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/make setup did not finish within 20 minutes/));
    warn.mockRestore();
  });
});

/** A task started with a repository, its clone and its pnpm store stood in for. */
async function starting(
  fill: () => Promise<unknown>,
  overrides: Partial<HostdConfig> = {},
  start: Partial<Pick<StartTaskInput, 'kind' | 'skill' | 'branch' | 'checkoutExistingBranch'>> = {},
) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const repo = { id: 'repo-widgets', name: 'widgets', fullName: 'exampleco/widgets', defaultBranch: 'main' };
  const worktree = join(loginRoot, 'clone');
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, 'Makefile'), 'setup:\n\tpnpm install --frozen-lockfile\n');
  vi.mocked(bots.getBotByName).mockResolvedValue(crew({ sidecarDb: true }));
  vi.mocked(repos.getRepoByName).mockResolvedValue(repo as never);
  const mint = vi.spyOn(SessionEnvMinter.prototype, 'mint').mockResolvedValue({ env: {}, cleanup: async () => undefined });
  const order: string[] = [];
  const exec = driver();
  const acquire = exec.acquire;
  exec.acquire = vi.fn(async (spec: TaskComputerSpec) => ({ ...(await acquire(spec)), databaseUrl: 'postgres://t', repoKey: 'exampleco__widgets' }));
  exec.fillPnpmStore = vi.fn(async () => {
    order.push('fill');
    return fill();
  }) as never;
  vi.mocked(exec.exec).mockImplementation(async (_computer, command) => {
    if (command.includes('setup')) order.push('make setup');
    return { code: 0, stdout: '.git', stderr: '' };
  });
  const runner = new TaskRunner({ ...config(), workRoot: loginRoot, ...overrides }, exec, null, async () => ({ model: 'claude-opus-5', modelAlias: null, account: null }));
  const internals = runner as unknown as { remoteFor: () => Promise<string | null>; worktrees: { create: unknown } };
  vi.spyOn(internals, 'remoteFor').mockResolvedValue('https://github.com/exampleco/widgets.git');
  const checkedOut = { path: worktree, mirror: '/mirrors/exampleco__widgets.git', branch: 'agent/atlas/7-issue-7', setAside: null };
  internals.worktrees.create = vi.fn(async () => checkedOut);
  (internals.worktrees as unknown as { checkoutExisting: unknown }).checkoutExisting = vi.fn(async () => checkedOut);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    await runner.start({ ...START, repo: 'widgets', ...start });
  } finally {
    mint.mockRestore();
    vi.mocked(repos.getRepoByName).mockReset();
  }
  const setupEnv = vi.mocked(exec.exec).mock.calls.find(([, command]) => command.includes('setup'))?.[2]?.env ?? {};
  const sessionEnv = vi.mocked(exec.startSession).mock.calls[0]?.[0].env ?? {};
  const ciEnv = runner.localCiTarget('task-1')?.env ?? {};
  return { exec, worktree, order, setupEnv, sessionEnv, ciEnv, warn };
}

/**
 * The repository's pnpm store is read-only in the task's computer, and hostd
 * fills it from the task's lockfile as it starts. `make setup`, the session
 * and local CI have to install from the same store, or pnpm stops on a
 * node_modules another store built.
 */
describe('the homes of task directories the sweep removes', () => {
  /** A runner whose worktree sweep removes nothing: what is left is what the home sweep did. */
  function sweeping(): TaskRunner {
    const runner = new TaskRunner(config(), driver(), null);
    const internals = runner as unknown as { worktrees: { pruneAbandoned: unknown; pruneSlots: unknown } };
    internals.worktrees.pruneAbandoned = vi.fn(async () => 0);
    internals.worktrees.pruneSlots = vi.fn(async () => 0);
    return runner;
  }

  /** A home per name under the login root; a slot for each name in `slots`, in the shared root and a bot's own. */
  function lay(shared: string[], own: string[], homeless: string[]): void {
    for (const name of shared) mkdirSync(join(config().workRoot, 'slots', name), { recursive: true });
    for (const name of own) mkdirSync(join(config().workRoot, 'atlas', 'slots', name), { recursive: true });
    for (const name of [...shared, ...own, ...homeless]) mkdirSync(join(loginRoot, '.homes', name), { recursive: true });
  }

  it('drops a home whose slot is gone after the shared slots are pruned, and keeps one whose slot is still anywhere', async () => {
    // The home is beside the login root, not in the slot, so removing the
    // slot left it, with whatever the task wrote there.
    lay(['live-1'], ['legacy-1'], ['gone-1']);

    await sweeping().pruneAbandonedSlots();

    expect(readdirSync(join(loginRoot, '.homes')).sort()).toEqual(['legacy-1', 'live-1']);
  });

  it('does the same after a bot’s own worktrees and slots are pruned', async () => {
    lay(['live-1'], ['legacy-1'], ['gone-1', 'gone-2']);

    await sweeping().pruneAbandonedWorktrees('atlas');

    expect(readdirSync(join(loginRoot, '.homes')).sort()).toEqual(['legacy-1', 'live-1']);
  });
});

describe('the pnpm store a task installs from', () => {
  it('is the repository’s, filled from the task’s worktree before make setup, and the same for the session and local CI', async () => {
    const { exec, worktree, order, setupEnv, sessionEnv, ciEnv, warn } = await starting(async () => ({ filled: true, path: '/pnpm-store' }));

    expect(exec.fillPnpmStore).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1' }), worktree);
    expect(order).toEqual(['fill', 'make setup']);
    for (const env of [setupEnv, sessionEnv, ciEnv]) expect(env.FLEETADLC_PNPM_STORE).toBe('/pnpm-store');
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('pnpm'))).toEqual([]);
    warn.mockRestore();
  });

  it('is the task’s own, said once with the repository and why, when the fill failed, and the task still starts', async () => {
    const { setupEnv, sessionEnv, ciEnv, warn } = await starting(async () => ({ filled: false, skipped: false, reason: 'pnpm fetch exited 1: ERR_PNPM_FETCH_404' }));

    for (const env of [setupEnv, sessionEnv, ciEnv]) expect(env).not.toHaveProperty('FLEETADLC_PNPM_STORE');
    expect(warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('pnpm'))).toEqual([
      '[hostd] exampleco/widgets: its pnpm store could not be filled, so task task-1 installs into a store of its own: pnpm fetch exited 1: ERR_PNPM_FETCH_404',
    ]);
    warn.mockRestore();
  });

  it('does not run a pull request’s make setup when a review checks that branch out', async () => {
    // The Makefile is the pull request's. hostd would run it before the
    // session, outside the skill's tools, with the task token.
    const { exec, order, warn } = await starting(async () => ({ filled: true, path: '/pnpm-store' }), {}, {
      kind: 'review',
      skill: 'pr-review',
      branch: 'agent/outsider/7-issue-7',
      checkoutExistingBranch: true,
    });

    expect(order).toEqual(['fill']);
    expect(vi.mocked(exec.exec).mock.calls.some(([, command]) => command.includes('setup'))).toBe(false);
    expect(exec.startSession).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('still runs make setup for a patch that checks out the branch it writes', async () => {
    const { order, warn } = await starting(async () => ({ filled: true, path: '/pnpm-store' }), {}, {
      kind: 'patch',
      skill: 'implement',
      branch: 'agent/atlas/7-issue-7',
      checkoutExistingBranch: true,
    });

    expect(order).toEqual(['fill', 'make setup']);
    warn.mockRestore();
  });
});

/**
 * `fleetadlc-install` asks hostd for the registry credential with the task's
 * own id and token. hostd's own `make setup` and the `make ci` behind
 * `fleetadlc-ci` ran with neither, so the wrapper installed with no credential.
 */
describe('what the installs hostd runs itself are given for the registry', () => {
  it('is the task’s id, token and hostd URL in make setup and local CI, and the flag when a registry is configured', async () => {
    setSecretStore(memory({ [internalSecretRef()]: 'install-secret' }));
    const { setupEnv, ciEnv, warn } = await starting(async () => ({ filled: true, path: '/pnpm-store' }), {
      registryHost: 'npm.internal.example',
      taskHostdUrl: 'http://host.docker.internal:58612',
    });
    warn.mockRestore();

    for (const env of [setupEnv, ciEnv]) {
      expect(env).toMatchObject({
        FLEETADLC_HOSTD_URL: 'http://host.docker.internal:58612',
        FLEETADLC_TASK_ID: 'task-1',
        FLEETADLC_TASK_TOKEN: taskTokenFor('task-1', 'install-secret'),
        FLEETADLC_REGISTRY_CONFIGURED: '1',
      });
    }
  });

  it('carries no flag without a registry', async () => {
    setSecretStore(memory({ [internalSecretRef()]: 'install-secret' }));
    const { setupEnv, ciEnv, warn } = await starting(async () => ({ filled: true, path: '/pnpm-store' }));
    warn.mockRestore();

    for (const env of [setupEnv, ciEnv]) {
      expect(env.FLEETADLC_TASK_TOKEN).toBe(taskTokenFor('task-1', 'install-secret'));
      expect(env).not.toHaveProperty('FLEETADLC_REGISTRY_CONFIGURED');
    }
  });
});

function memory(initial: Record<string, string> = {}): SecretStore {
  const data = new Map(Object.entries(initial));
  return {
    get: async (ref) => data.get(ref) ?? null,
    set: async (ref, value) => void data.set(ref, value),
    delete: async (ref) => void data.delete(ref),
    list: async (prefix = '') => [...data.keys()].filter((ref) => ref.startsWith(prefix)),
  };
}
