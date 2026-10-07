import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretStore } from '@fleetadlc/github';
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

beforeEach(async () => {
  asked = [];
  answer = { token: 'ghu_scoped', expiresAt: null, login: 'atlas-janedoe', scoped: true };
  bridge = createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => {
      asked.push({ path: request.url ?? '', body: JSON.parse(text || '{}') as Record<string, unknown> });
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
