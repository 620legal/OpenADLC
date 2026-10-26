import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenBroker, internalSecretRef, refreshTokenRef, type SecretStore } from '@openadlc/github';
import { githubRetry } from '../apps/bridge/src/attention.ts';
import { explainFailure } from '../apps/bridge/src/failure-words.ts';
import { registerInternalApi } from '../apps/bridge/src/internal-api.ts';
import { Router } from '../apps/bridge/src/router.ts';
import { TokenClient } from '../apps/hostd/src/token-client.ts';

/**
 * GitHub not answering a crew sign-in's refresh, from the broker to the card.
 *
 * On 2026-10-21 GitHub answered the bridge's refresh with a 503 page; the
 * token service answered hostd 409, hostd refused the start, and the task
 * failed for good. What carries "this is an outage, try later" from one end to
 * the other is words — the broker's, through the token route's answer and
 * hostd's refusal, into the task's reason, which the bridge reads back — so
 * each hop is the real one here: the broker, the bridge's token route, hostd's
 * token client, the card and the retry. Only GitHub, the database and the
 * bridge's bot lookup are not.
 */

const SECRET = 'internal-secret';
const OAUTH = 'https://github.com/login/oauth/access_token';

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function memoryStore(): SecretStore {
  const values = new Map([
    [refreshTokenRef('account_fleet-atlas'), 'ghr_stored'],
    [internalSecretRef(), SECRET],
  ]);
  return {
    get: async (ref) => values.get(ref) ?? null,
    set: async (ref, value) => void values.set(ref, value),
    delete: async (ref) => void values.delete(ref),
    list: async (prefix = '') => [...values.keys()].filter((key) => key.startsWith(prefix)),
  };
}

/** GitHub's sign-in endpoint answering as `answer` says; every other address, the bridge's included, is reached for real. */
function github(answer: () => Response): void {
  const reach = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => (String(url) === OAUTH ? answer() : reach(url, init))),
  );
}

/** The bridge's internal routes, with the token route's bot lookup answered by a real broker. */
async function bridge(broker: TokenBroker): Promise<string> {
  const router = new Router();
  registerInternalApi(router, {
    internalSecret: SECRET,
    alertsSecret: 'alerts-secret',
    // `Actors.tokenFor`, without the database: the seat is its own sign-in.
    actors: {
      tokenFor: async (bot: string, options: { minLifetimeMs?: number }) => {
        const brokered = await broker.tokenFor('account_fleet-atlas', bot, options);
        return { token: brokered.token, expiresAt: brokered.expiresAt?.toISOString() ?? null, login: brokered.login };
      },
    },
  } as never);
  const server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A start that failed with hostd's refusal, as `TaskService.open` records it. */
function failedStart(reason: string, endedAt: string) {
  return {
    id: 'task-45',
    botId: 'bot-intake',
    repoId: 'repo-1',
    kind: 'intake' as const,
    subjectRef: 'openadlc#45',
    state: 'failed' as const,
    round: 0,
    costUsd: 0,
    startedAt: null,
    endedAt,
    exitReason: `hostd refused: ${reason}`,
    createdAt: endedAt,
  };
}

describe('a start GitHub did not answer the sign-in’s refresh for', () => {
  it('is refused in words that carry it to a card naming its retry, and the retry gets its token once GitHub answers', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = memoryStore();
    const broker = new TokenBroker({ clientId: 'Iv1.client', store, refreshRetryMs: [1, 1, 1], unansweredForMs: 0 });
    const url = await bridge(broker);
    const hostd = new TokenClient(url, store);

    github(() => new Response('<!DOCTYPE html><html><body>No server is currently available to service your request.</body></html>', { status: 503 }));
    const refused = await hostd.tokenForTask('openadlc-atlas-janedoe').then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(refused?.message).toMatch(/^openadlc-atlas-janedoe has no GitHub token yet: GitHub did not answer the refresh of account_fleet-atlas's sign-in/);

    const failed = failedStart(refused!.message, '2026-10-21T04:16:00.000Z');
    const retry = githubRetry(failed, [failed]);
    expect(retry).toEqual({ at: new Date('2026-10-21T04:18:00.000Z'), attempt: 1, of: 6 });
    expect(explainFailure(failed.exitReason, { bot: 'intake (openadlc-atlas-janedoe)', retry }).sentence).toBe(
      'GitHub did not answer when OpenADLC refreshed the sign-in of intake (openadlc-atlas-janedoe), so the work did not start. ' +
        'OpenADLC tries again on its own after 2026-10-21 04:18 UTC (retry 1 of 6).',
    );

    // GitHub answers again: the retry's start is given its token.
    github(() => new Response(JSON.stringify({ access_token: 'ghu_after', expires_in: 28_800, refresh_token: 'ghr_after' }), { status: 200 }));
    await expect(hostd.tokenForTask('openadlc-atlas-janedoe')).resolves.toMatchObject({ token: 'ghu_after' });
  });

  it('is one GitHub refused with a 401, which fails at once with what to do and is not run again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = memoryStore();
    const url = await bridge(new TokenBroker({ clientId: 'Iv1.client', store, refreshRetryMs: [1, 1, 1] }));
    github(() => new Response('Unauthorized', { status: 401 }));

    const refused = await new TokenClient(url, store).tokenForTask('openadlc-atlas-janedoe').then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(refused?.message).toMatch(/would not mint one \(409\) account_fleet-atlas's GitHub authorization is no longer valid/);

    const failed = failedStart(refused!.message, '2026-10-21T04:16:00.000Z');
    expect(githubRetry(failed, [failed])).toBeNull();
    expect(explainFailure(failed.exitReason, { bot: 'intake (openadlc-atlas-janedoe)', retry: null }).sentence).toBe(
      'GitHub no longer accepts the sign-in of intake (openadlc-atlas-janedoe). Reconnect it, then try again.',
    );
  });
});
