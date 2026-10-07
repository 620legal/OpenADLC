import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelAccountRef, setSecretStore, TASK_TOKEN_HEADER, taskTokenFor, type SecretStore } from '@fleetadlc/github';
import type { AccountCheck, SubscriptionLogin } from '@fleetadlc/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The routes that sign a subscription in, check an account and forget a
 * login, and what `/engines` now says about a bot on a subscription. The
 * sign-in service itself is `logins.test.ts`; this is what reaches the wire.
 */

const SEAT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const CLAUDE_SEAT = '550e8400-e29b-41d4-a716-446655440000';
const INSTALL_SECRET = 'install-secret-for-the-test';
const PLATFORM = { 'x-fleetadlc-internal-secret': INSTALL_SECRET, 'x-fleetadlc-on-behalf-of': 'ada' };
/** A sign-in folder's auth.json, encoded here rather than written out for a secret scanner to raise. */
const SIGN_IN_FILE = Buffer.from('{"tokens":"zzz"}').toString('base64');

const CREW = [
  { name: 'quill', engine: 'codex', modelAccountId: SEAT },
  { name: 'atlas', engine: 'claude', modelAccountId: CLAUDE_SEAT },
];
const ACCOUNTS: Record<string, { id: string; provider: string; kind: string }> = {
  [SEAT]: { id: SEAT, provider: 'openai', kind: 'subscription' },
  [CLAUDE_SEAT]: { id: CLAUDE_SEAT, provider: 'anthropic', kind: 'subscription' },
};

vi.mock('@fleetadlc/db', () => ({
  audit: vi.fn(async () => undefined),
  bots: {
    setBotStatus: vi.fn(),
    getBotByName: vi.fn(async (name: string) => CREW.find((bot) => bot.name === name) ?? null),
    listBots: vi.fn(async () => CREW),
  },
  modelAccounts: { get: vi.fn(async (id: string) => ACCOUNTS[id] ?? null) },
  costs: { taskSpend: vi.fn(async () => 0) },
  sessions: { removeSessionsForBot: vi.fn() },
  tasks: { getTask: vi.fn(async () => null) },
}));

import { audit } from '@fleetadlc/db';

function memory(initial: Record<string, string> = {}): SecretStore {
  const data = new Map(Object.entries(initial));
  return {
    get: async (ref) => data.get(ref) ?? null,
    set: async (ref, value) => void data.set(ref, value),
    delete: async (ref) => void data.delete(ref),
    list: async (prefix = '') => [...data.keys()].filter((ref) => ref.startsWith(prefix)),
  };
}

const WAITING: SubscriptionLogin = {
  state: 'waiting',
  url: 'https://auth.openai.com/codex/device',
  code: 'URPK-DI1GG',
  startedAt: '2026-09-24T08:00:00.000Z',
};

let loginRoot: string;
let server: Awaited<ReturnType<typeof start>>;
const saved = { ...process.env };

function logins() {
  return {
    start: vi.fn(async (): Promise<SubscriptionLogin> => WAITING),
    status: vi.fn(async (): Promise<SubscriptionLogin> => ({ state: 'signed-in' })),
    forget: vi.fn(async () => undefined),
    verify: vi.fn(
      async (): Promise<AccountCheck> => ({
        ok: false,
        message: 'Not logged in · Please run /login',
        checkedAt: '2026-09-24T08:00:00.000Z',
      }),
    ),
    models: vi.fn(async (): Promise<{ id: string; createdAt: string | null; isDefault?: boolean }[]> => [
      { id: 'grok-4.7', createdAt: null, isDefault: true },
      { id: 'grok-4.6', createdAt: null },
    ]),
    signInFiles: vi.fn(async (): Promise<Record<string, string> | null> => ({ 'auth.json': SIGN_IN_FILE })),
    adoptSignIn: vi.fn(
      async (): Promise<AccountCheck> => ({ ok: true, message: 'answered: OK', checkedAt: '2026-09-24T08:00:00.000Z' }),
    ),
  };
}

async function start(
  service: ReturnType<typeof logins> | undefined,
  parts: { runner?: object; driver?: object } = {},
) {
  const { createHostdServer } = await import('./server.js');
  const { RegistryCredentials } = await import('./registry.js');
  const { AttachTokens } = await import('./attach-tokens.js');

  const http = createHostdServer({
    config: { hostName: 'test', driver: 'local', loginRoot } as never,
    driver: (parts.driver ?? { kind: 'local', loginPath: (id: string) => join(loginRoot, id) }) as never,
    runner: (parts.runner ?? { activeTaskIds: () => [], sessionOf: () => null }) as never,
    attachTokens: new AttachTokens(),
    registry: new RegistryCredentials(null),
    perTaskCapUsd: 10,
    secret: async () => INSTALL_SECRET,
    logins: service as never,
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;

  return {
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
    async call(method: string, path: string, headers: Record<string, string> = PLATFORM, body?: unknown) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
  };
}

beforeEach(() => {
  loginRoot = mkdtempSync(join(tmpdir(), 'fleetadlc-server-logins-'));
  vi.mocked(audit).mockClear();
  // Readiness counts a key in hostd's own environment too; none here.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.XAI_API_KEY;
});

afterEach(async () => {
  await server?.close();
  rmSync(loginRoot, { recursive: true, force: true });
  process.env = { ...saved };
});

describe('signing a subscription in through hostd', () => {
  it('starts the sign-in and hands back the link and code, which nothing audits', async () => {
    const service = logins();
    server = await start(service);

    const started = await server.call('POST', `/model-accounts/${SEAT}/login`);

    expect(started.status).toBe(200);
    expect(started.body).toEqual(WAITING);
    expect(service.start).toHaveBeenCalledWith(SEAT);
    const audited = JSON.stringify(vi.mocked(audit).mock.calls);
    expect(audited).toContain('model_account.sign_in');
    expect(audited).not.toContain('URPK-DI1GG');
    expect(audited).not.toContain('auth.openai.com');
  });

  it('says where a sign-in stands, and forgets a login', async () => {
    const service = logins();
    server = await start(service);

    expect((await server.call('GET', `/model-accounts/${SEAT}/login`)).body).toEqual({ state: 'signed-in' });
    expect((await server.call('DELETE', `/model-accounts/${SEAT}/login`)).status).toBe(200);
    expect(service.forget).toHaveBeenCalledWith(SEAT);
  });

  it('checks an account and audits whether it answered, not what it said', async () => {
    const service = logins();
    server = await start(service);

    const checked = await server.call('POST', `/model-accounts/${SEAT}/verify`);

    expect(checked.body).toMatchObject({ ok: false, message: 'Not logged in · Please run /login' });
    const entry = vi.mocked(audit).mock.calls.find(([input]) => input.action === 'model_account.checked')?.[0];
    expect(entry?.payload).toMatchObject({ ok: false });
    expect(JSON.stringify(entry)).not.toContain('Not logged in');
  });

  it('is refused to a caller without the install’s secret', async () => {
    const service = logins();
    server = await start(service);

    expect((await server.call('POST', `/model-accounts/${SEAT}/login`, {})).status).toBe(401);
    expect((await server.call('POST', `/model-accounts/${SEAT}/verify`, {})).status).toBe(401);
    expect(service.start).not.toHaveBeenCalled();
    expect(service.verify).not.toHaveBeenCalled();
  });

  it('answers 404 for an id that cannot be an account, before anything runs', async () => {
    const service = logins();
    server = await start(service);

    expect((await server.call('POST', '/model-accounts/..%2F..%2Fetc/login')).status).toBe(404);
    expect(service.start).not.toHaveBeenCalled();
  });

  it('passes on a refusal with its status', async () => {
    const { LoginRefused } = await import('./logins.js');
    const service = logins();
    service.start.mockRejectedValueOnce(new LoginRefused(400, 'an API key account has nothing to sign in to'));
    server = await start(service);

    const refused = await server.call('POST', `/model-accounts/${SEAT}/login`);

    expect(refused).toEqual({ status: 400, body: { error: 'an API key account has nothing to sign in to' } });
  });

  it('says so when it was started without a sign-in service', async () => {
    server = await start(undefined);

    expect((await server.call('POST', `/model-accounts/${SEAT}/login`)).status).toBe(503);
  });
});

describe('a sign-in folder through hostd, for a backup and a restore', () => {
  it('hands the files to the bridge, and audits nothing of them', async () => {
    const service = logins();
    server = await start(service);

    const read = await server.call('GET', `/model-accounts/${SEAT}/login/files`);

    expect(read).toEqual({ status: 200, body: { files: { 'auth.json': SIGN_IN_FILE } } });
    expect(service.signInFiles).toHaveBeenCalledWith(SEAT);
  });

  it('takes one over only by checking it, and audits which account, how many files and whether it answered — never what they hold', async () => {
    const service = logins();
    server = await start(service);

    const files = { 'auth.json': SIGN_IN_FILE };
    const adopted = await server.call('POST', `/model-accounts/${SEAT}/login/adopt`, PLATFORM, { files });

    expect(adopted).toEqual({ status: 200, body: { ok: true, message: 'answered: OK', checkedAt: '2026-09-24T08:00:00.000Z' } });
    expect(service.adoptSignIn).toHaveBeenCalledWith(SEAT, files);
    const entry = vi.mocked(audit).mock.calls.find(([input]) => input.action === 'model_account.login_adopted')?.[0];
    expect(entry?.payload).toMatchObject({ files: 1, ok: true });
    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain('eyJ0b2tlbnMi');
  });

  it('no longer writes a sign-in folder as it is handed one', async () => {
    const service = logins();
    server = await start(service);

    const put = await server.call('PUT', `/model-accounts/${SEAT}/login/files`, PLATFORM, { files: { 'auth.json': 'e30=' } });

    expect(put.status).toBe(404);
    expect(service.adoptSignIn).not.toHaveBeenCalled();
  });

  it('is refused to a caller without the install’s secret, and a body that is not files', async () => {
    const service = logins();
    server = await start(service);

    expect((await server.call('GET', `/model-accounts/${SEAT}/login/files`, {})).status).toBe(401);
    expect((await server.call('POST', `/model-accounts/${SEAT}/login/adopt`, PLATFORM, { files: ['auth.json'] })).status).toBe(400);
    expect(service.signInFiles).not.toHaveBeenCalled();
    expect(service.adoptSignIn).not.toHaveBeenCalled();
  });
});

describe('asking an xAI seat what it can call, through hostd', () => {
  it('answers grok’s list with the default marked, and audits nothing for a read', async () => {
    const service = logins();
    server = await start(service);

    const listed = await server.call('GET', `/model-accounts/${SEAT}/models`);

    expect(listed).toEqual({
      status: 200,
      body: {
        models: [
          { id: 'grok-4.7', createdAt: null, isDefault: true },
          { id: 'grok-4.6', createdAt: null, isDefault: false },
        ],
      },
    });
    expect(service.models).toHaveBeenCalledWith(SEAT);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it('is refused to a caller without the install’s secret, and to an id that cannot be an account', async () => {
    const service = logins();
    server = await start(service);

    expect((await server.call('GET', `/model-accounts/${SEAT}/models`, {})).status).toBe(401);
    expect((await server.call('GET', '/model-accounts/..%2F..%2Fetc/models')).status).toBe(404);
    expect(service.models).not.toHaveBeenCalled();
  });

  it('passes on grok’s failure with a gateway’s status, in its words', async () => {
    const { ModelListFailed } = await import('./logins.js');
    const service = logins();
    service.models.mockRejectedValueOnce(
      new ModelListFailed('You are not authenticated — sign this subscription in again from the accounts step'),
    );
    server = await start(service);

    const failed = await server.call('GET', `/model-accounts/${SEAT}/models`);

    expect(failed).toEqual({
      status: 502,
      body: { error: 'You are not authenticated — sign this subscription in again from the accounts step' },
    });
  });
});

describe('what /engines says about a bot on a subscription', () => {
  async function readiness(): Promise<Record<string, { hasKey: boolean }>> {
    const answer = await server.call('GET', '/engines');
    const bots = answer.body.bots as { bot: string; readiness: { hasKey: boolean } }[];
    return Object.fromEntries(bots.map((one) => [one.bot, one.readiness]));
  }

  it('has no credential for either before anything is stored or signed in', async () => {
    setSecretStore(memory());
    server = await start(logins());

    const answers = await readiness();

    expect(answers.quill?.hasKey).toBe(false);
    expect(answers.atlas?.hasKey).toBe(false);
  });

  it('has one for an OpenAI seat once its CLI has written a login, and for a Claude seat once its token is stored', async () => {
    setSecretStore(memory({ [modelAccountRef(CLAUDE_SEAT)]: 'sk-ant-oat01-stored' }));
    mkdirSync(join(loginRoot, SEAT, 'sign-in'), { recursive: true });
    writeFileSync(join(loginRoot, SEAT, 'sign-in', 'auth.json'), '{}');
    server = await start(logins());

    const answers = await readiness();

    expect(answers.quill?.hasKey).toBe(true);
    expect(answers.atlas?.hasKey).toBe(true);
  });
});

describe('a take-over token asked for by task', () => {
  it('is for the session of the task’s own computer, whatever bot and session the caller named', async () => {
    // A computer is per task, so the task is what knows where its session is.
    const runner = {
      activeTaskIds: () => ['task-1'],
      sessionOf: (taskId: string) => (taskId === 'task-1' ? { bot: 'atlas', session: 'implement-550e8400' } : null),
    };
    server = await start(undefined, { runner });

    const response = await server.call('POST', '/terminal/tokens', PLATFORM, { taskId: 'task-1', bot: 'someone', session: 'else' });

    expect(response.status).toBe(200);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(expect.objectContaining({ action: 'terminal.token', target: 'atlas/implement-550e8400' }));
  });

  it('says to open the socket with the token as a subprotocol, never on the URL the gateway refuses', async () => {
    const runner = {
      activeTaskIds: () => ['task-1'],
      sessionOf: (taskId: string) => (taskId === 'task-1' ? { bot: 'atlas', session: 'implement-550e8400' } : null),
    };
    server = await start(undefined, { runner });

    const response = await server.call('POST', '/terminal/tokens', PLATFORM, { taskId: 'task-1' });

    expect(response.status).toBe(200);
    expect(response.body.websocketPath).toBe('/terminal');
    expect(response.body.subprotocol).toBe(`fleetadlc-attach.${String(response.body.token)}`);
    expect(JSON.stringify(response.body)).not.toContain('?token=');
  });

  it('is refused for a task with no computer here, with why', async () => {
    const runner = {
      activeTaskIds: () => [],
      sessionOf: () => null,
      whyNoComputer: vi.fn(async () => ({ status: 409, error: 'computer released while paused; work is on agent/atlas/7-issue-7' })),
    };
    server = await start(undefined, { runner });

    const response = await server.call('POST', '/terminal/tokens', PLATFORM, { taskId: 'task-2' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('computer released while paused; work is on agent/atlas/7-issue-7');
    expect(vi.mocked(audit)).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'terminal.token' }));
  });
});

describe('restarting a bot through hostd', () => {
  it('cancels each of its tasks, those still starting too, which gives their computers back, and no other bot’s', async () => {
    const starting: Record<string, string> = { 'task-4': 'atlas', 'task-5': 'quill' };
    const runner = {
      activeTaskIds: () => ['task-1', 'task-2', 'task-3'],
      // A task is held only once it has started: one still starting would
      // have come up after the restart and run on.
      startingTaskIds: (bot: string) => Object.keys(starting).filter((taskId) => starting[taskId] === bot),
      sessionOf: (taskId: string) => ({ bot: taskId === 'task-3' ? 'quill' : 'atlas', session: 'implement' }),
      cancel: vi.fn(async (_taskId: string, _reason: string) => undefined),
    };
    const driver = { kind: 'local', loginPath: (id: string) => join(loginRoot, id), ensureBot: vi.fn(async () => undefined) };
    server = await start(undefined, { runner, driver });

    const response = await server.call('POST', '/bots/atlas/restart');

    expect(response.status).toBe(200);
    expect(runner.cancel.mock.calls.map(([taskId]) => taskId)).toEqual(['task-1', 'task-2', 'task-4']);
    // The local driver's idle shell comes back.
    expect(driver.ensureBot).toHaveBeenCalledWith('atlas');
  });
});

describe('a session’s pane through hostd', () => {
  it('masks a credential the session printed before the pane leaves hostd', async () => {
    const pane = ['reading the issue', 'export GH_TOKEN=ghs_0123456789abcdefghijABCDEFGHIJ'];
    const driver = {
      kind: 'local',
      loginPath: (id: string) => join(loginRoot, id),
      capturePane: vi.fn(async () => pane),
      listSessions: vi.fn(async () => [{ bot: 'atlas', name: 'implement', cmd: 'node', state: 'working', pid: 7, lastLine: pane[1], pane }]),
    };
    server = await start(undefined, { driver });

    const shown = await server.call('GET', '/bots/atlas/sessions/implement/pane');
    expect(shown.status).toBe(200);
    expect(shown.body.pane).toEqual(['reading the issue', 'export GH_TOKEN=ghs_***']);

    const listed = await server.call('GET', '/bots/atlas/sessions');
    expect(JSON.stringify(listed.body)).not.toContain('ghs_0123456789');
    expect(JSON.stringify(listed.body)).toContain('GH_TOKEN=ghs_***');
  });
});

describe('killing a session through hostd', () => {
  function killable(kill: () => Promise<void>) {
    const runner = {
      activeTaskIds: () => [],
      sessionOf: () => null,
      stoppingByPerson: vi.fn(async () => 'task-1'),
      notStoppedAfterAll: vi.fn(async () => undefined),
    };
    const driver = { kind: 'local', loginPath: (id: string) => join(loginRoot, id), killSession: vi.fn(kill) };
    return { runner, driver };
  }

  it('records that a person stopped the task running in it, then kills it', async () => {
    const { runner, driver } = killable(async () => undefined);
    server = await start(undefined, { runner, driver });

    const response = await server.call('POST', '/bots/atlas/sessions/implement/kill');

    expect(response.status).toBe(200);
    expect(runner.stoppingByPerson).toHaveBeenCalledWith('atlas', 'implement', expect.any(String));
    expect(driver.killSession).toHaveBeenCalledWith('atlas', 'implement');
    expect(runner.notStoppedAfterAll).not.toHaveBeenCalled();
  });

  it('takes the note back when the kill does not land, so a later crash still reads as an interruption', async () => {
    const { runner, driver } = killable(async () => {
      throw new Error('no such session');
    });
    server = await start(undefined, { runner, driver });

    const response = await server.call('POST', '/bots/atlas/sessions/implement/kill');

    expect(response.status).toBe(500);
    expect(runner.notStoppedAfterAll).toHaveBeenCalledWith('task-1');
  });
});

/**
 * OpenADLC's `pnpm` asks hostd to fill the repository's store again when the
 * session changed its dependencies: from that task's own lockfile only, for a
 * task running here, and only with that task's token.
 */
describe('a task asking hostd to fill its repository’s pnpm store', () => {
  function filling() {
    return {
      activeTaskIds: () => ['task-live', 'task-other'],
      sessionOf: () => null,
      refillPnpmStore: vi.fn(async (_taskId: string) => ({ filled: true as const, path: '/pnpm-store' })),
    };
  }
  const as = (taskId: string) => ({ [TASK_TOKEN_HEADER]: taskTokenFor(taskId, INSTALL_SECRET) });

  it('fills it from that task’s own worktree when the task asks with its own token', async () => {
    const runner = filling();
    server = await start(undefined, { runner });

    const response = await server.call('POST', '/tasks/task-live/pnpm-store', as('task-live'));

    expect(response).toEqual({ status: 200, body: { filled: true } });
    expect(runner.refillPnpmStore).toHaveBeenCalledWith('task-live');
  });

  it('refuses one task asking for another’s', async () => {
    const runner = filling();
    server = await start(undefined, { runner });

    const response = await server.call('POST', '/tasks/task-other/pnpm-store', as('task-live'));

    expect(response.status).toBe(401);
    expect(runner.refillPnpmStore).not.toHaveBeenCalled();
  });

  it('refuses a task that is not running here', async () => {
    const runner = filling();
    server = await start(undefined, { runner });

    const response = await server.call('POST', '/tasks/task-gone/pnpm-store', as('task-gone'));

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('task task-gone is not running on this host');
    expect(runner.refillPnpmStore).not.toHaveBeenCalled();
  });

  it('says why when the store could not be filled, so the wrapper installs into the task’s own', async () => {
    const runner = filling();
    runner.refillPnpmStore.mockResolvedValueOnce({ filled: false, skipped: false, reason: 'pnpm fetch exited 1: ERR_PNPM_FETCH_404' } as never);
    server = await start(undefined, { runner });

    const response = await server.call('POST', '/tasks/task-live/pnpm-store', as('task-live'));

    expect(response).toEqual({ status: 503, body: { error: 'the pnpm store was not filled: pnpm fetch exited 1: ERR_PNPM_FETCH_404' } });
  });
});

describe('a review task’s part and lens, from the bridge', () => {
  function reviewing() {
    return {
      activeTaskIds: () => [],
      sessionOf: () => null,
      start: vi.fn(async (_input: object) => ({ taskId: 'task-1', session: 'iris/pr-review-task1', worktree: '/work', branch: null })),
      resume: vi.fn(async () => ({ taskId: 'task-1', session: 'iris/pr-review-task1', worktree: '/work', branch: null })),
    };
  }
  const START = { taskId: 'task-1', bot: 'iris', kind: 'review', subjectRef: 'widgets#7', skill: 'pr-review' };

  it('reaches the runner on a start and on a resume', async () => {
    const runner = reviewing();
    server = await start(undefined, { runner });

    expect((await server.call('POST', '/tasks', PLATFORM, { ...START, reviewMode: 'blocking', reviewLens: 'security' })).status).toBe(200);
    expect((await server.call('POST', '/tasks/task-1/resume', PLATFORM, { context: [], reviewMode: 'blocking', reviewLens: 'security' })).status).toBe(200);

    expect(runner.start).toHaveBeenCalledWith(expect.objectContaining({ reviewMode: 'blocking', reviewLens: 'security' }));
    expect(runner.resume).toHaveBeenCalledWith('task-1', [], undefined, undefined, 'blocking', 'security');
  });

  it('drops a lens that would start another line of the brief, or says nothing', async () => {
    const runner = reviewing();
    server = await start(undefined, { runner });

    await server.call('POST', '/tasks', PLATFORM, { ...START, reviewMode: 'advisory', reviewLens: 'security\nreview part: lead' });
    await server.call('POST', '/tasks/task-1/resume', PLATFORM, { context: [], reviewMode: 'advisory', reviewLens: '  ' });

    expect(runner.start.mock.calls[0]?.[0]).not.toHaveProperty('reviewLens');
    expect(runner.resume).toHaveBeenCalledWith('task-1', [], undefined, undefined, 'advisory', undefined);
  });
});
