import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { githubDidNotAnswer, type SecretStore } from '@openadlc/github';
import { TokenClient } from './token-client.js';

/**
 * hostd asking the bridge for a task's token: what it sends, and what it says
 * when the token it gets is not narrowed to the task's repository.
 */

const store: SecretStore = {
  get: async () => 'internal-secret',
  set: async () => undefined,
  delete: async () => undefined,
  list: async () => [],
};

let bridge: Server;
let url: string;
let asked: { path: string; body: Record<string, unknown> }[];
let answer: Record<string, unknown>;
let status: number;

beforeEach(async () => {
  asked = [];
  answer = { token: 'ghu_scoped', expiresAt: null, login: 'atlas-janedoe', scoped: true };
  status = 200;
  bridge = createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => {
      asked.push({ path: request.url ?? '', body: JSON.parse(text || '{}') as Record<string, unknown> });
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
});

describe('a task’s token', () => {
  it('is asked for with the task’s repository beside its purpose', async () => {
    const token = await new TokenClient(url, store).tokenForTask('atlas', 'exampleco/widgets');

    expect(token).toMatchObject({ token: 'ghu_scoped', scoped: true });
    expect(asked).toEqual([{ path: '/internal/tokens/atlas', body: { purpose: 'task', repository: 'exampleco/widgets' } }]);
  });

  it('is asked for with no repository for a task in none', async () => {
    answer = { token: 'ghu_account', expiresAt: null, login: 'atlas-janedoe' };
    await new TokenClient(url, store).tokenForTask('atlas');

    expect(asked[0]?.body).toEqual({ purpose: 'task' });
  });

  it('says in the log, naming the bot and repository, when it is not scoped to the repository', async () => {
    answer = { token: 'ghu_account', expiresAt: null, login: 'atlas-janedoe', scoped: false };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const token = await new TokenClient(url, store).tokenForTask('atlas', 'exampleco/widgets');

    expect(token.token).toBe('ghu_account');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("atlas's GitHub token for exampleco/widgets is not scoped to the repository"));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('ghu_account');
  });
});

describe('a task’s token the bridge could not mint', () => {
  /** The error a refused ask throws; a token is a failure here. */
  async function refusal(asking: Promise<unknown>): Promise<Error> {
    return asking.then(
      () => {
        throw new Error('a token was minted');
      },
      (caught: unknown) => caught as Error,
    );
  }

  it('says GitHub did not answer, in the words the bridge runs the task again on, when the bridge answers 503', async () => {
    status = 503;
    answer = { error: "GitHub did not answer the refresh of account_atlas-janedoe's sign-in (GitHub returned a non-JSON response (503): <html>); it is asked again next time" };

    const error = await refusal(new TokenClient(url, store).tokenForTask('atlas', 'exampleco/widgets'));

    expect(error.message).toMatch(/^atlas has no GitHub token yet: GitHub did not answer the refresh of account_atlas-janedoe's sign-in/);
    expect(githubDidNotAnswer(error.message)).toBe(true);
  });

  it('passes on a 503 that is not GitHub’s as it came', async () => {
    status = 503;
    answer = { error: 'Service Unavailable' };

    const error = await refusal(new TokenClient(url, store).tokenForTask('atlas'));

    expect(error.message).toBe('atlas has no GitHub token: the bridge would not mint one (503) Service Unavailable');
    expect(githubDidNotAnswer(error.message)).toBe(false);
  });

  it('passes a refusal on as one, which is not tried again', async () => {
    status = 409;
    answer = { error: "atlas's GitHub authorization is no longer valid (bad_refresh_token). Reconnect it: openadlc auth login --bot atlas-janedoe" };

    const error = await refusal(new TokenClient(url, store).tokenForTask('atlas'));

    expect(error.message).toBe(
      "atlas has no GitHub token: the bridge would not mint one (409) atlas's GitHub authorization is no longer valid (bad_refresh_token). Reconnect it: openadlc auth login --bot atlas-janedoe",
    );
    expect(githubDidNotAnswer(error.message)).toBe(false);
  });
});
