import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOSTD_NOT_ANSWERING_FOR_ACCOUNTS, HOSTD_NOT_ANSWERING_FOR_ATTACH, HostdClient, START_TIMEOUT_MS } from './hostd-client.js';

/**
 * A stand-in for hostd that records what it was asked and answers what it is
 * told to. What matters here is the half the bridge owns: that the credential
 * travels, and that hostd's refusal reaches a browser as hostd's words with
 * hostd's status — not as a 500, and not carrying hostd's address.
 */
let hostd: Server;
let client: HostdClient;
let asked: { url: string; secret: string | undefined; method?: string; onBehalfOf?: string | undefined; body?: string }[];
let answer: { status: number; body: unknown };

const SECRET = 'install-secret-for-the-test';

beforeEach(async () => {
  asked = [];
  answer = { status: 200, body: { kind: 'directory', path: '', entries: [], truncated: false } };

  hostd = createServer((request, response) => {
    const seen: (typeof asked)[number] = {
      url: request.url ?? '',
      secret: request.headers['x-fleetadlc-internal-secret'] as string | undefined,
      method: request.method,
      onBehalfOf: request.headers['x-fleetadlc-on-behalf-of'] as string | undefined,
      body: '',
    };
    asked.push(seen);
    request.on('data', (chunk: Buffer) => (seen.body += chunk.toString()));
    request.on('end', () => {
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => hostd.listen(0, '127.0.0.1', resolve));

  const { port } = hostd.address() as AddressInfo;
  client = new HostdClient(`http://127.0.0.1:${port}`, SECRET);
});

afterEach(async () => {
  await new Promise<void>((resolve) => hostd.close(() => resolve()));
});

describe('the bridge asking whether hostd is up', () => {
  it('counts a hostd that takes the connection and never answers as down, without waiting minutes', async () => {
    const silent = createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = silent.address() as AddressInfo;
      const started = Date.now();
      expect(await new HostdClient(`http://127.0.0.1:${port}`, SECRET, { healthTimeoutMs: 100 }).health()).toEqual({ ok: false });
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      silent.closeAllConnections();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});

describe('the bridge reading a worktree through hostd', () => {
  it('presents the install secret, which hostd refuses a caller without', async () => {
    await client.worktree('task-live', '');
    expect(asked[0]?.secret).toBe(SECRET);
  });

  it('sends the path as an encoded query, so a space or a slash survives it', async () => {
    await client.worktree('task-live', 'src/a file.ts');
    expect(asked[0]?.url).toBe('/tasks/task-live/worktree?path=src%2Fa%20file.ts');
  });

  it('asks for the root when no path is given, rather than for an empty one', async () => {
    await client.worktree('task-live', '');
    expect(asked[0]?.url).toBe('/tasks/task-live/worktree');
  });

  it('carries a refusal’s status through, so the console shows 403 and not 500', async () => {
    answer = { status: 403, body: { error: 'escape/secrets.txt resolves outside the worktree', remedy: '…' } };
    await expect(client.worktree('task-live', 'escape/secrets.txt')).rejects.toMatchObject({ status: 403 });
  });

  it('passes hostd’s words and not hostd’s address', async () => {
    // `fetchJson` would prefix the message with the URL it called. That is
    // hostd's address on the private network, and this message is read by a
    // person in a browser.
    answer = { status: 403, body: { error: '.git is not served', remedy: '…' } };
    const failure = await client.worktree('task-live', '.git/config').catch((error: Error) => error);

    expect((failure as Error).message).toBe('.git is not served');
    expect((failure as Error).message).not.toContain('127.0.0.1');
  });
});

describe('the bridge asking hostd for an attach token', () => {
  it('says hostd is not answering when nothing answers, rather than `fetch failed`', async () => {
    // A port that was listening a moment ago and is not now.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const silent = new HostdClient(`http://127.0.0.1:${port}`, SECRET);
    const failure = await silent.attachToken('atlas', 'shell', 'operator').catch((error: Error) => error);

    expect((failure as Error).message).toBe(HOSTD_NOT_ANSWERING_FOR_ATTACH);
    expect(failure).toMatchObject({ status: 502 });
  });

  it('still passes a refusal through as a refusal', async () => {
    answer = { status: 404, body: { error: 'no such session' } };
    await expect(client.attachToken('atlas', 'gone', 'operator')).rejects.toMatchObject({ status: 404 });
  });

  it('names the task the session is for, and passes on why it has no computer in hostd’s words', async () => {
    answer = { status: 409, body: { error: 'computer released while paused; work is on agent/atlas/7-issue-7' } };

    const failure = await client.attachToken('atlas', 'implement-3f2a9c1e', 'operator', 'task-7').catch((error: Error) => error);

    expect(JSON.parse(asked[0]?.body ?? '{}')).toEqual({ bot: 'atlas', session: 'implement-3f2a9c1e', taskId: 'task-7' });
    expect(failure).toMatchObject({ status: 409 });
    expect((failure as Error).message).toContain('computer released while paused; work is on agent/atlas/7-issue-7');
  });
});

describe('the bridge asking hostd about a model account', () => {
  const ACCOUNT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

  it('starts a sign-in with the install secret, on behalf of the person asking', async () => {
    answer = {
      status: 200,
      body: { state: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'URPK-DI1GG', startedAt: 'now' },
    };

    const state = await client.startLogin(ACCOUNT, 'ada');

    expect(state).toMatchObject({ state: 'waiting', code: 'URPK-DI1GG' });
    expect(asked[0]).toMatchObject({ method: 'POST', url: `/model-accounts/${ACCOUNT}/login`, secret: SECRET, onBehalfOf: 'ada' });
  });

  it('asks where a sign-in stands, checks an account and forgets a login on the routes hostd serves', async () => {
    answer = { status: 200, body: { state: 'signed-in' } };
    await client.loginStatus(ACCOUNT);
    answer = { status: 200, body: { ok: true, message: 'answered: OK', checkedAt: 'now' } };
    await client.verifyAccount(ACCOUNT, 'ada');
    answer = { status: 200, body: { ok: true } };
    await client.forgetLogin(ACCOUNT, 'ada');

    expect(asked.map((one) => `${one.method} ${one.url}`)).toEqual([
      `GET /model-accounts/${ACCOUNT}/login`,
      `POST /model-accounts/${ACCOUNT}/verify`,
      `DELETE /model-accounts/${ACCOUNT}/login`,
    ]);
  });

  it('asks for an xAI seat’s models on the route hostd serves, with the install secret', async () => {
    answer = { status: 200, body: { models: [{ id: 'grok-4.7', createdAt: null, isDefault: true }] } };

    const listed = await client.accountModels(ACCOUNT);

    expect(listed.models).toEqual([{ id: 'grok-4.7', createdAt: null, isDefault: true }]);
    expect(asked[0]).toMatchObject({ method: 'GET', url: `/model-accounts/${ACCOUNT}/models`, secret: SECRET });
  });

  it('passes on grok’s failure to list with hostd’s status', async () => {
    answer = { status: 502, body: { error: 'You are not authenticated — sign this subscription in again' } };

    await expect(client.accountModels(ACCOUNT)).rejects.toMatchObject({
      status: 502,
      message: 'You are not authenticated — sign this subscription in again',
    });
  });

  it('passes hostd’s refusal on in its words and with its status', async () => {
    answer = { status: 400, body: { error: 'an API key account has nothing to sign in to' } };

    const failure = await client.startLogin(ACCOUNT, 'ada').catch((error: Error) => error);

    expect(failure).toMatchObject({ status: 400, message: 'an API key account has nothing to sign in to' });
    expect((failure as Error).message).not.toContain('127.0.0.1');
  });

  it('says hostd is not answering when nothing answers', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const failure = await new HostdClient(`http://127.0.0.1:${port}`, SECRET)
      .verifyAccount(ACCOUNT, 'ada')
      .catch((error: Error) => error);

    expect(failure).toMatchObject({ status: 502, message: HOSTD_NOT_ANSWERING_FOR_ACCOUNTS });
  });
});

describe('the bridge naming a bot, a session or a task to hostd', () => {
  it('encodes each name, so a decoded `../` cannot reach another of hostd’s routes', async () => {
    answer = { status: 200, body: { pane: [], sessions: [] } };
    const escape = '../../engines/rollback#';
    await client.pane(escape, escape, 60);
    await client.killSession(escape, escape, 'ada@example.com');
    await client.restartBot(escape, 'ada@example.com');
    await client.sessions(escape);
    await client.cancelTask(escape, 'stopped');
    await client.cleanupTask(escape, 'done');
    await client.resumeTask(escape, []);
    await client.worktree(escape, '');

    const encoded = encodeURIComponent(escape);
    expect(asked.map((one) => one.url)).toEqual([
      `/bots/${encoded}/sessions/${encoded}/pane?lines=60`,
      `/bots/${encoded}/sessions/${encoded}/kill`,
      `/bots/${encoded}/restart`,
      `/bots/${encoded}/sessions`,
      `/tasks/${encoded}/cancel`,
      `/tasks/${encoded}/cleanup`,
      `/tasks/${encoded}/resume`,
      `/tasks/${encoded}/worktree`,
    ]);
  });
});

describe('a refusal from hostd on any other call', () => {
  it('carries hostd’s words and status, and never hostd’s address', async () => {
    // Stop on a card answered "POST http://<hostd>:47312/tasks/…/cancel → 500: …".
    answer = { status: 409, body: { error: 'the task is not running here' } };
    const failure = await client.cancelTask('task-81', 'stopped').catch((error: Error) => error);

    expect((failure as Error).message).toBe('the task is not running here');
    expect(failure).toMatchObject({ status: 409 });
    expect((failure as Error).message).not.toContain('127.0.0.1');
  });

  it('says hostd is not answering when nothing answers', async () => {
    const silent = new HostdClient('http://127.0.0.1:1', SECRET);
    const failure = await silent.sessions('atlas').catch((error: Error) => error);
    expect(failure).toMatchObject({ status: 502 });
    expect((failure as Error).message).not.toContain('127.0.0.1');
  });
});

describe('the bridge asking whether hostd is up', () => {
  it('says it is not when hostd takes the connection and never answers', async () => {
    const silent = createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as AddressInfo;
    try {
      const health = await new HostdClient(`http://127.0.0.1:${port}`, SECRET, { healthTimeoutMs: 50 }).health();
      expect(health).toEqual({ ok: false });
    } finally {
      silent.closeAllConnections();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});

describe('the bridge starting or resuming a task', () => {
  it('waits longer than hostd’s slowest start, so a start hostd is still completing is not failed under it', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    answer = { status: 200, body: { session: 'atlas/implement-task1', worktree: '/work/wt' } };
    try {
      await client.startTask({ taskId: 'task-1', bot: 'atlas', repo: 'widgets', kind: 'implement', subjectRef: 'widgets#1', skill: 'implement' });
      await client.resumeTask('task-1', []);

      expect(timeout.mock.calls).toEqual([[START_TIMEOUT_MS], [START_TIMEOUT_MS]]);
      // Past `make setup`'s own 30 minutes, and a first clone besides.
      expect(START_TIMEOUT_MS).toBeGreaterThan(30 * 60_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it('sends a review seat’s part and lens on a start and on a resume', async () => {
    answer = { status: 200, body: { session: 'iris/pr-review-task1', worktree: '/work/wt' } };

    await client.startTask({ taskId: 'task-1', bot: 'iris', repo: 'widgets', kind: 'review', subjectRef: 'widgets#7', skill: 'pr-review', reviewMode: 'blocking', reviewLens: 'security' });
    await client.resumeTask('task-1', [], undefined, undefined, 'blocking', 'security');
    await client.resumeTask('task-2', []);

    const bodies = asked.map((one) => JSON.parse(one.body ?? '{}') as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({ reviewMode: 'blocking', reviewLens: 'security' });
    expect(bodies[1]).toMatchObject({ reviewMode: 'blocking', reviewLens: 'security' });
    expect(bodies[2]).not.toHaveProperty('reviewLens');
  });
});

describe('starting an engine update on hostd', () => {
  it('sends how old a release must be, with the hold and the person asking', async () => {
    answer = { status: 202, body: { running: true, startedAt: '2026-10-04T10:00:00.000Z', joined: false, last: null } };

    await client.startEngineUpdate({ trigger: 'console', hold: {}, minReleaseAgeDays: 7 }, 'ada');

    expect(asked[0]).toMatchObject({ url: '/engines/update', method: 'POST', secret: SECRET, onBehalfOf: 'ada' });
    expect(JSON.parse(asked[0]?.body ?? '{}')).toEqual({ trigger: 'console', hold: {}, minReleaseAgeDays: 7 });
  });
});
